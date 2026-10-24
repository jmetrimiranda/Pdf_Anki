//! EPUB core without UI (spec 7.1, 12.3 B, 18): parses the container, the OPF package and the
//! table of contents, finds the cover and extracts the plain text of each spine section for the
//! search and the vocabulary scan. Pure Rust, synchronous, no desktop APIs; the reader itself is
//! foliate-js in the web UI. Technical notes: docs/tecnico/epub.md.
//!
//! **Unit = section index**: sections are the spine itemrefs in order (linear and non-linear)
//! whose manifest item exists — the same list and order as foliate-js `book.sections`.
//!
//! Every public entry point runs under a panic guard; untrusted files only ever give `EpubError`.

mod archive;
mod book;
mod cfi;
mod error;
mod opf;
mod path;
mod text;
mod toc;
mod xml;

#[cfg(feature = "testkit")]
pub mod testkit;

use serde::{Deserialize, Serialize};

pub use book::{EpubBook, fingerprint_of, open};
pub use cfi::{MAX_CFI_LEN, is_valid_cfi, section_of_cfi};
pub use error::EpubError;

/// Limits applied to untrusted EPUBs (docs/tecnico/epub.md).
pub mod limits {
    pub use crate::archive::{
        MAX_COVER, MAX_ENTRIES, MAX_PACKAGE_FILE, MAX_SECTION, MAX_TOTAL_TEXT,
    };
    pub use crate::toc::{MAX_DEPTH as MAX_TOC_DEPTH, MAX_ITEMS as MAX_TOC_ITEMS};
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EpubVersion {
    V2,
    V3,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubMeta {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub identifier: Option<String>,
    pub version: EpubVersion,
}

/// One spine item (a content document). `index` is the unit everywhere (vocabulary, `book_text`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub index: u32,
    /// Manifest id.
    pub id: String,
    /// Zip path (percent-decoded, normalised).
    pub href: String,
    pub media_type: String,
    pub linear: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TocItem {
    pub title: String,
    /// Zip path of the target (percent-decoded); empty for a heading without a link.
    pub href: String,
    /// `#fragment` of the target, percent-decoded.
    pub fragment: Option<String>,
    /// Section of the target; for a heading without a link, the section of its first child.
    pub section: Option<u32>,
    pub children: Vec<TocItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverImage {
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp` (sniffed from the bytes).
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionText {
    pub section: u32,
    /// Title of the deepest TOC item covering the section.
    pub label: Option<String>,
    pub text: String,
}
