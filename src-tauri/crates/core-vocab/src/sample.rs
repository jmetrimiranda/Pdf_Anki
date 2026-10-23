//! The manual check of spec 12.8: sample random tokens of a real book with their lemma and status into a CSV for
//! review ("lema e status corretos em pelo menos 95%").

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::compare::{Classifier, Status};
use crate::table::{Analysis, scan_book, token_key};
use crate::{KnownIndex, Lexicon, PageInput, Pos, ScanConfig};

/// One sampled token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRow {
    /// 1-based page.
    pub page: u32,
    pub token: String,
    pub sentence: String,
    pub lemma: String,
    pub pos: Option<Pos>,
    pub status: Status,
}

/// splitmix64: a tiny deterministic generator (no dependency, same sample for the same seed).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

/// Samples `n` distinct tokens (deterministic for `seed`), in reading order, classified like a scan with the
/// default options (without an index, only function words count as known).
pub fn sample_tokens(
    pages: &[PageInput],
    lex: &Lexicon,
    known: Option<&KnownIndex>,
    n: usize,
    seed: u64,
) -> Vec<SampleRow> {
    let Ok(book) = scan_book(pages, lex, &AtomicBool::new(false), &mut |_, _| {}) else {
        return Vec::new();
    };
    let all: Vec<(usize, usize)> = book
        .pages
        .iter()
        .enumerate()
        .flat_map(|(pi, p)| (0..p.tokens.len()).map(move |ti| (pi, ti)))
        .collect();
    let mut idx: Vec<usize> = (0..all.len()).collect();
    let mut rng = Rng(seed);
    let take = n.min(idx.len());
    for i in 0..take {
        let j = i + (rng.next() % (idx.len() - i) as u64) as usize;
        idx.swap(i, j);
    }
    let mut chosen: Vec<usize> = idx[..take].to_vec();
    chosen.sort_unstable();

    let empty = KnownIndex::default();
    let overrides = HashMap::new();
    let config = ScanConfig::default();
    let classifier = Classifier {
        known: known.unwrap_or(&empty),
        overrides: &overrides,
        config: &config,
        lex,
    };
    let mut cache: HashMap<String, Analysis> = HashMap::new();
    chosen
        .into_iter()
        .filter_map(|k| {
            let (pi, ti) = all[k];
            let page = &book.pages[pi];
            let t = &page.tokens[ti];
            let sentence = page
                .sentences
                .get(t.sentence)
                .and_then(|s| page.text.get(s.start..s.end))
                .unwrap_or("")
                .trim()
                .replace('\n', " ");
            let (proper, lower) = token_key(t, &book, lex, &mut cache);
            let (lemma, pos, status) = match proper {
                Some(p) => (p, None, Status::Proper),
                None => {
                    let a = cache.get(&lower)?;
                    let alts: Vec<&str> = a.alts.iter().map(String::as_str).collect();
                    let c = classifier.classify(&a.key, &[lower.as_str()], &alts, false);
                    (a.key.clone(), a.pos, c.status)
                }
            };
            Some(SampleRow {
                page: page.unit.saturating_add(1),
                token: t.text.clone(),
                sentence,
                lemma,
                pos,
                status,
            })
        })
        .collect()
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn status_name(s: Status) -> &'static str {
    match s {
        Status::Known => "known",
        Status::Learning => "learning",
        Status::New => "new",
        Status::Suspended => "suspended",
        Status::Unknown => "unknown",
        Status::Ignored => "ignored",
        Status::Proper => "proper",
    }
}

/// The CSV for the manual review: `token,lemma,pos,status,page,sentence,lemma_ok,status_ok` (the last two are left
/// empty for the reviewer to fill with 1/0).
pub fn to_csv(rows: &[SampleRow]) -> String {
    let mut out = String::from("token,lemma,pos,status,page,sentence,lemma_ok,status_ok\n");
    for r in rows {
        let fields = [
            csv_field(&r.token),
            csv_field(&r.lemma),
            r.pos.map(|p| p.letter()).unwrap_or("").to_string(),
            status_name(r.status).to_string(),
            r.page.to_string(),
            csv_field(&r.sentence),
            String::new(),
            String::new(),
        ];
        out.push_str(&fields.join(","));
        out.push('\n');
    }
    out
}
