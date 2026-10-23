//! Whole-book text for vocabulary scanning (docs/PROJETO.md 12.3 B, F) and the text fingerprint of a file version.
//!
//! [`extract_book_text`] reads every page's text through the same PdfCraft path as [`crate::PdfCore::page_words`]
//! (a `RequestKind::Text` request of a `RenderPool`, the text being `PageText::plain_text`), so the per-page lemma
//! table and the marks drawn from `page_words` agree. It owns a private pool with several workers (one shared
//! parser, PdfCraft's watchdog per page) and never touches the open documents or their text caches.
//!
//! [`text_fingerprint`] hashes what the text comes from — the decoded content streams of every page — and not the
//! annotations, so saving a version that only adds comments or bookmarks (PdfCraft's autosave, spec 6.5) keeps the
//! cached lemma table, while a change of the page content (or an OCR text layer, Phase 7) invalidates it.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use pdfcraft_cos::{Document, Object};
use pdfcraft_render::{RenderConfig, RenderPool, RenderRequest, RenderedPage, RequestKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::PdfError;
use crate::core::inspect_with_password;
use crate::error::guard;

/// Most worker threads [`ExtractOptions::default`] picks.
pub const MAX_EXTRACT_THREADS: usize = 4;
/// How often the extraction polls the pool.
const POLL: Duration = Duration::from_millis(2);
/// The pool's watchdog gives up on a page after 20 s; this only guards against a lost result.
const STALL: Duration = Duration::from_secs(60);
/// Requests listed at once per worker (the pool keeps at most 32 finished results).
const WINDOW_PER_THREAD: usize = 4;
/// Largest decoded content stream hashed as decoded; bigger (or undecodable) ones are hashed raw.
const MAX_CONTENT_BYTES: usize = 256 << 20;

/// What [`extract_book_text`] reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractOptions {
    /// 0-based pages to read (sorted and deduplicated; pages past the end are ignored). `None` = every page.
    pub pages: Option<Vec<usize>>,
    /// Worker threads (at least 1).
    pub threads: usize,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            pages: None,
            threads: std::thread::available_parallelism()
                .map_or(2, |n| n.get())
                .clamp(1, MAX_EXTRACT_THREADS),
        }
    }
}

/// The text of one page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    /// 0-based.
    pub page: usize,
    /// The page text as `page_words` reconstructs it (`' '` between words, `'\n'` between lines). Empty when the
    /// page could not be read.
    pub text: String,
    /// `false` when the page's text could not be read (damaged content, watchdog): the rest of the book is still
    /// read.
    pub ok: bool,
}

/// The text of the book's pages in reading order, read in parallel. `password` is the user or owner password.
/// `on_page(done, total)` is called after each page. Setting `cancel` stops the work and returns
/// [`PdfError::Cancelled`]. A page that fails gives `ok: false` and an empty text; only a document that can't be
/// opened is an error. Never panics.
pub fn extract_book_text(
    bytes: Arc<Vec<u8>>,
    password: Option<&str>,
    opts: ExtractOptions,
    cancel: &AtomicBool,
    on_page: &mut dyn FnMut(usize, usize),
) -> Result<Vec<PageText>, PdfError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(PdfError::Cancelled);
    }
    let opened = guard(|| inspect_with_password(bytes.clone(), password))?;
    let count = opened.info.pages.len();
    let mut wanted: Vec<usize> = match opts.pages {
        Some(pages) => pages.into_iter().filter(|&p| p < count).collect(),
        None => (0..count).collect(),
    };
    wanted.sort_unstable();
    wanted.dedup();
    let total = wanted.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let config = RenderConfig {
        password: opened.render_password.map(Arc::from),
        ..RenderConfig::default()
    };
    let threads = opts.threads.max(1);
    guard(|| run_pool(bytes, config, threads, &wanted, cancel, on_page))
}

fn text_request(page: usize) -> RenderRequest {
    RenderRequest {
        page,
        kind: RequestKind::Text,
        scale: 1.0,
        ..Default::default()
    }
}

fn run_pool(
    bytes: Arc<Vec<u8>>,
    config: RenderConfig,
    threads: usize,
    wanted: &[usize],
    cancel: &AtomicBool,
    on_page: &mut dyn FnMut(usize, usize),
) -> Result<Vec<PageText>, PdfError> {
    let total = wanted.len();
    let pool = RenderPool::new(bytes, threads, config);
    let window = threads.saturating_mul(WINDOW_PER_THREAD).clamp(1, 32);
    // Position of each wanted page in the output.
    let slot: HashMap<usize, usize> = wanted.iter().enumerate().map(|(i, &p)| (p, i)).collect();
    let mut out: Vec<Option<PageText>> = vec![None; total];
    let mut next = 0usize;
    let mut outstanding: Vec<usize> = Vec::with_capacity(window);
    let mut done = 0usize;
    let mut last_progress = Instant::now();
    while done < total {
        if cancel.load(Ordering::Relaxed) {
            // Dropping the pool stops its workers at their next content operator.
            return Err(PdfError::Cancelled);
        }
        let mut changed = false;
        while outstanding.len() < window && next < total {
            outstanding.push(wanted[next]);
            next += 1;
            changed = true;
        }
        if changed {
            pool.set_queue(outstanding.iter().map(|&p| text_request(p)).collect());
        }
        let mut received = false;
        while let Some(result) = pool.try_recv() {
            let page = result.request.page;
            let Some(&i) = slot.get(&page) else { continue };
            if out[i].is_some() || result.request.kind != RequestKind::Text {
                continue;
            }
            out[i] = Some(page_text_of(&result));
            outstanding.retain(|&p| p != page);
            done += 1;
            received = true;
            on_page(done, total);
        }
        if received {
            last_progress = Instant::now();
            pool.set_queue(outstanding.iter().map(|&p| text_request(p)).collect());
        } else if last_progress.elapsed() > STALL {
            // A lost result: give up on what is outstanding, keep going with the rest.
            for page in std::mem::take(&mut outstanding) {
                if let Some(&i) = slot.get(&page) {
                    tracing::warn!(page, "book text: no result from the pool");
                    out[i] = Some(PageText {
                        page,
                        text: String::new(),
                        ok: false,
                    });
                    done += 1;
                    on_page(done, total);
                }
            }
            last_progress = Instant::now();
            pool.set_queue(Vec::new());
        } else {
            std::thread::sleep(POLL);
        }
    }
    Ok(out
        .into_iter()
        .zip(wanted)
        .map(|(t, &page)| {
            t.unwrap_or(PageText {
                page,
                text: String::new(),
                ok: false,
            })
        })
        .collect())
}

/// The text of a finished text request; a failed one (error or no text layer) is `ok: false` with no text.
fn page_text_of(result: &RenderedPage) -> PageText {
    let page = result.request.page;
    match (&result.error, &result.text) {
        (None, Some(pt)) => PageText {
            page,
            text: pt.plain_text(),
            ok: true,
        },
        (error, _) => {
            tracing::warn!(page, ?error, "book text: page skipped");
            PageText {
                page,
                text: String::new(),
                ok: false,
            }
        }
    }
}

/// A hex sha256 of the page count and each page's decoded content streams, in page order (not `/Annots`, not
/// the Info dictionary, not the outline). `password` is the user or owner password. Never panics.
pub fn text_fingerprint(bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<String, PdfError> {
    guard(|| {
        let doc = Document::open_with_password(bytes, password).map_err(PdfError::from_cos)?;
        let pages = pdfcraft_organize::pages(&doc)
            .map_err(|e| PdfError::Invalid(format!("page tree: {e}")))?;
        if pages.is_empty() {
            return Err(PdfError::Invalid("the document has no pages".into()));
        }
        let mut hasher = Sha256::new();
        hasher.update(b"leitor-text-fingerprint-v1\0");
        hasher.update((pages.len() as u64).to_le_bytes());
        for page in &pages {
            let obj = doc.get(page.obj);
            let contents = obj.as_dict().and_then(|d| d.get(b"Contents")).cloned();
            let streams: Vec<Object> = match contents.map(|c| doc.resolve(&c)) {
                Some(c) => match c.as_ref() {
                    Object::Array(items) => {
                        items.iter().map(|o| (*doc.resolve(o)).clone()).collect()
                    }
                    other => vec![other.clone()],
                },
                None => Vec::new(),
            };
            hasher.update(b"\0page");
            hasher.update((streams.len() as u64).to_le_bytes());
            for stream in &streams {
                match stream {
                    Object::Stream(s) => {
                        let (tag, data): (&[u8], Vec<u8>) =
                            match s.decoded_within(MAX_CONTENT_BYTES) {
                                Ok(data) => (b"d", data),
                                Err(_) => (b"r", s.raw.to_vec()),
                            };
                        hasher.update(tag);
                        hasher.update((data.len() as u64).to_le_bytes());
                        hasher.update(&data);
                    }
                    _ => hasher.update(b"n"),
                }
            }
        }
        Ok(hex_lower(&hasher.finalize()))
    })
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(page: usize, error: Option<&str>, text: Option<&str>) -> RenderedPage {
        let text = text.map(|t| {
            let mut pt = pdfcraft_render::PageText::default();
            for (i, c) in t.chars().enumerate() {
                pt.glyphs.push(pdfcraft_render::TextGlyph {
                    text: c.to_string(),
                    rect: [i as f32, 0.0, i as f32 + 1.0, 1.0],
                    quad: [[0.0; 2]; 4],
                    direction: [1.0, 0.0],
                });
                pt.line_of.push(0);
                pt.space_before.push(false);
            }
            Arc::new(pt)
        });
        RenderedPage {
            request: text_request(page),
            width: 0,
            height: 0,
            rgba: Default::default(),
            error: error.map(str::to_owned),
            text,
            warnings: Vec::new(),
            millis: 0,
        }
    }

    #[test]
    fn failed_pages_are_empty_and_not_ok() {
        assert_eq!(
            page_text_of(&finished(3, None, Some("abc"))),
            PageText {
                page: 3,
                text: "abc".into(),
                ok: true
            }
        );
        for bad in [
            finished(4, Some("text extraction crashed on page 5"), None),
            finished(4, None, None),
            finished(4, Some("watchdog"), Some("partial")),
        ] {
            assert_eq!(
                page_text_of(&bad),
                PageText {
                    page: 4,
                    text: String::new(),
                    ok: false
                }
            );
        }
    }

    #[test]
    fn default_threads_are_bounded() {
        let t = ExtractOptions::default().threads;
        assert!((1..=MAX_EXTRACT_THREADS).contains(&t), "{t}");
    }

    #[test]
    fn hex_is_lowercase() {
        assert_eq!(hex_lower(&[0, 0xab, 0x1f]), "00ab1f");
    }
}
