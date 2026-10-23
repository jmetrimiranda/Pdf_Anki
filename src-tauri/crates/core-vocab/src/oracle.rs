//! Reading-time marks (spec 12.7): which words of a page to underline, with the same tokens, lemmas and
//! comparison as the scan.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::compare::{Classifier, OverrideStatus, RowGroup, Status};
use crate::table::{analyze, looks_proper};
use crate::text::token_text;
use crate::{KnownIndex, Lexicon, ScanConfig};

/// Underline color class: unknown = coral, learning (or new in the deck) = amber.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkStatus {
    Unknown,
    Learning,
}

/// A word to underline and its lemma (the key of the book table).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkKind {
    pub lemma: String,
    pub status: MarkStatus,
}

/// Classifies the words of a page for the marks. Owns its inputs so the app can keep one per open book.
pub struct StatusOracle {
    known: KnownIndex,
    overrides: HashMap<String, OverrideStatus>,
    config: ScanConfig,
    lex: Arc<Lexicon>,
    proper: Option<HashSet<String>>,
}

impl StatusOracle {
    pub fn new(
        known: KnownIndex,
        overrides: HashMap<String, OverrideStatus>,
        config: ScanConfig,
        lex: Arc<Lexicon>,
    ) -> StatusOracle {
        StatusOracle {
            known,
            overrides,
            config,
            lex,
            proper: None,
        }
    }

    /// Uses the proper nouns of the book table (keys with `isProper`, any case) instead of the per-word heuristic.
    pub fn with_proper_nouns<I: IntoIterator<Item = String>>(mut self, names: I) -> StatusOracle {
        self.proper = Some(names.into_iter().map(|n| n.to_lowercase()).collect());
        self
    }

    /// Replaces the overrides ("Já sei", "Nome próprio"… during reading).
    pub fn set_override(&mut self, lemma: &str, status: Option<OverrideStatus>) {
        match status {
            Some(s) => {
                self.overrides.insert(lemma.to_string(), s);
            }
            None => {
                self.overrides.remove(lemma);
            }
        }
    }

    /// One entry per input word (`(text, sentence_start)`, e.g. `core-pdf` page words): `None` when it is not
    /// underlined (known, function word, proper noun, ignored, a form of a known word, a derivative counted as known,
    /// not a word), otherwise its lemma and color.
    pub fn classify_words(&self, words: &[(&str, bool)]) -> Vec<Option<MarkKind>> {
        let classifier = Classifier {
            known: &self.known,
            overrides: &self.overrides,
            config: &self.config,
            lex: &self.lex,
        };
        let mut cache: HashMap<String, Option<MarkKind>> = HashMap::new();
        words
            .iter()
            .map(|(word, initial)| {
                let (text, _) =
                    token_text(&word.replace(['\u{2019}', '\u{2018}', '\u{02BC}'], "'"))?;
                let lower = text.to_lowercase();
                let proper = match &self.proper {
                    Some(set) => text != lower && set.contains(&lower),
                    None => looks_proper(&text, *initial, &self.lex),
                };
                if proper {
                    return None;
                }
                if let Some(hit) = cache.get(&lower) {
                    return hit.clone();
                }
                let a = analyze(&lower, &self.lex);
                let alts: Vec<&str> = a.alts.iter().map(String::as_str).collect();
                let c = classifier.classify(&a.key, &[lower.as_str()], &alts, false);
                let status = match (c.group, c.status) {
                    (RowGroup::Main, Status::Unknown | Status::Suspended) => {
                        Some(MarkStatus::Unknown)
                    }
                    (RowGroup::Main, Status::Learning | Status::New) => Some(MarkStatus::Learning),
                    _ => None,
                };
                let out = status.map(|status| MarkKind {
                    lemma: a.key.clone(),
                    status,
                });
                cache.insert(lower, out.clone());
                out
            })
            .collect()
    }
}
