# Leitor de Estudos

PDF/EPUB reader with Anki's core inside (Tauri 2 + React). The spec is the source of truth: [docs/PROJETO.md](docs/PROJETO.md).
Decisions: [docs/decisoes.md](docs/decisoes.md) · Progress per phase: [docs/progresso.md](docs/progresso.md) · Upstream API notes: [docs/tecnico/](docs/tecnico/).

Scope for now (user decision, 2026-10-22): desktop only — Linux first, Windows via CI. iOS/iPad deferred, but keep the
Rust core free of desktop-only APIs (desktop-only code goes behind `cfg(desktop)` in `src-tauri/app`).

## Environment

Everything runs in the devcontainer (`.devcontainer/`): Rust 1.97.1, protoc 31.1 (`PROTOC` is set), Node 22 + pnpm, Tauri
Linux deps, g++/clang, Xvfb. Without VS Code: `scripts/dev.sh <cmd…>` runs a command inside the same image.

## Commands

| What | Command |
|---|---|
| Dev desktop | `pnpm --dir web install && cd src-tauri && cargo tauri dev` (or `pnpm --dir web tauri dev`) |
| Dev iOS | deferred (see docs/decisoes.md) |
| Rust tests | `cd src-tauri && cargo test -j 8 --workspace` |
| Web tests | `pnpm --dir web test` · checkers: `pnpm --dir packages/checkers test` |
| E2E (mocked core) | `pnpm --dir web e2e` |
| Lint | `cd src-tauri && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings` · `pnpm --dir web lint` |
| Build | `pnpm --dir web tauri build` (AppImage/.deb on Linux, .msi on Windows CI) |
| Release | push a tag `v*` → `.github/workflows/release.yml` |
| Anki web assets | `scripts/fetch-anki-web.sh` (extracts `aqt==26.9.3` web assets to `src-tauri/resources/anki-web/`) |

## Rules that bite

- Pinned upstreams: Anki tag `26.09.3`, PdfCraft submodule commit in docs/decisoes.md. Never update both in one PR. Read the
  pinned source before using an API (`docs/tecnico/` has verified notes).
- `[patch.crates-io]` in `src-tauri/Cargo.toml` mirrors PdfCraft's; re-diff it whenever the submodule moves.
- One `rusqlite`/`libsqlite3-sys` in the graph: Anki's (0.36). No sqlx, no Tauri SQL plugin.
- `core-pdf` is the only crate that touches PdfCraft; `core-anki` (AnkiService actor thread) is the only owner of the collection.
- Untrusted input (PDF, EPUB, .apkg) never panics the app — errors become pt-BR messages.
- UI text in pt-BR in `web/src/i18n/pt-BR.ts`; code, commands and commits in English.
- Custom protocol URLs only through `protocolUrl(scheme, path)` (Windows uses `http://<scheme>.localhost/`).
