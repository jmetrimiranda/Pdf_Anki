//! The `pdf` URI scheme (spec 6.2): `pdf://localhost/render/{docId}/{page}?escala=…&bloco=…&tema=…`
//! (`http://pdf.localhost/…` on Windows) answers with the page as PNG.

use std::sync::Arc;

use core_pdf::{DocHandle, DocumentEngine, PdfError, RenderReq};
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

/// `pdfRenderUrl(docId, page, { scale })` of the web client.
pub fn render_url(doc: DocHandle, page: usize, scale: f32) -> String {
    protocol_url(PDF_SCHEME, &format!("render/{doc}/{page}?escala={scale}"))
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
    let (doc, req) = match parse(request.uri().path(), request.uri().query().unwrap_or("")) {
        Ok(parsed) => parsed,
        Err(bad) => return reply(bad.response()),
    };
    let head_only = request.method() == Method::HEAD;
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());
    tauri::async_runtime::spawn_blocking(move || {
        let res = match state.pdf().render_png(doc, req) {
            Ok(png) => png_response(if head_only { Vec::new() } else { png }),
            Err(e) => {
                tracing::warn!(%doc, page = req.page, code = e.code(), detail = ?e, "pdf render failed");
                error(&e)
            }
        };
        reply(res);
    });
}

/// Why a request never reached the engine.
#[derive(Debug)]
enum BadRequest {
    UnknownRoute,
    Pdf(PdfError),
}

impl From<PdfError> for BadRequest {
    fn from(e: PdfError) -> Self {
        Self::Pdf(e)
    }
}

impl BadRequest {
    fn response(&self) -> Response<Vec<u8>> {
        match self {
            Self::UnknownRoute => text(StatusCode::NOT_FOUND, "Endereço desconhecido."),
            Self::Pdf(e) => error(e),
        }
    }
}

/// `/render/{docId}/{page}` plus its query.
fn parse(path: &str, query: &str) -> Result<(DocHandle, RenderReq), BadRequest> {
    let mut parts = path.trim_matches('/').split('/');
    let (Some("render"), Some(doc), Some(page), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(BadRequest::UnknownRoute);
    };
    let doc: DocHandle = doc.parse()?;
    let page: usize = page
        .parse()
        .map_err(|_| PdfError::InvalidRequest("a página precisa ser um número".into()))?;
    Ok((doc, RenderReq::from_query(page, query)?))
}

fn png_response(png: Vec<u8>) -> Response<Vec<u8>> {
    response(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        // Doc ids restart at 1 on every launch, so a cached image could belong to another
        // document; the engine keeps the in-memory page cache instead (spec 6.2).
        .header(header::CACHE_CONTROL, "no-store")
        .body(png)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn error(e: &PdfError) -> Response<Vec<u8>> {
    let status = StatusCode::from_u16(e.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    text(status, &e.to_string())
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
fn ui_origins<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut origins = vec![
        "tauri://localhost".to_owned(),
        "http://tauri.localhost".to_owned(),
        "https://tauri.localhost".to_owned(),
    ];
    if tauri::is_dev()
        && let Some(url) = &app.config().build.dev_url
    {
        origins.insert(0, url.origin().ascii_serialization());
    }
    origins
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
    use core_pdf::ReadingTheme;

    #[test]
    fn parses_the_render_route() {
        let (doc, req) = parse("/render/7/2", "escala=1.5&bloco=10,20,30,40&tema=sepia").unwrap();
        assert_eq!(doc, DocHandle(7));
        assert_eq!(req.page, 2);
        assert_eq!(req.scale, 1.5);
        assert_eq!(req.tile, Some([10.0, 20.0, 30.0, 40.0]));
        assert_eq!(req.theme, ReadingTheme::Sepia);
        let (_, req) = parse("/render/1/0", "escala=2&bloco=1%2C2%2C3%2C4").unwrap();
        assert_eq!(req.tile, Some([1.0, 2.0, 3.0, 4.0]));
    }

    #[test]
    fn bad_routes_map_to_4xx() {
        let status =
            |path: &str, query: &str| parse(path, query).unwrap_err().response().status().as_u16();
        assert_eq!(status("/render/abc/0", ""), 404);
        assert_eq!(status("/render/1/x", ""), 400);
        assert_eq!(status("/render/1/-1", ""), 400);
        assert_eq!(status("/render/1", ""), 404);
        assert_eq!(status("/other/1/0", ""), 404);
        assert_eq!(status("/render/1/0/extra", ""), 404);
        assert_eq!(status("/render/1/0", "escala=x"), 400);
        assert_eq!(status("/render/1/0", "bloco=1,2"), 400);
        assert_eq!(status("/render/1/0", "tema=azul"), 400);
    }

    #[test]
    fn error_bodies_are_pt_br_text() {
        let res = error(&PdfError::UnknownDocument);
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            String::from_utf8(res.body().clone()).unwrap(),
            "O documento não está aberto."
        );
    }

    #[test]
    fn urls_match_the_web_helper() {
        let url = render_url(DocHandle(3), 0, 2.0);
        if cfg!(windows) {
            assert_eq!(url, "http://pdf.localhost/render/3/0?escala=2");
        } else {
            assert_eq!(url, "pdf://localhost/render/3/0?escala=2");
        }
    }
}
