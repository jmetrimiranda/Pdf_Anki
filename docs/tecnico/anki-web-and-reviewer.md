# Anki web pages + the Python half of the reviewer (reference for spec §8.2–8.4)

Sources used (read-only):

- Anki source tag `26.09.3` checked out at `/tmp/anki-ref` (commit `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`). All `file:line` references below are relative to that tree.
- PyPI wheel `aqt==26.9.3`. sha256 `83d60a2494939128138692435ab9c65579338c6902aaba88606bce6b5ccd22d3`, 4,392,515 bytes. Unzipped to `/tmp/aqt-wheel/x`. License in the wheel: `License-Expression: AGPL-3.0-or-later`.

Everything below was checked against the source. Where something could not be confirmed, the text says so.

---

## 0. Summary of decisions, and corrections to the spec

1. `post_handler_list` has **32** handlers, not about 36 (`qt/aqt/mediasrv.py:1131-1164`). `exposed_backend_list` has **55** methods (`mediasrv.py:1167-1238`).
2. **`FrontendService` is not implemented in rslib.** The codegen filters it out (`rslib/rust_interface.rs:26,30`). So `getSchedulingStatesWithContext`, `setSchedulingStates`, `deckOptionsReady` and the rest can **never** go through `Collection::run_service_method`. They have to be implemented in the app.
3. **`addMediaFromUrl` is Backend-only** (`proto/anki/media.proto:28-30`, `BackendMediaService`). `Collection::run_service_method` cannot run it. Only the editor uses it, and we do not reuse the editor, so return 404.
4. `latestProgress`, `setWantsAbort` and `i18nResources` exist on *both* `CollectionService` and `Backend*Service`. The Collection versions are generated and work (`rslib/src/collection/service.rs:47-55`, `rslib/src/i18n/service.rs:32`).
5. **`getConfigJson` is a Python post handler, not the backend method.** Python returns JSON `null` when the key is missing (`mediasrv.py:834-838`). The backend returns NotFound (`rslib/src/backend/config.rs:59-64`). **`setConfigJson` is the backend method.** The Python `set_config_json` at `mediasrv.py:841` is dead code because it is not listed in `post_handler_list`.
6. **`import-page` is the JSON-import log page, not `.colpkg`** (`qt/aqt/import_export/import_dialog.py:20-28`, `ts/routes/import-page/index.ts`). `.colpkg` import goes through `BackendImportExportService.ImportCollectionPackage`, which needs a closed collection (`rslib/src/backend/import_export.rs:24-37`). That is a native flow, not a web page. Fix the table in §8.3 of the spec.
7. **Progress polling vs. the actor.** Deck options calls `computeFsrsParams`, `computeOptimalRetention` and `simulateFsrs*` through `runWithBackendProgress`. That helper polls `latestProgress` and sends `setWantsAbort` *while the long call is still running* (`ts/lib/tslib/progress.ts`, `ts/routes/deck-options/FsrsOptions.svelte:202,212,285,295`). If one actor thread serialises every call, progress freezes and the user cannot cancel. Answer these two methods **outside the actor**, as described in §2.6.
8. Card rendering. Python renders with `partial_render=true` and then does three things itself: injects `{{FrontSide}}`, applies custom filters, and runs the **LaTeX→image hook** (`pylib/anki/latex.py:57-63,178-179`, installed at `pylib/anki/collection.py:99`). All three have to be ported. See §4.2.
9. The SvelteKit pages switch to dark mode only through the URL hash `#night` (`ts/lib/tslib/nightmode.ts`). Several pages need a host-provided `window.bridgeCommand`, plus `alert()` and `confirm()`.
10. **(Added in review)** The progress problem in item 7 *is* solvable without patching Anki: `anki::backend::Backend` (pub, `rslib/src/backend/mod.rs:83`) holds the collection behind its own `Mutex` and answers `latestProgress`/`setWantsAbort` from `BackendCollectionService` **without taking the collection lock** (`rslib/src/backend/collection.rs:85-93`). See §2.6 option (d).
11. **(Added in review)** `anki_proto` does **not** expose the descriptor pool at runtime (`rslib/proto/src/lib.rs` only `include!`s prost output), and service indices are pool order (`rslib/proto_gen/src/lib.rs:129,140`). Prefer a hand-written name→trait-method dispatch over an index table (§2.5).
12. **(Added in review)** `anki::card::Card` fields are all `pub(crate)` (`rslib/src/card/mod.rs:80-105`); only `id()`, `note_id()`, `deck_id()`, `template_idx()` etc. are pub. For `flags`/`custom_data` convert with `anki_proto::cards::Card::from(card)` (`rslib/src/card/service.rs:116`) or work with the proto `QueuedCards` (`From` impl at `rslib/src/scheduler/service/answering.rs:61`), as Python does.

---

## 1. Built assets in the `aqt` wheel (verified)

Root: `_aqt/data/web/` (the whole tree is 14 MB, 204 files).

| Path | Size | Needed by us? |
|---|---|---|
| `sveltekit/index.html` | 3,002 B | yes (SPA fallback for every route) |
| `sveltekit/_app/version.json` | 27 B (`{"version":"1790167954796"}`) | optional |
| `sveltekit/_app/immutable/{entry,nodes,chunks,assets}` | 4.6 MB total (nodes 2.9M, chunks 1.3M, assets 580K), 128 files under `sveltekit/` | yes |
| `js/reviewer.js` | 499,345 B | yes (card iframe) |
| `js/mathjax.js` | 376 B (MathJax config; sets `loader.paths.mathjax = "/_anki/js/vendor/mathjax"`) | yes |
| `js/vendor/mathjax/` | 4.0 MB, 35 files (`tex-chtml-full.js` 1.3M, `sre/` 2.3M, `output/chtml/fonts/woff-v2/*.woff`, `a11y/`) | yes |
| `js/webview.js` | 215 B (blocks Backspace navigation) | yes (cheap) |
| `js/reviewer-bottom.js` | 721 B (bottom-bar timer, `showQuestion`/`showAnswer`/`selectedAnswerButton`) | no (native bar), reference only |
| `js/editor.js` | 3.6 MB | **no** |
| `js/vendor/{jquery.min.js 87K, jquery-ui.min.js 255K, bootstrap.bundle.min.js 80K, plot.js 68K}` | | no. `reviewer.js` already bundles jQuery and exports `$`/`jQuery` as globals (`ts/reviewer/index.ts:8`, `index_wrapper.ts`) |
| `css/reviewer.css` | 1,603 B | yes |
| `css/webview.css` | 12,590 B (defines `--canvas`, `--fg`, `--flag-1..7` and the rest of the palette) | yes. `reviewer.css` uses these variables |
| `css/reviewer-bottom.css`, `toolbar-bottom.css`, ... | | no |
| `pages/congrats.{html,js,css}` | 244K | no. A legacy page; desktop now uses the SvelteKit `congrats` route (`qt/aqt/overview.py:209`) |
| `imgs/favicon.ico` etc. | 64K | favicon only |

Minimal bundle for `src-tauri/resources/anki-web/`: `sveltekit/**`, `js/reviewer.js`, `js/mathjax.js`, `js/webview.js`, `js/vendor/mathjax/**`, `css/reviewer.css`, `css/webview.css`, `imgs/favicon.ico`. That is about 9.2 MB.

`sveltekit/index.html` (verbatim excerpt; it carries a **hash CSP meta tag**):

```html
<meta http-equiv="content-security-policy" content="script-src 'self' 'sha256-qxt8up9A9DouldIGIfi5r/23h6vjn6vBDfZPc+rhUmU='">
<link rel="preload" as="script" crossorigin="anonymous" href="/_app/immutable/entry/start.BvMV78ow.mjs">
...
<link href="/_app/immutable/assets/0.H7G7hbx1.css" rel="stylesheet">
<body data-sveltekit-preload-data="hover"><div style="display: contents"><script>
  { __sveltekit_1anyzui = { base: "" }; const element = document.currentScript.parentElement;
    Promise.all([import("/_app/immutable/entry/start.BvMV78ow.mjs"), import("/_app/immutable/entry/app.D4P4U8k4.mjs")])
      .then(([kit, app]) => { kit.start(app, element); }); }
</script></div></body>
```

Gotchas:

- All asset URLs are **absolute** (`/_app/...`), with `base: ""`. The page therefore has to be served at the **origin root** of the `anki` protocol.
- Module scripts are fetched in CORS mode (`crossorigin="anonymous"`). Same-origin custom-scheme module loading must work on every platform's webview. **Not verified here; spike it** (WebKitGTK, WKWebView, WebView2, Android).
- With the CSP meta tag left in, nothing else inline can run: no injected inline `<script>` and no `javascript:` links. `congrats` uses `bridgeLink()`, which produces `href="javascript:bridgeCommand('unbury')"` (`ts/lib/tslib/bridgecommand.ts`). Anki **strips** the meta tag for trusted routes (§2.4). Do the same, and load our shim from an external `<script src>`.

---

## 2. `qt/aqt/mediasrv.py` — how Anki serves the pages

### 2.1 Request entry and routing

`mediasrv.py:492-521`. Every GET and POST goes to `handle_request(pathin)`:

1. Host and Origin checks: Host must be `127.0.0.1:`, `localhost:` or `[::1]:`, and Origin must be localhost. Otherwise 403. Skipped when `ANKI_API_HOST=0.0.0.0`.
2. `req = _extract_request(pathin)` → `NotFound` → 404 text/plain. A callable → `_handle_dynamic_request` (POST API). `BundledFileRequest` → bundled file. `LocalFileRequest` → collection media.
3. An `UnsafePathException` becomes 403.

`_extract_request` (`mediasrv.py:634-646`) tries the internal (`_anki`/SvelteKit) paths first, then `_addons/`. Everything else is a **collection media file** at the server root, `root=col.media.dir()`, after `hooks.media_file_filter(path)`.

### 2.2 `get_sveltekit_route` (`mediasrv.py:524-544`)

```python
def get_sveltekit_route(path: str) -> str | None:
    page_name = path.split("/", maxsplit=1)[0]
    if page_name in [
        "graphs", "congrats", "card-info", "change-notetype", "deck-options",
        "import-anki-package", "import-csv", "import-page", "image-occlusion",
        "preferences", "editor",
    ]:
        return page_name
    return None

def is_untrusted_sveltekit_route(route: str) -> bool:
    return route in ("editor", "image-occlusion")
```

### 2.3 `_app` rewrite and the `index.html` fallback

`_extract_internal_request`, `mediasrv.py:547-597`:

```python
sveltekit_route = get_sveltekit_route(path)
if sveltekit_route:
    path = f"_anki/sveltekit/_app/{path}"          # e.g. deck-options/1 -> _anki/sveltekit/_app/deck-options/1
if path.startswith("_app/"):
    path = path.replace("_app", "_anki/sveltekit/_app")   # _app/immutable/x.mjs -> _anki/sveltekit/_app/immutable/x.mjs
prefix = "_anki/"
if not path.startswith(prefix): return None
dirname, filename = os.path.dirname(path), os.path.basename(path)
if dirname == "_anki":
    if flask.request.method == "POST":
        return _extract_collection_post_request(filename)      # POST /_anki/<method>
    elif get_handler := _extract_dynamic_get_request(filename): # only "legacyPageData"
        return get_handler
    # legacy remap: /_anki/x.css -> css/x.css ; /_anki/x.js -> js/x.js (jquery|jquery-ui|plot -> js/vendor/)
...
return BundledFileRequest(path=path[len(prefix):], sveltekit_route=sveltekit_route)
```

`_handle_builtin_file_request`, `mediasrv.py:441-489`:

```python
immutable = "immutable" in path
if path.startswith("sveltekit/") and not immutable:
    path = "sveltekit/index.html"                 # SPA fallback for every non-immutable sveltekit path
...
if immutable: response.headers["Cache-Control"] = "max-age=31536000"
if request.sveltekit_route:
    is_index = path.endswith("index.html")
    if is_untrusted_sveltekit_route(route):       # editor, image-occlusion
        CSP = _untrusted_sveltekit_content_security_policy(port, hash-from-meta if is_index)
    elif is_index:
        response.set_data(_strip_csp_meta(data))  # remove the SvelteKit <meta> CSP
        CSP = TRUSTED_PAGE_CSP                    # "frame-ancestors 'none'"
elif mimetype == "text/html":
    CSP = TRUSTED_PAGE_CSP
```

Quirks:

- `_app/version.json` does not contain "immutable", so it **also gets `index.html`**. This is harmless.
- Flask's `<path:pathin>` excludes the query string and fragment. Our handler must strip `?…` and `#…` before routing: desktop opens graphs as `graphs?cb=<time>` (`webview.py:954-955`, `stats.py:141`) and appends `#night` in dark mode.
- Other routes on the same server, not needed by us: `GET /favicon.ico` (`mediasrv.py:268`), `GET /_anki/readyz` (`mediasrv.py:274`, 503 until a collection is open), `GET /_anki/legacyPageData?id=` (`mediasrv.py:1381-1385`), `/_addons/<addon>/<path>` gated by `getWebExports` regex (`mediasrv.py:600-631`).
- Legacy remap: `/_anki/jquery.js`→`js/vendor/jquery.js`, `/_anki/js/vendor/jquery.js`→`js/vendor/jquery.min.js` (`mediasrv.py:571-596`). Not needed by the SvelteKit pages or `reviewer.js`.
- `FileNotFoundError` becomes 404 text/plain. Any other exception becomes 500 text/plain.

Port to Rust as follows:

```rust
// anki:// protocol, path without leading '/'
fn route(path: &str) -> Served {
    const ROUTES: &[&str] = &["graphs","congrats","card-info","change-notetype","deck-options",
        "import-anki-package","import-csv","import-page","image-occlusion","preferences"]; // drop "editor"
    let first = path.split('/').next().unwrap_or("");
    if ROUTES.contains(&first) { return Served::Index; }              // strip CSP meta, add own CSP
    if let Some(rest) = path.strip_prefix("_app/") {
        if rest.starts_with("immutable/") { return Served::File(format!("sveltekit/_app/{rest}"), Cache::Immutable); }
        return Served::Index;                                            // mirrors Anki's fallback
    }
    if let Some(m) = path.strip_prefix("_anki/") { if !m.contains('/') { return Served::Post(m.into()); } }
    Served::NotFound
}
```

### 2.4 CSPs and headers (copy them)

| Constant | Line | Value / use |
|---|---|---|
| `UNTRUSTED_MEDIA_CSP` | 75-100 | `default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; media-src 'self'; sandbox allow-same-origin`. Set on **every collection media response** (`_handle_local_file_request`, 413-415). It stops a deck's `.html`/`.svg` from running when it is navigated to directly. |
| `TRUSTED_PAGE_CSP` | 104 | `frame-ancestors 'none'` (trusted SvelteKit pages and legacy HTML). |
| `_SVELTEKIT_CSP_META_RE` | 126-128 | `rb"<meta http-equiv=\"content-security-policy\" content=\"script-src 'self' ('sha256-[A-Za-z0-9+/=]+')\">"`. `_strip_csp_meta` raises if it is not found (141-145). |

- Media cache rules (`mediasrv.py:397-405`): `.css` gets max-age=10, `.js` gets 0, everything else gets 3600.
- Directories return 403.
- `ensure_safe_path` (347-355) does `realpath(base)`, `normpath(path)`, then requires `fullpath.startswith(base + os.sep)`.
- `_mime_for_path` (290-329) uses a hard-coded table: css, js, mjs, html, htm, svg, png, jpg/jpeg, gif, webp, ico, json, woff, woff2, ttf, otf, mp3, mp4, webm, ogg, pdf, txt. Anything else falls back to `mimetypes`, then to `application/octet-stream`. **Copy the table.** `.mjs` must be served as `application/javascript`, or module loading fails.

### 2.5 POST `/_anki/<method>`

`mediasrv.py:1241-1348`:

```python
post_handlers = {stringcase.camelcase(h.__name__): h for h in post_handler_list} | \
                {stringcase.camelcase(n): raw_backend_request(n) for n in exposed_backend_list}
# NOTE: backend entries win on a name clash (dict union, right side last). There is no clash in 26.09.3.

def _extract_collection_post_request(path):          # 1281
    if not aqt.mw.col: return NotFound(...)           # -> 404
    handler -> wrapped(): data = handler() (asyncio.run if coroutine)
        if data: 200, body=data, "Content-Type: application/binary"
        else:    204, text/plain ""                   # empty bytes => 204
        except Exception as exc: 500 text/plain str(exc)

def _check_dynamic_request_permissions():            # 1310
    if request.method == "GET": return
    if request.headers.get("Content-type") != "application/binary": warn(); abort(403)   # EXACT match
    if _have_api_access(): return                    # "Authorization: Bearer <_APIKEY>" header
    if request.path in ("/_anki/getSchedulingStatesWithContext", "/_anki/setSchedulingStates",
                        "/_anki/i18nResources", "/_anki/congratsInfo"): pass
    else: warn(); abort(403)
```

`raw_backend_request` (1241-1269) calls `col._backend.<name>_raw(request.data)`. If the request has the header `Anki-Op-Changes: N` (N=1 `OpChanges`, 2 `OpChangesOnly`, 3 `NestedOpChanges`), it parses the *output* as that type and unwraps `.changes` N-1 times. It then calls `on_op_finished(mw, changes, handler)` on the main thread, which refreshes the other screens.

Client side (`ts/lib/generated/post.ts:34-58`):

```ts
fetch(`/_anki/${method}`, { method: "POST",
  headers: { "Content-Type": "application/binary", "Anki-Op-Changes": opChangesType.toString() }, body, signal })
// !ok -> throw Error(await result.text())   (prod) ; postProto() then alert()s it unless alertOnError:false
// special-cased: err.message === "500: Interrupted" (dev form) or AbortError are not alerted
```

The TS generator picks `opChangesType` from the output message (`rslib/proto/typescript.rs:100-122`). Wire trick: any message whose field 1 is an `OpChanges` (for example `OpChangesWithCount`) decodes as `OpChangesOnly`.

Our implementation:

```rust
// in the anki:// handler
if req.method() == "POST" {
    if req.headers().get("content-type").map(|v| v.as_bytes()) != Some(b"application/binary") { return status(403); }
    let name = /* camelCase method */;
    match lookup(name) {
        Handler::Backend(svc, m) => {
            let out = actor.call(move |col| col.run_service_method(svc, m, &body)).await;
            match out {
                Ok(bytes) if bytes.is_empty() => status(204),
                Ok(bytes) => binary(200, bytes),
                Err(err_bytes) => {   // anki_proto::backend::BackendError { message=1, kind=2, ... }
                    let e = BackendError::decode(&*err_bytes).unwrap_or_default();
                    text(500, if e.kind() == Kind::Interrupted { "Interrupted".into() } else { e.message })
                }
            }
            // then, if header Anki-Op-Changes = 1..3: decode OpChanges and emit a Tauri event so our Svelte UI refreshes
        }
        Handler::App(f) => f(body).await,
        Handler::NotFound => text(404, "..."),
    }
}
```

`Collection::run_service_method` is generated by `rslib/rust_interface.rs:132-165` (top-level match; per-service matches at `:167-190`):

```rust
pub fn run_service_method(&mut self, service: u32, method: u32, input: &[u8]) -> Result<Vec<u8>, Vec<u8>>
// Err = BackendError protobuf bytes; unknown index -> AnkiError::InvalidServiceIndex / InvalidMethodIndex
```

How the indices work:

- The service index is `ServiceDescriptor::index()` and the method index is `MethodDescriptor::index()`, both taken from the anki_proto descriptor pool (`rslib/proto_gen/src/lib.rs:125-160`).
- Only **non-`Backend*`** services are dispatched, and `FrontendService` is excluded.
- Method name = snake_case of the proto rpc name. The URL uses its camelCase form. For example, rpc `deckOptionsRequireClose` is already lowerCamel, and `GetDeckConfigsForUpdate` becomes `getDeckConfigsForUpdate`.
- An empty output message is encoded as `Vec::new()` (`rust_interface.rs:224-230`), so it naturally maps to Anki's 204.

**Gotcha (added in review): building the index table.** `ServiceDescriptor::index()` is the position in the *descriptor pool*, which depends on how `anki_proto`'s build loaded the files. `anki_proto` does not export the pool; its build writes `descriptors.bin` to `$DESCRIPTORS_BIN` or `OUT_DIR/../../anki_descriptors.bin` (`rslib/proto_gen/src/lib.rs:275-284`), which is a fragile path to read from our `build.rs`. Two safer options:

1. **Direct trait dispatch (recommended).** The generated traits are `pub` (`rust_interface.rs:81-88`, re-exported as `anki::services::*`) and implemented on `Collection`. Write the 55-entry match by hand (or with a small macro): decode with `prost::Message::decode`, call the trait method, encode. Methods with an `Empty` input take no argument (`text_if_input_not_empty`, `rust_interface.rs:90-99`), for example `SchedulerService::congrats_info(col)`. No indices are involved, and a typo is a compile error.
2. Index table generated from `/tmp/anki-ref/proto/anki/*.proto` with our own `prost-reflect`/`protox` build step. This only works if the file load order matches `anki_proto`'s. Add a startup self-test (for example, call `i18nResources` by index and decode the result).

### 2.6 `latestProgress` / `setWantsAbort` with the actor

The Collection impls read and write `self.state.progress: Arc<Mutex<ProgressState>>` (`rslib/src/collection/service.rs:47-55`). The builder exposes:

```rust
// rslib/src/collection/mod.rs:118-124
/// If provided, progress info will be written to the provided mutex, and can be tracked on a separate thread.
pub fn set_shared_progress_state(&mut self, state: Arc<Mutex<ProgressState>>) -> &mut Self
```

`ProgressState` is declared `pub struct` with pub fields `want_abort: bool` and `last_progress: Option<Progress>` (`rslib/src/progress.rs:120-124`). However, it lives in the **private** module `mod progress` (`rslib/src/lib.rs:35`), and `progress_to_proto` is `pub(crate)` (`progress.rs:148`). As a result:

- An external crate can still create the state by type inference (`Arc::new(Mutex::new(Default::default()))` passed to `set_shared_progress_state`) and set `want_abort = true` from any thread. This works for `setWantsAbort`.
- It **cannot** turn `last_progress` into the `anki_proto::collection::Progress` bytes outside the actor, because the `Progress` enum is not nameable.

Options for `latestProgress`:

- (a) Return an empty `Progress {}` (the page then shows an indeterminate bar). Simplest.
- (b) Carry a tiny patch or fork exposure. The spec forbids modifying `third_party/` and Anki.
- (c) Keep a second, read-only path. Not possible: the SQLite connection is exclusive.
- (d) **(Added in review) Use `anki::backend::Backend` as the owner of the collection**, as desktop does. Verified:
  - `pub fn Backend::new(tr: I18n, server: bool) -> Backend` (`rslib/src/backend/mod.rs:83`). `Backend` is `Arc<BackendInner>` with `col: Mutex<Option<Collection>>` and its own `progress_state: Arc<Mutex<ProgressState>>`.
  - The generated `pub fn run_service_method(&self, service: u32, method: u32, input: &[u8]) -> Result<Vec<u8>, Vec<u8>>` also exists on `Backend` (`rust_interface.rs:60-73` + `:132-165`, `self_kind = "&self"`). It uses **Backend\*Service indices**, and Collection-only methods are reached through generated *delegating* methods with offset indices (`proto_gen/src/lib.rs:70-79`).
  - `BackendCollectionService::latest_progress`/`set_wants_abort` read and write `self.progress_state` **without** locking `col` (`rslib/src/backend/collection.rs:85-93`). Every other call goes through `with_col` (`backend/mod.rs:117-129`), which serialises on the mutex. So a progress poll during `computeFsrsParams` returns real progress.
  - It also makes `addMediaFromUrl`, `importCollectionPackage` and the other Backend-only methods reachable.
  - Cost: the collection is opened through `BackendCollectionService::open_collection` (proto `OpenCollectionRequest`), not through `CollectionBuilder`. Reconcile this with `anki-rslib-api.md` before choosing.

**Recommendation (revised in review):** if we keep `Collection` + actor, implement `setWantsAbort` outside the actor through the shared state (store a `move || state.lock().unwrap().want_abort = true` closure, because `ProgressState` cannot be named in a struct field) and return an empty `Progress` for `latestProgress` (option a, a known limitation). If an accurate FSRS progress bar matters, use option (d).

### 2.7 Page context and ids

There is no server-side context for SvelteKit pages. Each page reads its ids **from the URL path** (`ts/routes/**/+page.ts`):

| URL (desktop opener) | Loader reads | First calls |
|---|---|---|
| `deck-options/<deckId>` (`qt/aqt/deckoptions.py:47`) | `Number(params.deckId)` | `getDeckConfigsForUpdate({did})` |
| `card-info/<cardId>` (`browser/card_info.py:62`), `card-info/<cid>/<previousId>` | BigInt | `cardStats` |
| `change-notetype/<oldNtId>[/<newNtId>]`. Desktop sends **only** `<oldNtId>` (`changenotetype.py:54`); the route defaults new = old (`ts/routes/change-notetype/[...notetypeIds]/+page.ts`) | split `/` | `getNotetypeNames`, `getChangeNotetypeInfo` |
| `graphs` (`stats.py:141`, `cache_bust`) | none; initial search `"deck:current"` (`ts/routes/graphs/+page.svelte:43`) | `graphs`, `getGraphPreferences` |
| `congrats` (`overview.py:209`) | none | `congratsInfo` (uses the **current deck**) |
| `import-anki-package/<urlquoted abs path>` (`import_dialog.py:68`) | `params.path` | `getImportAnkiPackagePresets`, then `importAnkiPackage({packagePath})` |
| `import-csv/<path>` | path | `getNotetypeNames`, `getDeckNames`, `getCsvMetadata` |
| `import-page/<path>` | path | JSON import (`importJsonFile`) |
| `image-occlusion/<noteId or image path>` | `/^\d+/` → edit, else add | `getImageForOcclusion` / `getImageOcclusionNote` |
| `preferences` | none | `getConfigJson("experimentalFeatures")`, `setConfigJson` |

- **Dark mode:** append `#night` (`webview.py:956-957`). `checkNightMode()` sets `<html class="night-mode" data-bs-theme="dark">`.
- `+layout.ts` sets `ssr=false` and `prerender=false` and calls `setupGlobalI18n()`, which POSTs `i18nResources`.
- **Post-load styling (added in review).** For every SvelteKit page, desktop runs `add_dynamic_styling_and_props_then_show()` after load (`webview.py:451-462,910-935`). It sets `document.title`, appends a `<style>` with `standard_css()` (zoom, platform font, button styles, `--canvas`), adds the `theme_manager.body_class()` classes to `<body>` (`isLin`/`isMac`/`isWin`, `fancy`, `nightMode night_mode` in dark mode), and adds `night-mode` to `<html>`. Our `page-bridge.js` should do the same, or the pages render with the browser-default font and no platform classes.
- **Theme change while open:** desktop evals a snippet that toggles `html.night-mode`, `data-bs-theme` and the body `nightMode`/`night_mode` classes (`webview.py:989-1013`). The `#night` hash is only read at load.
- **Current deck:** `graphs` and `congrats` depend on it. Call `Collection::set_current_deck(did)` (`rslib/src/decks/current.rs:10`) before opening them.
- Legacy `PageContext` / `legacyPageData?id=` (`mediasrv.py:176-194,1351-1366`; `webview.py:569-583`) only serves `stdHtml` pages. We do not need it.

### 2.8 Host↔page JS contract (beyond POST)

- `window.bridgeCommand(cmd, cb?)` is called in two places:
  - `graphs`: `bridgeCommand("browserSearch: <search> <query>")` (`GraphsPage.svelte:26`). Desktop handler: `stats.py:132`.
  - `congrats`: `javascript:bridgeCommand('unbury'|'customStudy')`, shown only if `info.bridgeCommandsSupported`, which the backend always sets to `true` (`rslib/src/scheduler/congrats.rs:38,62`). Desktop handler: `overview.py:116-119`.
  - `bridgeCommand` is called at call time without a guard (`ts/lib/tslib/bridgecommand.ts:21-23`), so our shim **must** define `window.bridgeCommand`.
- The host evaluates these in the page:
  - `anki.deckOptionsPendingChanges()` on close (`deckoptions.py:67`). It may `confirm()` and then POSTs `deckOptionsRequireClose`.
  - `anki.updateCard('<cid>')` / `anki.updateCardInfos` (card-info).
  - `anki.onOperationDidExecute(changesJson)` (`webview.py:1025-1034`; `ts/lib/tslib/operations.ts:19-20`).
- On load, the desktop adds `Escape` → `pycmd("close")` (`webview.py:451-460`).
- The pages call `alert()` (`post.ts:28`) and `confirm()` (deck options). **Risk:** WKWebView (macOS/iOS) and some Linux webviews ignore `alert`/`confirm` unless the host implements the UI delegate. Verify in Tauri/wry; if they are missing, polyfill them in the shim with a sync-looking modal (`confirm` is used synchronously).

---

## 3. Decision table → copy into `docs/anki-handlers.md`

Legend:

- **FWD** = forward to rslib: a direct trait-method call (recommended, §2.5) or `Collection::run_service_method` with an index table.
- **APP** = implement in our app.
- **404** = respond 404.

"Card" = also allowed from the `card` protocol, matching Anki's whitelist (`mediasrv.py:1329-1334`).

### 3.1 `post_handler_list` (32, `mediasrv.py:1131-1164`)

| # | URL name | Python (line) | What Python does | Decision for Leitor |
|---|---|---|---|---|
| 1 | `congratsInfo` | 649 | If the scheduler is not finished, moves the main window to overview. Then returns backend `congrats_info`. | **FWD** (`SchedulerService.CongratsInfo`). Card. Optional APP side effect: if the queue is not empty, emit an event to resume study. |
| 2 | `getDeckConfigsForUpdate` | 655 | Calls backend `get_deck_configs_for_update_raw(body)` directly. | **FWD** (`DeckConfigService.GetDeckConfigsForUpdate`). |
| 3 | `updateDeckConfigs` | 669 | Parses `UpdateDeckConfigs`, runs the op on the main thread **in the background** with a progress dialog (compute memory/params labels), and **returns b"" immediately (204)**. On success it closes the dialog unless mode = `COMPUTE_ALL_PARAMS`. | **APP**: run FWD (`DeckConfigService.UpdateDeckConfigs`) on the actor and reply 204 right away (the page ignores the result: `ts/routes/deck-options/lib.ts:282-286`). Show our progress overlay from the shared progress state, emit op-changes, and close the page on success unless mode = COMPUTE_ALL_PARAMS. |
| 4 | `getSchedulingStatesWithContext` | 714 | Returns `SchedulingStatesWithContext{states: reviewer._v3.states, context}`. | **APP** (no Rust impl; FrontendService). Card. Serialise the `anki_proto::frontend::SchedulingStatesWithContext` of the card being shown. |
| 5 | `setSchedulingStates` | 721 | Parses `SetSchedulingStatesRequest`. If `key == reviewer._state_mutation_key`, replaces the reviewer's states. | **APP**. Card. Check the per-session random key (see §4.7). |
| 6 | `changeNotetype` | 767 | Sends bytes to the active `ChangeNotetypeDialog.save()`. That method parses `ChangeNotetypeRequest`, **asks to confirm the schema change**, **adds `note_ids` from the dialog** (the page does not send them), and runs `change_notetype_of_notes`. | **APP**: keep the note ids for the open page server-side, confirm the schema change (full sync), fill `note_ids`, then FWD (`NotetypesService.ChangeNotetype`) and close the page. |
| 7 | `importDone` | 728 | Makes the import dialog non-modal. | **APP** no-op, return 204. Emit op-changes, because an import changes everything. |
| 8 | `importDialogRequireClose` | 742 | Rejects (closes) the import dialog. | **APP**: close the import page. Callers (verified in review): `$lib/components/ErrorPage.svelte` (the OK button on the error box), used by `import-csv` and `import-page`. |
| 9 | `searchInBrowser` | 755 | Parses `SearchNode` and opens the Browser with it. | **APP**: open our Browse screen. Turning `SearchNode` into text needs backend `build_search_string` (`SearchService.BuildSearchString`), FWD internally. Callers (verified in review): `import-page/lib.ts` (the import log's "show in browser" links) and the editor. Return 204 at first; a 404 would make `postProto` `alert()`. |
| 10 | `deckOptionsRequireClose` | 779 | Force-closes the deck options dialog (next event-loop tick). | **APP**: close the page. |
| 11 | `deckOptionsReady` | 791 | Marks the dialog ready. Before this, close does not ask the page. | **APP**: set a flag. While it is unset, close directly; once set, close calls `anki.deckOptionsPendingChanges()`. |
| 12 | `getProfileConfigJson` | 816 | Returns `Json` of a profile key (`pm.profile.get`). | **APP**: small JSON key/value store in `core-store`. Return `null` if missing. Input `generic.String{val:key}`, output `generic.Json` (`mediasrv.py:801-806`). Callers: `ts/lib/tslib/profile.ts`, used only by the editor. |
| 13 | `setProfileConfigJson` | 821 | Sets a profile key. | **APP** (same store) or 404. Input `frontend.SetSettingJsonRequest{key, value_json}` (`mediasrv.py:809-813`). Editor only (color buttons). |
| 14 | `getMetaJson` | 826 | Global meta store, get. | **APP** (same store) or 404. Editor only. |
| 15 | `setMetaJson` | 830 | Global meta store, set. | **APP** (same store) or 404. Editor only. |
| 16 | `getConfigJson` | 834 | `col.conf.get_immutable(key)`; **on KeyError returns `Json(json=b"null")`**. | **APP wrapper over FWD** (`ConfigService.GetConfigJson`). On NotFound, return `generic::Json{json:b"null"}`. Used by `preferences` (`routes/preferences/+page.ts` via `getColConfig`) and the editor. Note: `setColConfig` sends `setConfigJson{key, valueJson, undoable:true}`, which is the backend method (FWD). |
| 17 | `convertPastedImage` | 845 | Re-encodes an image with QImage (png q50 / other q80). | **404**. Editor only. |
| 18 | `openFilePicker` | 884 | Native open dialog (`title`, `filter_description`, `extensions`, `key`). Returns `String` path or "". | **APP** (Tauri dialog plugin, returns `generic.String`, "" on cancel) or 404. **Corrected in review:** only the editor calls it (`routes/editor/rich-text-input/data-transfer.ts`), not image-occlusion. Python `async def`. |
| 19 | `openMedia` | 910 | Opens an image in the OS viewer. | **404** (editor only). |
| 20 | `showInMediaFolder` | 924 | Reveals the file in the OS file manager. | **404** (editor only). |
| 21 | `recordAudio` | 935 | Records with the Qt recorder and returns the path. | **404** (editor only). |
| 22 | `playFile` | 952 | Plays a media file with av_player. | **APP** if needed (our audio player) or 404. Editor only. |
| 23 | `readClipboard` | 976 | Reads mime types from the Qt clipboard. | **404** (editor only). |
| 24 | `writeClipboard` | 990 | Writes the clipboard. | **404** (editor only). |
| 25 | `closeAddCards` | 1002 | Closes Add Cards if the user discards. | **404** (we do not reuse the editor). |
| 26 | `closeEditCurrent` | 1016 | Closes Edit Current. | **404**. |
| 27 | `openLink` | 1027 | Opens a URL in the external browser. | **APP**: Tauri opener plugin. Allow http(s) only. Used by editor help; cheap to add. |
| 28 | `askUser` | 1035 | Yes/no dialog → `Bool`. | **APP**: Tauri dialog `ask`. Editor only. Optional. |
| 29 | `showMessageBox` | 1062 | Info/warn/critical box → `Bool(true)`. | **APP**: Tauri dialog `message`. Editor only. Optional. |
| 30 | `openFieldsDialog` | 1096 | Editor → Fields dialog. | **404**. |
| 31 | `openCardsDialog` | 1109 | Editor → Card Layout. | **404**. |
| 32 | `saveCustomColours` | 1122 | Saves the QColorDialog palette to config `customColorPickerPalette`. | **Corrected in review: APP no-op → 204** if we ship the `image-occlusion` page. `routes/image-occlusion/Toolbar.svelte:270` calls it on every colour-input `change`, and a 404 would `alert()`. (Optionally store the colours and serve them from `getCustomColours`, which is FWD.) Otherwise 404. |

Proto I/O of the APP handlers (verified in review, `proto/anki/frontend.proto:17-67`): `GetSchedulingStatesWithContext(Empty)→SchedulingStatesWithContext`, `SetSchedulingStates(SetSchedulingStatesRequest{key, states})→Empty`, `ImportDone(Empty)→Empty`, `SearchInBrowser(search.SearchNode)→Empty`, `deckOptionsRequireClose/deckOptionsReady(Empty)→Empty`, `OpenFilePicker(openFilePickerRequest)→String`, `OpenLink(String)→Empty`, `AskUser(AskUserRequest)→Bool`, `ShowMessageBox(ShowMessageBoxRequest)→Empty` (Python actually returns serialized `Bool(true)`; this is harmless because the decoder ignores the unknown field), `Get{Profile,Meta}ConfigJson(String)→Json`, `Set{Profile,Meta}ConfigJson(SetSettingJsonRequest)→Empty`, `SaveCustomColours(Empty)→Empty`, `ImportDialogRequireClose(Empty)→Empty`. `congratsInfo`, `getDeckConfigsForUpdate`, `updateDeckConfigs`, `changeNotetype` and `getConfigJson` are **not** in `FrontendService`. They are real Collection-service rpcs (`SchedulerService.CongratsInfo` `scheduler.proto:26`, `NotetypesService.ChangeNotetype` `notetypes.proto:32`, `ConfigService.GetConfigJson` `config.proto:14`), so FWD works for them.

Python handlers marked `async def` (they wait on a Qt dialog): `openFilePicker` 884, `recordAudio` 935, `askUser` 1035, `showMessageBox` 1062.

### 3.2 `exposed_backend_list` (55, `mediasrv.py:1167-1238`), copied verbatim with our decision

All of these are **FWD**, except where marked otherwise.

```text
# CollectionService      latest_progress (APP-outside-actor, §2.6), get_custom_colours
# DeckService            get_deck_names, get_deck
# I18nService            i18n_resources            (Card: allowed)
# ImportExportService    get_csv_metadata, get_import_anki_package_presets, import_csv,
#                        import_anki_package, import_json_file, import_json_string
# NotesService           get_field_names, get_note, new_note, note_fields_check, defaults_for_adding,
#                        default_deck_for_notetype, add_note, update_notes, update_notetype
# NotetypesService       get_notetype, get_notetype_names, get_change_notetype_info, get_cloze_field_ords
# StatsService           card_stats, get_review_logs, graphs, get_graph_preferences, set_graph_preferences
# TagsService            complete_tag
# ImageOcclusionService  get_image_for_occlusion, add_image_occlusion_note, get_image_occlusion_note,
#                        update_image_occlusion_note, get_image_occlusion_fields
# SchedulerService       compute_fsrs_params, compute_optimal_retention, set_wants_abort (APP-outside-actor),
#                        evaluate_params_legacy, get_optimal_retention_parameters,
#                        simulate_fsrs_review, simulate_fsrs_workload
# DeckConfigService      get_ignored_before_count, get_retention_workload
# CardRenderingService   encode_iri_paths, decode_iri_paths, html_to_text_line
# ConfigService          set_config_json, get_config_bool
# MediaService           add_media_file, add_media_from_path, add_media_from_url (404: Backend-only),
#                        get_absolute_media_path, extract_media_files
# CardsService           get_card
```

The groupings above are the comment headers from the Python list. I verified the real proto services by grepping `proto/anki/*.proto`, and these differ from those comments (re-checked mechanically in review against every `rpc` line):

- `get_deck_names`, `get_deck`: the service is named **`DecksService`**, not `DeckService` (`decks.proto:22,27`).
- `get_field_names` is `NotetypesService` (`notetypes.proto:33`).
- `update_notetype` is `NotetypesService` (`notetypes.proto:15`), not `NotesService`. *(Missed in the first version.)*
- `set_wants_abort` is `CollectionService` (`collection.proto:21`), not `SchedulerService`. `latest_progress` is correctly listed under CollectionService (`collection.proto:20`).
- `add_media_from_url` is `BackendMediaService` (`media.proto:29`).

Every other entry sits in the service its comment names. Build the dispatch from the proto service, **not** from these comments.

Extra security notes for FWD:

- `import_anki_package`, `import_csv` and `import_json_file` take **arbitrary filesystem paths** from the page (the path is in the URL). `add_media_from_path` and `get_absolute_media_path` touch the filesystem too.
- Only the trusted `anki` origin may call these. On iOS, copy picked files into the app sandbox or tmp, and build the page URL from that copy.

### 3.3 Anything else → 404

---

## 4. Porting the reviewer (`qt/aqt/reviewer.py`, `qt/aqt/sound.py`, `qt/aqt/main.py`, `pylib/anki/template.py`)

### 4.1 `revHtml` and the full base page

`reviewer.py:329-362`:

```python
def revHtml(self) -> str:
    extra = self.mw.col.conf.get("reviewExtra", "")
    fade = ""
    if self.mw.pm.video_driver() == VideoDriver.Software:
        fade = "<script>qFade=0;</script>"          # dead: reviewer.js no longer reads qFade (0 hits in the built js)
    return f"""
<div id="_mark" hidden>&#x2605;</div>
<div id="_flag" hidden>&#x2691;</div>
{fade}
<div id="qa" dir="auto"></div>
{extra}
"""

def _initWeb(self) -> None:
    self._reps = 0
    self.web.stdHtml(self.revHtml(), css=["css/reviewer.css"], js=["js/reviewer.js"], context=self)
    self.web.allow_drops = True
    self.web.eval("_blockDefaultDragDropBehavior();")
    self.bottom.web.stdHtml(self._bottomHTML(), css=["css/toolbar-bottom.css", "css/reviewer-bottom.css"],
                            js=["js/vendor/jquery.min.js", "js/reviewer-bottom.js"], context=ReviewerBottomBar(self))
```

`stdHtml` (`webview.py:694-776`) wraps it:

- css = `["css/webview.css"] + css`.
- js = `["js/webview.js"] + js`. Because `js` is passed, jQuery is **not** added.
- head = `<base href="http://127.0.0.1:PORT/">` (`main.py:1890-1891`), then webview.css, then `<style>standard_css()</style>`, then the extra css.

Resulting document:

```html
<!doctype html>
<html class="{'night-mode' | ''}" dir="{ltr|rtl}" data-bs-theme="{dark|light}">
<head>
    <title>{title}</title>
<base href="http://127.0.0.1:PORT/"><link rel="stylesheet" type="text/css" href="http://127.0.0.1:PORT/_anki/css/webview.css"><style>{standard_css}</style><link rel="stylesheet" type="text/css" href="http://127.0.0.1:PORT/_anki/css/reviewer.css">
</head>
<body class="{theme_manager.body_class()}">
<script src="http://127.0.0.1:PORT/_anki/js/webview.js"></script>
<script src="http://127.0.0.1:PORT/_anki/js/reviewer.js"></script>
<div id="_mark" hidden>&#x2605;</div> <div id="_flag" hidden>&#x2691;</div> <div id="qa" dir="auto"></div> {reviewExtra}
</body></html>
```

`standard_css()` (`webview.py:638-692`) contains:

- `body { zoom: Z; background-color: var(--canvas); }`
- the platform font family
- `:root.system-font-size {font-size...}`
- button styles
- `:root { --canvas: <light> }` / `:root[class*=night-mode] { --canvas: <dark> }`

Qt also injects the bridge script at DocumentReady (`webview.py:102-135`). It defines `pycmd = bridgeCommand = function(arg, cb)` over QWebChannel, returns `false`, and then sends `pycmd("domDone")`. Python queues every `eval` until `domDone` arrives (`webview.py:819-834,861-863`).

**Leitor version.** Serve it at `card://localhost/_leitor/reviewer.html`; media sits at the same origin root, so no `<base>` is needed:

```html
<!doctype html>
<html class="" dir="ltr" data-bs-theme="light">
<head><meta charset="utf-8">
<link rel="stylesheet" href="/_anki/css/webview.css">
<style>/* our standard_css equivalent: body{background-color:var(--canvas)} + font */</style>
<link rel="stylesheet" href="/_anki/css/reviewer.css">
<script src="/_leitor/card-bridge.js"></script>   <!-- MUST run before reviewer.js -->
</head>
<body class="isLin fancy">
<script src="/_anki/js/webview.js"></script>
<script src="/_anki/js/reviewer.js"></script>
<div id="_mark" hidden>&#x2605;</div><div id="_flag" hidden>&#x2691;</div>
<div id="qa" dir="auto"></div>
<!-- reviewExtra: optional, raw HTML from col config "reviewExtra" -->
</body></html>
```

Body classes:

- `body_class()` (`theme.py:163-185`): `isWin|isMac|isLin`, plus `nightMode night_mode` (and `macos-dark-mode`) in dark mode, `fancy` unless minimalist mode, and `no-blur` only on Qt < 5.15. The reviewer variant drops `reduce-motion` (`reviewer=True`).
- Per card, `body_classes_for_card_ord(ord)` = `f"card card{ord+1} {body_class(reviewer=True)}"` (`theme.py:187-191`).

### 4.2 Card text pipeline (what `c.question()` / `c.answer()` return)

The pipeline is `Card.question()` → `render_output().question_and_style()` → `f"<style>{css}</style>{question_text}"` (`pylib/anki/cards.py:149-160`, `template.py:289-293`). `TemplateRenderContext.render()` (`template.py:224-256`):

```python
partial = backend.render_existing_card(card_id, browser, partial_render=True)
qtext = apply_custom_filters(partial.qnodes, ctx, front_side=None)
qout  = backend.extract_av_tags(text=qtext, question_side=True)     # [sound:x]/[anki:tts] -> [anki:play:q:N]
atext = apply_custom_filters(partial.anodes, ctx, front_side=qout.text)  # FrontSide = question AFTER av extraction
aout  = backend.extract_av_tags(text=atext, question_side=False)
output = TemplateRenderOutput(qout.text, aout.text, av_tags_to_native(qout.av_tags), ..., css=partial.css)
hooks.card_did_render(output, ctx)    # -> anki.latex.on_card_did_render: [latex]..[/latex] -> <img src=latex-<hash>.png>
```

`apply_custom_filters` (`template.py:308-343`) concatenates the nodes:

- Text nodes are used as they are.
- For a `Replacement`: if `field_name == "FrontSide"` and `front_side` is set, `current_text = front_side`. Each filter then goes through `hooks.field_filter`; the only built-in one is `tts-voices` (`qt/aqt/tts.py:150-166`). Unknown filters leave the text unchanged.

Rust APIs (exact):

```rust
// rslib/src/notetype/render.rs:46
pub fn render_existing_card(&mut self, cid: CardId, browser: bool, partial_render: bool) -> Result<RenderCardOutput>
// render.rs:18
pub struct RenderCardOutput { pub qnodes: Vec<RenderedNode>, pub anodes: Vec<RenderedNode>, pub css: String, pub latex_svg: bool, pub is_empty: bool }
// rslib/src/template.rs:367
pub enum RenderedNode { Text { text: String }, Replacement { field_name: String, current_text: String, filters: Vec<String> } }
// rslib/src/card_rendering/mod.rs:19   (pub mod card_rendering)
pub fn extract_av_tags<S: Into<String> + AsRef<str>>(txt: S, question_side: bool, tr: &I18n)
    -> (String, Vec<anki_proto::card_rendering::AvTag>)
pub fn strip_av_tags<S: Into<String> + AsRef<str>>(txt: S) -> String            // mod.rs:13
// rslib/src/latex.rs:63
pub fn extract_latex(text: &str, svg: bool) -> (Cow<'_, str>, Vec<ExtractedLatex>)
// Collection accessors
pub fn tr(&self) -> &I18n                                                     // collection/mod.rs:215
```

Gotcha: with `partial_render=false`, Rust injects FrontSide as the question text **before** av extraction (`template.rs:647-655`). Sounds from the question then get renumbered as answer tags `[anki:play:a:N]`, so the answer side **plays the question audio again**. It also drops unknown filters. **Use `partial_render=true` and port `apply_custom_filters`:**

```rust
fn nodes_to_text(nodes: &[RenderedNode], front_side: Option<&str>) -> String {
    let mut out = String::new();
    for n in nodes {
        match n {
            RenderedNode::Text { text } => out.push_str(text),
            RenderedNode::Replacement { field_name, current_text, filters } => {
                let mut t = if field_name == "FrontSide" { front_side.unwrap_or(current_text).to_string() }
                            else { current_text.clone() };
                for f in filters { if f == "tts-voices" { t = tts_voices_html(); } /* others: no-op, like Python */ }
                out.push_str(&t);
            }
        }
    }
    out
}
let r = col.render_existing_card(cid, false, true)?;
let (q_text, q_av) = anki::card_rendering::extract_av_tags(nodes_to_text(&r.qnodes, None), true, col.tr());
let (a_text, a_av) = anki::card_rendering::extract_av_tags(nodes_to_text(&r.anodes, Some(&q_text)), false, col.tr());
let q_html = format!("<style>{}</style>{}", r.css, render_latex(col, &q_text, r.latex_svg)?);
let a_html = format!("<style>{}</style>{}", r.css, render_latex(col, &a_text, r.latex_svg)?);
```

LaTeX port (`pylib/anki/latex.py:73-108`):

1. Run `extract_latex(text, svg)` to get the HTML with `<img src="latex-….png|svg">` plus the list of `(filename, latex_body)`.
2. For each entry: if `col.media` already has the file, it is fine. Otherwise Python runs `latex`/`dvipng` (or `dvisvgm`); if config bool `RENDER_LATEX` is off, it appends `tr.preferences_latex_generation_disabled()`.
3. **We cannot run TeX on iPad.** Just use the existing media and append the "generation disabled"/missing message. Shared decks usually ship the images.
4. If `RenderCardOutput.is_empty` is set, the nodes **already contain** the "empty front / missing cloze" message (`rslib/src/template.rs:623-647`), so no extra handling is needed beyond rendering them. Python's `apply_custom_filters` also short-circuits when there is a single text node (`template.py:314-316`).
5. Template errors: Python catches `TemplateError` and shows `str(error)` as both question and answer (`template.py:225-234`). In Rust, `render_existing_card` returns `Err(AnkiError::TemplateError{..})`. Show `err.message(col.tr())` as HTML.

`AvTag` proto (`proto/anki/card_rendering.proto:53-66`): `oneof value { string sound_or_video = 1; TTSTag tts = 2; }`, where `TTSTag { field_text, lang, repeated voices, float speed, repeated other_args }`. Python keeps **only `os.path.basename(sound_or_video)`** (`pylib/anki/template.py:93-96`), for security. Do the same.

### 4.3 `prepare_card_text_for_display` and `av_refs_to_play_icons`

`qt/aqt/main.py:633-643`:

```python
def _add_play_buttons(self, text: str) -> str:
    if self.col.get_config_bool(Config.Bool.HIDE_AUDIO_PLAY_BUTTONS):
        return anki.sound.strip_av_refs(text)
    else:
        return aqt.sound.av_refs_to_play_icons(text)

def prepare_card_text_for_display(self, text: str) -> str:
    text = self.col.media.escape_media_filenames(text)   # == backend encode_iri_paths
    text = self._add_play_buttons(text)
    return text
```

`pylib/anki/sound.py:69-73`:

```python
AV_REF_RE = re.compile(r"\[anki:(play:(.):(\d+))\]")
def strip_av_refs(text: str) -> str: return AV_REF_RE.sub("", text)
```

`qt/aqt/sound.py:906-921` (copy the HTML exactly, because `.replay-button`/`.soundLink`/`.playImage` are styled by `reviewer.css` and by user templates):

```python
def av_refs_to_play_icons(text: str) -> str:
    def repl(match: re.Match) -> str:
        return f"""
<a class="replay-button soundLink" href=# onclick="pycmd('{match.group(1)}'); return false;" draggable="false">
    <svg class="playImage" viewBox="0 0 64 64" version="1.1">
        <circle cx="32" cy="32" r="29" />
        <path d="M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z" />
    </svg>
</a>"""
    return AV_REF_RE.sub(repl, text)

def play_clicked_audio(pycmd: str, card: Card) -> None:   # sound.py:924
    play, context, str_idx = pycmd.split(":")
    tags = card.question_av_tags() if context == "q" else card.answer_av_tags()
    av_player.play_tags([tags[int(str_idx)]])
```

Rust port:

```rust
static AV_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[anki:(play:(.):(\d+))\]").unwrap());
fn av_refs_to_play_icons(text: &str) -> String {
    AV_REF.replace_all(text, |c: &regex::Captures| format!(
"\n<a class=\"replay-button soundLink\" href=# onclick=\"pycmd('{}'); return false;\" draggable=\"false\">\n    <svg class=\"playImage\" viewBox=\"0 0 64 64\" version=\"1.1\">\n        <circle cx=\"32\" cy=\"32\" r=\"29\" />\n        <path d=\"M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z\" />\n    </svg>\n</a>", &c[1])).into_owned()
}
// encode_iri_paths is pub(crate) in rslib/src/text.rs:559 -> call via the service trait:
use anki::services::CardRenderingService;
let enc = col.encode_iri_paths(anki_proto::generic::String { val: html })?.val;   // card_rendering/service.rs:140
let hide = col.get_config_bool(anki::config::BoolKey::HideAudioPlayButtons);         // config/bool.rs:22
```

`anki::config::BoolKey` is re-exported publicly (`rslib/src/config/mod.rs:19`). `Collection::get_config_bool(&self, key: BoolKey) -> bool` is at `rslib/src/config/bool.rs:58`.

### 4.4 Show question / answer: exact JS calls

`reviewer.py:367-405` (question):

```python
def _mungeQA(self, buf): return self.typeAnsFilter(self.mw.prepare_card_text_for_display(buf))
q = c.question()                         # "<style>css</style>" + question text
# autoplay: if c.autoplay() (deck conf "autoplay"): play c.question_av_tags(); setPlaybackRequiresGesture(False)
q = self._mungeQA(q)                      # state == "question" -> typeAnsQuestionFilter
q = gui_hooks.card_will_show(q, c, "reviewQuestion")
self._run_state_mutation_hook()
bodyclass = theme_manager.body_classes_for_card_ord(c.ord)
a = self.mw.col.media.escape_media_filenames(c.answer())   # raw answer, NOT munged: only used for image/MathJax preload
self.web.eval(f"_showQuestion({json.dumps(q)}, {json.dumps(a)}, '{bodyclass}');")
self._update_flag_icon()   # web.eval(f"_drawFlag({card.user_flag()});")      user_flag = flags & 0b111
self._update_mark_icon()   # web.eval(f"_drawMark({json.dumps(note.has_tag('marked'))});")
self._showAnswerButton()   # bottom bar
```

`reviewer.py:460-484` (answer):

```python
if self.mw.state != "review": return
self.state = "answer"
a = c.answer()
# autoplay: c.answer_av_tags() only (question audio inside FrontSide is [anki:play:q:N] -> not autoplayed again)
a = self._mungeQA(a)                     # typeAnsAnswerFilter
a = gui_hooks.card_will_show(a, c, "reviewAnswer")
self.web.eval(f"_showAnswer({json.dumps(a)});")   # NOTE: bodyclass arg omitted (undefined) in the reviewer
self._showEaseButtons()
```

`ts/reviewer/index.ts` signatures (they are exported to `window` by `index_wrapper.ts`, which loops over `window[key] = globals[key]`):

```ts
export function _showQuestion(q: string, a: string, bodyclass: string): void   // :200  queued; sets body.className=bodyclass, scrolls top,
                                                                                //       focuses #typeans, preloads answer images/MathJax
export function _showAnswer(a: string, bodyclass: string): void                // :232  sets body.className only if bodyclass truthy;
                                                                                //       scrolls to #answer after images load
export function _drawFlag(flag: 0|1|2|3|4|5|6|7): void                         // :253  #_flag hidden if 0, color var(--flag-N)
export function _drawMark(mark: boolean): void                                 // :259
export function getTypedAnswer(): string | null                               // :60   value of #typeans captured at onshown
export function _typeAnsPress(): void                                          // :263  Enter -> bridgeCommand("ans")
export function _emulateMobile(enabled: boolean): void                         // :270
export function _blockDefaultDragDropBehavior(): void                          // :275
export async function _updateQA(html, _unused, onupdate, onshown): Promise<void> // :146
export const onUpdateHook: Array<Callback>; export const onShownHook: Array<Callback>; export const ankiPlatform = "desktop";
globalThis.anki.mutateNextCardStates / .imageOcclusion / .setupImageCloze    // :14-17
// also: globalThis.require (runtime-require), $ / jQuery
```

What `_updateQA` does (`index.ts:146-198`):

1. If the HTML matches `/\\\[(.*?)\\\]|\\\((.*?)\\\)/su`, it lazy-loads MathJax: `/_anki/js/mathjax.js`, then `/_anki/js/vendor/mathjax/tex-chtml-full.js`. Both are **absolute paths on the card origin**.
2. `preloadResources(html)` (fonts 800ms, css 500ms, images 200ms caps).
3. `qa.style.opacity=0`, then `innerHTML`, then re-creates every `<script>` so they execute, in order.
4. Runs `onUpdateHook`, then `bridgeCommand("updateToolbar")`, then `MathJax.typesetPromise([qa])`.
5. Sets opacity back to 1 and runs `onShownHook`.

Globals that `reviewer.js` expects from the host: **only `window.bridgeCommand`**. The built file calls it as `function fr(i,e){window.bridgeCommand(i,e)}`. Templates written for desktop also call `pycmd(...)` directly, so define both.

### 4.5 Every bridge message the card page can send

| Message | Sent by | Python handling (`reviewer.py:673-693`, `webview.py:850-873`) | Leitor |
|---|---|---|---|
| `domDone` | Qt bridge script, after load | Releases the queued evals | Shim posts `ready`; the host waits for it before the first `_showQuestion` |
| `updateToolbar` | `reviewer.js` `_updateQA`, on every show | Toolbar background image refresh | Ignore |
| `repaintNeeded` | `reviewer.js` `scrollToAnswer` | `web.update()` | Ignore |
| `ans` | `_typeAnsPress` (Enter in `#typeans`); also templates and the bottom bar | `_getTypedAnswer()` → eval `getTypedAnswer()` → `typedAnswer = val or ""` → `_showAnswer()` | Show answer (request the typed answer first) |
| `ease1`..`ease4` | Bottom bar buttons; some templates | `_answerCard(int(url[4:]))` (only if state == "answer") | Answer (validate 1–4, only on the answer side) |
| `play:q:N` / `play:a:N` | Play buttons from `av_refs_to_play_icons` | `play_clicked_audio` | Play the tag at that index (bounds-check) |
| `statesMutated` | `RUN_STATE_MUTATION` wrapper (host-evaluated) | `_states_mutated = True` (the ease buttons wait for it, polling every 50ms) | Same |
| `edit`, `more` | Bottom bar (not `reviewer.js`) | Edit current / context menu | Our native bar |
| `close` | Escape key handler injected by `AnkiWebView._on_load_finished` | `onEsc` | Optional |
| anything else | user templates | `print("unrecognized anki link")` | Ignore and log |

### 4.6 Type-in-the-answer filters (port verbatim)

`reviewer.py:698-805`:

```python
typeAnsPat = r"\[\[type:(.+?)\]\]"

def typeAnsQuestionFilter(self, buf: str) -> str:
    self._combining = True
    self.typeCorrect = None
    clozeIdx = None
    m = re.search(self.typeAnsPat, buf)
    if not m:
        return buf
    fld = m.group(1)
    if fld.startswith("cloze:"):
        clozeIdx = self.card.ord + 1
        fld = fld.split(":")[1]
    if fld.startswith("nc:"):
        self._combining = False
        fld = fld.split(":")[1]
    for f in self.card.note_type()["flds"]:
        if f["name"] == fld:
            self.typeCorrect = self.card.note()[f["name"]]
            if clozeIdx:
                self.typeCorrect = self._contentForCloze(self.typeCorrect, clozeIdx)  # extract_cloze_for_typing(txt, idx) or None
            self.typeFont = f["font"]
            self.typeSize = f["size"]
            break
    if not self.typeCorrect:
        if self.typeCorrect is None:
            if clozeIdx: warn = tr.studying_please_run_toolsempty_cards()
            else:        warn = tr.studying_type_answer_unknown_field(val=fld)
            return re.sub(self.typeAnsPat, warn, buf)
        else:
            return re.sub(self.typeAnsPat, "", buf)       # field exists but empty
    return re.sub(self.typeAnsPat, f"""
<center>
<input type=text id=typeans onkeypress="_typeAnsPress();"
   style="font-family: '{self.typeFont}'; font-size: {self.typeSize}px;">
</center>
""", buf)

def typeAnsAnswerFilter(self, buf: str) -> str:
    if not self.typeCorrect:
        return re.sub(self.typeAnsPat, "", buf)
    m = re.search(self.typeAnsPat, buf)
    type_pattern = m.group(1) if m else ""                 # only passed to hooks
    orig = buf
    origSize = len(buf)
    buf = buf.replace("<hr id=answer>", "")
    hadHR = len(buf) != origSize
    expected, provided = self.typeCorrect, self.typedAnswer  # (hook reviewer_will_compare_answer)
    output = self.mw.col.compare_answer(expected, provided, self._combining)
    def repl(match):
        s = """
<div style="font-family: '{}'; font-size: {}px">{}</div>""".format(self.typeFont, self.typeSize, output)
        if hadHR:
            s = f"<hr id=answer>{s}"     # keep separator before the comparison when using {{FrontSide}}
        return s
    if hadHR and not re.search(self.typeAnsPat, buf):
        return orig
    return re.sub(self.typeAnsPat, repl, buf)
```

Port notes:

- This is per-card state: `type_correct: Option<String>`, `combining: bool`, `type_font: String`, `type_size: u32`, `typed_answer: String`. It is set by the question filter and read by the answer filter.
- `re.sub` replaces **all** matches, so use `Regex::replace_all`. `re.search` takes the first match. There is no DOTALL, and `.+?` is lazy, which Rust `regex` supports.
- `fld.split(":")[1]` takes only the **second** segment. Keep that behaviour, quirks included (`cloze:nc:X` → `nc`, which then matches the `nc:` branch only if the segment starts with "nc:"; it does not).
- Field font and size come from the notetype field config, `field.config.font_name` (String) and `field.config.font_size` (u32). Proto: `notetypes.proto:84-85`; defaults "Arial"/20 at `rslib/src/notetype/fields.rs:45-46`. The note field value is the raw HTML of the field.
- The `"" vs None` difference matters. For a cloze, `extract_cloze_for_typing(...) or None` turns an empty string into None, which gives the "run Empty Cards" warning.
- Backend calls (`rslib/src/card_rendering/service.rs:166-180`; `typeanswer` is a private module, so go through the service trait):

```rust
use anki::services::CardRenderingService;
use anki_proto::card_rendering::{CompareAnswerRequest, ExtractClozeForTypingRequest};
let html = col.compare_answer(CompareAnswerRequest { expected, provided, combining })?.val;
let cloze = col.extract_cloze_for_typing(ExtractClozeForTypingRequest { text, ordinal: (card.template_idx() + 1) as u32 })?.val;
// NOTE: Card fields are pub(crate); use the accessor template_idx() (rslib/src/card/mod.rs:174)
```

- The output of `compare_answer` (`rslib/src/typeanswer.rs:32-70`) is `<code id=typeans>…</code>`:
  - `<span class=typeGood>` when correct.
  - Otherwise typed tokens, then `<br><span id=typearrow>&darr;</span><br>`, then expected tokens, using classes `typeGood`/`typeBad`/`typeMissed`.
  - With an empty typed answer it is just the escaped expected text.
- i18n keys (verified in `ftl/core/studying.ftl:35,45`): `studying-please-run-toolsempty-cards`, `studying-type-answer-unknown-field = Type answer: unknown field { $val }`.
- The typed answer comes from the iframe: the host asks the shim to return `getTypedAnswer()` (null becomes "").

### 4.7 Custom scheduling JS (state mutation)

`reviewer.py:162,182,286-297,1237-1244`. When the reviewer opens, `cardStateCustomizer` is read from collection config (`:182`). On every question, if it is non-empty, the host evaluates:

```js
anki.mutateNextCardStates('{key}', async (states, customData, ctx) => {
    {js}
    }).finally(() => bridgeCommand('statesMutated'));
```

- `key` = `str(random.randint(0, 2**64-1))`, generated once per Reviewer instance (`reviewer.py:162`, in `__init__`).
- **Error path (added in review):** if the eval fails (for example a syntax error in the user JS), the Qt eval callback receives `None` and Python sets `_states_mutated = True` anyway (`reviewer.py:286-291`). Otherwise the ease buttons would never appear. Our shim must do the same: wrap `new Function(...)` in try/catch and always post `statesMutated`. Also add a host-side timeout, because a never-settling promise blocks the answer buttons forever (Python has the same bug).
- If no `cardStateCustomizer` is set, `_states_mutated` stays `True` and nothing is evaluated.
- `mutateNextCardStates` (`ts/reviewer/answering.ts`) POSTs `getSchedulingStatesWithContext`, runs the JS, then POSTs `setSchedulingStates{key, states}`.
- The ease buttons are not built until `statesMutated` arrives (`reviewer.py:859-862`).
- `V3CardInfo.from_queue` copies `top_card.card.custom_data` into `states.current.custom_data` before exposing it (`reviewer.py:97-103`). The proto comment confirms that the backend does **not** fill it (`proto/anki/scheduler.proto:128-131`). Do the same.
- Rust `QueuedCard { card, kind, states, context }` (`rslib/src/scheduler/queue/mod.rs:60-65`).

### 4.8 Audio and TTS (`qt/aqt/sound.py`)

- `AVPlayer.play_tags(tags)` clears the queue, interrupts the current playback (`interrupt_current_audio=True`), then plays the tags in order (`sound.py:153-158`).
- Replay (`reviewer.py:74-81`):
  - Question side: question tags.
  - Answer side: answer tags, with the question tags first if deck conf `replayq` (default True, `cards.py:206-208`).
- Autoplay is controlled by deck conf `autoplay` (`cards.py:210-213`).
- Leitor:
  - Play `[sound:]` files in the **host** with `<audio>`/`<video>`, so they keep working inside the sandboxed iframe without gesture rules. The source is the media file by basename.
  - Play TTS with `speechSynthesis`: map `lang` `en_US` → `en-US`, `speed` → `utterance.rate` (default 1.0), and pick `voices[]` by name if present.
  - `field_text` is already HTML-stripped by rslib (`card_rendering/writer.rs:142`, `strip_html_for_tts`).
  - Video in Anki goes to mpv; we need an overlay `<video>`.
- Shortcuts in the desktop reviewer:
  - `r`/F5 replay; `5` pause; `6`/`7` seek ±5s; `v`/`Shift+V` replay/record own voice.
  - `e` edit; `*` mark; `=` bury note; `-` bury card; `!` suspend note; `@` suspend card; `u` undo; `o` options; `i` card info.
  - Answer keys come from the profile (`reviewer.py:594-641`).

### 4.9 Bottom bar (reference only; build it natively)

`reviewer.py:810-951`:

- Show-answer button: `pycmd("ans")` with counts `<span class=new-count>`, `learn-count`, `review-count`. The current queue index is wrapped in `<u>`, and counts are shown only if col conf `dueCounts`.
- Ease buttons: `data-ease=i`, `onclick='pycmd("ease%d")'`. The default ease is 3 (`id="defease"`). The labels come from `sched.describe_next_states(states)` and are shown only if col conf `estTimes`. v3 always has 4 buttons.
- Timer: `showQuestion(middle, maxTime)`, with `maxTime = conf.maxTaken` if conf `timer`, else 0. `showAnswer(middle, stopTimerOnAnswer)`.
- Rust: `pub fn describe_next_states(&mut self, choices: &SchedulingStates) -> Result<Vec<String>>` (`rslib/src/scheduler/answering/mod.rs:269`). `pub fn answer_card(&mut self, answer: &mut CardAnswer) -> Result<OpOutput<()>>` (`:317`). `CardAnswer { card_id, current_state, new_state, rating, answered_at, milliseconds_taken, custom_data, from_queue }` (`:48-57`). `milliseconds_taken` is uncapped in Python (`time_taken(capped=False)`, `pylib/anki/scheduler/v3.py:91`); rslib caps it via `cap_answer_secs` (`answering/mod.rs:60,330`).
- **(Added in review)** Python builds the answer from the proto states (`v3.py:66-92`): `new_state = states.{again,hard,good,easy}` by rating, `current_state = states.current` (with `custom_data` copied in, §4.7), and `answered_at_millis = now`. `rating_from_ease`: 1→AGAIN, 2→HARD, 3→GOOD, else EASY (`reviewer.py:125-133`). Proto `CardAnswer` (`scheduler.proto:272-286`) has no `custom_data` field; custom data travels inside `new_state.custom_data`. Because the `CardAnswer` Rust struct needs `CardState` (not proto), the simplest port is FWD `SchedulerService.AnswerCard` with the proto, exactly like Python (`v3.py:94-98`).
- **Auto-advance** (`reviewer.py:407-529,1212`, `Shift+A`): deck conf `secondsToShowQuestion`/`secondsToShowAnswer`, `waitForAudio`, `questionAction`, `answerAction`. Out of scope unless the spec asks for it.
- `ans` on the question side resets `typedAnswer` to `None` in `_showQuestion` (`reviewer.py:373`), and `_onTypedAnswer` turns `None` into `""` (`:803-805`).

---

## 5. The `card` protocol and the iframe shim (recommended design)

The shim, `card://localhost/_leitor/card-bridge.js`, is loaded before `reviewer.js`:

```js
(() => {
  const host = window.parent;
  let seq = 0; const cbs = new Map();
  window.pycmd = window.bridgeCommand = (cmd, cb) => {
    const id = cb ? ++seq : 0; if (cb) cbs.set(id, cb);
    host.postMessage({ t: "pycmd", cmd: String(cmd), id }, "*");
    return false;
  };
  addEventListener("message", (e) => {
    if (e.source !== host) return;
    const m = e.data;
    switch (m && m.t) {
      case "showQuestion": window._showQuestion(m.q, m.a, m.bodyclass); break;
      case "showAnswer":   window._showAnswer(m.a); break;
      case "flag":         window._drawFlag(m.flag | 0); break;
      case "mark":         window._drawMark(!!m.mark); break;
      case "getTypedAnswer": host.postMessage({ t: "typed", v: window.getTypedAnswer() ?? "" }, "*"); break;
      case "mutateStates": /* run m.js via new Function(...) wrapped exactly like RUN_STATE_MUTATION */ break;
      case "cb": { const f = cbs.get(m.id); cbs.delete(m.id); f && f(m.v); break; }
      case "theme": /* toggle html.night-mode + data-bs-theme + body nightMode/night_mode */ break;
    }
  });
  addEventListener("DOMContentLoaded", () => host.postMessage({ t: "ready" }, "*"));
})();
```

Host side: accept a message only if `e.source === iframe.contentWindow`. Expect `e.origin === "null"` (sandboxed opaque origin) and whitelist `cmd` against §4.5.

Card-protocol rules (Anki equivalents in parentheses):

- `GET /_anki/js/{reviewer,mathjax,webview}.js`, `/_anki/js/vendor/mathjax/**`, `/_anki/css/{webview,reviewer}.css` come from the bundle.
- `GET /_leitor/*` is our shim and page.
- Any other `GET /<file>` is **collection media** (root = `collection.media`; `ensure_safe_path`; **`UNTRUSTED_MEDIA_CSP`** on the response, as in `mediasrv.py:413-415`).
- `POST /_anki/{getSchedulingStatesWithContext,setSchedulingStates,i18nResources,congratsInfo}` is allowed, with the exact `Content-Type: application/binary`. Every other POST returns **403** (`mediasrv.py:1329-1340`).
- The card page response itself should carry a CSP such as `default-src card: data: blob:; script-src card: 'unsafe-inline' 'unsafe-eval'; style-src card: 'unsafe-inline'; connect-src card:; frame-ancestors <app origin>`. This makes a card's `fetch()` to `anki://` impossible regardless of anything else. Deck templates need inline script and eval.

Gotchas for the sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`):

- The origin is opaque. `fetch("/_anki/…")` from `reviewer.js` (`getSchedulingStatesWithContext`, `i18nResources` for image occlusion) is therefore **cross-origin**, and `Content-Type: application/binary` triggers a **CORS preflight**.
  - The card handler must answer `OPTIONS` for those 4 paths with `Access-Control-Allow-Origin: null`, `Access-Control-Allow-Methods: POST` and `Access-Control-Allow-Headers: content-type, anki-op-changes`, and put `Access-Control-Allow-Origin: null` on the POST response.
  - Alternative: have the shim wrap `window.fetch` for `/_anki/` URLs and tunnel them over `postMessage`. That avoids both CORS and custom-scheme POST-body issues.
  - Custom-scheme POST bodies on WKWebView/WebKitGTK are **unverified; spike it**.
- MathJax loads `.woff` fonts via `@font-face`. Font loads use CORS, so those responses also need `Access-Control-Allow-Origin: *`. Anki avoids this with same-origin (see the comment at `mediasrv.py:93-97`). Template `@font-face` with media fonts needs the same.
- `localStorage`, `sessionStorage` and `document.cookie` throw in opaque-origin frames. Some shared-deck templates use them; wrap them or accept the breakage.
- `alert` and `confirm` are blocked without `allow-modals`.
- Autoplay of `<audio>` inside the iframe needs a user gesture, which is another reason to play audio in the host.
- Tauri custom-protocol origins differ by platform: `anki://localhost` on macOS/iOS/Linux, `http://anki.localhost` on Windows/Android. Make every origin check and CSP platform-aware.

`anki` protocol hardening (the Anki equivalents are the Host/Origin checks at `mediasrv.py:494-503` and the Bearer key at `1369-1376`, injected by `AuthInterceptor`, `webview.py:88-99`):

- Never send CORS headers on `anki://`.
- Require the exact `application/binary` Content-Type on POST. This forces a preflight from any foreign origin, and the preflight will fail.
- Reject any request whose `Origin` header is present and is not the anki origin.
- Show the pages in a webview or iframe that has **no Tauri capabilities**, so there is no `invoke`.

---

## 6. Recommendations (prioritised)

1. **Asset extraction** (build step):
   - Download `aqt==26.9.3` and check its sha256 against §1.
   - Copy the minimal set from §1 into `src-tauri/resources/anki-web/`.
   - Fail the build if `_SVELTEKIT_CSP_META_RE` does not match `sveltekit/index.html`, because we strip it at serve time like Anki does.
   - Record the AGPL-3.0 obligation; the assets are AGPL.
2. **`anki` protocol** = a port of §2.3 and §2.5:
   - SPA fallback; immutable caching; the MIME table.
   - Strip the CSP meta and inject `<script src="/_leitor/page-bridge.js">` (it defines `bridgeCommand`, and polyfills `alert`/`confirm` if the platform lacks them).
   - Our header CSP; the POST dispatcher with the §3 table; `Anki-Op-Changes` → Tauri event.
3. **Dispatch table** (revised in review; see §2.5):
   - Preferred: a hand-written `match name { "getDeckNames" => call::<DecksService>(…), … }` that uses the pub `anki::services::*` traits plus `prost` decode/encode. It needs no descriptor pool, and a typo is a compile error.
   - If we use an index table instead: `anki_proto` does not export its pool, so it has to be generated from `proto/anki/*.proto`, skipping `Backend*` services and `FrontendService`, and mapping `camelCase(rpc) → (service.index(), method.index())`. Add a startup self-test.
   - Either way, cover all 55 entries of §3.2 except `addMediaFromUrl` (Backend-only).
4. **Progress:**
   - Build the collection with `set_shared_progress_state`.
   - Answer `setWantsAbort` and `latestProgress` outside the actor; `latestProgress` returns an empty `Progress`, a known limitation. Alternatively, own the collection through `anki::backend::Backend` (§2.6 option d) to get real progress.
   - Run `computeFsrsParams` and similar calls so they do not block the rest of the UI unnecessarily.
5. **Reviewer core (Rust, in `core-anki`)**:
   - `render_card_for_review(cid) -> {q_html, a_html_raw, q_av, a_av, css, bodyclass}` using `partial_render=true` with the FrontSide, LaTeX and `tts-voices` port (§4.2).
   - Then `prepare_card_text_for_display` (§4.3), then the type-answer filters (§4.6).
   - Send it to the iframe via the shim as `showQuestion`/`showAnswer`.
6. **Card protocol + iframe** as in §5. The required test (spec §8.4) is that `invoke` and `POST /_anki/addNote` fail from inside a card. Add these tests too:
   - `fetch('anki://localhost/_anki/addNote')` is blocked by CSP.
   - `/_anki/getSchedulingStatesWithContext` works, so custom scheduling JS still runs.

## 7. Open items / not verified

- Same-origin ES-module loading and POST bodies on custom schemes for each platform webview (WebKitGTK, WKWebView, WebView2, Android). Spike before Phase 2.
- Whether wry/Tauri 2 implements `alert`/`confirm` on macOS/iOS/Linux.
- ~~The `latestProgress` limitation (§2.6) cannot be solved without changing Anki.~~ **Corrected in review:** it can be solved by owning the collection through `anki::backend::Backend` (§2.6 option d). The open question is whether that fits the actor design in `anki-rslib-api.md`.
- Service-index stability if we use an index table instead of direct trait dispatch (§2.5).
- `ts/reviewer/reviewer_extras.ts` builds a separate `reviewer_extras_bundle.js` for mobile clients (`build/configure/src/web.rs:281-293`). It is **not** in the aqt wheel and we do not need it, because `reviewer.js` already includes the same `anki.mutateNextCardStates`/`imageOcclusion` setup (`ts/reviewer/index.ts:14-17`).
