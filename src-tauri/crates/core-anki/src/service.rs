use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread::{self, JoinHandle, ThreadId};

use anki::collection::{Collection, CollectionBuilder};
use anki::prelude::I18n;

use crate::error::{Error, Result};
use crate::types::DeckTree;

type Job = Box<dyn FnOnce(&mut Collection) + Send>;

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
        let col = CollectionBuilder::new(&paths.collection)
            .set_media_paths(paths.media_folder.clone(), paths.media_db.clone())
            .set_tr(tr.clone())
            .build()
            .map_err(|source| Error::Open {
                path: paths.collection.clone(),
                message: source.message(&tr),
                source: Box::new(source),
            })?;

        let (tx, rx) = mpsc::channel::<Job>();
        let thread = thread::Builder::new()
            .name("anki-actor".into())
            .spawn(move || run_actor(col, rx))
            .map_err(Error::Spawn)?;
        Ok(Self {
            inner: Arc::new(Inner {
                tx: Mutex::new(Some(tx)),
                thread_id: thread.thread().id(),
                thread: Mutex::new(Some(thread)),
                paths,
            }),
        })
    }

    pub fn paths(&self) -> &CollectionPaths {
        &self.inner.paths
    }

    /// Runs `f` on the actor thread and awaits its result. Calls are executed one at a time,
    /// in the order they were submitted.
    pub async fn call<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Collection) -> Result<R> + Send + 'static,
    {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.submit(f, move |res| {
            let _ = reply.send(res);
        })?;
        rx.await.unwrap_or(Err(Error::Closed))
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
        self.submit(f, move |res| {
            let _ = reply.send(res);
        })?;
        rx.recv().unwrap_or(Err(Error::Closed))
    }

    fn submit<R, F>(&self, f: F, reply: impl FnOnce(Result<R>) + Send + 'static) -> Result<()>
    where
        R: Send + 'static,
        F: FnOnce(&mut Collection) -> Result<R> + Send + 'static,
    {
        let job: Job = Box::new(move |col| {
            let res = match catch_unwind(AssertUnwindSafe(|| f(col))) {
                Ok(res) => res.map_err(|e| e.localized(col.tr())),
                Err(panic) => {
                    tracing::error!(panic = panic_message(&panic), "panic in Anki actor job");
                    Err(Error::Panicked)
                }
            };
            reply(res);
        });
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

fn run_actor(mut col: Collection, rx: mpsc::Receiver<Job>) -> Result<()> {
    while let Ok(job) = rx.recv() {
        job(&mut col);
    }
    let tr = col.tr().clone();
    col.close(None).map_err(|e| Error::from_anki(e, &tr))
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("(sem mensagem)")
}
