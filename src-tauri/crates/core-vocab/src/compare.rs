//! The comparison of a book's table with the user's vocabulary (spec 12.3 G, I, H), the metrics of the chosen range
//! (12.4) and the report rows (12.5).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::lemmatize::index_only_candidates;
use crate::ranges::chapter_of;
use crate::table::is_split_form;
use crate::{
    BookLemma, BookLemmaPage, Chapter, DerivedPolicy, KnownIndex, Lexicon, NoteStatus, Pos,
    ResolvedRange, ScanConfig, SuspendedPolicy,
};

/// A manual adjustment (`vocab_override`), valid for every book.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverrideStatus {
    /// "Já sei".
    Known,
    /// "Ignorar".
    Ignored,
    /// "Nome próprio".
    Proper,
}

/// Status of a report row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Known,
    Learning,
    /// New in the deck (never studied).
    New,
    Suspended,
    Unknown,
    Ignored,
    Proper,
}

/// Why a row has its status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusSource {
    Override,
    Deck,
    Function,
    /// An inflected form of a known word (group "forms").
    Form,
    /// A derivative of a known word counted as known (derivedPolicy = known).
    Family,
}

/// Group of a report row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RowGroup {
    Main,
    /// "Formas de palavras que você sabe".
    Forms,
    Proper,
    Phrasal,
}

/// A related word and its status ("learning ← learn ✓", "família: learn ✓").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRef {
    pub lemma: String,
    pub status: Status,
}

/// One row of the report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabRow {
    pub lemma: String,
    /// Most common original spelling in the range.
    pub form: String,
    pub pos: Option<Pos>,
    pub group: RowGroup,
    pub status: Status,
    pub status_source: Option<StatusSource>,
    /// Occurrences in the range.
    pub occurrences: u32,
    /// First page in the range (0-based).
    pub first_page: u32,
    /// Pages in the range where it occurs (0-based, sorted).
    pub pages: Vec<u32>,
    pub zipf: Option<f32>,
    /// Zipf < 2.5 or not in the list.
    pub rare: bool,
    /// First example inside the range.
    pub example: Option<String>,
    pub example_span: Option<[u32; 2]>,
    pub example_page: Option<u32>,
    /// For the "forms" group: the known word it is a form of.
    pub base: Option<BaseRef>,
    /// For derivatives: the known word of the family.
    pub family: Option<BaseRef>,
    /// Note created by an earlier scan of this book ("Vocabulário · Livro").
    pub existing_note_id: Option<i64>,
    pub default_selected: bool,
    /// Chapter (1-based index) of `first_page`.
    pub chapter: Option<u32>,
    /// Index of the first occurrence among the words of `first_page` (reading order).
    #[serde(default)]
    pub position: u32,
}

/// A point of the coverage curve: coverage after learning the `n` most frequent unknown lemmas.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
    pub n: u32,
    pub coverage: f64,
}

/// Metrics of the range (spec 12.4). Coverages are fractions (0–1).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    /// Tokens without proper nouns, numbers, ignored words and phrasal verbs.
    pub total_tokens: u32,
    pub known_tokens: u32,
    /// Learning + new in the deck.
    pub learning_tokens: u32,
    pub coverage_known: f64,
    pub coverage_with_learning: f64,
    /// Unknown lemmas (unknown or suspended, main group).
    pub unknown_lemmas: u32,
    /// …of which occur 2 or more times.
    pub unknown_lemmas_repeated: u32,
    /// Unknown lemmas to learn, most frequent first, to reach 95% / 98% (0 if already reached). The curve starts
    /// at the coverage with learning.
    pub words_to_95: u32,
    pub words_to_98: u32,
    pub curve: Vec<CurvePoint>,
    pub proper_lemmas: u32,
    pub forms_lemmas: u32,
}

/// Coverage of one chapter (only the part inside the range).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCoverage {
    pub index: u32,
    pub label: String,
    pub start_page: u32,
    pub end_page: u32,
    pub total_tokens: u32,
    pub known_tokens: u32,
    pub coverage_known: f64,
    pub coverage_with_learning: f64,
}

/// The result of a scan.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub metrics: Metrics,
    pub chapters: Vec<ChapterCoverage>,
    pub rows: Vec<VocabRow>,
}

/// Inputs of [`compare`].
pub struct CompareInput<'a> {
    /// The whole-book lemmas (proper-noun flags, POS, forms and alts).
    pub lemmas: &'a [BookLemma],
    /// Page rows; rows outside `range` are ignored.
    pub pages: &'a [BookLemmaPage],
    pub range: &'a ResolvedRange,
    pub chapters: &'a [Chapter],
    pub known: &'a KnownIndex,
    pub overrides: &'a HashMap<String, OverrideStatus>,
    /// Lemma → note id of "Vocabulário · Livro" notes created by earlier scans of this book.
    pub previous_notes: &'a HashMap<String, i64>,
    pub config: &'a ScanConfig,
    pub lex: &'a Lexicon,
}

/// The status of a word in the deck, with the "eu sei" options applied.
pub(crate) fn deck_status(s: NoteStatus, config: &ScanConfig) -> Status {
    match s {
        NoteStatus::Mature => Status::Known,
        NoteStatus::Learning if config.count_young => Status::Known,
        NoteStatus::Learning => Status::Learning,
        NoteStatus::New => Status::New,
        NoteStatus::Suspended if config.suspended_policy == SuspendedPolicy::Known => Status::Known,
        NoteStatus::Suspended => Status::Suspended,
    }
}

/// Classification of one key (shared with the reading-marks oracle).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Classified {
    pub status: Status,
    pub source: Option<StatusSource>,
    pub group: RowGroup,
    pub base: Option<BaseRef>,
    pub family: Option<BaseRef>,
}

pub(crate) struct Classifier<'a> {
    pub known: &'a KnownIndex,
    pub overrides: &'a HashMap<String, OverrideStatus>,
    pub config: &'a ScanConfig,
    pub lex: &'a Lexicon,
}

impl Classifier<'_> {
    fn plain(&self, status: Status, source: Option<StatusSource>, group: RowGroup) -> Classified {
        Classified {
            status,
            source,
            group,
            base: None,
            family: None,
        }
    }

    /// Whether a word counts as known by itself (override, deck or function word): the bases of forms and families.
    fn word_known(&self, w: &str) -> bool {
        match self.overrides.get(w) {
            Some(OverrideStatus::Known) => return true,
            Some(_) => return false,
            None => {}
        }
        if let Some(s) = self.known.word_status(w)
            && deck_status(s, self.config) == Status::Known
        {
            return true;
        }
        self.config.function_words_known && self.lex.is_function_word(w)
    }

    fn word_deck(&self, w: &str) -> Option<Status> {
        self.known
            .word_status(w)
            .map(|s| deck_status(s, self.config))
    }

    /// Classifies a table key. `forms`: the lowercase forms in the book; `alts`: alternative lemmas of those forms;
    /// `detected_proper`: the table flagged it as a proper noun.
    pub fn classify(
        &self,
        key: &str,
        forms: &[&str],
        alts: &[&str],
        detected_proper: bool,
    ) -> Classified {
        let lower = key.to_lowercase();
        // 1. Manual adjustment.
        if let Some(o) = self
            .overrides
            .get(&lower)
            .or_else(|| self.overrides.get(key))
        {
            return match o {
                OverrideStatus::Known => {
                    self.plain(Status::Known, Some(StatusSource::Override), RowGroup::Main)
                }
                OverrideStatus::Ignored => self.plain(
                    Status::Ignored,
                    Some(StatusSource::Override),
                    RowGroup::Main,
                ),
                OverrideStatus::Proper => self.plain(
                    Status::Proper,
                    Some(StatusSource::Override),
                    RowGroup::Proper,
                ),
            };
        }
        if detected_proper {
            return self.plain(Status::Proper, None, RowGroup::Proper);
        }
        // Phrasal verbs compare with multi-word deck entries only.
        if key.contains(' ') {
            let st = self
                .known
                .phrase_status(&lower)
                .map(|s| deck_status(s, self.config));
            return match st {
                Some(s) => self.plain(s, Some(StatusSource::Deck), RowGroup::Phrasal),
                None => self.plain(Status::Unknown, None, RowGroup::Phrasal),
            };
        }
        // 2. The lemma in the deck.
        if let Some(s) = self.word_deck(&lower) {
            return self.plain(s, Some(StatusSource::Deck), RowGroup::Main);
        }
        let split = is_split_form(&lower, self.lex);
        if split {
            // I. An inflected form that is also its own noun/adjective lemma: "forms" group when a base is known.
            if let Some(b) = alts.iter().find(|a| self.word_known(a)) {
                return Classified {
                    status: Status::Known,
                    source: Some(StatusSource::Form),
                    group: RowGroup::Forms,
                    base: Some(BaseRef {
                        lemma: (*b).to_string(),
                        status: Status::Known,
                    }),
                    family: None,
                };
            }
            // A base being learned: the row follows it.
            let best = alts
                .iter()
                .filter_map(|a| self.word_deck(a).map(|s| (*a, s)))
                .find(|(_, s)| matches!(s, Status::Learning | Status::New));
            if let Some((b, s)) = best {
                return Classified {
                    status: s,
                    source: Some(StatusSource::Form),
                    group: RowGroup::Main,
                    base: Some(BaseRef {
                        lemma: b.to_string(),
                        status: s,
                    }),
                    family: None,
                };
            }
        }
        // 3. The original forms of the lemma in the book, and the alternative lemmas.
        let mut best: Option<Status> = None;
        for w in
            forms
                .iter()
                .filter(|f| **f != lower)
                .chain(if split { [].iter() } else { alts.iter() })
        {
            if let Some(s) = self.word_deck(w) {
                best = Some(match best {
                    Some(b) if rank(b) >= rank(s) => b,
                    _ => s,
                });
            }
        }
        // D.3/D.4: morphy candidates that only the user's index has (the table is built without the index).
        if !split {
            let own = (!forms.contains(&lower.as_str())).then_some(lower.as_str());
            for f in forms.iter().copied().chain(own) {
                for c in index_only_candidates(f, self.lex) {
                    if let Some(s) = self.word_deck(&c) {
                        best = Some(match best {
                            Some(b) if rank(b) >= rank(s) => b,
                            _ => s,
                        });
                    }
                }
            }
        }
        if let Some(s) = best {
            return self.plain(s, Some(StatusSource::Deck), RowGroup::Main);
        }
        // 4. Function words: the lemma, or every form seen in the book (WordNet's morphy turns "his" into the
        // noun "hi", so the key alone would miss it).
        if self.config.function_words_known
            && (self.lex.is_function_word(&lower)
                || (!forms.is_empty() && forms.iter().all(|f| self.lex.is_function_word(f))))
        {
            return self.plain(Status::Known, Some(StatusSource::Function), RowGroup::Main);
        }
        // I. Derivatives of a known word.
        if let Some(b) = self
            .lex
            .family_bases(&lower)
            .into_iter()
            .find(|b| self.word_known(b))
        {
            let family = Some(BaseRef {
                lemma: b,
                status: Status::Known,
            });
            return match self.config.derived_policy {
                DerivedPolicy::Known => Classified {
                    status: Status::Known,
                    source: Some(StatusSource::Family),
                    group: RowGroup::Main,
                    base: None,
                    family,
                },
                DerivedPolicy::Card => Classified {
                    status: Status::Unknown,
                    source: None,
                    group: RowGroup::Main,
                    base: None,
                    family,
                },
            };
        }
        self.plain(Status::Unknown, None, RowGroup::Main)
    }
}

fn rank(s: Status) -> u8 {
    match s {
        Status::Known => 4,
        Status::Learning => 3,
        Status::New => 2,
        Status::Suspended => 1,
        _ => 0,
    }
}

/// Status classes for the metrics.
fn counts_as_known(s: Status) -> bool {
    s == Status::Known
}
fn counts_as_learning(s: Status) -> bool {
    matches!(s, Status::Learning | Status::New)
}
fn counts_as_unknown(s: Status) -> bool {
    matches!(s, Status::Unknown | Status::Suspended)
}
fn in_metrics(r: &VocabRow) -> bool {
    matches!(r.group, RowGroup::Main | RowGroup::Forms)
        && !matches!(r.status, Status::Ignored | Status::Proper)
}

const RARE_ZIPF: f32 = 2.5;
const CURVE_POINTS: usize = 200;

fn ratio(a: u32, b: u32) -> f64 {
    if b == 0 {
        0.0
    } else {
        f64::from(a) / f64::from(b)
    }
}

/// Compares the table (restricted to the range) with the user's vocabulary: metrics, chapters and rows.
/// Target: 10k lemmas in ≤ 300 ms (release).
pub fn compare(input: CompareInput) -> ScanResult {
    let classifier = Classifier {
        known: input.known,
        overrides: input.overrides,
        config: input.config,
        lex: input.lex,
    };
    let by_lemma: HashMap<&str, &BookLemma> =
        input.lemmas.iter().map(|l| (l.lemma.as_str(), l)).collect();

    // Aggregate the page rows inside the range per lemma.
    struct Agg<'p> {
        occurrences: u32,
        pages: Vec<u32>,
        forms: HashMap<&'p str, u32>,
        first: &'p BookLemmaPage,
        per_page: Vec<(u32, u32)>,
    }
    let mut aggs: HashMap<&str, Agg> = HashMap::new();
    for p in input.pages {
        if !input.range.contains(p.unit) {
            continue;
        }
        let a = aggs.entry(p.lemma.as_str()).or_insert_with(|| Agg {
            occurrences: 0,
            pages: Vec::new(),
            forms: HashMap::new(),
            first: p,
            per_page: Vec::new(),
        });
        a.occurrences += p.occurrences;
        a.pages.push(p.unit);
        a.per_page.push((p.unit, p.occurrences));
        for (f, n) in &p.forms {
            *a.forms.entry(f.as_str()).or_default() += n;
        }
        if (p.unit, p.position) < (a.first.unit, a.first.position) {
            a.first = p;
        }
    }

    let mut rows: Vec<VocabRow> = Vec::with_capacity(aggs.len());
    let mut chapter_tokens: HashMap<u32, (u32, u32, u32)> = HashMap::new();
    for (lemma, mut a) in aggs {
        let book = by_lemma.get(lemma);
        let lower_forms: Vec<&str> = book
            .map(|b| b.forms.iter().map(|f| f.form.as_str()).collect())
            .unwrap_or_default();
        let mut alts: Vec<&str> = Vec::new();
        if let Some(b) = book {
            for f in &b.forms {
                for x in &f.alts {
                    if !alts.contains(&x.as_str()) {
                        alts.push(x.as_str());
                    }
                }
            }
        }
        let proper = book.is_some_and(|b| b.is_proper);
        let c = classifier.classify(lemma, &lower_forms, &alts, proper);
        a.pages.sort_unstable();
        a.pages.dedup();
        let form = a
            .forms
            .iter()
            .max_by(|x, y| x.1.cmp(y.1).then_with(|| y.0.cmp(x.0)))
            .map(|(f, _)| (*f).to_string())
            .unwrap_or_else(|| lemma.to_string());
        let zipf = book.and_then(|b| b.zipf).or_else(|| {
            if proper || lemma.contains(' ') {
                None
            } else {
                input.lex.zipf(lemma)
            }
        });
        let existing = input
            .previous_notes
            .get(lemma)
            .copied()
            .or_else(|| input.previous_notes.get(&lemma.to_lowercase()).copied());
        let row = VocabRow {
            lemma: lemma.to_string(),
            form,
            pos: book.and_then(|b| b.pos),
            group: c.group,
            status: c.status,
            status_source: c.source,
            occurrences: a.occurrences,
            first_page: a.first.unit,
            pages: a.pages,
            zipf,
            rare: zipf.is_none_or(|z| z < RARE_ZIPF),
            example: a.first.example.clone(),
            example_span: a.first.example_span,
            example_page: a.first.example.as_ref().map(|_| a.first.unit),
            base: c.base,
            family: c.family,
            existing_note_id: existing,
            default_selected: c.status == Status::Unknown
                && c.group == RowGroup::Main
                && existing.is_none(),
            chapter: chapter_of(input.chapters, a.first.unit),
            position: a.first.position,
        };
        if in_metrics(&row) {
            for (unit, n) in &a.per_page {
                if let Some(ch) = chapter_of(input.chapters, *unit) {
                    let e = chapter_tokens.entry(ch).or_default();
                    e.0 += n;
                    if counts_as_known(row.status) {
                        e.1 += n;
                    } else if counts_as_learning(row.status) {
                        e.2 += n;
                    }
                }
            }
        }
        rows.push(row);
    }
    order_rows(&mut rows, RowOrder::Reading);

    // Metrics.
    let mut m = Metrics::default();
    let mut unknown_occ: Vec<u32> = Vec::new();
    for r in &rows {
        match r.group {
            RowGroup::Proper => m.proper_lemmas += 1,
            RowGroup::Forms => m.forms_lemmas += 1,
            _ => {}
        }
        if !in_metrics(r) {
            continue;
        }
        m.total_tokens += r.occurrences;
        if counts_as_known(r.status) {
            m.known_tokens += r.occurrences;
        } else if counts_as_learning(r.status) {
            m.learning_tokens += r.occurrences;
        } else if counts_as_unknown(r.status) && r.group == RowGroup::Main {
            unknown_occ.push(r.occurrences);
        }
    }
    m.coverage_known = ratio(m.known_tokens, m.total_tokens);
    m.coverage_with_learning = ratio(m.known_tokens + m.learning_tokens, m.total_tokens);
    m.unknown_lemmas = unknown_occ.len() as u32;
    m.unknown_lemmas_repeated = unknown_occ.iter().filter(|n| **n >= 2).count() as u32;
    unknown_occ.sort_unstable_by(|a, b| b.cmp(a));
    let base = m.known_tokens + m.learning_tokens;
    let mut cum = base;
    let mut coverages = Vec::with_capacity(unknown_occ.len() + 1);
    coverages.push(ratio(cum, m.total_tokens));
    for n in &unknown_occ {
        cum += n;
        coverages.push(ratio(cum, m.total_tokens));
    }
    let words_to = |target: f64| -> u32 {
        if m.total_tokens == 0 {
            return 0;
        }
        coverages
            .iter()
            .position(|c| *c + 1e-12 >= target)
            .unwrap_or(coverages.len().saturating_sub(1)) as u32
    };
    m.words_to_95 = words_to(0.95);
    m.words_to_98 = words_to(0.98);
    let len = coverages.len();
    let step = len.div_ceil(CURVE_POINTS).max(1);
    m.curve = coverages
        .iter()
        .enumerate()
        .filter(|(i, _)| i % step == 0 || *i == len - 1)
        .map(|(i, c)| CurvePoint {
            n: i as u32,
            coverage: *c,
        })
        .collect();
    if m.total_tokens == 0 {
        m.curve.clear();
    }

    let chapters = input
        .chapters
        .iter()
        .filter(|c| {
            input
                .range
                .pages
                .iter()
                .any(|[a, b]| c.start_page <= *b && *a <= c.end_page)
        })
        .map(|c| {
            let (t, k, l) = chapter_tokens.get(&c.index).copied().unwrap_or_default();
            ChapterCoverage {
                index: c.index,
                label: c.label.clone(),
                start_page: c.start_page,
                end_page: c.end_page,
                total_tokens: t,
                known_tokens: k,
                coverage_known: ratio(k, t),
                coverage_with_learning: ratio(k + l, t),
            }
        })
        .collect();

    ScanResult {
        metrics: m,
        chapters,
        rows,
    }
}

/// Order of the cards of a generated deck (spec 12.6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RowOrder {
    /// First occurrence: page, then position on the page (default).
    #[default]
    Reading,
    /// Occurrences (descending), ties by first page.
    Frequency,
}

/// Sorts rows in place.
pub fn order_rows(rows: &mut [VocabRow], order: RowOrder) {
    match order {
        RowOrder::Reading => rows.sort_by(|a, b| {
            (a.first_page, a.position)
                .cmp(&(b.first_page, b.position))
                .then_with(|| a.lemma.cmp(&b.lemma))
        }),
        RowOrder::Frequency => rows.sort_by(|a, b| {
            b.occurrences
                .cmp(&a.occurrences)
                .then(a.first_page.cmp(&b.first_page))
                .then(a.position.cmp(&b.position))
                .then_with(|| a.lemma.cmp(&b.lemma))
        }),
    }
}
