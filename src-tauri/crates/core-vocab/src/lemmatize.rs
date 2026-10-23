//! Lemmatization (spec 12.3 D): WordNet exception forms, then WordNet's "morphy" suffix rules per part of speech
//! (plus a doubled-consonant extension), keeping only candidates in the lexicon or the user's index. Also the affix
//! rules that back up OEWN's `derivation` links for word families (12.3 I).

use serde::{Deserialize, Serialize};

use crate::{KnownIndex, Lexicon, Pos};

/// The analysis of one word form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lemma {
    /// The chosen lemma, lowercase (the form itself when nothing better exists).
    pub lemma: String,
    /// Its part of speech, when the lemma is in the lexicon.
    pub pos: Option<Pos>,
    /// The other candidate lemmas (sorted), so a comparison can re-attribute the form to one the user knows.
    pub alts: Vec<String>,
}

const NOUN_RULES: &[(&str, &str)] = &[
    ("s", ""),
    ("ses", "s"),
    ("xes", "x"),
    ("zes", "z"),
    ("ches", "ch"),
    ("shes", "sh"),
    ("men", "man"),
    ("ies", "y"),
];
const VERB_RULES: &[(&str, &str)] = &[
    ("s", ""),
    ("ies", "y"),
    ("es", "e"),
    ("es", ""),
    ("ed", "e"),
    ("ed", ""),
    ("ied", "y"),
    ("ing", "e"),
    ("ing", ""),
];
const ADJ_RULES: &[(&str, &str)] = &[
    ("er", ""),
    ("est", ""),
    ("er", "e"),
    ("est", "e"),
    ("ier", "y"),
    ("iest", "y"),
];

/// When the form itself is a lemma and an inflectional reduction also exists, the form wins only if it is this much
/// more frequent (Zipf) than the best reduction ("physics" over "physic", but "running" → "run").
const IDENTITY_MARGIN: f32 = 1.0;

/// Lowercases, normalizes typographic apostrophes and drops a possessive `'s`/`s'`.
pub(crate) fn normalize_form(form: &str) -> String {
    let mut w: String = form
        .trim()
        .chars()
        .map(|c| match c {
            '\u{2019}' | '\u{2018}' | '\u{02BC}' => '\'',
            c => c,
        })
        .collect::<String>()
        .to_lowercase();
    if let Some(stem) = w.strip_suffix("'s") {
        w = stem.to_string();
    } else if w.ends_with("s'") {
        w.pop();
    }
    w
}

fn is_consonant(c: u8) -> bool {
    c.is_ascii_lowercase() && !matches!(c, b'a' | b'e' | b'i' | b'o' | b'u')
}

/// The morphy candidates of `w` (lowercase) for one part of speech, before validation.
fn rule_candidates(w: &str, rules: &[(&str, &str)], doubled: bool) -> Vec<String> {
    let mut out = Vec::new();
    for (suffix, ending) in rules {
        let Some(stem) = w.strip_suffix(suffix) else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        out.push(format!("{stem}{ending}"));
        // running → run, bigger → big, stopped → stop.
        if doubled && ending.is_empty() && matches!(*suffix, "ed" | "ing" | "er" | "est") {
            let b = stem.as_bytes();
            let n = b.len();
            if n >= 3 && b[n - 1] == b[n - 2] && is_consonant(b[n - 1]) {
                out.push(stem[..n - 1].to_string());
            }
        }
    }
    out
}

/// The morphy reductions of `w` (lowercase, normalized) that are NOT WordNet lemmas of any part of speech, so they
/// can only be valid through the user's index (spec 12.3 D.3: a candidate is kept when it is in WordNet OR in the
/// index). The book table is built without the index ([`lemmatize`] with `None`), so the comparison checks these
/// against the decks ("vlogs" counts as an inflection of a deck word "vlog" missing from OEWN). Candidates that are
/// WordNet lemmas are left out: those valid for the rule's POS are already lemmas/alts of the table, and the others
/// ("new" from "news" by a noun rule) would be cross-POS false matches.
pub(crate) fn index_only_candidates(w: &str, lex: &Lexicon) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !w.is_ascii() || w.len() > crate::MAX_WORD_CHARS * 2 {
        return out;
    }
    for (rules, doubled) in [(NOUN_RULES, false), (VERB_RULES, true), (ADJ_RULES, true)] {
        for c in rule_candidates(w, rules, doubled) {
            if c != w && c.len() >= 2 && !out.contains(&c) && !lex.is_lemma(&c, None) {
                out.push(c);
            }
        }
    }
    out
}

/// Lemmatizes `form` with the lexicon, preferring candidates in the user's index when given (spec 12.3 D).
/// Steps: exception forms; morphy rules per POS (+ doubled consonant); keep candidates in the lexicon or the index;
/// choose the one in the index, else the most frequent (Zipf), else the form itself. The form is itself a candidate
/// when it is a lemma, but an inflectional reduction wins unless the form is clearly more frequent.
pub fn lemmatize(form: &str, lex: &Lexicon, known: Option<&KnownIndex>) -> Lemma {
    let w = normalize_form(form);
    if w.is_empty() || w.chars().count() > crate::MAX_WORD_CHARS * 2 {
        return Lemma {
            lemma: w,
            pos: None,
            alts: Vec::new(),
        };
    }
    let in_index = |s: &str| known.is_some_and(|k| k.has_lemma(s));
    // (lemma, pos) reductions, in discovery order.
    let mut reductions: Vec<(String, Pos)> = Vec::new();
    let add = |v: &mut Vec<(String, Pos)>, l: String, p: Pos| {
        if l != w && !v.iter().any(|(x, q)| *x == l && *q == p) {
            v.push((l, p));
        }
    };
    for (l, p) in lex.exception_lemmas(&w) {
        add(&mut reductions, l.clone(), *p);
    }
    if w.is_ascii() {
        for (pos, rules, doubled) in [
            (Pos::Noun, NOUN_RULES, false),
            (Pos::Verb, VERB_RULES, true),
            (Pos::Adj, ADJ_RULES, true),
        ] {
            for c in rule_candidates(&w, rules, doubled) {
                if lex.is_lemma(&c, Some(pos)) || in_index(&c) {
                    add(&mut reductions, c, pos);
                }
            }
        }
    }
    let identity: Vec<Pos> = lex.parts_of_speech(&w);
    let zipf = |s: &str| lex.zipf(s).unwrap_or(0.0);
    let pos_of = |l: &str, fallback: Option<Pos>| -> Option<Pos> {
        // The part of speech with the most senses among those that produced `l`.
        let mut ps: Vec<Pos> = reductions
            .iter()
            .filter(|(x, _)| x == l)
            .map(|(_, p)| *p)
            .collect();
        if ps.is_empty() {
            return fallback;
        }
        let order = lex.parts_of_speech(l);
        ps.sort_by_key(|p| order.iter().position(|q| q == p).unwrap_or(usize::MAX));
        ps.first().copied()
    };

    let mut names: Vec<String> = Vec::new();
    for (l, _) in &reductions {
        if !names.contains(l) {
            names.push(l.clone());
        }
    }
    let best_reduction = {
        let pool: Vec<&String> = if names.iter().any(|n| in_index(n)) {
            names.iter().filter(|n| in_index(n)).collect()
        } else {
            names.iter().collect()
        };
        pool.into_iter()
            .max_by(|a, b| zipf(a).total_cmp(&zipf(b)).then_with(|| b.cmp(a)))
            .cloned()
    };
    let identity_ok = !identity.is_empty() || in_index(&w);
    let chosen: (String, Option<Pos>) = match best_reduction {
        None => (w.clone(), identity.first().copied()),
        Some(r) => {
            let r_known = in_index(&r);
            let w_known = in_index(&w);
            let identity_wins = identity_ok
                && if known.is_some() && (r_known || w_known) {
                    w_known && !r_known
                } else {
                    zipf(&w) >= zipf(&r) + IDENTITY_MARGIN
                };
            if identity_wins {
                (w.clone(), identity.first().copied())
            } else {
                let p = pos_of(&r, None);
                (r, p)
            }
        }
    };
    let mut alts: Vec<String> = names.into_iter().filter(|n| *n != chosen.0).collect();
    if identity_ok && chosen.0 != w {
        alts.push(w.clone());
    }
    alts.sort();
    alts.dedup();
    Lemma {
        lemma: chosen.0,
        pos: chosen.1,
        alts,
    }
}

/// The lemma of `word`: with the lexicon when given ([`lemmatize`] without a user index), otherwise the
/// provisional rules of Phase 4 ([`crate::lemma`]).
pub fn lemma_with(word: &str, lex: Option<&Lexicon>) -> String {
    match lex {
        Some(lex) => lemmatize(word, lex, None).lemma,
        None => crate::lemma(word),
    }
}

/// Affix rules for word families (spec 12.3 I), used only when OEWN has no `derivation`/`pertainym` link for the
/// word ([`Lexicon::family_bases`]): candidates are kept only when both words are WordNet lemmas and the base has
/// the part of speech the affix attaches to. Agent nouns (-er/-or) must be nouns only and never drop a doubled
/// consonant (letter is not "one who lets"); the doubled consonant is dropped only before -able (forgettable).
pub(crate) fn affix_bases(w: &str, lex: &Lexicon) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !w.is_ascii() || w.len() < 5 || !lex.is_lemma(w, None) {
        return out;
    }
    let derived_pos = lex.parts_of_speech(w);
    let noun_only = derived_pos == [Pos::Noun];
    let mut push = |cand: String, pos: Option<Pos>| {
        if cand.len() >= 3
            && cand != w
            && lex.is_lemma(&cand, pos)
            && (pos.is_some() || derived_pos.iter().any(|p| lex.is_lemma(&cand, Some(*p))))
            && !out.contains(&cand)
        {
            out.push(cand);
        }
    };
    for prefix in ["un", "re", "dis", "mis", "in", "im", "il", "ir", "non"] {
        if let Some(rest) = w.strip_prefix(prefix) {
            // Same part of speech on both sides (unlearn/learn, unhappy/happy).
            push(rest.to_string(), None);
        }
    }
    // (suffix, replacement, part of speech of the base)
    const SUFFIXES: &[(&str, &str, Pos)] = &[
        ("iness", "y", Pos::Adj),
        ("ness", "", Pos::Adj),
        ("ily", "y", Pos::Adj),
        ("ally", "", Pos::Adj),
        ("bly", "ble", Pos::Adj),
        ("ly", "", Pos::Adj),
        ("ier", "y", Pos::Verb),
        ("er", "", Pos::Verb),
        ("er", "e", Pos::Verb),
        ("or", "", Pos::Verb),
        ("or", "e", Pos::Verb),
        ("ment", "", Pos::Verb),
        ("iful", "y", Pos::Noun),
        ("ful", "", Pos::Noun),
        ("iless", "y", Pos::Noun),
        ("less", "", Pos::Noun),
        ("able", "", Pos::Verb),
        ("able", "e", Pos::Verb),
        ("ible", "", Pos::Verb),
        ("ibility", "ible", Pos::Adj),
        ("ability", "able", Pos::Adj),
        ("ity", "", Pos::Adj),
        ("ity", "e", Pos::Adj),
        ("ication", "y", Pos::Verb),
        ("ation", "ate", Pos::Verb),
        ("ation", "", Pos::Verb),
        ("ation", "e", Pos::Verb),
    ];
    for (suffix, rep, pos) in SUFFIXES {
        let Some(stem) = w.strip_suffix(suffix) else {
            continue;
        };
        if stem.len() < 2 {
            continue;
        }
        let agent = matches!(*suffix, "er" | "ier" | "or");
        if agent && !noun_only {
            continue;
        }
        push(format!("{stem}{rep}"), Some(*pos));
        if rep.is_empty() && matches!(*suffix, "able" | "ible") {
            let b = stem.as_bytes();
            let n = b.len();
            // runner → run, forgettable → forget.
            if n >= 3 && b[n - 1] == b[n - 2] && is_consonant(b[n - 1]) {
                push(stem[..n - 1].to_string(), Some(*pos));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TestLexicon;

    fn lex() -> Lexicon {
        Lexicon::from_parts(TestLexicon::sample())
    }

    #[test]
    fn exceptions_and_rules() {
        let lex = lex();
        for (form, want) in [
            ("went", "go"),
            ("children", "child"),
            ("mice", "mouse"),
            ("better", "good"),
            ("ran", "run"),
            ("geese", "goose"),
            ("studies", "study"),
            ("running", "run"),
            ("bigger", "big"),
            ("watched", "watch"),
            ("learns", "learn"),
            ("learned", "learn"),
            ("Pigs", "pig"),
            ("farmer's", "farmer"),
            ("zzzq", "zzzq"),
        ] {
            assert_eq!(lemmatize(form, &lex, None).lemma, want, "{form}");
        }
        let l = lemmatize("learning", &lex, None);
        assert_eq!(l.lemma, "learn");
        assert_eq!(l.alts, vec!["learning".to_string()]);
        assert_eq!(l.pos, Some(Pos::Verb));
        // The form itself wins only when clearly more frequent.
        let g = lemmatize("glasses", &lex, None);
        assert_eq!(g.lemma, "glass");
        assert_eq!(g.alts, vec!["glasses".to_string()]);
    }

    #[test]
    fn affixes() {
        let lex = lex();
        assert_eq!(affix_bases("unlearn", &lex), vec!["learn".to_string()]);
        assert_eq!(affix_bases("happiness", &lex), vec!["happy".to_string()]);
        assert_eq!(affix_bases("quickly", &lex), vec!["quick".to_string()]);
        assert_eq!(affix_bases("learner", &lex), vec!["learn".to_string()]);
        assert!(affix_bases("learn", &lex).is_empty());
    }

    #[test]
    fn fallback_without_lexicon() {
        assert_eq!(lemma_with("children", None), "child");
        assert_eq!(lemma_with("went", Some(&lex())), "go");
    }

    #[test]
    fn odd_input() {
        let lex = lex();
        for w in [
            "",
            "'",
            "'s",
            "s'",
            "ing",
            "ed",
            "ss",
            "🐷s",
            "ÉTATS",
            "a\u{301}ed",
            &"x".repeat(10_000),
        ] {
            let _ = lemmatize(w, &lex, None);
            let _ = affix_bases(w, &lex);
        }
    }
}
