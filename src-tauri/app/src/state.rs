use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use core_anki::AnkiService;
use core_pdf::{DocHandle, DocumentEngine, PdfcraftEngine};
use core_store::Store;

use crate::error::AppError;

/// Everything the commands and protocols share. Managed by Tauri as `Arc<AppState>` so that
/// blocking work can take a clone off the async runtime.
///
/// The collection and the store open lazily (and are retried after a failure, e.g. when another
/// instance holds the collection), so a broken data dir never keeps the window from showing.
pub struct AppState {
    data_dir: PathBuf,
    anki: Mutex<Option<AnkiService>>,
    /// A throwaway collection for the smoke check, which seeds demo decks: they must never
    /// reach the user's collection (and, from Phase 3, AnkiWeb).
    smoke_anki: Mutex<Option<AnkiService>>,
    store: Mutex<Option<Store>>,
    pdf: PdfcraftEngine,
    /// The document opened by the last smoke run, closed by the next one.
    smoke_doc: Mutex<Option<DocHandle>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            anki: Mutex::new(None),
            smoke_anki: Mutex::new(None),
            store: Mutex::new(None),
            pdf: PdfcraftEngine::new(),
            smoke_doc: Mutex::new(None),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn anki_dir(&self) -> PathBuf {
        self.data_dir.join("anki")
    }

    pub fn smoke_anki_dir(&self) -> PathBuf {
        self.data_dir.join("smoke").join("anki")
    }

    pub fn store_path(&self) -> PathBuf {
        self.data_dir.join("leitor.sqlite")
    }

    /// The collection service, opening it on first use. Blocks: call it off the async runtime.
    pub fn anki(&self) -> Result<AnkiService, AppError> {
        open_service(&self.anki, &self.anki_dir())
    }

    /// The smoke check's own collection (never the user's), opening it on first use. Blocks.
    pub fn smoke_anki(&self) -> Result<AnkiService, AppError> {
        open_service(&self.smoke_anki, &self.smoke_anki_dir())
    }

    /// Runs `f` with the app database, opening it on first use. Blocks.
    pub fn with_store<R>(
        &self,
        f: impl FnOnce(&mut Store) -> core_store::Result<R>,
    ) -> Result<R, AppError> {
        let mut slot = lock(&self.store);
        if slot.is_none() {
            let store = Store::open(self.store_path())?;
            tracing::info!(path = %self.store_path().display(), "app database open");
            *slot = Some(store);
        }
        let store = slot.as_mut().expect("store was just opened");
        Ok(f(store)?)
    }

    pub fn pdf(&self) -> &PdfcraftEngine {
        &self.pdf
    }

    /// Remembers the smoke document and returns the previous one.
    pub fn replace_smoke_doc(&self, doc: DocHandle) -> Option<DocHandle> {
        lock(&self.smoke_doc).replace(doc)
    }

    /// Opens the collection and the database in the background so the first command is fast.
    pub fn warm_up(self: &Arc<Self>) {
        let state = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("warm-up".into())
            .spawn(move || {
                if let Err(e) = state.anki() {
                    tracing::warn!(code = %e.code, "could not open the Anki collection: {e}");
                }
                if let Err(e) = state.with_store(|s| s.schema_version()) {
                    tracing::warn!(code = %e.code, "could not open the app database: {e}");
                }
            });
        if let Err(e) = spawned {
            tracing::warn!(%e, "could not start the warm-up thread");
        }
    }

    /// Closes the collection cleanly (flushes and releases the SQLite lock) and every document.
    pub fn shutdown(&self) {
        for slot in [&self.anki, &self.smoke_anki] {
            if let Some(svc) = lock(slot).take()
                && let Err(e) = svc.shutdown()
            {
                tracing::warn!(code = %e.code(), "closing the Anki collection failed: {e}");
            }
        }
        lock(&self.store).take();
        for doc in self.pdf.open_documents() {
            self.pdf.close(doc);
        }
    }
}

fn open_service(slot: &Mutex<Option<AnkiService>>, dir: &Path) -> Result<AnkiService, AppError> {
    let mut slot = lock(slot);
    if let Some(svc) = slot.as_ref() {
        return Ok(svc.clone());
    }
    let svc = AnkiService::open(dir)?;
    tracing::info!(path = %svc.paths().collection.display(), "Anki collection open");
    *slot = Some(svc.clone());
    Ok(svc)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}
