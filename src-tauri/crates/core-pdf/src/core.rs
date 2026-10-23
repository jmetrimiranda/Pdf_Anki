//! `PdfCore`: open documents for text, covers and metadata, on PdfCraft's render crate.
//!
//! Opening (docs/tecnico/pdfcraft-api.md §1.2–1.4): `pdfcraft_render::inspect` gives geometry,
//! outline and the Info dictionary. The renderer only takes the *user* password of R2–R4 files,
//! so an owner password is turned into the user password it unlocks through `pdfcraft-cos`
//! (what the engine's `render_password_for` does).
//!
//! Threading: `PdfCore` is `Send + Sync` and every method takes `&self`, so the app shares one
//! `Arc<PdfCore>` between commands and the `pdf://` protocol. Methods block; call them from a
//! blocking pool. Per open document there is one actor thread owning a small `RenderPool` (text
//! and cover), created on first use, so PdfCraft's watchdog bounds pathological pages, plus a
//! small LRU of page texts.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use pdfcraft_render::{
    PageInfo, PageText, RenderConfig, RenderRequest, RequestKind, device_pixels,
};

use crate::actor::RenderActor;
use crate::error::guard;
use crate::types::{DocHandle, DocInfo, OutlineItem, PageSize, PageWords, PdfMeta, TextStats};
use crate::{PdfError, encode, info, words};

/// Page texts kept per document.
const TEXT_CACHE_PAGES: usize = 16;
/// Workers of a document's pool: one page stuck until the watchdog fires must not stall the rest.
const POOL_THREADS: usize = 2;

/// The PDF core. Share it as `Arc<PdfCore>`.
pub struct PdfCore {
    docs: RwLock<HashMap<DocHandle, Arc<OpenDoc>>>,
    next_id: AtomicU64,
}

struct OpenDoc {
    handle: DocHandle,
    bytes: Arc<Vec<u8>>,
    /// Holds the render password (the recovered user password for R2–R4 owner passwords).
    config: RenderConfig,
    pages: Vec<PageInfo>,
    title: Option<String>,
    author: Option<String>,
    outline: Vec<OutlineItem>,
    actor: Mutex<Option<Arc<RenderActor>>>,
    text_cache: Mutex<VecDeque<(usize, Arc<PageText>)>>,
}

impl Default for PdfCore {
    fn default() -> Self {
        Self::new()
    }
}

/// The result of opening through `inspect`, with the password the renderer needs.
struct Inspected {
    info: pdfcraft_render::DocInfo,
    render_password: Option<String>,
}

impl PdfCore {
    pub fn new() -> Self {
        Self {
            docs: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Reads what the library needs (page count, title, author, `LeitorBookUid`) without keeping
    /// the document open. `password` is the user or owner password.
    pub fn inspect(
        &self,
        bytes: Arc<Vec<u8>>,
        password: Option<&str>,
    ) -> Result<PdfMeta, PdfError> {
        let opened = guard(|| inspect_with_password(bytes, password))?;
        let info = opened.info;
        let leitor_book_uid = info
            .custom
            .iter()
            .find(|(k, _)| k == info::LEITOR_BOOK_UID_KEY)
            .and_then(|(_, v)| info::valid_book_uid(v));
        Ok(PdfMeta {
            page_count: info.pages.len(),
            title: non_empty(info.title),
            author: non_empty(info.author),
            leitor_book_uid,
            warnings: info.warnings,
        })
    }

    /// Opens a document for text, covers and outline. `password` is the user or owner password.
    pub fn open(&self, bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<DocHandle, PdfError> {
        let opened = guard(|| inspect_with_password(bytes.clone(), password))?;
        let handle = DocHandle(self.next_id.fetch_add(1, Ordering::Relaxed));
        let info = opened.info;
        let doc = OpenDoc {
            handle,
            bytes,
            config: RenderConfig {
                password: opened.render_password.map(Arc::from),
                ..RenderConfig::default()
            },
            outline: info.outline.iter().map(convert_outline).collect(),
            pages: info.pages,
            title: non_empty(info.title),
            author: non_empty(info.author),
            actor: Mutex::new(None),
            text_cache: Mutex::new(VecDeque::new()),
        };
        tracing::debug!(%handle, pages = doc.pages.len(), "pdf opened");
        write(&self.docs).insert(handle, Arc::new(doc));
        Ok(handle)
    }

    /// Releases a document and its threads. Unknown handles are ignored.
    pub fn close(&self, doc: DocHandle) {
        write(&self.docs).remove(&doc);
    }

    /// Handles of the open documents, in opening order.
    pub fn open_documents(&self) -> Vec<DocHandle> {
        let mut v: Vec<_> = read(&self.docs).keys().copied().collect();
        v.sort();
        v
    }

    /// Page count, page sizes, title and author.
    pub fn info(&self, doc: DocHandle) -> Result<DocInfo, PdfError> {
        let d = self.doc(doc)?;
        Ok(DocInfo {
            doc_id: d.handle.to_string(),
            page_count: d.pages.len(),
            pages: d
                .pages
                .iter()
                .map(|p| PageSize {
                    width: p.width,
                    height: p.height,
                })
                .collect(),
            title: d.title.clone(),
            author: d.author.clone(),
        })
    }

    /// The bookmarks, with 0-based pages.
    pub fn outline(&self, doc: DocHandle) -> Result<Vec<OutlineItem>, PdfError> {
        Ok(self.doc(doc)?.outline.clone())
    }

    /// The page text segmented into words (UAX #29) with their rects, in view space (points,
    /// origin at the top-left of the page as displayed, y down).
    pub fn page_words(&self, doc: DocHandle, page: usize) -> Result<PageWords, PdfError> {
        let d = self.doc(doc)?;
        let info = d.page(page)?;
        let pt = d.page_text(page, true)?;
        let (text, words) = words::page_words(&pt);
        Ok(PageWords {
            page,
            width: info.width,
            height: info.height,
            text,
            words,
        })
    }

    /// Samples up to `max_pages` pages, evenly spaced and including the first and the last, and
    /// counts those with more than [`TextStats::MIN_CHARS`] non-whitespace characters. A page
    /// whose text cannot be read counts as a page without text.
    pub fn text_stats(&self, doc: DocHandle, max_pages: usize) -> Result<TextStats, PdfError> {
        let d = self.doc(doc)?;
        let mut stats = TextStats::default();
        for page in sample_pages(d.pages.len(), max_pages) {
            stats.pages_checked += 1;
            // Not cached: a sweep through the book must not evict the pages in use.
            match d.page_text(page, false) {
                Ok(pt) => {
                    if visible_chars(&pt) > TextStats::MIN_CHARS {
                        stats.pages_with_text += 1;
                    }
                }
                Err(e @ (PdfError::Internal(_) | PdfError::UnknownDocument)) => return Err(e),
                Err(e) => tracing::warn!(page, error = ?e, "text stats skipped a page"),
            }
        }
        Ok(stats)
    }

    /// The first page as a PNG on a white background, its longest side at most `max_side_px`.
    pub fn cover_png(&self, doc: DocHandle, max_side_px: u32) -> Result<Vec<u8>, PdfError> {
        let d = self.doc(doc)?;
        let page = d.page(0)?;
        let scale = cover_scale(page.width, page.height, max_side_px)?;
        let out = d.actor()?.render(RenderRequest {
            page: 0,
            kind: RequestKind::Pixels,
            scale,
            ..Default::default()
        })?;
        if let Some(e) = &out.error {
            return Err(PdfError::Render(e.clone()));
        }
        // Premultiplied, but the config never asks for transparency: every pixel is opaque.
        encode::encode_rgba(out.width, out.height, &out.rgba)
    }

    fn doc(&self, handle: DocHandle) -> Result<Arc<OpenDoc>, PdfError> {
        read(&self.docs)
            .get(&handle)
            .cloned()
            .ok_or(PdfError::UnknownDocument)
    }
}

impl OpenDoc {
    fn page(&self, page: usize) -> Result<&PageInfo, PdfError> {
        self.pages
            .get(page)
            .ok_or_else(|| PdfError::page_out_of_range(page, self.pages.len()))
    }

    fn actor(&self) -> Result<Arc<RenderActor>, PdfError> {
        let mut slot = lock(&self.actor);
        if let Some(a) = &*slot {
            return Ok(a.clone());
        }
        let actor = Arc::new(RenderActor::spawn(
            self.bytes.clone(),
            self.config.clone(),
            POOL_THREADS,
            format!("pdf-core-{}", self.handle),
        )?);
        *slot = Some(actor.clone());
        Ok(actor)
    }

    fn cached_text(&self, page: usize) -> Option<Arc<PageText>> {
        let mut cache = lock(&self.text_cache);
        let pos = cache.iter().position(|(p, _)| *p == page)?;
        let entry = cache.remove(pos)?;
        let pt = entry.1.clone();
        cache.push_front(entry);
        Some(pt)
    }

    fn page_text(&self, page: usize, keep: bool) -> Result<Arc<PageText>, PdfError> {
        self.page(page)?;
        if let Some(pt) = self.cached_text(page) {
            return Ok(pt);
        }
        // Concurrent requests for the same page are merged by the actor.
        let out = self.actor()?.render(RenderRequest {
            page,
            kind: RequestKind::Text,
            scale: 1.0,
            ..Default::default()
        })?;
        let pt = match (&out.error, &out.text) {
            (Some(e), _) => return Err(PdfError::Text(e.clone())),
            (None, Some(pt)) => pt.clone(),
            (None, None) => return Err(PdfError::Text("no text layer returned".into())),
        };
        if keep {
            let mut cache = lock(&self.text_cache);
            cache.push_front((page, pt.clone()));
            cache.truncate(TEXT_CACHE_PAGES);
        }
        Ok(pt)
    }
}

/// `inspect`, retrying an owner password as the user password it recovers (R2–R4).
fn inspect_with_password(
    bytes: Arc<Vec<u8>>,
    password: Option<&str>,
) -> Result<Inspected, PdfError> {
    let first = pdfcraft_render::inspect(bytes.clone(), password);
    let (info, render_password) = match (first, password) {
        (Err(pdfcraft_render::OpenError::WrongPassword), Some(pw)) => {
            let Some(user) = recovered_user_password(bytes.clone(), pw) else {
                return Err(PdfError::WrongPassword);
            };
            let info = pdfcraft_render::inspect(bytes, Some(&user)).map_err(PdfError::from_open)?;
            (info, Some(user))
        }
        (result, _) => (
            result.map_err(PdfError::from_open)?,
            password.map(str::to_owned),
        ),
    };
    if info.pages.is_empty() {
        return Err(PdfError::Invalid("the document has no pages".into()));
    }
    Ok(Inspected {
        info,
        render_password,
    })
}

/// The user password an owner password unlocks, as the renderer takes it (the engine's private
/// `renderer_password`: UTF-8 if valid, otherwise PDFDocEncoding byte by byte).
fn recovered_user_password(bytes: Arc<Vec<u8>>, owner: &str) -> Option<String> {
    let doc = pdfcraft_cos::Document::open_with_password(bytes, Some(owner)).ok()?;
    let user = doc.security()?.recovered_user_password()?;
    Some(match std::str::from_utf8(&user) {
        Ok(text) => text.to_owned(),
        Err(_) => user.iter().map(|b| pdfcraft_cos::pdfdoc_char(*b)).collect(),
    })
}

/// `n` = min(count, max) page indices spread evenly over `0..count`, first and last included.
pub(crate) fn sample_pages(count: usize, max: usize) -> Vec<usize> {
    let n = count.min(max);
    match n {
        0 => Vec::new(),
        1 => vec![0],
        _ => (0..n).map(|i| i * (count - 1) / (n - 1)).collect(),
    }
}

fn visible_chars(pt: &PageText) -> usize {
    pt.glyphs
        .iter()
        .flat_map(|g| g.text.chars())
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .count()
}

/// The scale (pixels per point) that fits the page's longest side in `max_side_px`.
fn cover_scale(width: f32, height: f32, max_side_px: u32) -> Result<f32, PdfError> {
    if max_side_px == 0 {
        return Err(PdfError::InvalidRequest(
            "o tamanho da capa precisa ser maior que zero.".into(),
        ));
    }
    let longest = width.max(height);
    if !(longest.is_finite() && longest > 0.0) {
        return Err(PdfError::Render(format!("page size {width}x{height}")));
    }
    let max_side = max_side_px as f32;
    let mut scale = max_side / longest;
    // `device_pixels` rounds up; shave the scale until the result fits.
    while scale > 0.0 && device_pixels(longest, scale) > max_side_px {
        scale *= 0.999;
    }
    Ok(scale)
}

fn convert_outline(item: &pdfcraft_render::OutlineItem) -> OutlineItem {
    OutlineItem {
        title: item.title.clone(),
        page: item.page,
        children: item.children.iter().map(convert_outline).collect(),
    }
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

// A panic is always caught before it can poison these locks, so recovering is safe.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn read<T>(l: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| e.into_inner())
}

fn write<T>(l: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_safety() {
        fn send<T: Send>() {}
        fn send_sync<T: Send + Sync>() {}
        send::<pdfcraft_render::PageRenderer>();
        send::<pdfcraft_render::RenderPool>();
        send_sync::<PageText>();
        send_sync::<RenderConfig>();
        send_sync::<PdfCore>();
    }

    #[test]
    fn samples_are_spread_and_include_both_ends() {
        assert!(sample_pages(0, 40).is_empty());
        assert!(sample_pages(10, 0).is_empty());
        assert_eq!(sample_pages(1, 40), [0]);
        assert_eq!(sample_pages(3, 40), [0, 1, 2]);
        assert_eq!(sample_pages(10, 2), [0, 9]);
        let s = sample_pages(500, 40);
        assert_eq!(s.len(), 40);
        assert_eq!((s[0], s[39]), (0, 499));
        assert!(s.windows(2).all(|w| w[0] < w[1]), "{s:?}");
    }

    #[test]
    fn cover_scale_fits_the_longest_side() {
        for (w, h, max) in [
            (595.2756, 841.8898, 480),
            (841.8898, 595.2756, 480),
            (100.0, 100.0, 1),
            (612.0, 792.0, 333),
            (14400.0, 3.0, 480),
        ] {
            let s = cover_scale(w, h, max).expect("scale");
            let side = device_pixels(w.max(h), s);
            assert!(
                side <= max && side + 2 >= max,
                "{w}x{h} → {side} (max {max})"
            );
        }
        assert!(matches!(
            cover_scale(100.0, 100.0, 0),
            Err(PdfError::InvalidRequest(_))
        ));
        assert!(matches!(
            cover_scale(0.0, 0.0, 480),
            Err(PdfError::Render(_))
        ));
    }
}
