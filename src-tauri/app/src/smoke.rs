//! The smoke check (spec 21, Phase 0): open a collection, read the deck tree, open a PDF in the
//! core, read its words and render page 1 (the cover renderer). Runs from the `dev_smoke` command
//! and from `--smoke` on the CLI.
//!
//! It seeds demo decks, so it works on its own collection (`<data dir>/smoke/anki`), never on
//! the user's.

use std::sync::Arc;
use std::time::Instant;

use base64::Engine as _;
use core_anki::{DeckTree, decks, demo};
use serde::Serialize;

use crate::error::AppError;
use crate::state::AppState;

/// The spike's sample (docs/referencia/spike/sample.pdf), bundled so the check needs no files.
pub const SAMPLE_PDF: &[u8] = include_bytes!("../../../docs/referencia/spike/sample.pdf");

/// Longest side of the page-1 image, in pixels.
pub const PAGE1_PX: u32 = 1200;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    pub collection_path: String,
    pub deck_tree: DeckTree,
    pub doc: SmokeDoc,
    /// Page 1 as `data:image/png;base64,…`.
    pub page1_data_url: String,
    pub words: usize,
    pub millis: SmokeMillis,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeDoc {
    pub page_count: usize,
    pub title: Option<String>,
    pub author: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeMillis {
    pub anki: u64,
    pub pdf_open: u64,
    pub pdf_text: u64,
    pub cover: u64,
}

/// Runs the check and returns the report with page 1 as PNG. Blocks.
pub fn run(state: &AppState) -> Result<(SmokeReport, Vec<u8>), AppError> {
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

    let pdf = state.pdf();
    let t = Instant::now();
    let bytes = Arc::new(SAMPLE_PDF.to_vec());
    let meta = pdf.inspect(Arc::clone(&bytes), None)?;
    let doc = pdf.open(bytes, None)?;
    let pdf_open = elapsed_ms(t);
    let result = (|| {
        let t = Instant::now();
        let words = pdf.page_words(doc, 0)?.words.len();
        let pdf_text = elapsed_ms(t);
        let t = Instant::now();
        let png = pdf.cover_png(doc, PAGE1_PX)?;
        Ok::<_, core_pdf::PdfError>((words, pdf_text, png, elapsed_ms(t)))
    })();
    pdf.close(doc);
    let (words, pdf_text, png, cover) = result?;
    tracing::info!(
        pages = meta.page_count,
        words,
        pdf_open,
        pdf_text,
        cover,
        "smoke: PDF ok"
    );

    let report = SmokeReport {
        collection_path: anki.paths().collection.display().to_string(),
        deck_tree,
        doc: SmokeDoc {
            page_count: meta.page_count,
            title: meta.title,
            author: meta.author,
        },
        page1_data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        ),
        words,
        millis: SmokeMillis {
            anki: anki_ms,
            pdf_open,
            pdf_text,
            cover,
        },
    };
    Ok((report, png))
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
        let (report, png) = run(&state).unwrap();
        assert!(report.collection_path.ends_with("collection.anki2"));
        assert!(
            report
                .collection_path
                .starts_with(&state.smoke_anki_dir().display().to_string())
        );
        // The user's collection is never created or touched by the check.
        assert!(!state.anki_dir().exists());
        assert!(report.deck_tree.find(demo::VOCAB_DECK).is_some());
        assert!(report.doc.page_count >= 1);
        assert!(report.words > 0);
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(
            report
                .page1_data_url
                .starts_with("data:image/png;base64,iVBOR")
        );
        // The sample document is closed again.
        assert!(state.pdf().open_documents().is_empty());

        let json = serde_json::to_value(&report).unwrap();
        for key in [
            "collectionPath",
            "deckTree",
            "doc",
            "page1DataUrl",
            "words",
            "millis",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert!(json["doc"].get("pageCount").is_some());
        assert!(json["millis"].get("pdfOpen").is_some());
        assert!(json["millis"].get("cover").is_some());
        assert!(json["deckTree"].get("studiedToday").is_some());
        state.shutdown();
    }
}
