//! Text recognition (OCR) of scanned pages (docs/PROJETO.md 7.2) and the invisible text layer that makes them
//! searchable, without PdfCraft's engine.
//!
//! This is PdfCraft's own "Recognize text" (`crates/engine/src/ocr.rs`, `OcrJob::run` and `Session::ocr_job`)
//! on the layers below the engine (docs/tecnico/pdfcraft-api.md §8):
//!
//! 1. the scan's own resolution comes from `pdfcraft_edit::page_images` (pixels / placed size);
//! 2. each page is rendered with a `PageRenderer` at `clamp(native, fit, dpi/72 · fit)` pixels per point, where
//!    `fit = min(1, 842 / longest side)` (a page bigger than an A4 sheet is measured as if shrunk to one);
//! 3. pages that already carry text are skipped (`skip_text_pages`), otherwise the words the page's own text
//!    already covers (≥ 50 % of the word box) are dropped;
//! 4. `pdfcraft_ocr::Ocr::recognize` reads the pixels and each word is placed in user space through
//!    `PageInfo::view_to_user`;
//! 5. [`apply_text_layer`] writes the words as `pdfcraft_edit::stamp(doc, page, "OCR", pdfcraft_ocr::text_layer)`,
//!    exactly what the engine's `Edit::AddOcrText` does (PdfCraft's "Searchable Image"), and saves an incremental
//!    update, so the Info dictionary (`LeitorBookUid`) and everything else in the file stay as they were.
//!
//! The models read the Latin alphabet without accents (English). One page is rendered at a time and its pixels
//! are dropped before the next one. Recognition runs on rten's own thread pool (one thread per *physical* core;
//! the only knob is the process-wide `RTEN_NUM_THREADS` environment variable, read once, which code can't set
//! without `unsafe`): on machines with SMT the logical siblings stay free for the UI. Pure Rust, no desktop APIs. Nothing here panics on untrusted
//! input: each page runs inside the crate's `catch_unwind` guard and a page that fails is reported as skipped.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use pdfcraft_cos::{Document, Object, SaveOptions};
use pdfcraft_render::{PageInfo, PageRenderer, RenderConfig, RenderRequest, RequestKind};

pub use pdfcraft_ocr::PlacedWord;

use crate::PdfError;
use crate::core::inspect_with_password;
use crate::error::guard;

/// The tag of the OCR text layer's content stream (`/PCMark /OCR`), the one PdfCraft's "Recognize text" uses.
pub const OCR_TAG: &str = "OCR";
/// The two model files [`OcrModels::in_dir`] needs.
pub const OCR_MODEL_FILES: [&str; 2] = [
    pdfcraft_ocr::DETECTION_MODEL,
    pdfcraft_ocr::RECOGNITION_MODEL,
];

/// A recognised word whose box the page's own text covers this much is that text read again.
const ALREADY_ON_PAGE: f32 = 0.5;
/// The long side of an A4 sheet in points: the resolution is chosen for paper this size or smaller.
const SHEET: f32 = 842.0;

/// Where the recognition models are.
#[derive(Clone, Debug, PartialEq)]
pub struct OcrModels(pdfcraft_ocr::Models);

impl OcrModels {
    /// The models in `dir`, when both files ([`OCR_MODEL_FILES`]) are there.
    pub fn in_dir(dir: &Path) -> Option<Self> {
        pdfcraft_ocr::Models::in_dir(dir).map(Self)
    }
}

/// A loaded recogniser. Loading reads about 12 MB of models and takes a moment: load once and share it (it is
/// `Send + Sync` and cheap to clone).
#[derive(Clone)]
pub struct OcrEngine(Arc<pdfcraft_ocr::Ocr>);

impl std::fmt::Debug for OcrEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OcrEngine")
    }
}

impl OcrEngine {
    pub fn load(models: &OcrModels) -> Result<Self, PdfError> {
        guard(|| {
            pdfcraft_ocr::Ocr::load(&models.0)
                .map(|o| Self(Arc::new(o)))
                .map_err(|e| PdfError::Ocr(e.to_string()))
        })
    }
}

/// How pages are read (PdfCraft's Recognize Text settings, without the language: the models read English).
#[derive(Clone, Debug, PartialEq)]
pub struct OcrSettings {
    /// Resolution pages are rendered at, capped at the scan's own (enlarging a scan only blurs it).
    pub dpi: f32,
    /// Leave pages that already have text alone.
    pub skip_text_pages: bool,
}

impl Default for OcrSettings {
    fn default() -> Self {
        Self {
            dpi: 300.0,
            skip_text_pages: true,
        }
    }
}

/// What recognition found on one page.
#[derive(Clone, Debug, PartialEq)]
pub struct OcrPageResult {
    /// 0-based.
    pub page: u32,
    /// The words to add, placed in PDF user space.
    pub words: Vec<PlacedWord>,
    /// Why the page was not read (English, for logs), if it was skipped.
    pub skipped: Option<String>,
    /// Words recognised but left out because the page's own text already has them there.
    pub already_on_page: u32,
    /// Time spent on the page (render + recognition), in milliseconds.
    pub ms: u64,
}

impl OcrPageResult {
    /// The recognised words joined by spaces.
    pub fn text(&self) -> String {
        self.words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn skipped(page: usize, why: impl Into<String>) -> Self {
        Self {
            page: u32::try_from(page).unwrap_or(u32::MAX),
            words: Vec::new(),
            skipped: Some(why.into()),
            already_on_page: 0,
            ms: 0,
        }
    }
}

/// Recognises the text of `pages` (0-based; `None` = every page; pages past the end are ignored) one page at a
/// time. `progress(done, total)` is called before the first page and after each one. Setting `cancel` stops
/// between pages (and between rendering and recognising a page) with [`PdfError::Cancelled`]. A page that can't
/// be rendered or read comes back with `skipped`; only a document that can't be opened is an error
/// (`NeedsPassword` for an encrypted file). Never panics.
pub fn ocr_pages(
    bytes: Arc<Vec<u8>>,
    engine: &OcrEngine,
    pages: Option<&[u32]>,
    settings: &OcrSettings,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<Vec<OcrPageResult>, PdfError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(PdfError::Cancelled);
    }
    let opened = guard(|| inspect_with_password(Arc::clone(&bytes), None))?;
    let infos = opened.info.pages;
    let mut wanted: Vec<usize> = match pages {
        Some(list) => list
            .iter()
            .filter_map(|&p| usize::try_from(p).ok())
            .filter(|&p| p < infos.len())
            .collect(),
        None => (0..infos.len()).collect(),
    };
    wanted.sort_unstable();
    wanted.dedup();
    let total = u32::try_from(wanted.len()).unwrap_or(u32::MAX);
    // The scan resolution needs the content streams; a file `cos` can't read is still rendered at `dpi`.
    let native = guard(|| Ok(native_scales(&bytes, &wanted))).unwrap_or_else(|e| {
        tracing::debug!(error = ?e, "ocr: no native resolution");
        HashMap::new()
    });
    let config = RenderConfig {
        password: opened.render_password.map(Arc::from),
        ..RenderConfig::default()
    };
    let mut renderer = guard(|| Ok(PageRenderer::new(bytes, config)))?;
    let mut out = Vec::with_capacity(wanted.len());
    progress(0, total);
    for (i, &page) in wanted.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(PdfError::Cancelled);
        }
        let Some(info) = infos.get(page) else {
            continue;
        };
        let started = Instant::now();
        let read = guard(|| {
            read_page(
                &mut renderer,
                &engine.0,
                page,
                info,
                native.get(&page).copied(),
                settings,
                cancel,
            )
        });
        let mut result = match read {
            Ok(r) => r,
            Err(PdfError::Cancelled) => return Err(PdfError::Cancelled),
            Err(e) => {
                tracing::warn!(page, error = ?e, "ocr: page failed");
                OcrPageResult::skipped(page, format!("{e:?}"))
            }
        };
        result.ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        tracing::debug!(
            page,
            words = result.words.len(),
            ms = result.ms,
            skipped = ?result.skipped,
            "ocr page"
        );
        out.push(result);
        progress(u32::try_from(i + 1).unwrap_or(u32::MAX), total);
    }
    Ok(out)
}

/// One page of [`ocr_pages`] (the engine's `OcrJob::run` loop body).
fn read_page(
    r: &mut PageRenderer,
    ocr: &pdfcraft_ocr::Ocr,
    page: usize,
    info: &PageInfo,
    native: Option<f32>,
    settings: &OcrSettings,
    cancel: &AtomicBool,
) -> Result<OcrPageResult, PdfError> {
    // The boxes of the page's own text (an earlier OCR layer's included), in view space.
    let existing: Vec<[f32; 4]> = r
        .render(RenderRequest {
            page,
            kind: RequestKind::Text,
            scale: 1.0,
            ..Default::default()
        })
        .text
        .map(|t| {
            t.glyphs
                .iter()
                .filter(|g| !g.text.trim().is_empty())
                .map(|g| g.rect)
                .collect()
        })
        .unwrap_or_default();
    if settings.skip_text_pages && !existing.is_empty() {
        return Ok(OcrPageResult::skipped(
            page,
            "the page already contains text",
        ));
    }
    let shot = r.render(RenderRequest {
        page,
        scale: render_scale(settings, info, native),
        ..Default::default()
    });
    if let Some(e) = shot.error {
        return Ok(OcrPageResult::skipped(page, e));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(PdfError::Cancelled);
    }
    let (width, height) = (shot.width, shot.height);
    let lines = ocr.recognize(&shot.rgba, width, height);
    // The page's pixels are the big allocation: gone before the words are placed and the next page rendered.
    drop(shot);
    let lines = match lines {
        Ok(l) => l,
        Err(e) => return Ok(OcrPageResult::skipped(page, e.to_string())),
    };
    let scale = width as f32 / info.width.max(1e-3);
    let to_user = |x: f32, y: f32| {
        let [u, v] = info.view_to_user(x / scale, y / scale);
        [f64::from(u), f64::from(v)]
    };
    let mut words = Vec::new();
    let mut already = 0u32;
    for w in lines.iter().flat_map(|l| &l.words) {
        if !on_image(w, width as f32, height as f32) {
            continue;
        }
        if covered(w.rect.map(|v| v / scale), &existing) < ALREADY_ON_PAGE {
            let placed = PlacedWord::place(w, to_user);
            if placed
                .origin
                .iter()
                .chain(&placed.across)
                .chain(&placed.up)
                .all(|v| v.is_finite())
            {
                words.push(placed);
            }
        } else {
            already = already.saturating_add(1);
        }
    }
    Ok(OcrPageResult {
        page: u32::try_from(page).unwrap_or(u32::MAX),
        words,
        skipped: None,
        already_on_page: already,
        ms: 0,
    })
}

/// Whether `word`'s box lies on the `width` × `height` image. A box reaching past the edge is something the
/// scan cut (the edge of the sheet, specks along it): its text would land off the page, so it is left out.
fn on_image(word: &pdfcraft_ocr::Word, width: f32, height: f32) -> bool {
    let [l, t, r, b] = word.rect;
    word.rect.iter().all(|v| v.is_finite())
        && l >= 0.0
        && t >= 0.0
        && r <= width
        && b <= height
        && r > l
        && b > t
}

/// The render scale (pixels per point) a page is read at: the scan's own resolution, at most the chosen one
/// (the engine's `OcrJob::scale`).
fn render_scale(settings: &OcrSettings, info: &PageInfo, native: Option<f32>) -> f32 {
    let dpi = if settings.dpi.is_finite() {
        settings.dpi.clamp(72.0, 600.0)
    } else {
        300.0
    };
    let wanted = dpi / 72.0;
    let Some(native) = native.filter(|n| n.is_finite() && *n > 0.0) else {
        return wanted;
    };
    let fit = (SHEET / info.width.max(info.height).max(1e-3)).min(1.0);
    native.clamp(fit, wanted * fit)
}

/// Per wanted page with images: the scale (pixels per point) that shows them at their own resolution.
fn native_scales(bytes: &Arc<Vec<u8>>, wanted: &[usize]) -> HashMap<usize, f32> {
    let Ok(doc) = Document::open(Arc::clone(bytes)) else {
        return HashMap::new();
    };
    wanted
        .iter()
        .filter_map(|&p| {
            let images = pdfcraft_edit::page_images(&doc, p).ok()?;
            images
                .iter()
                .filter(|i| i.width > 1 && i.height > 1 && !i.is_form)
                .map(|i| {
                    let m = i.matrix;
                    let (w, h) = (m[0].hypot(m[1]), m[2].hypot(m[3]));
                    (f64::from(i.width) / w.max(1e-6)).max(f64::from(i.height) / h.max(1e-6)) as f32
                })
                .filter(|s| s.is_finite() && *s > 0.0)
                .reduce(f32::max)
                .map(|s| (p, s))
        })
        .collect()
}

/// How much of `word` the `text` boxes cover, from 0 to 1 (boxes `[x0, y0, x1, y1]`, view space). Overlaps
/// between text boxes count twice (glyphs rarely overlap), so the sum is capped at the whole word.
fn covered(word: [f32; 4], text: &[[f32; 4]]) -> f32 {
    // `max(0.0)` also turns a NaN side into 0: a degenerate box covers nothing.
    let area = |[x0, y0, x1, y1]: [f32; 4]| (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
    let total = area(word);
    if !total.is_finite() || total <= 0.0 {
        return 0.0;
    }
    let inside: f32 = text
        .iter()
        .map(|g| {
            area([
                word[0].max(g[0]),
                word[1].max(g[1]),
                word[2].min(g[2]),
                word[3].min(g[3]),
            ])
        })
        .filter(|a| a.is_finite())
        .sum();
    (inside / total).min(1.0)
}

/// `bytes` with the words of `pages` added as an invisible text layer (PdfCraft's "Searchable Image": the
/// images stay untouched), written as an incremental update after the original bytes. Pages without words are
/// left alone; with `skip_pages_with_layer`, so are pages that already carry an OCR layer ([`has_ocr_layer`]).
/// Returns the input unchanged when nothing was added. A page index past the end is an error. Never panics.
pub fn apply_text_layer(
    bytes: &[u8],
    pages: &[OcrPageResult],
    skip_pages_with_layer: bool,
) -> Result<Vec<u8>, PdfError> {
    guard(|| {
        let mut doc = Document::open(Arc::new(bytes.to_vec())).map_err(PdfError::from_cos)?;
        let count = page_count(&doc)?;
        let mut stamped = 0usize;
        for p in pages.iter().filter(|p| !p.words.is_empty()) {
            let page = usize::try_from(p.page).unwrap_or(usize::MAX);
            if page >= count {
                return Err(PdfError::page_out_of_range(page, count));
            }
            if skip_pages_with_layer && page_has_layer(&doc, page)? {
                continue;
            }
            pdfcraft_edit::stamp(&mut doc, page, OCR_TAG, pdfcraft_ocr::text_layer(&p.words))
                .map_err(|e| edit_error(e, count))?;
            stamped += 1;
        }
        if stamped == 0 {
            return Ok(bytes.to_vec());
        }
        pdfcraft_cos::write_incremental(&doc, &SaveOptions::default())
            .map_err(|e| PdfError::Internal(format!("write_incremental: {e}")))
    })
}

/// Whether page `page` (0-based) carries an OCR text layer: a content stream tagged `/PCMark /OCR`, which is
/// how PdfCraft's "Recognize text" and [`apply_text_layer`] write it. Never panics.
pub fn has_ocr_layer(bytes: Arc<Vec<u8>>, page: u32) -> Result<bool, PdfError> {
    guard(|| {
        let doc = Document::open(bytes).map_err(PdfError::from_cos)?;
        let count = page_count(&doc)?;
        let page = usize::try_from(page).unwrap_or(usize::MAX);
        if page >= count {
            return Err(PdfError::page_out_of_range(page, count));
        }
        page_has_layer(&doc, page)
    })
}

fn page_count(doc: &Document) -> Result<usize, PdfError> {
    let pages =
        pdfcraft_organize::pages(doc).map_err(|e| PdfError::Invalid(format!("page tree: {e}")))?;
    if pages.is_empty() {
        return Err(PdfError::Invalid("the document has no pages".into()));
    }
    Ok(pages.len())
}

fn page_has_layer(doc: &Document, page: usize) -> Result<bool, PdfError> {
    let pages =
        pdfcraft_organize::pages(doc).map_err(|e| PdfError::Invalid(format!("page tree: {e}")))?;
    let Some(p) = pages.get(page) else {
        return Err(PdfError::page_out_of_range(page, pages.len()));
    };
    let obj = doc.get(p.obj);
    let Some(contents) = obj.as_dict().and_then(|d| d.get(b"Contents")).cloned() else {
        return Ok(false);
    };
    let contents = doc.resolve(&contents);
    let tagged = |o: &Object| match &*doc.resolve(o) {
        Object::Stream(s) => s.dict.name(b"PCMark") == Some(OCR_TAG.as_bytes()),
        _ => false,
    };
    Ok(match contents.as_ref() {
        Object::Array(items) => items.iter().any(tagged),
        other => tagged(other),
    })
}

fn edit_error(e: pdfcraft_edit::EditError, count: usize) -> PdfError {
    match e {
        pdfcraft_edit::EditError::NoSuchPage(p) => PdfError::page_out_of_range(p, count),
        pdfcraft_edit::EditError::Cos(c) => PdfError::from_cos(c),
        pdfcraft_edit::EditError::Invalid(d) => PdfError::Internal(format!("stamp: {d}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_safety() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<OcrEngine>();
        send_sync::<pdfcraft_ocr::Ocr>();
    }

    #[test]
    fn words_cut_by_the_edge_of_the_scan_are_left_out() {
        let word = |rect| pdfcraft_ocr::Word {
            text: "3".into(),
            rect,
        };
        assert!(on_image(&word([10.0, 10.0, 30.0, 20.0]), 100.0, 100.0));
        assert!(on_image(&word([0.0, 0.0, 100.0, 100.0]), 100.0, 100.0));
        assert!(!on_image(&word([10.0, 90.0, 30.0, 100.5]), 100.0, 100.0));
        assert!(!on_image(&word([-1.0, 10.0, 30.0, 20.0]), 100.0, 100.0));
        assert!(!on_image(&word([5.0, 5.0, 5.0, 9.0]), 100.0, 100.0));
        assert!(!on_image(&word([f32::NAN, 0.0, 5.0, 5.0]), 100.0, 100.0));
    }

    #[test]
    fn coverage_of_a_word_box() {
        let word = [0.0, 0.0, 10.0, 10.0];
        assert_eq!(covered(word, &[]), 0.0);
        assert_eq!(covered(word, &[[0.0, 0.0, 10.0, 10.0]]), 1.0);
        assert!((covered(word, &[[0.0, 0.0, 5.0, 10.0]]) - 0.5).abs() < 1e-6);
        // Overlapping glyph boxes never count for more than the word.
        assert_eq!(covered(word, &[word, word]), 1.0);
        assert_eq!(covered([0.0, 0.0, f32::NAN, 1.0], &[word]), 0.0);
        assert_eq!(covered([5.0, 5.0, 5.0, 5.0], &[word]), 0.0);
    }

    fn page(width: f32, height: f32) -> PageInfo {
        PageInfo {
            width,
            height,
            label: "1".into(),
            crop: [0.0, 0.0, width, height],
            rotation: 0,
        }
    }

    #[test]
    fn scale_is_the_scan_resolution_at_most_the_chosen_one() {
        let letter = page(612.0, 792.0);
        let s = OcrSettings::default();
        let near = |a: f32, b: f32| (a - b).abs() < 1e-3;
        // No image: the chosen resolution.
        assert!(near(render_scale(&s, &letter, None), 300.0 / 72.0));
        // A 200 dpi scan is read at 200 dpi, a 600 dpi one at 300.
        assert!(near(
            render_scale(&s, &letter, Some(200.0 / 72.0)),
            200.0 / 72.0
        ));
        assert!(near(
            render_scale(&s, &letter, Some(600.0 / 72.0)),
            300.0 / 72.0
        ));
        // A page given in pixels (one point per pixel, 300 dpi A4) is measured as if shrunk to a sheet: its
        // full image, not more.
        assert!(near(
            render_scale(&s, &page(2480.0, 3508.0), Some(1.0)),
            1.0
        ));
        // Nonsense settings and image sizes fall back to sane values.
        let bad = OcrSettings {
            dpi: f32::NAN,
            ..OcrSettings::default()
        };
        assert!(near(
            render_scale(&bad, &letter, Some(f32::INFINITY)),
            300.0 / 72.0
        ));
    }
}
