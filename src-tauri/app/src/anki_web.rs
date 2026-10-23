//! Files shared by the `anki` and `card` protocols: the Anki web assets extracted from the `aqt`
//! wheel by `scripts/fetch-anki-web.sh` (bundled as the Tauri resource `anki-web/`, spec 19), the
//! MIME table and the path-safety rules of `qt/aqt/mediasrv.py`, and small response helpers.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{HeaderValue, Response, StatusCode, header};

/// Overrides where the Anki web assets are read from (tests, side-by-side builds).
pub const ANKI_WEB_DIR_ENV: &str = "LEITOR_ANKI_WEB_DIR";
/// Name of the bundled resource folder (`tauri.conf.json` → `bundle.resources`).
pub const RESOURCE_NAME: &str = "anki-web";
/// The file whose presence marks a usable asset folder.
const MARKER: &str = "sveltekit/index.html";

/// Shown (with 503) by pages and cards when the assets are missing (a dev build that never ran
/// `scripts/fetch-anki-web.sh`).
pub const MISSING_MESSAGE: &str =
    "Os arquivos do Anki não foram encontrados. Rode scripts/fetch-anki-web.sh.";

/// The Anki web asset folder, if one was found.
#[derive(Clone, Debug, Default)]
pub struct AnkiWeb {
    root: Option<PathBuf>,
}

impl AnkiWeb {
    /// Resolution order: `LEITOR_ANKI_WEB_DIR` → `<resource_dir>/anki-web` → (debug builds)
    /// `src-tauri/resources/anki-web` of the source tree. The first folder that has
    /// `sveltekit/index.html` wins.
    pub fn resolve(env_dir: Option<PathBuf>, resource_dir: Option<PathBuf>) -> Self {
        let mut candidates: Vec<PathBuf> = Vec::new();
        candidates.extend(env_dir);
        candidates.extend(resource_dir.map(|d| d.join(RESOURCE_NAME)));
        if cfg!(debug_assertions) {
            candidates.push(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("resources")
                    .join(RESOURCE_NAME),
            );
        }
        for dir in candidates {
            if dir.join(MARKER).is_file() {
                let web = Self::at(&dir);
                if web.root.is_some() {
                    tracing::info!(dir = %dir.display(), "Anki web assets");
                    return web;
                }
            }
        }
        tracing::warn!("Anki web assets not found: run scripts/fetch-anki-web.sh");
        Self::missing()
    }

    /// Assets at `dir` (canonicalized); missing if it cannot be resolved.
    pub fn at(dir: &Path) -> Self {
        Self {
            root: dir.canonicalize().ok(),
        }
    }

    pub fn missing() -> Self {
        Self { root: None }
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// A file under the asset root, by a relative `/`-separated path.
    pub fn file(&self, rel: &str) -> Result<PathBuf, FileError> {
        let root = self.root.as_deref().ok_or(FileError::Unavailable)?;
        safe_join(root, rel)
    }

    /// Reads a file of the asset root.
    pub fn read(&self, rel: &str) -> Result<Vec<u8>, FileError> {
        let path = self.file(rel)?;
        std::fs::read(&path).map_err(|e| FileError::from_io(&e))
    }
}

/// Why a file could not be served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileError {
    /// Traversal, absolute path, backslash, NUL, a directory: 403.
    Forbidden,
    NotFound,
    /// The asset folder is missing: 503 with [`MISSING_MESSAGE`].
    Unavailable,
}

impl FileError {
    fn from_io(e: &std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound,
            _ => Self::Forbidden,
        }
    }

    pub fn response(self) -> Response<Vec<u8>> {
        match self {
            Self::Forbidden => text(StatusCode::FORBIDDEN, "Acesso negado."),
            Self::NotFound => text(StatusCode::NOT_FOUND, "Não encontrado."),
            Self::Unavailable => missing_page(),
        }
    }
}

/// Checks a decoded relative path the way `ensure_safe_path` does (plus a few rules of ours) and
/// joins it to `root`. `root` must be canonical. Rejects `..`, `.`, empty segments, absolute
/// paths, backslashes, NUL and drive letters, then canonicalizes and requires the result to stay
/// strictly inside `root` (so symlinks out of the folder are refused too). Directories are
/// forbidden.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, FileError> {
    if !is_safe_rel(rel) {
        return Err(FileError::Forbidden);
    }
    let joined = root.join(rel);
    let full = match joined.canonicalize() {
        Ok(full) => full,
        Err(e) => return Err(FileError::from_io(&e)),
    };
    if !full.starts_with(root) || full == root {
        return Err(FileError::Forbidden);
    }
    if full.is_dir() {
        return Err(FileError::Forbidden);
    }
    Ok(full)
}

/// The lexical half of [`safe_join`].
pub fn is_safe_rel(rel: &str) -> bool {
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.contains('\0')
        || rel.contains(':')
    {
        return false;
    }
    rel.split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// Percent-decodes a URL path (without the leading `/`); `None` if it is not UTF-8.
pub fn decode_path(raw: &str) -> Option<String> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
}

/// The request path without the leading `/`, query or fragment (desktop opens `graphs?cb=…` and
/// appends `#night`; the webview never sends the fragment, but a test or a buggy caller might).
pub fn route_path(path: &str) -> &str {
    let end = path.find(['?', '#']).unwrap_or(path.len());
    path[..end].trim_start_matches('/')
}

/// `_mime_for_path` of `mediasrv.py:290-329`, plus `.wav`, `.oga`/`.opus`/`.m4a`/`.flac` audio and
/// `.webp`/`.avif`/`.bmp` images that the Python fallback (`mimetypes`) would find.
pub fn mime_for_path(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "html" | "htm" => "text/html",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "json" => "application/json",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        // The `mimetypes` fallback of the Python table.
        "wav" => "audio/wav",
        "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// A `text/plain` response (no escaping needed, like `_text_response`).
pub fn text(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// The pt-BR page shown when the assets are missing (503).
pub fn missing_page() -> Response<Vec<u8>> {
    let body = format!(
        "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><title>Anki</title>\
         <style>body{{font-family:system-ui,sans-serif;margin:2rem;color:#444}}</style></head>\
         <body><p>{MISSING_MESSAGE}</p></body></html>"
    );
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; style-src 'unsafe-inline'",
        )
        .body(body.into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// A 200 response with `bytes` as `mime`.
pub fn bytes_response(mime: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    let mut res = Response::new(bytes);
    if let Ok(v) = HeaderValue::from_str(mime) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    res.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res
}

/// Sets (or replaces) a header; values that are not valid header text are skipped.
pub fn set_header(res: &mut Response<Vec<u8>>, name: header::HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        res.headers_mut().insert(name, v);
    }
}

/// Serves a file, honouring a single `Range: bytes=…` (206/416) so audio and video can seek.
/// `head` answers headers only.
pub fn file_response(
    path: &Path,
    mime: &str,
    range: Option<&str>,
    head: bool,
) -> Result<Response<Vec<u8>>, FileError> {
    let mut file = std::fs::File::open(path).map_err(|e| FileError::from_io(&e))?;
    let len = file.metadata().map_err(|e| FileError::from_io(&e))?.len();
    let wanted = match range.map(|r| parse_range(r, len)) {
        None => None,
        Some(Some(r)) => Some(r),
        Some(None) => {
            let mut res = text(StatusCode::RANGE_NOT_SATISFIABLE, "Intervalo inválido.");
            set_header(&mut res, header::CONTENT_RANGE, &format!("bytes */{len}"));
            return Ok(res);
        }
    };
    let (start, end) = wanted.unwrap_or((0, len.saturating_sub(1)));
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut body = Vec::new();
    if !head && count > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|e| FileError::from_io(&e))?;
        body.reserve(usize::try_from(count).unwrap_or(0));
        file.take(count)
            .read_to_end(&mut body)
            .map_err(|e| FileError::from_io(&e))?;
    }
    let mut res = bytes_response(mime, body);
    set_header(&mut res, header::ACCEPT_RANGES, "bytes");
    if wanted.is_some() {
        *res.status_mut() = StatusCode::PARTIAL_CONTENT;
        set_header(
            &mut res,
            header::CONTENT_RANGE,
            &format!("bytes {start}-{end}/{len}"),
        );
    }
    if head {
        set_header(&mut res, header::CONTENT_LENGTH, &count.to_string());
    }
    Ok(res)
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n` against a file of `len` bytes → inclusive `(start, end)`.
/// Multiple ranges are not supported (`None` → 416), like an unsatisfiable range.
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.trim();
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() {
            len - 1
        } else {
            b.parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_table_matches_mediasrv() {
        assert_eq!(mime_for_path("a/b/x.mjs"), "application/javascript");
        assert_eq!(mime_for_path("x.JS"), "application/javascript");
        assert_eq!(mime_for_path("f.woff2"), "font/woff2");
        assert_eq!(mime_for_path("f.woff"), "font/woff");
        assert_eq!(mime_for_path("s.wav"), "audio/wav");
        assert_eq!(mime_for_path("s.mp3"), "audio/mpeg");
        assert_eq!(mime_for_path("i.svg"), "image/svg+xml");
        assert_eq!(mime_for_path("noext"), "application/octet-stream");
    }

    #[test]
    fn unsafe_relative_paths_are_rejected() {
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../../x",
            "a/./b",
            "a//b",
            "a\\b",
            "a\0b",
            "C:/x",
            "..",
        ] {
            assert!(!is_safe_rel(bad), "{bad:?}");
        }
        assert!(is_safe_rel("sveltekit/_app/immutable/x.mjs"));
        assert!(is_safe_rel("foto 1.jpg"));
    }

    #[test]
    fn safe_join_stays_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), b"a").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"s").unwrap();
        let root = root.canonicalize().unwrap();
        assert!(safe_join(&root, "sub/a.txt").is_ok());
        assert_eq!(safe_join(&root, "sub"), Err(FileError::Forbidden));
        assert_eq!(safe_join(&root, "../secret.txt"), Err(FileError::Forbidden));
        assert_eq!(safe_join(&root, "nope.txt"), Err(FileError::NotFound));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("link.txt"))
                .unwrap();
            assert_eq!(safe_join(&root, "link.txt"), Err(FileError::Forbidden));
        }
    }

    #[test]
    fn route_path_strips_query_and_fragment() {
        assert_eq!(route_path("/graphs?cb=1#night"), "graphs");
        assert_eq!(route_path("/deck-options/1#night"), "deck-options/1");
        assert_eq!(route_path("/"), "");
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
        assert_eq!(parse_range("bytes=5-1", 100), None);
    }

    #[test]
    fn file_response_supports_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.wav");
        std::fs::write(&p, (0u8..100).collect::<Vec<_>>()).unwrap();
        let full = file_response(&p, "audio/wav", None, false).unwrap();
        assert_eq!(full.status(), 200);
        assert_eq!(full.body().len(), 100);
        assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");
        let part = file_response(&p, "audio/wav", Some("bytes=10-19"), false).unwrap();
        assert_eq!(part.status(), 206);
        assert_eq!(part.body(), &(10u8..20).collect::<Vec<_>>());
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        let bad = file_response(&p, "audio/wav", Some("bytes=200-"), false).unwrap();
        assert_eq!(bad.status(), 416);
    }

    #[test]
    fn missing_assets_answer_503_in_portuguese() {
        let web = AnkiWeb::missing();
        let err = web.read("sveltekit/index.html").unwrap_err();
        let res = err.response();
        assert_eq!(res.status(), 503);
        assert!(String::from_utf8_lossy(res.body()).contains(MISSING_MESSAGE));
    }
}
