//! The `anki` URI scheme (spec 8.3): Anki's own SvelteKit pages (deck options, statistics, card
//! info, import, change notetype, congrats, image occlusion) and their `POST /_anki/<method>`
//! calls, ported from `qt/aqt/mediasrv.py` of the pinned tag (`get_sveltekit_route`, the `_app`
//! rewrite, the `index.html` fallback, `_strip_csp_meta`, the MIME table).
//!
//! `anki://localhost/<route>` (`http://anki.localhost/<route>` on Windows):
//!
//! | Path | Answer |
//! |---|---|
//! | `<sveltekit route>[/…]` | `sveltekit/index.html`, CSP meta removed, `page-bridge.js` injected |
//! | `_app/immutable/**` | the file, cached for a year |
//! | other `_app/**` | `index.html` (Anki's fallback) |
//! | `_leitor/page-bridge.js` | our host shim (`window.bridgeCommand`, Escape, theme) |
//! | `_anki/js/**`, `_anki/css/**` | bundled files |
//! | `POST _anki/<method>` | the bridge, as [`Caller::Page`] (the whole whitelist) |
//! | anything else | 404 |
//!
//! The pages run in an iframe of the UI with no Tauri capability (no `invoke`). Responses never
//! carry CORS headers, POSTs need the exact `Content-Type: application/binary` and, when an
//! `Origin` is sent, the anki origin; `OPTIONS` is always 403, so no other origin can call the API.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use core_anki::bridge::{Caller, PostReply, PostRequest};
use regex::Regex;
use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::anki_web::{self, AnkiWeb, FileError};
use crate::protocol::scheme_origins;
use crate::state::AppState;

pub const ANKI_SCHEME: &str = "anki";

/// `get_sveltekit_route` (`mediasrv.py:524-544`) without `editor` (we have our own editor) and
/// `preferences` (not reused).
pub const SVELTEKIT_ROUTES: [&str; 9] = [
    "graphs",
    "congrats",
    "card-info",
    "change-notetype",
    "deck-options",
    "import-anki-package",
    "import-csv",
    "import-page",
    "image-occlusion",
];

/// The host shim, owned by the web shell (`src-tauri/app/assets/anki-page/page-bridge.js`).
pub const PAGE_BRIDGE_JS: &str = include_str!("../assets/anki-page/page-bridge.js");
/// Where the shim is served and what is injected as the first child of `<head>`.
pub const PAGE_BRIDGE_PATH: &str = "_leitor/page-bridge.js";
pub const PAGE_BRIDGE_TAG: &str = r#"<script src="/_leitor/page-bridge.js"></script>"#;

/// `_SVELTEKIT_CSP_META_RE` of `mediasrv.py:126-128`, verbatim.
static CSP_META_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"<meta http-equiv="content-security-policy" content="script-src 'self' ('sha256-[A-Za-z0-9+/=]+')">"#)
        .map_err(|e| tracing::error!(%e, "bad CSP meta regex"))
        .ok()
});
static HEAD_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"(?i)<head(\s[^>]*)?>")
        .map_err(|e| tracing::error!(%e, "bad head regex"))
        .ok()
});

/// Debug builds: `LEITOR_RECORD_ANKI_POSTS=<dir>` writes the first body of each page method to
/// `<dir>/<method>.bin` (+ `<method>.json` with its headers) for the bridge tests
/// (`scripts/record-anki-posts.sh`).
pub const RECORD_ENV: &str = "LEITOR_RECORD_ANKI_POSTS";

/// Removes SvelteKit's hash-only CSP meta (our header CSP replaces it, so the injected shim and
/// `javascript:bridgeCommand(…)` links of `congrats` can run) and injects the shim as the first
/// child of `<head>`. Fails closed (`None`) when the meta or `<head>` is not found, like
/// `_strip_csp_meta`.
pub fn prepare_index(html: &str) -> Option<String> {
    let csp = CSP_META_RE.as_ref()?;
    let head = HEAD_RE.as_ref()?;
    let found = csp.find(html)?;
    let mut stripped = String::with_capacity(html.len() + PAGE_BRIDGE_TAG.len());
    stripped.push_str(&html[..found.start()]);
    stripped.push_str(&html[found.end()..]);
    let open = head.find(&stripped)?;
    let mut out = String::with_capacity(stripped.len() + PAGE_BRIDGE_TAG.len());
    out.push_str(&stripped[..open.end()]);
    out.push_str(PAGE_BRIDGE_TAG);
    out.push_str(&stripped[open.end()..]);
    Some(out)
}

/// The header CSP of the pages: only our origin for scripts, styles, images and fetches, and only
/// the UI may frame them.
pub fn page_csp(ui_origins: &[String]) -> String {
    let own = crate::protocol::own_sources(ANKI_SCHEME);
    format!(
        "default-src {own} data: blob:; script-src {own} 'unsafe-inline'; \
         style-src {own} 'unsafe-inline'; img-src {own} data: blob:; connect-src {own}; \
         object-src 'none'; frame-ancestors {}",
        ui_origins.join(" ")
    )
}

/// What a request turned into.
#[derive(Debug)]
pub enum Routed {
    /// Answer right away.
    Reply(Response<Vec<u8>>),
    /// A checked `POST /_anki/<method>` for the bridge.
    Post(PostRequest),
}

/// The `anki` scheme: routing and responses. Pure apart from reading the asset files, so the
/// tests drive it without a webview.
pub struct AnkiPages {
    web: AnkiWeb,
    ui_origins: Vec<String>,
    csp: String,
    record_dir: Option<PathBuf>,
}

impl AnkiPages {
    pub fn new(web: AnkiWeb, ui_origins: Vec<String>) -> Self {
        let record_dir = if cfg!(debug_assertions) {
            std::env::var_os(RECORD_ENV).map(PathBuf::from)
        } else {
            None
        };
        Self {
            web,
            csp: page_csp(&ui_origins),
            ui_origins,
            record_dir,
        }
    }

    /// Records page POST bodies into `dir` (what `LEITOR_RECORD_ANKI_POSTS` does in debug builds).
    pub fn recording_to(mut self, dir: PathBuf) -> Self {
        self.record_dir = Some(dir);
        self
    }

    pub fn ui_origins(&self) -> &[String] {
        &self.ui_origins
    }

    /// Routes a request. GETs read their file here (blocking IO: call off the async runtime).
    pub fn route(&self, req: &Request<Vec<u8>>) -> Routed {
        let raw = anki_web::route_path(req.uri().path());
        let Some(path) = anki_web::decode_path(raw) else {
            return Routed::Reply(FileError::NotFound.response());
        };
        let method = req.method();
        if method == Method::POST {
            return self.route_post(req, &path);
        }
        if method == Method::OPTIONS {
            // No CORS on this scheme: a preflight from any other origin fails here.
            return Routed::Reply(anki_web::text(StatusCode::FORBIDDEN, "Acesso negado."));
        }
        if method != Method::GET && method != Method::HEAD {
            return Routed::Reply(anki_web::text(
                StatusCode::METHOD_NOT_ALLOWED,
                "Método não permitido.",
            ));
        }
        let mut res = self.get(&path);
        if method == Method::HEAD {
            res.body_mut().clear();
        }
        Routed::Reply(res)
    }

    fn get(&self, path: &str) -> Response<Vec<u8>> {
        let first = path.split('/').next().unwrap_or_default();
        if SVELTEKIT_ROUTES.contains(&first) {
            return self.index();
        }
        if let Some(rest) = path.strip_prefix("_app/") {
            if rest.starts_with("immutable/") {
                return self.asset(&format!("sveltekit/_app/{rest}"), true);
            }
            return self.index();
        }
        if path == PAGE_BRIDGE_PATH {
            let mut res = anki_web::bytes_response(
                "application/javascript",
                PAGE_BRIDGE_JS.as_bytes().to_vec(),
            );
            anki_web::set_header(&mut res, header::CACHE_CONTROL, "no-cache");
            return res;
        }
        if let Some(rest) = path.strip_prefix("_anki/")
            && (rest.starts_with("js/") || rest.starts_with("css/"))
        {
            return self.asset(rest, false);
        }
        if path == "favicon.ico" {
            return self.asset("imgs/favicon.ico", false);
        }
        FileError::NotFound.response()
    }

    /// The SPA page for every SvelteKit route.
    fn index(&self) -> Response<Vec<u8>> {
        let html = match self.web.read("sveltekit/index.html") {
            Ok(bytes) => bytes,
            Err(e) => return e.response(),
        };
        let html = String::from_utf8_lossy(&html);
        let Some(page) = prepare_index(&html) else {
            tracing::error!(
                "CSP meta tag or <head> not found in the SvelteKit index page (anki-web assets changed?)"
            );
            return anki_web::text(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Página do Anki inválida.",
            );
        };
        let mut res = anki_web::bytes_response("text/html; charset=utf-8", page.into_bytes());
        anki_web::set_header(&mut res, header::CONTENT_SECURITY_POLICY, &self.csp);
        anki_web::set_header(&mut res, header::CACHE_CONTROL, "no-cache");
        res
    }

    fn asset(&self, rel: &str, immutable: bool) -> Response<Vec<u8>> {
        match self.web.read(rel) {
            Ok(bytes) => {
                let mut res = anki_web::bytes_response(anki_web::mime_for_path(rel), bytes);
                if immutable {
                    anki_web::set_header(&mut res, header::CACHE_CONTROL, "max-age=31536000");
                }
                res
            }
            Err(e) => e.response(),
        }
    }

    fn route_post(&self, req: &Request<Vec<u8>>, path: &str) -> Routed {
        let Some(name) = path.strip_prefix("_anki/").filter(|m| is_method_name(m)) else {
            return Routed::Reply(FileError::NotFound.response());
        };
        let headers = req.headers();
        let get = |h: &str| {
            headers
                .get(h)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let post = PostRequest {
            method: name.to_owned(),
            content_type: get(header::CONTENT_TYPE.as_str()),
            origin: get(header::ORIGIN.as_str()),
            op_changes: get("anki-op-changes"),
            body: req.body().clone(),
        };
        // Checked here too (the bridge checks again): nothing reaches the actor otherwise.
        if post.content_type.as_deref() != Some(core_anki::bridge::CONTENT_TYPE) {
            tracing::warn!(method = name, "anki POST with a wrong Content-Type");
            return Routed::Reply(self.post_response(&post, forbidden()));
        }
        if let Some(origin) = post.origin.as_deref()
            && !scheme_origins(ANKI_SCHEME).iter().any(|o| o == origin)
        {
            tracing::warn!(method = name, origin, "anki POST from a foreign origin");
            return Routed::Reply(self.post_response(&post, forbidden()));
        }
        Routed::Post(post)
    }

    /// Turns a bridge reply into the HTTP response (no CORS headers, never cached).
    pub fn post_response(&self, req: &PostRequest, reply: PostReply) -> Response<Vec<u8>> {
        log_post("page", &req.method, reply.status);
        if reply.status < 400 {
            self.record(req);
        }
        reply_response(reply)
    }

    /// Routes and answers a request (file reads on the blocking pool), calling the bridge for
    /// POSTs.
    pub async fn serve(
        self: Arc<Self>,
        state: Arc<AppState>,
        req: Request<Vec<u8>>,
    ) -> Response<Vec<u8>> {
        let routed = {
            let pages = Arc::clone(&self);
            tauri::async_runtime::spawn_blocking(move || pages.route(&req)).await
        };
        match routed {
            Ok(Routed::Reply(res)) => res,
            Ok(Routed::Post(post)) => {
                let reply = crate::anki::bridge_post(state, Caller::Page, post.clone()).await;
                self.post_response(&post, reply)
            }
            Err(e) => {
                tracing::error!(%e, "anki protocol task failed");
                anki_web::text(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno.")
            }
        }
    }

    fn record(&self, req: &PostRequest) {
        let Some(dir) = &self.record_dir else { return };
        let bin = dir.join(format!("{}.bin", req.method));
        if bin.exists() {
            return;
        }
        let meta = serde_json::json!({
            "method": req.method,
            "contentType": req.content_type,
            "opChanges": req.op_changes,
        });
        let written = std::fs::create_dir_all(dir)
            .and_then(|()| std::fs::write(&bin, &req.body))
            .and_then(|()| {
                std::fs::write(
                    dir.join(format!("{}.json", req.method)),
                    serde_json::to_vec_pretty(&meta).unwrap_or_default(),
                )
            });
        if let Err(e) = written {
            tracing::warn!(%e, method = %req.method, "could not record the request");
        }
    }
}

/// A camelCase rpc name: ASCII letters and digits only (also keeps recorder file names safe).
pub fn is_method_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric())
}

pub(crate) fn forbidden() -> PostReply {
    PostReply {
        status: 403,
        content_type: "text/plain; charset=utf-8",
        body: "Acesso negado.".as_bytes().to_vec(),
    }
}

/// `PostReply` → HTTP response.
pub(crate) fn reply_response(reply: PostReply) -> Response<Vec<u8>> {
    let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut res = anki_web::bytes_response(reply.content_type, reply.body);
    *res.status_mut() = status;
    anki_web::set_header(&mut res, header::CACHE_CONTROL, "no-store");
    res
}

/// One line per POST in debug builds; `scripts/anki-real-app.sh` greps it.
pub(crate) fn log_post(caller: &str, method: &str, status: u16) {
    if cfg!(debug_assertions) {
        tracing::info!("anki-post caller={caller} method={method} status={status}");
    }
}

/// Tauri handler of the `anki` scheme.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle();
    let pages = Arc::clone(app.state::<Arc<AnkiPages>>().inner());
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());
    tauri::async_runtime::spawn(async move {
        responder.respond(pages.serve(state, request).await);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const INDEX: &str = "<!doctype html>\n<html lang=\"en\">\n\t<head>\n\t\t<meta charset=\"utf-8\" />\n\t\t<meta http-equiv=\"content-security-policy\" content=\"script-src 'self' 'sha256-qxt8up9A9DouldIGIfi5r/23h6vjn6vBDfZPc+rhUmU='\">\n\t</head><body><script>start()</script></body></html>";

    #[test]
    fn index_loses_the_csp_meta_and_gains_the_shim_first() {
        let page = prepare_index(INDEX).unwrap();
        assert!(!page.contains("content-security-policy"));
        assert!(page.contains("<head><script src=\"/_leitor/page-bridge.js\"></script>"));
        let shim = page.find("page-bridge.js").unwrap();
        assert!(shim < page.find("<meta charset").unwrap());
        assert!(page.contains("<script>start()</script>"));
    }

    #[test]
    fn a_modified_index_fails_closed() {
        let changed = INDEX.replace(
            "script-src 'self' 'sha256",
            "script-src 'self' 'unsafe-inline' 'sha256",
        );
        assert!(prepare_index(&changed).is_none());
        assert!(prepare_index("<html><head></head></html>").is_none());
        let no_head = INDEX.replace("<head>", "").replace("</head>", "");
        assert!(prepare_index(&no_head).is_none());
    }

    #[test]
    fn method_names() {
        assert!(is_method_name("getDeckConfigsForUpdate"));
        assert!(!is_method_name(""));
        assert!(!is_method_name("a/b"));
        assert!(!is_method_name("../x"));
        assert!(!is_method_name(&"a".repeat(65)));
    }

    #[test]
    fn csp_lists_the_ui_as_the_only_ancestor() {
        let csp = page_csp(&["tauri://localhost".into()]);
        assert!(csp.ends_with("frame-ancestors tauri://localhost"));
        assert!(csp.contains("connect-src 'self' anki: http://anki.localhost"));
        assert!(!csp.contains("card:"));
    }
}
