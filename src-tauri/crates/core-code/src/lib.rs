//! Code cards (docs/PROJETO.md 11): pure helpers shared by the app on every platform (no I/O, no
//! Tauri, nothing desktop-only, so the iOS door stays open).
//!
//! - [`html`]: code inside Anki fields (HTML) and back, a byte-for-byte port of the web editor's
//!   `codeField.ts` (both sides are checked against the same vectors file).
//! - [`markdown`]: the Markdown batch importer of spec 11.7 (preview with per-item errors).

pub mod html;
pub mod markdown;

pub use html::{code_to_html, html_to_code, prose_to_html};
pub use markdown::{ImportItem, ImportPreview, ItemKind, ProgramMode, parse};
