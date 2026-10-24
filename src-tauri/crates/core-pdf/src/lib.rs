//! `core-pdf`: the native PDF core (docs/PROJETO.md 2.6, 6.3, 6.6). The reading screen is
//! PdfCraft's own web UI embedded in the app, so this crate does only what is not on screen:
//! text with positions (UAX #29 words mapped to glyph rects, for vocabulary and marks), covers
//! and metadata for the library, the `LeitorBookUid` Info entry, and "looks scanned" detection.
//! It also reads the whole book's text in parallel for vocabulary scanning, and fingerprints the text of a
//! file version (so an annotation-only save keeps the cached lemma table).
//! It also recognises the text of scanned pages and writes it back as an invisible text layer ([`ocr`],
//! spec 7.2: PdfCraft's own "Searchable Image").
//! It is the only crate that knows PdfCraft and uses only its lower layers (`pdfcraft-render`,
//! `-cos`, `-organize`, `-ocr` and `-edit` for the OCR text layer), never the engine, so it builds wherever those
//! do (iOS included).
//!
//! Coordinates are always view space: points, origin at the top-left of the page as displayed,
//! y down, with `/Rotate` and the crop box applied. Rects are `[x, y, w, h]`.
//!
//! Nothing here panics on untrusted input: every call into PdfCraft is wrapped in a
//! `catch_unwind` guard and failures become [`PdfError`] (pt-BR `Display`).

mod actor;
mod core;
mod encode;
mod error;
mod extract;
mod info;
pub mod ocr;
#[cfg(feature = "testkit")]
pub mod testkit;
mod types;
mod words;

pub use crate::core::PdfCore;
pub use encode::encode_rgba as encode_png;
pub use error::PdfError;
pub use extract::{
    ExtractOptions, MAX_EXTRACT_THREADS, PageText, extract_book_text, text_fingerprint,
};
pub use info::{LEITOR_BOOK_UID_KEY, read_info, stamp_info};
pub use ocr::{
    OcrEngine, OcrModels, OcrPageResult, OcrSettings, PlacedWord, apply_text_layer, has_ocr_layer,
    ocr_pages,
};
pub use types::{
    DocHandle, DocInfo, OutlineItem, PageSize, PageWord, PageWords, PdfMeta, Rect, TextStats,
};
