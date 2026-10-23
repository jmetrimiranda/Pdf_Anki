//! Anki sync in the shell (spec 9, 15, 18): the account (URL and user in the settings, the sync
//! key in the system keychain, never the password), the status the UI shows (`anki://sync`), the
//! commands and the scheduler ([`policy`] decides, [`driver`] runs).
//!
//! The work itself is `core_anki::sync` (`AnkiService::sync` / `sync_full`), which never uploads
//! on its own and always downloads on the first sync of an account.

pub mod driver;
pub mod policy;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use core_anki::sync::{self as core_sync, validate_certificate};
use core_anki::{
    BackupInfo, FullSyncChoice, FullSyncDirection, SyncConfig, SyncCredentials, SyncEndpoint,
    SyncFailure, SyncOutcome,
};
use core_store::setting_keys as keys;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Notify, oneshot};

use crate::anki::{ChangeReason, UiEvent};
use crate::error::AppError;
use crate::secrets::{SecretStore, sync_account};
use crate::state::{AppState, lock};
pub use policy::{Finished, Policy, Reason, SyncTimings, Trigger};

/// Event with the [`AnkiSyncStatus`] after every change.
pub const ANKI_SYNC_EVENT: &str = "anki://sync";

/// What the top bar pill and the settings screen show.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    /// Not logged in (no server, no user or no key).
    Off,
    Idle,
    Syncing,
    /// The last attempt could not reach the server; retried with backoff and when the network
    /// returns.
    Offline,
    Error,
    /// The server needs a full sync: the UI asks the user (never automatic upload).
    FullSyncRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SyncErrorInfo {
    pub code: String,
    pub message: String,
}

impl From<&AppError> for SyncErrorInfo {
    fn from(e: &AppError) -> Self {
        Self {
            code: e.code.clone(),
            message: e.message.clone(),
        }
    }
}

/// `anki_sync_status` and the `anki://sync` payload. Every field is always serialized.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiSyncStatus {
    pub state: SyncState,
    pub url: Option<String>,
    pub user: Option<String>,
    pub logged_in: bool,
    /// SHA-256 of the configured extra root certificate (`AA:BB:…`).
    pub certificate_fingerprint: Option<String>,
    /// Logged in, but the first sync of this account (always a download) has not completed.
    pub first_sync_pending: bool,
    /// Epoch ms of the last successful sync.
    pub last_sync_at: Option<i64>,
    pub last_error: Option<SyncErrorInfo>,
    /// Set in state `fullSyncRequired`: which directions the dialog may offer.
    pub full_sync: Option<FullSyncChoice>,
    /// Epoch ms of the next automatic retry (offline/backoff).
    pub next_retry_at: Option<i64>,
    pub media_syncing: bool,
    /// The last media sync failed (the collection sync itself succeeded).
    pub media_error: Option<String>,
    /// Text the server asked to show.
    pub server_message: Option<String>,
}

/// `anki_sync_full` result: the status after the full sync and the backup written before it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSyncResult {
    pub status: AnkiSyncStatus,
    pub backup: BackupInfo,
}

/// `anki_sync_notify` events from the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncNotice {
    TabEntered,
    Online,
    Offline,
    Visible,
}

impl From<SyncNotice> for Trigger {
    fn from(n: SyncNotice) -> Self {
        match n {
            SyncNotice::TabEntered => Trigger::TabEntered,
            SyncNotice::Online => Trigger::Online,
            SyncNotice::Offline => Trigger::Offline,
            SyncNotice::Visible => Trigger::Visible,
        }
    }
}

pub fn not_logged_in() -> AppError {
    AppError::new(
        "anki_sync_not_logged_in",
        "Entre no servidor de sincronização em Configurações → Anki e sincronização.",
    )
}

fn busy() -> AppError {
    AppError::new("anki_sync_busy", SyncFailure::Busy.message(None))
}

/// A full sync replaces one side entirely, so it only runs when the last sync asked for it and
/// in a direction the server allowed. The one exception is the first sync of an account, which
/// may always download (the local collection is disposable, spec 9). Never an upload otherwise:
/// it would replace the server collection.
pub(crate) fn check_full_sync_allowed(
    direction: FullSyncDirection,
    required: Option<FullSyncChoice>,
    first_sync_pending: bool,
) -> Result<(), AppError> {
    match (direction, required) {
        // First sync: the server copy wins whenever there is one to download.
        (FullSyncDirection::Upload, Some(c)) if first_sync_pending && c.download_ok => {
            Err(AppError::new(
                "anki_sync_upload_not_allowed",
                "Na primeira sincronização deste aparelho, a coleção vem do servidor.",
            ))
        }
        (FullSyncDirection::Upload, Some(c)) if c.upload_ok => Ok(()),
        (FullSyncDirection::Download, Some(c)) if c.download_ok => Ok(()),
        (FullSyncDirection::Download, None) if first_sync_pending => Ok(()),
        (FullSyncDirection::Upload, Some(_)) => Err(AppError::new(
            "anki_sync_upload_not_allowed",
            "A coleção deste aparelho está vazia: não há o que enviar.",
        )),
        (FullSyncDirection::Download, Some(_)) => Err(AppError::new(
            "anki_sync_download_not_allowed",
            "O servidor ainda não tem uma coleção para baixar.",
        )),
        (_, None) => Err(AppError::new(
            "anki_sync_full_not_required",
            "A sincronização completa não é necessária agora. Use “Sincronizar agora”.",
        )),
    }
}

/// The account settings (no secret here).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SyncSettings {
    pub url: Option<String>,
    pub user: Option<String>,
    pub ca_cert: Option<String>,
    pub last_at: Option<i64>,
    pub first_done: Option<String>,
}

impl SyncSettings {
    /// The keychain account id (`anki-sync:user@endpoint`), when URL and user are set.
    pub fn account(&self) -> Option<String> {
        Some(sync_account(self.user.as_deref()?, self.url.as_deref()?))
    }
}

/// Mutable sync state, behind [`SyncHub::inner`]. Never held across an await or another lock.
pub(crate) struct HubState {
    /// Created on first use (needs the settings and the keychain).
    pub policy: Option<Policy>,
    pub last_error: Option<SyncErrorInfo>,
    pub last_failure: Option<SyncFailure>,
    pub full_sync: Option<FullSyncChoice>,
    pub server_message: Option<String>,
    pub media_error: Option<String>,
    /// `anki_sync` calls waiting for the next manual sync.
    pub waiters: Vec<oneshot::Sender<()>>,
    /// Cached fingerprint of the configured certificate: `(pem, fingerprint)`.
    pub fingerprint: Option<(String, Option<String>)>,
}

/// The sync side of [`AppState`].
pub struct SyncHub {
    pub(crate) secrets: Arc<dyn SecretStore>,
    pub(crate) timings: Mutex<SyncTimings>,
    pub(crate) inner: Mutex<HubState>,
    /// Wakes the driver (a stored permit is never lost).
    pub(crate) wake: Arc<Notify>,
    pub(crate) driver_started: AtomicBool,
    /// Bumped by login/logout so a sync of the previous account cannot write its result.
    pub(crate) generation: AtomicU64,
}

impl SyncHub {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            secrets,
            timings: Mutex::new(SyncTimings::default()),
            inner: Mutex::new(HubState {
                policy: None,
                last_error: None,
                last_failure: None,
                full_sync: None,
                server_message: None,
                media_error: None,
                waiters: Vec::new(),
                fingerprint: None,
            }),
            wake: Arc::new(Notify::new()),
            driver_started: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn bump_generation(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

pub(crate) fn now_ms() -> i64 {
    core_store::now_ms()
}

fn text_setting(v: Value) -> Option<String> {
    v.as_str().map(str::to_owned).filter(|s| !s.is_empty())
}

impl AppState {
    /// The secret store of the sync key (tests inspect it).
    pub fn secret_store(&self) -> &Arc<dyn SecretStore> {
        &self.sync.secrets
    }

    /// Sync timings of the scheduler; only effective before the scheduler starts (tests use
    /// [`SyncTimings::fast`]).
    pub fn set_sync_timings(&self, timings: SyncTimings) {
        *lock(&self.sync.timings) = timings;
    }

    pub(crate) fn sync_settings(&self) -> Result<SyncSettings, AppError> {
        self.with_store(|s| {
            Ok(SyncSettings {
                url: text_setting(s.setting(keys::ANKI_SYNC_URL)?),
                user: text_setting(s.setting(keys::ANKI_SYNC_USER)?),
                ca_cert: text_setting(s.setting(keys::ANKI_SYNC_CA_CERT)?),
                last_at: s.setting(keys::ANKI_SYNC_LAST_AT)?.as_i64(),
                first_done: text_setting(s.setting(keys::ANKI_SYNC_FIRST_DONE)?),
            })
        })
    }

    fn set_text_setting(&self, key: &'static str, value: Option<&str>) -> Result<(), AppError> {
        let value = value.map_or(Value::Null, |v| Value::String(v.to_owned()));
        self.with_store(|s| s.set_setting(key, value))
    }

    /// Credentials of the configured account, `None` when logged out. Blocks (keychain).
    pub(crate) fn sync_credentials(
        &self,
        settings: &SyncSettings,
    ) -> Result<Option<(SyncCredentials, String)>, AppError> {
        let (Some(url), Some(account)) = (settings.url.as_deref(), settings.account()) else {
            return Ok(None);
        };
        let Some(hkey) = self.sync.secrets.get(&account)? else {
            return Ok(None);
        };
        let endpoint = SyncEndpoint::parse(url)?;
        let mut config = SyncConfig::new(endpoint);
        config.ca_cert_pem = settings.ca_cert.clone();
        Ok(Some((SyncCredentials { config, hkey }, account)))
    }

    /// Creates the scheduler state on first use: logged in when URL, user and key are present.
    /// Blocks (store, keychain).
    pub(crate) fn sync_init(&self) -> Result<SyncSettings, AppError> {
        let settings = self.sync_settings()?;
        if lock(&self.sync.inner).policy.is_some() {
            return Ok(settings);
        }
        let (logged_in, error) = match self.sync_credentials(&settings) {
            Ok(creds) => (creds.is_some(), None),
            Err(e) => {
                tracing::warn!(code = %e.code, "could not read the sync account");
                (false, settings.account().map(|_| SyncErrorInfo::from(&e)))
            }
        };
        let timings = lock(&self.sync.timings).clone();
        let mut hub = lock(&self.sync.inner);
        if hub.policy.is_none() {
            hub.policy = Some(Policy::new(timings, logged_in, settings.last_at));
            if hub.last_error.is_none() {
                hub.last_error = error;
            }
        }
        Ok(settings)
    }

    /// The collection was replaced by a `.colpkg`: it is disposable now (spec 9), so the next sync
    /// of the account is a first sync again (always a download, never a merge or an upload) and a
    /// pending full-sync choice no longer applies. Blocks (store).
    pub(crate) fn sync_collection_replaced(&self) -> Result<(), AppError> {
        self.set_text_setting(keys::ANKI_SYNC_FIRST_DONE, None)?;
        let has_policy = lock(&self.sync.inner).policy.is_some();
        if has_policy {
            self.with_policy(|p, hub| {
                p.collection_replaced();
                hub.full_sync = None;
            });
            self.emit_sync_status()?;
        }
        Ok(())
    }

    /// Runs `f` on the scheduler state (initialised by [`AppState::sync_init`]).
    pub(crate) fn with_policy<R>(&self, f: impl FnOnce(&mut Policy, &mut HubState) -> R) -> R {
        let timings = lock(&self.sync.timings).clone();
        let mut hub = lock(&self.sync.inner);
        match hub.policy.take() {
            Some(mut policy) => {
                let out = f(&mut policy, &mut hub);
                hub.policy = Some(policy);
                out
            }
            // Not initialised (the settings could not be read): a logged-out throwaway, so a
            // later `sync_init` still reads the real account.
            None => f(&mut Policy::new(timings, false, None), &mut hub),
        }
    }

    fn fingerprint(&self, pem: Option<&str>) -> Option<String> {
        let pem = pem?;
        let mut hub = lock(&self.sync.inner);
        if let Some((cached, fp)) = &hub.fingerprint
            && cached == pem
        {
            return fp.clone();
        }
        let fp = validate_certificate(pem)
            .ok()
            .map(|info| info.fingerprint_sha256);
        hub.fingerprint = Some((pem.to_owned(), fp.clone()));
        fp
    }

    /// The current status. Blocks (store; the keychain the first time).
    pub fn anki_sync_status(&self) -> Result<AnkiSyncStatus, AppError> {
        let settings = self.sync_init()?;
        Ok(self.status_from(&settings))
    }

    pub(crate) fn status_from(&self, settings: &SyncSettings) -> AnkiSyncStatus {
        let certificate_fingerprint = self.fingerprint(settings.ca_cert.as_deref());
        let hub = lock(&self.sync.inner);
        let policy = hub.policy.as_ref();
        let logged_in = policy.is_some_and(Policy::is_logged_in) && settings.account().is_some();
        let running = policy.is_some_and(|p| {
            p.is_running() || p.requested().is_some_and(Reason::is_user_initiated)
        });
        let next_retry_at = policy.and_then(Policy::retry_due);
        let state = if !logged_in {
            SyncState::Off
        } else if running {
            SyncState::Syncing
        } else if hub.full_sync.is_some() {
            SyncState::FullSyncRequired
        } else if matches!(
            hub.last_failure,
            Some(SyncFailure::Offline | SyncFailure::Timeout)
        ) {
            SyncState::Offline
        } else if hub.last_error.is_some() {
            SyncState::Error
        } else {
            SyncState::Idle
        };
        let first_sync_pending =
            logged_in && settings.account().is_some() && settings.first_done != settings.account();
        AnkiSyncStatus {
            state,
            url: settings.url.clone(),
            user: settings.user.clone(),
            logged_in,
            certificate_fingerprint,
            first_sync_pending,
            last_sync_at: settings.last_at,
            last_error: hub.last_error.clone(),
            full_sync: if logged_in { hub.full_sync } else { None },
            next_retry_at: if logged_in { next_retry_at } else { None },
            media_syncing: false,
            media_error: hub.media_error.clone(),
            server_message: hub.server_message.clone(),
        }
    }

    /// Builds the status and sends it as `anki://sync`. Blocks (store).
    pub(crate) fn emit_sync_status(&self) -> Result<AnkiSyncStatus, AppError> {
        let status = self.anki_sync_status()?;
        self.emit(UiEvent::AnkiSync(status.clone()));
        Ok(status)
    }

    /// Logs in, keeps the key in the keychain (never the password), saves the account and starts
    /// the first sync (always a download) in the background. Nothing is stored on failure.
    pub async fn anki_sync_login(
        self: &Arc<Self>,
        url: String,
        user: String,
        password: String,
        certificate_pem: Option<String>,
    ) -> Result<AnkiSyncStatus, AppError> {
        let endpoint = SyncEndpoint::parse(&url)?;
        let user = user.trim().to_owned();
        let pem = certificate_pem
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty());
        if let Some(pem) = &pem {
            validate_certificate(pem)?;
        }
        // No certificate in the request: keep the saved one (the settings screen saves and
        // removes it on its own through `anki_sync_set_certificate`).
        let pem = match pem {
            Some(pem) => Some(pem),
            None => {
                let this = Arc::clone(self);
                blocking(move || Ok(this.sync_settings()?.ca_cert)).await?
            }
        };
        let mut config = SyncConfig::new(endpoint.clone());
        config.ca_cert_pem = pem.clone();
        let hkey = core_sync::login(&config, &user, &password).await;
        drop(password);
        let hkey = hkey?;

        let this = Arc::clone(self);
        let status = blocking(move || {
            let previous = this.sync_settings()?;
            let account = sync_account(&user, endpoint.as_str());
            this.sync.secrets.set(&account, &hkey)?;
            if let Some(prev) = previous.account()
                && prev != account
                && let Err(e) = this.sync.secrets.delete(&prev)
            {
                tracing::warn!(code = %e.code, "could not delete the previous sync key");
            }
            this.set_text_setting(keys::ANKI_SYNC_URL, Some(endpoint.as_str()))?;
            this.set_text_setting(keys::ANKI_SYNC_USER, Some(&user))?;
            this.set_text_setting(keys::ANKI_SYNC_CA_CERT, pem.as_deref())?;
            if previous.first_done.is_some() && previous.first_done.as_deref() != Some(&account) {
                this.set_text_setting(keys::ANKI_SYNC_FIRST_DONE, None)?;
            }
            this.sync.bump_generation();
            this.sync_init()?;
            this.with_policy(|p, hub| {
                hub.last_error = None;
                hub.last_failure = None;
                hub.full_sync = None;
                hub.server_message = None;
                hub.media_error = None;
                p.notify(Trigger::Login, now_ms());
            });
            this.emit_sync_status()
        })
        .await?;
        tracing::info!(endpoint = %status.url.as_deref().unwrap_or(""), "logged in to the sync server");
        driver::ensure_started(self);
        self.sync.wake();
        Ok(status)
    }

    /// Deletes the key from the keychain and stops syncing; URL, user and certificate stay for
    /// the next login. Blocks.
    pub fn anki_sync_logout(&self) -> Result<AnkiSyncStatus, AppError> {
        let settings = self.sync_init()?;
        self.sync.bump_generation();
        let waiters = self.with_policy(|p, hub| {
            p.set_logged_out();
            hub.last_error = None;
            hub.last_failure = None;
            hub.full_sync = None;
            hub.server_message = None;
            hub.media_error = None;
            std::mem::take(&mut hub.waiters)
        });
        for w in waiters {
            let _ = w.send(());
        }
        self.abort_sync();
        if let Some(account) = settings.account() {
            self.sync.secrets.delete(&account)?;
        }
        tracing::info!("logged out of the sync server");
        self.emit_sync_status()
    }

    /// Sets (validated) or clears the extra root certificate. Blocks.
    pub fn anki_sync_set_certificate(
        &self,
        pem: Option<String>,
    ) -> Result<AnkiSyncStatus, AppError> {
        let pem = pem.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
        if let Some(pem) = &pem {
            validate_certificate(pem)?;
        }
        self.set_text_setting(keys::ANKI_SYNC_CA_CERT, pem.as_deref())?;
        self.emit_sync_status()
    }

    /// A notification from the UI (tab entered, window visible, network back/lost). Blocks
    /// (the first time: store, keychain).
    pub fn anki_sync_notify(&self, notice: SyncNotice) -> Result<(), AppError> {
        self.sync_init()?;
        self.with_policy(|p, _| p.notify(notice.into(), now_ms()));
        self.sync.wake();
        Ok(())
    }

    /// Hook of `anki_answer`: re-arms the after-answer sync.
    pub(crate) fn sync_answered(&self) {
        let has_policy = lock(&self.sync.inner).policy.is_some();
        if has_policy {
            self.with_policy(|p, _| p.notify(Trigger::Answered, now_ms()));
            self.sync.wake();
        }
    }

    /// Syncs now and waits for it; failures end up in `lastError` (the call resolves). Rejects
    /// only when logged out.
    pub async fn anki_sync(self: &Arc<Self>) -> Result<AnkiSyncStatus, AppError> {
        let this = Arc::clone(self);
        let rx = blocking(move || {
            this.sync_init()?;
            this.with_policy(|p, hub| {
                if !p.is_logged_in() {
                    return Err(not_logged_in());
                }
                let (tx, rx) = oneshot::channel();
                hub.waiters.push(tx);
                p.notify(Trigger::Manual, now_ms());
                Ok(rx)
            })
        })
        .await?;
        driver::ensure_started(self);
        self.sync.wake();
        let _ = rx.await;
        let this = Arc::clone(self);
        blocking(move || this.anki_sync_status()).await
    }

    /// Full sync in the direction the user chose (the full-sync dialog). A `PreSync` backup is
    /// written first by the core and returned. Never called by the scheduler.
    pub async fn anki_sync_full(
        self: &Arc<Self>,
        direction: FullSyncDirection,
    ) -> Result<FullSyncResult, AppError> {
        let this = Arc::clone(self);
        let (creds, handles) = blocking(move || {
            let settings = this.sync_init()?;
            let Some((creds, account)) = this.sync_credentials(&settings)? else {
                return Err(not_logged_in());
            };
            let first_sync_pending = settings.first_done.as_deref() != Some(account.as_str());
            let handles = this.anki_handles()?;
            this.with_policy(|p, hub| {
                if !p.is_logged_in() {
                    return Err(not_logged_in());
                }
                if p.is_running() {
                    return Err(busy());
                }
                check_full_sync_allowed(direction, hub.full_sync, first_sync_pending)?;
                p.started(now_ms());
                Ok(())
            })?;
            Ok((creds, handles))
        })
        .await?;
        let generation = self.sync.generation();
        let _ = self.emit_status_async().await;
        handles.study.close();
        let result = handles.svc.sync_full(&creds, direction).await;
        // Whatever happened, the collection was closed and reopened: nothing cached survives.
        handles.study.reset();
        handles.bridge.reset();
        let this = Arc::clone(self);
        let outcome = blocking(move || {
            let current = this.sync.generation() == generation;
            match result {
                Ok(report) => {
                    let backup = match report.outcome {
                        SyncOutcome::FullDownloaded { backup }
                        | SyncOutcome::FullUploaded { backup } => backup,
                        _ => return Err(AppError::internal("full sync without a backup")),
                    };
                    tracing::info!(?direction, backup = %backup.file_name, "full sync done");
                    if current {
                        let settings = this.sync_settings()?;
                        let now = now_ms();
                        this.with_store(|s| s.set_setting(keys::ANKI_SYNC_LAST_AT, now.into()))?;
                        if let Some(account) = settings.account() {
                            this.set_text_setting(keys::ANKI_SYNC_FIRST_DONE, Some(&account))?;
                        }
                        this.with_policy(|p, hub| {
                            p.full_sync_done(now);
                            hub.full_sync = None;
                            hub.last_error = None;
                            hub.last_failure = None;
                            hub.media_error = report.media_error.map(|(_, m)| m);
                        });
                    } else {
                        this.with_policy(|p, _| p.finished(Finished::Failed, now_ms()));
                    }
                    this.emit(UiEvent::AnkiChanged(ChangeReason::SyncFull));
                    let status = this.emit_sync_status()?;
                    Ok(FullSyncResult { status, backup })
                }
                Err(e) => {
                    let e = AppError::from(e);
                    this.with_policy(|p, hub| {
                        // Still waiting for a choice: the dialog stays.
                        let outcome = if hub.full_sync.is_some() {
                            Finished::FullSyncRequired
                        } else {
                            Finished::Failed
                        };
                        p.finished(outcome, now_ms());
                        if current {
                            hub.last_error = Some(SyncErrorInfo::from(&e));
                        }
                    });
                    this.emit(UiEvent::AnkiChanged(ChangeReason::SyncFull));
                    let _ = this.emit_sync_status();
                    Err(e)
                }
            }
        })
        .await;
        self.sync.wake();
        outcome
    }

    async fn emit_status_async(self: &Arc<Self>) -> Result<AnkiSyncStatus, AppError> {
        let this = Arc::clone(self);
        blocking(move || this.emit_sync_status()).await
    }

    /// Stops a running sync (logout, exit). Never blocks.
    pub(crate) fn abort_sync(&self) {
        if let Some(h) = lock(&self.anki_handles).as_ref() {
            h.svc.abort_sync();
        }
    }
}

/// Runs blocking work (store, keychain, collection open) off the async runtime.
pub(crate) async fn blocking<R, F>(f: F) -> Result<R, AppError>
where
    R: Send + 'static,
    F: FnOnce() -> Result<R, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_every_key() {
        let status = AnkiSyncStatus {
            state: SyncState::FullSyncRequired,
            url: None,
            user: None,
            logged_in: false,
            certificate_fingerprint: None,
            first_sync_pending: false,
            last_sync_at: None,
            last_error: None,
            full_sync: None,
            next_retry_at: None,
            media_syncing: false,
            media_error: None,
            server_message: None,
        };
        let v = serde_json::to_value(&status).unwrap();
        assert_eq!(v["state"], "fullSyncRequired");
        assert_eq!(v.as_object().unwrap().len(), 13);
        assert!(v["lastError"].is_null() && v["fullSync"].is_null());
        let n: SyncNotice = serde_json::from_value("tabEntered".into()).unwrap();
        assert_eq!(n, SyncNotice::TabEntered);
        assert!(serde_json::from_value::<SyncNotice>("upload".into()).is_err());
        assert_eq!(serde_json::to_value(SyncState::Off).unwrap(), "off");
    }

    #[test]
    fn full_sync_only_when_required_and_in_an_allowed_direction() {
        use FullSyncDirection::{Download, Upload};
        let choice = |upload_ok, download_ok| {
            Some(FullSyncChoice {
                upload_ok,
                download_ok,
            })
        };
        let code = |d, c, first| check_full_sync_allowed(d, c, first).err().map(|e| e.code);
        // Not required: never an upload; a download only for the first sync of the account.
        for first in [false, true] {
            assert_eq!(
                code(Upload, None, first).as_deref(),
                Some("anki_sync_full_not_required")
            );
        }
        assert_eq!(
            code(Download, None, false).as_deref(),
            Some("anki_sync_full_not_required")
        );
        assert_eq!(code(Download, None, true), None);
        // Required: only the directions the server allowed.
        for first in [false, true] {
            assert_eq!(
                code(Upload, choice(false, true), first).as_deref(),
                Some("anki_sync_upload_not_allowed")
            );
            assert_eq!(
                code(Download, choice(true, false), first).as_deref(),
                Some("anki_sync_download_not_allowed")
            );
            assert_eq!(code(Download, choice(true, true), first), None);
            assert_eq!(code(Upload, choice(true, false), first), None);
        }
        assert_eq!(code(Upload, choice(true, true), false), None);
        // First sync: an upload only when the server has nothing to download (empty server).
        assert_eq!(
            code(Upload, choice(true, true), true).as_deref(),
            Some("anki_sync_upload_not_allowed")
        );
    }
}
