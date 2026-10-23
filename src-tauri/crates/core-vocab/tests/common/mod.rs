//! Shared helpers of the integration tests: the real data pack, when built.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use core_vocab::{DATA_DIR_ENV, DATA_FILE, Lexicon};

/// The data directory: `LEITOR_VOCAB_DATA_DIR` or `<repo>/data/generated/vocab`.
pub fn data_dir() -> PathBuf {
    std::env::var_os(DATA_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../data/generated/vocab")
        })
}

fn required() -> bool {
    std::env::var("LEITOR_REQUIRE_VOCAB_DATA").is_ok_and(|v| v == "1")
        || std::env::var("CI").is_ok_and(|v| !v.is_empty() && v != "false" && v != "0")
}

/// The real lexicon, loaded once. `None` (test skipped) when the pack is missing, unless it is required
/// (`LEITOR_REQUIRE_VOCAB_DATA=1` or `CI`), then the test fails.
pub fn lexicon() -> Option<Arc<Lexicon>> {
    static LEX: OnceLock<Option<Arc<Lexicon>>> = OnceLock::new();
    LEX.get_or_init(|| {
        let path = data_dir().join(DATA_FILE);
        match Lexicon::open(&path) {
            Ok(l) => Some(Arc::new(l)),
            Err(e) => {
                assert!(
                    !required(),
                    "vocab data required but not loadable at {}: {e} (run scripts/build-wordnet.sh)",
                    path.display()
                );
                eprintln!("skipping: no vocab data at {} ({e}); run scripts/build-wordnet.sh", path.display());
                None
            }
        }
    })
    .clone()
}
