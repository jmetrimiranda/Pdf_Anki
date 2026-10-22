//! `PdfcraftEngine`: the `DocumentEngine` over PdfCraft.
//!
//! Opening goes through `pdfcraft-engine` (render password recovery, display bytes with drawn
//! comment appearances, page-tree repair); everything after that uses `pdfcraft-render` types
//! only, so a plan B without the engine only has to replace `open_with_engine`.
//!
//! Threading: the engine is `Send + Sync` and every method takes `&self`, so the app can share
//! one `Arc<PdfcraftEngine>` between commands and the `pdf://` protocol handler. Methods block;
//! call them from a blocking pool (`spawn_blocking`). Per document:
//! - one render actor per reading theme (created on first use), owning a `RenderPool`;
//! - one more render actor for the text layer (shared by `page_words` and search), so text
//!   extraction gets PdfCraft's watchdog too, plus a small LRU of page texts;
//! - at most one search runs: starting a new one makes the previous one stop at its next page.
//!
//! Encoded page images are kept in one size-limited LRU shared by all documents (spec 6.2).

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use pdfcraft_render::{
    PageInfo, PageText, ReadingColors, ReadingParams, RenderConfig, RenderRequest, RequestKind,
    Tile, device_pixels,
};

use crate::actor::RenderActor;
use crate::cache::{DEFAULT_PAGE_CACHE_BYTES, PageCache, PageKey};
use crate::error::guard;
use crate::types::{
    Annotation, DocHandle, DocInfo, MAX_SCALE, MAX_TILE_SIDE, OcrWord, OutlineItem, PageSize,
    PageWords, Rect, RenderReq, Rendered, SearchHit, SearchOpts,
};
use crate::{DocumentEngine, PdfError, ReadingTheme, words};

/// Page texts kept per document (the reader asks for visible pages ± 2).
const TEXT_CACHE_PAGES: usize = 32;
/// Workers of the text pool: one page stuck until the watchdog fires must not stall the reader.
const TEXT_THREADS: usize = 2;

pub struct PdfcraftEngine {
    docs: RwLock<HashMap<DocHandle, Arc<OpenDoc>>>,
    next_id: AtomicU64,
    render_threads: usize,
    page_cache: Mutex<PageCache>,
}

struct OpenDoc {
    handle: DocHandle,
    /// What is rendered: the file plus display-only appearances.
    display: Arc<Vec<u8>>,
    /// Holds the render password (the recovered user password for R2–R4 owner passwords).
    config: RenderConfig,
    pages: Vec<PageInfo>,
    render_threads: usize,
    title: Option<String>,
    author: Option<String>,
    outline: Vec<OutlineItem>,
    actors: Mutex<HashMap<ReadingTheme, Arc<RenderActor>>>,
    text_actor: Mutex<Option<Arc<RenderActor>>>,
    text_cache: Mutex<VecDeque<(usize, Arc<PageText>)>>,
    /// Bumped by every search; a running search stops once it no longer matches.
    search_generation: AtomicU64,
}

impl Default for PdfcraftEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PdfcraftEngine {
    pub fn new() -> Self {
        // Same sizing as PdfCraft's own viewer.
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 8)
            - 1;
        Self::with_render_threads(threads)
    }

    /// `threads` workers per (document, theme) render pool.
    pub fn with_render_threads(threads: usize) -> Self {
        Self {
            docs: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            render_threads: threads.max(1),
            page_cache: Mutex::new(PageCache::new(DEFAULT_PAGE_CACHE_BYTES)),
        }
    }

    /// Byte budget of the PNG cache shared by all documents (default 256 MB). 0 disables it.
    pub fn set_page_cache_bytes(&self, bytes: usize) {
        lock(&self.page_cache).set_budget(bytes);
    }

    /// Bytes held by the PNG cache.
    pub fn page_cache_bytes(&self) -> usize {
        lock(&self.page_cache).used_bytes()
    }

    /// Handles of the open documents.
    pub fn open_documents(&self) -> Vec<DocHandle> {
        let mut v: Vec<_> = read(&self.docs).keys().copied().collect();
        v.sort();
        v
    }

    fn doc(&self, handle: DocHandle) -> Result<Arc<OpenDoc>, PdfError> {
        read(&self.docs)
            .get(&handle)
            .cloned()
            .ok_or(PdfError::UnknownDocument)
    }
}

impl DocumentEngine for PdfcraftEngine {
    fn open(&self, bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<DocHandle, PdfError> {
        let opened = guard(|| open_with_engine(bytes, password))?;
        let handle = DocHandle(self.next_id.fetch_add(1, Ordering::Relaxed));
        let doc = OpenDoc {
            handle,
            display: opened.display,
            config: opened.config,
            pages: opened.info.pages,
            render_threads: self.render_threads,
            title: non_empty(opened.info.title),
            author: non_empty(opened.info.author),
            outline: opened.info.outline.iter().map(convert_outline).collect(),
            actors: Mutex::new(HashMap::new()),
            text_actor: Mutex::new(None),
            text_cache: Mutex::new(VecDeque::new()),
            search_generation: AtomicU64::new(0),
        };
        tracing::debug!(%handle, pages = doc.pages.len(), "pdf opened");
        write(&self.docs).insert(handle, Arc::new(doc));
        Ok(handle)
    }

    fn close(&self, doc: DocHandle) {
        let removed = write(&self.docs).remove(&doc);
        if let Some(d) = removed {
            // A running search holds the document; make it stop.
            d.search_generation.fetch_add(1, Ordering::AcqRel);
        }
        // After the removal: `render_png` only caches while the document is still open.
        lock(&self.page_cache).evict_doc(doc);
    }

    fn info(&self, doc: DocHandle) -> Result<DocInfo, PdfError> {
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

    fn outline(&self, doc: DocHandle) -> Result<Vec<OutlineItem>, PdfError> {
        Ok(self.doc(doc)?.outline.clone())
    }

    fn render(&self, doc: DocHandle, req: RenderReq) -> Result<Rendered, PdfError> {
        let d = self.doc(doc)?;
        let page = d.page(req.page)?;
        if !(req.scale.is_finite() && req.scale > 0.0 && req.scale <= MAX_SCALE) {
            return Err(PdfError::InvalidRequest(format!(
                "escala precisa estar entre 0 e {MAX_SCALE}"
            )));
        }
        let tile = req
            .tile
            .map(|t| tile_pixels(t, req.scale, page))
            .transpose()?;
        let actor = d.actor(req.theme)?;
        let out = actor.render(RenderRequest {
            page: req.page,
            kind: RequestKind::Pixels,
            tile,
            scale: req.scale,
            tag: 0,
            preview: req.preview,
        })?;
        if let Some(e) = &out.error {
            return Err(PdfError::Render(e.clone()));
        }
        // Premultiplied, but the config never asks for transparency, so every pixel is opaque.
        Ok(Rendered {
            width: out.width,
            height: out.height,
            rgba: out.rgba.to_vec(),
            millis: out.millis,
        })
    }

    fn render_png(&self, doc: DocHandle, req: RenderReq) -> Result<Vec<u8>, PdfError> {
        let key = PageKey::new(doc, &req);
        if let Some(png) = lock(&self.page_cache).get(&key) {
            return Ok(png.to_vec());
        }
        let png = self.render(doc, req)?.to_png()?;
        let mut cache = lock(&self.page_cache);
        if read(&self.docs).contains_key(&doc) {
            cache.insert(key, Arc::new(png.clone()));
        }
        Ok(png)
    }

    fn page_words(&self, doc: DocHandle, page: usize) -> Result<PageWords, PdfError> {
        let d = self.doc(doc)?;
        let info = d.page(page)?;
        let pt = d.page_text(page)?;
        let (text, words) = words::page_words(&pt);
        Ok(PageWords {
            page,
            width: info.width,
            height: info.height,
            text,
            words,
        })
    }

    fn search(
        &self,
        doc: DocHandle,
        query: &str,
        opts: SearchOpts,
    ) -> Result<Vec<SearchHit>, PdfError> {
        let d = self.doc(doc)?;
        let generation = d.search_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let query = query.trim();
        let mut hits = Vec::new();
        if query.is_empty() || opts.limit == 0 {
            return Ok(hits);
        }
        let actor = d.text_actor()?;
        for page in 0..d.pages.len() {
            if d.search_generation.load(Ordering::Acquire) != generation {
                return Err(PdfError::Cancelled);
            }
            // Not cached: a scan through the book must not evict the pages being read.
            let text = match d.cached_text(page) {
                Some(pt) => Ok(pt),
                None => extract_text(&actor, page),
            };
            let pt = match text {
                Ok(pt) => pt,
                // A closed document stops the scan; one unreadable page must not hide the rest.
                Err(e @ PdfError::Internal(_)) => return Err(e),
                Err(e) => {
                    tracing::warn!(page, error = ?e, "search skipped a page");
                    continue;
                }
            };
            let remaining = opts.limit - hits.len();
            hits.extend(words::search_page(
                &pt,
                page,
                query,
                opts.case_sensitive,
                opts.whole_words,
                remaining,
            ));
            if hits.len() >= opts.limit {
                break;
            }
        }
        Ok(hits)
    }

    fn export_annotated(&self, doc: DocHandle, _notes: &[Annotation]) -> Result<Vec<u8>, PdfError> {
        self.doc(doc)?;
        Err(PdfError::NotYetImplemented("export_annotated"))
    }

    fn ocr_page(&self, doc: DocHandle, page: usize) -> Result<Vec<OcrWord>, PdfError> {
        self.doc(doc)?.page(page)?;
        Err(PdfError::NotYetImplemented("ocr_page"))
    }
}

impl OpenDoc {
    fn page(&self, page: usize) -> Result<&PageInfo, PdfError> {
        self.pages.get(page).ok_or(PdfError::PageOutOfRange {
            page,
            count: self.pages.len(),
        })
    }

    fn actor(&self, theme: ReadingTheme) -> Result<Arc<RenderActor>, PdfError> {
        let mut actors = lock(&self.actors);
        if let Some(a) = actors.get(&theme) {
            return Ok(a.clone());
        }
        let config = RenderConfig {
            reading_colors: reading_colors(theme),
            ..self.config.clone()
        };
        let actor = Arc::new(RenderActor::spawn(
            self.display.clone(),
            config,
            self.render_threads,
            format!("pdf-render-{}-{}", self.handle, theme.as_param()),
        )?);
        actors.insert(theme, actor.clone());
        Ok(actor)
    }

    fn text_actor(&self) -> Result<Arc<RenderActor>, PdfError> {
        let mut slot = lock(&self.text_actor);
        if let Some(a) = &*slot {
            return Ok(a.clone());
        }
        let actor = Arc::new(RenderActor::spawn(
            self.display.clone(),
            self.config.clone(),
            TEXT_THREADS,
            format!("pdf-text-{}", self.handle),
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

    fn page_text(&self, page: usize) -> Result<Arc<PageText>, PdfError> {
        if let Some(pt) = self.cached_text(page) {
            return Ok(pt);
        }
        // Concurrent requests for the same page are merged by the actor.
        let pt = extract_text(&*self.text_actor()?, page)?;
        let mut cache = lock(&self.text_cache);
        cache.push_front((page, pt.clone()));
        cache.truncate(TEXT_CACHE_PAGES);
        Ok(pt)
    }
}

struct Opened {
    display: Arc<Vec<u8>>,
    config: RenderConfig,
    info: pdfcraft_render::DocInfo,
}

/// Opens through a throwaway engine session and keeps only what reading needs. The session's
/// own render pool is dropped right away; ours are created per theme on demand.
fn open_with_engine(bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<Opened, PdfError> {
    let mut session = pdfcraft_engine::Session::new();
    session.set_javascript(false);
    let prepared = session
        .open_context()
        .prepare_open("documento.pdf", None, bytes, password)
        .map_err(PdfError::from_open)?;
    let id = session.commit_open(prepared);
    let config = session.render_config(id);
    let doc = session.get(id);
    let (Some(config), Some(doc)) = (config, doc) else {
        return Err(PdfError::Internal(
            "opened document vanished from the session".into(),
        ));
    };
    if doc.info.pages.is_empty() {
        return Err(PdfError::Invalid("the document has no pages".into()));
    }
    let opened = Opened {
        display: doc.display.clone(),
        config,
        info: doc.info.clone(),
    };
    session.close(id);
    Ok(opened)
}

/// Extracts through the pool, so a pathological page is cut off by PdfCraft's watchdog
/// (`STUCK_AFTER`) and the wait is bounded by the actor.
fn extract_text(actor: &RenderActor, page: usize) -> Result<Arc<PageText>, PdfError> {
    let out = actor.render(RenderRequest {
        page,
        kind: RequestKind::Text,
        scale: 1.0,
        ..Default::default()
    })?;
    match (&out.error, &out.text) {
        (Some(e), _) => Err(PdfError::Text(e.clone())),
        (None, Some(pt)) => Ok(pt.clone()),
        (None, None) => Err(PdfError::Text("no text layer returned".into())),
    }
}

/// Our themes as PdfCraft reading colours: solid paints remapped, images untouched (no inversion).
pub(crate) fn reading_colors(theme: ReadingTheme) -> ReadingColors {
    let params = |text, background| ReadingColors {
        params: Some(ReadingParams {
            text,
            background,
            only_black: false,
            line_art: true,
        }),
    };
    match theme {
        ReadingTheme::Light => ReadingColors::default(),
        ReadingTheme::Sepia => params([0x5b, 0x46, 0x36], [0xf4, 0xec, 0xd8]),
        ReadingTheme::Dark => params([0xd8, 0xd8, 0xd8], [0x1e, 0x1e, 0x1e]),
    }
}

/// A tile in page points → PdfCraft's tile in device pixels of the whole page at `scale`.
fn tile_pixels(t: Rect, scale: f32, page: &PageInfo) -> Result<Tile, PdfError> {
    let [x, y, w, h] = t;
    let outside = || PdfError::InvalidRequest("bloco fora da página".into());
    if !t.iter().all(|v| v.is_finite()) || w <= 0.0 || h <= 0.0 || x < 0.0 || y < 0.0 {
        return Err(outside());
    }
    let (full_w, full_h) = (
        device_pixels(page.width, scale),
        device_pixels(page.height, scale),
    );
    // Float → int casts saturate, so huge values cannot wrap.
    let (x0, y0) = ((x * scale).floor() as u32, (y * scale).floor() as u32);
    if x0 >= full_w || y0 >= full_h {
        return Err(outside());
    }
    let x1 = (((x + w) * scale).ceil() as u32).min(full_w);
    let y1 = (((y + h) * scale).ceil() as u32).min(full_h);
    let (tw, th) = ((x1 - x0).max(1), (y1 - y0).max(1));
    // PdfCraft would silently crop a larger tile, misaligning it with the text layer.
    if tw > MAX_TILE_SIDE || th > MAX_TILE_SIDE {
        return Err(PdfError::InvalidRequest(format!(
            "bloco grande demais para a escala; máximo {MAX_TILE_SIDE} px por lado"
        )));
    }
    Ok(Tile {
        x: x0,
        y: y0,
        w: tw,
        h: th,
    })
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
        send_sync::<PdfcraftEngine>();
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
    fn tiles_are_converted_to_device_pixels() {
        let p = page(100.0, 200.0);
        assert_eq!(
            tile_pixels([10.0, 20.0, 30.0, 40.0], 2.0, &p).ok(),
            Some(Tile {
                x: 20,
                y: 40,
                w: 60,
                h: 80
            })
        );
        // Clipped at the page edge.
        assert_eq!(
            tile_pixels([90.0, 0.0, 50.0, 10.0], 1.0, &p).ok(),
            Some(Tile {
                x: 90,
                y: 0,
                w: 10,
                h: 10
            })
        );
        // Exactly the limit is fine; one pixel more is refused instead of cropped.
        let big = page(1000.0, 1000.0);
        assert_eq!(
            tile_pixels([0.0, 0.0, 256.0, 10.0], 16.0, &big)
                .map(|t| t.w)
                .ok(),
            Some(MAX_TILE_SIDE)
        );
        for oversized in [[0.0, 0.0, 500.0, 10.0], [0.0, 0.0, 10.0, 410.0]] {
            assert!(
                matches!(
                    tile_pixels(oversized, 10.0, &big),
                    Err(PdfError::InvalidRequest(_))
                ),
                "{oversized:?}"
            );
        }
        for bad in [
            [200.0, 0.0, 1.0, 1.0],
            [-1.0, 0.0, 1.0, 1.0],
            [0.0, 0.0, 0.0, 1.0],
            [f32::NAN, 0.0, 1.0, 1.0],
        ] {
            assert!(
                matches!(tile_pixels(bad, 1.0, &p), Err(PdfError::InvalidRequest(_))),
                "{bad:?}"
            );
        }
    }
}
