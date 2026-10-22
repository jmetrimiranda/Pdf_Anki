//! `core-anki`: the single owner of the Anki collection.
//!
//! [`AnkiService`] runs a dedicated thread that owns the `anki::collection::Collection`; every
//! other part of the app talks to the collection only through it (docs/PROJETO.md 8.1).

pub mod decks;
pub mod demo;
mod error;
pub mod notetypes;
mod service;
pub mod types;

pub use anki;
pub use anki::collection::Collection;
pub use error::{Error, Result};
pub use service::{AnkiService, CollectionPaths};
pub use types::{DeckNode, DeckTree, StudiedToday};
