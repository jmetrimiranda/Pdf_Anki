//! `core-pdf`: the PDF facade (spec 6.1). The only crate that knows PdfCraft; the rest of the app
//! sees `DocumentEngine` and the plain types below.
//!
//! Coordinates are always view space: points, origin at the top-left of the page as displayed,
//! y down, with `/Rotate` and the crop box applied. Rects are `[x, y, w, h]`.

mod actor;
mod cache;
mod encode;
mod engine;
mod error;
mod types;
mod words;

use std::sync::Arc;

pub use cache::DEFAULT_PAGE_CACHE_BYTES;
pub use encode::encode_rgba as encode_png;
pub use engine::PdfcraftEngine;
pub use error::PdfError;
pub use types::{
    Annotation, DocHandle, DocInfo, MAX_SCALE, MAX_TILE_SIDE, OcrWord, OutlineItem, PageSize,
    PageWord, PageWords, ReadingTheme, Rect, RenderReq, Rendered, SearchHit, SearchOpts,
};

/// A PDF backend. Implementations are shared between threads; every method may block (run them
/// off the async runtime) and none panics on untrusted input.
pub trait DocumentEngine: Send + Sync {
    /// Opens a document. `password` is the user or owner password.
    fn open(&self, bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<DocHandle, PdfError>;
    /// Releases a document and its threads. Unknown handles are ignored.
    fn close(&self, doc: DocHandle);
    /// Page count, page sizes, title and author.
    fn info(&self, doc: DocHandle) -> Result<DocInfo, PdfError>;
    /// The bookmarks, with 0-based pages.
    fn outline(&self, doc: DocHandle) -> Result<Vec<OutlineItem>, PdfError>;
    /// Rasterises a page or a tile of it.
    fn render(&self, doc: DocHandle, req: RenderReq) -> Result<Rendered, PdfError>;
    /// The page text segmented into words (UAX #29) with their rects.
    fn page_words(&self, doc: DocHandle, page: usize) -> Result<PageWords, PdfError>;
    /// Finds `query` in every page, in page order.
    fn search(
        &self,
        doc: DocHandle,
        query: &str,
        opts: SearchOpts,
    ) -> Result<Vec<SearchHit>, PdfError>;
    /// A copy of the file with `notes` written as PDF annotations (spec 6.5).
    fn export_annotated(&self, doc: DocHandle, notes: &[Annotation]) -> Result<Vec<u8>, PdfError>;
    /// Recognises the words of a scanned page (spec 7.2).
    fn ocr_page(&self, doc: DocHandle, page: usize) -> Result<Vec<OcrWord>, PdfError>;

    /// `render` encoded as PNG (the `pdf://` protocol response).
    fn render_png(&self, doc: DocHandle, req: RenderReq) -> Result<Vec<u8>, PdfError> {
        self.render(doc, req)?.to_png()
    }
}
