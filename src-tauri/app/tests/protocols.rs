//! The `anki` and `card` protocols without a webview (spec 8.3, 8.4, 18): routing, CSPs, CORS,
//! path safety and the card whitelist.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use leitor_app::AppState;
use leitor_app::anki_web::{AnkiWeb, MISSING_MESSAGE};
use leitor_app::protocol_anki::{self, AnkiPages};
use leitor_app::protocol_card::{self, CardFrames, UNTRUSTED_MEDIA_CSP};
use tauri::http::{Request, Response, header};

const INDEX: &str = r#"<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta http-equiv="content-security-policy" content="script-src 'self' 'sha256-qxt8up9A9DouldIGIfi5r/23h6vjn6vBDfZPc+rhUmU='">
		<link rel="preload" as="script" crossorigin="anonymous" href="/_app/immutable/entry/start.mjs">
	</head>
	<body><div style="display: contents"><script>{ start(); }</script></div></body>
</html>
"#;

const UI: &str = "tauri://localhost";

/// A small stand-in for `src-tauri/resources/anki-web/`.
fn fake_web(dir: &Path) -> PathBuf {
    let web = dir.join("anki-web");
    let files: &[(&str, &[u8])] = &[
        ("sveltekit/index.html", INDEX.as_bytes()),
        ("sveltekit/_app/immutable/entry/start.mjs", b"export {}"),
        ("sveltekit/_app/immutable/assets/font.woff2", b"wOF2"),
        ("sveltekit/_app/version.json", b"{\"version\":\"1\"}"),
        ("js/reviewer.js", b"/* reviewer */"),
        ("js/mathjax.js", b"/* mathjax */"),
        ("js/editor.js", b"/* editor */"),
        ("js/vendor/mathjax/tex-chtml-full.js", b"/* tex */"),
        (
            "js/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Main-Regular.woff",
            b"wOFF",
        ),
        ("css/reviewer.css", b"body{}"),
        ("imgs/favicon.ico", b"ico"),
    ];
    for (rel, bytes) in files {
        let path = web.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    std::fs::write(dir.join("secret.txt"), b"secret").unwrap();
    web
}

fn pages(dir: &Path) -> Arc<AnkiPages> {
    Arc::new(AnkiPages::new(
        AnkiWeb::at(&fake_web(dir)),
        vec![UI.to_owned()],
    ))
}

fn req(method: &str, uri: &str) -> tauri::http::request::Builder {
    Request::builder().method(method).uri(uri)
}

fn get(uri: &str) -> Request<Vec<u8>> {
    req("GET", uri).body(Vec::new()).unwrap()
}

fn post(uri: &str, content_type: Option<&str>, origin: Option<&str>) -> Request<Vec<u8>> {
    let mut b = req("POST", uri);
    if let Some(ct) = content_type {
        b = b.header(header::CONTENT_TYPE, ct);
    }
    if let Some(o) = origin {
        b = b.header(header::ORIGIN, o);
    }
    b.body(Vec::new()).unwrap()
}

fn anki_reply(pages: &AnkiPages, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match pages.route(request) {
        protocol_anki::Routed::Reply(res) => res,
        protocol_anki::Routed::Post(p) => panic!("unexpected bridge call {}", p.method),
    }
}

fn card_reply(frames: &CardFrames, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match frames.route(request) {
        protocol_card::Routed::Reply(res) => res,
        protocol_card::Routed::Post(p) => panic!("unexpected bridge call {}", p.method),
    }
}

fn body(res: &Response<Vec<u8>>) -> String {
    String::from_utf8_lossy(res.body()).into_owned()
}

fn header_of(res: &Response<Vec<u8>>, name: header::HeaderName) -> String {
    res.headers()
        .get(name)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default()
}

fn no_cors(res: &Response<Vec<u8>>) {
    assert!(
        !res.headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        "anki responses never carry CORS headers"
    );
}

#[test]
fn sveltekit_routes_serve_the_prepared_index() {
    let dir = tempfile::tempdir().unwrap();
    let pages = pages(dir.path());
    for uri in [
        "anki://localhost/deck-options/123",
        "anki://localhost/graphs?cb=17",
        "anki://localhost/card-info/5",
        "anki://localhost/congrats",
        "anki://localhost/change-notetype/9",
        "anki://localhost/import-anki-package/%2Ftmp%2Fx.apkg",
        "anki://localhost/image-occlusion/12",
        "http://anki.localhost/deck-options/1",
        // `_app/version.json` has no "immutable": Anki's fallback serves the index.
        "anki://localhost/_app/version.json",
        "anki://localhost/_app/env.js",
    ] {
        let res = anki_reply(&pages, &get(uri));
        assert_eq!(res.status(), 200, "{uri}");
        assert_eq!(
            header_of(&res, header::CONTENT_TYPE),
            "text/html; charset=utf-8"
        );
        let html = body(&res);
        assert!(!html.contains("content-security-policy"), "{uri}");
        assert!(
            html.contains("<head><script src=\"/_leitor/page-bridge.js\"></script>"),
            "{uri}: shim injected as the first child of <head>"
        );
        let csp = header_of(&res, header::CONTENT_SECURITY_POLICY);
        assert!(csp.contains("script-src 'self'"), "{csp}");
        assert!(csp.contains("connect-src 'self' anki:"), "{csp}");
        assert!(csp.ends_with(&format!("frame-ancestors {UI}")), "{csp}");
        no_cors(&res);
    }
}

#[test]
fn immutable_files_and_assets() {
    let dir = tempfile::tempdir().unwrap();
    let pages = pages(dir.path());
    let res = anki_reply(
        &pages,
        &get("anki://localhost/_app/immutable/entry/start.mjs"),
    );
    assert_eq!(res.status(), 200);
    assert_eq!(
        header_of(&res, header::CONTENT_TYPE),
        "application/javascript"
    );
    assert_eq!(header_of(&res, header::CACHE_CONTROL), "max-age=31536000");
    assert_eq!(body(&res), "export {}");
    no_cors(&res);

    let res = anki_reply(
        &pages,
        &get("anki://localhost/_app/immutable/assets/font.woff2"),
    );
    assert_eq!(header_of(&res, header::CONTENT_TYPE), "font/woff2");

    let res = anki_reply(&pages, &get("anki://localhost/_leitor/page-bridge.js"));
    assert_eq!(res.status(), 200);
    assert_eq!(body(&res), protocol_anki::PAGE_BRIDGE_JS);

    let res = anki_reply(&pages, &get("anki://localhost/_anki/js/reviewer.js"));
    assert_eq!(res.status(), 200);
    no_cors(&res);

    let res = anki_reply(&pages, &get("anki://localhost/favicon.ico"));
    assert_eq!(header_of(&res, header::CONTENT_TYPE), "image/x-icon");

    let head = req("HEAD", "anki://localhost/deck-options/1")
        .body(Vec::new())
        .unwrap();
    let res = anki_reply(&pages, &head);
    assert_eq!(res.status(), 200);
    assert!(res.body().is_empty());
}

#[test]
fn unknown_and_unsafe_paths() {
    let dir = tempfile::tempdir().unwrap();
    let pages = pages(dir.path());
    let status = |uri: &str| {
        let res = anki_reply(&pages, &get(uri));
        no_cors(&res);
        res.status().as_u16()
    };
    // Not reused: our own editor; preferences are not ours to change.
    assert_eq!(status("anki://localhost/editor"), 404);
    assert_eq!(status("anki://localhost/preferences"), 404);
    assert_eq!(status("anki://localhost/"), 404);
    assert_eq!(status("anki://localhost/collection.anki2"), 404);
    assert_eq!(status("anki://localhost/_anki/sveltekit/index.html"), 404);
    assert_eq!(status("anki://localhost/_app/immutable/missing.mjs"), 404);
    for bad in [
        "anki://localhost/_app/immutable/../../../secret.txt",
        "anki://localhost/_app/immutable/%2e%2e/%2e%2e/%2e%2e/secret.txt",
        "anki://localhost/_app/immutable/..%2f..%2f..%2fsecret.txt",
        "anki://localhost/_anki/js/..%5c..%5csecret.txt",
        "anki://localhost/_anki/js/%2Fetc%2Fpasswd",
        "anki://localhost/_app/immutable/entry",
    ] {
        let s = status(bad);
        assert!(s == 403 || s == 404, "{bad}: {s}");
    }
}

#[test]
fn a_modified_index_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let web = fake_web(dir.path());
    std::fs::write(
        web.join("sveltekit/index.html"),
        INDEX.replace(
            "script-src 'self' 'sha256",
            "script-src 'self' 'unsafe-eval' 'sha256",
        ),
    )
    .unwrap();
    let pages = AnkiPages::new(AnkiWeb::at(&web), vec![UI.into()]);
    let res = anki_reply(&pages, &get("anki://localhost/deck-options/1"));
    assert_eq!(res.status(), 500);
    assert!(!body(&res).contains("<script"));
}

#[test]
fn posts_need_the_binary_content_type_and_the_anki_origin() {
    let dir = tempfile::tempdir().unwrap();
    let pages = pages(dir.path());
    let uri = "anki://localhost/_anki/getDeckNames";
    for (ct, origin) in [
        (None, None),
        (Some("application/octet-stream"), None),
        (Some("application/binary; charset=x"), None),
        (Some("text/plain"), Some("anki://localhost")),
        (Some("application/binary"), Some("tauri://localhost")),
        (Some("application/binary"), Some("null")),
        (Some("application/binary"), Some("card://localhost")),
        (Some("application/binary"), Some("http://evil.example")),
    ] {
        let res = anki_reply(&pages, &post(uri, ct, origin));
        assert_eq!(res.status(), 403, "{ct:?} {origin:?}");
        no_cors(&res);
    }
    for origin in [
        None,
        Some("anki://localhost"),
        Some("http://anki.localhost"),
    ] {
        match pages.route(&post(uri, Some("application/binary"), origin)) {
            protocol_anki::Routed::Post(p) => {
                assert_eq!(p.method, "getDeckNames");
                assert_eq!(p.content_type.as_deref(), Some("application/binary"));
                assert_eq!(p.origin.as_deref(), origin);
            }
            protocol_anki::Routed::Reply(r) => panic!("refused {origin:?}: {}", r.status()),
        }
    }
    let res = anki_reply(
        &pages,
        &post(
            "anki://localhost/_anki/a/b",
            Some("application/binary"),
            None,
        ),
    );
    assert_eq!(res.status(), 404);
    let res = anki_reply(
        &pages,
        &post("anki://localhost/graphs", Some("application/binary"), None),
    );
    assert_eq!(res.status(), 404);
}

#[test]
fn options_on_anki_is_forbidden() {
    let dir = tempfile::tempdir().unwrap();
    let pages = pages(dir.path());
    for path in [
        "_anki/getDeckNames",
        "_anki/i18nResources",
        "deck-options/1",
    ] {
        let r = req("OPTIONS", &format!("anki://localhost/{path}"))
            .header(header::ORIGIN, "tauri://localhost")
            .header("access-control-request-method", "POST")
            .body(Vec::new())
            .unwrap();
        let res = anki_reply(&pages, &r);
        assert_eq!(res.status(), 403);
        no_cors(&res);
    }
}

#[test]
fn page_posts_reach_the_bridge() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().join("data")));
    let pages = pages(dir.path());
    let r = req("POST", "anki://localhost/_anki/i18nResources")
        .header(header::CONTENT_TYPE, "application/binary")
        .header(header::ORIGIN, "anki://localhost")
        .body(Vec::new())
        .unwrap();
    let res = tauri::async_runtime::block_on(Arc::clone(&pages).serve(Arc::clone(&state), r));
    assert_eq!(res.status(), 200);
    assert_eq!(header_of(&res, header::CONTENT_TYPE), "application/binary");
    assert!(!res.body().is_empty());
    no_cors(&res);
    // A method Anki does not expose: 404 from the bridge.
    let r = post(
        "anki://localhost/_anki/openCollection",
        Some("application/binary"),
        None,
    );
    let res = tauri::async_runtime::block_on(Arc::clone(&pages).serve(Arc::clone(&state), r));
    assert_eq!(res.status(), 404);
    no_cors(&res);
    state.shutdown();
}

#[test]
fn page_posts_can_be_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().join("data")));
    let rec = dir.path().join("rec");
    let pages = Arc::new(
        AnkiPages::new(AnkiWeb::at(&fake_web(dir.path())), vec![UI.into()])
            .recording_to(rec.clone()),
    );
    let send = |body: &[u8]| {
        let r = req("POST", "anki://localhost/_anki/getDeckNames")
            .header(header::CONTENT_TYPE, "application/binary")
            .header("anki-op-changes", "1")
            .body(body.to_vec())
            .unwrap();
        tauri::async_runtime::block_on(Arc::clone(&pages).serve(Arc::clone(&state), r))
    };
    assert!(send(&[0x08, 0x01]).status().is_success());
    assert!(send(&[0x10, 0x01]).status().is_success());
    assert_eq!(
        std::fs::read(rec.join("getDeckNames.bin")).unwrap(),
        vec![0x08, 0x01],
        "only the first body is kept"
    );
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(rec.join("getDeckNames.json")).unwrap()).unwrap();
    assert_eq!(meta["opChanges"], "1");
    state.shutdown();
}

fn frames(dir: &Path, web: AnkiWeb) -> (Arc<CardFrames>, PathBuf) {
    let media = dir.join("media");
    std::fs::create_dir_all(&media).unwrap();
    std::fs::write(media.join("foto 1.png"), b"\x89PNG....").unwrap();
    std::fs::write(media.join("som.wav"), (0u8..100).collect::<Vec<_>>()).unwrap();
    std::fs::write(media.join("_estilo.css"), b"b{}").unwrap();
    std::fs::write(media.join("x.html"), b"<script>alert(1)</script>").unwrap();
    std::fs::create_dir_all(media.join("pasta")).unwrap();
    (
        Arc::new(CardFrames::new(web, media.clone(), &[UI.to_owned()])),
        media,
    )
}

#[test]
fn card_posts_are_limited_to_four_methods() {
    let dir = tempfile::tempdir().unwrap();
    let (frames, _) = frames(dir.path(), AnkiWeb::at(&fake_web(dir.path())));
    for m in [
        "addNote",
        "importAnkiPackage",
        "getDeckNames",
        "updateDeckConfigs",
        "nope",
        "a%2Fb",
    ] {
        let res = card_reply(
            &frames,
            &post(
                &format!("card://localhost/_anki/{m}"),
                Some("application/binary"),
                Some("null"),
            ),
        );
        assert_eq!(res.status(), 403, "{m}");
        assert_eq!(header_of(&res, header::ACCESS_CONTROL_ALLOW_ORIGIN), "null");
    }
    // Right method, wrong content type or a foreign origin.
    for (ct, origin) in [
        (Some("text/plain"), Some("null")),
        (None, Some("null")),
        (Some("application/binary"), Some("tauri://localhost")),
        (Some("application/binary"), Some("anki://localhost")),
    ] {
        let res = card_reply(
            &frames,
            &post("card://localhost/_anki/i18nResources", ct, origin),
        );
        assert_eq!(res.status(), 403, "{ct:?} {origin:?}");
    }
    for m in core_anki::bridge::CARD_METHODS {
        assert!(matches!(
            frames.route(&post(
                &format!("card://localhost/_anki/{m}"),
                Some("application/binary"),
                Some("null"),
            )),
            protocol_card::Routed::Post(_)
        ));
    }
}

#[test]
fn card_i18n_resources_answer_200_for_the_opaque_origin() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().join("data")));
    let (frames, _) = frames(dir.path(), AnkiWeb::at(&fake_web(dir.path())));
    let res = tauri::async_runtime::block_on(Arc::clone(&frames).serve(
        Arc::clone(&state),
        post(
            "card://localhost/_anki/i18nResources",
            Some("application/binary"),
            Some("null"),
        ),
    ));
    assert_eq!(res.status(), 200);
    assert_eq!(header_of(&res, header::ACCESS_CONTROL_ALLOW_ORIGIN), "null");
    assert!(!res.body().is_empty());
    let res = tauri::async_runtime::block_on(Arc::clone(&frames).serve(
        Arc::clone(&state),
        post(
            "card://localhost/_anki/addNote",
            Some("application/binary"),
            Some("null"),
        ),
    ));
    assert_eq!(res.status(), 403);
    state.shutdown();
}

#[test]
fn card_preflight() {
    let dir = tempfile::tempdir().unwrap();
    let (frames, _) = frames(dir.path(), AnkiWeb::at(&fake_web(dir.path())));
    let options = |m: &str| {
        card_reply(
            &frames,
            &req("OPTIONS", &format!("card://localhost/_anki/{m}"))
                .header(header::ORIGIN, "null")
                .header("access-control-request-method", "POST")
                .body(Vec::new())
                .unwrap(),
        )
    };
    for m in core_anki::bridge::CARD_METHODS {
        let res = options(m);
        assert_eq!(res.status(), 204, "{m}");
        assert_eq!(header_of(&res, header::ACCESS_CONTROL_ALLOW_ORIGIN), "null");
        assert_eq!(
            header_of(&res, header::ACCESS_CONTROL_ALLOW_METHODS),
            "POST"
        );
        assert_eq!(
            header_of(&res, header::ACCESS_CONTROL_ALLOW_HEADERS),
            "content-type, anki-op-changes"
        );
    }
    let res = options("addNote");
    assert_eq!(res.status(), 403);
    assert!(
        !res.headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
    assert_eq!(
        card_reply(
            &frames,
            &req("OPTIONS", "card://localhost/foto.png")
                .body(Vec::new())
                .unwrap()
        )
        .status(),
        403
    );
}

#[test]
fn card_page_assets_and_media() {
    let dir = tempfile::tempdir().unwrap();
    let (frames, _) = frames(dir.path(), AnkiWeb::at(&fake_web(dir.path())));

    let res = card_reply(&frames, &get("card://localhost/_leitor/reviewer.html"));
    assert_eq!(res.status(), 200);
    assert_eq!(body(&res), protocol_card::REVIEWER_HTML);
    let csp = header_of(&res, header::CONTENT_SECURITY_POLICY);
    assert!(csp.contains("'unsafe-eval'"), "{csp}");
    assert!(
        csp.contains("connect-src 'self' card: http://card.localhost"),
        "{csp}"
    );
    assert!(!csp.contains("anki:") && !csp.contains("ipc:"), "{csp}");
    assert!(csp.ends_with(&format!("frame-ancestors {UI}")));

    let res = card_reply(&frames, &get("card://localhost/_leitor/card-bridge.js"));
    assert_eq!(body(&res), protocol_card::CARD_BRIDGE_JS);
    assert_eq!(
        header_of(&res, header::CONTENT_TYPE),
        "application/javascript"
    );

    for asset in [
        "_anki/js/reviewer.js",
        "_anki/js/mathjax.js",
        "_anki/js/vendor/mathjax/tex-chtml-full.js",
        "_anki/js/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Main-Regular.woff",
        "_anki/css/reviewer.css",
    ] {
        let res = card_reply(&frames, &get(&format!("card://localhost/{asset}")));
        assert_eq!(res.status(), 200, "{asset}");
        assert_eq!(header_of(&res, header::ACCESS_CONTROL_ALLOW_ORIGIN), "*");
    }
    let woff = card_reply(
        &frames,
        &get(
            "card://localhost/_anki/js/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Main-Regular.woff",
        ),
    );
    assert_eq!(header_of(&woff, header::CONTENT_TYPE), "font/woff");
    // Only the reviewer's assets: not the editor, not the SvelteKit pages.
    for other in [
        "_anki/js/editor.js",
        "_anki/sveltekit/index.html",
        "_anki/imgs/favicon.ico",
    ] {
        assert_eq!(
            card_reply(&frames, &get(&format!("card://localhost/{other}"))).status(),
            404,
            "{other}"
        );
    }

    // Media at the origin root (and next to the reviewer page, for relative links).
    for uri in [
        "card://localhost/foto%201.png",
        "card://localhost/_leitor/foto%201.png",
    ] {
        let res = card_reply(&frames, &get(uri));
        assert_eq!(res.status(), 200, "{uri}");
        assert_eq!(header_of(&res, header::CONTENT_TYPE), "image/png");
        assert_eq!(
            header_of(&res, header::CONTENT_SECURITY_POLICY),
            UNTRUSTED_MEDIA_CSP
        );
        assert_eq!(header_of(&res, header::CACHE_CONTROL), "max-age=3600");
    }
    let res = card_reply(&frames, &get("card://localhost/_estilo.css"));
    assert_eq!(header_of(&res, header::CACHE_CONTROL), "max-age=10");
    let res = card_reply(&frames, &get("card://localhost/x.html"));
    assert_eq!(header_of(&res, header::CONTENT_TYPE), "text/html");
    assert!(header_of(&res, header::CONTENT_SECURITY_POLICY).contains("script-src 'none'"));

    // Audio seeking.
    let r = req("GET", "card://localhost/som.wav")
        .header(header::RANGE, "bytes=10-19")
        .body(Vec::new())
        .unwrap();
    let res = card_reply(&frames, &r);
    assert_eq!(res.status(), 206);
    assert_eq!(header_of(&res, header::CONTENT_TYPE), "audio/wav");
    assert_eq!(res.body(), &(10u8..20).collect::<Vec<_>>());
    assert_eq!(header_of(&res, header::CONTENT_RANGE), "bytes 10-19/100");
}

#[test]
fn card_media_never_leaves_the_media_folder() {
    let dir = tempfile::tempdir().unwrap();
    let (frames, media) = frames(dir.path(), AnkiWeb::at(&fake_web(dir.path())));
    std::fs::write(dir.path().join("fora.png"), b"x").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.path().join("fora.png"), media.join("link.png")).unwrap();
    for bad in [
        "card://localhost/..%2ffora.png",
        "card://localhost/..%2Ffora.png",
        "card://localhost/%2e%2e%2ffora.png",
        "card://localhost/%2Fetc%2Fpasswd",
        "card://localhost/..%5cfora.png",
        "card://localhost/pasta",
        "card://localhost/pasta/x.png",
        "card://localhost/_leitor/..%2f..%2ffora.png",
        "card://localhost/link.png",
        "card://localhost/nao-existe.png",
        "card://localhost/",
    ] {
        let s = card_reply(&frames, &get(bad)).status().as_u16();
        assert!(s == 403 || s == 404, "{bad}: {s}");
    }
}

#[test]
fn missing_assets_show_a_portuguese_page() {
    let dir = tempfile::tempdir().unwrap();
    let pages = AnkiPages::new(AnkiWeb::missing(), vec![UI.into()]);
    for uri in [
        "anki://localhost/deck-options/1",
        "anki://localhost/_app/immutable/entry/start.mjs",
    ] {
        let res = anki_reply(&pages, &get(uri));
        assert_eq!(res.status(), 503, "{uri}");
        assert!(body(&res).contains(MISSING_MESSAGE));
        assert!(body(&res).contains("lang=\"pt-BR\""));
    }
    let (frames, _) = frames(dir.path(), AnkiWeb::missing());
    let res = card_reply(&frames, &get("card://localhost/_leitor/reviewer.html"));
    assert_eq!(res.status(), 503);
    assert!(body(&res).contains(MISSING_MESSAGE));
    // Media does not depend on the assets.
    assert_eq!(
        card_reply(&frames, &get("card://localhost/foto%201.png")).status(),
        200
    );
}

#[test]
fn mime_table() {
    use leitor_app::anki_web::mime_for_path;
    for (name, mime) in [
        ("a.mjs", "application/javascript"),
        ("a.js", "application/javascript"),
        ("a.css", "text/css"),
        ("a.woff2", "font/woff2"),
        ("a.woff", "font/woff"),
        ("a.ttf", "font/ttf"),
        ("a.wav", "audio/wav"),
        ("a.mp3", "audio/mpeg"),
        ("a.ogg", "audio/ogg"),
        ("a.webm", "video/webm"),
        ("a.svg", "image/svg+xml"),
        ("a.JPG", "image/jpeg"),
        ("a.json", "application/json"),
        ("a.bin", "application/octet-stream"),
    ] {
        assert_eq!(mime_for_path(name), mime, "{name}");
    }
}
