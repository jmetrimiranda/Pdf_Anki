//! The user's known vocabulary (spec 12.3 A): cleaning the mapped field of each note, the note status, the index
//! (lemma → best status, original form → best status, phrases) and the "eu sei" criterion (12.1 step 4).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::Lexicon;
use crate::lemmatize::{lemmatize, normalize_form};

/// Status of a note: the best among its cards (P2 derives it with the `knownIvlDays` threshold).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteStatus {
    /// Interval ≥ the threshold (21 days by default).
    Mature,
    /// Studied, interval below the threshold.
    Learning,
    /// Never studied.
    New,
    /// All cards suspended.
    Suspended,
}

impl NoteStatus {
    /// Higher is better: Mature > Learning > New > Suspended.
    pub fn rank(self) -> u8 {
        match self {
            NoteStatus::Mature => 3,
            NoteStatus::Learning => 2,
            NoteStatus::New => 1,
            NoteStatus::Suspended => 0,
        }
    }

    /// The better of two statuses.
    pub fn best(self, other: NoteStatus) -> NoteStatus {
        if other.rank() > self.rank() {
            other
        } else {
            self
        }
    }
}

/// One note of the vocabulary folder: its mapped field (HTML) and status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownNote {
    pub note_id: i64,
    pub field_html: String,
    pub status: NoteStatus,
}

/// What to do with suspended notes (12.1 step 4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SuspendedPolicy {
    #[default]
    Ignore,
    Known,
}

/// "Derivadas de palavras conhecidas" (12.1 step 4, 12.3 I).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DerivedPolicy {
    /// Derivatives become cards, with the family shown (default).
    #[default]
    Card,
    /// Derivatives count as known.
    Known,
}

/// The "eu sei" criterion and options of a scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanConfig {
    /// Mature = interval ≥ this many days (applied when the note statuses are derived).
    pub known_ivl_days: u32,
    /// Count learning (young) cards as known.
    pub count_young: bool,
    pub suspended_policy: SuspendedPolicy,
    /// Function words ("the", "of"…) count as known.
    pub function_words_known: bool,
    pub derived_policy: DerivedPolicy,
}

impl Default for ScanConfig {
    fn default() -> Self {
        ScanConfig {
            known_ivl_days: 21,
            count_young: false,
            suspended_policy: SuspendedPolicy::Ignore,
            function_words_known: true,
            derived_policy: DerivedPolicy::Card,
        }
    }
}

/// The index of the user's vocabulary.
#[derive(Debug, Clone, Default)]
pub struct KnownIndex {
    lemmas: HashMap<String, NoteStatus>,
    forms: HashMap<String, NoteStatus>,
    phrases: HashMap<String, NoteStatus>,
    notes: usize,
}

fn upsert(map: &mut HashMap<String, NoteStatus>, key: String, status: NoteStatus) {
    map.entry(key)
        .and_modify(|s| *s = s.best(status))
        .or_insert(status);
}

impl KnownIndex {
    /// Builds the index: every entry of each note's cleaned field is indexed as an original form and under its
    /// lemma (the entry itself when it is a WordNet lemma, else its [`lemmatize`]d form); multi-word entries are
    /// phrases. `_config` is accepted for future criteria; statuses are mapped by [`KnownIndex::status_of`].
    pub fn build(notes: &[KnownNote], lex: &Lexicon, _config: &ScanConfig) -> KnownIndex {
        let mut idx = KnownIndex::default();
        for note in notes {
            let entries = clean_field(&note.field_html);
            if !entries.is_empty() {
                idx.notes += 1;
            }
            for e in entries {
                idx.insert_entry(&e, note.status, lex);
            }
        }
        idx
    }

    /// Adds one already-cleaned entry (lowercase word or phrase).
    pub fn insert_entry(&mut self, entry: &str, status: NoteStatus, lex: &Lexicon) {
        let e = entry.trim();
        if e.is_empty() {
            return;
        }
        if e.contains(' ') {
            let words: Vec<String> = e.split_whitespace().map(normalize_form).collect();
            upsert(&mut self.phrases, words.join(" "), status);
            return;
        }
        let form = normalize_form(e);
        if form.is_empty() {
            return;
        }
        let lemma = if lex.is_lemma(&form, None) {
            form.clone()
        } else {
            lemmatize(&form, lex, None).lemma
        };
        upsert(&mut self.forms, form, status);
        upsert(&mut self.lemmas, lemma, status);
    }

    /// Whether the word is in the index as a lemma or as an original form.
    pub fn has_lemma(&self, word: &str) -> bool {
        self.lemmas.contains_key(word) || self.forms.contains_key(word)
    }

    /// Best status of a lemma.
    pub fn lemma_status(&self, lemma: &str) -> Option<NoteStatus> {
        self.lemmas.get(lemma).copied()
    }

    /// Best status of an original form (as written in the deck).
    pub fn form_status(&self, form: &str) -> Option<NoteStatus> {
        self.forms.get(form).copied()
    }

    /// Best status of the lemma or, failing that, of the form with that spelling.
    pub fn word_status(&self, word: &str) -> Option<NoteStatus> {
        match (self.lemma_status(word), self.form_status(word)) {
            (Some(a), Some(b)) => Some(a.best(b)),
            (a, b) => a.or(b),
        }
    }

    /// Best status of a multi-word entry ("look up").
    pub fn phrase_status(&self, phrase: &str) -> Option<NoteStatus> {
        self.phrases.get(phrase).copied()
    }

    /// Number of notes that produced at least one entry.
    pub fn note_count(&self) -> usize {
        self.notes
    }

    /// Number of distinct lemmas.
    pub fn len(&self) -> usize {
        self.lemmas.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lemmas.is_empty() && self.phrases.is_empty()
    }
}

/// Cleans a mapped field into its entries (spec 12.3 A): strips HTML and `[sound:…]`, `{{c1::x::hint}}` → `x`,
/// drops text in parentheses or brackets, splits variants on `/`, `,`, `;`, line breaks and " or ", lowercases and
/// trims. A leading "to " (verbs) or article is dropped; multi-word entries stay phrases.
pub fn clean_field(html: &str) -> Vec<String> {
    let text = strip_cloze(&strip_sound(html));
    let text = strip_html(&text);
    let text = strip_brackets(&text);
    let mut out: Vec<String> = Vec::new();
    for part in text.split(['/', ',', ';', '\n', '|']) {
        for piece in split_or(part) {
            let cleaned = clean_entry(&piece);
            if !cleaned.is_empty() && !out.contains(&cleaned) {
                out.push(cleaned);
            }
        }
    }
    out
}

fn strip_sound(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("[sound:") {
        out.push_str(&rest[..i]);
        match rest[i..].find(']') {
            Some(j) => rest = &rest[i + j + 1..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_cloze(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("{{c") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 3..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        let body_start = &after[digits..];
        if digits == 0 || !body_start.starts_with("::") {
            out.push_str("{{c");
            rest = after;
            continue;
        }
        let body = &body_start[2..];
        match body.find("}}") {
            Some(end) => {
                let inner = &body[..end];
                out.push_str(inner.split("::").next().unwrap_or(""));
                rest = &body[end + 2..];
            }
            None => {
                out.push_str(body);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Removes tags (block tags and `<br>` become line breaks) and decodes the common entities.
pub(crate) fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '<' {
            let rest = &s[i..];
            if let Some(end) = rest.find('>') {
                let tag = rest[1..end].trim_start_matches('/').to_ascii_lowercase();
                let name: String = tag
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                if matches!(
                    name.as_str(),
                    "br" | "div" | "p" | "li" | "tr" | "ul" | "ol" | "hr"
                ) {
                    out.push('\n');
                }
                // Skip to the '>' (one byte).
                while let Some((j, _)) = chars.peek() {
                    if *j > i + end {
                        break;
                    }
                    chars.next();
                }
                continue;
            }
        }
        if c == '&' {
            let rest = &s[i..];
            if let Some((end, _)) = rest.char_indices().take(12).find(|(_, c)| *c == ';') {
                let ent = &rest[1..end];
                let decoded = match ent {
                    "nbsp" => Some(' '),
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" | "#39" => Some('\''),
                    _ => ent
                        .strip_prefix("#x")
                        .or_else(|| ent.strip_prefix("#X"))
                        .and_then(|h| u32::from_str_radix(h, 16).ok())
                        .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                        .and_then(char::from_u32),
                };
                if let Some(d) = decoded {
                    out.push(d);
                    while let Some((j, _)) = chars.peek() {
                        if *j > i + end {
                            break;
                        }
                        chars.next();
                    }
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

fn strip_brackets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

fn split_or(s: &str) -> Vec<String> {
    let lower = s.to_lowercase();
    lower.split(" or ").map(str::to_string).collect()
}

fn clean_entry(s: &str) -> String {
    let s: String = s
        .chars()
        .map(|c| match c {
            '\u{2019}' | '\u{2018}' | '\u{02BC}' => '\'',
            '\u{00A0}' => ' ',
            c => c,
        })
        .collect();
    let words: Vec<&str> = s.split_whitespace().collect();
    let mut joined = words.join(" ").to_lowercase();
    joined = joined
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
        .trim_matches('\'')
        .to_string();
    for prefix in ["to ", "a ", "an ", "the "] {
        if let Some(rest) = joined.strip_prefix(prefix) {
            if !rest.trim().is_empty() {
                joined = rest.trim().to_string();
            }
            break;
        }
    }
    if !joined.chars().any(char::is_alphabetic) {
        return String::new();
    }
    joined
}

/// ASCII-folds common Latin accents ("Inglês" → "Ingles"); other characters stay.
pub(crate) fn fold_accents(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let r: &str = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => "A",
            'ç' | 'ć' | 'č' => "c",
            'Ç' | 'Ć' | 'Č' => "C",
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => "e",
            'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ę' | 'Ě' => "E",
            'ì' | 'í' | 'î' | 'ï' | 'ī' => "i",
            'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' => "I",
            'ñ' | 'ń' | 'ň' => "n",
            'Ñ' | 'Ń' | 'Ň' => "N",
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o",
            'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' | 'Ő' => "O",
            'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => "u",
            'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ů' | 'Ű' => "U",
            'ý' | 'ÿ' => "y",
            'Ý' | 'Ÿ' => "Y",
            'ś' | 'š' => "s",
            'Ś' | 'Š' => "S",
            'ź' | 'ż' | 'ž' => "z",
            'Ź' | 'Ż' | 'Ž' => "Z",
            'ł' => "l",
            'Ł' => "L",
            'ř' => "r",
            'Ř' => "R",
            'ť' => "t",
            'Ť' => "T",
            'ď' => "d",
            'Ď' => "D",
            'æ' => "ae",
            'Æ' => "AE",
            'œ' => "oe",
            'Œ' => "OE",
            'ß' => "ss",
            _ => {
                out.push(c);
                continue;
            }
        };
        out.push_str(r);
    }
    out
}

/// Field names the wizard suggests, in priority order (spec 12.1 step 3).
const FIELD_PRIORITY: &[&str] = &[
    "word",
    "palavra",
    "english",
    "ingles",
    "front",
    "frente",
    "expression",
    "vocab",
    "term",
];

/// The index of the field that most likely holds the English word: the first name of the priority list (Word,
/// Palavra, English, Inglês, Front, Frente, Expression, Vocab, Term) that a field matches, case- and
/// accent-insensitively (exact name first, then a name that contains it); otherwise 0.
pub fn suggest_field(names: &[String]) -> usize {
    let norm: Vec<String> = names
        .iter()
        .map(|n| fold_accents(n.trim()).to_lowercase())
        .collect();
    for want in FIELD_PRIORITY {
        if let Some(i) = norm.iter().position(|n| n == want) {
            return i;
        }
    }
    for want in FIELD_PRIORITY {
        if let Some(i) = norm.iter().position(|n| {
            n.split(|c: char| !c.is_alphanumeric())
                .any(|part| part == *want)
        }) {
            return i;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Lexicon, TestLexicon};

    #[test]
    fn cleans_fields() {
        let cases: [(&str, &[&str]); 12] = [
            ("windmill", &["windmill"]),
            ("<b>Windmill</b>", &["windmill"]),
            ("to learn [sound:learn.mp3]", &["learn"]),
            ("{{c1::happy::adj}} days", &["happy days"]),
            ("run (verb)", &["run"]),
            ("colour / color", &["colour", "color"]),
            ("big, large; huge", &["big", "large", "huge"]),
            ("look up or search", &["look up", "search"]),
            ("a<br>b<div>see</div>", &["a", "b", "see"]),
            ("don&#39;t &amp; won’t", &["don't & won't"]),
            ("[sound:x.mp3]", &[]),
            ("the Internet&nbsp;", &["internet"]),
        ];
        for (html, want) in cases {
            assert_eq!(clean_field(html), want, "{html}");
        }
        for odd in [
            "<",
            "<<>",
            "&",
            "&#99999999;",
            "{{c",
            "{{c1::",
            "[sound:",
            "(((",
            ")))",
            "&#x;",
        ] {
            let _ = clean_field(odd);
        }
    }

    #[test]
    fn suggests_fields() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(suggest_field(&names(&["Front", "Back"])), 0);
        assert_eq!(suggest_field(&names(&["Back", "Front"])), 1);
        assert_eq!(suggest_field(&names(&["Definição", "Inglês", "Frente"])), 1);
        assert_eq!(suggest_field(&names(&["Front", "Word"])), 1);
        assert_eq!(suggest_field(&names(&["Audio", "WORD"])), 1);
        assert_eq!(suggest_field(&names(&["Image", "English word"])), 1);
        assert_eq!(suggest_field(&names(&["A", "B"])), 0);
        assert_eq!(suggest_field(&[]), 0);
    }

    #[test]
    fn index_statuses() {
        let lex = Lexicon::from_parts(TestLexicon::sample());
        let notes = vec![
            KnownNote {
                note_id: 1,
                field_html: "learn".into(),
                status: NoteStatus::New,
            },
            KnownNote {
                note_id: 2,
                field_html: "to learn".into(),
                status: NoteStatus::Mature,
            },
            KnownNote {
                note_id: 3,
                field_html: "children".into(),
                status: NoteStatus::Learning,
            },
            KnownNote {
                note_id: 4,
                field_html: "look up".into(),
                status: NoteStatus::Suspended,
            },
        ];
        let idx = KnownIndex::build(&notes, &lex, &ScanConfig::default());
        assert_eq!(idx.lemma_status("learn"), Some(NoteStatus::Mature));
        assert_eq!(idx.lemma_status("child"), Some(NoteStatus::Learning));
        assert_eq!(idx.form_status("children"), Some(NoteStatus::Learning));
        assert_eq!(idx.phrase_status("look up"), Some(NoteStatus::Suspended));
        assert_eq!(idx.note_count(), 4);
    }
}
