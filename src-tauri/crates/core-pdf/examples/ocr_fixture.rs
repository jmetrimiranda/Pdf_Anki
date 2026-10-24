//! Writes the OCR fixtures of the bridge test (web/e2e/bridge/ocr.spec.ts). Never committed.
//!
//! `cargo run -p core-pdf --features testkit --example ocr_fixture -- [OUT_DIR]`
//!
//! - `scanned.pdf`: the two sample pages scanned at 200 dpi, turned 0.8°, a few specks (0.2 %) (image-only pages);
//! - `scanned-ocr.pdf`: the same file after `ocr_pages` + `apply_text_layer` (a new version with an invisible
//!   text layer), using the models in `LEITOR_OCR_MODELS_DIR` (default `src-tauri/resources/ocr-models`);
//! - `expected.json`: `{ words, text_pages }` — distinctive words and the text of each page;
//! - `ocr-words.json`: per page, the words `PdfCore::page_words` finds in `scanned-ocr.pdf`, with their
//!   view-space rect `[x, y, w, h]` (points, y down) and the page size.
//!
//! The default output dir is `src-tauri/target/fixtures/ocr` (the build volume).

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use core_pdf::testkit::{SAMPLE_PAGES, SAMPLE_WORDS, ScanOpts, scanned_pdf};
use core_pdf::{OcrEngine, OcrModels, OcrSettings, PdfCore, apply_text_layer, ocr_pages};
use serde_json::json;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ocr_fixture: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out_dir = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("../../target/fixtures/ocr"));
    let models_dir = std::env::var_os("LEITOR_OCR_MODELS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("../../resources/ocr-models"));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let write = |name: &str, bytes: &[u8]| {
        let path = out_dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))
    };

    let scan = scanned_pdf(
        SAMPLE_PAGES,
        &ScanOpts {
            dpi: 200,
            rotate_deg: 0.8,
            noise: 0.002,
            seed: 42,
        },
    );
    write("scanned.pdf", &scan)?;

    let models = OcrModels::in_dir(&models_dir).ok_or_else(|| {
        format!(
            "OCR models not found in {} (scripts/fetch-ocr-models.sh)",
            models_dir.display()
        )
    })?;
    let engine = OcrEngine::load(&models).map_err(|e| format!("{e:?}"))?;
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let pages = ocr_pages(
        Arc::new(scan.clone()),
        &engine,
        None,
        &OcrSettings::default(),
        &cancel,
        &mut |_, _| {},
    )
    .map_err(|e| format!("{e:?}"))?;
    let ms = started.elapsed().as_millis();
    let ocr = apply_text_layer(&scan, &pages, false).map_err(|e| format!("{e:?}"))?;
    write("scanned-ocr.pdf", &ocr)?;

    let expected = json!({ "words": SAMPLE_WORDS, "text_pages": SAMPLE_PAGES });
    write(
        "expected.json",
        &serde_json::to_vec_pretty(&expected).map_err(|e| e.to_string())?,
    )?;

    let core = PdfCore::new();
    let doc = core
        .open(Arc::new(ocr), None)
        .map_err(|e| format!("{e:?}"))?;
    let mut out_pages = Vec::new();
    for page in 0..SAMPLE_PAGES.len() {
        let words = core.page_words(doc, page).map_err(|e| format!("{e:?}"))?;
        let list: Vec<_> = words
            .words
            .iter()
            .filter_map(|w| {
                w.rects
                    .first()
                    .map(|r| json!({ "word": w.text, "rect": r }))
            })
            .collect();
        out_pages.push(json!({
            "page": page,
            "width": words.width,
            "height": words.height,
            "words": list,
        }));
    }
    write(
        "ocr-words.json",
        &serde_json::to_vec_pretty(&json!({ "pages": out_pages })).map_err(|e| e.to_string())?,
    )?;
    println!(
        "ocr_fixture: {} pages read in {ms} ms ({} words) → {}",
        pages.len(),
        pages.iter().map(|p| p.words.len()).sum::<usize>(),
        out_dir.display()
    );
    Ok(())
}
