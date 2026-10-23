//! The `card` URI scheme (spec 8.4): the reviewer page of the sandboxed card iframe, Anki's
//! reviewer assets and the collection media, on an origin of their own.
//!
//! `card://localhost/<path>` (`http://card.localhost/<path>` on Windows):
//!
//! | Path | Answer |
//! |---|---|
//! | `GET _leitor/reviewer.html`, `_leitor/card-bridge.js` | our reviewer page and its shim |
//! | `GET _anki/js/{reviewer,mathjax,webview}.js`, `_anki/js/vendor/mathjax/**`, `_anki/css/{webview,reviewer}.css` | bundled files, `Access-Control-Allow-Origin: *` (fonts and modules from the opaque origin) |
//! | `POST _anki/<method>` | the bridge as [`Caller::Card`]: only [`CARD_METHODS`], else 403 |
//! | `OPTIONS _anki/<card method>` | CORS preflight for the opaque (`null`) origin; anything else 403 |
//! | `GET <file>` | collection media (flat folder), with `UNTRUSTED_MEDIA_CSP` |
//!
//! The iframe has `sandbox="allow-scripts"` (opaque origin, `Origin: null`), no Tauri capability,
//! and talks to the app only through validated `postMessage`s. Its CSP keeps `connect-src` on this
//! scheme, so a card cannot reach `anki://` or Tauri's IPC.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use core_anki::bridge::{CARD_METHODS, Caller, PostReply, PostRequest};
use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::anki_web::{self, AnkiWeb, FileError};
use crate::protocol::scheme_origins;
use crate::protocol_anki::{forbidden, is_method_name, log_post, reply_response};
use crate::state::AppState;

pub const CARD_SCHEME: &str = "card";

/// The reviewer page and its shim, owned by the study package (`src-tauri/app/assets/card/`).
pub const REVIEWER_HTML: &str = include_str!("../assets/card/reviewer.html");
pub const CARD_BRIDGE_JS: &str = include_str!("../assets/card/card-bridge.js");

/// `UNTRUSTED_MEDIA_CSP` of `mediasrv.py:75-100`, verbatim: a deck's `.html`/`.svg` opened
/// directly never runs as an active document.
pub const UNTRUSTED_MEDIA_CSP: &str = "default-src 'none'; script-src 'none'; connect-src 'none'; \
     object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'; \
     style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; media-src 'self'; \
     sandbox allow-same-origin";

/// Where the desktop reviewer also loads passive content from: deck templates and notes may use
/// remote images, audio, fonts and stylesheets (`<img src="https://…">`, `@font-face`), which
/// Anki desktop shows. Isolation does not depend on blocking them: the iframe is sandboxed, the
/// bridge answers only [`CARD_METHODS`] and `connect-src` stays on this scheme.
const REMOTE_PASSIVE: &str = "https: http:";

/// The reviewer page CSP. Deck templates need inline scripts and `eval` (custom scheduling JS).
/// The sandboxed document has an opaque origin, so `'self'` is also spelled out as the scheme
/// (`card:` and `http://card.localhost`): engines differ on what `'self'` means there.
pub fn reviewer_csp(ui_origins: &[String]) -> String {
    let own = crate::protocol::own_sources(CARD_SCHEME);
    let remote = REMOTE_PASSIVE;
    format!(
        "default-src {own} data: blob:; script-src {own} 'unsafe-inline' 'unsafe-eval'; \
         style-src {own} 'unsafe-inline' {remote}; img-src {own} data: blob: {remote}; \
         font-src {own} data: {remote}; media-src {own} blob: {remote}; connect-src {own}; \
         object-src 'none'; frame-ancestors {}",
        ui_origins.join(" ")
    )
}

/// Bundled files a card may load.
pub fn is_card_asset(rel: &str) -> bool {
    matches!(
        rel,
        "js/reviewer.js"
            | "js/mathjax.js"
            | "js/webview.js"
            | "css/webview.css"
            | "css/reviewer.css"
    ) || rel
        .strip_prefix("js/vendor/mathjax/")
        .is_some_and(|rest| !rest.is_empty())
}

/// What a request turned into.
#[derive(Debug)]
pub enum Routed {
    Reply(Response<Vec<u8>>),
    Post(PostRequest),
}

/// The `card` scheme: routing and responses (pure apart from file reads).
pub struct CardFrames {
    web: AnkiWeb,
    media_dir: PathBuf,
    csp: String,
}

impl CardFrames {
    /// `media_dir` is the collection's media folder (it may not exist yet).
    pub fn new(web: AnkiWeb, media_dir: PathBuf, ui_origins: &[String]) -> Self {
        Self {
            web,
            media_dir,
            csp: reviewer_csp(ui_origins),
        }
    }

    pub fn route(&self, req: &Request<Vec<u8>>) -> Routed {
        let raw = anki_web::route_path(req.uri().path());
        let Some(path) = anki_web::decode_path(raw) else {
            return Routed::Reply(FileError::NotFound.response());
        };
        let method = req.method();
        if method == Method::OPTIONS {
            return Routed::Reply(preflight(&path));
        }
        if method == Method::POST {
            return route_post(req, &path);
        }
        if method != Method::GET && method != Method::HEAD {
            return Routed::Reply(anki_web::text(
                StatusCode::METHOD_NOT_ALLOWED,
                "Método não permitido.",
            ));
        }
        let head = method == Method::HEAD;
        let range = req
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok());
        let mut res = self.get(&path, range, head);
        if head {
            res.body_mut().clear();
        }
        Routed::Reply(res)
    }

    fn get(&self, path: &str, range: Option<&str>, head: bool) -> Response<Vec<u8>> {
        match path {
            "_leitor/reviewer.html" => {
                if self.web.root().is_none() {
                    return anki_web::missing_page();
                }
                let mut res = anki_web::bytes_response(
                    "text/html; charset=utf-8",
                    REVIEWER_HTML.as_bytes().to_vec(),
                );
                anki_web::set_header(&mut res, header::CONTENT_SECURITY_POLICY, &self.csp);
                anki_web::set_header(&mut res, header::CACHE_CONTROL, "no-cache");
                return res;
            }
            "_leitor/card-bridge.js" => {
                let mut res = anki_web::bytes_response(
                    "application/javascript",
                    CARD_BRIDGE_JS.as_bytes().to_vec(),
                );
                anki_web::set_header(&mut res, header::CACHE_CONTROL, "no-cache");
                return res;
            }
            _ => {}
        }
        if let Some(rel) = path.strip_prefix("_anki/") {
            if !is_card_asset(rel) {
                return FileError::NotFound.response();
            }
            let mut res = match self.web.read(rel) {
                Ok(bytes) => anki_web::bytes_response(anki_web::mime_for_path(rel), bytes),
                Err(e) => e.response(),
            };
            anki_web::set_header(&mut res, header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            return res;
        }
        // Relative media links resolve against the reviewer page (`/_leitor/x.png`) when a page
        // has no `<base href="/">`: serve the same media file there.
        let name = path.strip_prefix("_leitor/").unwrap_or(path);
        self.media(name, range, head)
    }

    /// A collection media file: flat folder, name checked, `UNTRUSTED_MEDIA_CSP`.
    fn media(&self, name: &str, range: Option<&str>, head: bool) -> Response<Vec<u8>> {
        let res = match media_path(&self.media_dir, name) {
            Ok(path) => anki_web::file_response(&path, anki_web::mime_for_path(name), range, head)
                .unwrap_or_else(FileError::response),
            Err(e) => {
                // Never the 503 page here: a missing asset folder says nothing about media.
                if e == FileError::Unavailable {
                    FileError::NotFound.response()
                } else {
                    e.response()
                }
            }
        };
        let mut res = res;
        anki_web::set_header(
            &mut res,
            header::CONTENT_SECURITY_POLICY,
            UNTRUSTED_MEDIA_CSP,
        );
        let cache = match name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()) {
            Some(e) if e == "css" => "max-age=10",
            Some(e) if e == "js" => "max-age=0",
            _ => "max-age=3600",
        };
        if res.status().is_success() {
            anki_web::set_header(&mut res, header::CACHE_CONTROL, cache);
        }
        // Card `@font-face` and the like load with CORS from the opaque (`null`) origin.
        anki_web::set_header(&mut res, header::ACCESS_CONTROL_ALLOW_ORIGIN, "null");
        res
    }

    /// Turns a bridge reply into the HTTP response (readable by the opaque card origin).
    pub fn post_response(&self, req: &PostRequest, reply: PostReply) -> Response<Vec<u8>> {
        log_post("card", &req.method, reply.status);
        card_post_response(reply)
    }

    /// Routes and answers a request (file reads on the blocking pool).
    pub async fn serve(
        self: Arc<Self>,
        state: Arc<AppState>,
        req: Request<Vec<u8>>,
    ) -> Response<Vec<u8>> {
        let routed = {
            let frames = Arc::clone(&self);
            tauri::async_runtime::spawn_blocking(move || frames.route(&req)).await
        };
        match routed {
            Ok(Routed::Reply(res)) => res,
            Ok(Routed::Post(post)) => {
                let reply = crate::anki::bridge_post(state, Caller::Card, post.clone()).await;
                self.post_response(&post, reply)
            }
            Err(e) => {
                tracing::error!(%e, "card protocol task failed");
                anki_web::text(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno.")
            }
        }
    }
}

/// A media file name (no folders: Anki's media folder is flat) inside `media_dir`.
pub fn media_path(media_dir: &Path, name: &str) -> Result<PathBuf, FileError> {
    if name.contains('/') || !anki_web::is_safe_rel(name) {
        return Err(FileError::Forbidden);
    }
    let root = media_dir.canonicalize().map_err(|_| FileError::NotFound)?;
    anki_web::safe_join(&root, name)
}

fn route_post(req: &Request<Vec<u8>>, path: &str) -> Routed {
    let name = path.strip_prefix("_anki/").unwrap_or_default();
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
    let allowed = is_method_name(name) && CARD_METHODS.contains(&name);
    let origin_ok = match post.origin.as_deref() {
        None | Some("null") => true,
        Some(o) => scheme_origins(CARD_SCHEME).iter().any(|c| c == o),
    };
    let type_ok = post.content_type.as_deref() == Some(core_anki::bridge::CONTENT_TYPE);
    if !(allowed && origin_ok && type_ok) {
        log_post("card", name, 403);
        return Routed::Reply(card_post_response(forbidden()));
    }
    Routed::Post(post)
}

fn card_post_response(reply: PostReply) -> Response<Vec<u8>> {
    let mut res = reply_response(reply);
    anki_web::set_header(&mut res, header::ACCESS_CONTROL_ALLOW_ORIGIN, "null");
    res
}

/// CORS preflight of the opaque card origin: only for the four card methods.
fn preflight(path: &str) -> Response<Vec<u8>> {
    let allowed = path
        .strip_prefix("_anki/")
        .is_some_and(|m| CARD_METHODS.contains(&m));
    if !allowed {
        return anki_web::text(StatusCode::FORBIDDEN, "Acesso negado.");
    }
    let mut res = Response::new(Vec::new());
    *res.status_mut() = StatusCode::NO_CONTENT;
    anki_web::set_header(&mut res, header::ACCESS_CONTROL_ALLOW_ORIGIN, "null");
    anki_web::set_header(&mut res, header::ACCESS_CONTROL_ALLOW_METHODS, "POST");
    anki_web::set_header(
        &mut res,
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "content-type, anki-op-changes",
    );
    anki_web::set_header(&mut res, header::ACCESS_CONTROL_MAX_AGE, "600");
    res
}

/// Tauri handler of the `card` scheme.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle();
    let frames = Arc::clone(app.state::<Arc<CardFrames>>().inner());
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());
    tauri::async_runtime::spawn(async move {
        responder.respond(frames.serve(state, request).await);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_assets_are_a_short_list() {
        assert!(is_card_asset("js/reviewer.js"));
        assert!(is_card_asset("js/vendor/mathjax/tex-chtml-full.js"));
        assert!(is_card_asset("css/reviewer.css"));
        assert!(!is_card_asset("js/editor.js"));
        assert!(!is_card_asset("js/vendor/mathjax/"));
        assert!(!is_card_asset("sveltekit/index.html"));
    }

    #[test]
    fn reviewer_csp_spells_out_the_card_origin() {
        let csp = reviewer_csp(&["tauri://localhost".into()]);
        assert!(csp.contains("connect-src 'self' card: http://card.localhost"));
        assert!(csp.contains("'unsafe-eval'"));
        assert!(!csp.contains("anki:"));
        assert!(!csp.contains("ipc:"));
        assert!(csp.ends_with("frame-ancestors tauri://localhost"));
    }

    /// Remote images, audio, fonts and stylesheets load like in the desktop reviewer; scripts
    /// and requests (`fetch`/XHR) stay on the card scheme.
    #[test]
    fn reviewer_csp_allows_remote_passive_content_only() {
        let csp = reviewer_csp(&["tauri://localhost".into()]);
        let remote = |name: &str| {
            let d = csp
                .split(';')
                .map(str::trim)
                .find(|d| d.split_whitespace().next() == Some(name))
                .unwrap_or_else(|| panic!("no {name} in {csp}"));
            let sources: Vec<&str> = d.split_whitespace().collect();
            (sources.contains(&"https:"), sources.contains(&"http:"))
        };
        for name in ["img-src", "media-src", "font-src", "style-src"] {
            assert_eq!(remote(name), (true, true), "{name} in {csp}");
        }
        for name in ["script-src", "connect-src", "default-src"] {
            assert_eq!(remote(name), (false, false), "{name} in {csp}");
        }
    }

    #[test]
    fn preflight_only_for_card_methods() {
        assert_eq!(preflight("_anki/i18nResources").status(), 204);
        assert_eq!(preflight("_anki/addNote").status(), 403);
        assert_eq!(preflight("x").status(), 403);
    }
}
