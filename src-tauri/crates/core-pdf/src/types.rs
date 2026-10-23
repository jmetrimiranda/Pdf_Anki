use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::PdfError;

/// An open document. Its string form (decimal) is the `docId` of the commands and URLs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DocHandle(pub u64);

impl fmt::Display for DocHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DocHandle {
    type Err = PdfError;
    fn from_str(s: &str) -> Result<Self, PdfError> {
        s.parse()
            .map(DocHandle)
            .map_err(|_| PdfError::UnknownDocument)
    }
}

/// Size of a page as displayed, in points (rotation and crop applied).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub doc_id: String,
    pub page_count: usize,
    pub pages: Vec<PageSize>,
    pub title: Option<String>,
    pub author: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub title: String,
    /// 0-based; `None` when the bookmark points nowhere in this file.
    pub page: Option<usize>,
    pub children: Vec<OutlineItem>,
}

/// `[x, y, w, h]` in points, view space (origin top-left of the displayed page, y down).
pub type Rect = [f32; 4];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageWord {
    /// Number of the word on the page (0-based, reading order).
    pub index: usize,
    pub text: String,
    /// Offsets in `PageWords::text` in UTF-16 code units (so JS `text.slice(start, end)` is the
    /// word), end exclusive.
    pub start: usize,
    pub end: usize,
    /// One rect per line run the word covers.
    pub rects: Vec<Rect>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageWords {
    pub page: usize,
    pub width: f32,
    pub height: f32,
    /// The page text as PdfCraft reconstructs it (`' '` between words, `'\n'` between lines).
    pub text: String,
    pub words: Vec<PageWord>,
}

/// What the library needs from a file at import time (spec 6.6), without keeping it open.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMeta {
    pub page_count: usize,
    pub title: Option<String>,
    pub author: Option<String>,
    /// `LeitorBookUid` from the Info dictionary (spec 6.5), only when it is a well-formed
    /// `book_uid` (64 lowercase hex digits).
    pub leitor_book_uid: Option<String>,
    /// Structure problems PdfCraft worked around (English, for logs).
    pub warnings: Vec<String>,
}

/// How much of a sample of pages carries text (spec 6.6: "parece escaneado").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStats {
    pub pages_checked: usize,
    /// Pages with more than [`TextStats::MIN_CHARS`] non-whitespace characters.
    pub pages_with_text: usize,
}

impl TextStats {
    /// A page "has text" above this many non-whitespace characters.
    pub const MIN_CHARS: usize = 20;

    /// Less than half of the checked pages have text.
    pub fn looks_scanned(&self) -> bool {
        self.pages_with_text * 2 < self.pages_checked
    }
}
