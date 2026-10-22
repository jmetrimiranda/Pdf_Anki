# PdfCraft API reference for `core-pdf` (rendering, text, links, export)

Source: `third_party/pdfcraft` at commit `3e968c8a` (workspace version 0.11.0, edition 2024, MSRV 1.95).
All paths below are relative to `third_party/pdfcraft/`. Signatures are copied from that source.
Spec sections covered: PROJETO.md 6.1–6.5 and 7.2.

Thread-safety notes: no `cargo` was available on the host when this was written, so the Send/Sync
claims were not checked by a compiler. Each one says where it comes from: a compile-time assertion
in PdfCraft's own tests, or reading the fields. Add `static_assertions` checks to `core-pdf` (see §11).

---

## 0. Crate map (what matters to us)

| Crate | Role for us | Heavy deps |
|---|---|---|
| `pdfcraft-render` (`crates/render`) | rasterize pages (`PageRenderer`, `RenderPool`), text layer (`PageText`), `inspect` (page sizes, outline, links, Info metadata), `OpenError` | hayro (vendored, patched), lopdf (vendored), kurbo |
| `pdfcraft-cos` (`crates/cos`) | PDF object graph: open with a password, copy-on-write edits, `write_incremental` / `write_full` | pdfcraft-crypt, pdfcraft-filters, chrono |
| `pdfcraft-annot` (`crates/annot`) | build annotations (`add_annotation`) and their appearance streams; link annotations | cos, fonts, model |
| `pdfcraft-model` (`crates/model`) | typed page tree: `Page::crop/rotation/view_matrix` | cos |
| `pdfcraft-organize` (`crates/organize`) | `set_info` / `info` / `custom_info` (Info dictionary), bookmark paging | cos, content |
| `pdfcraft-ocr` (`crates/ocr`) | ocrs recogniser (§7.2) | ocrs, rten |
| `pdfcraft-engine` (`crates/engine`) | façade: `Session` holds open `Document`s (cos graph, `DocInfo`, a `RenderPool`, undo, saves); `Edit` enum | **everything**: sign (aws-lc-rs, rustls-cng), js (boa_engine), xfa, forms, print (craft-print git), craft-docpath (git), image, png, tiff, chrono… |

Important: the engine does **not** re-export `pdfcraft_render` (types such as `RenderRequest`,
`PageText`, `OpenError`, `ReadingColors` are not reachable through it). `core-pdf` must depend on
`pdfcraft-render` directly as well. Our `src-tauri/Cargo.toml` already does this.

**Patched dependencies.** The renderer relies on PdfCraft's patched hayro: the `ColorReplacement`
reading colours, `preview`, `hide_comments`, `warning_sink` and cancellation support. A `[patch]`
section only applies at the workspace root. `src-tauri/Cargo.toml` already repeats
`[patch.crates-io]` for hayro, hayro-interpret, hayro-syntax, hayro-cmap, hayro-jbig2, lopdf and
vello_common (`Cargo.toml:112-122` upstream). If this section ever drifts from upstream, rendering
silently loses those features or fails to compile. Re-copy it whenever the submodule moves.

---

## 1. Opening a document, passwords, errors

### 1.1 `pdfcraft_render::OpenError` — `crates/render/src/lib.rs:33`
```rust
#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("the file is not a readable PDF: {0}")] Invalid(String),
    #[error("the document is protected by a password")] NeedsPassword,
    #[error("the password is incorrect")] WrongPassword,
    #[error("{0}")] Unsupported(String),   // e.g. "encryption not supported: …"
}
```
Not `Clone` and not `PartialEq`. Map it to our own `OpenError`.

### 1.2 `pdfcraft_render::inspect` — `crates/render/src/inspect.rs:515`
```rust
pub fn inspect(bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<DocInfo, OpenError>
```
- This is the only render-level call that reports password errors. When hayro returns
  `Decryption(PasswordProtected)`, the result is `NeedsPassword` if `password` is `None` and
  `WrongPassword` otherwise (`inspect.rs:516-527`).
- It never panics (it uses `catch_unwind`). It fails with `Invalid("the document has no pages")` for a page-less file.
- Page geometry comes from hayro. Outline, links, annotations, Info and labels come from a lazy COS reader, with lopdf as the fallback. If structure reading fails, it does **not** fail the open. Instead the outline, links and other panels are empty and `DocInfo.warnings` says why (`inspect.rs:610-627`).
- Cost: it walks every page and every `/Annots`. That takes seconds on very large files, so run it off the UI thread.
- The hayro renderer accepts only the **user** password of R2–R4 files. For the owner password, use the user password recovered through cos (see 1.4).

### 1.3 `pdfcraft_cos::Document::open_with_password` — `crates/cos/src/document.rs:577`
```rust
pub fn open(data: Arc<Vec<u8>>) -> Result<Self, CosError>                       // :571
pub fn open_with_password(data: Arc<Vec<u8>>, password: Option<&str>) -> Result<Self, CosError>
```
It accepts the owner or the user password. `CosError` (`crates/cos/src/lib.rs:31`) includes `NotPdf`,
`Syntax{offset,detail}`, `NeedsPassword`, `WrongPassword`, `Security(String)`, `ReadOnlyLimit` and others.
`CosError` is `Clone + PartialEq`.

### 1.4 Owner password → renderer password (R2–R4)
The engine provides this helper (`crates/engine/src/lib.rs:972`):
```rust
pub fn render_password_for(bytes: Arc<Vec<u8>>, password: Option<&str>) -> Option<String>
```
Without the engine, do the same thing by hand. Open with cos, then call
`doc.security().and_then(|s| s.recovered_user_password())` (`crates/crypt/src/lib.rs:202`, returns
`Option<Vec<u8>>`). Convert the bytes to a `String`: UTF-8 if valid, otherwise map each byte through
`pdfcraft_cos::pdfdoc_char` (the engine's private `renderer_password`, `engine/src/lib.rs:2897`).

### 1.5 Engine open — `crates/engine/src/lib.rs`
```rust
pub struct DocId(pub u64);                                                        // :230 (Copy, Hash)
impl Session {
  pub fn new() -> Self                                                            // :3372
  pub fn open_context(&self) -> OpenContext                                       // :3453 (Clone)
  pub fn prepare_open(&self, name: impl Into<String>, path: Option<String>,
                      bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<PreparedDocument, OpenError> // :3458
  pub fn commit_open(&mut self, prepared: PreparedDocument) -> DocId              // :3469
  pub fn open(&mut self, name: impl Into<String>, path: Option<String>,
              bytes: Arc<Vec<u8>>, password: Option<&str>) -> Result<DocId, OpenError> // :3479
  pub fn get(&self, id: DocId) -> Option<&Document>                               // :5133
  pub fn close(&mut self, id: DocId)                                              // :5129
  pub fn set_javascript(&mut self, on: bool)                                      // js.rs:203
}
impl OpenContext {
  pub fn prepare_open(&self, name, path, bytes, password) -> Result<PreparedDocument, OpenError> // :3067
}
```
What `prepare_open` does (`:3483-3620`, `build_document` `:3624`):
- It runs cos open, then `inspect`, retrying with the recovered user password on `WrongPassword`.
- It lays out dynamic XFA forms and runs their scripts with boa (unless `set_javascript(false)`).
- It recovers a missing page tree.
- It validates signatures.
- It builds the `display` bytes (missing comment and field appearances drawn, in memory only).
- **It always spawns a `RenderPool`** with `render_threads()` = `clamp(available_parallelism, 2, 8) - 1` threads (`:1052`). Every open document therefore costs 1–7 idle threads until `close`.

`pub struct Document` (`:391`) has these public fields: `id`, `name`, `path`, `bytes` (working file),
`display` (what is rendered), `info: DocInfo`, `renderer: RenderPool`, `password: Option<String>`
(already the **render** password), `dirty` and `read_only_reason`. The `RenderConfig` is private.
Read it with `Session::render_config(id) -> Option<RenderConfig>` (`:5017`).

**Pattern for a Tauri app:** call `prepare_open` (through an `OpenContext` clone) on a blocking
worker **without** holding the session lock. Then lock and call `commit_open`. The engine's own
test asserts `PreparedDocument: Send` (`crates/engine/src/tests.rs:41-42`).

---

## 2. Document info: page count, sizes, rotation, crop, metadata

### 2.1 `DocInfo` — `crates/render/src/inspect.rs:56` (Clone, Default)
```rust
pub struct DocInfo {
    pub title, author, subject, keywords, creator, producer: Option<String>,
    pub custom: Vec<(String, String)>,   // non-standard /Info text entries, max 256  ← LeitorBookUid is read here
    pub pdf_version: String, pub file_size: usize, pub encrypted: bool, pub tagged: bool,
    pub has_javascript: bool, pub xfa: Option<Xfa>,
    pub pages: Vec<PageInfo>,
    pub outline: Vec<OutlineItem>, pub outline_more: bool,
    pub annotations: Vec<Annotation>, pub fields: Vec<Field>, pub links: Vec<Link>,
    pub layers: Vec<Layer>, pub layer_groups: Vec<Vec<(u32, u16)>>, pub fonts: Vec<FontInfo>,
    pub attachments: Vec<Attachment>, pub transitions: Vec<PageTransition>,
    pub warnings: Vec<String>,
}
```
Page count = `info.pages.len()`. `PageRenderer::page_count()` also exists, but it returns 0 when
parsing fails or the password is wrong (see §3.4).

### 2.2 `PageInfo` — `inspect.rs:186` (Clone)
```rust
pub struct PageInfo {
    pub width: f32, pub height: f32,   // displayed size in points, after /Rotate and /UserUnit
    pub label: String,                 // /PageLabels or "1","2",…
    pub crop: [f32; 4],                // effective crop box (clipped to media), USER space
    pub rotation: u16,                 // 0/90/180/270 clockwise
}
impl PageInfo {
    pub fn view_to_user(&self, x: f32, y: f32) -> [f32; 2]                         // :201
    pub fn user_to_view(&self, x: f32, y: f32) -> [f32; 2]                         // :214
    pub fn xyz_for_view(&self, x: Option<f32>, y: Option<f32>) -> [Option<f32>; 2] // :232
    pub fn dest_fraction(&self, x: Option<f32>, y: Option<f32>, view_rotation: u16) -> [Option<f32>; 2] // :244
    pub fn view_rect_to_user(&self, r: [f32; 4]) -> [f32; 4]                       // :262
    pub fn view_rect_to_quad(&self, r: [f32; 4]) -> [f64; 8]                       // :269
}
```
**View space** means points, origin at the top-left of the page **as displayed**, y pointing down, with
`/Rotate` and crop already applied. This is the space of `TextGlyph.rect`, of tiles at scale 1, and of
our stored annotation quads. `view_to_user` maps through fractions of `width`/`height` onto `crop`, so it
also accounts for `/UserUnit` correctly. These functions are the canonical "undo rotation and crop"
conversion. Do not write our own.

An alternative at the model level is `pdfcraft_model::Page::{crop, rotation, display_size, view_matrix}`
(`crates/model/src/lib.rs:31-77`). It works on a `cos::Document`, and its display space has **y up**.
Do not mix the two conventions.

### 2.3 Metadata through the engine
`Document::info_value(&self, key: &str) -> Option<String>` (`engine/src/lib.rs:869`) and
`Document::custom_info(&self) -> Vec<(String,String)>` (`:874`) read the live cos graph. `DocInfo.custom`
holds the same data as of open time.

---

## 3. Rendering

### 3.1 `RenderConfig` — `crates/render/src/raster.rs:57` (Clone, Debug, Default)
```rust
pub struct RenderConfig {
    pub password: Option<Arc<str>>,             // the RENDER (user) password, see 1.4
    pub layers: Arc<Vec<(i32, i32, bool)>>,     // OCG overrides
    pub hide_comments: bool,
    pub reject_oversize: bool,                  // error instead of silently down-scaling whole pages
    pub reading_colors: ReadingColors,          // §4
    pub transparent: bool,                      // clear to transparent (overlay rasters)
}
```
The config applies to the whole document. One `PageRenderer` or `RenderPool` = one config. Changing the
theme means building another renderer or pool. The engine itself does that in `Session::set_reading_colors`
(`engine/src/lib.rs:4999`): it **replaces** `doc.renderer` with a fresh `RenderPool`.

### 3.2 `RenderRequest`, `Tile`, `RequestKind` — `raster.rs:142-176`
```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum RequestKind { #[default] Pixels, Text /* scale ignored */ }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Tile { pub x: u32, pub y: u32, pub w: u32, pub h: u32 }   // DEVICE PIXELS of the page at `scale`

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct RenderRequest {
    pub page: usize,            // 0-based
    pub kind: RequestKind,
    pub tile: Option<Tile>,     // None = whole page
    pub scale: f32,             // device pixels per PDF point (multiply by devicePixelRatio yourself)
    pub tag: u64,               // echoed back; caller-defined
    pub preview: bool,          // low detail: tiny images skipped. Thumbnails only.
}
pub const PRINT_TAG: u64 = 1 << 60;   // :178 — a tag with this bit renders with reading colours OFF
pub const MAX_SIDE: f32 = 8192.0;     // :136
pub const MAX_PIXELS: f32 = 64.0e6;   // :138
pub fn effective_scale(width_pt: f32, height_pt: f32, scale: f32) -> f32   // :282
pub fn device_pixels(pt: f32, scale: f32) -> u32                           // :296 (ceil, ≥1)
```
Gotchas (from `render_page`, `raster.rs:306-400`):
- **Whole page**: the scale is clamped by `effective_scale` (at most 8192 px per side and 64 MP). The output
  size is `device_pixels(w_pt, s) × device_pixels(h_pt, s)` with the *clamped* `s`. When the scale is
  clamped, the result is smaller than asked and no error is reported, unless `reject_oversize` is set.
  **Always use `RenderedPage.width/height`** and never assume the requested size.
- **Tile**: the scale is clamped to `0.01..=400`, `w`/`h` to `1..=4096`, and `x`/`y` are offsets in device
  pixels of the full page at `scale`. Tiles are not limited by `MAX_SIDE`, which is why they are the way
  to zoom deep. The page's full pixel size at a given scale is
  `device_pixels(info.width, scale) × device_pixels(info.height, scale)`. Our URL `bloco=x,y,w,h`
  should use these same units.
- `preview: true` skips images that cover only a few device pixels. Never use it for final renders.
- Do not set bit 60 in our own tags.

### 3.3 `RenderedPage` — `raster.rs:203`
```rust
#[derive(Debug)]
pub struct RenderedPage {
    pub request: RenderRequest,
    pub width: u32, pub height: u32,
    pub rgba: Pixels,                         // PREMULTIPLIED RGBA8, row-major; empty on error
    pub error: Option<String>,                // per-page failure (panic, empty box, too large, watchdog)
    pub text: Option<Arc<PageText>>,          // for RequestKind::Text
    pub warnings: Vec<RenderWarning>,         // RenderWarning::ContentTruncated
    pub millis: u32,                          // render time only (not queue wait); 0 on wasm
}
```
`Pixels` (`crates/render/src/pixels.rs:10`) wraps `Vec<u32>`. It implements `Deref<Target=[u8]>` and
`AsRef<[u8]>`, and has `into_words(self) -> Vec<u32>`. The data is premultiplied. With the default
(non-`transparent`) config every pixel is opaque, so it can go to PNG or `ImageData` as is. If
`transparent` is set, un-premultiply before encoding PNG.

### 3.4 `PageRenderer` — single-threaded, synchronous — `raster.rs:422`
```rust
pub struct PageRenderer { /* bytes, config, Option<hayro Pdf>, settings, stats */ }
impl PageRenderer {
    pub fn new(bytes: Arc<Vec<u8>>, config: RenderConfig) -> Self                  // :431
    pub fn page_count(&self) -> usize                                              // :437 (0 if unparsable / bad password)
    pub fn stats(&self) -> RenderStats                                             // :442
    pub fn filtered_text(&mut self, page: usize, filter: TextFilter) -> Result<PageText, String> // :447
    pub fn render(&mut self, req: RenderRequest) -> RenderedPage                   // :455 never panics
}
```
- `new` parses eagerly, but a parse failure or wrong password gives no error: `page_count()` is 0 and
  every `render` returns `error = Some("the document could not be parsed")`. Validate with `inspect` first.
- After a renderer panic it re-parses the document (`:486-489`).
- Use it for sequential jobs on a background thread: document-wide search (§5.5), text for vocabulary
  scanning, cover thumbnails at import, and OCR. The engine's `Exporter` and `OcrJob` follow the same
  pattern (`engine/src/export.rs:107`, `engine/src/ocr.rs:107`).

Usage:
```rust
let mut r = PageRenderer::new(bytes.clone(), RenderConfig { password: pw.map(Arc::from), ..Default::default() });
let out = r.render(RenderRequest { page: 0, scale: 2.0, ..Default::default() });
if let Some(e) = out.error { /* show placeholder */ }
let text = r.render(RenderRequest { page: 0, kind: RequestKind::Text, scale: 1.0, ..Default::default() }).text; // Option<Arc<PageText>>
```

### 3.5 `RenderPool` — multi-threaded, poll-based — `raster.rs:724`
```rust
impl RenderPool {
    pub fn new(bytes: Arc<Vec<u8>>, threads: usize, config: RenderConfig) -> Self   // :741 (threads.max(1))
    pub fn new_inline(bytes: Arc<Vec<u8>>, config: RenderConfig) -> Self             // :802 renders inside try_recv
    pub fn is_inline(&self) -> bool                                                  // :807
    pub fn stats(&self) -> RenderStats                                               // :812
    pub fn set_stuck_after(&mut self, limit: Duration)                               // :817 (default STUCK_AFTER = 20 s, :495)
    pub fn set_queue(&self, requests: Vec<RenderRequest>)                            // :828
    pub fn try_recv(&self) -> Option<RenderedPage>                                   // :845
    pub fn without_replacements(self) -> Self                                        // :967
    pub fn threads(&self) -> usize                                                   // :973
    pub fn retire(self) -> Retiring                                                  // :979
}
```
Semantics:
- **`set_queue` replaces the entire set of wanted work.** Order matters: put the most urgent first.
  In-flight renders that are no longer listed are cancelled at their next content operator, and
  their results are dropped. Contract (`:822-827`): *"a result is delivered only while its request is
  in the latest queue. A caller still waiting for a page … must keep listing it in every call."*
- Requests are deduplicated on `(page, kind, tile, scale bits, tag, preview)` (`raster/work_queue.rs:16-29`).
- **There is no blocking receive in the public API.** `recv_timeout` exists but is `pub(super)`
  (`work_queue.rs:283`). Consumers must poll `try_recv`, and each call also runs the watchdog.
- Completed results that have not been collected are capped at 32 results and 32 MB
  (`work_queue.rs:12-13`). Workers block when that budget is full, so drain the results promptly.
- One parser is shared between workers. Caches are per worker. A panic or timeout retires the shared
  parser, and later work uses one private parser per worker (more memory). After the watchdog fires,
  the page fails with "…took longer than 20 s and was skipped…". At most `threads` replacement workers
  are spawned. Once they are all used up, every request fails with "all render workers exceeded their
  time limits; close and reopen the document…".
- `Drop` signals the workers to stop but does not join them. Use `retire()` if you need to count
  threads that are still alive.

**Recommended wrapper ("render actor", one per document and theme):** a dedicated thread owns the pool.
It receives `RenderJob { req, reply: oneshot::Sender<RenderedPage> }` over a channel, keeps a
`HashMap<Key, Vec<Sender>>` of outstanding jobs, calls `set_queue(outstanding sorted by priority)`
whenever that set changes, and polls `try_recv()` every 2–4 ms while anything is outstanding (it blocks
on the channel when idle). When the frontend virtualises a page away, it drops the request (an HTTP
abort), and the actor removes it from the queue, so PdfCraft cancels the work.
```rust
loop {
    let msg = if pending.is_empty() { rx.recv().ok() } else { rx.recv_timeout(Duration::from_millis(3)).ok() };
    if let Some(m) = msg { apply(m, &mut pending); pool.set_queue(prioritised(&pending)); }
    while let Some(done) = pool.try_recv() {
        if let Some(waiters) = pending.remove(&key(done.request)) { /* send to waiters (Arc it if >1) */ }
        pool.set_queue(prioritised(&pending));
    }
}
```

### 3.6 Thread-safety (rendering)
| Type | Send | Sync | Basis |
|---|---|---|---|
| `RenderConfig`, `RenderRequest`, `Tile`, `ReadingColors` | yes | yes | plain data / `Arc` fields |
| `RenderedPage`, `Pixels`, `PageText`, `TextGlyph`, `DocInfo`, `PageInfo` | yes | yes | plain data, `Arc<PageText>` |
| `PageRenderer` | **yes** | not relied on (`render` is `&mut self`) | `RenderPool` holds `Option<RefCell<PageRenderer>>`, and `engine::Document` (which holds a `RenderPool`) is asserted `Send` by `tests.rs:41` |
| `RenderPool` | **yes** | **no** (`RefCell` field `inline`, `raster.rs:737`) | same assertion; `RefCell<T>: !Sync` |
| hayro `Pdf` | yes | yes | shared as `Arc<Pdf>` across workers |
| hayro `RenderCache` | no (`Rc<RefCell>`, `vendor/hayro/src/lib.rs:84`) | no | internal only, created per render |

`RenderPool` takes `&self` for `set_queue` and `try_recv`, but because it is `!Sync` it cannot be shared
through an `Arc` across threads. Own it on one thread (the actor above), or put it behind a `Mutex`.

---

## 4. Reading colours (sepia / dark without inversion) — `crates/render/src/reading.rs`

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadingColors { pub params: Option<ReadingParams> }   // None = off (true colours)   :8
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadingParams {                                                                      // :15
    pub text: [u8; 3],        // sRGB that dark paints move towards
    pub background: [u8; 3],  // sRGB that light paints move towards; also the page clear colour
    pub only_black: bool,     // only paints with luminance <= 10% are mapped
    pub line_art: bool,       // map path paints too (not just glyphs)
}
impl ReadingColors {
    pub const BLACK_ON_WHITE / WHITE_ON_BLACK / YELLOW_ON_BLACK / GREEN_ON_BLACK: Self;        // :27-37
    pub fn parse(mode: &str, text: Option<&str>, background: Option<&str>,
                 only_black: Option<bool>, line_art: Option<bool>) -> Result<Self, String>     // :43
    pub fn mode_name(&self) -> &'static str; pub fn text_hex(&self) -> Option<String>; pub fn background_hex(&self) -> Option<String>;
}
```
How it works (`vendor/hayro/src/lib.rs:89-120`, a PdfCraft patch): **solid** paints are mapped by luminance
between `text` and `background`. Images, shadings and patterns are **never** mapped. This gives a dark theme
in which photos and figures keep their real colours, which is exactly the spec's "no inversion". The page
background is cleared to `background`. Print previews (`PRINT_TAG`) ignore the setting.

Our three themes:
```rust
let claro  = ReadingColors::default();                                     // true colours
let sepia  = ReadingColors { params: Some(ReadingParams { text: [0x5b,0x46,0x36], background: [0xf4,0xec,0xd8], only_black: false, line_art: true }) };
let escuro = ReadingColors { params: Some(ReadingParams { text: [0xd8,0xd8,0xd8], background: [0x1e,0x1e,0x1e], only_black: false, line_art: true }) };
let cfg = RenderConfig { reading_colors: escuro, ..base_cfg.clone() };
```
Gotchas:
- Light-coloured filled boxes (callouts, table shading) also move towards `background`. That is usually
  desirable. Coloured text is mapped by luminance, so its hue is lost unless `only_black: true`.
- Because the theme lives in `RenderConfig`, keep a pool per (doc, theme) or rebuild the pool on a theme
  change. Parsing is lazy and cheap compared with rendering, but the per-worker caches start empty again.
- **Include the theme in our raster cache key.**

---

## 5. Text layer

### 5.1 Getting it
- Pool: `RenderRequest { kind: RequestKind::Text, scale: 1.0, .. }` → `RenderedPage.text: Option<Arc<PageText>>`.
- Synchronous: `PageRenderer::render` with the same request, or
  `PageRenderer::filtered_text(page, TextFilter) -> Result<PageText, String>` (`raster.rs:447`).

The text is extracted with the same initial transform as rendering (`text.rs:721`,
`p.initial_transform(true)`), so it lines up with the raster. **Annotation appearances are included**
(`text.rs:718-719`): form-field values and drawn comment text appear in the text. Reading colours do not
affect text.

### 5.2 `TextGlyph` — `crates/render/src/text.rs:59` (Clone, Debug, PartialEq)
```rust
pub struct TextGlyph {
    pub text: String,            // ONE char, or several for a ligature ("fi") — may also be " " or empty-ish
    pub rect: [f32; 4],          // VIEW space bbox [x0,y0,x1,y1], points, y down
    pub quad: [[f32; 2]; 4],     // em box as drawn: quad[0]→quad[1] = writing direction, then opposite edge
    pub direction: [f32; 2],     // unit writing direction in view space ([1,0] = LTR horizontal)
}
```

### 5.3 `PageText` — `text.rs:94` (Clone, Debug, Default, PartialEq)
```rust
pub struct PageText {
    pub glyphs: Vec<TextGlyph>,   // reading order (columns left→right, RTL runs reversed to logical)
    pub line_of: Vec<u32>,        // line index per glyph, lines in reading order
    pub space_before: Vec<bool>,  // word break before glyph i on the same line
}
impl PageText {
    pub fn is_empty(&self) -> bool                                                         // :103
    pub fn text_of(&self, range: Range<usize>) -> String                                   // :108  ' ' for word gaps, '\n' for line changes
    pub fn plain_text(&self) -> String                                                     // :126  = text_of(0..len)
    pub fn find(&self, needle: &str) -> Vec<Range<usize>>                                  // :132  case-insensitive
    pub fn find_opts(&self, needle: &str, case_sensitive: bool, whole_words: bool) -> Vec<Range<usize>> // :137
    pub fn find_opts_limited(&self, needle: &str, case_sensitive: bool, whole_words: bool, limit: usize) -> Vec<Range<usize>> // :142
    pub fn find_with(&self, matcher: impl Fn(&[char]) -> Vec<Range<usize>>) -> Vec<Range<usize>> // :148
    pub fn nearest(&self, x: f32, y: f32) -> Option<usize>                                 // :184  view-space hit test
    pub fn word_at(&self, i: usize) -> Option<(usize, usize)>                              // :226  INCLUSIVE (first,last)
    pub fn line_at(&self, i: usize) -> Option<(usize, usize)>                              // :244  INCLUSIVE
    pub fn line_rects(&self, range: Range<usize>) -> Vec<[f32; 4]>                         // :260  one rect per line run
    pub fn glyph_rects(&self, glyphs: &[usize]) -> Vec<[f32; 4]>                           // :267  ascending indices; run breaks at gaps
    pub fn glyphs_in(&self, rect: [f32; 4]) -> Vec<usize>                                  // :290  centre-inside (column select)
    pub fn column_text(&self, glyphs: &[usize]) -> String                                  // :307
}
pub fn fold_case(s: &str) -> String                                                        // :80  (i/İ/ı → i, σ/ς/Σ → σ)
pub fn layout(glyphs: Vec<TextGlyph>) -> PageText                                          // :1453
```
Gotchas:
- `find*` returns **glyph** index ranges (end exclusive). `word_at` and `line_at` return **inclusive**
  pairs. To get a range from a word: `first..last + 1`.
- Search folds case per character. Whitespace runs and line breaks count as one space. Matches do not overlap.
- `line_rects` merges consecutive glyphs on the same line, so its rects are in view space.
  Multiply by the display scale.
- `TextFilter` (`text.rs:21`) has `{ tables, code, images, mcids: HashSet<i32> }`. Setting `images: true`
  excludes `Figure`-tagged text **and invisible text layers (including OCR)**. Use it for statistics only.
  `filtered_text` can fail with "a replacement text span mixes…".

### 5.4 Words via UAX #29 (our code) → glyph indices
`text_of` / `plain_text` add separators (`' '`, `'\n'`) that belong to no glyph, and a glyph can hold
several chars. So build the char→glyph map the same way `text.rs:108-124` builds the string:
```rust
use unicode_segmentation::UnicodeSegmentation;
/// Page text (identical to pt.plain_text()) plus, per byte, the glyph that produced it (None = separator).
fn text_with_owners(pt: &PageText) -> (String, Vec<Option<usize>>) {
    let (mut s, mut owner) = (String::new(), Vec::new());
    let mut prev_line = None;
    for (i, g) in pt.glyphs.iter().enumerate() {
        if i > 0 {
            let sep = if prev_line != Some(pt.line_of[i]) { Some('\n') } else if pt.space_before[i] { Some(' ') } else { None };
            if let Some(c) = sep { s.push(c); owner.push(None); }
        }
        s.push_str(&g.text);
        owner.extend(std::iter::repeat(Some(i)).take(g.text.len()));
        prev_line = Some(pt.line_of[i]);
    }
    (s, owner)
}
/// UAX#29 words → (word_index, char_offset, glyph range).
fn words(pt: &PageText) -> Vec<(usize, usize, std::ops::Range<usize>)> {
    let (s, owner) = text_with_owners(pt);
    s.unicode_word_indices().enumerate().filter_map(|(n, (b, w))| {
        let span = &owner[b..b + w.len()];
        let first = span.iter().find_map(|o| *o)?;
        let last = span.iter().rev().find_map(|o| *o)?;
        Some((n, s[..b].chars().count(), first..last + 1))
    }).collect()
}
```
Then `rects = pt.glyph_rects(&(first..=last).collect::<Vec<_>>())` (or `line_rects(first..last+1)`).
Copying a selection uses `pt.text_of(range)`, as the spec requires.

### 5.5 Document search
**There is no document-wide search API** in render or engine. The egui canvas loops over cached
`PageText`s and calls `find_opts` (`crates/ui-egui/src/canvas.rs:1185-1192`). For `core-pdf::search`:
1. Run it on a background thread with its own `PageRenderer`. Do not use the view pool, because
   `set_queue` would evict the visible pages' work.
2. For each page, get Text (cache `Arc<PageText>` per page, LRU), then call `find_opts_limited(q, cs, ww, remaining)`.
3. Emit `Hit { page, glyphs: Range, rects: pt.line_rects(range.clone()) }` progressively, so the frontend
   can show "n results" while the search runs. Support cancellation between pages.

---

## 6. Outline and links

### 6.1 `OutlineItem` — `inspect.rs:370` (Clone, Debug)
```rust
pub struct OutlineItem { pub title: String, pub page: Option<usize>, pub view: DestView, pub children: Vec<OutlineItem>, pub open: bool }
```
`DocInfo.outline` holds the **first 10 000** bookmarks, up to depth 32 (`inspect.rs:44-48`).
`outline_more: bool` reports that some were left out. `/Dest` and `/A /GoTo /D` are both resolved,
including named destinations. Through the engine, `Session::bookmark_page(id, offset, limit) ->
Option<BookmarkPage>` (`engine/src/lib.rs:4832`) pages through the full outline
(`BookmarkRow { path, title, open, page, view }`, `:1122`).

### 6.2 `Link`, `LinkTarget`, `DestView` — `inspect.rs:282-367`
```rust
pub struct Link { pub page: usize, pub index: usize, pub rect: [f32; 4] /* USER space, normalized */, pub target: LinkTarget }
pub enum LinkTarget {
    Page(usize, DestView),                 // internal GoTo / Dest (named dests resolved)
    Uri(String),
    SetLayers { changes: Vec<(LayerOp, (u32, u16))>, preserve_rb: bool },
    RemoteGoTo { file: String, destination: RemoteDestination, new_window: Option<bool> },
    Other(String),                         // "JavaScript", "Launch", …
}
pub enum DestView { Top, Xyz { left, top, zoom: Option<f32> }, Fit, FitH { top }, FitV { left }, FitR { rect: [f32; 4] } } // user-space coords
```
Converting for the frontend: `Link.rect` is in **user** space. Map both corners with
`info.pages[l.page].user_to_view(x, y)` and normalize. For a jump, `LinkTarget::Page(p, view)` →
scroll to page `p`. For the offset, use `info.pages[p].dest_fraction(left, top, 0)`, which returns fractions
of the displayed page (0..1, y down). Only `Page` and `Uri` matter in v1. Ignore `RemoteGoTo` and `Other`.
`DocInfo.links` is filled once at open. The engine also has `Document::links() -> &[pdfcraft_annot::links::LinkItem]`
(`engine/src/lib.rs:772`; `LinkItem { page, index, obj, rect: [f64;4], action: LinkAction, style }`,
`crates/annot/src/links.rs:71`). It is for editing links and is not needed for the reader.

---

## 7. Writing an exported copy: highlights + `LeitorBookUid`

### 7.1 View space → PDF space (undo rotation and crop)
```rust
let pi: &PageInfo = &info.pages[page];
// a stored view-space rect (one per line of the highlight) → Acrobat-order quad in user space
let quad: [f64; 8] = pi.view_rect_to_quad([x0, y0, x1, y1]);  // TL, TR, BL, BR "as read on screen" (inspect.rs:269)
// general quad (e.g. from TextGlyph.quad on turned text): map each point
let p = pi.view_to_user(x, y);                                // [f32; 2]
```
`view_rect_to_quad` keeps the reading orientation on rotated pages, which matters for underline and
squiggly placement. **Required tests (spec 6.5):** a page with `/Rotate 90` and a page with an offset
`/CropBox`. Round trip: view → user → `user_to_view` ≈ identity. Also render the exported copy and check
that the highlight pixels sit over the glyphs.

### 7.2 `pdfcraft-annot` types — `crates/annot/src/lib.rs`
```rust
pub type Rgb = [f64; 3];                                                         // :49 (0..1)
pub enum Markup { Highlight, Underline, StrikeOut, Squiggly }                    // :51
pub enum Shape { Note { at: [f64; 2], icon: NoteIcon }, TextMarkup { kind: Markup, quads: Vec<[f64; 8]> }, Rectangle{..}, … } // :342 (user space)
pub fn rect_quad(r: [f64; 4]) -> [f64; 8]                                        // :480 (unrotated pages only)
pub struct Style { pub color: Rgb, pub opacity: f64, pub width: f64, pub fill: Option<Rgb> } // :564
impl Style { pub fn default_for(shape: &Shape) -> Self }                         // :582 (highlight = [1.0,0.94,0.0])
pub struct NewAnnotation { pub page: usize, pub shape: Shape, pub style: Style, pub contents: String, pub author: String } // :611
pub struct Meta { pub date: Option<String>, pub id: String }                     // :625 (/M+/CreationDate, /NM)
pub fn add_annotation(doc: &mut pdfcraft_cos::Document, new: &NewAnnotation, meta: &Meta) -> Result<usize, AnnotError> // :1073
pub enum AnnotError { NoPageTree, NoSuchPage(usize), NoSuchAnnotation{page,index}, Invalid(String), Unsupported(String), Undrawable(String), Cos(CosError) } // :26
```
`add_annotation` writes `/Subtype /Highlight`, `/QuadPoints`, `/C`, `/CA` (when opacity < 1), `/Contents`,
`/T`, `/Subj`, `/P` and `/F 4 (Print)`. It **generates the appearance stream** (`draw_appearance`,
`:1295`; highlights use the `Multiply` blend mode, `appearance.rs:242`) and appends to the page's `/Annots`.
For a note on a highlight, use `contents` (only `Shape::Note` gets a `/Popup`). For a loose note, use
`Shape::Note { at: top-left in user space, icon: NoteIcon::Comment }`. Our 4 colours map to `Style { color, opacity: 1.0, width: 1.0, fill: None }`.

### 7.3 Info dictionary write
- Engine: `Edit::SetInfo { key: String, value: String }` (`engine/src/lib.rs:1375`), which calls
  `pdfcraft_organize::set_info` (`crates/organize/src/lib.rs:672`):
  ```rust
  pub fn set_info(doc: &mut Document, key: &str, value: &str) -> Result<(), OrganizeError>
  pub fn info(doc: &Document, key: &str) -> Option<String>                 // :662
  pub fn custom_info(doc: &Document) -> Vec<(String, String)>              // :624
  pub fn check_custom_key(name: &str) -> Result<(), OrganizeError>         // :645 (≤127 bytes, no whitespace/delimiters, not a standard key)
  ```
  The value is trimmed, and an empty value **removes** the key. The value is stored as `PdfString::text`.
  Only the standard keys are synced to XMP (`organize/src/xmp.rs:55`), so `LeitorBookUid` stays Info-only. That is fine.
- Without the engine, add `pdfcraft-organize` (deps: cos and content only) and call `set_info`, or write it by
  hand with cos. That code is equivalent to the private `set_info_entry`, `organize/src/lib.rs:683`:
  ```rust
  use pdfcraft_cos::{Dict, Object, PdfString};
  match doc.trailer().get(b"Info").cloned() {
      Some(Object::Ref(r)) if doc.get(r).as_dict().is_some() =>
          doc.update_dict(r, |d| d.set(b"LeitorBookUid".to_vec(), PdfString::text(uid)))?,   // document.rs:1345
      other => {
          let mut d = match other { Some(Object::Dict(d)) => d, _ => Dict::new() };
          d.set(b"LeitorBookUid".to_vec(), PdfString::text(uid));
          let r = doc.add(d);                                                                   // document.rs:1278
          doc.trailer_mut().set(b"Info".to_vec(), Object::Ref(r));                              // document.rs:890
      }
  }
  ```
- Read it on import with `inspect(..)?.custom.iter().find(|(k, _)| k == "LeitorBookUid")`. A standard key would
  not appear in `custom`.

### 7.4 Saving — `crates/cos/src/writer.rs`
```rust
pub struct SaveOptions { pub mod_date: Option<String>, pub id_seed: u64, pub object_streams: bool } // :151 (Default)
pub fn write_incremental(doc: &Document, opts: &SaveOptions) -> Result<Vec<u8>, CosError>          // :189
pub fn write_full(doc: &Document, opts: &SaveOptions) -> Result<Vec<u8>, CosError>                 // :254
pub fn pdf_date(unix_secs: i64) -> String                                                          // :589
```
`write_incremental` appends a revision and leaves the original bytes untouched. This preserves signatures,
and the encryption is kept. A reconstructed (damaged) file is rewritten in full automatically.

### 7.5 Full export recipes
**Via engine** (open a *separate* copy so the reading document's pool and undo history are untouched):
```rust
use pdfcraft_engine::{Edit, NewAnnotation, Shape, Markup, Style};
let prepared = session.open_context().prepare_open("export.pdf", None, original.clone(), password)?;  // off-lock
let id = session.commit_open(prepared);
let pages = session.get(id).unwrap().info.pages.clone();
let mut edits: Vec<Edit> = notes.iter().map(|n| Edit::AddAnnotation(NewAnnotation {
    page: n.page,
    shape: Shape::TextMarkup { kind: Markup::Highlight, quads: n.view_rects.iter().map(|r| pages[n.page].view_rect_to_quad(*r)).collect() },
    style: Style { color: n.rgb, opacity: 1.0, width: 1.0, fill: None },
    contents: n.comment.clone().unwrap_or_default(), author: "Leitor de Estudos".into(),
})).collect();
edits.push(Edit::SetInfo { key: "LeitorBookUid".into(), value: book_uid.into() });
let res = session.apply(id, Edit::Batch { label: "Export annotated".into(), edits });   // :3754, all-or-nothing
let bytes = res.and_then(|_| session.save_bytes(id));                                   // :4256 incremental, stamps /ModDate
if let Ok(b) = &bytes { session.check_save(id, b)?; }                                    // :4296 reopen check
session.close(id);
```
The engine generates `Meta` (`/NM` uuid, dates from the session clock), checks permissions (an encrypted file
without the annotate bit → `EditError::NotPermitted("comments")`, `engine/src/lib.rs:2240-2262`), and runs
the edit on a clone inside `catch_unwind` (`:3800-3803`). Cost: each `apply` rewrites the working bytes,
re-inspects and rebuilds a `RenderPool`, so **batch everything into one `Edit::Batch`**.

**Without engine** (cos + annot + organize):
```rust
let mut doc = pdfcraft_cos::Document::open_with_password(original.clone(), password)?;
// optional: if let Some(p) = doc.permissions() { if !p.annotate() { … } }   (document.rs:756)
for n in notes {
    let meta = pdfcraft_annot::Meta { date: Some(pdfcraft_cos::pdf_date(now)), id: uuid::Uuid::new_v4().to_string() };
    pdfcraft_annot::add_annotation(&mut doc, &new_annotation(n, &pages), &meta)?;
}
pdfcraft_organize::set_info(&mut doc, "LeitorBookUid", &book_uid)?;
let out = pdfcraft_cos::write_incremental(&doc, &SaveOptions { mod_date: Some(pdfcraft_cos::pdf_date(now)), ..Default::default() })?;
pdfcraft_render::check_pages(Arc::new(out.clone()), render_pw.as_deref(), pages.len())?;  // inspect.rs:491
```
Wrap the whole thing in `std::panic::catch_unwind` (the engine's `guard`, `engine/src/lib.rs:2907`, is public
and can be reused even when the engine is only partially used).

### 7.6 Thread-safety (editing)
- `pdfcraft_cos::Document`: **Send**. It is part of `engine::Document`, asserted `Send`. Its fields are `Arc`,
  `Arc<Mutex<…>>` and `BTreeMap`, so it is very likely Sync too, but nothing here relies on that. Clones share
  unchanged data, so snapshots are cheap.
- `engine::Session`: Send (`Vec<Document>`, `fn` pointers, `Arc<TrustStore>`), **!Sync** because each
  `Document` owns a `!Sync` `RenderPool`. Put it in `Mutex<Session>`, and never hold that lock across `prepare_open` or long exports.
- `pdfcraft_annot::{NewAnnotation, Shape, Style, Meta}`: plain data, Send + Sync.

---

## 8. OCR (spec 7.2) — `crates/ocr/src/lib.rs`, `crates/engine/src/ocr.rs`
```rust
pub struct Models { pub detection: PathBuf, pub recognition: PathBuf }           // :45
impl Models { pub fn in_dir(dir: &Path) -> Option<Models>; pub fn find() -> Option<Models>; pub fn search_dirs() -> Vec<PathBuf> } // :52-64
pub struct Ocr { /* ocrs::OcrEngine */ }                                          // :107
impl Ocr {
    pub fn load(models: &Models) -> Result<Ocr, OcrError>                         // :112 (slow: load once, share Arc)
    pub fn recognize(&self, pixels: &[u8], width: u32, height: u32) -> Result<Vec<Line>, OcrError> // :130 RGBA/RGB/grey
}
pub struct Line { pub words: Vec<Word> }  pub struct Word { pub text: String, pub rect: [f32; 4] /* IMAGE PIXELS l,t,r,b */ }
pub enum OcrError { NoModels, Load(String, String), Recognize(String), EmptyImage }  // :30
pub const ALPHABET: &str = " 0123456789!…ABC…xyz";  // no accented letters
```
- Model lookup order: `$PDFCRAFT_MODELS`, then `models/`, `../Resources/models` and `../share/pdfcraft/models` beside the
  exe, then `CARGO_MANIFEST_DIR/../../assets/models`. **In the Tauri app, call `Ocr::load(&Models::in_dir(app_data/models)?)`**
  instead of relying on `find()`.
- Pipeline (copy of `OcrJob::run`, `engine/src/ocr.rs:107-157`): render at `scale = dpi/72` (300 dpi default, capped at the
  scan's native resolution), call `recognize(&shot.rgba, w, h)`, then convert to **view space** with `word.rect.map(|v| v / scale)`
  where `scale = shot.width as f32 / info.width`. Store that in our DB (same space as `TextGlyph.rect`).
- Searchable export: the engine's `Edit::AddOcrText { page, words: Vec<pdfcraft_ocr::PlacedWord> }` (`engine/src/lib.rs:1657`),
  or `Session::ocr_job` / `apply_ocr` (`ocr.rs:170, 194`). `PlacedWord::place(word, to_user)` (`ocr/src/lib.rs:178`) takes a
  pixel→user closure: `|x, y| { let [u, v] = info.view_to_user(x/scale, y/scale); [u as f64, v as f64] }`.
- `Ocr` is Send + Sync: the engine keeps it in `static Mutex<Option<Arc<Ocr>>>` (`engine/src/ocr.rs:77`), which requires both.

---

## 9. Engine vs. direct crates: two designs for `core-pdf`

### A. On `pdfcraft-engine` (spec's main plan; decided for desktop in `docs/decisoes.md`)
- `open`: `OpenContext::prepare_open` off-lock, then `commit_open`. The error is `pdfcraft_render::OpenError`.
- `info` / `outline` / links: `session.get(id)?.info` (`DocInfo`).
- `render`: **do not use `doc.renderer` through the session lock** (it is `!Sync` and needs a polling owner).
  Instead build our own pool per (doc, theme): `RenderPool::new(doc.display.clone(), n, RenderConfig { reading_colors, ..session.render_config(id)? })`.
  `display` and the config are `Arc`/`Clone` and `Send`, so they can move to the render actor thread. The cost is the
  engine's own pool (1–7 idle threads per doc) sitting unused. That is acceptable, and `close(id)` frees it.
- `page_text` / `search`: a `PageRenderer` over `doc.display` on a worker.
- `export_annotated`: §7.5 engine recipe.
- `ocr_page`: §8.
- Pros: owner-password recovery, display appearances for comments and fields that lack them, damaged page-tree
  repair, permission checks, and `Edit::Batch` atomicity all come for free.
  Cons: huge dependency graph (aws-lc-sys via pdfcraft-sign, boa via pdfcraft-js, git deps `craft-print` and
  `craft-docpath`). The open step does work we don't need (signature validation, XFA layout and scripts, form adoption),
  and it spawns a pool per document.

### B. Directly on render + cos + annot (+ organize, model, ocr) — the iOS fallback
- `open`: `inspect(bytes, pw)` for `DocInfo` and the error. Also `cos::Document::open_with_password` only when editing
  or exporting, or for owner-password recovery (§1.4).
- `render`: `RenderPool::new(bytes, n, RenderConfig{ password: render_pw, reading_colors, .. })`. Note that we lose the
  engine's `display` bytes, so comments or fields **without** appearance streams don't draw. Optionally apply
  `pdfcraft_annot::with_missing_appearances(&cos) -> Option<Document>` (`annot/src/lib.rs:1504`) and then
  `write_incremental` to get display bytes. Missing form-field appearances need `pdfcraft-forms` (not in our deps).
- Text, search, links and outline: identical (all from render).
- Export: §7.5 manual recipe. Add `pdfcraft-organize` (or the hand-written Info code) and `pdfcraft-model` if needed.
- Pros: small graph (hayro, lopdf, kurbo, chrono, thiserror, serde, bytemuck plus ocrs/rten for OCR), no git deps,
  no crypto C code, and full control over threads. Cons: we must replicate owner-password recovery and panic guards
  ourselves (`std::panic::catch_unwind`).

### Recommendation
Keep the `DocumentEngine` trait. Implement `PdfcraftEngine` so that **all rendering, text, search, link and outline
paths go through `pdfcraft-render` types only** (`DocInfo`, `PageRenderer`, `RenderPool`, `PageText`). Use
`pdfcraft-engine` only for (1) opening, which gives the render password and display bytes, and (2) `export_annotated`
through `Edit::Batch` and `save_bytes`. That isolates the engine to two functions, so plan B on iOS means replacing
just those two (with `inspect` plus cos/annot/organize). Concretely:
1. A render actor thread per (doc, theme) owns a `RenderPool` (threads = `clamp(cores,2,8)-1`, or fewer with many docs).
   It speaks oneshot channels to the `pdf://` protocol handler and is fed by `set_queue`.
2. A text worker per doc owns a `PageRenderer` plus an LRU of `Arc<PageText>`. It serves `page_text` and `search`.
3. `Mutex<Session>`, held only briefly. `prepare_open` and exports run off-lock (export opens its own copy).
4. Thumbnails: the same pool with `preview: true` and a distinct `tag` range (thumbnail vs page vs tile). Never set bit 60.
5. Every `RenderedPage.error` becomes an in-place warning with a "switch renderer" action. Never `unwrap`.

---

## 10. Gotchas checklist
- `RenderPool::set_queue` drops results for requests you stop listing. A forgotten request means a hung HTTP request,
  so time out the oneshots.
- Results are premultiplied RGBA. Opaque unless `transparent`.
- A whole-page render can come back smaller than requested (caps). Read `width`/`height`, and send them as response headers.
- `Tile` units are device pixels at the request's `scale`. Tile sides are ≤ 4096.
- `PageRenderer::new` with a wrong password does not error; it gives `page_count() == 0`. Validate with `inspect`.
- The renderer needs the *user* password for R2–R4 (§1.4).
- `DocInfo.outline` is truncated at 10k entries and depth 32 (`outline_more`).
- `Link.rect`, `Annotation.rect` and `DestView` coordinates are in **user** space. `TextGlyph.rect` is in **view** space.
- `word_at` and `line_at` return inclusive pairs. `find*` returns half-open glyph ranges.
- The text layer includes annotation appearance text (form values, FreeText).
- `TextGlyph.text` can hold several chars (ligatures). Map UAX#29 words through a char→glyph table (§5.4).
- `set_info` with an empty value deletes the key. The key must pass `check_custom_key`.
- The engine `Session::apply` rebuilds the pool and re-inspects on every call. Batch the edits.
- The engine's `Session::set_reading_colors` replaces the document's pool (in-flight work is lost).
- Our root `Cargo.toml` must keep `[patch.crates-io]` identical to upstream's hayro/lopdf/vello_common entries.

## 11. Things not found / to verify with a compiler
- There is no public blocking receive on `RenderPool` and no document-wide search function. Both have been confirmed absent.
- No `ReadingColors` sepia preset exists. Ours are custom `ReadingParams`.
- Send/Sync were derived from source and from `tests.rs:41` (`PreparedDocument: Send`). Add these to `core-pdf` tests:
  `fn _a() { fn s<T: Send>() {} fn ss<T: Send + Sync>() {} s::<RenderPool>(); s::<PageRenderer>(); s::<pdfcraft_cos::Document>(); s::<pdfcraft_engine::Session>(); ss::<PageText>(); ss::<DocInfo>(); ss::<RenderConfig>(); }`.
- `PageInfo::view_rect_to_quad` on a rotated **and** cropped page has no direct PdfCraft test in render's `inspect.rs`.
  We must test it ourselves (spec 6.5).
