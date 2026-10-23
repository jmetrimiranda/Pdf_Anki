//! The English lexicon (spec 12.2): WordNet lemmas with their parts of speech, irregular forms, derivation and
//! pertainym links, first-sense definitions, phrasal verbs, the Zipf frequency list and the function words.
//!
//! [`Lexicon::open`] reads `vocab-en.sqlite` (built by `scripts/build-wordnet.sh`, schema in
//! `docs/tecnico/vocab-data.md`) into memory; definitions stay on disk and are read on demand.
//! [`Lexicon::from_parts`] builds a small in-memory lexicon for tests that run without the data pack.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{DATA_SCHEMA_VERSION, Pos, VocabError};

/// One data source of the pack (shown in "Sobre").
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub name: String,
    pub release: String,
    pub sha256: String,
    pub license: String,
    pub url: String,
}

/// Versions and licences of the loaded data (from the `meta` table).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    pub schema_version: u32,
    pub wordnet: SourceInfo,
    pub frequency: SourceInfo,
    pub stopwords: SourceInfo,
}

/// What the lexicon knows about one lowercase spelling.
#[derive(Debug, Clone, Copy, Default)]
struct WordInfo {
    /// Number of senses per part of speech (index = [`pos_index`]); 0 = not a lemma with that POS.
    senses: [u16; 4],
    /// The lemma exists spelled in lowercase ("snowball"), and/or with capitals ("Napoleon").
    lower: bool,
    cased: bool,
}

impl WordInfo {
    fn has(&self, pos: Option<Pos>) -> bool {
        match pos {
            Some(p) => self.senses[pos_index(p)] > 0,
            None => self.senses.iter().any(|&n| n > 0),
        }
    }
}

pub(crate) fn pos_index(pos: Pos) -> usize {
    match pos {
        Pos::Noun => 0,
        Pos::Verb => 1,
        Pos::Adj => 2,
        Pos::Adv => 3,
    }
}

enum Definitions {
    Memory(HashMap<(String, Pos), String>),
    Db(Mutex<Connection>),
}

/// The loaded lexicon. `Send + Sync`; build it once and share it (`Arc`).
pub struct Lexicon {
    info: DataInfo,
    words: HashMap<String, WordInfo>,
    /// Irregular form (lowercase) → its lemmas.
    forms: HashMap<String, Vec<(String, Pos)>>,
    /// Lemma (lowercase) → lemmas linked by `derivation` (both directions).
    derivation: HashMap<String, Vec<String>>,
    /// Lemma (lowercase) → lemmas it is a pertainym of (quickly → quick).
    pertainym: HashMap<String, Vec<String>>,
    /// Lemmas (lowercase) in any `derivation`/`pertainym` row, including links between the parts of speech of the
    /// same word (corner n ↔ corner v): OEWN has analysed their morphology, so the affix rules don't apply.
    linked: HashSet<String>,
    zipf: HashMap<String, f32>,
    stopwords: HashSet<String>,
    /// Verb (lowercase) → particles of its phrasal verbs ("look" → ["up", "after"...]).
    phrasal: HashMap<String, Vec<String>>,
    definitions: Definitions,
}

/// The parts of [`Lexicon::from_parts`] (tests and fixtures, no data pack needed). Words keep their case.
#[derive(Debug, Clone, Default)]
pub struct TestLexicon {
    /// (word, part of speech, first-sense definition).
    pub lemmas: Vec<(String, Pos, Option<String>)>,
    /// (irregular form, lemma, part of speech of the lemma).
    pub forms: Vec<(String, String, Pos)>,
    /// Derivation links (stored in both directions).
    pub derivations: Vec<(String, String)>,
    /// Pertainyms: (from, to), e.g. ("quickly", "quick").
    pub pertainyms: Vec<(String, String)>,
    pub zipf: Vec<(String, f32)>,
    pub stopwords: Vec<String>,
    /// Phrasal verbs as (verb, particle).
    pub phrasal: Vec<(String, String)>,
}

impl TestLexicon {
    /// Adds lemmas with one POS and no definition.
    pub fn with_lemmas(mut self, pos: Pos, words: &[&str]) -> Self {
        self.lemmas
            .extend(words.iter().map(|w| ((*w).to_string(), pos, None)));
        self
    }

    /// Adds a lemma with its definition.
    pub fn with_definition(mut self, word: &str, pos: Pos, definition: &str) -> Self {
        self.lemmas
            .push((word.to_string(), pos, Some(definition.to_string())));
        self
    }

    /// Adds irregular forms as (form, lemma) of one POS.
    pub fn with_forms(mut self, pos: Pos, forms: &[(&str, &str)]) -> Self {
        self.forms.extend(
            forms
                .iter()
                .map(|(f, l)| ((*f).to_string(), (*l).to_string(), pos)),
        );
        self
    }

    pub fn with_derivations(mut self, pairs: &[(&str, &str)]) -> Self {
        self.derivations.extend(
            pairs
                .iter()
                .map(|(a, b)| ((*a).to_string(), (*b).to_string())),
        );
        self
    }

    pub fn with_pertainyms(mut self, pairs: &[(&str, &str)]) -> Self {
        self.pertainyms.extend(
            pairs
                .iter()
                .map(|(a, b)| ((*a).to_string(), (*b).to_string())),
        );
        self
    }

    pub fn with_zipf(mut self, pairs: &[(&str, f32)]) -> Self {
        self.zipf
            .extend(pairs.iter().map(|(w, z)| ((*w).to_string(), *z)));
        self
    }

    pub fn with_stopwords(mut self, words: &[&str]) -> Self {
        self.stopwords
            .extend(words.iter().map(|w| (*w).to_string()));
        self
    }

    pub fn with_phrasal(mut self, pairs: &[(&str, &str)]) -> Self {
        self.phrasal.extend(
            pairs
                .iter()
                .map(|(v, p)| ((*v).to_string(), (*p).to_string())),
        );
        self
    }

    /// A small English lexicon for tests of other crates (Animal Farm-like words, a few irregular forms, families,
    /// Zipf values and function words). Not a substitute for the data pack.
    pub fn sample() -> Self {
        let nouns = [
            "animal",
            "farm",
            "windmill",
            "pig",
            "horse",
            "man",
            "child",
            "mouse",
            "goose",
            "foot",
            "day",
            "house",
            "learning",
            "meaning",
            "feeling",
            "building",
            "learner",
            "happiness",
            "snowball",
            "boxer",
            "napoleon",
            "Napoleon",
            "Boxer",
            "Snowball",
            "rebellion",
            "barn",
            "harvest",
            "hay",
            "sheep",
            "dog",
            "word",
            "book",
            "time",
            "night",
            "song",
            "interest",
            "study",
            "glasses",
            "glass",
        ];
        let verbs = [
            "be", "have", "do", "go", "learn", "unlearn", "run", "build", "feel", "mean",
            "interest", "study", "watch", "work", "sing", "look", "give", "say", "see", "take",
            "make", "come", "know", "think", "walk", "read",
        ];
        let adjs = [
            "happy",
            "quick",
            "big",
            "good",
            "bad",
            "interesting",
            "old",
            "new",
            "great",
            "small",
            "red",
            "slow",
        ];
        let advs = ["quickly", "slowly", "very", "well"];
        let mut t = TestLexicon::default()
            .with_lemmas(Pos::Noun, &nouns)
            .with_lemmas(Pos::Verb, &verbs)
            .with_lemmas(Pos::Adj, &adjs)
            .with_lemmas(Pos::Adv, &advs)
            .with_forms(
                Pos::Verb,
                &[
                    ("went", "go"),
                    ("gone", "go"),
                    ("was", "be"),
                    ("were", "be"),
                    ("is", "be"),
                    ("are", "be"),
                    ("been", "be"),
                    ("had", "have"),
                    ("has", "have"),
                    ("did", "do"),
                    ("ran", "run"),
                    ("built", "build"),
                    ("felt", "feel"),
                    ("meant", "mean"),
                    ("said", "say"),
                    ("saw", "see"),
                    ("knew", "know"),
                    ("thought", "think"),
                    ("sang", "sing"),
                    ("made", "make"),
                    ("came", "come"),
                    ("took", "take"),
                    ("gave", "give"),
                ],
            )
            .with_forms(
                Pos::Noun,
                &[
                    ("children", "child"),
                    ("mice", "mouse"),
                    ("geese", "goose"),
                    ("feet", "foot"),
                    ("men", "man"),
                ],
            )
            .with_forms(
                Pos::Adj,
                &[("better", "good"), ("best", "good"), ("worse", "bad")],
            )
            .with_derivations(&[
                ("learner", "learn"),
                ("happiness", "happy"),
                ("building", "build"),
            ])
            .with_pertainyms(&[("quickly", "quick"), ("slowly", "slow")])
            .with_stopwords(&[
                "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with",
                "by", "from", "as", "is", "was", "be", "been", "are", "were", "it", "its", "he",
                "she", "they", "them", "his", "her", "their", "i", "you", "we", "that", "this",
                "which", "who", "not", "no", "had", "have", "has", "do", "did", "so", "all",
                "there", "up", "out", "then", "than", "what", "when", "very",
            ])
            .with_phrasal(&[
                ("look", "up"),
                ("give", "in"),
                ("give", "up"),
                ("run", "away"),
            ]);
        t.zipf = [
            ("the", 7.7),
            ("be", 7.3),
            ("go", 6.3),
            ("have", 6.9),
            ("learn", 5.1),
            ("learning", 4.7),
            ("learner", 3.4),
            ("unlearn", 1.9),
            ("happy", 5.5),
            ("happiness", 4.2),
            ("quick", 5.0),
            ("quickly", 4.8),
            ("mean", 5.3),
            ("meaning", 4.8),
            ("feel", 5.7),
            ("feeling", 5.1),
            ("build", 5.1),
            ("building", 5.0),
            ("interest", 5.0),
            ("interesting", 5.2),
            ("run", 5.4),
            ("running", 4.7),
            ("big", 5.6),
            ("good", 6.2),
            ("windmill", 2.9),
            ("animal", 5.0),
            ("farm", 4.9),
            ("pig", 4.4),
            ("horse", 4.8),
            ("snowball", 2.9),
            ("boxer", 3.6),
            ("napoleon", 3.6),
            ("man", 6.0),
            ("child", 5.3),
            ("study", 5.1),
            ("watch", 5.4),
            ("glass", 4.9),
            ("glasses", 4.5),
            ("day", 6.0),
            ("house", 5.6),
            ("look", 6.0),
            ("give", 5.9),
        ]
        .iter()
        .map(|(w, z)| ((*w).to_string(), *z as f32))
        .collect();
        t
    }
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

impl Lexicon {
    /// Loads the data pack at `path` (`vocab-en.sqlite`). Missing file → [`VocabError::Unavailable`]; unreadable
    /// file or another schema → [`VocabError::BadData`].
    pub fn open(path: &Path) -> Result<Lexicon, VocabError> {
        if !path.is_file() {
            return Err(VocabError::Unavailable);
        }
        let bad = |e: rusqlite::Error| VocabError::BadData(e.to_string());
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(bad)?;
        let meta: HashMap<String, String> = {
            let mut st = conn.prepare("SELECT key, value FROM meta").map_err(bad)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(bad)?;
            rows.collect::<Result<_, _>>().map_err(bad)?
        };
        let schema: u32 = meta
            .get("schema_version")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if schema != DATA_SCHEMA_VERSION {
            return Err(VocabError::BadData(format!(
                "esquema {schema}, esperado {DATA_SCHEMA_VERSION}"
            )));
        }
        let source = |prefix: &str| SourceInfo {
            name: meta
                .get(&format!("{prefix}_name"))
                .cloned()
                .unwrap_or_default(),
            release: meta
                .get(&format!("{prefix}_release"))
                .cloned()
                .unwrap_or_default(),
            sha256: meta
                .get(&format!("{prefix}_sha256"))
                .cloned()
                .unwrap_or_default(),
            license: meta
                .get(&format!("{prefix}_license"))
                .cloned()
                .unwrap_or_default(),
            url: meta
                .get(&format!("{prefix}_url"))
                .cloned()
                .unwrap_or_default(),
        };
        let info = DataInfo {
            schema_version: schema,
            wordnet: source("wordnet"),
            frequency: source("frequency"),
            stopwords: source("stopwords"),
        };

        let mut words: HashMap<String, WordInfo> = HashMap::with_capacity(160_000);
        let mut by_id: HashMap<i64, (String, Pos)> = HashMap::with_capacity(170_000);
        {
            let mut st = conn
                .prepare("SELECT id, word, pos, sense_count FROM lemma")
                .map_err(bad)?;
            let mut rows = st.query([]).map_err(bad)?;
            while let Some(r) = rows.next().map_err(bad)? {
                let id: i64 = r.get(0).map_err(bad)?;
                let word: String = r.get(1).map_err(bad)?;
                let pos: String = r.get(2).map_err(bad)?;
                let senses: i64 = r.get::<_, Option<i64>>(3).map_err(bad)?.unwrap_or(1);
                let Some(pos) = Pos::from_letter(&pos) else {
                    continue;
                };
                let lw = lower(&word);
                let e = words.entry(lw.clone()).or_default();
                let slot = &mut e.senses[pos_index(pos)];
                *slot = slot.saturating_add(senses.clamp(1, 1000) as u16);
                if lw == word {
                    e.lower = true;
                } else {
                    e.cased = true;
                }
                by_id.insert(id, (lw, pos));
            }
        }
        let mut forms: HashMap<String, Vec<(String, Pos)>> = HashMap::new();
        {
            let mut st = conn
                .prepare("SELECT form, lemma_id FROM form")
                .map_err(bad)?;
            let mut rows = st.query([]).map_err(bad)?;
            while let Some(r) = rows.next().map_err(bad)? {
                let form: String = r.get(0).map_err(bad)?;
                let id: i64 = r.get(1).map_err(bad)?;
                if let Some((w, p)) = by_id.get(&id) {
                    push_unique(forms.entry(lower(&form)).or_default(), (w.clone(), *p));
                }
            }
        }
        let mut derivation: HashMap<String, Vec<String>> = HashMap::new();
        let mut pertainym: HashMap<String, Vec<String>> = HashMap::new();
        let mut linked: HashSet<String> = HashSet::new();
        {
            let mut st = conn
                .prepare("SELECT from_id, to_id, kind FROM relation")
                .map_err(bad)?;
            let mut rows = st.query([]).map_err(bad)?;
            while let Some(r) = rows.next().map_err(bad)? {
                let from: i64 = r.get(0).map_err(bad)?;
                let to: i64 = r.get(1).map_err(bad)?;
                let kind: String = r.get(2).map_err(bad)?;
                let (Some((a, _)), Some((b, _))) = (by_id.get(&from), by_id.get(&to)) else {
                    continue;
                };
                linked.insert(a.clone());
                linked.insert(b.clone());
                if a == b {
                    continue;
                }
                let map = if kind == "pertainym" {
                    &mut pertainym
                } else {
                    &mut derivation
                };
                push_unique(map.entry(a.clone()).or_default(), b.clone());
            }
        }
        let mut zipf = HashMap::with_capacity(110_000);
        {
            let mut st = conn.prepare("SELECT word, zipf FROM freq").map_err(bad)?;
            let mut rows = st.query([]).map_err(bad)?;
            while let Some(r) = rows.next().map_err(bad)? {
                let w: String = r.get(0).map_err(bad)?;
                let z: f64 = r.get(1).map_err(bad)?;
                zipf.insert(lower(&w), z as f32);
            }
        }
        let mut stopwords = HashSet::new();
        {
            let mut st = conn.prepare("SELECT word FROM stopword").map_err(bad)?;
            let mut rows = st.query([]).map_err(bad)?;
            while let Some(r) = rows.next().map_err(bad)? {
                stopwords.insert(lower(&r.get::<_, String>(0).map_err(bad)?));
            }
        }
        let mut phrasal: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut st = conn
                .prepare("SELECT verb, particle FROM phrasal")
                .map_err(bad)?;
            let mut rows = st.query([]).map_err(bad)?;
            while let Some(r) = rows.next().map_err(bad)? {
                let v: String = r.get(0).map_err(bad)?;
                let p: String = r.get(1).map_err(bad)?;
                push_unique(phrasal.entry(lower(&v)).or_default(), lower(&p));
            }
        }
        Ok(Lexicon {
            info,
            words,
            forms,
            derivation,
            pertainym,
            linked,
            zipf,
            stopwords,
            phrasal,
            definitions: Definitions::Db(Mutex::new(conn)),
        })
    }

    /// An in-memory lexicon from explicit parts (tests; no data pack needed).
    pub fn from_parts(parts: TestLexicon) -> Lexicon {
        let mut words: HashMap<String, WordInfo> = HashMap::new();
        let mut defs = HashMap::new();
        for (word, pos, def) in parts.lemmas {
            let lw = lower(&word);
            let e = words.entry(lw.clone()).or_default();
            e.senses[pos_index(pos)] = e.senses[pos_index(pos)].saturating_add(1);
            if lw == word {
                e.lower = true;
            } else {
                e.cased = true;
            }
            if let Some(d) = def {
                defs.entry((lw, pos)).or_insert(d);
            }
        }
        let mut forms: HashMap<String, Vec<(String, Pos)>> = HashMap::new();
        for (form, lemma, pos) in parts.forms {
            push_unique(forms.entry(lower(&form)).or_default(), (lower(&lemma), pos));
        }
        let mut derivation: HashMap<String, Vec<String>> = HashMap::new();
        let mut linked: HashSet<String> = HashSet::new();
        for (a, b) in parts.derivations {
            let (a, b) = (lower(&a), lower(&b));
            linked.insert(a.clone());
            linked.insert(b.clone());
            if a == b {
                // A link between two parts of speech of the same word (corner n ↔ corner v).
                continue;
            }
            push_unique(derivation.entry(a.clone()).or_default(), b.clone());
            push_unique(derivation.entry(b).or_default(), a);
        }
        let mut pertainym: HashMap<String, Vec<String>> = HashMap::new();
        for (a, b) in parts.pertainyms {
            let (a, b) = (lower(&a), lower(&b));
            linked.insert(a.clone());
            linked.insert(b.clone());
            push_unique(pertainym.entry(a).or_default(), b);
        }
        let mut phrasal: HashMap<String, Vec<String>> = HashMap::new();
        for (v, p) in parts.phrasal {
            push_unique(phrasal.entry(lower(&v)).or_default(), lower(&p));
        }
        Lexicon {
            info: DataInfo {
                schema_version: DATA_SCHEMA_VERSION,
                ..DataInfo::default()
            },
            words,
            forms,
            derivation,
            pertainym,
            linked,
            zipf: parts
                .zipf
                .into_iter()
                .map(|(w, z)| (lower(&w), z))
                .collect(),
            stopwords: parts.stopwords.iter().map(|w| lower(w)).collect(),
            phrasal,
            definitions: Definitions::Memory(defs),
        }
    }

    /// Sources, versions and licences of the data.
    pub fn info(&self) -> &DataInfo {
        &self.info
    }

    /// Number of distinct lemma spellings (lowercase).
    pub fn lemma_count(&self) -> usize {
        self.words.len()
    }

    /// Whether `word` (any case) is a WordNet lemma, optionally with the given part of speech.
    pub fn is_lemma(&self, word: &str, pos: Option<Pos>) -> bool {
        self.words.get(&lower(word)).is_some_and(|w| w.has(pos))
    }

    /// The parts of speech of a lemma, most senses first.
    pub fn parts_of_speech(&self, word: &str) -> Vec<Pos> {
        let Some(info) = self.words.get(&lower(word)) else {
            return Vec::new();
        };
        let mut out: Vec<Pos> = Pos::ALL
            .into_iter()
            .filter(|p| info.senses[pos_index(*p)] > 0)
            .collect();
        out.sort_by_key(|p| std::cmp::Reverse(info.senses[pos_index(*p)]));
        out
    }

    /// Whether the lemma exists spelled in lowercase ("snowball"), as opposed to only capitalized ("Orwell").
    pub fn has_lowercase_lemma(&self, word: &str) -> bool {
        self.words.get(&lower(word)).is_some_and(|w| w.lower)
    }

    /// Whether WordNet has the lemma with capitals ("Napoleon", "Boxer").
    pub fn has_capitalized_lemma(&self, word: &str) -> bool {
        self.words.get(&lower(word)).is_some_and(|w| w.cased)
    }

    /// The lemmas of an irregular form ("went" → go/v).
    pub fn exception_lemmas(&self, form: &str) -> &[(String, Pos)] {
        self.forms.get(form).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Zipf frequency (wordfreq scale: 7 ≈ "the", 3 ≈ once per million words), lowercase lookup.
    pub fn zipf(&self, word: &str) -> Option<f32> {
        self.zipf
            .get(word)
            .or_else(|| self.zipf.get(&lower(word)))
            .copied()
    }

    /// Whether the word is in the function-word (stopword) list.
    pub fn is_function_word(&self, word: &str) -> bool {
        self.stopwords.contains(word) || self.stopwords.contains(&lower(word))
    }

    /// The particles of the phrasal verbs of `verb` ("look" → up, after…).
    pub fn phrasal_particles(&self, verb: &str) -> &[String] {
        self.phrasal.get(verb).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Whether "verb particle" is a WordNet phrasal verb.
    pub fn is_phrasal(&self, verb: &str, particle: &str) -> bool {
        self.phrasal_particles(verb).iter().any(|p| p == particle)
    }

    /// Lemmas linked to `lemma` by WordNet `derivation` (both directions).
    pub fn derivations(&self, lemma: &str) -> &[String] {
        self.derivation.get(lemma).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Lemmas `lemma` is a pertainym of (quickly → quick).
    pub fn pertainyms(&self, lemma: &str) -> &[String] {
        self.pertainym.get(lemma).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Whether OEWN has any `derivation`/`pertainym` link for `lemma` (lowercase), including a link between two
    /// parts of speech of the same word.
    pub fn has_oewn_links(&self, lemma: &str) -> bool {
        self.linked.contains(lemma)
    }

    /// The words `lemma` derives from (spec 12.3 I), most frequent first: WordNet `derivation` links to a shorter
    /// lemma (learner → learn, happiness → happy) and pertainyms (quickly → quick). Only when OEWN has no link at
    /// all for the word, affix rules validated by both words being WordNet lemmas (unlearn → learn). Empty for a
    /// base word.
    pub fn family_bases(&self, lemma: &str) -> Vec<String> {
        let lw = lower(lemma);
        let len = lw.chars().count();
        let mut out: Vec<String> = Vec::new();
        for d in self.derivations(&lw) {
            if d.chars().count() < len && !d.contains(' ') && !is_false_family(&lw, d) {
                push_unique(&mut out, d.clone());
            }
        }
        for p in self.pertainyms(&lw) {
            if *p != lw && !p.contains(' ') {
                push_unique(&mut out, p.clone());
            }
        }
        if !self.has_oewn_links(&lw) {
            for b in crate::lemmatize::affix_bases(&lw, self) {
                push_unique(&mut out, b);
            }
        }
        out.retain(|b| *b != lw);
        out.sort_by(|a, b| {
            let za = self.zipf(a).unwrap_or(0.0);
            let zb = self.zipf(b).unwrap_or(0.0);
            zb.total_cmp(&za).then_with(|| a.cmp(b))
        });
        out
    }

    /// The first-sense definition of `lemma`: for `pos` when given (and present), otherwise for the part of speech
    /// with the most senses. Never fails: a read error is `None`.
    pub fn definition(&self, lemma: &str, pos: Option<Pos>) -> Option<(Pos, String)> {
        let lw = lower(lemma);
        let order: Vec<Pos> = match pos {
            Some(p) if self.is_lemma(&lw, Some(p)) => vec![p],
            _ => self.parts_of_speech(&lw),
        };
        let first = *order.first()?;
        match &self.definitions {
            Definitions::Memory(defs) => order
                .iter()
                .find_map(|p| defs.get(&(lw.clone(), *p)).map(|d| (*p, d.clone()))),
            Definitions::Db(conn) => {
                let conn = conn.lock().ok()?;
                // Prefer the lowercase spelling, then any capitalization.
                let mut st = conn
                    .prepare_cached(
                        "SELECT definition FROM lemma WHERE lower(word) = ?1 AND pos = ?2 AND definition IS NOT NULL \
                         ORDER BY word = ?1 DESC, sense_count DESC LIMIT 1",
                    )
                    .ok()?;
                let d: Option<String> = st
                    .query_row(rusqlite::params![lw, first.letter()], |r| r.get(0))
                    .optional()
                    .ok()
                    .flatten();
                d.map(|d| (first, d))
            }
        }
    }
}

/// OEWN `derivation` links that come from a rare sense of a common word and would show a misleading family
/// ("letter" as "one who lets" → let). Checked against the 2025 release.
const FALSE_FAMILIES: &[(&str, &str)] = &[("letter", "let"), ("better", "bet")];

fn is_false_family(derived: &str, base: &str) -> bool {
    FALSE_FAMILIES
        .iter()
        .any(|(d, b)| *d == derived && *b == base)
}

fn push_unique<T: PartialEq>(v: &mut Vec<T>, x: T) {
    if !v.contains(&x) {
        v.push(x);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexicon_is_send_sync() {
        fn check<T: Send + Sync>() {}
        check::<Lexicon>();
    }

    #[test]
    fn missing_file_is_unavailable() {
        let e = Lexicon::open(Path::new("/nonexistent/vocab-en.sqlite"))
            .err()
            .expect("error");
        assert_eq!(e, VocabError::Unavailable);
    }

    #[test]
    fn garbage_file_is_bad_data() {
        let dir = std::env::temp_dir().join(format!("core-vocab-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("vocab-en.sqlite");
        std::fs::write(&path, b"not a database at all, just bytes").expect("write");
        let e = Lexicon::open(&path).err().expect("error");
        assert!(matches!(e, VocabError::BadData(_)), "{e:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn from_parts_lookups() {
        let lex = Lexicon::from_parts(TestLexicon::sample().with_definition(
            "windmill",
            Pos::Noun,
            "a mill powered by the wind",
        ));
        assert!(lex.is_lemma("Windmill", Some(Pos::Noun)));
        assert!(!lex.is_lemma("windmill", Some(Pos::Verb)));
        assert!(lex.has_lowercase_lemma("snowball"));
        assert!(lex.has_capitalized_lemma("napoleon"));
        assert_eq!(
            lex.definition("windmill", None),
            Some((Pos::Noun, "a mill powered by the wind".to_string()))
        );
        assert_eq!(lex.family_bases("learner"), vec!["learn".to_string()]);
        assert_eq!(lex.family_bases("quickly"), vec!["quick".to_string()]);
        assert!(lex.family_bases("learn").is_empty());
        assert!(lex.is_function_word("The"));
        assert!(lex.is_phrasal("look", "up"));
    }

    #[test]
    fn affix_rules_only_without_oewn_links() {
        let lex = Lexicon::from_parts(
            TestLexicon::default()
                .with_lemmas(
                    Pos::Noun,
                    &[
                        "corner",
                        "letter",
                        "number",
                        "numbering",
                        "station",
                        "worker",
                    ],
                )
                .with_lemmas(Pos::Noun, &["record", "cord", "summer", "summery"])
                .with_lemmas(
                    Pos::Verb,
                    &["corner", "corn", "letter", "let", "number", "station"],
                )
                .with_lemmas(Pos::Verb, &["state", "record", "work", "summer", "sum"])
                .with_lemmas(Pos::Adj, &["numb", "unkind", "kind"])
                // A link between two parts of speech of the same word still counts as an OEWN link.
                .with_derivations(&[
                    ("corner", "corner"),
                    ("station", "station"),
                    ("record", "record"),
                    ("letter", "letter"),
                    ("letter", "let"),
                    ("number", "numbering"),
                    ("summer", "summery"),
                ]),
        );
        for word in ["corner", "letter", "number", "station", "record", "summer"] {
            assert!(
                lex.family_bases(word).is_empty(),
                "{word}: {:?}",
                lex.family_bases(word)
            );
        }
        // No OEWN link at all: the affix rules apply.
        assert_eq!(lex.family_bases("worker"), vec!["work".to_string()]);
        assert_eq!(lex.family_bases("unkind"), vec!["kind".to_string()]);
    }
}
