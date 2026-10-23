//! The per-page lemma table of a book (spec 12.3 E, F, H). It depends only on the book text and the lexicon, never
//! on the user (no index), so it is computed once per version of the text and reused for every range and rescan.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::lemmatize::lemmatize;
use crate::text::{Sentence, Token, clean_pages, is_capitalized, tokenize, utf16_len};
use crate::{Lexicon, PageInput, Pos, VocabError};

/// A form of a lemma in the book (lowercase) with its count and the other lemmas it could belong to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormCount {
    pub form: String,
    pub count: u32,
    #[serde(default)]
    pub alts: Vec<String>,
}

/// A lemma of the book (all pages). Lemmas with a space are phrasal verbs ("look up", spec 12.3 H); proper nouns
/// keep their capital ("Napoleon").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookLemma {
    pub lemma: String,
    pub pos: Option<Pos>,
    pub occurrences: u32,
    /// First unit (0-based page) where it occurs.
    pub first_unit: u32,
    /// Example sentence of the first page (see [`BookLemmaPage::example`]).
    pub example: String,
    /// UTF-16 [start, end) of the form inside `example`.
    pub example_span: Option<[u32; 2]>,
    /// Units where it occurs, sorted.
    pub units: Vec<u32>,
    pub is_proper: bool,
    pub zipf: Option<f32>,
    pub forms: Vec<FormCount>,
}

/// A lemma on one page (`book_lemma_page`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookLemmaPage {
    pub lemma: String,
    pub unit: u32,
    pub occurrences: u32,
    /// The most common original spelling on the page.
    pub form: String,
    /// Original spellings with their counts on the page.
    pub forms: Vec<(String, u32)>,
    /// First sentence of the page with 8–30 words containing it (original spelling), else a 30-word window.
    pub example: Option<String>,
    /// UTF-16 [start, end) of the occurrence inside `example`.
    pub example_span: Option<[u32; 2]>,
    /// Index of the first occurrence among the page's words (reading order inside the page).
    #[serde(default)]
    pub position: u32,
}

/// The table of a book.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTable {
    pub page_count: u32,
    pub lemmas: Vec<BookLemma>,
    pub pages: Vec<BookLemmaPage>,
    /// The repeated header/footer lines the cleanup removed ([`crate::repeated_lines`]): the highlight skips them.
    #[serde(default)]
    pub repeated_lines: Vec<String>,
}

/// A lowercase share below this makes a capitalized word a proper noun (spec 12.3 E).
const PROPER_LOWER_SHARE: f64 = 0.10;
/// A lowercase WordNet lemma at least this frequent is a common word, not a name.
const PROPER_COMMON_ZIPF: f32 = 3.5;
const EXAMPLE_MIN_WORDS: usize = 8;
const EXAMPLE_MAX_WORDS: usize = 30;
const WINDOW_WORDS: usize = 30;

/// The user-independent analysis of a lowercase form: the table key, its POS and the alternative lemmas.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Analysis {
    pub key: String,
    pub pos: Option<Pos>,
    pub alts: Vec<String>,
}

/// Analyses a lowercase form for the table. An inflected verb/adjective form that is itself a WordNet noun or
/// adjective lemma (learning, meaning, building, interesting) stays its own key with the base among the alts, so
/// the comparison can put it in "Formas de palavras que você sabe" (spec 12.3 I).
pub(crate) fn analyze(lower: &str, lex: &Lexicon) -> Analysis {
    let lem = lemmatize(lower, lex, None);
    let own_lemma = lex.is_lemma(lower, Some(Pos::Noun)) || lex.is_lemma(lower, Some(Pos::Adj));
    if lem.lemma != lower && own_lemma && matches!(lem.pos, Some(Pos::Verb) | Some(Pos::Adj)) {
        let mut alts: Vec<String> = std::iter::once(lem.lemma.clone())
            .chain(lem.alts)
            .filter(|a| a != lower)
            .collect();
        alts.sort();
        alts.dedup();
        let pos = if lex.is_lemma(lower, Some(Pos::Noun)) {
            Pos::Noun
        } else {
            Pos::Adj
        };
        return Analysis {
            key: lower.to_string(),
            pos: Some(pos),
            alts,
        };
    }
    Analysis {
        key: lem.lemma,
        pos: lem.pos,
        alts: lem.alts,
    }
}

/// Whether a table key is an inflected form kept apart by [`analyze`].
pub(crate) fn is_split_form(key: &str, lex: &Lexicon) -> bool {
    !key.contains(' ') && analyze(key, lex).key == key && lemmatize(key, lex, None).lemma != key
}

/// Tokenized book, shared by the table and the sampler.
pub(crate) struct ScannedBook {
    pub pages: Vec<ScannedPage>,
    /// Lowercase forms that are proper nouns in this book.
    pub proper: HashSet<String>,
}

pub(crate) struct ScannedPage {
    pub unit: u32,
    pub text: String,
    pub sentences: Vec<Sentence>,
    pub tokens: Vec<Token>,
}

#[derive(Default)]
struct CaseStats {
    total: u32,
    lower: u32,
    cap_non_initial: u32,
}

/// Whether a lowercase form is a proper noun given its case statistics in the book (spec 12.3 E): capitalized
/// at least once outside the start of a sentence, lowercase in fewer than 10% of its occurrences, not a function
/// word, and not a common lowercase WordNet lemma (lowercase lemma with Zipf ≥ 3.5) unless WordNet also has it
/// capitalized ("Boxer", "Napoleon").
fn is_proper(lower: &str, s: &CaseStats, lex: &Lexicon) -> bool {
    if s.cap_non_initial == 0 || lower.chars().count() < 2 || lex.is_function_word(lower) {
        return false;
    }
    if f64::from(s.lower) >= PROPER_LOWER_SHARE * f64::from(s.total) {
        return false;
    }
    let common =
        lex.has_lowercase_lemma(lower) && lex.zipf(lower).unwrap_or(0.0) >= PROPER_COMMON_ZIPF;
    !common || lex.has_capitalized_lemma(lower)
}

/// The proper-noun test for one word without book statistics (reading marks without a table): capitalized, not
/// sentence-initial, and not a common lowercase lemma unless WordNet has it capitalized.
pub(crate) fn looks_proper(word: &str, initial: bool, lex: &Lexicon) -> bool {
    if initial || !is_capitalized(word) {
        return false;
    }
    let lower = word.to_lowercase();
    is_proper(
        &lower,
        &CaseStats {
            total: 1,
            lower: 0,
            cap_non_initial: 1,
        },
        lex,
    )
}

pub(crate) fn scan_book(
    pages: &[PageInput],
    lex: &Lexicon,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<ScannedBook, VocabError> {
    let total = pages.len() as u32;
    let clean = clean_pages(pages);
    let mut out = Vec::with_capacity(clean.len());
    let mut stats: HashMap<String, CaseStats> = HashMap::new();
    for (i, page) in clean.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(VocabError::Cancelled);
        }
        let (sentences, tokens) = tokenize(&page.text);
        for t in &tokens {
            let lower = t.text.to_lowercase();
            let s = stats.entry(lower.clone()).or_default();
            s.total += 1;
            if t.text == lower {
                s.lower += 1;
            } else if !t.initial && is_capitalized(&t.text) {
                s.cap_non_initial += 1;
            }
        }
        out.push(ScannedPage {
            unit: page.unit,
            text: page.text,
            sentences,
            tokens,
        });
        // Text is about half the work; the table the other half.
        progress((i as u32 + 1).div_ceil(2), total);
    }
    let proper = stats
        .iter()
        .filter(|(l, s)| is_proper(l, s, lex))
        .map(|(l, _)| l.clone())
        .collect();
    Ok(ScannedBook { pages: out, proper })
}

/// The key of one token: a proper noun (capitalized spelling), or the analysis of its lowercase form.
pub(crate) fn token_key(
    token: &Token,
    book: &ScannedBook,
    lex: &Lexicon,
    cache: &mut HashMap<String, Analysis>,
) -> (Option<String>, String) {
    let lower = token.text.to_lowercase();
    if token.text != lower && book.proper.contains(&lower) {
        // Keep mixed-case spellings ("McDonald"); all-caps headings fold to "Napoleon".
        let key = if is_capitalized(&token.text) {
            token.text.clone()
        } else {
            title_case(&lower)
        };
        return (Some(key), lower);
    }
    if !cache.contains_key(&lower) {
        let a = analyze(&lower, lex);
        cache.insert(lower.clone(), a);
    }
    (None, lower)
}

fn title_case(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

struct PageAgg {
    occurrences: u32,
    forms: Vec<(String, u32)>,
    example: Option<(String, [u32; 2])>,
    first_token: usize,
    first_token_end: usize,
}

struct KeyInfo {
    pos: Option<Pos>,
    is_proper: bool,
    forms: Vec<FormCount>,
}

/// Example from a sentence: the trimmed sentence text with line breaks as spaces, and the UTF-16 span of
/// `[start, end)` (byte offsets in the page) inside it.
fn sentence_example(
    text: &str,
    s: &Sentence,
    start: usize,
    end: usize,
) -> Option<(String, [u32; 2])> {
    let raw = text.get(s.start..s.end)?;
    let lead = raw.len() - raw.trim_start().len();
    let sent_start = s.start + lead;
    let body = raw.trim();
    let before = text.get(sent_start..start)?;
    let inside = text.get(start..end)?;
    let a = utf16_len(before);
    Some((body.replace('\n', " "), [a, a + utf16_len(inside)]))
}

fn window_example(page: &ScannedPage, first: usize, last_end: usize) -> Option<(String, [u32; 2])> {
    let toks = &page.tokens;
    let half = WINDOW_WORDS / 2;
    let from = first.saturating_sub(half);
    let to = (first + half).min(toks.len().saturating_sub(1));
    let start = toks.get(from)?.start;
    let end = toks.get(to)?.end.max(last_end);
    let slice = page.text.get(start..end)?;
    let a = utf16_len(page.text.get(start..toks.get(first)?.start)?);
    let b = a + utf16_len(page.text.get(toks.get(first)?.start..last_end)?);
    Some((slice.replace('\n', " "), [a, b]))
}

/// Builds the table of a book (spec 12.3 F). `progress(done, total)` is called as pages are processed; setting
/// `cancel` stops it with [`VocabError::Cancelled`]. Target: 100k words in ≤ 2 s (release, one core).
pub fn build_book_table(
    pages: &[PageInput],
    lex: &Lexicon,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<BookTable, VocabError> {
    let total = pages.len() as u32;
    let book = scan_book(pages, lex, cancel, progress)?;
    let page_count = pages
        .iter()
        .map(|p| p.unit.saturating_add(1))
        .max()
        .unwrap_or(0);
    let mut cache: HashMap<String, Analysis> = HashMap::new();
    let mut infos: HashMap<String, KeyInfo> = HashMap::new();
    let mut rows: Vec<BookLemmaPage> = Vec::new();

    for (pi, page) in book.pages.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(VocabError::Cancelled);
        }
        let mut aggs: HashMap<String, PageAgg> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let add = |key: String,
                   spelled: &str,
                   ti: usize,
                   start: usize,
                   end: usize,
                   sentence: usize,
                   aggs: &mut HashMap<String, PageAgg>,
                   order: &mut Vec<String>| {
            let agg = aggs.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                PageAgg {
                    occurrences: 0,
                    forms: Vec::new(),
                    example: None,
                    first_token: ti,
                    first_token_end: end,
                }
            });
            agg.occurrences += 1;
            match agg.forms.iter_mut().find(|(f, _)| f == spelled) {
                Some((_, n)) => *n += 1,
                None => agg.forms.push((spelled.to_string(), 1)),
            }
            if agg.example.is_none()
                && let Some(s) = page.sentences.get(sentence)
                && (EXAMPLE_MIN_WORDS..=EXAMPLE_MAX_WORDS).contains(&s.words)
            {
                agg.example = sentence_example(&page.text, s, start, end);
            }
        };
        for (ti, t) in page.tokens.iter().enumerate() {
            let (proper_key, lower) = token_key(t, &book, lex, &mut cache);
            let (key, pos, alts, is_proper) = match proper_key {
                Some(k) => (k, None, Vec::new(), true),
                None => {
                    let a = &cache[&lower];
                    (a.key.clone(), a.pos, a.alts.clone(), false)
                }
            };
            let info = infos.entry(key.clone()).or_insert_with(|| KeyInfo {
                pos,
                is_proper,
                forms: Vec::new(),
            });
            match info.forms.iter_mut().find(|f| f.form == lower) {
                Some(f) => f.count += 1,
                None => info.forms.push(FormCount {
                    form: lower.clone(),
                    count: 1,
                    alts,
                }),
            }
            add(
                key.clone(),
                &t.text,
                ti,
                t.start,
                t.end,
                t.sentence,
                &mut aggs,
                &mut order,
            );

            // Phrasal verbs (H): verb + adjacent particle in the same sentence.
            if !is_proper
                && let Some(next) = page.tokens.get(ti + 1)
                && next.sentence == t.sentence
                && page
                    .text
                    .get(t.end..next.start)
                    .is_some_and(|g| g.chars().all(char::is_whitespace) && !g.contains('\n'))
            {
                let particle = next.text.to_lowercase();
                let a = &cache[&lower];
                let verb = std::iter::once(&a.key)
                    .chain(a.alts.iter())
                    .find(|v| lex.is_phrasal(v, &particle))
                    .cloned();
                if let Some(v) = verb {
                    let pkey = format!("{v} {particle}");
                    let spelled = format!("{} {}", t.text, next.text);
                    infos.entry(pkey.clone()).or_insert_with(|| KeyInfo {
                        pos: Some(Pos::Verb),
                        is_proper: false,
                        forms: Vec::new(),
                    });
                    if let Some(info) = infos.get_mut(&pkey) {
                        let lf = spelled.to_lowercase();
                        match info.forms.iter_mut().find(|f| f.form == lf) {
                            Some(f) => f.count += 1,
                            None => info.forms.push(FormCount {
                                form: lf,
                                count: 1,
                                alts: Vec::new(),
                            }),
                        }
                    }
                    add(
                        pkey, &spelled, ti, t.start, next.end, t.sentence, &mut aggs, &mut order,
                    );
                }
            }
        }
        for key in order {
            let Some(mut agg) = aggs.remove(&key) else {
                continue;
            };
            let example = agg
                .example
                .take()
                .or_else(|| window_example(page, agg.first_token, agg.first_token_end));
            agg.forms
                .sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let form = agg.forms.first().map(|f| f.0.clone()).unwrap_or_default();
            rows.push(BookLemmaPage {
                lemma: key,
                unit: page.unit,
                occurrences: agg.occurrences,
                form,
                forms: agg.forms,
                example_span: example.as_ref().map(|e| e.1),
                example: example.map(|e| e.0),
                position: agg.first_token as u32,
            });
        }
        progress((total + pi as u32 + 1).div_ceil(2), total);
    }

    // Book-wide rows.
    let mut by_key: HashMap<&str, BookLemma> = HashMap::new();
    for r in &rows {
        let e = by_key.entry(r.lemma.as_str()).or_insert_with(|| BookLemma {
            lemma: r.lemma.clone(),
            pos: None,
            occurrences: 0,
            first_unit: r.unit,
            example: r.example.clone().unwrap_or_default(),
            example_span: r.example_span,
            units: Vec::new(),
            is_proper: false,
            zipf: None,
            forms: Vec::new(),
        });
        e.occurrences += r.occurrences;
        if r.unit < e.first_unit {
            e.first_unit = r.unit;
            e.example = r.example.clone().unwrap_or_default();
            e.example_span = r.example_span;
        }
        e.units.push(r.unit);
    }
    let mut lemmas: Vec<BookLemma> = by_key
        .into_values()
        .map(|mut l| {
            l.units.sort_unstable();
            l.units.dedup();
            if let Some(info) = infos.remove(&l.lemma) {
                l.pos = info.pos;
                l.is_proper = info.is_proper;
                let mut forms = info.forms;
                forms.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.form.cmp(&b.form)));
                l.forms = forms;
            }
            if !l.is_proper && !l.lemma.contains(' ') {
                l.zipf = lex.zipf(&l.lemma);
            }
            l
        })
        .collect();
    lemmas.sort_by(|a, b| a.lemma.cmp(&b.lemma));
    rows.sort_by(|a, b| a.lemma.cmp(&b.lemma).then(a.unit.cmp(&b.unit)));
    progress(total, total);
    Ok(BookTable {
        page_count,
        lemmas,
        pages: rows,
        repeated_lines: crate::text::repeated_lines(pages),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Lexicon, TestLexicon};

    fn table(texts: &[&str]) -> BookTable {
        let lex = Lexicon::from_parts(TestLexicon::sample());
        let pages: Vec<PageInput> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| PageInput {
                unit: i as u32,
                text: t,
            })
            .collect();
        build_book_table(&pages, &lex, &AtomicBool::new(false), &mut |_, _| {}).expect("table")
    }

    fn lemma<'a>(t: &'a BookTable, l: &str) -> &'a BookLemma {
        t.lemmas
            .iter()
            .find(|x| x.lemma == l)
            .unwrap_or_else(|| panic!("no {l}"))
    }

    #[test]
    fn counts_lemmas_pages_and_examples() {
        let t = table(&[
            "The pigs went to the windmill. Napoleon watched the pigs and the horses working on the windmill all day.",
            "Boxer said: I will work harder. The windmill fell.",
        ]);
        assert_eq!(t.page_count, 2);
        let w = lemma(&t, "windmill");
        assert_eq!(w.occurrences, 3);
        assert_eq!(w.units, vec![0, 1]);
        assert_eq!(w.first_unit, 0);
        // First sentence has 6 words: too short; the second (17 words) is the example.
        assert!(w.example.starts_with("Napoleon watched"), "{}", w.example);
        let span = w.example_span.expect("span");
        let utf16: Vec<u16> = w.example.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&utf16[span[0] as usize..span[1] as usize]),
            "windmill"
        );
        assert_eq!(lemma(&t, "go").occurrences, 1);
        assert_eq!(lemma(&t, "pig").occurrences, 2);
        let p = t
            .pages
            .iter()
            .find(|p| p.lemma == "pig" && p.unit == 0)
            .expect("page row");
        assert_eq!(p.form, "pigs");
        assert_eq!(p.forms, vec![("pigs".to_string(), 2)]);
        // A short page falls back to a window.
        let fell = t
            .pages
            .iter()
            .find(|p| p.lemma == "windmill" && p.unit == 1)
            .expect("p1");
        assert!(
            fell.example
                .as_deref()
                .is_some_and(|e| e.contains("windmill"))
        );
    }

    #[test]
    fn proper_nouns() {
        let p1 = "Old Major and Napoleon spoke. Then Napoleon and Snowball argued with Boxer about the farm. ".repeat(6);
        let p2 = "Snowball fled. The animals said Snowball was a traitor while Napoleon watched Boxer work. ".repeat(3);
        let p3 = "In winter the children made a snowball and threw it. Napoleon smiled at Boxer.";
        let t = table(&[&p1, &p2, p3]);
        for name in ["Napoleon", "Snowball", "Boxer"] {
            assert!(lemma(&t, name).is_proper, "{name}");
        }
        // The lowercase occurrence stays a common word.
        assert!(!lemma(&t, "snowball").is_proper);
        assert_eq!(lemma(&t, "snowball").occurrences, 1);
    }

    #[test]
    fn forms_are_split_and_phrasal_found() {
        let t = table(&[
            "Learning is fun. He learned to look up words while learning. She looks up and gives in.",
        ]);
        assert_eq!(lemma(&t, "learning").occurrences, 2);
        assert_eq!(
            lemma(&t, "learning").forms[0].alts,
            vec!["learn".to_string()]
        );
        assert_eq!(lemma(&t, "learn").occurrences, 1);
        assert_eq!(lemma(&t, "look up").occurrences, 2);
        assert_eq!(lemma(&t, "give in").occurrences, 1);
        assert_eq!(lemma(&t, "look").occurrences, 2);
    }

    #[test]
    fn cancel_and_empty() {
        let lex = Lexicon::from_parts(TestLexicon::sample());
        let pages = [PageInput {
            unit: 0,
            text: "hello",
        }];
        let r = build_book_table(&pages, &lex, &AtomicBool::new(true), &mut |_, _| {});
        assert_eq!(r, Err(VocabError::Cancelled));
        let t =
            build_book_table(&[], &lex, &AtomicBool::new(false), &mut |_, _| {}).expect("empty");
        assert_eq!(t.page_count, 0);
        assert!(t.lemmas.is_empty());
    }
}
