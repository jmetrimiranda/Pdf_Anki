//! Deck, subdeck and tag names of generated vocabulary decks (spec 12.6).

use serde::{Deserialize, Serialize};

use crate::ResolvedRange;
use crate::known::fold_accents;

const SLUG_MAX: usize = 40;

/// A tag/URL slug: lowercase, accents folded to ASCII, anything else non-alphanumeric → '-', collapsed and trimmed,
/// at most 40 characters ("Animal Farm" → "animal-farm", "p. 21-45, 60" → "p-21-45-60").
pub fn slug(s: &str) -> String {
    let folded = fold_accents(s).to_lowercase();
    let mut out = String::with_capacity(folded.len());
    for c in folded.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let mut out: String = out.chars().take(SLUG_MAX).collect();
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn slug_or(s: &str, fallback: &str) -> String {
    let s = slug(s);
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}

/// `livro::<slug of the title>`.
pub fn book_tag(title: &str) -> String {
    format!("livro::{}", slug_or(title, "sem-titulo"))
}

/// `trecho::<slug of the range>` for range scans; `None` for the whole book.
pub fn range_tag(range: &ResolvedRange) -> Option<String> {
    range
        .slug
        .as_deref()
        .or(range.label.as_deref())
        .map(|s| format!("trecho::{}", slug_or(s, "trecho")))
}

/// `cap::03`.
pub fn chapter_tag(n: u32) -> String {
    format!("cap::{n:02}")
}

/// `Cap 03`.
pub fn chapter_subdeck(n: u32) -> String {
    format!("Cap {n:02}")
}

/// The decks of a generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabDeckNames {
    /// `<root>::Livros::<Título>` (or `Livros::<Título>` without a root).
    pub book: String,
    /// `<book>::<range subdeck>` for a range scan without per-chapter subdecks.
    pub range: Option<String>,
    /// One subdeck per chapter (`<book>::Cap NN`).
    pub per_chapter: bool,
}

impl VocabDeckNames {
    /// The deck for a row: its chapter subdeck (per-chapter on, chapter known), else the range subdeck, else the
    /// book deck.
    pub fn deck_for(&self, chapter: Option<u32>) -> String {
        match (self.per_chapter, chapter) {
            (true, Some(n)) => self.chapter(n),
            _ => self.range.clone().unwrap_or_else(|| self.book.clone()),
        }
    }

    /// `<book>::Cap NN`.
    pub fn chapter(&self, n: u32) -> String {
        format!("{}::{}", self.book, chapter_subdeck(n))
    }
}

fn deck_part(s: &str) -> String {
    let t = s.replace("::", ":");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    t.trim_matches(':').trim().to_string()
}

/// The decks of a generated vocabulary deck: the book deck inside the vocabulary folder, the range subdeck (only
/// without per-chapter subdecks: per-chapter subdecks live under the book deck), or per-chapter subdecks.
pub fn vocab_deck_names(
    root_name: Option<&str>,
    title: &str,
    range: &ResolvedRange,
    per_chapter: bool,
) -> VocabDeckNames {
    let title = match deck_part(title) {
        t if t.is_empty() => "Sem título".to_string(),
        t => t,
    };
    let book = match root_name.map(str::trim).filter(|r| !r.is_empty()) {
        Some(root) => format!("{root}::Livros::{title}"),
        None => format!("Livros::{title}"),
    };
    let range = if per_chapter {
        None
    } else {
        range
            .subdeck
            .as_deref()
            .map(deck_part)
            .filter(|s| !s.is_empty())
            .map(|s| format!("{book}::{s}"))
    };
    VocabDeckNames {
        book,
        range,
        per_chapter,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RangeSpec, resolve_range};

    #[test]
    fn slugs_and_tags() {
        assert_eq!(slug("Animal Farm"), "animal-farm");
        assert_eq!(slug("  A Revolução dos Bichos! "), "a-revolucao-dos-bichos");
        assert_eq!(slug("p. 21-45, 60, 72-80"), "p-21-45-60-72-80");
        assert_eq!(slug("Cap 3"), "cap-3");
        assert_eq!(slug("::"), "");
        assert_eq!(slug(&"word ".repeat(20)).len(), 39);
        assert!(!slug(&"word ".repeat(20)).ends_with('-'));
        assert_eq!(book_tag("Animal Farm"), "livro::animal-farm");
        assert_eq!(book_tag("日本"), "livro::sem-titulo");
        assert_eq!(chapter_tag(3), "cap::03");
        assert_eq!(chapter_tag(12), "cap::12");
        assert_eq!(chapter_subdeck(1), "Cap 01");
    }

    #[test]
    fn deck_names() {
        let all = ResolvedRange::all(100);
        let p = resolve_range(
            &RangeSpec::Pages {
                text: "21-45".into(),
            },
            &[],
            100,
        )
        .expect("p");
        assert_eq!(range_tag(&all), None);
        assert_eq!(range_tag(&p).as_deref(), Some("trecho::p-21-45"));

        let n = vocab_deck_names(Some("Vocabulário"), "Animal Farm", &all, false);
        assert_eq!(n.book, "Vocabulário::Livros::Animal Farm");
        assert_eq!(n.deck_for(Some(2)), "Vocabulário::Livros::Animal Farm");

        let n = vocab_deck_names(Some("Vocabulário"), "Animal Farm", &p, false);
        assert_eq!(
            n.range.as_deref(),
            Some("Vocabulário::Livros::Animal Farm::p. 21-45")
        );
        assert_eq!(
            n.deck_for(None),
            "Vocabulário::Livros::Animal Farm::p. 21-45"
        );

        let n = vocab_deck_names(Some("Vocabulário"), "Animal Farm", &p, true);
        assert_eq!(n.range, None);
        assert_eq!(
            n.deck_for(Some(3)),
            "Vocabulário::Livros::Animal Farm::Cap 03"
        );
        assert_eq!(n.deck_for(None), "Vocabulário::Livros::Animal Farm");

        let n = vocab_deck_names(None, "C++ :: Guia", &all, false);
        assert_eq!(n.book, "Livros::C++ : Guia");
        let n = vocab_deck_names(Some("  "), "   ", &all, false);
        assert_eq!(n.book, "Livros::Sem título");
    }
}
