//! "Reconhecer texto" (spec 7.2): OCR of a scanned PDF in the native core, as a background job (spec 15
//! `ocr_start`/`ocr_cancel`, progress on `job://<id>`), ending in a NEW VERSION of the book with an invisible
//! text layer (PdfCraft's "Searchable Image") through the existing version mechanism (spec 6.5: same `book_uid`,
//! new `file_hash`/`file_version`, `LeitorBookUid` kept in Info). The text travels inside the file (spec 16), so
//! PdfCraft's search, selection and annotations and the vocabulary scan work on it afterwards.
//!
//! - One OCR at a time in the whole app (recognition already uses every physical core): other books wait in the
//!   `queued` stage, still cancellable.
//! - Cancel discards the partial result: no new version, `ocr_status` goes back to what it was.
//! - The library lock and the store are never held while recognising; the result is written onto the CURRENT
//!   version (a save made by PdfCraft during the OCR is not lost; a different page count fails with
//!   `ocr_book_changed`). The check that the base is still current, the new version and its stored layer are one
//!   step under the library lock, so a PdfCraft autosave never lands between them.
//! - Removing the book cancels its OCR; a job that ends after the removal writes nothing back.
//! - The words placed by the last OCR of each book are kept in `<data_dir>/ocr/<uid>.layer.json`, so a PdfCraft
//!   save based on the version before the OCR gets the layer back ([`AppState::ocr_merge_into_save`]). They are
//!   not under `books/<uid>/`, which pruning empties of everything but the kept versions.
//! - Models: `LEITOR_OCR_MODELS_DIR` → `<resource_dir>/ocr-models` → (debug builds) `src-tauri/resources/ocr-models`;
//!   the first folder with both `.rten` files wins. The engine loads on the first OCR and stays for the app run.
//!
//! The models read English (Latin alphabet without accents); there is no language option. Pure core calls, no
//! desktop APIs (iOS-safe apart from where the resource dir comes from).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use core_pdf::{
    LEITOR_BOOK_UID_KEY, OcrEngine, OcrModels, OcrPageResult, OcrSettings, PdfError, PlacedWord,
};
use core_store::{Book, BookFormat, BookPatch, OcrStatus};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::jobs::{JobHandle, JobKind, JobProgress, JobSink, JobStage, OcrJobInfo, Started};
use crate::state::{AppState, lock};

/// Overrides where the models are (any build).
pub const MODELS_DIR_ENV: &str = "LEITOR_OCR_MODELS_DIR";
/// Name of the bundled resource folder (`tauri.conf.json` → `bundle.resources`).
pub const RESOURCE_NAME: &str = "ocr-models";
/// Folder under the data dir with the per-book OCR layer and last error.
const OCR_DIR: &str = "ocr";
/// Pages sampled for "parece escaneado" after the OCR (same as the import).
const TEXT_SAMPLE_PAGES: usize = 40;
/// How often a queued job checks for cancellation.
const QUEUE_POLL: Duration = Duration::from_millis(100);
/// Attempts to write onto the current version when PdfCraft saves a new one at the same moment.
const WRITE_ATTEMPTS: usize = 3;

/// `ocr_info`: what the library and the panel need to offer "Reconhecer texto".
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrInfo {
    /// The book is a PDF and the models are installed.
    pub available: bool,
    pub status: OcrStatus,
    /// `false` = "parece escaneado" (spec 6.6).
    pub has_text: bool,
    pub pages: u32,
    /// The book's running OCR job, else its last one of this app run (if still known).
    pub job: Option<JobProgress>,
    /// pt-BR message of the last failure, when `status` is `failed`.
    pub last_error: Option<String>,
}

/// `ocr_start`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStarted {
    pub job_id: String,
    /// The book's OCR was already running: this is its job.
    pub already_running: bool,
}

/// The OCR side of [`AppState`].
#[derive(Default)]
pub struct OcrHub {
    resource_dir: Mutex<Option<PathBuf>>,
    /// Wins over every other place (tests).
    models_override: Mutex<Option<PathBuf>>,
    /// The loaded recogniser and the folder it came from.
    engine: Mutex<Option<(PathBuf, OcrEngine)>>,
    /// One OCR at a time: `true` while a job holds the slot.
    busy: Mutex<bool>,
    freed: Condvar,
    /// book_uid → id of its last OCR job of this run.
    last_job: Mutex<std::collections::HashMap<String, String>>,
}

/// The app-wide OCR slot, released on drop.
struct Slot<'a>(&'a OcrHub);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *lock(&self.0.busy) = false;
        self.0.freed.notify_all();
    }
}

impl OcrHub {
    /// Waits for the slot; `None` when `stop()` turns true first.
    fn acquire(&self, stop: impl Fn() -> bool) -> Option<Slot<'_>> {
        let mut busy = lock(&self.busy);
        while *busy {
            if stop() {
                return None;
            }
            busy = self
                .freed
                .wait_timeout(busy, QUEUE_POLL)
                .map(|(g, _)| g)
                .unwrap_or_else(|e| e.into_inner().0);
        }
        if stop() {
            return None;
        }
        *busy = true;
        Some(Slot(self))
    }
}

/// The words of the last OCR of a book (`<data_dir>/ocr/<uid>.layer.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct StoredLayer {
    /// The version the OCR wrote.
    file_version: u32,
    pages: Vec<StoredPage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct StoredPage {
    page: u32,
    words: Vec<StoredWord>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct StoredWord {
    text: String,
    origin: [f64; 2],
    across: [f64; 2],
    up: [f64; 2],
}

impl StoredLayer {
    fn of(file_version: u32, pages: &[OcrPageResult]) -> Self {
        Self {
            file_version,
            pages: pages
                .iter()
                .filter(|p| !p.words.is_empty())
                .map(|p| StoredPage {
                    page: p.page,
                    words: p
                        .words
                        .iter()
                        .map(|w| StoredWord {
                            text: w.text.clone(),
                            origin: w.origin,
                            across: w.across,
                            up: w.up,
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    fn results(&self) -> Vec<OcrPageResult> {
        self.pages
            .iter()
            .map(|p| OcrPageResult {
                page: p.page,
                words: p
                    .words
                    .iter()
                    .map(|w| PlacedWord {
                        text: w.text.clone(),
                        origin: w.origin,
                        across: w.across,
                        up: w.up,
                    })
                    .collect(),
                skipped: None,
                already_on_page: 0,
                ms: 0,
            })
            .collect()
    }
}

fn not_pdf() -> AppError {
    AppError::new("ocr_not_pdf", "O reconhecimento de texto é só para PDFs.")
}

fn has_text() -> AppError {
    AppError::new(
        "ocr_has_text",
        "Este livro já tem texto; o reconhecimento de texto não é necessário.",
    )
}

fn models_missing() -> AppError {
    AppError::new(
        "ocr_models_missing",
        "Os modelos de reconhecimento de texto não foram encontrados nesta instalação.",
    )
}

fn locked() -> AppError {
    AppError::new(
        "ocr_locked",
        "Este PDF tem senha; o reconhecimento de texto não está disponível.",
    )
}

fn no_text() -> AppError {
    AppError::new("ocr_no_text", "Nenhum texto foi reconhecido neste livro.")
}

fn book_changed() -> AppError {
    AppError::new(
        "ocr_book_changed",
        "O livro mudou durante o reconhecimento; tente de novo.",
    )
}

fn cancelled() -> AppError {
    AppError::new("cancelled", "Reconhecimento de texto cancelado.")
}

/// What `ocr_recover` records for a job a previous run left running.
pub const INTERRUPTED: &str = "O reconhecimento de texto foi interrompido.";
/// Shown for a failed OCR whose message was lost.
const FAILED_UNKNOWN: &str = "O reconhecimento de texto não terminou. Tente de novo.";

fn pdf_failure(e: PdfError) -> AppError {
    match e {
        PdfError::NeedsPassword | PdfError::WrongPassword => locked(),
        PdfError::Cancelled => cancelled(),
        PdfError::Ocr(detail) => {
            tracing::warn!(%detail, "ocr engine failed");
            AppError::new(
                "pdf_ocr",
                "Não foi possível carregar o reconhecimento de texto.",
            )
        }
        other => other.into(),
    }
}

/// The first folder of `candidates` with both model files.
fn first_models_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|d| OcrModels::in_dir(d).is_some())
        .cloned()
}

impl AppState {
    /// The app's resource dir (set once in setup, before any command runs).
    pub fn set_ocr_resource_dir(&self, dir: PathBuf) {
        *lock(&self.ocr.resource_dir) = Some(dir);
    }

    /// Uses `dir` for the models instead of the normal lookup (`None` restores it). Tests use it to simulate a
    /// missing install.
    pub fn set_ocr_models_dir(&self, dir: Option<PathBuf>) {
        *lock(&self.ocr.models_override) = dir;
    }

    /// The folder with the OCR models: `LEITOR_OCR_MODELS_DIR` → `<resource_dir>/ocr-models` → (debug builds)
    /// `src-tauri/resources/ocr-models`. `None` when none has both `.rten` files.
    pub fn ocr_models_dir(&self) -> Option<PathBuf> {
        if let Some(dir) = lock(&self.ocr.models_override).clone() {
            return OcrModels::in_dir(&dir).map(|_| dir);
        }
        let mut candidates = Vec::new();
        if let Some(dir) = std::env::var_os(MODELS_DIR_ENV) {
            candidates.push(PathBuf::from(dir));
        }
        if let Some(dir) = lock(&self.ocr.resource_dir).as_ref() {
            candidates.push(dir.join(RESOURCE_NAME));
        }
        if cfg!(debug_assertions) {
            candidates.push(
                Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../resources")).join(RESOURCE_NAME),
            );
        }
        first_models_dir(&candidates)
    }

    /// The recogniser, loaded on first use (a moment: about 12 MB of models) and kept.
    fn ocr_engine(&self) -> Result<OcrEngine, AppError> {
        let dir = self.ocr_models_dir().ok_or_else(models_missing)?;
        let mut slot = lock(&self.ocr.engine);
        if let Some((from, engine)) = slot.as_ref()
            && *from == dir
        {
            return Ok(engine.clone());
        }
        let models = OcrModels::in_dir(&dir).ok_or_else(models_missing)?;
        let started = std::time::Instant::now();
        let engine = OcrEngine::load(&models).map_err(pdf_failure)?;
        tracing::info!(
            dir = %dir.display(),
            ms = started.elapsed().as_millis() as u64,
            "ocr models loaded"
        );
        *slot = Some((dir, engine.clone()));
        Ok(engine)
    }

    fn ocr_book(&self, uid: &str) -> Result<Book, AppError> {
        self.with_store(|s| {
            s.get_book(uid)?
                .ok_or_else(|| core_store::StoreError::BookNotFound(uid.to_owned()))
        })
    }

    /// `<data_dir>/ocr/<uid>.<ext>`; `None` for anything but a well-formed `book_uid`.
    fn ocr_file(&self, uid: &str, ext: &str) -> Option<PathBuf> {
        core_store::is_valid_book_uid(uid)
            .then(|| self.data_dir().join(OCR_DIR).join(format!("{uid}.{ext}")))
    }

    fn ocr_last_error(&self, uid: &str) -> Option<String> {
        let path = self.ocr_file(uid, "error.txt")?;
        std::fs::read_to_string(path)
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
    }

    fn ocr_set_last_error(&self, uid: &str, message: Option<&str>) {
        let Some(path) = self.ocr_file(uid, "error.txt") else {
            return;
        };
        let result = match message {
            Some(m) => crate::files::write_atomic(&path, m.as_bytes()),
            None => match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            },
        };
        if let Err(e) = result {
            tracing::warn!(path = %path.display(), %e, "could not record the OCR error");
        }
    }

    fn ocr_layer(&self, uid: &str) -> Option<StoredLayer> {
        let path = self.ocr_file(uid, "layer.json")?;
        let bytes = std::fs::read(&path).ok()?;
        match serde_json::from_slice(&bytes) {
            Ok(layer) => Some(layer),
            Err(e) => {
                tracing::warn!(path = %path.display(), %e, "unreadable OCR layer");
                None
            }
        }
    }

    /// Deletes what the OCR keeps for a book (its stored layer and last error). For library removal.
    pub(crate) fn ocr_forget(&self, uid: &str) {
        for ext in ["layer.json", "error.txt"] {
            if let Some(path) = self.ocr_file(uid, ext)
                && let Err(e) = std::fs::remove_file(&path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(path = %path.display(), %e, "could not delete an OCR file");
            }
        }
    }

    /// `ocr_info`.
    pub fn ocr_info(&self, uid: &str) -> Result<OcrInfo, AppError> {
        let book = self.ocr_book(uid)?;
        let job = self.vocab.jobs.running_for(JobKind::Ocr, uid).or_else(|| {
            let id = lock(&self.ocr.last_job).get(uid).cloned()?;
            self.vocab.jobs.status(&id)
        });
        let last_error = (book.ocr_status == OcrStatus::Failed).then(|| {
            self.ocr_last_error(uid)
                .unwrap_or_else(|| FAILED_UNKNOWN.to_owned())
        });
        Ok(OcrInfo {
            available: book.format == BookFormat::Pdf && self.ocr_models_dir().is_some(),
            status: book.ocr_status,
            has_text: book.has_text,
            pages: book.pages,
            job,
            last_error,
        })
    }

    /// `ocr_start`: starts "Reconhecer texto" on a PDF of the library (or returns the job already running for it).
    pub fn ocr_start(self: &Arc<Self>, uid: &str) -> Result<OcrStarted, AppError> {
        let book = self.ocr_book(uid)?;
        if book.format != BookFormat::Pdf {
            return Err(not_pdf());
        }
        if let Some(running) = self.vocab.jobs.running_for(JobKind::Ocr, uid) {
            return Ok(OcrStarted {
                job_id: running.job_id,
                already_running: true,
            });
        }
        if self.ocr_models_dir().is_none() {
            return Err(models_missing());
        }
        let bytes = Arc::new(self.book_bytes(uid)?);
        match self.pdf().inspect(bytes, None) {
            Ok(_) => {}
            Err(PdfError::NeedsPassword | PdfError::WrongPassword) => return Err(locked()),
            Err(e) => return Err(e.into()),
        }
        // A PDF with text would only get every page skipped (and a failed status): only scanned books, a failed run
        // or one still marked running (the same rule as the UI's offer) are recognised. After the password check, so
        // a locked PDF says so.
        if book.has_text && !matches!(book.ocr_status, OcrStatus::Failed | OcrStatus::Running) {
            return Err(has_text());
        }
        let job = match self
            .vocab
            .jobs
            .start(JobKind::Ocr, uid, "", self.ocr_job_sink())
        {
            Started::New(job) => job,
            Started::Running(running) => {
                return Ok(OcrStarted {
                    job_id: running.job_id,
                    already_running: true,
                });
            }
        };
        let started = OcrStarted {
            job_id: job.job_id().to_owned(),
            already_running: false,
        };
        // A `running` left by a crash is not a status to go back to.
        let previous = match book.ocr_status {
            OcrStatus::Running => OcrStatus::None,
            other => other,
        };
        self.ocr_set_status(uid, OcrStatus::Running)?;
        self.ocr_set_last_error(uid, None);
        lock(&self.ocr.last_job).insert(uid.to_owned(), started.job_id.clone());
        let state = Arc::clone(self);
        let owned_uid = uid.to_owned();
        let spawned = std::thread::Builder::new()
            .name("ocr".into())
            .spawn(move || state.run_ocr(job, &owned_uid, previous));
        if let Err(e) = spawned {
            let _ = self.ocr_set_status(uid, previous);
            return Err(AppError::internal(e));
        }
        Ok(started)
    }

    /// `ocr_cancel`: asks the book's running OCR to stop (`false` when none runs). The job ends `cancelled`,
    /// with no new version.
    pub fn ocr_cancel(&self, uid: &str) -> bool {
        match self.vocab.jobs.running_for(JobKind::Ocr, uid) {
            Some(p) => self.vocab.jobs.cancel(&p.job_id),
            None => false,
        }
    }

    /// At startup: books a previous run left with `ocr_status` `running` become `failed` ("O reconhecimento de
    /// texto foi interrompido.").
    pub fn ocr_recover(&self) {
        let books = match self.with_store(|s| s.list_library()) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(code = %e.code, "could not recover the OCR jobs: {e}");
                return;
            }
        };
        for entry in books {
            let uid = entry.book.book_uid;
            if entry.book.ocr_status != OcrStatus::Running
                || self.vocab.jobs.running_for(JobKind::Ocr, &uid).is_some()
            {
                continue;
            }
            match self.ocr_set_status(&uid, OcrStatus::Failed) {
                Ok(()) => {
                    self.ocr_set_last_error(&uid, Some(INTERRUPTED));
                    tracing::info!(book_uid = %uid, "interrupted OCR marked failed");
                }
                Err(e) => tracing::warn!(book_uid = %uid, code = %e.code, "OCR recovery: {e}"),
            }
        }
    }

    /// For `book_save_version_from` when a PdfCraft save is based on `base_version` but the current version is
    /// newer: when the last OCR of the book wrote a version after that base, its words are stamped onto `bytes`
    /// (only on pages without an OCR layer), so the save keeps the text layer. Otherwise, or if the bytes can't
    /// take the layer, `bytes` come back unchanged: a user's save never fails because of this.
    pub(crate) fn ocr_merge_into_save(
        &self,
        uid: &str,
        bytes: Vec<u8>,
        base_version: Option<u32>,
    ) -> Result<Vec<u8>, AppError> {
        let Some(base) = base_version else {
            return Ok(bytes);
        };
        let Some(layer) = self.ocr_layer(uid) else {
            return Ok(bytes);
        };
        if layer.file_version <= base || layer.pages.is_empty() {
            return Ok(bytes);
        }
        match core_pdf::apply_text_layer(&bytes, &layer.results(), true) {
            Ok(out) => {
                if out.len() != bytes.len() {
                    tracing::info!(
                        book_uid = %uid,
                        base,
                        ocr_version = layer.file_version,
                        "OCR layer merged into a stale save"
                    );
                }
                Ok(out)
            }
            Err(e) => {
                tracing::warn!(book_uid = %uid, error = ?e, "OCR layer not merged into the save");
                Ok(bytes)
            }
        }
    }

    fn ocr_set_status(&self, uid: &str, status: OcrStatus) -> Result<(), AppError> {
        let patch = BookPatch {
            ocr_status: Some(status),
            ..BookPatch::default()
        };
        self.with_store(|s| s.update_book(uid, &patch))?;
        Ok(())
    }

    fn ocr_job_sink(&self) -> JobSink {
        let slot = Arc::clone(&self.ui_sink);
        Arc::new(move |p| crate::anki::emit_with(&slot, crate::anki::UiEvent::Job(p)))
    }

    fn run_ocr(&self, job: JobHandle, uid: &str, previous: OcrStatus) {
        // A panic (a bug: untrusted input never panics by design) ends the job as failed.
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.ocr_steps(&job, uid)))
                .unwrap_or_else(|_| Err(AppError::internal("OCR panicked")));
        match outcome {
            Ok(info) => {
                tracing::info!(book_uid = %uid, ?info, "OCR done");
                job.set_ocr(info);
                job.done();
            }
            Err(e) if e.code == "cancelled" => {
                self.ocr_record_end(uid, previous, None);
                job.cancelled();
            }
            Err(e) => {
                tracing::warn!(book_uid = %uid, code = %e.code, "OCR failed: {e}");
                self.ocr_record_end(uid, OcrStatus::Failed, Some(&e.message));
                job.failed(&e.code, &e.message);
            }
        }
    }

    /// Records how a job that wrote no version ended: the book's status and its last error. Under the library lock
    /// and only while the book is in the library: a book removed meanwhile (library removal cancels its OCR and
    /// deletes the OCR files) gets nothing written back.
    fn ocr_record_end(&self, uid: &str, status: OcrStatus, error: Option<&str>) {
        let _guard = self.library_guard();
        if self.ocr_book(uid).is_err() {
            tracing::info!(book_uid = %uid, "OCR ended for a book no longer in the library");
            return;
        }
        if let Err(e) = self.ocr_set_status(uid, status) {
            tracing::warn!(book_uid = %uid, code = %e.code, "OCR end: {e}");
        }
        if error.is_some() {
            self.ocr_set_last_error(uid, error);
        }
    }

    fn ocr_steps(&self, job: &JobHandle, uid: &str) -> Result<OcrJobInfo, AppError> {
        let stop = || job.is_cancelled() || self.is_shutting_down();
        let check = || if stop() { Err(cancelled()) } else { Ok(()) };
        // Queued (and told so) until no other OCR runs.
        job.stage(JobStage::Queued, 0);
        let _slot = self.ocr.acquire(stop).ok_or_else(cancelled)?;
        let book = self.ocr_book(uid)?;
        let base_version = book.file_version;
        let bytes = Arc::new(self.book_bytes(uid)?);
        let total = self
            .pdf()
            .inspect(Arc::clone(&bytes), None)
            .map_err(pdf_failure)?
            .page_count;
        job.stage(JobStage::Ocr, total as u64);
        let engine = self.ocr_engine()?;
        check()?;
        let cancel = job.cancel_flag();
        let pages = core_pdf::ocr_pages(
            Arc::clone(&bytes),
            &engine,
            None,
            &OcrSettings::default(),
            &cancel,
            &mut |done, total| {
                if self.is_shutting_down() {
                    cancel.store(true, Ordering::Relaxed);
                }
                job.progress(u64::from(done), u64::from(total));
            },
        )
        .map_err(pdf_failure)?;
        check()?;
        let words: u64 = pages.iter().map(|p| p.words.len() as u64).sum();
        if words == 0 {
            return Err(no_text());
        }
        job.stage(JobStage::Writing, 1);
        let saved = self.ocr_write(uid, base_version, &bytes, &pages, &check)?;
        let has_text = self.ocr_has_text(uid);
        let patch = BookPatch {
            has_text: Some(has_text),
            ocr_status: Some(OcrStatus::Done),
            ..BookPatch::default()
        };
        self.with_store(|s| s.update_book(uid, &patch))?;
        self.invalidate_docs(uid);
        self.vocab.invalidate_marks();
        job.progress(1, 1);

        let read: Vec<&OcrPageResult> = pages.iter().filter(|p| p.skipped.is_none()).collect();
        let pages_read = u32::try_from(read.len()).unwrap_or(u32::MAX);
        let ms_per_page =
            (!read.is_empty()).then(|| read.iter().map(|p| p.ms).sum::<u64>() / read.len() as u64);
        Ok(OcrJobInfo {
            words,
            pages_read,
            pages_skipped: u32::try_from(pages.len())
                .unwrap_or(u32::MAX)
                .saturating_sub(pages_read),
            file_version: Some(saved.file_version),
            ms_per_page,
        })
    }

    /// Writes the text layer onto the current version and records the result as the book's new version. When
    /// PdfCraft saved a version during the OCR, the layer goes onto that one (same page count required).
    fn ocr_write(
        &self,
        uid: &str,
        base_version: u32,
        base_bytes: &Arc<Vec<u8>>,
        pages: &[OcrPageResult],
        check: &dyn Fn() -> Result<(), AppError>,
    ) -> Result<crate::library::SavedVersion, AppError> {
        let page_count = |b: &Arc<Vec<u8>>| -> Result<usize, AppError> {
            Ok(self
                .pdf()
                .inspect(Arc::clone(b), None)
                .map_err(pdf_failure)?
                .page_count)
        };
        let base_pages = page_count(base_bytes)?;
        for _ in 0..WRITE_ATTEMPTS {
            let current = self.ocr_book(uid)?;
            let source = if current.file_version == base_version {
                Arc::clone(base_bytes)
            } else {
                let b = Arc::new(self.book_bytes(uid)?);
                if page_count(&b)? != base_pages {
                    return Err(book_changed());
                }
                tracing::info!(
                    book_uid = %uid,
                    base = base_version,
                    current = current.file_version,
                    "OCR written onto a newer version"
                );
                b
            };
            let layered = core_pdf::apply_text_layer(&source, pages, true).map_err(pdf_failure)?;
            let out =
                core_pdf::stamp_info(&layered, LEITOR_BOOK_UID_KEY, uid).map_err(pdf_failure)?;
            // Checked and committed under the library lock, with the words kept before the lock is released (for a
            // PdfCraft save based on a version before this one). `check` there is the last moment to cancel. PdfCraft
            // may have saved while the layer was written: then start over from that version.
            let saved = self.book_save_version_if_current(
                uid,
                out,
                current.file_version,
                check,
                |saved| {
                    self.ocr_keep_layer(uid, saved.file_version, pages);
                },
            )?;
            if let Some(saved) = saved {
                return Ok(saved);
            }
        }
        Err(book_changed())
    }

    /// Keeps the words written as `file_version` (`<data_dir>/ocr/<uid>.layer.json`), for
    /// [`ocr_merge_into_save`](Self::ocr_merge_into_save).
    fn ocr_keep_layer(&self, uid: &str, file_version: u32, pages: &[OcrPageResult]) {
        let Some(path) = self.ocr_file(uid, "layer.json") else {
            return;
        };
        let layer = StoredLayer::of(file_version, pages);
        let written = serde_json::to_vec(&layer)
            .map_err(std::io::Error::other)
            .and_then(|json| crate::files::write_atomic(&path, &json));
        if let Err(e) = written {
            tracing::warn!(path = %path.display(), %e, "could not keep the OCR layer");
        }
    }

    /// "Parece escaneado" on the new current version. A file whose text can't be sampled counts as text.
    fn ocr_has_text(&self, uid: &str) -> bool {
        let Ok(bytes) = self.book_bytes(uid) else {
            return true;
        };
        let pdf = self.pdf();
        let Ok(doc) = pdf.open(Arc::new(bytes), None) else {
            return true;
        };
        let stats = pdf.text_stats(doc, TEXT_SAMPLE_PAGES);
        pdf.close(doc);
        stats.map_or(true, |s| !s.looks_scanned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_layers_round_trip() {
        let pages = vec![
            OcrPageResult {
                page: 0,
                words: vec![PlacedWord {
                    text: "windmill".into(),
                    origin: [72.0, 700.5],
                    across: [60.25, 0.5],
                    up: [-0.1, 9.0],
                }],
                skipped: None,
                already_on_page: 0,
                ms: 900,
            },
            OcrPageResult {
                page: 1,
                words: Vec::new(),
                skipped: Some("the page already contains text".into()),
                already_on_page: 3,
                ms: 0,
            },
        ];
        let layer = StoredLayer::of(2, &pages);
        assert_eq!(layer.pages.len(), 1, "pages without words are not kept");
        let json = serde_json::to_string(&layer).unwrap();
        let back: StoredLayer = serde_json::from_str(&json).unwrap();
        assert_eq!(back, layer);
        let results = back.results();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].words, pages[0].words);
    }

    /// The OCR's save: the base check, the new version and the stored layer are one step under the library lock;
    /// a moved base or a cancel writes nothing.
    #[test]
    fn the_ocr_save_only_lands_on_its_base() {
        use core_pdf::testkit::{ScanOpts, scanned_pdf};
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().join("data"));
        let original = scanned_pdf(&["windmill"], &ScanOpts::default());
        let path = tmp.path().join("scan.pdf");
        std::fs::write(&path, &original).unwrap();
        let uid = state.library_add(&path, false).unwrap().book.book.book_uid;
        let version = |s: &AppState| s.ocr_book(&uid).unwrap().file_version;
        assert_eq!(version(&state), 1);
        let out = core_pdf::stamp_info(&original, LEITOR_BOOK_UID_KEY, &uid).unwrap();
        let pages = vec![OcrPageResult {
            page: 0,
            words: vec![PlacedWord {
                text: "windmill".into(),
                origin: [72.0, 700.0],
                across: [60.0, 0.0],
                up: [0.0, 9.0],
            }],
            skipped: None,
            already_on_page: 0,
            ms: 1,
        }];
        let keep = |saved: &crate::library::SavedVersion| {
            state.ocr_keep_layer(&uid, saved.file_version, &pages);
        };

        // The current version is no longer the base: nothing is written, the caller starts over.
        let moved = state
            .book_save_version_if_current(&uid, out.clone(), 2, &|| Ok(()), |_| {
                panic!("not committed")
            })
            .unwrap();
        assert!(moved.is_none());
        // Cancelled before the lock was free: nothing is written.
        let err = state
            .book_save_version_if_current(&uid, out.clone(), 1, &|| Err(cancelled()), |_| {
                panic!("not committed")
            })
            .unwrap_err();
        assert_eq!(err.code, "cancelled");
        assert_eq!(version(&state), 1);
        assert!(state.ocr_layer(&uid).is_none());

        // On its base: a new version, with the layer recorded for it.
        let saved = state
            .book_save_version_if_current(&uid, out, 1, &|| Ok(()), keep)
            .unwrap()
            .expect("saved");
        assert_eq!(saved.file_version, 2);
        assert_eq!(version(&state), 2);
        assert_eq!(state.ocr_layer(&uid).map(|l| l.file_version), Some(2));
        state.shutdown();
    }

    #[test]
    fn the_slot_is_one_at_a_time_and_cancellable() {
        let hub = OcrHub::default();
        let first = hub.acquire(|| false).expect("free slot");
        assert!(hub.acquire(|| true).is_none(), "a waiting job can stop");
        std::thread::scope(|s| {
            let waiter = s.spawn(|| hub.acquire(|| false).is_some());
            std::thread::sleep(Duration::from_millis(50));
            drop(first);
            assert!(waiter.join().unwrap(), "the slot passes on");
        });
    }

    #[test]
    fn models_are_found_by_their_two_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (empty, full) = (tmp.path().join("empty"), tmp.path().join("full"));
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&full).unwrap();
        assert_eq!(first_models_dir(&[empty.clone(), full.clone()]), None);
        for f in core_pdf::ocr::OCR_MODEL_FILES {
            std::fs::write(full.join(f), b"x").unwrap();
        }
        assert_eq!(first_models_dir(&[empty, full.clone()]), Some(full));
    }

    /// The models ship with the app: `tauri.conf.json` bundles `resources/ocr-models/` as [`RESOURCE_NAME`], and
    /// the build fetches them first (spec 7.2, offline).
    #[test]
    fn the_models_are_a_bundled_resource() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(
            conf["bundle"]["resources"]["../resources/ocr-models/"].as_str(),
            Some(format!("{RESOURCE_NAME}/").as_str())
        );
        let before = conf["build"]["beforeBuildCommand"].as_str().unwrap_or("");
        assert!(before.contains("fetch-ocr-models.sh"), "{before}");
    }
}
