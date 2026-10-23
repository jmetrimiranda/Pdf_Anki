# runner

C++ runner of the code cards (spec 11.5): `GET /health`, `POST /run` with `Authorization: Bearer <RUNNER_TOKEN>`.
Rust + axum, a standalone Cargo project (its own `Cargo.lock`; not part of `src-tauri`, no Anki dependencies,
MIT/Apache-2.0 dependencies only).

- `src/api.rs` — routes, Bearer auth (constant-time), validation, one run at a time (queue of 8, else 503)
- `src/exec.rs` — job dir under `/work`, `prlimit` + `timeout`, jobs as uid 10002 via `setpriv` with a cleared
  environment, process-group kill plus the per-uid reaper (`runner --reap`), 256 KiB output cap
- `src/validate.rs`, `check.hpp` — byte-identical copies of `src-tauri/crates/core-cpp/{src/validate.rs,check.hpp}`
  (checked by `core-cpp`'s `tests/shared_files.rs`)
- `Dockerfile` — multi-stage (rust:1.97.1-slim-bookworm → debian:bookworm-slim with g++, clang-format, util-linux,
  coreutils; server uid 10001 via a `setpriv` entrypoint with ambient CAP_SETUID/CAP_SETGID only, jobs uid 10002;
  `runner --healthcheck`)
- `Caddyfile` — the dev proxy (`runner-dev-proxy` in `compose.dev.yml`), the only ingress

Unit tests (devcontainer): `scripts/dev.sh bash -c 'cd server/runner && CARGO_TARGET_DIR=$PWD/../../src-tauri/target/runner cargo test'`.
Isolation tests: `scripts/runner-test.sh`. Full notes (pt-BR): [docs/tecnico/runner.md](../../docs/tecnico/runner.md).
