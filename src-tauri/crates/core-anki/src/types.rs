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
    /// Filtered (custom study) deck.
    pub filtered: bool,
    /// Cards in the deck and its subdecks (Anki's `total_including_children`).
    pub total: u32,
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
    /// The collection's current deck (falls back to Default, id 1).
    pub current_deck_id: i64,
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

/// A deck for pickers: full name, sorted case-insensitively.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckName {
    pub id: i64,
    pub name: String,
    pub filtered: bool,
}

/// Result of "Preparar coleção": which app notetypes were created now and which already existed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareReport {
    pub created: Vec<String>,
    pub existing: Vec<String>,
}

/// Note counts of an `.apkg` import (Anki's import log, grouped).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: u32,
    pub updated: u32,
    pub duplicates: u32,
    pub conflicts: u32,
    pub skipped: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub with_scheduling: bool,
    pub with_media: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            with_scheduling: true,
            with_media: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// Number of exported notes.
    pub notes: u32,
}

/// Why a `.colpkg` backup was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    Daily,
    PreImport,
    Manual,
}

/// One backup file in `<collection dir>/backups/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub file_name: String,
    pub kind: BackupKind,
    /// Local time encoded in the name, as epoch milliseconds.
    pub created_at: i64,
    pub size: u64,
}
