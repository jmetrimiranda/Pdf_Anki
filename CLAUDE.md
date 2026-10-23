# Leitor de Estudos

PDF/EPUB reader with Anki's core inside (Tauri 2 + React). The spec is the source of truth: [docs/PROJETO.md](docs/PROJETO.md)
(v1.1).

The reading screen **is PdfCraft's own UI**: the web build of `third_party/pdfcraft/apps/pdfcraft-web` (egui → WebAssembly,
WebGL canvas) runs in an iframe at the same origin under `/pdfcraft/`, and talks to the app only through `postMessage`
(the bridge, spec 6.2). The app adds things *around* the iframe (tabs Biblioteca | Leitor | Anki, the "Painel Anki do
livro") and never restyles what is inside. Annotations and bookmarks are PdfCraft's, saved inside the PDF (autosave →
new file version, spec 6.5). `core-pdf` uses only `pdfcraft-render`/`-annot`/`-ocr`/`-cos` (+ `-organize` for the Info dict) for page text with word rects,
covers, metadata/Info (`LeitorBookUid`) and OCR — no `pdfcraft-engine`, no reading renderer.

Decisions: [docs/decisoes.md](docs/decisoes.md) · Progress per phase: [docs/progresso.md](docs/progresso.md) · Upstream API notes: [docs/tecnico/](docs/tecnico/).

Scope (user decision, 2026-10-23): Linux (desktop app) + Web (UI, TS packages) only. Windows is out: no Windows CI on push/PR (manual workflow_dispatch only), never fix Windows-only failures, no Windows builds — just don't break it on purpose (use `Path`, no needless shell-only code). The CI that must stay green is Linux + Web. iOS/iPad deferred, but keep the
Rust core free of desktop-only APIs (desktop-only code goes behind `cfg(desktop)` in `src-tauri/app`).

## Environment

Everything runs in the devcontainer (`.devcontainer/`): Rust 1.97.1, protoc 31.1 (`PROTOC` is set), Node 22 + pnpm, Tauri
Linux deps, g++/clang, Xvfb, the PdfCraft web toolchain (trunk 0.22.0, wasm-bindgen 0.2.129, wasm-opt/binaryen
version_131, `wasm32-unknown-unknown`) and the Playwright browsers (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`,
Mesa for software WebGL). Without VS Code: `scripts/dev.sh <cmd…>` runs a command inside the same image
(`LEITOR_DEV_IMAGE=<tag>` picks another image, `LEITOR_DEV_NETWORK=<net>` joins a docker network).

## Commands

| What | Command |
|---|---|
| PdfCraft web build | `scripts/build-pdfcraft-web.sh` (`--force` to rebuild; ~4 min the first time, "up to date" after) → `src-tauri/resources/pdfcraft-web/` |
| Dev desktop | `scripts/build-pdfcraft-web.sh` once (again whenever the fork changes), then `pnpm --dir web install && pnpm --dir web tauri dev` |
| Dev iOS | deferred (see docs/decisoes.md) |
| Rust tests | `cd src-tauri && cargo test -j 8 --workspace` |
| Web tests | `pnpm --dir web test` · checkers: `pnpm --dir packages/checkers test` |
| E2E (mocked core) | `pnpm --dir web e2e:mock` (Chromium + WebKit) |
| E2E bridge (real PdfCraft web build) | `pnpm --dir web e2e:bridge` (needs the PdfCraft web build; `xvfb-run -a` in CI) · performance: `pnpm --dir web e2e:perf` |
| Real app bridge probe (debug) | `LEITOR_BRIDGE_PROBE=1 LEITOR_START_ROUTE=/leitor xvfb-run -a src-tauri/target/debug/leitor-estudos [file.pdf]` logs every `pdfcraft:*` message, CSP violations and WebGL support; `LEITOR_BRIDGE_PROBE=perf` also times open → active and scrolling |
| Real app performance (WebKitGTK, debug build + `perf-500.pdf` from `e2e:perf`) | `scripts/perf-real-app.sh` (inside the devcontainer) → `web/test-results/realapp/summary.txt` |
| Leitor tab load time (click → `pdfcraft:ready`, later openings; `window.__leitorTimings`) | `pnpm --dir web e2e:load` (Chromium + WebKit) · real app: `scripts/load-real-app.sh` (`CACHE=warm`, `BIN=…/release/leitor-estudos` built with `--features bridge-probe,tauri/custom-protocol`) |
| Lint | `cd src-tauri && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings` · `pnpm --dir web lint` |
| Build | `pnpm --dir web tauri build` (AppImage/.deb on Linux; runs `build-pdfcraft-web.sh` first) |
| Release | push a tag `v*` → `.github/workflows/release.yml` |
| Anki web assets | `scripts/fetch-anki-web.sh` (extracts `aqt==26.9.3` web assets to `src-tauri/resources/anki-web/`) |
| Anki web assets location | bundled as Tauri resources (`<resource_dir>/anki-web`); `LEITOR_ANKI_WEB_DIR=<dir>` overrides; debug builds fall back to `src-tauri/resources/anki-web` |
| Anki fixture collection | `cargo run -p core-anki --example seed_fixture -- <LEITOR_DATA_DIR>/anki [--isolation-probe] [--force]` (prints the deck/card ids as JSON) |
| Real app Anki probes (WebKitGTK, Xvfb, fixture) | `scripts/anki-real-app.sh isolation` (card iframe isolation) · `scripts/anki-real-app.sh pages` (Anki's pages over the `anki` protocol) → `web/test-results/anki-realapp/summary.txt` |
| Record Anki page requests for the bridge tests | `scripts/record-anki-posts.sh` → `src-tauri/crates/core-anki/tests/fixtures/bridge/` (commit them) |
| Real app captures with the fixture | `bash -c 'LEITOR_CAPTURE_SEED=1 scripts/capture.sh docs/capturas/fase-N /anki "/anki/opcoes/{deck:5000 palavras}"'` (env vars must be set inside `scripts/dev.sh`, which doesn't forward them); with a book: `python3 -I scripts/sample-book-pdf.py "/tmp/cap/Animal Farm.pdf"` and `LEITOR_CAPTURE_PDF="/tmp/cap/Animal Farm.pdf"` (imports it; `{book}` in a route = its uid, e.g. `/leitor?livro={book}&painel=card&trecho=…`) |
| Local Anki sync server (official `anki==26.9.3` + TLS dev CA, network `leitor-dev`) | `scripts/ankisync-dev-certs.sh` (dev CA + server cert into `server/ankisync-dev/certs/`, gitignored), then `docker compose -f compose.dev.yml up -d --build --wait`; `docker compose -f compose.dev.yml down -v` after. Never sync with any other server. Docs: `docs/tecnico/anki-sync-dev.md` |
| Sync integration tests (host, repo root) | `scripts/sync-test.sh [all\|core-anki\|app\|crosscheck]` (recreates the server empty, checks 26.9.3, runs the gated Rust suites on `leitor-dev` under the keyring, the official Python client cross-check, then `down -v`) |
| Keychain in the container (Secret Service) | `scripts/with-keyring.sh <cmd…>` (private D-Bus + unlocked gnome-keyring, sets `LEITOR_TEST_KEYRING=1`); debug builds also accept `LEITOR_SECRET_STORE=memory` |
| Deep link `leitor://livro/<uid>?pagina=N&q=…` (dev) | Run-time registration (background thread, never on the startup path) is off in debug builds and for non-AppImage Linux runs (the bundler registers `.deb`/`.rpm`); `LEITOR_DEEP_LINK_REGISTER=1` forces it (e.g. to check with `xdg-mime query default x-scheme-handler/leitor`), `=0` disables it; it never takes the scheme from another handler; test a running app with a second launch: `src-tauri/target/debug/leitor-estudos 'leitor://livro/<uid>?pagina=3&q=windmill'` |
| Rust ↔ TS contract snapshot | `LEITOR_UPDATE_CONTRACT=1 cargo test -p leitor-estudos --test contract` rewrites `web/src/lib/core/__fixtures__/contract.json` (Vitest `contract.test.ts` checks the mock against it) |

## PdfCraft fork workflow

- `third_party/pdfcraft` is the fork `jmetrimiranda/pdfcraft`, branch `leitor-bridge` (remote `fork`), based on the
  pinned upstream commit in docs/decisoes.md. Core crates and the reading screen always come from the **same** commit.
- Edit only `apps/pdfcraft-web` and the smallest hook points in `crates/ui-egui` (bridge events). Follow PdfCraft's
  `AGENTS.md`/`CLAUDE.md` (Rust only, never panic, no GPL/AGPL code, their style and tests) so it can go upstream as a PR.
- Validate in the submodule: `cargo test`/`cargo clippy` of the touched crates and a wasm32 check
  (`cargo check --target wasm32-unknown-unknown -p pdfcraft-web`; `build-pdfcraft-web.sh` does it through trunk).
- Commit inside the submodule, `git -C third_party/pdfcraft push fork leitor-bridge`, then commit the new submodule
  pointer here. Rebasing on upstream `main` is its own PR (re-diff `[patch.crates-io]`, rerun the bridge tests).

## Rules that bite

- Pinned upstreams: Anki tag `26.09.3`, PdfCraft submodule commit in docs/decisoes.md. Never update both in one PR. Read the
  pinned source before using an API (`docs/tecnico/` has verified notes).
- `[patch.crates-io]` in `src-tauri/Cargo.toml` mirrors PdfCraft's; re-diff it whenever the submodule moves.
- One `rusqlite`/`libsqlite3-sys` in the graph: Anki's (0.36). No sqlx, no Tauri SQL plugin.
- `core-pdf` is the only Rust crate that touches PdfCraft; `core-anki` (AnkiService actor thread) is the only owner of the collection.
- The `/pdfcraft/` iframe must stay same-origin: CSP keeps `frame-ancestors 'self'`/`frame-src 'self'` and allows
  `'wasm-unsafe-eval'` and `blob:` workers. PdfCraft never gets `invoke`; the app validates every bridge message.
- Book bytes cross IPC raw (`tauri::ipc::Response` / raw request body), never as JSON arrays.
- Never `preventDefault` a key PdfCraft uses (it owns Ctrl+1/2/3, Ctrl+P, Ctrl+Shift+N…): app shortcuts are listed in
  docs/decisoes.md.
- Untrusted input (PDF, EPUB, .apkg) never panics the app — errors become pt-BR messages.
- UI text in pt-BR in `web/src/i18n/pt-BR.ts`; code, commands and commits in English.
- Custom protocol URLs only through `protocolUrl(scheme, path)` (Windows uses `http://<scheme>.localhost/`).
