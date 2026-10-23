//! Finding the local compiler and clang-format.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use crate::process::{find_on_path, is_executable, supervise};
use crate::{CompilerInfo, LocalToolchain};

/// Environment variable naming the compiler to use (a path or a name on the PATH).
pub const CXX_ENV: &str = "LEITOR_CXX";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const FORMAT_TIMEOUT: Duration = Duration::from_secs(5);
const FORMAT_CAP: usize = 4 * 1024 * 1024;

/// The local toolchain, detected once: `LEITOR_CXX` if set, else `g++`, then `clang++` on the PATH; and
/// `clang-format` on the PATH.
pub fn detect_local() -> &'static LocalToolchain {
    static TOOLCHAIN: OnceLock<LocalToolchain> = OnceLock::new();
    TOOLCHAIN.get_or_init(detect)
}

fn detect() -> LocalToolchain {
    let compiler = match std::env::var_os(CXX_ENV).filter(|v| !v.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(&value);
            let resolved = if path.components().count() > 1 {
                is_executable(&path).then_some(path)
            } else {
                find_on_path(&value.to_string_lossy())
            };
            if resolved.is_none() {
                tracing::warn!(
                    "{CXX_ENV}={} is not an executable compiler",
                    value.to_string_lossy()
                );
            }
            resolved
        }
        None => find_on_path("g++").or_else(|| find_on_path("clang++")),
    };
    LocalToolchain {
        compiler: compiler.map(|path| CompilerInfo {
            name: compiler_name(&path).to_owned(),
            version: version_line(&path),
            path,
        }),
        clang_format: find_on_path("clang-format"),
    }
}

fn compiler_name(path: &Path) -> &'static str {
    let file = path
        .file_name()
        .map(|f| f.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if file.contains("clang") {
        "clang++"
    } else {
        "g++"
    }
}

fn version_line(path: &Path) -> String {
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    supervise(cmd, None, VERSION_TIMEOUT, 64 * 1024)
        .ok()
        .and_then(|out| {
            out.stdout
                .into_string()
                .lines()
                .next()
                .map(|l| l.trim().to_owned())
        })
        .unwrap_or_default()
}

/// Formats C++ with `clang-format --style=LLVM` (stdin, 5 s limit). Returns the formatted code and
/// `Some("clang-format")`, or the code unchanged and `None` when clang-format is absent or fails (the caller then
/// normalizes whitespace itself, spec 11.5 mode `estrutura`).
pub fn format_cpp(code: &str) -> (String, Option<&'static str>) {
    let Some(tool) = detect_local().clang_format.as_ref() else {
        return (code.to_owned(), None);
    };
    let mut cmd = Command::new(tool);
    cmd.args(["--style=LLVM", "--assume-filename=code.cpp"]);
    match supervise(
        cmd,
        Some(code.as_bytes().to_vec()),
        FORMAT_TIMEOUT,
        FORMAT_CAP,
    ) {
        Ok(out) if out.status.success() && !out.timed_out && !out.stdout.truncated => {
            (out.stdout.into_string(), Some("clang-format"))
        }
        _ => (code.to_owned(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(compiler_name(Path::new("/usr/bin/clang++-14")), "clang++");
        assert_eq!(compiler_name(Path::new("/usr/bin/g++")), "g++");
        assert_eq!(
            compiler_name(Path::new("C:/mingw/bin/x86_64-w64-mingw32-g++.exe")),
            "g++"
        );
    }
}
