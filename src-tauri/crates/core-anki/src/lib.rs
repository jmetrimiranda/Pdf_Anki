//! `core-anki`: the single owner of the Anki collection.
//!
//! [`AnkiService`] runs a dedicated thread that owns the `anki::collection::Collection`; every
//! other part of the app talks to the collection only through it (docs/PROJETO.md 8.1).

pub mod backup;
pub mod bridge;
pub mod browse;
pub mod decks;
pub mod demo;
mod error;
pub mod fixture;
pub mod import_export;
pub mod media;
pub mod notes;
pub mod notetypes;
mod service;
pub mod study;
pub mod types;

pub use anki;
pub use anki::collection::Collection;
pub use error::{Error, Result};
pub use service::{AnkiService, CollectionPaths};
pub use types::{
    BackupInfo, BackupKind, DeckName, DeckNode, DeckTree, ExportOptions, ExportResult,
    ImportSummary, PrepareReport, StudiedToday,
};
