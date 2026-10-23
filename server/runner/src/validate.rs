//! Request validation shared by the desktop runner (`core-cpp`) and the remote runner (`server/runner`).
//!
//! This file is byte-identical in `src-tauri/crates/core-cpp/src/validate.rs` and
//! `server/runner/src/validate.rs` (checked by `core-cpp`'s `tests/shared_files.rs`): edit both together.
//! Standard library only.

use std::collections::BTreeMap;
use std::fmt;

/// At most this many files per request.
pub const MAX_FILES: usize = 16;
/// File names are 1..=64 characters.
pub const MAX_NAME_LEN: usize = 64;
/// Total size of all sources (UTF-8 bytes).
pub const MAX_SOURCE_BYTES: usize = 512 * 1024;
/// Size of the program's standard input (UTF-8 bytes).
pub const MAX_STDIN_BYTES: usize = 1024 * 1024;
/// The header with the `CHECK` macro, always written by the runner itself.
pub const CHECK_HEADER: &str = "check.hpp";
/// Translation units: passed to the compiler one by one.
pub const SOURCE_EXTENSIONS: [&str; 2] = ["cpp", "cc"];
/// Headers: written next to the sources, never passed to the compiler.
pub const HEADER_EXTENSIONS: [&str; 2] = ["hpp", "h"];

/// Why a request was refused before anything ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    /// More than [`MAX_FILES`] files.
    TooManyFiles(usize),
    /// A name outside `^[A-Za-z0-9_.-]{1,64}$`, starting with `.` or `-`, or without a C++ extension.
    InvalidName(String),
    /// A file named like [`CHECK_HEADER`].
    ReservedName(String),
    /// No `.cpp`/`.cc` file.
    NoSource,
    /// Sources larger than [`MAX_SOURCE_BYTES`] in total.
    SourceTooLarge(usize),
    /// Standard input larger than [`MAX_STDIN_BYTES`].
    StdinTooLarge(usize),
}

impl ValidationError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::TooManyFiles(_) => "too_many_files",
            Self::InvalidName(_) => "invalid_name",
            Self::ReservedName(_) => "reserved_name",
            Self::NoSource => "no_source",
            Self::SourceTooLarge(_) => "source_too_large",
            Self::StdinTooLarge(_) => "stdin_too_large",
        }
    }

    /// Size limits (as opposed to malformed requests).
    pub fn is_too_large(&self) -> bool {
        matches!(self, Self::SourceTooLarge(_) | Self::StdinTooLarge(_))
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyFiles(n) => write!(f, "too many files: {n} (at most {MAX_FILES})"),
            Self::InvalidName(name) => write!(
                f,
                "invalid file name {name:?}: use 1-{MAX_NAME_LEN} of A-Z a-z 0-9 _ . - (not starting with . or -) \
                 ending in .cpp, .cc, .hpp or .h"
            ),
            Self::ReservedName(name) => write!(
                f,
                "{name:?} is reserved (the runner provides {CHECK_HEADER})"
            ),
            Self::NoSource => write!(f, "at least one .cpp file is required"),
            Self::SourceTooLarge(n) => write!(
                f,
                "sources too large: {n} bytes (at most {MAX_SOURCE_BYTES})"
            ),
            Self::StdinTooLarge(n) => {
                write!(f, "stdin too large: {n} bytes (at most {MAX_STDIN_BYTES})")
            }
        }
    }
}

impl std::error::Error for ValidationError {}

/// The extension of a valid name (`"cpp"`, `"cc"`, `"hpp"`, `"h"`), or `None` when the name is not allowed.
pub fn file_kind(name: &str) -> Option<&'static str> {
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return None;
    }
    if name.starts_with('.') || name.starts_with('-') {
        return None;
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
    {
        return None;
    }
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    SOURCE_EXTENSIONS
        .iter()
        .chain(HEADER_EXTENSIONS.iter())
        .find(|known| **known == ext)
        .copied()
}

/// Checks a request and returns the translation units to compile, in name order.
pub fn validate_request<'a>(
    files: &'a BTreeMap<String, String>,
    stdin: &str,
) -> Result<Vec<&'a str>, ValidationError> {
    if files.len() > MAX_FILES {
        return Err(ValidationError::TooManyFiles(files.len()));
    }
    let mut total = 0usize;
    let mut sources = Vec::new();
    for (name, content) in files {
        if name.eq_ignore_ascii_case(CHECK_HEADER) {
            return Err(ValidationError::ReservedName(name.clone()));
        }
        let kind = file_kind(name).ok_or_else(|| ValidationError::InvalidName(name.clone()))?;
        if SOURCE_EXTENSIONS.contains(&kind) {
            sources.push(name.as_str());
        }
        total = total.saturating_add(content.len());
    }
    if total > MAX_SOURCE_BYTES {
        return Err(ValidationError::SourceTooLarge(total));
    }
    if stdin.len() > MAX_STDIN_BYTES {
        return Err(ValidationError::StdinTooLarge(stdin.len()));
    }
    if sources.is_empty() {
        return Err(ValidationError::NoSource);
    }
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(n, c)| ((*n).to_owned(), (*c).to_owned()))
            .collect()
    }

    #[test]
    fn accepts_sources_and_headers() {
        let f = files(&[
            ("main.cpp", "int main(){}"),
            ("util.hpp", ""),
            ("b.cc", ""),
            ("x_y-1.h", ""),
        ]);
        assert_eq!(validate_request(&f, "").unwrap(), vec!["b.cc", "main.cpp"]);
    }

    #[test]
    fn rejects_bad_names() {
        for name in [
            "",
            ".cpp",
            "-o.cpp",
            "a b.cpp",
            "../a.cpp",
            "a/b.cpp",
            "a\\b.cpp",
            "main",
            "main.c",
            "main.CPP",
            "main.py",
            "ção.cpp",
            ".hidden.cpp",
        ] {
            let f = files(&[(name, ""), ("ok.cpp", "")]);
            assert_eq!(
                validate_request(&f, ""),
                Err(ValidationError::InvalidName(name.to_owned())),
                "{name:?}"
            );
        }
        let long = format!("{}.cpp", "a".repeat(61));
        assert_eq!(long.len(), 65);
        assert!(validate_request(&files(&[(&long, "")]), "").is_err());
        let max = format!("{}.cpp", "a".repeat(60));
        assert!(validate_request(&files(&[(&max, "")]), "").is_ok());
    }

    #[test]
    fn check_header_is_reserved() {
        for name in ["check.hpp", "CHECK.HPP", "Check.hpp"] {
            let f = files(&[(name, ""), ("main.cpp", "")]);
            assert_eq!(
                validate_request(&f, ""),
                Err(ValidationError::ReservedName(name.to_owned()))
            );
        }
    }

    #[test]
    fn limits() {
        let many: BTreeMap<String, String> = (0..=MAX_FILES)
            .map(|i| (format!("f{i}.cpp"), String::new()))
            .collect();
        assert_eq!(
            validate_request(&many, ""),
            Err(ValidationError::TooManyFiles(MAX_FILES + 1))
        );
        let big = files(&[("a.cpp", &"x".repeat(MAX_SOURCE_BYTES)), ("b.hpp", "y")]);
        let err = validate_request(&big, "").unwrap_err();
        assert!(err.is_too_large(), "{err}");
        let at_limit = files(&[("a.cpp", &"x".repeat(MAX_SOURCE_BYTES))]);
        assert!(validate_request(&at_limit, &"i".repeat(MAX_STDIN_BYTES)).is_ok());
        let err = validate_request(&at_limit, &"i".repeat(MAX_STDIN_BYTES + 1)).unwrap_err();
        assert_eq!(err, ValidationError::StdinTooLarge(MAX_STDIN_BYTES + 1));
        assert_eq!(err.code(), "stdin_too_large");
    }

    #[test]
    fn needs_a_source() {
        assert_eq!(
            validate_request(&files(&[("a.hpp", "")]), ""),
            Err(ValidationError::NoSource)
        );
        assert_eq!(
            validate_request(&BTreeMap::new(), ""),
            Err(ValidationError::NoSource)
        );
    }
}
