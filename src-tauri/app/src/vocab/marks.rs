//! "Realçar vocabulário" (spec 12.7): the underline rects of the unknown (coral) and learning-or-new (amber) words
//! of a page, for `pdfcraft:marks`. The words and rects are `core-pdf`'s `page_words` of the current version (the
//! same document cache as `doc_words`), classified by `core_vocab::StatusOracle` with the latest scan's folder and
//! criterion, the overrides and the book's proper nouns. Marks are in page-word order: that order is the mark
//! index of `pdfcraft:marks`/`pdfcraft:mark-click`.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use core_pdf::{PageWords, Rect};
use core_vocab::{MarkStatus, StatusOracle};
use serde::Serialize;
use unicode_segmentation::UnicodeSegmentation;

use crate::error::AppError;
use crate::state::{AppState, lock};

use super::scan::StoredScanConfig;
use super::{MAX_MARK_PAGES, not_scanned};

/// Oracles kept (one per recently read book).
const ORACLE_CACHE: usize = 4;

/// One underlined word.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabMark {
    pub lemma: String,
    /// The word as on the page.
    pub form: String,
    pub status: MarkStatus,
    /// Page view space, like `PageWord.rects`.
    pub rects: Vec<Rect>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabPageMarks {
    pub page: u32,
    pub marks: Vec<VocabMark>,
}

/// An oracle and what it was built from.
pub(crate) struct CachedOracle {
    book_uid: String,
    scan_uid: String,
    col_mod: i64,
    overrides_generation: u64,
    oracle: Arc<StatusOracle>,
}

/// Whether each word starts a sentence (UAX #29 sentences of the page text, lines joined).
pub fn sentence_starts(pw: &PageWords) -> Vec<bool> {
    let text = pw.text.replace('\n', " ");
    let mut starts: Vec<usize> = Vec::new();
    let mut utf16 = 0usize;
    let mut last = 0usize;
    for (byte, _) in text.split_sentence_bound_indices() {
        utf16 += text.get(last..byte).map_or(0, |s| s.encode_utf16().count());
        starts.push(utf16);
        last = byte;
    }
    let mut next = 0usize;
    let mut pending = false;
    pw.words
        .iter()
        .map(|w| {
            while next < starts.len() && starts[next] <= w.start {
                pending = true;
                next += 1;
            }
            let initial = pending;
            if w.text.chars().any(char::is_alphabetic) {
                pending = false;
            }
            initial
        })
        .collect()
}

/// The marks of a page, in page-word order. Words inside `noise` (UTF-16 ranges of `pw.text` that the scan's
/// cleanup drops: repeated headers/footers, page numbers, URLs — see [`core_vocab::noise_spans`]) get no mark,
/// like the report doesn't count them; the first word kept starts a sentence, as on the cleaned page.
pub fn page_marks(
    oracle: &StatusOracle,
    pw: &PageWords,
    noise: &[(usize, usize)],
) -> Vec<VocabMark> {
    let starts = sentence_starts(pw);
    let in_noise = |start: usize| noise.iter().any(|&(a, b)| start >= a && start < b);
    let mut first = true;
    let kept: Vec<(&core_pdf::PageWord, bool)> = pw
        .words
        .iter()
        .zip(&starts)
        .filter(|(w, _)| !in_noise(w.start))
        .map(|(w, s)| {
            let initial = *s || first;
            if w.text.chars().any(char::is_alphabetic) {
                first = false;
            }
            (w, initial)
        })
        .collect();
    let words: Vec<(&str, bool)> = kept.iter().map(|(w, s)| (w.text.as_str(), *s)).collect();
    oracle
        .classify_words(&words)
        .into_iter()
        .zip(&kept)
        .filter_map(|(kind, (w, _))| {
            kind.map(|k| VocabMark {
                lemma: k.lemma,
                form: w.text.clone(),
                status: k.status,
                rects: w.rects.clone(),
            })
        })
        .collect()
}

impl AppState {
    /// The marks oracle of the book's latest scan, rebuilt when the collection or the overrides changed.
    pub(crate) fn vocab_oracle(&self, uid: &str) -> Result<Arc<StatusOracle>, AppError> {
        let scan = self
            .with_store(|s| s.latest_vocab_scan(uid, true))?
            .ok_or_else(not_scanned)?;
        let generation = self.vocab.overrides_generation.load(Ordering::Relaxed);
        let col_mod: i64 = self.anki_handles()?.svc.call_blocking(|col| {
            Ok(col
                .storage
                .db()
                .query_row("SELECT mod FROM col", [], |r| r.get(0))
                .unwrap_or(0))
        })?;
        if let Some(hit) = lock(&self.vocab.oracles).iter().find(|o| {
            o.book_uid == uid
                && o.scan_uid == scan.uid
                && o.col_mod == col_mod
                && o.overrides_generation == generation
        }) {
            return Ok(Arc::clone(&hit.oracle));
        }
        let lex = self.vocab_lexicon()?;
        let stored: StoredScanConfig =
            serde_json::from_value(scan.config.clone()).map_err(AppError::internal)?;
        let (known, _) = self.vocab_known_index(
            scan.root_deck_id,
            &stored.excluded_deck_ids,
            &stored.config,
            &lex,
        )?;
        let overrides = self.vocab_overrides_map()?;
        let proper: Vec<String> = self
            .with_store(|s| s.vocab_table_lemmas(uid))?
            .into_iter()
            .filter(|l| l.is_proper)
            .map(|l| l.lemma)
            .collect();
        let oracle = StatusOracle::new((*known).clone(), overrides, stored.config, lex);
        let oracle = Arc::new(if proper.is_empty() {
            oracle
        } else {
            oracle.with_proper_nouns(proper)
        });
        let mut cache = lock(&self.vocab.oracles);
        cache.retain(|o| o.book_uid != uid);
        cache.push(CachedOracle {
            book_uid: uid.to_owned(),
            scan_uid: scan.uid,
            col_mod,
            overrides_generation: generation,
            oracle: Arc::clone(&oracle),
        });
        while cache.len() > ORACLE_CACHE {
            cache.remove(0);
        }
        Ok(oracle)
    }

    /// `vocab_marks`: the marks of up to [`MAX_MARK_PAGES`] pages (0-based) of the current version.
    pub fn vocab_marks(&self, uid: &str, pages: &[u32]) -> Result<Vec<VocabPageMarks>, AppError> {
        if pages.len() > MAX_MARK_PAGES {
            return Err(AppError::new(
                "invalid_input",
                format!("Peça no máximo {MAX_MARK_PAGES} páginas de cada vez."),
            ));
        }
        let book = self.vocab_book(uid)?;
        let oracle = self.vocab_oracle(uid)?;
        // The header/footer lines the scan's cleanup removed (stored with the lemma table).
        let repeated: HashSet<String> = self
            .with_store(|s| s.vocab_table_state(uid))?
            .map(|st| st.repeated_lines.into_iter().collect())
            .unwrap_or_default();
        let doc = self.book_doc(&book)?;
        let mut out = Vec::with_capacity(pages.len());
        for &page in pages {
            let pw = self
                .pdf()
                .page_words(doc, usize::try_from(page).unwrap_or(usize::MAX))?;
            let noise = core_vocab::noise_spans(&pw.text, &repeated);
            out.push(VocabPageMarks {
                page,
                marks: page_marks(&oracle, &pw, &noise),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_pdf::PageWord;

    fn words(text: &str) -> PageWords {
        let mut out = Vec::new();
        let mut utf16 = 0usize;
        let mut last = 0usize;
        for (i, (byte, w)) in text.unicode_word_indices().enumerate() {
            utf16 += text[last..byte].encode_utf16().count();
            let len = w.encode_utf16().count();
            out.push(PageWord {
                index: i,
                text: w.to_string(),
                start: utf16,
                end: utf16 + len,
                rects: vec![[i as f32, 0.0, 1.0, 1.0]],
            });
            utf16 += len;
            last = byte + w.len();
        }
        PageWords {
            page: 0,
            width: 100.0,
            height: 100.0,
            text: text.to_string(),
            words: out,
        }
    }

    #[test]
    fn sentence_starts_follow_the_text() {
        let pw = words("The pigs met. \u{201c}Napoleon\u{201d} spoke\nto Boxer. Three sheep ran.");
        let s = sentence_starts(&pw);
        let flags: Vec<(&str, bool)> = pw
            .words
            .iter()
            .zip(&s)
            .map(|(w, b)| (w.text.as_str(), *b))
            .collect();
        assert_eq!(
            flags,
            vec![
                ("The", true),
                ("pigs", false),
                ("met", false),
                ("Napoleon", true),
                ("spoke", false),
                ("to", false),
                ("Boxer", false),
                ("Three", true),
                ("sheep", false),
                ("ran", false),
            ]
        );
    }

    #[test]
    fn marks_keep_page_order_and_rects() {
        let lex = Arc::new(core_vocab::Lexicon::from_parts(
            core_vocab::TestLexicon::sample(),
        ));
        let oracle = StatusOracle::new(
            core_vocab::KnownIndex::default(),
            Default::default(),
            core_vocab::ScanConfig::default(),
            lex,
        );
        let pw = words("The windmill and the windmills.");
        let marks = page_marks(&oracle, &pw, &[]);
        assert_eq!(marks.len(), 2, "{marks:?}");
        assert_eq!(marks[0].form, "windmill");
        assert_eq!(marks[1].form, "windmills");
        assert_eq!(marks[1].lemma, "windmill");
        assert_eq!(marks[1].rects, pw.words[4].rects);
        assert_eq!(marks[0].status, MarkStatus::Unknown);
    }

    #[test]
    fn repeated_headers_and_page_numbers_get_no_marks() {
        let lex = Arc::new(core_vocab::Lexicon::from_parts(
            core_vocab::TestLexicon::sample(),
        ));
        let oracle = StatusOracle::new(
            core_vocab::KnownIndex::default(),
            Default::default(),
            core_vocab::ScanConfig::default(),
            lex,
        );
        let header = "The Windmill Chronicle";
        // Only the header (and the "Page N" line) repeats: the bodies differ.
        let bodies = [
            "The pigs met.",
            "The windmills turned.",
            "Boxer worked.",
            "Snowball ran.",
            "Night fell.",
            "Rain came.",
        ];
        let texts: Vec<String> = (1..=6)
            .map(|n| format!("{header}\n{}\nPage {n}", bodies[n - 1]))
            .collect();
        let inputs: Vec<core_vocab::PageInput> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| core_vocab::PageInput {
                unit: i as u32,
                text: t,
            })
            .collect();
        let repeated: HashSet<String> = core_vocab::repeated_lines(&inputs).into_iter().collect();
        let pw = words(&texts[1]);
        let body = |m: &VocabMark| {
            pw.words[3..6]
                .iter()
                .any(|w| w.text == m.form && w.rects == m.rects)
        };
        // Without the cleanup the header's words are underlined too.
        assert!(page_marks(&oracle, &pw, &[]).iter().any(|m| !body(m)));
        let noise = core_vocab::noise_spans(&pw.text, &repeated);
        let marks = page_marks(&oracle, &pw, &noise);
        assert!(marks.iter().all(body), "{marks:?}");
        assert_eq!(marks[0].form, "windmills");
        assert_eq!(marks[0].rects, pw.words[4].rects);
    }
}
