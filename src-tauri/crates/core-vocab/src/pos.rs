//! Parts of speech (WordNet's four; adjective satellites fold into adjectives).

use serde::{Deserialize, Serialize};

/// A WordNet part of speech. Serialized as WordNet's letters `n`, `v`, `a`, `r`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Pos {
    #[serde(rename = "n")]
    Noun,
    #[serde(rename = "v")]
    Verb,
    #[serde(rename = "a")]
    Adj,
    #[serde(rename = "r")]
    Adv,
}

impl Pos {
    /// All four, in WordNet's order.
    pub const ALL: [Pos; 4] = [Pos::Noun, Pos::Verb, Pos::Adj, Pos::Adv];

    /// WordNet's letter (`s`, the satellite, maps to [`Pos::Adj`] in [`Pos::from_letter`]).
    pub fn letter(self) -> &'static str {
        match self {
            Pos::Noun => "n",
            Pos::Verb => "v",
            Pos::Adj => "a",
            Pos::Adv => "r",
        }
    }

    /// Parses `n`, `v`, `a`, `s` (satellite → adjective) or `r`.
    pub fn from_letter(s: &str) -> Option<Pos> {
        match s {
            "n" => Some(Pos::Noun),
            "v" => Some(Pos::Verb),
            "a" | "s" => Some(Pos::Adj),
            "r" => Some(Pos::Adv),
            _ => None,
        }
    }
}

/// The pt-BR name of a part of speech (the "Classe" field of "Vocabulário · Livro").
pub fn pos_label_pt(pos: Pos) -> &'static str {
    match pos {
        Pos::Noun => "substantivo",
        Pos::Verb => "verbo",
        Pos::Adj => "adjetivo",
        Pos::Adv => "advérbio",
    }
}
