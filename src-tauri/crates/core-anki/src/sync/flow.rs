//! The sync operations of [`AnkiService`].

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};

use anki::media::MediaManager;
use anki::prelude::Usn;
use anki::sync::collection::normal::{SyncActionRequired, SyncOutput};
use anki::sync::collection::status::online_sync_status_check;
use anki::sync::http_client::HttpSyncClient;
use anki_proto::sync::SyncCollectionResponse;
use tokio::sync::{oneshot, watch};

use super::client::{build_client, diagnose, make_auth};
use super::decide::{Action, decide};
use super::failure::{SyncFailure, from_anki, sync_error};
use super::{FullSyncDirection, SyncConfig, SyncCredentials, SyncOutcome, SyncReport};
use crate::backup::backup_now;
use crate::error::{Error, Result};
use crate::service::AnkiService;
use crate::types::{BackupInfo, BackupKind};

/// A running media sync: how to stop it and how to know it stopped.
pub(crate) struct MediaTask {
    cancel: Option<oneshot::Sender<()>>,
    done: watch::Receiver<bool>,
}

impl AnkiService {
    /// Syncs the collection, then media (docs/PROJETO.md 9).
    ///
    /// `first_sync`: first sync of this account in the app — the local collection is disposable
    /// and the server's is downloaded (after a `PreSync` backup). Never uploads: when only an
    /// upload could reconcile, returns [`SyncOutcome::FullSyncRequired`] and changes nothing.
    /// The network check runs off the actor, so an unreachable server never blocks the collection.
    pub async fn sync(&self, creds: &SyncCredentials, first_sync: bool) -> Result<SyncReport> {
        let ctl = self.sync_control();
        let _running = ctl.try_start()?;
        let mut cancel = ctl.cancel.subscribe();
        let mut cfg = creds.config.clone();
        let hkey = creds.hkey.as_str();

        // Only this reads the collection; the network check below does not hold the actor.
        let meta = self.call(|col| Ok(col.sync_meta()?)).await?;
        let state = {
            let http = build_client(&cfg)?;
            let mut server =
                HttpSyncClient::new(make_auth(&cfg.endpoint, hkey, cfg.io_timeout_secs)?, http);
            match with_cancel(&mut cancel, online_sync_status_check(meta, &mut server)).await? {
                Ok(state) => state,
                Err(err) => return Err(refine(&cfg, from_anki(&err, &[hkey])).await),
            }
        };

        let mut report = SyncReport {
            outcome: SyncOutcome::NoChanges,
            server_message: Some(state.server_message.trim().to_owned()).filter(|m| !m.is_empty()),
            new_endpoint: None,
            media_error: None,
            collection_changed: false,
        };
        if let Some(target) = state.new_endpoint.as_deref() {
            let next = cfg.endpoint.accept_redirect(target)?;
            cfg.endpoint = next.clone();
            report.new_endpoint = Some(next);
        }
        let required = state.required;
        let mut media_usn = media_usn_of(SyncOutput::from(state));

        let mut action = decide(first_sync, required);
        if action == Action::Normal {
            if cancel.has_changed().unwrap_or(false) {
                return Err(sync_error(SyncFailure::Aborted, None));
            }
            let out = self
                .normal_sync_on_actor(&cfg, hkey, cancel.clone())
                .await?;
            match out {
                Ok(out) => {
                    let required = out.required;
                    media_usn = media_usn_of(out);
                    action = match required {
                        // Done: rslib reports NoChanges after a successful normal sync.
                        SyncActionRequired::NoChanges | SyncActionRequired::NormalSyncRequired => {
                            report.outcome = SyncOutcome::Normal;
                            report.collection_changed = true;
                            Action::Nothing
                        }
                        // The server changed in between; same rules as a later sync.
                        full => decide(false, full),
                    };
                }
                Err(err) => return Err(refine(&cfg, from_anki(&err, &[hkey])).await),
            }
        }

        match action {
            Action::Nothing | Action::Normal => {}
            Action::Download => {
                let backup = self
                    .full_sync_steps(&cfg, hkey, FullSyncDirection::Download, &mut cancel)
                    .await?;
                report.outcome = SyncOutcome::FullDownloaded { backup };
                report.collection_changed = true;
            }
            Action::Ask(choice) => {
                report.outcome = SyncOutcome::FullSyncRequired(choice);
                return Ok(report);
            }
        }

        report.media_error = self
            .media_sync_steps(&cfg, hkey, Some(media_usn))
            .await
            .err()
            .map(|e| media_failure(&e));
        Ok(report)
    }

    /// Full sync in the direction the user chose, after a `PreSync` backup (if the backup fails,
    /// nothing else happens), then media sync.
    pub async fn sync_full(
        &self,
        creds: &SyncCredentials,
        dir: FullSyncDirection,
    ) -> Result<SyncReport> {
        let ctl = self.sync_control();
        let _running = ctl.try_start()?;
        let mut cancel = ctl.cancel.subscribe();
        let cfg = &creds.config;
        let backup = self
            .full_sync_steps(cfg, &creds.hkey, dir, &mut cancel)
            .await?;
        let media_error = self
            .media_sync_steps(cfg, &creds.hkey, None)
            .await
            .err()
            .map(|e| media_failure(&e));
        Ok(SyncReport {
            outcome: match dir {
                FullSyncDirection::Download => SyncOutcome::FullDownloaded { backup },
                FullSyncDirection::Upload => SyncOutcome::FullUploaded { backup },
            },
            server_message: None,
            new_endpoint: None,
            media_error,
            collection_changed: true,
        })
    }

    /// Media only (the collection is not touched).
    pub async fn sync_media(&self, creds: &SyncCredentials) -> Result<()> {
        let _running = self.sync_control().try_start()?;
        self.media_sync_steps(&creds.config, &creds.hkey, None)
            .await
    }

    /// Cancels a running media sync and any pending network step of the running sync (a normal
    /// sync already applying changes finishes or rolls back). Never blocks.
    pub fn abort_sync(&self) {
        let ctl = self.sync_control();
        ctl.cancel.send_modify(|g| *g = g.wrapping_add(1));
        if let Some(task) = lock(&ctl.media).as_mut()
            && let Some(cancel) = task.cancel.take()
        {
            let _ = cancel.send(());
        }
        if ctl.is_on_actor() {
            self.request_abort();
        }
    }

    /// Whether a sync, full sync or media sync is running.
    pub fn sync_running(&self) -> bool {
        self.sync_control().is_running()
    }

    /// Runs rslib's normal sync on the actor. `abort_sync` reaches it at any point: before the
    /// job leaves the actor queue (checked when it starts), and while it runs. rslib resets
    /// `want_abort` when the syncer is built, so a watcher raises it again from inside the job
    /// whenever the cancel generation changes; rslib then stops at its first progress update
    /// (right after opening its transaction, before anything is sent) or later, always rolling
    /// back. The future itself is never dropped mid-sync (that would leave the transaction open).
    async fn normal_sync_on_actor(
        &self,
        cfg: &SyncConfig,
        hkey: &str,
        mut cancel: watch::Receiver<u64>,
    ) -> Result<std::result::Result<SyncOutput, anki::prelude::AnkiError>> {
        let auth = make_auth(&cfg.endpoint, hkey, cfg.io_timeout_secs)?;
        let cfg = cfg.clone();
        let abort = self.abort_handle();
        let _on_actor = self.sync_control().on_actor();
        self.call(move |col| {
            if cancel.has_changed().unwrap_or(false) {
                return Err(sync_error(SyncFailure::Aborted, None));
            }
            let rt = runtime()?;
            let http = build_client(&cfg)?;
            Ok(rt.block_on(async {
                let sync = col.normal_sync(auth, http);
                tokio::pin!(sync);
                let watcher = async {
                    while cancel.changed().await.is_ok() {
                        abort(Some(true));
                    }
                    std::future::pending::<()>().await;
                };
                tokio::pin!(watcher);
                // `biased`: the sync is polled first, so the syncer (and its reset of
                // `want_abort`) exists before the watcher can raise the flag.
                loop {
                    tokio::select! {
                        biased;
                        out = &mut sync => break out,
                        () = &mut watcher => {}
                    }
                }
            }))
        })
        .await
    }

    /// Backup, stop media sync, then replace the collection (download) or the server's (upload).
    async fn full_sync_steps(
        &self,
        cfg: &SyncConfig,
        hkey: &str,
        dir: FullSyncDirection,
        cancel: &mut watch::Receiver<u64>,
    ) -> Result<BackupInfo> {
        let backup = backup_now(self, BackupKind::PreSync).await?;
        self.abort_media_and_wait().await;
        if cancel.has_changed().unwrap_or(false) {
            return Err(sync_error(SyncFailure::Aborted, None));
        }
        let auth = make_auth(&cfg.endpoint, hkey, cfg.io_timeout_secs)?;
        let owned_cfg = cfg.clone();
        let mut owned_cancel = cancel.clone();
        let _on_actor = self.sync_control().on_actor();
        let res = self
            .with_owned_collection(move |col| {
                let rt = runtime()?;
                let http = build_client(&owned_cfg)?;
                rt.block_on(async {
                    let fut = async {
                        match dir {
                            FullSyncDirection::Download => col.full_download(auth, http).await,
                            FullSyncDirection::Upload => col.full_upload(auth, http).await,
                        }
                    };
                    with_cancel(&mut owned_cancel, fut).await
                })
            })
            .await?;
        match res {
            Ok(()) => Ok(backup),
            Err(err) => Err(refine(cfg, from_anki(&err, &[hkey])).await),
        }
    }

    /// Runs a media sync on its own thread (own media DB handle, never the actor) and waits for
    /// it. [`AnkiService::abort_sync`] stops it.
    async fn media_sync_steps(
        &self,
        cfg: &SyncConfig,
        hkey: &str,
        server_usn: Option<Usn>,
    ) -> Result<()> {
        let auth = make_auth(&cfg.endpoint, hkey, cfg.io_timeout_secs)?;
        let thread_cfg = cfg.clone();
        let paths = self.paths().clone();
        let secret = hkey.to_owned();
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let (done_tx, done_rx) = watch::channel(false);
        let (res_tx, res_rx) = oneshot::channel();
        *lock(&self.sync_control().media) = Some(MediaTask {
            cancel: Some(cancel_tx),
            done: done_rx,
        });
        let spawned = std::thread::Builder::new()
            .name("anki-media-sync".into())
            .spawn(move || {
                let job = || -> Result<()> {
                    let rt = runtime()?;
                    let http = build_client(&thread_cfg)?;
                    let mgr = MediaManager::new(&paths.media_folder, &paths.media_db)
                        .map_err(|e| from_anki(&e, &[]))?;
                    rt.block_on(async {
                        tokio::select! {
                            res = mgr.sync_media(Default::default(), auth, http, server_usn) => {
                                res.map_err(|e| from_anki(&e, &[&secret]))
                            }
                            _ = cancel_rx => Err(sync_error(SyncFailure::Aborted, None)),
                        }
                    })
                };
                let res = catch_unwind(AssertUnwindSafe(job)).unwrap_or(Err(Error::Panicked));
                let _ = done_tx.send(true);
                let _ = res_tx.send(res);
            });
        let res = match spawned {
            Ok(_) => res_rx.await.unwrap_or(Err(Error::Panicked)),
            Err(e) => Err(Error::Spawn(e)),
        };
        {
            let mut slot = lock(&self.sync_control().media);
            if slot.as_ref().is_some_and(|t| *t.done.borrow()) {
                *slot = None;
            }
        }
        match res {
            Ok(()) => Ok(()),
            Err(err) => Err(refine(cfg, err).await),
        }
    }

    /// Stops a running media sync and waits until its thread let go of the media DB.
    pub(crate) async fn abort_media_and_wait(&self) {
        let done = {
            let mut slot = lock(&self.sync_control().media);
            match slot.as_mut() {
                Some(task) => {
                    if let Some(cancel) = task.cancel.take() {
                        let _ = cancel.send(());
                    }
                    Some(task.done.clone())
                }
                None => None,
            }
        };
        if let Some(mut done) = done {
            let _ = done.wait_for(|d| *d).await;
        }
    }
}

/// Turns a vague "other" network failure into Offline / Timeout / TlsUntrusted by asking the
/// server directly. An Offline failure is checked too: rslib reports a failed TLS handshake and
/// a dropped connection with the same "error sending request"; when the server answers now, the
/// failure stays Offline (a transfer cut midway, retried with backoff).
pub(crate) async fn refine(cfg: &SyncConfig, err: Error) -> Error {
    match err {
        Error::Sync {
            kind: SyncFailure::Other | SyncFailure::Offline,
            ..
        } => match diagnose(cfg).await {
            Some(kind) => sync_error(kind, None),
            None => err,
        },
        other => other,
    }
}

fn media_failure(err: &Error) -> (SyncFailure, String) {
    let kind = match err {
        Error::Sync { kind, .. } => *kind,
        _ => SyncFailure::Other,
    };
    let message = match kind {
        SyncFailure::Other => format!("Falha ao sincronizar a mídia: {err}"),
        _ => err.to_string(),
    };
    (kind, message)
}

fn media_usn_of(out: SyncOutput) -> Usn {
    let resp: SyncCollectionResponse = out.into();
    Usn(resp.server_media_usn)
}

/// Current-thread runtime for the network part of a job on the actor or the media thread.
fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| sync_error(SyncFailure::Other, Some(format!("runtime: {e}"))))
}

/// Runs `fut` unless `abort_sync` is called first.
async fn with_cancel<F: Future>(cancel: &mut watch::Receiver<u64>, fut: F) -> Result<F::Output> {
    let cancelled = async {
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        out = fut => Ok(out),
        () = cancelled => Err(sync_error(SyncFailure::Aborted, None)),
    }
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
