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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page: usize,
    pub rects: Vec<Rect>,
    /// The match with a little text around it, on one line.
    pub context: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOpts {
    pub case_sensitive: bool,
    pub whole_words: bool,
    /// Stop after this many hits.
    pub limit: usize,
}

impl Default for SearchOpts {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            whole_words: false,
            limit: 1000,
        }
    }
}

/// Reading theme of the page raster (independent from the app theme, spec 4).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ReadingTheme {
    #[default]
    #[serde(rename = "claro")]
    Light,
    #[serde(rename = "sepia")]
    Sepia,
    #[serde(rename = "escuro")]
    Dark,
}

impl ReadingTheme {
    /// The `tema` value of the `pdf://` URL.
    pub fn as_param(self) -> &'static str {
        match self {
            Self::Light => "claro",
            Self::Sepia => "sepia",
            Self::Dark => "escuro",
        }
    }

    pub fn from_param(s: &str) -> Option<Self> {
        match s {
            "claro" => Some(Self::Light),
            "sepia" => Some(Self::Sepia),
            "escuro" => Some(Self::Dark),
            _ => None,
        }
    }
}

/// Largest accepted scale (device pixels per point). Whole pages are further capped by PdfCraft
/// at 8192 px per side; deeper zoom goes through tiles.
pub const MAX_SCALE: f32 = 64.0;

/// Largest tile side in device pixels (PdfCraft's own clamp). A `bloco` larger than this at the
/// requested scale is rejected rather than silently cropped; split it into smaller tiles.
pub const MAX_TILE_SIDE: u32 = 4096;

/// A raster request.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RenderReq {
    /// 0-based page index.
    pub page: usize,
    /// Device pixels per point.
    pub scale: f32,
    /// Only this region `[x, y, w, h]`, in page points (view space). `None` = whole page.
    pub tile: Option<Rect>,
    pub theme: ReadingTheme,
    /// Low-detail render for thumbnails (tiny images skipped).
    pub preview: bool,
}

impl RenderReq {
    pub fn page(page: usize, scale: f32) -> Self {
        Self {
            page,
            scale,
            tile: None,
            theme: ReadingTheme::Light,
            preview: false,
        }
    }

    /// Builds a request from the query string of `pdf://localhost/render/{doc}/{page}?…`
    /// (`escala`, `bloco=x,y,w,h` in points, `tema`, `previa=1`). Unknown keys are ignored.
    pub fn from_query(page: usize, query: &str) -> Result<Self, PdfError> {
        let bad = |m: &str| PdfError::InvalidRequest(m.to_owned());
        let mut req = Self::page(page, 1.0);
        for pair in query
            .trim_start_matches('?')
            .split('&')
            .filter(|p| !p.is_empty())
        {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let value = value.replace("%2C", ",").replace("%2c", ",");
            match key {
                "escala" => {
                    req.scale = value
                        .parse()
                        .map_err(|_| bad("escala precisa ser um número"))?
                }
                "bloco" => {
                    let parts: Vec<f32> = value
                        .split(',')
                        .map(|v| v.trim().parse::<f32>())
                        .collect::<Result<_, _>>()
                        .map_err(|_| bad("bloco precisa ser x,y,w,h"))?;
                    let [x, y, w, h] = parts[..] else {
                        return Err(bad("bloco precisa ser x,y,w,h"));
                    };
                    req.tile = Some([x, y, w, h]);
                }
                "tema" => {
                    req.theme = ReadingTheme::from_param(&value)
                        .ok_or_else(|| bad("tema precisa ser claro, sepia ou escuro"))?
                }
                "previa" => req.preview = matches!(value.as_str(), "1" | "true" | "sim"),
                _ => {}
            }
        }
        Ok(req)
    }
}

/// A raster: straight RGBA8, row-major, opaque.
#[derive(Clone, Debug, PartialEq)]
pub struct Rendered {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// Render time in PdfCraft, without queue wait.
    pub millis: u32,
}

impl Rendered {
    pub fn to_png(&self) -> Result<Vec<u8>, PdfError> {
        crate::encode::encode_rgba(self.width, self.height, &self.rgba)
    }
}

/// A highlight or note to burn into an exported copy (spec 6.5; not implemented yet).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub page: usize,
    /// View-space rects, one per line.
    pub rects: Vec<Rect>,
    pub color: [u8; 3],
    pub comment: Option<String>,
}

/// A word recognised by OCR (spec 7.2; not implemented yet).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    pub rect: Rect,
}
