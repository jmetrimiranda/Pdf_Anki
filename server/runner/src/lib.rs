//! Leitor de Estudos C++ runner (spec 11.5): `GET /health`, `POST /run` (Bearer token), one run at a time.
//!
//! Isolation comes from the container (compose: internal network only, read-only root, tmpfs `/work`, non-root,
//! no capabilities) plus per-run `prlimit` + `timeout` (CPU 5 s, 512 MB, 64 processes, 10 MB files).

pub mod api;
pub mod exec;
pub mod validate;

/// The `CHECK(expr)` header, byte-identical to `src-tauri/crates/core-cpp/check.hpp`.
pub const CHECK_HPP: &str = include_str!("../check.hpp");
