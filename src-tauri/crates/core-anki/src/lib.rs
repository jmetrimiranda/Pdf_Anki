//! `core-anki`: the single owner of the Anki collection.
//!
//! [`AnkiService`] runs a dedicated thread that owns the `anki::collection::Collection`; every
//! other part of the app talks to the collection only through it (docs/PROJETO.md 8.1).
//!
//! It also syncs that collection with the user's own Anki sync server ([`sync`], spec 9): login
//! (the caller keeps the hkey in the system keychain), normal sync, full sync with a backup first,
//! media sync. AnkiWeb is refused, and sync never goes through the `/_anki/` bridge. No
//! desktop-only APIs here (the iOS door stays open).

pub mod backup;
pub mod book;
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
pub mod sync;
pub mod types;

pub use anki;
pub use anki::collection::Collection;
pub use error::{Error, Result};
pub use service::{AnkiService, CollectionPaths};
pub use sync::{
    CertificateInfo, FullSyncChoice, FullSyncDirection, SyncConfig, SyncCredentials, SyncEndpoint,
    SyncFailure, SyncOutcome, SyncReport,
};
pub use types::{
    BackupInfo, BackupKind, DeckName, DeckNode, DeckTree, ExportOptions, ExportResult,
    ImportSummary, PrepareReport, StudiedToday,
};
