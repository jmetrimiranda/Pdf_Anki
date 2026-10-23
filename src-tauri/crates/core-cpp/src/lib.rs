//! C++ for the code cards (spec 11.5).
//!
//! - **Local** (desktop): [`run_local`] compiles with the `g++`/`clang++` found on the PATH ([`detect_local`]) in a
//!   fresh temporary directory, with wall-clock timeouts, process-group kill and (Linux, via util-linux `prlimit`)
//!   CPU/memory/file-size/process limits.
//! - **Remote**: [`RemoteRunner`] talks to `server/runner` (`POST /run`, Bearer token).
//!
//! Both validate requests the same way ([`validate`]) and always provide [`CHECK_HPP`] next to the sources.

mod local;
mod process;
mod remote;
mod toolchain;
pub mod validate;

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use local::run_local;
pub use remote::RemoteRunner;
pub use toolchain::{detect_local, format_cpp};
pub use validate::ValidationError;

/// The `CHECK(expr)` header of mode `testes`, written as `check.hpp` next to the sources of every run.
pub const CHECK_HPP: &str = include_str!("../check.hpp");

/// Wall-clock limit of a compilation.
pub const COMPILE_TIMEOUT_MS: u64 = 10_000;
/// Wall-clock limit of a run; [`CppRequest::timeout_ms`] can lower it, never raise it.
pub const RUN_TIMEOUT_MS: u64 = 10_000;
/// Each captured stream (stdout, stderr, compiler output) keeps at most this many bytes.
pub const OUTPUT_CAP_BYTES: usize = 256 * 1024;

/// A program to compile and run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CppRequest {
    /// File name → content. Names follow [`validate::file_kind`]; at least one `.cpp`.
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub stdin: String,
    /// Lowers the run time limit ([`RUN_TIMEOUT_MS`]); `None` keeps it.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Where the program ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CppRunResult {
    pub backend: Backend,
    /// `g++ (Debian 12.2.0-14) 12.2.0`-like first line of `--version`, when known.
    pub compiler: Option<String>,
    pub compile: CompileResult,
    /// `None` when the compilation failed.
    pub run: Option<RunResult>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub ok: bool,
    /// Compiler diagnostics (capped at [`OUTPUT_CAP_BYTES`]).
    pub stderr: String,
    pub time_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// `None` when the program was killed by a signal.
    pub exit_code: Option<i32>,
    /// `SIGKILL`, `SIGXCPU`, `SIGXFSZ`, `SIGSEGV`, `SIGABRT`…
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub time_ms: u64,
    /// The wall-clock or CPU limit was reached and the program was killed.
    pub timed_out: bool,
    /// stdout or stderr went over [`OUTPUT_CAP_BYTES`] and was cut.
    pub truncated: bool,
}

/// The local compiler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompilerInfo {
    pub path: PathBuf,
    /// `"g++"` or `"clang++"`.
    pub name: String,
    /// First line of `<compiler> --version` (empty if it printed nothing).
    pub version: String,
}

/// What [`detect_local`] found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolchain {
    pub compiler: Option<CompilerInfo>,
    pub clang_format: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RunError {
    /// No local compiler (desktop) / no runner configured.
    #[error("no C++ compiler available")]
    Unavailable,
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("request too large")]
    TooLarge,
    #[error("I/O error: {0}")]
    Io(String),
    #[error("runner unreachable: {0}")]
    RemoteUnreachable(String),
    #[error("runner refused the token")]
    RemoteAuth,
    #[error("runner busy")]
    RemoteBusy,
    #[error("unexpected runner response: {0}")]
    RemoteProtocol(String),
}

impl RunError {
    /// Stable machine-readable code (`snake_case`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::InvalidRequest(_) => "invalid_request",
            Self::TooLarge => "too_large",
            Self::Io(_) => "io",
            Self::RemoteUnreachable(_) => "remote_unreachable",
            Self::RemoteAuth => "remote_auth",
            Self::RemoteBusy => "remote_busy",
            Self::RemoteProtocol(_) => "remote_protocol",
        }
    }

    /// Message for the user (pt-BR).
    pub fn message_pt(&self) -> String {
        match self {
            Self::Unavailable => {
                "Nenhum compilador C++ encontrado. Instale o g++ ou o clang++ (ou configure o runner).".to_owned()
            }
            Self::InvalidRequest(detail) => format!("Pedido inválido: {detail}"),
            Self::TooLarge => format!(
                "O código ou a entrada passam do limite ({} KiB de código, {} KiB de entrada).",
                validate::MAX_SOURCE_BYTES / 1024,
                validate::MAX_STDIN_BYTES / 1024
            ),
            Self::Io(detail) => format!("Erro ao executar o código: {detail}"),
            Self::RemoteUnreachable(_) => "Não foi possível falar com o runner. Verifique o endereço e a conexão.".to_owned(),
            Self::RemoteAuth => "O runner recusou o token. Confira o token em Configurações → Código.".to_owned(),
            Self::RemoteBusy => "O runner está ocupado. Tente de novo em alguns segundos.".to_owned(),
            Self::RemoteProtocol(_) => "O runner respondeu algo inesperado.".to_owned(),
        }
    }
}

impl From<ValidationError> for RunError {
    fn from(err: ValidationError) -> Self {
        if err.is_too_large() {
            Self::TooLarge
        } else {
            Self::InvalidRequest(err.to_string())
        }
    }
}

impl From<std::io::Error> for RunError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

/// The effective run limit of a request (never above [`RUN_TIMEOUT_MS`], at least 100 ms).
pub fn effective_run_timeout_ms(req: &CppRequest) -> u64 {
    req.timeout_ms
        .unwrap_or(RUN_TIMEOUT_MS)
        .clamp(100, RUN_TIMEOUT_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_shapes() {
        let req: CppRequest = serde_json::from_str(r#"{"files":{"main.cpp":"x"}}"#).unwrap();
        assert_eq!(req.stdin, "");
        assert_eq!(req.timeout_ms, None);
        let result = CppRunResult {
            backend: Backend::Local,
            compiler: None,
            compile: CompileResult {
                ok: true,
                stderr: String::new(),
                time_ms: 1,
            },
            run: Some(RunResult {
                exit_code: Some(0),
                ..RunResult::default()
            }),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["backend"], "local");
        assert_eq!(json["compile"]["timeMs"], 1);
        assert_eq!(json["run"]["exitCode"], 0);
        assert_eq!(json["run"]["timedOut"], false);
    }

    #[test]
    fn timeout_is_never_raised() {
        let mut req = CppRequest::default();
        assert_eq!(effective_run_timeout_ms(&req), RUN_TIMEOUT_MS);
        req.timeout_ms = Some(60_000);
        assert_eq!(effective_run_timeout_ms(&req), RUN_TIMEOUT_MS);
        req.timeout_ms = Some(2_000);
        assert_eq!(effective_run_timeout_ms(&req), 2_000);
        req.timeout_ms = Some(0);
        assert_eq!(effective_run_timeout_ms(&req), 100);
    }

    #[test]
    fn error_codes_and_messages() {
        let err: RunError = ValidationError::SourceTooLarge(1).into();
        assert_eq!(err, RunError::TooLarge);
        let err: RunError = ValidationError::NoSource.into();
        assert_eq!(err.code(), "invalid_request");
        for e in [
            RunError::Unavailable,
            RunError::Io("x".into()),
            RunError::RemoteUnreachable("x".into()),
            RunError::RemoteAuth,
            RunError::RemoteBusy,
            RunError::RemoteProtocol("x".into()),
        ] {
            assert!(!e.message_pt().is_empty());
        }
    }
}
