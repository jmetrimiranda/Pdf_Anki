//! Serde types shared with the UI (camelCase, same names on the TypeScript side).

use serde::{Deserialize, Serialize};

/// One deck in the deck list, with the counts the Anki deck list shows (limits applied).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckNode {
    pub id: i64,
    /// Last component of the name ("Teste").
    pub name: String,
    /// Full Anki name ("Vocabulário::Livros::Teste").
    pub full_name: String,
    /// 1 for top-level decks.
    pub level: u32,
    pub new_count: u32,
    pub learn_count: u32,
    pub review_count: u32,
    pub collapsed: bool,
    pub children: Vec<DeckNode>,
}

/// Same numbers as Anki's "Studied N cards in X minutes today".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudiedToday {
    pub cards: u32,
    pub seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTree {
    pub decks: Vec<DeckNode>,
    pub studied_today: StudiedToday,
}

impl DeckNode {
    /// Depth-first search by full name.
    pub fn find(&self, full_name: &str) -> Option<&DeckNode> {
        if self.full_name == full_name {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(full_name))
    }
}

impl DeckTree {
    pub fn find(&self, full_name: &str) -> Option<&DeckNode> {
        self.decks.iter().find_map(|d| d.find(full_name))
    }
}
