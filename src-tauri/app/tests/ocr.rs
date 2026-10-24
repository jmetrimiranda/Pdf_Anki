//! "Reconhecer texto" through `AppState` (spec 7.2, 6.5, 6.6, 15, 20, 21 Phase 7): a scanned English PDF made in
//! memory (`core_pdf::testkit`) is imported ("parece escaneado"), recognised in the background (`job://` events,
//! one OCR at a time, cancel), and becomes a NEW VERSION of the same book with an invisible text layer; the
//! vocabulary scan then reads it, and a PdfCraft save based on the version before the OCR keeps the layer.
//!
//! The recognition tests need the models (`scripts/fetch-ocr-models.sh` → `src-tauri/resources/ocr-models`, or
//! `LEITOR_OCR_MODELS_DIR`); without them they are skipped with a message, unless `LEITOR_REQUIRE_OCR_MODELS=1` or
//! `CI` is set.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_anki::fixture::{self, FixtureOptions};
use core_pdf::testkit::{SAMPLE_PAGES, ScanOpts, scanned_pdf};
use core_store::{BookFormat, BookPatch, NewBook, OcrStatus};
use core_vocab::{RangeSpec, ScanConfig};
use leitor_app::{AppState, JobKind, JobProgress, JobStage, UiEvent};

mod common;

const WAIT: Duration = Duration::from_secs(300);

fn models_required() -> bool {
    std::env::var("LEITOR_REQUIRE_OCR_MODELS").is_ok_and(|v| v == "1")
        || std::env::var_os("CI").is_some()
}

/// `false` (and a message) when the models are missing and not required.
fn have_models(state: &AppState) -> bool {
    if state.ocr_models_dir().is_some() {
        return true;
    }
    assert!(
        !models_required(),
        "OCR models missing: run scripts/fetch-ocr-models.sh"
    );
    eprintln!("skipped: OCR models not found (scripts/fetch-ocr-models.sh)");
    false
}

fn scan(pages: &[&str]) -> Vec<u8> {
    scanned_pdf(
        pages,
        &ScanOpts {
            dpi: 200,
            rotate_deg: 0.8,
            noise: 0.002,
            seed: 11,
        },
    )
}

type Events = Arc<Mutex<Vec<(Instant, JobProgress)>>>;

struct Env {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    events: Events,
    /// Receives every OCR progress event (in the job thread's order).
    rx: mpsc::Receiver<JobProgress>,
}

impl Env {
    fn new() -> Self {
        Self::build(false).0
    }

    /// With the fixture collection and its vocabulary folder (`root` = the folder's deck id).
    fn with_fixture() -> (Self, Option<i64>) {
        Self::build(true)
    }

    fn build(with_fixture: bool) -> (Self, Option<i64>) {
        let dir = tempfile::tempdir().unwrap();
        let root = with_fixture.then(|| {
            let info = fixture::build(
                &dir.path().join("data").join("anki"),
                FixtureOptions {
                    vocab: true,
                    ..FixtureOptions::default()
                },
            )
            .unwrap();
            info.decks[fixture::DECK_VOCAB]
        });
        let state = Arc::new(AppState::new(dir.path().join("data")));
        let (events, rx) = Self::listen(&state);
        (
            Self {
                dir,
                state,
                events,
                rx,
            },
            root,
        )
    }

    fn listen(state: &AppState) -> (Events, mpsc::Receiver<JobProgress>) {
        let events: Events = Arc::default();
        let seen = Arc::clone(&events);
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        state.set_ui_sink(Arc::new(move |e| {
            if let UiEvent::Job(p) = e
                && p.kind == JobKind::Ocr
            {
                seen.lock().unwrap().push((Instant::now(), p.clone()));
                let _ = tx.lock().unwrap().send(p);
            }
        }));
        (events, rx)
    }

    fn data_dir(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    fn add(&self, name: &str, bytes: &[u8]) -> String {
        let path = common::write(self.dir.path(), name, bytes);
        self.state
            .library_add(&path, false)
            .unwrap()
            .book
            .book
            .book_uid
    }

    fn wait(&self, job_id: &str) -> JobProgress {
        let p = self.state.job_wait(job_id, WAIT).unwrap();
        assert!(p.stage.is_terminal(), "job still running: {p:?}");
        p
    }

    fn stages(&self, job_id: &str) -> Vec<JobStage> {
        let mut out: Vec<JobStage> = Vec::new();
        for (_, p) in self.events.lock().unwrap().iter() {
            if p.job_id == job_id && out.last() != Some(&p.stage) {
                out.push(p.stage);
            }
        }
        out
    }

    /// Waits for an event of `job_id` in `stage`.
    fn wait_stage(&self, job_id: &str, stage: JobStage) -> JobProgress {
        let end = Instant::now() + WAIT;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let p = self
                .rx
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no {stage:?} event for {job_id}"));
            if p.job_id == job_id && p.stage == stage {
                return p;
            }
            assert!(
                !(p.job_id == job_id && p.stage.is_terminal()),
                "ended before {stage:?}: {p:?}"
            );
        }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.state.shutdown();
    }
}

fn layer_on_every_page(bytes: &[u8], pages: usize) -> bool {
    (0..pages).all(|p| core_pdf::has_ocr_layer(Arc::new(bytes.to_vec()), p as u32).unwrap())
}

#[test]
fn ocr_makes_a_searchable_new_version_that_survives_restarts_and_stale_saves() {
    let (env, root) = Env::with_fixture();
    let root = root.expect("vocabulary folder of the fixture");
    let data = env.data_dir();
    if !have_models(&env.state) {
        return;
    }
    common::use_lexicon(&env.state);
    let original = scan(SAMPLE_PAGES);
    let uid = env.add("scanned.pdf", &original);

    // Imported as "parece escaneado", OCR offered.
    let entry = env.state.library_entry(&uid).unwrap();
    assert!(!entry.book.has_text);
    assert_eq!(entry.book.file_version, 1);
    let info = env.state.ocr_info(&uid).unwrap();
    assert!(info.available && !info.has_text);
    assert_eq!(info.status, OcrStatus::None);
    assert_eq!(info.pages, 2);
    assert!(info.job.is_none() && info.last_error.is_none());

    let started = env.state.ocr_start(&uid).unwrap();
    assert!(!started.already_running);
    // While it runs, a second start returns the same job.
    let again = env.state.ocr_start(&uid).unwrap();
    assert!(again.already_running);
    assert_eq!(again.job_id, started.job_id);
    let running = env.state.ocr_info(&uid).unwrap();
    assert_eq!(running.status, OcrStatus::Running);
    assert_eq!(
        running.job.as_ref().map(|j| j.job_id.as_str()),
        Some(started.job_id.as_str())
    );

    let end = env.wait(&started.job_id);
    assert_eq!(end.stage, JobStage::Done, "{end:?}");
    assert_eq!(end.kind, JobKind::Ocr);
    assert_eq!(end.scan_uid, "");
    assert_eq!(
        env.stages(&started.job_id),
        [
            JobStage::Queued,
            JobStage::Ocr,
            JobStage::Writing,
            JobStage::Done
        ]
    );
    let ocr = end.ocr.clone().expect("ocr info");
    assert!(ocr.words > 100, "{ocr:?}");
    assert_eq!((ocr.pages_read, ocr.pages_skipped), (2, 0));
    assert_eq!(ocr.file_version, Some(2));
    eprintln!("app OCR: {ocr:?}");
    assert!(ocr.ms_per_page.is_some_and(|ms| ms > 0));
    // At most 10 events a second within a stage (stage changes and the end always go out).
    let evs = env.events.lock().unwrap().clone();
    let mine: Vec<_> = evs
        .iter()
        .filter(|(_, p)| p.job_id == started.job_id)
        .collect();
    for w in mine.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if a.1.stage == b.1.stage && !b.1.stage.is_terminal() {
            assert!(
                b.0.duration_since(a.0) >= Duration::from_millis(90),
                "events too close: {:?} {:?}",
                a.1,
                b.1
            );
        }
    }
    let ocr_events: Vec<_> = mine
        .iter()
        .filter(|(_, p)| p.stage == JobStage::Ocr)
        .collect();
    assert_eq!(ocr_events[0].1.total, 2, "progress counts pages");

    // A new version of the same book, with the text inside the file.
    let entry = env.state.library_entry(&uid).unwrap();
    assert_eq!(entry.book.book_uid, uid);
    assert_eq!(entry.book.file_version, 2);
    assert_ne!(entry.book.file_hash, uid);
    assert!(entry.book.has_text);
    assert_eq!(entry.book.ocr_status, OcrStatus::Done);
    let v2 = env.state.book_bytes(&uid).unwrap();
    assert!(v2.starts_with(&original), "incremental update of the scan");
    assert_eq!(
        core_pdf::read_info(Arc::new(v2.clone()), core_pdf::LEITOR_BOOK_UID_KEY)
            .unwrap()
            .as_deref(),
        Some(uid.as_str())
    );
    assert!(layer_on_every_page(&v2, 2));
    let words = env.state.doc_words(&uid, 0).unwrap();
    assert!(
        words
            .words
            .iter()
            .any(|w| w.text.eq_ignore_ascii_case("windmill")),
        "{}",
        words.text
    );
    let info = env.state.ocr_info(&uid).unwrap();
    assert_eq!(info.status, OcrStatus::Done);
    assert!(info.has_text && info.last_error.is_none());
    assert_eq!(info.job.map(|j| j.stage), Some(JobStage::Done));

    // The vocabulary scan works on the OCR version.
    let scan_job = env
        .state
        .vocab_scan_start(&uid, root, vec![], RangeSpec::All, ScanConfig::default())
        .unwrap();
    let p = env.wait(&scan_job.job_id);
    assert_eq!(p.stage, JobStage::Done, "{p:?}");
    let report = env.state.vocab_report(&uid).unwrap().unwrap();
    assert!(
        report.rows.iter().any(|r| r.lemma == "windmill"),
        "windmill in the report"
    );

    // A PdfCraft save based on version 1 (the tab was opened before the OCR) keeps the text layer.
    let stale = core_pdf::stamp_info(&original, core_pdf::LEITOR_BOOK_UID_KEY, &uid).unwrap();
    assert!(!layer_on_every_page(&stale, 2));
    let saved = env
        .state
        .book_save_version_from(&uid, stale, Some(1))
        .unwrap();
    assert_eq!(saved.file_version, 3);
    assert!(saved.kept_newer);
    let v3 = env.state.book_bytes(&uid).unwrap();
    assert!(layer_on_every_page(&v3, 2), "the OCR layer was merged");

    // Everything survives a restart.
    env.state.shutdown();
    let state = AppState::new(data);
    let entry = state.library_entry(&uid).unwrap();
    assert_eq!(entry.book.file_version, 3);
    assert!(entry.book.has_text);
    let info = state.ocr_info(&uid).unwrap();
    assert_eq!(info.status, OcrStatus::Done);
    assert!(info.job.is_none());
    let again = core_pdf::stamp_info(&original, "Title", "Outra cópia").unwrap();
    let again = core_pdf::stamp_info(&again, core_pdf::LEITOR_BOOK_UID_KEY, &uid).unwrap();
    let saved = state.book_save_version_from(&uid, again, Some(1)).unwrap();
    assert_eq!(saved.file_version, 4);
    assert!(layer_on_every_page(&state.book_bytes(&uid).unwrap(), 2));
    state.shutdown();
}

#[test]
fn cancel_discards_and_only_one_ocr_runs_at_a_time() {
    let env = Env::new();
    if !have_models(&env.state) {
        return;
    }
    let a = env.add("a.pdf", &scan(SAMPLE_PAGES));
    let b = env.add("b.pdf", &scan(&SAMPLE_PAGES[1..]));
    let job_a = env.state.ocr_start(&a).unwrap().job_id;
    env.wait_stage(&job_a, JobStage::Ocr);
    let job_b = env.state.ocr_start(&b).unwrap().job_id;
    // B waits for A (one OCR at a time), and can be cancelled while it waits.
    assert_eq!(
        env.state.job_status(&job_b).unwrap().stage,
        JobStage::Queued
    );
    assert!(env.state.ocr_cancel(&b));
    assert_eq!(env.wait(&job_b).stage, JobStage::Cancelled);
    assert!(env.state.ocr_cancel(&a));
    let end = env.wait(&job_a);
    assert_eq!(end.stage, JobStage::Cancelled, "{end:?}");
    assert!(!env.state.ocr_cancel(&a), "nothing left to cancel");
    for uid in [&a, &b] {
        let entry = env.state.library_entry(uid).unwrap();
        assert_eq!(entry.book.file_version, 1, "no new version");
        assert_eq!(entry.book.ocr_status, OcrStatus::None);
        assert!(!entry.book.has_text);
        let info = env.state.ocr_info(uid).unwrap();
        assert_eq!(info.status, OcrStatus::None);
        assert!(info.last_error.is_none());
        assert_eq!(info.job.map(|j| j.stage), Some(JobStage::Cancelled));
    }
}

#[test]
fn refusals() {
    let env = Env::new();
    let scanned = env.add("scan.pdf", &scan(&SAMPLE_PAGES[..1]));

    // Models missing.
    let empty = env.dir.path().join("no-models");
    std::fs::create_dir_all(&empty).unwrap();
    env.state.set_ocr_models_dir(Some(empty));
    assert!(env.state.ocr_models_dir().is_none());
    let err = env.state.ocr_start(&scanned).unwrap_err();
    assert_eq!(err.code, "ocr_models_missing");
    assert_eq!(
        err.message,
        "Os modelos de reconhecimento de texto não foram encontrados nesta instalação."
    );
    assert!(!env.state.ocr_info(&scanned).unwrap().available);
    assert_eq!(
        env.state.library_entry(&scanned).unwrap().book.ocr_status,
        OcrStatus::None
    );
    env.state.set_ocr_models_dir(None);

    // Not a PDF (an EPUB row).
    let epub_uid = "e".repeat(64);
    env.state
        .with_store(|s| {
            s.add_book(&NewBook {
                book_uid: epub_uid.clone(),
                title: "Livro EPUB".into(),
                author: None,
                language: None,
                format: BookFormat::Epub,
                file_name: "livro.epub".into(),
                pages: 3,
                has_text: true,
                file_hash: epub_uid.clone(),
                local_path: None,
            })
        })
        .unwrap();
    let err = env.state.ocr_start(&epub_uid).unwrap_err();
    assert_eq!(err.code, "ocr_not_pdf");
    assert_eq!(err.message, "O reconhecimento de texto é só para PDFs.");
    assert!(!env.state.ocr_info(&epub_uid).unwrap().available);

    // A PDF that already has text (nothing to recognise, no pointless version).
    if env.state.ocr_models_dir().is_some() {
        let text = env.add("text.pdf", &common::text_pdf(2, "Texto"));
        let err = env.state.ocr_start(&text).unwrap_err();
        assert_eq!(err.code, "ocr_has_text");
        assert_eq!(
            err.message,
            "Este livro já tem texto; o reconhecimento de texto não é necessário."
        );
        let entry = env.state.library_entry(&text).unwrap();
        assert_eq!(entry.book.ocr_status, OcrStatus::None);
        assert_eq!(entry.book.file_version, 1);
    }

    // Unknown book.
    assert!(env.state.ocr_start(&"f".repeat(64)).is_err());
    assert!(env.state.ocr_info("not-a-uid").is_err());
    assert!(!env.state.ocr_cancel(&scanned));

    // Encrypted.
    if env.state.ocr_models_dir().is_some() {
        let locked = env.add("locked.pdf", &common::protected_pdf());
        let err = env.state.ocr_start(&locked).unwrap_err();
        assert_eq!(err.code, "ocr_locked");
    }
}

#[test]
fn a_run_left_running_is_recovered_as_failed() {
    let env = Env::new();
    let uid = env.add("scan.pdf", &scan(&SAMPLE_PAGES[..1]));
    env.state
        .with_store(|s| {
            s.update_book(
                &uid,
                &BookPatch {
                    ocr_status: Some(OcrStatus::Running),
                    ..BookPatch::default()
                },
            )
        })
        .unwrap();
    env.state.ocr_recover();
    let info = env.state.ocr_info(&uid).unwrap();
    assert_eq!(info.status, OcrStatus::Failed);
    assert_eq!(
        info.last_error.as_deref(),
        Some("O reconhecimento de texto foi interrompido.")
    );
    // The message survives a restart.
    let data = env.data_dir();
    env.state.shutdown();
    let state = AppState::new(data);
    let info = state.ocr_info(&uid).unwrap();
    assert_eq!(info.status, OcrStatus::Failed);
    assert_eq!(
        info.last_error.as_deref(),
        Some("O reconhecimento de texto foi interrompido.")
    );
    // Recovering again changes nothing.
    state.ocr_recover();
    assert_eq!(state.ocr_info(&uid).unwrap().status, OcrStatus::Failed);
    state.shutdown();
}

#[test]
fn a_blank_scan_fails_without_a_new_version() {
    let env = Env::new();
    if !have_models(&env.state) {
        return;
    }
    // A clean white sheet (specks would be read as "words").
    let uid = env.add("blank.pdf", &scanned_pdf(&[""], &ScanOpts::default()));
    let job = env.state.ocr_start(&uid).unwrap().job_id;
    let end = env.wait(&job);
    assert_eq!(end.stage, JobStage::Failed, "{end:?}");
    let error = end.error.unwrap();
    assert_eq!(error.code, "ocr_no_text");
    assert_eq!(error.message, "Nenhum texto foi reconhecido neste livro.");
    let entry = env.state.library_entry(&uid).unwrap();
    assert_eq!(entry.book.file_version, 1);
    assert_eq!(entry.book.ocr_status, OcrStatus::Failed);
    assert_eq!(
        env.state.ocr_info(&uid).unwrap().last_error.as_deref(),
        Some("Nenhum texto foi reconhecido neste livro.")
    );
}

/// Removing a book cancels its OCR (the slot is free for the next book), nothing of the job is written back for
/// the removed book, and adding it again starts with no OCR status.
#[test]
fn removing_a_book_cancels_its_ocr() {
    let env = Env::new();
    if !have_models(&env.state) {
        return;
    }
    let bytes = scan(SAMPLE_PAGES);
    let uid = env.add("scan.pdf", &bytes);
    let job = env.state.ocr_start(&uid).unwrap().job_id;
    env.wait_stage(&job, JobStage::Ocr);
    env.state.library_remove(&uid).unwrap();
    let end = env.wait(&job);
    assert_eq!(end.stage, JobStage::Cancelled, "{end:?}");
    let ocr_dir = env.data_dir().join("ocr");
    for ext in ["error.txt", "layer.json"] {
        assert!(
            !ocr_dir.join(format!("{uid}.{ext}")).exists(),
            "{ext} left behind"
        );
    }

    let again = env.add("scan.pdf", &bytes);
    assert_eq!(again, uid);
    let entry = env.state.library_entry(&uid).unwrap();
    assert_eq!(entry.book.file_version, 1, "no OCR version");
    assert_eq!(entry.book.ocr_status, OcrStatus::None);
    assert!(!entry.book.has_text);
    let info = env.state.ocr_info(&uid).unwrap();
    assert_eq!(info.status, OcrStatus::None);
    assert!(info.last_error.is_none());
    // The slot is free: a new OCR of the book gets past the queue.
    let next = env.state.ocr_start(&uid).unwrap();
    assert!(!next.already_running);
    env.wait_stage(&next.job_id, JobStage::Ocr);
    assert!(env.state.ocr_cancel(&uid));
    assert_eq!(env.wait(&next.job_id).stage, JobStage::Cancelled);
}
