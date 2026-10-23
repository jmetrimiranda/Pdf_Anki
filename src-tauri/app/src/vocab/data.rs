//! The vocabulary data pack (spec 12.2): Open English WordNet, the Zipf list and the stopwords, built by
//! `scripts/build-wordnet.sh` into `data/generated/vocab/` and bundled as the Tauri resource `vocab/`.
//!
//! Resolution order: `LEITOR_VOCAB_DATA_DIR` → `<resource_dir>/vocab` → (debug builds) `data/generated/vocab` of the
//! source tree. The first folder with `vocab-en.sqlite` wins. The lexicon is opened lazily (first scan, marks or
//! "Definir palavra"), never on the startup path, and kept for the app run.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use core_vocab::{DATA_DIR_ENV, DATA_FILE, Lexicon, VocabError};
use serde::Serialize;

use crate::error::AppError;

/// Name of the bundled resource folder (`tauri.conf.json` → `bundle.resources`).
pub const RESOURCE_NAME: &str = "vocab";

/// One bundled data set, for the credits of "Sobre".
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabDataSource {
    pub name: String,
    /// The pinned release ("2025", "3.1.1").
    pub version: String,
    /// SPDX id ("CC-BY-4.0").
    pub license: String,
    pub url: Option<String>,
}

/// `vocab_data_info`: what "Sobre" shows about the bundled data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabDataInfo {
    pub available: bool,
    pub wordnet: Option<VocabDataSource>,
    pub frequency: Option<VocabDataSource>,
    pub stopwords: Option<VocabDataSource>,
    pub schema_version: Option<u32>,
}

/// The lazily opened lexicon of the app run.
#[derive(Default)]
pub struct VocabData {
    resource_dir: OnceLock<PathBuf>,
    lexicon: OnceLock<Result<Arc<Lexicon>, AppError>>,
}

impl VocabData {
    /// The app's resource dir (set once in `build`, before any command runs).
    pub fn set_resource_dir(&self, dir: PathBuf) {
        let _ = self.resource_dir.set(dir);
    }

    /// Uses `lexicon` instead of the data pack (tests without the pack). No effect once a lexicon was loaded.
    pub fn set_lexicon(&self, lexicon: Arc<Lexicon>) {
        let _ = self.lexicon.set(Ok(lexicon));
    }

    /// The candidate folders, in resolution order.
    pub fn candidates(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        if let Some(dir) = std::env::var_os(DATA_DIR_ENV) {
            out.push(PathBuf::from(dir));
        }
        if let Some(dir) = self.resource_dir.get() {
            out.push(dir.join(RESOURCE_NAME));
        }
        if cfg!(debug_assertions) {
            out.push(source_tree_dir());
        }
        out
    }

    /// The lexicon, opening it on first use. Blocks (call it off the async runtime).
    pub fn lexicon(&self) -> Result<Arc<Lexicon>, AppError> {
        self.lexicon
            .get_or_init(|| {
                let started = std::time::Instant::now();
                let result = open_first(&self.candidates());
                match &result {
                    Ok(_) => tracing::info!(
                        ms = started.elapsed().as_millis() as u64,
                        "vocabulary data loaded"
                    ),
                    Err(e) => tracing::warn!(code = %e.code, "vocabulary data unavailable: {e}"),
                }
                result
            })
            .clone()
    }

    /// The lexicon if it is (or can be) loaded, `None` otherwise (callers with a fallback).
    pub fn lexicon_opt(&self) -> Option<Arc<Lexicon>> {
        self.lexicon().ok()
    }

    pub fn info(&self) -> VocabDataInfo {
        match self.lexicon() {
            Ok(lex) => {
                let info = lex.info();
                let label = |s: &core_vocab::SourceInfo| {
                    (!s.name.is_empty()).then(|| VocabDataSource {
                        name: s.name.clone(),
                        version: s.release.clone(),
                        license: s.license.clone(),
                        url: (!s.url.is_empty()).then(|| s.url.clone()),
                    })
                };
                VocabDataInfo {
                    available: true,
                    wordnet: label(&info.wordnet),
                    frequency: label(&info.frequency),
                    stopwords: label(&info.stopwords),
                    schema_version: Some(info.schema_version),
                }
            }
            Err(_) => VocabDataInfo {
                available: false,
                wordnet: None,
                frequency: None,
                stopwords: None,
                schema_version: None,
            },
        }
    }
}

/// `data/generated/vocab` of the source tree (debug builds, tests).
pub fn source_tree_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("data")
        .join("generated")
        .join("vocab")
}

fn open_first(candidates: &[PathBuf]) -> Result<Arc<Lexicon>, AppError> {
    for dir in candidates {
        let file = dir.join(DATA_FILE);
        if file.is_file() {
            return Lexicon::open(&file)
                .map(Arc::new)
                .map_err(|e| data_error(&e));
        }
    }
    Err(missing())
}

/// `vocab_data_missing`: the pack is not installed.
pub fn missing() -> AppError {
    let message = if cfg!(debug_assertions) {
        "Os dados de vocabulário não foram encontrados. Rode scripts/build-wordnet.sh."
    } else {
        "Os dados de vocabulário não foram encontrados. Reinstale o app."
    };
    AppError::new("vocab_data_missing", message)
}

fn data_error(e: &VocabError) -> AppError {
    match e {
        VocabError::Unavailable => missing(),
        other => {
            tracing::warn!(error = %other, "vocabulary data unreadable");
            AppError::new("vocab_data_invalid", other.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_pack_is_a_typed_error() {
        let dir = tempfile::tempdir().unwrap();
        let e = open_first(&[dir.path().to_path_buf()]).err().unwrap();
        assert_eq!(e.code, "vocab_data_missing");
        assert!(e.message.contains("build-wordnet.sh"));
        let data = VocabData::default();
        data.set_lexicon(Arc::new(Lexicon::from_parts(
            core_vocab::TestLexicon::sample(),
        )));
        assert!(data.lexicon().is_ok());
    }
}
