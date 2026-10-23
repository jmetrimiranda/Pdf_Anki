//! The `pdf` URI scheme (spec 15): only library covers.
//! `GET pdf://localhost/cover/{book_uid}?v={file_version}` (`http://pdf.localhost/…` on Windows)
//! answers with the cover PNG of the book's current file version. The reader itself is PdfCraft,
//! served as a static file of the UI under `/pdfcraft/`.

use std::sync::Arc;

use tauri::http::{Method, Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::AppState;

pub const PDF_SCHEME: &str = "pdf";

/// Same rule as the web helper `protocolUrl` (web/src/lib/protocol.ts): WebView2 and Android
/// cannot register schemes, so Tauri serves them as `http://<scheme>.localhost/`.
pub fn protocol_url(scheme: &str, path: &str) -> String {
    let path = path.trim_start_matches('/');
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{scheme}.localhost/{path}")
    } else {
        format!("{scheme}://localhost/{path}")
    }
}

/// `pdfCoverUrl(bookUid, fileVersion)` of the web client.
pub fn cover_url(book_uid: &str, file_version: u32) -> String {
    protocol_url(PDF_SCHEME, &format!("cover/{book_uid}?v={file_version}"))
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle();
    let origin = cors_origin(app, request.headers().get(header::ORIGIN));
    let reply = move |res: Response<Vec<u8>>| responder.respond(with_cors(res, &origin));

    match *request.method() {
        Method::OPTIONS => return reply(preflight()),
        Method::GET | Method::HEAD => {}
        _ => {
            return reply(text(
                StatusCode::METHOD_NOT_ALLOWED,
                "Método não permitido.",
            ));
        }
    }
    let route = match parse(request.uri().path()) {
        Ok(route) => route,
        Err(bad) => return reply(bad.response()),
    };
    let head_only = request.method() == Method::HEAD;
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());
    tauri::async_runtime::spawn_blocking(move || {
        let res = match route {
            Route::Cover(uid) => match state.cover_png(&uid) {
                Ok(Some(png)) => png_response(if head_only { Vec::new() } else { png }),
                Ok(None) => not_found_cover(),
                Err(e) => {
                    tracing::warn!(book_uid = %uid, code = %e.code, "cover failed");
                    not_found_cover()
                }
            },
        };
        reply(res);
    });
}

#[derive(Debug, PartialEq, Eq)]
enum Route {
    Cover(String),
}

/// Why a request never reached the library.
#[derive(Debug, PartialEq, Eq)]
enum BadRoute {
    UnknownRoute,
    NoCover,
}

impl BadRoute {
    fn response(&self) -> Response<Vec<u8>> {
        match self {
            Self::UnknownRoute => text(StatusCode::NOT_FOUND, "Endereço desconhecido."),
            Self::NoCover => not_found_cover(),
        }
    }
}

/// `/cover/{book_uid}`. The `v` query only busts the cache; the current version is served.
fn parse(path: &str) -> Result<Route, BadRoute> {
    let mut parts = path.trim_matches('/').split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("cover"), Some(uid), None) if core_store::is_valid_book_uid(uid) => {
            Ok(Route::Cover(uid.to_owned()))
        }
        (Some("cover"), Some(_), None) => Err(BadRoute::NoCover),
        _ => Err(BadRoute::UnknownRoute),
    }
}

fn not_found_cover() -> Response<Vec<u8>> {
    text(StatusCode::NOT_FOUND, "Capa não encontrada.")
}

fn png_response(png: Vec<u8>) -> Response<Vec<u8>> {
    response(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        // The URL carries `?v={file_version}`, so a cached cover never outlives its version.
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .body(png)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn text(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    response(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn preflight() -> Response<Vec<u8>> {
    response(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn response(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder().status(status)
}

fn with_cors(mut res: Response<Vec<u8>>, origin: &str) -> Response<Vec<u8>> {
    let headers = res.headers_mut();
    if let Ok(v) = origin.parse() {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
    res
}

/// The UI origins: the bundled app on every platform and, in development, the dev server.
pub(crate) fn ui_origins<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let dev_url = if tauri::is_dev() {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    ui_origins_with(dev_url.map(|u| u.origin().ascii_serialization()))
}

/// [`ui_origins`] with the dev server origin given explicitly (first when present).
pub fn ui_origins_with(dev_origin: Option<String>) -> Vec<String> {
    let mut origins = vec![
        "tauri://localhost".to_owned(),
        "http://tauri.localhost".to_owned(),
        "https://tauri.localhost".to_owned(),
    ];
    if let Some(origin) = dev_origin {
        origins.insert(0, origin);
    }
    origins
}

/// CSP sources for "this scheme": `'self'` plus the scheme and its Windows/Android origin, spelled
/// out because sandboxed (opaque-origin) documents and some engines do not match custom schemes
/// with `'self'`.
pub fn own_sources(scheme: &str) -> String {
    format!("'self' {scheme}: http://{scheme}.localhost https://{scheme}.localhost")
}

/// The origins a custom scheme is served from: `<scheme>://localhost` (Linux, macOS, iOS) and
/// `http(s)://<scheme>.localhost` (Windows, Android).
pub fn scheme_origins(scheme: &str) -> [String; 3] {
    [
        format!("{scheme}://localhost"),
        format!("http://{scheme}.localhost"),
        format!("https://{scheme}.localhost"),
    ]
}

/// Echoes the request origin when it is the UI; otherwise answers with this platform's UI
/// origin, which any other page will not match.
fn cors_origin<R: Runtime>(app: &AppHandle<R>, origin: Option<&header::HeaderValue>) -> String {
    let origins = ui_origins(app);
    if let Some(o) = origin.and_then(|o| o.to_str().ok())
        && origins.iter().any(|allowed| allowed == o)
    {
        return o.to_owned();
    }
    if tauri::is_dev() && app.config().build.dev_url.is_some() {
        return origins[0].clone();
    }
    if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost".to_owned()
    } else {
        "tauri://localhost".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn parses_the_cover_route() {
        assert_eq!(
            parse(&format!("/cover/{UID}")).unwrap(),
            Route::Cover(UID.into())
        );
        assert_eq!(
            parse(&format!("cover/{UID}/")).unwrap(),
            Route::Cover(UID.into())
        );
    }

    #[test]
    fn bad_routes_map_to_404_text() {
        let status = |path: &str| parse(path).unwrap_err().response().status().as_u16();
        assert_eq!(status("/cover/abc"), 404);
        assert_eq!(status(&format!("/cover/{}", UID.to_uppercase())), 404);
        assert_eq!(status(&format!("/cover/{UID}/extra")), 404);
        assert_eq!(status("/render/1/0"), 404);
        assert_eq!(status("/"), 404);
        let res = parse("/cover/x").unwrap_err().response();
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            String::from_utf8(res.body().clone()).unwrap(),
            "Capa não encontrada."
        );
    }

    #[test]
    fn covers_are_cached_per_version() {
        let res = png_response(vec![1, 2]);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
        assert!(
            res.headers()[header::CACHE_CONTROL]
                .to_str()
                .unwrap()
                .contains("immutable")
        );
        let res = with_cors(preflight(), "tauri://localhost");
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "tauri://localhost"
        );
    }

    #[test]
    fn urls_match_the_web_helper() {
        let url = cover_url(UID, 2);
        if cfg!(windows) {
            assert_eq!(url, format!("http://pdf.localhost/cover/{UID}?v=2"));
        } else {
            assert_eq!(url, format!("pdf://localhost/cover/{UID}?v=2"));
        }
    }
}
