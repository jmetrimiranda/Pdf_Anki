//! The Phase 0 integration check (spec 21): open the collection, read the deck tree, open a
//! PDF and read page 1. Runs from the `dev_smoke` command and from `--smoke` on the CLI.
//!
//! It seeds demo decks, so it works on its own collection (`<data dir>/smoke/anki`), never on
//! the user's.

use std::sync::Arc;
use std::time::Instant;

use core_anki::{DeckTree, decks, demo};
use core_pdf::{DocHandle, DocInfo, DocumentEngine, RenderReq};
use serde::Serialize;

use crate::error::AppError;
use crate::protocol::render_url;
use crate::state::AppState;

/// The spike's sample (docs/referencia/spike/sample.pdf), bundled so the check needs no files.
pub const SAMPLE_PDF: &[u8] = include_bytes!("../../../docs/referencia/spike/sample.pdf");

/// Device pixels per point of the page-1 image.
pub const PAGE1_SCALE: f32 = 2.0;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    pub collection_path: String,
    pub deck_tree: DeckTree,
    pub doc: DocInfo,
    pub page1_url: String,
    pub words: usize,
    pub millis: SmokeMillis,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeMillis {
    pub anki: u64,
    pub pdf_open: u64,
    pub pdf_text: u64,
}

/// Runs the check and returns the report with the handle of the sample document, which stays
/// open (the page-1 URL points at it) until the next run. Blocks.
pub fn run(state: &AppState) -> Result<(SmokeReport, DocHandle), AppError> {
    let t = Instant::now();
    let anki = state.smoke_anki()?;
    let added = anki.call_blocking(demo::seed_demo)?;
    let deck_tree = anki.call_blocking(decks::deck_tree)?;
    let anki_ms = elapsed_ms(t);
    tracing::info!(
        added,
        decks = deck_tree.decks.len(),
        anki_ms,
        "smoke: Anki ok"
    );

    let t = Instant::now();
    let pdf = state.pdf();
    let doc = pdf.open(Arc::new(SAMPLE_PDF.to_vec()), None)?;
    if let Some(previous) = state.replace_smoke_doc(doc) {
        pdf.close(previous);
    }
    let info = pdf.info(doc)?;
    let pdf_open = elapsed_ms(t);

    let t = Instant::now();
    let words = pdf.page_words(doc, 0)?.words.len();
    let pdf_text = elapsed_ms(t);
    tracing::info!(%doc, pages = info.page_count, words, pdf_open, pdf_text, "smoke: PDF ok");

    let report = SmokeReport {
        collection_path: anki.paths().collection.display().to_string(),
        deck_tree,
        doc: info,
        page1_url: render_url(doc, 0, PAGE1_SCALE),
        words,
        millis: SmokeMillis {
            anki: anki_ms,
            pdf_open,
            pdf_text,
        },
    };
    Ok((report, doc))
}

/// Page 1 of the smoke document as PNG, exactly what the `pdf` protocol serves for `page1Url`.
pub fn page1_png(state: &AppState, doc: DocHandle) -> Result<Vec<u8>, AppError> {
    Ok(state
        .pdf()
        .render_png(doc, RenderReq::page(0, PAGE1_SCALE))?)
}

fn elapsed_ms(t: Instant) -> u64 {
    u64::try_from(t.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_opens_the_collection_and_the_sample() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().to_path_buf());
        let (report, doc) = run(&state).unwrap();
        assert!(report.collection_path.ends_with("collection.anki2"));
        assert!(
            report
                .collection_path
                .starts_with(&state.smoke_anki_dir().display().to_string())
        );
        // The user's collection is never created or touched by the check.
        assert!(!state.anki_dir().exists());
        assert!(report.deck_tree.find(demo::VOCAB_DECK).is_some());
        assert_eq!(report.doc.page_count, report.doc.pages.len());
        assert!(report.doc.page_count >= 1);
        assert!(report.words > 0);
        assert!(
            report
                .page1_url
                .contains(&format!("render/{doc}/0?escala=2"))
        );

        let png = page1_png(&state, doc).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));

        // A second run replaces the previous sample document instead of leaking it.
        let (_, doc2) = run(&state).unwrap();
        assert_ne!(doc, doc2);
        assert_eq!(state.pdf().open_documents(), vec![doc2]);

        let json = serde_json::to_value(&report).unwrap();
        for key in [
            "collectionPath",
            "deckTree",
            "doc",
            "page1Url",
            "words",
            "millis",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert!(json["millis"].get("pdfOpen").is_some());
        assert!(json["deckTree"].get("studiedToday").is_some());
        state.shutdown();
    }
}
