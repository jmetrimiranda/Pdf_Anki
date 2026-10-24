use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use core_anki::AnkiService;
use core_pdf::{DocHandle, PdfCore};
use core_store::{Clock, ReadingTracker, Store, SystemClock};

use crate::anki::{AnkiHandles, UiSink};
use crate::error::AppError;
use crate::files::BookFiles;
use crate::grants::{ExportGrants, ReadGrants};
use crate::secrets::{self, SecretStore};
use crate::sync::SyncHub;

/// Documents `doc_words` keeps open, keyed by book and file version.
const DOC_CACHE_SIZE: usize = 3;

/// Everything the commands and protocols share. Managed by Tauri as `Arc<AppState>` so that
/// blocking work can take a clone off the async runtime.
///
/// The collection and the store open lazily (and are retried after a failure, e.g. when another
/// instance holds the collection), so a broken data dir never keeps the window from showing.
///
/// Lock order: `library_lock` → `tracker` → `store`; `anki_handles` → `anki`; `docs` is never
/// held across another lock.
pub struct AppState {
    data_dir: PathBuf,
    files: BookFiles,
    anki: Mutex<Option<AnkiService>>,
    /// The study session and the `/_anki/` bridge, created with the collection service.
    pub(crate) anki_handles: Mutex<Option<AnkiHandles>>,
    /// Where events for the UI go (`anki://page`, `anki://changed`, links to open).
    pub(crate) ui_sink: Arc<RwLock<Option<UiSink>>>,
    export_grants: ExportGrants,
    read_grants: ReadGrants,
    /// A throwaway collection for the smoke check, which seeds demo decks: they must never
    /// reach the user's collection (and, from Phase 3, AnkiWeb).
    smoke_anki: Mutex<Option<AnkiService>>,
    store: Mutex<Option<Store>>,
    pdf: Arc<PdfCore>,
    /// `doc_words` documents, most recently used last: `(book_uid, file_hash, handle)`.
    docs: Mutex<VecDeque<(String, String, DocHandle)>>,
    /// Serialises library changes (imports, versions, removals) so version numbers and files
    /// never race.
    library_lock: Mutex<()>,
    tracker: Mutex<ReadingTracker<Arc<dyn Clock>>>,
    /// PDF paths from the command line ("Abrir com"), handed to the UI once.
    open_paths: Mutex<Vec<String>>,
    /// `leitor://` links of the launch, handed to the UI once (`pending_deep_links`).
    pub(crate) deep_links: Mutex<Vec<crate::deep_link::DeepLink>>,
    shutting_down: AtomicBool,
    /// Anki sync: account, key store, scheduler state (spec 9).
    pub(crate) sync: SyncHub,
    /// Vocabulary scanning: data pack, jobs and caches (spec 12).
    pub(crate) vocab: crate::vocab::VocabHub,
    /// OCR of scanned PDFs: models and running jobs (spec 7.2).
    pub(crate) ocr: crate::ocr::OcrHub,
    /// Parsed EPUBs of the last books used (annotations, outline, marks; spec 7.1).
    pub(crate) epubs: crate::epub::EpubCache,
    /// AI: reservations of the calls in flight and the provider adapters (spec 13).
    pub(crate) ai: crate::ai::AiHub,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self::with_clock(data_dir, Arc::new(SystemClock))
    }

    /// Same as [`AppState::new`] with the clock of the reading sessions injected (tests).
    pub fn with_clock(data_dir: PathBuf, clock: Arc<dyn Clock>) -> Self {
        Self::with_secret_store(data_dir, clock, secrets::default_store())
    }

    /// Same as [`AppState::with_clock`] with the store of the sync key injected (tests use a
    /// [`crate::secrets::MemoryStore`]).
    pub fn with_secret_store(
        data_dir: PathBuf,
        clock: Arc<dyn Clock>,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            files: BookFiles::new(&data_dir),
            data_dir,
            anki: Mutex::new(None),
            anki_handles: Mutex::new(None),
            ui_sink: Arc::new(RwLock::new(None)),
            export_grants: ExportGrants::default(),
            read_grants: ReadGrants::default(),
            smoke_anki: Mutex::new(None),
            store: Mutex::new(None),
            pdf: Arc::new(PdfCore::new()),
            docs: Mutex::new(VecDeque::new()),
            library_lock: Mutex::new(()),
            tracker: Mutex::new(ReadingTracker::new(clock)),
            open_paths: Mutex::new(Vec::new()),
            deep_links: Mutex::new(Vec::new()),
            shutting_down: AtomicBool::new(false),
            sync: SyncHub::new(secrets),
            vocab: crate::vocab::VocabHub::default(),
            ocr: crate::ocr::OcrHub::default(),
            epubs: Default::default(),
            ai: crate::ai::AiHub::default(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn files(&self) -> &BookFiles {
        &self.files
    }

    pub fn anki_dir(&self) -> PathBuf {
        self.data_dir.join("anki")
    }

    /// One-shot write grants (`export_pick_path`).
    pub fn export_grants(&self) -> &ExportGrants {
        &self.export_grants
    }

    /// One-shot read grants of Anki packages (`anki_pick_package`, "Abrir com", drag and drop).
    pub fn read_grants(&self) -> &ReadGrants {
        &self.read_grants
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
    ///
    /// Opening also closes the reading sessions a crash left open (spec 6.4) and fails the vocabulary scans it left
    /// running.
    pub fn with_store<R>(
        &self,
        f: impl FnOnce(&mut Store) -> core_store::Result<R>,
    ) -> Result<R, AppError> {
        let mut slot = lock(&self.store);
        if slot.is_none() {
            let mut store = Store::open(self.store_path())?;
            tracing::info!(path = %self.store_path().display(), "app database open");
            // A fresh tracker owns no session, so every open row is a leftover.
            match ReadingTracker::new(SystemClock).recover(&mut store) {
                Ok(report) if !report.closed.is_empty() || report.discarded > 0 => {
                    tracing::info!(
                        closed = report.closed.len(),
                        discarded = report.discarded,
                        "reading sessions recovered"
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(%e, "could not recover the reading sessions"),
            }
            // Likewise, scans a previous run left running (crash, quit) are marked failed.
            match store.recover_vocab_scans() {
                Ok(0) => {}
                Ok(n) => tracing::info!(n, "vocabulary scans recovered"),
                Err(e) => tracing::warn!(%e, "could not recover the vocabulary scans"),
            }
            *slot = Some(store);
        }
        let Some(store) = slot.as_mut() else {
            return Err(AppError::internal("store slot empty after open"));
        };
        Ok(f(store)?)
    }

    pub fn pdf(&self) -> &PdfCore {
        &self.pdf
    }

    pub(crate) fn library_guard(&self) -> MutexGuard<'_, ()> {
        lock(&self.library_lock)
    }

    pub(crate) fn tracker(&self) -> MutexGuard<'_, ReadingTracker<Arc<dyn Clock>>> {
        lock(&self.tracker)
    }

    /// The open document for `(book_uid, file_hash)`, opening it with `open` on a miss. The least
    /// recently used document is closed beyond [`DOC_CACHE_SIZE`].
    pub(crate) fn cached_doc(
        &self,
        book_uid: &str,
        file_hash: &str,
        open: impl FnOnce() -> Result<DocHandle, AppError>,
    ) -> Result<DocHandle, AppError> {
        {
            let mut docs = lock(&self.docs);
            if let Some(i) = docs
                .iter()
                .position(|(u, h, _)| u == book_uid && h == file_hash)
                && let Some(entry) = docs.remove(i)
            {
                let handle = entry.2;
                docs.push_back(entry);
                return Ok(handle);
            }
        }
        // Opened without the lock: parsing a big file must not block other books.
        let handle = open()?;
        let evicted: Vec<DocHandle> = {
            let mut docs = lock(&self.docs);
            docs.push_back((book_uid.to_owned(), file_hash.to_owned(), handle));
            let mut out = Vec::new();
            while docs.len() > DOC_CACHE_SIZE {
                if let Some((_, _, h)) = docs.pop_front() {
                    out.push(h);
                }
            }
            out
        };
        for h in evicted {
            self.pdf.close(h);
        }
        Ok(handle)
    }

    /// Closes the cached documents of a book (a new version was saved or the book was removed).
    pub(crate) fn invalidate_docs(&self, book_uid: &str) {
        let closed: Vec<DocHandle> = {
            let mut docs = lock(&self.docs);
            let (gone, kept): (Vec<_>, Vec<_>) =
                docs.drain(..).partition(|(u, _, _)| u == book_uid);
            docs.extend(kept);
            gone.into_iter().map(|(_, _, h)| h).collect()
        };
        for h in closed {
            self.pdf.close(h);
        }
    }

    /// How many documents `doc_words` keeps open (tests).
    pub fn open_doc_count(&self) -> usize {
        lock(&self.docs).len()
    }

    /// Queues "Abrir com" paths for the UI (Anki packages among them get a read grant).
    pub fn push_open_paths(&self, paths: Vec<String>) {
        if !paths.is_empty() {
            self.grant_packages(&paths);
            lock(&self.open_paths).extend(paths);
        }
    }

    /// The queued "Abrir com" paths; each one is returned once.
    pub fn take_open_paths(&self) -> Vec<String> {
        std::mem::take(&mut *lock(&self.open_paths))
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Relaxed)
    }

    /// Opens the collection and the database in the background so the first command is fast.
    pub fn warm_up(self: &Arc<Self>) {
        let state = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("warm-up".into())
            .spawn(move || {
                if let Err(e) = state.with_store(|s| s.schema_version()) {
                    tracing::warn!(code = %e.code, "could not open the app database: {e}");
                } else {
                    // OCR jobs a previous run left `running` become `failed` (spec 7.2).
                    state.ocr_recover();
                }
                if let Err(e) = state.anki() {
                    tracing::warn!(code = %e.code, "could not open the Anki collection: {e}");
                }
                // The background AI enrichment picks up what was left in its queue.
                state.ai_queue_start();
            });
        if let Err(e) = spawned {
            tracing::warn!(%e, "could not start the warm-up thread");
        }
    }

    /// Closes the collection cleanly (flushes and releases the SQLite lock), the database and
    /// every document.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Relaxed);
        self.vocab.jobs.cancel_all();
        // A running sync stops (a normal sync applying changes finishes or rolls back).
        self.abort_sync();
        self.sync.wake();
        self.ai_queue_kick_for_shutdown();
        if let Some(h) = lock(&self.anki_handles).take() {
            h.study.close();
        }
        for slot in [&self.anki, &self.smoke_anki] {
            if let Some(svc) = lock(slot).take()
                && let Err(e) = svc.shutdown()
            {
                tracing::warn!(code = %e.code(), "closing the Anki collection failed: {e}");
            }
        }
        lock(&self.store).take();
        lock(&self.docs).clear();
        lock(&self.epubs).clear();
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

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}
