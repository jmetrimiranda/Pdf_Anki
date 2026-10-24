//! OCR of scanned pages and the searchable text layer (spec 7.2, 20): fixtures generated in memory by
//! `core_pdf::testkit` (known English text rendered to a scanner-like image), recognised with the real models.
//!
//! The models live in `src-tauri/resources/ocr-models` (`scripts/fetch-ocr-models.sh`) or `LEITOR_OCR_MODELS_DIR`.
//! Without them the recognition tests are skipped with a message, unless `LEITOR_REQUIRE_OCR_MODELS=1` or `CI` is
//! set (then a missing model is a failure).
//!
//! Timing (release): `cargo test --release -p core-pdf --features testkit --test ocr -- --ignored --nocapture`.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use core_pdf::testkit::{SAMPLE_PAGES, SAMPLE_WORDS, ScanOpts, scanned_pdf, text_pdf, word_recall};
use core_pdf::{
    ExtractOptions, LEITOR_BOOK_UID_KEY, OcrEngine, OcrModels, OcrPageResult, OcrSettings, PdfCore,
    PdfError, apply_text_layer, extract_book_text, has_ocr_layer, ocr_pages, read_info, stamp_info,
    text_fingerprint,
};

const UID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn arc(bytes: &[u8]) -> Arc<Vec<u8>> {
    Arc::new(bytes.to_vec())
}

fn models_dir() -> PathBuf {
    std::env::var_os("LEITOR_OCR_MODELS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/ocr-models")
        })
}

fn models_required() -> bool {
    std::env::var("LEITOR_REQUIRE_OCR_MODELS").is_ok_and(|v| v == "1")
        || std::env::var_os("CI").is_some()
}

/// The recogniser, loaded once per test binary; `None` (test skipped) when the models are missing and not
/// required.
fn engine() -> Option<&'static OcrEngine> {
    static ENGINE: OnceLock<Option<OcrEngine>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            let dir = models_dir();
            match OcrModels::in_dir(&dir) {
                Some(m) => Some(OcrEngine::load(&m).expect("the OCR models load")),
                None if models_required() => panic!(
                    "OCR models missing in {} (run scripts/fetch-ocr-models.sh)",
                    dir.display()
                ),
                None => {
                    eprintln!(
                        "skipped: OCR models not found in {} (scripts/fetch-ocr-models.sh)",
                        dir.display()
                    );
                    None
                }
            }
        })
        .as_ref()
}

fn run(bytes: &[u8], settings: &OcrSettings) -> Vec<OcrPageResult> {
    let engine = engine().expect("engine");
    let cancel = AtomicBool::new(false);
    let mut calls = Vec::new();
    let out = ocr_pages(arc(bytes), engine, None, settings, &cancel, &mut |d, t| {
        calls.push((d, t))
    })
    .expect("ocr");
    let total = u32::try_from(out.len()).unwrap();
    assert_eq!(calls.first(), Some(&(0, total)), "{calls:?}");
    assert_eq!(calls.last(), Some(&(total, total)), "{calls:?}");
    out
}

fn report(label: &str, pages: &[OcrPageResult]) {
    for p in pages {
        eprintln!(
            "{label} page {}: {} words (text has {}), {} ms, recall {:.3}",
            p.page,
            p.words.len(),
            core_pdf::testkit::words_of(SAMPLE_PAGES[p.page as usize]).len(),
            p.ms,
            word_recall(SAMPLE_PAGES[p.page as usize], &p.text())
        );
        let known = core_pdf::testkit::words_of(SAMPLE_PAGES[p.page as usize]);
        let extra: Vec<&str> = p
            .words
            .iter()
            .map(|w| w.text.as_str())
            .filter(|w| {
                !core_pdf::testkit::words_of(w)
                    .iter()
                    .all(|x| known.contains(x))
            })
            .take(20)
            .collect();
        eprintln!("  not in the text: {extra:?}");
    }
}

/// A 200 dpi scan with `LeitorBookUid`, and its OCR.
fn scan_and_read(label: &str, rotate_deg: f32, noise: f32) -> (Vec<u8>, Vec<OcrPageResult>) {
    let scan = scanned_pdf(
        SAMPLE_PAGES,
        &ScanOpts {
            dpi: 200,
            rotate_deg,
            noise,
            seed: 7,
        },
    );
    let stamped = stamp_info(&scan, LEITOR_BOOK_UID_KEY, UID).expect("stamp");
    let pages = run(&stamped, &OcrSettings::default());
    report(label, &pages);
    (stamped, pages)
}

#[test]
fn the_scanned_fixture_has_no_text() {
    let bytes = scanned_pdf(SAMPLE_PAGES, &ScanOpts::default());
    assert!(
        bytes.len() < 2_000_000,
        "small fixture: {} bytes",
        bytes.len()
    );
    let core = PdfCore::new();
    let doc = core.open(arc(&bytes), None).expect("open");
    assert!(core.text_stats(doc, 40).unwrap().looks_scanned());
    for page in 0..SAMPLE_PAGES.len() {
        let words = core.page_words(doc, page).unwrap();
        assert!(words.words.is_empty() && words.text.trim().is_empty());
        assert!(!has_ocr_layer(arc(&bytes), page as u32).unwrap());
    }
    let cancel = AtomicBool::new(false);
    let text = extract_book_text(
        arc(&bytes),
        None,
        ExtractOptions::default(),
        &cancel,
        &mut |_, _| {},
    )
    .unwrap();
    assert!(text.iter().all(|p| p.ok && p.text.trim().is_empty()));
    // The text version of the same pages does have text.
    let doc = core.open(arc(&text_pdf(SAMPLE_PAGES)), None).unwrap();
    assert!(!core.text_stats(doc, 40).unwrap().looks_scanned());
}

#[test]
fn clean_scan_at_300_dpi_reads_at_least_90_percent() {
    if engine().is_none() {
        return;
    }
    let bytes = scanned_pdf(
        SAMPLE_PAGES,
        &ScanOpts {
            dpi: 300,
            ..ScanOpts::default()
        },
    );
    let pages = run(&bytes, &OcrSettings::default());
    report("clean", &pages);
    assert_eq!(pages.len(), SAMPLE_PAGES.len());
    for (p, expected) in pages.iter().zip(SAMPLE_PAGES) {
        assert!(p.skipped.is_none(), "{p:?}");
        assert_eq!(p.already_on_page, 0);
        let recall = word_recall(expected, &p.text());
        assert!(
            recall >= 0.9,
            "page {}: recall {recall}: {}",
            p.page,
            p.text()
        );
    }
    let all: String = pages
        .iter()
        .map(OcrPageResult::text)
        .collect::<Vec<_>>()
        .join(" ");
    for w in SAMPLE_WORDS {
        assert!(word_recall(w, &all) == 1.0, "{w} not read: {all}");
    }
}

#[test]
fn rotated_noisy_scan_reads_at_least_80_percent() {
    if engine().is_none() {
        return;
    }
    // 1 % salt and pepper is a dirty scan: the specks come back as extra "words", but the text is read.
    let (_, pages) = scan_and_read("rotated", 1.2, 0.01);
    for (p, expected) in pages.iter().zip(SAMPLE_PAGES) {
        assert!(p.skipped.is_none(), "{p:?}");
        let recall = word_recall(expected, &p.text());
        assert!(
            recall >= 0.8,
            "page {}: recall {recall}: {}",
            p.page,
            p.text()
        );
    }
}

#[test]
fn the_text_layer_makes_the_scan_searchable() {
    if engine().is_none() {
        return;
    }
    // A scan as an office scanner makes it: slightly turned, a few specks.
    let (scan, pages) = &scan_and_read("light", 0.8, 0.002);
    let out = apply_text_layer(scan, pages, false).expect("apply");
    // An incremental update: the original bytes are untouched.
    assert!(out.len() > scan.len() && out.starts_with(scan));
    assert_eq!(
        read_info(arc(&out), LEITOR_BOOK_UID_KEY)
            .unwrap()
            .as_deref(),
        Some(UID)
    );
    assert_ne!(
        text_fingerprint(arc(&out), None).unwrap(),
        text_fingerprint(arc(scan), None).unwrap(),
        "an OCR version rebuilds the vocabulary table"
    );

    let core = PdfCore::new();
    let doc = core.open(arc(&out), None).expect("open");
    assert!(!core.text_stats(doc, 40).unwrap().looks_scanned());
    let mut seen = Vec::new();
    for page in 0..SAMPLE_PAGES.len() {
        assert!(has_ocr_layer(arc(&out), page as u32).unwrap());
        let words = core.page_words(doc, page).unwrap();
        assert!(!words.words.is_empty());
        for w in &words.words {
            for r in &w.rects {
                assert!(
                    common::inside(r, words.width, words.height),
                    "{} at {r:?} outside {}x{}",
                    w.text,
                    words.width,
                    words.height
                );
            }
        }
        seen.push(words.text);
    }
    let page_text = seen.join(" ");
    for w in SAMPLE_WORDS {
        assert!(
            word_recall(w, &page_text) == 1.0,
            "{w} not in the page words"
        );
    }

    let cancel = AtomicBool::new(false);
    let text = extract_book_text(
        arc(&out),
        None,
        ExtractOptions::default(),
        &cancel,
        &mut |_, _| {},
    )
    .unwrap();
    let book: String = text
        .iter()
        .map(|p| p.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    for w in SAMPLE_WORDS {
        assert!(word_recall(w, &book) == 1.0, "{w} not in the book text");
    }

    // Applying the same words again over a page that has a layer changes nothing.
    assert_eq!(apply_text_layer(&out, pages, true).unwrap(), out);
    // Nothing to add: the input comes back as it was.
    assert_eq!(apply_text_layer(scan, &[], false).unwrap(), *scan);
}

#[test]
fn pages_with_text_are_left_alone() {
    let Some(engine) = engine() else { return };
    let text = text_pdf(&SAMPLE_PAGES[..1]);
    let cancel = AtomicBool::new(false);
    let skipped = ocr_pages(
        arc(&text),
        engine,
        None,
        &OcrSettings::default(),
        &cancel,
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(skipped.len(), 1);
    assert!(skipped[0].skipped.is_some() && skipped[0].words.is_empty());
    assert_eq!(apply_text_layer(&text, &skipped, false).unwrap(), text);

    // Read anyway: the words the page already has are not added a second time.
    let read = ocr_pages(
        arc(&text),
        engine,
        Some(&[0, 0, 7]),
        &OcrSettings {
            skip_text_pages: false,
            ..OcrSettings::default()
        },
        &cancel,
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(read.len(), 1, "pages deduplicated and bounded");
    let p = &read[0];
    assert!(p.skipped.is_none());
    assert!(
        p.already_on_page as usize > 10 * p.words.len().max(1) / 2,
        "{} already on the page, {} added: {}",
        p.already_on_page,
        p.words.len(),
        p.text()
    );
}

#[test]
fn cancel_stops_with_a_typed_error() {
    let Some(engine) = engine() else { return };
    let bytes = scanned_pdf(SAMPLE_PAGES, &ScanOpts::default());
    let cancel = AtomicBool::new(true);
    let err = ocr_pages(
        arc(&bytes),
        engine,
        None,
        &OcrSettings::default(),
        &cancel,
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(err, PdfError::Cancelled);
    // Cancelled after the first page.
    let cancel = AtomicBool::new(false);
    let mut last = (0, 0);
    let err = ocr_pages(
        arc(&bytes),
        engine,
        None,
        &OcrSettings::default(),
        &cancel,
        &mut |done, total| {
            last = (done, total);
            if done == 1 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
    )
    .unwrap_err();
    assert_eq!(err, PdfError::Cancelled);
    assert_eq!(last, (1, 2));
}

#[test]
fn garbage_and_passwords_are_errors_not_panics() {
    let garbage: [&[u8]; 4] = [b"", b"%PDF-1.7\n garbage", b"not a pdf", &[0xff; 64]];
    for bad in garbage {
        assert!(has_ocr_layer(arc(bad), 0).is_err());
        assert!(apply_text_layer(bad, &[], false).is_err());
        if let Some(engine) = engine() {
            let cancel = AtomicBool::new(false);
            assert!(
                ocr_pages(
                    arc(bad),
                    engine,
                    None,
                    &OcrSettings::default(),
                    &cancel,
                    &mut |_, _| {}
                )
                .is_err()
            );
        }
    }
    let locked = common::protected(pdfcraft_cos::Algorithm::Aes256, "user", "owner");
    assert_eq!(
        has_ocr_layer(arc(&locked), 0).unwrap_err(),
        PdfError::NeedsPassword
    );
    assert_eq!(
        apply_text_layer(&locked, &[], false).unwrap_err(),
        PdfError::NeedsPassword
    );
    if let Some(engine) = engine() {
        let cancel = AtomicBool::new(false);
        assert_eq!(
            ocr_pages(
                arc(&locked),
                engine,
                None,
                &OcrSettings::default(),
                &cancel,
                &mut |_, _| {}
            )
            .unwrap_err(),
            PdfError::NeedsPassword
        );
    }

    // A page past the end.
    let scan = scanned_pdf(&SAMPLE_PAGES[..1], &ScanOpts::default());
    assert!(matches!(
        has_ocr_layer(arc(&scan), 5),
        Err(PdfError::InvalidRequest(_))
    ));
    let far = OcrPageResult {
        page: 9,
        words: vec![core_pdf::PlacedWord {
            text: "far".into(),
            origin: [72.0, 72.0],
            across: [20.0, 0.0],
            up: [0.0, 9.0],
        }],
        skipped: None,
        already_on_page: 0,
        ms: 0,
    };
    assert!(matches!(
        apply_text_layer(&scan, &[far], false),
        Err(PdfError::InvalidRequest(_))
    ));

    // Models: a folder without them, and files that are not models.
    let dir = std::env::temp_dir().join(format!("core-pdf-ocr-models-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(OcrModels::in_dir(&dir).is_none());
    for f in ["text-detection.rten", "text-recognition.rten"] {
        std::fs::write(dir.join(f), b"not a model").unwrap();
    }
    let models = OcrModels::in_dir(&dir).expect("both files present");
    assert!(matches!(OcrEngine::load(&models), Err(PdfError::Ocr(_))));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Spec 7.2 "alguns segundos por página no desktop": a Letter page scanned at 200 dpi, read with the default
/// 300 dpi (capped at the scan's 200). Asserts ≤ 15 s per page so a slow CI doesn't flake; prints the number.
#[test]
#[ignore = "timing: run in release with --ignored --nocapture"]
fn ocr_time_per_page() {
    let Some(engine) = engine() else { return };
    let bytes = scanned_pdf(
        SAMPLE_PAGES,
        &ScanOpts {
            dpi: 200,
            rotate_deg: 0.8,
            noise: 0.002,
            seed: 3,
        },
    );
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let pages = ocr_pages(
        arc(&bytes),
        engine,
        None,
        &OcrSettings::default(),
        &cancel,
        &mut |_, _| {},
    )
    .unwrap();
    let total = started.elapsed().as_millis() as u64;
    let per_page = total / pages.len() as u64;
    let apply_started = Instant::now();
    let out = apply_text_layer(&bytes, &pages, false).unwrap();
    let apply_ms = apply_started.elapsed().as_millis();
    let threads = std::thread::available_parallelism().map_or(0, |n| n.get());
    println!(
        "OCR: {} pages, {total} ms total, {per_page} ms/page (pages: {:?} ms), text layer {apply_ms} ms, \
         {} → {} bytes, {threads} logical CPUs",
        pages.len(),
        pages.iter().map(|p| p.ms).collect::<Vec<_>>(),
        bytes.len(),
        out.len()
    );
    assert!(per_page <= 15_000, "{per_page} ms/page");
}
