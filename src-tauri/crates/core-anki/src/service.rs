use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread::{self, JoinHandle, ThreadId};

use anki::collection::{Collection, CollectionBuilder};
use anki::prelude::I18n;

use crate::error::{Error, Result};
use crate::types::{BackupInfo, DeckTree};

type Job = Box<dyn FnOnce(&mut Actor) + Send>;
/// Type-erased access to rslib's (unnameable) `ProgressState.want_abort`: `Some(v)` sets it,
/// `None` only reads it.
pub(crate) type AbortFn = Arc<dyn Fn(Option<bool>) -> bool + Send + Sync>;

/// Files of a collection folder, using the desktop layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionPaths {
    pub collection: PathBuf,
    pub media_folder: PathBuf,
    pub media_db: PathBuf,
}

impl CollectionPaths {
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            collection: dir.join("collection.anki2"),
            media_folder: dir.join("collection.media"),
            media_db: dir.join("collection.mdb"),
        }
    }

    /// The folder holding the collection file.
    pub fn dir(&self) -> &Path {
        self.collection.parent().unwrap_or(Path::new("."))
    }
}

/// Handle to the actor thread that owns the collection. Cheap to clone; the collection is
/// closed when [`AnkiService::shutdown`] is called or the last handle is dropped.
#[derive(Clone)]
pub struct AnkiService {
    inner: Arc<Inner>,
}

struct Inner {
    tx: Mutex<Option<mpsc::Sender<Job>>>,
    thread: Mutex<Option<JoinHandle<Result<()>>>>,
    thread_id: ThreadId,
    paths: CollectionPaths,
    abort: AbortFn,
    sync: crate::sync::SyncControl,
}

/// State of the actor thread. The collection is `None` only between a close and a successful
/// reopen (see [`AnkiService::replace_collection`]); the next job retries the reopen.
pub(crate) struct Actor {
    col: Option<Collection>,
    builder: CollectionBuilder,
    paths: CollectionPaths,
    tr: I18n,
}

impl Actor {
    fn ensure_open(&mut self) -> Result<&mut Collection> {
        if self.col.is_none() {
            let col = self.builder.build().map_err(|source| Error::Open {
                path: self.paths.collection.clone(),
                message: source.message(&self.tr),
                source: Box::new(source),
            })?;
            self.col = Some(col);
        }
        self.col.as_mut().ok_or(Error::Closed)
    }

    /// Takes the collection out, hands it to `f` (which consumes/closes it) and always reopens
    /// afterwards. Returns `f`'s result; a reopen failure is reported only if `f` succeeded
    /// (the next job retries the reopen).
    fn with_owned<R>(&mut self, f: impl FnOnce(Collection) -> Result<R>) -> Result<R> {
        let col = match self.col.take() {
            Some(col) => col,
            None => self.builder.build().map_err(|source| Error::Open {
                path: self.paths.collection.clone(),
                message: source.message(&self.tr),
                source: Box::new(source),
            })?,
        };
        let res = catch_unwind(AssertUnwindSafe(|| f(col))).unwrap_or_else(|panic| {
            tracing::error!(
                panic = panic_message(&panic),
                "panic while the collection was closed"
            );
            Err(Error::Panicked)
        });
        let reopened = self.ensure_open().map(|_| ());
        match (res, reopened) {
            (Err(e), _) => Err(e.localized(&self.tr)),
            (Ok(_), Err(e)) => Err(e),
            (Ok(r), Ok(())) => Ok(r),
        }
    }
}

impl AnkiService {
    /// Opens (or creates) `dir/collection.anki2` with its media folder and media DB.
    pub fn open(dir: &Path) -> Result<Self> {
        let paths = CollectionPaths::in_dir(dir);
        for folder in [dir, paths.media_folder.as_path()] {
            std::fs::create_dir_all(folder).map_err(|source| Error::CreateDir {
                path: folder.to_path_buf(),
                source,
            })?;
        }
        let tr = I18n::new(&["pt-BR"]);
        let progress = Arc::new(Mutex::new(Default::default()));
        let mut builder = CollectionBuilder::new(&paths.collection);
        builder
            .set_media_paths(paths.media_folder.clone(), paths.media_db.clone())
            .set_tr(tr.clone())
            .set_shared_progress_state(Arc::clone(&progress));
        let col = builder.build().map_err(|source| Error::Open {
            path: paths.collection.clone(),
            message: source.message(&tr),
            source: Box::new(source),
        })?;
        // Never enters the actor (docs/decisoes.md: setWantsAbort outside the actor).
        let abort: AbortFn = Arc::new(move |set| {
            let mut state = progress.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(value) = set {
                state.want_abort = value;
            }
            state.want_abort
        });

        let actor = Actor {
            col: Some(col),
            builder,
            paths: paths.clone(),
            tr,
        };
        let (tx, rx) = mpsc::channel::<Job>();
        let thread = thread::Builder::new()
            .name("anki-actor".into())
            .spawn(move || run_actor(actor, rx))
            .map_err(Error::Spawn)?;
        Ok(Self {
            inner: Arc::new(Inner {
                tx: Mutex::new(Some(tx)),
                thread_id: thread.thread().id(),
                thread: Mutex::new(Some(thread)),
                paths,
                abort,
                sync: Default::default(),
            }),
        })
    }

    pub fn paths(&self) -> &CollectionPaths {
        &self.inner.paths
    }

    /// Asks the running rslib operation (import, export, check…) to stop at its next progress
    /// update. Safe to call from any thread while a job runs: it never goes through the actor.
    pub fn request_abort(&self) {
        (self.inner.abort)(Some(true));
    }

    /// The `want_abort` setter itself, for a job that must raise it from inside the actor (an
    /// rslib operation resets the flag when it starts, see `normal_sync_on_actor`).
    pub(crate) fn abort_handle(&self) -> AbortFn {
        Arc::clone(&self.inner.abort)
    }

    /// Whether an abort was requested and not yet consumed by an rslib operation.
    pub fn abort_requested(&self) -> bool {
        (self.inner.abort)(None)
    }

    /// Runs `f` on the actor thread and awaits its result. Calls are executed one at a time,
    /// in the order they were submitted.
    pub async fn call<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Collection) -> Result<R> + Send + 'static,
    {
        self.run_async(move |actor| run_on_collection(actor, f))
            .await
    }

    /// Blocking variant of [`AnkiService::call`]. Must not be called from inside an actor job.
    pub fn call_blocking<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Collection) -> Result<R> + Send + 'static,
    {
        if thread::current().id() == self.inner.thread_id {
            return Err(Error::Reentrant);
        }
        let (reply, rx) = mpsc::sync_channel(1);
        self.submit(Box::new(move |actor| {
            let _ = reply.send(run_on_collection(actor, f));
        }))?;
        rx.recv().unwrap_or(Err(Error::Closed))
    }

    /// Closes the collection, runs `f` with its paths (it may replace the collection file and
    /// media), then ALWAYS reopens the collection and returns `f`'s result. If the reopen fails
    /// the service stays usable: the next call tries again.
    ///
    /// Never while a sync runs (a sync/media sync error `Busy`); no sync starts until it is done.
    pub async fn replace_collection<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&CollectionPaths) -> Result<R> + Send + 'static,
    {
        let _no_sync = self.exclude_sync().await?;
        self.replace_collection_unguarded(f).await
    }

    /// Holds off every sync for the life of the guard: fails with `Busy` if one is running and
    /// waits for a leftover media sync thread (its own handle on the media DB) to let go.
    async fn exclude_sync(&self) -> Result<crate::sync::RunningGuard<'_>> {
        let guard = self.sync_control().try_start()?;
        self.abort_media_and_wait().await;
        Ok(guard)
    }

    async fn replace_collection_unguarded<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&CollectionPaths) -> Result<R> + Send + 'static,
    {
        self.run_async(move |actor| {
            let paths = actor.paths.clone();
            let tr = actor.tr.clone();
            actor.with_owned(move |col| {
                col.close(None).map_err(|e| Error::from_anki(e, &tr))?;
                f(&paths)
            })
        })
        .await
    }

    /// Hands the collection to `f`, which consumes it (rslib's full sync), and always reopens it
    /// afterwards, even when `f` fails or panics.
    pub(crate) async fn with_owned_collection<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(Collection) -> Result<R> + Send + 'static,
    {
        self.run_async(move |actor| actor.with_owned(f)).await
    }

    pub(crate) fn sync_control(&self) -> &crate::sync::SyncControl {
        &self.inner.sync
    }

    /// Writes a consistent copy of the collection database to `dest` with SQLite's
    /// `VACUUM INTO`, without closing the collection (the undo queue survives). Jobs run between
    /// rslib operations, so no transaction is open. Only this copy runs on the actor.
    pub(crate) async fn snapshot_collection(&self, dest: PathBuf) -> Result<()> {
        let Some(target) = dest.to_str().map(str::to_owned) else {
            return Err(Error::io(
                &dest,
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "caminho não é UTF-8"),
            ));
        };
        self.call(move |col| {
            col.storage
                .db()
                .execute("VACUUM INTO ?1", [target])
                .map_err(anki::prelude::AnkiError::from)?;
            Ok(())
        })
        .await
    }

    /// Replaces the whole collection with a `.colpkg` (spec 8.5). A pre-import backup of the
    /// current collection is written first and returned. On failure the previous collection is
    /// kept (rslib writes through a temporary file). Fails with `Busy` while a sync runs (it
    /// would merge into or upload the half-replaced collection and media).
    pub async fn import_colpkg(&self, src: &Path) -> Result<BackupInfo> {
        crate::import_export::validate_package(src, "colpkg")?;
        let _no_sync = self.exclude_sync().await?;
        let backup = crate::backup::backup_now(self, crate::types::BackupKind::PreImport).await?;
        let src = src.to_path_buf();
        self.replace_collection_unguarded(move |p| {
            let (Some(src), Some(col)) = (src.to_str(), p.collection.to_str()) else {
                return Err(Error::InvalidPackage(
                    "o caminho do arquivo não é UTF-8 válido.".into(),
                ));
            };
            anki::import_export::package::import_colpkg(
                src,
                col,
                &p.media_folder,
                &p.media_db,
                Default::default(),
            )
            .map_err(crate::import_export::package_error)
        })
        .await?;
        Ok(backup)
    }

    async fn run_async<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Actor) -> Result<R> + Send + 'static,
    {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.submit(Box::new(move |actor| {
            let _ = reply.send(f(actor));
        }))?;
        rx.await.unwrap_or(Err(Error::Closed))
    }

    fn submit(&self, job: Job) -> Result<()> {
        let tx = self.inner.tx.lock().unwrap_or_else(PoisonError::into_inner);
        tx.as_ref()
            .ok_or(Error::Closed)?
            .send(job)
            .map_err(|_| Error::Closed)
    }

    /// Deck list with today's counts and the "studied today" totals.
    pub async fn deck_tree(&self) -> Result<DeckTree> {
        self.call(crate::decks::deck_tree).await
    }

    /// Creates the demo decks/notes if missing; returns the number of notes added.
    pub async fn seed_demo(&self) -> Result<usize> {
        self.call(crate::demo::seed_demo).await
    }

    /// Runs the queued jobs, closes the collection and waits for the actor thread. Later calls
    /// on any handle fail with [`Error::Closed`]. Idempotent.
    pub fn shutdown(&self) -> Result<()> {
        self.inner.shutdown()
    }
}

/// Runs a normal job: reopens the collection if a previous replace left it closed, catches
/// panics and localizes errors.
fn run_on_collection<R>(
    actor: &mut Actor,
    f: impl FnOnce(&mut Collection) -> Result<R>,
) -> Result<R> {
    let col = actor.ensure_open()?;
    match catch_unwind(AssertUnwindSafe(|| f(col))) {
        Ok(res) => res.map_err(|e| e.localized(col.tr())),
        Err(panic) => {
            tracing::error!(panic = panic_message(&panic), "panic in Anki actor job");
            Err(Error::Panicked)
        }
    }
}

impl Inner {
    fn shutdown(&self) -> Result<()> {
        // Dropping the last sender lets the actor drain its queue and exit.
        self.tx
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if thread::current().id() == self.thread_id {
            // Called from inside a job: the actor closes the collection once the job returns.
            return Ok(());
        }
        let handle = self
            .thread
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        match handle {
            Some(handle) => handle.join().unwrap_or(Err(Error::Panicked)),
            None => Ok(()),
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Err(err) = self.shutdown() {
            tracing::error!(%err, "closing the Anki collection failed");
        }
    }
}

fn run_actor(mut actor: Actor, rx: mpsc::Receiver<Job>) -> Result<()> {
    while let Ok(job) = rx.recv() {
        job(&mut actor);
    }
    match actor.col.take() {
        Some(col) => col.close(None).map_err(|e| Error::from_anki(e, &actor.tr)),
        None => Ok(()),
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("(sem mensagem)")
}
