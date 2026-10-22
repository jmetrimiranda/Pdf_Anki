//! Notetypes (docs/PROJETO.md 9). The app's own types are created by "Preparar coleção" in a
//! later phase; this module only names them and finds the stock ones.

use anki::collection::Collection;
use anki::prelude::Notetype;
use anki_proto::notetypes::notetype::config::Kind as NotetypeKind;
use anki_proto::notetypes::stock_notetype::OriginalStockKind;
use std::sync::Arc;

use crate::error::{Error, Result};

pub const BASIC_LEITOR: &str = "Básico (Leitor)";
pub const CLOZE_LEITOR: &str = "Cloze (Leitor)";
pub const CODE_COMMAND: &str = "Código · Comando";
pub const CODE_PROGRAM: &str = "Código · Programa";
pub const VOCAB_BOOK: &str = "Vocabulário · Livro";

/// Notetypes the app creates (idempotent per type, never modified once created).
pub const APP_NOTETYPES: [&str; 5] = [
    BASIC_LEITOR,
    CLOZE_LEITOR,
    CODE_COMMAND,
    CODE_PROGRAM,
    VOCAB_BOOK,
];

/// The collection's stock "Basic" notetype, found by kind rather than by its (localized) name.
/// Picks the oldest one, which is the stock type created with the collection.
pub fn stock_basic(col: &mut Collection) -> Result<Arc<Notetype>> {
    col.get_all_notetypes()?
        .into_iter()
        .filter(|nt| {
            nt.config.original_stock_kind() == OriginalStockKind::Basic
                && nt.config.kind() == NotetypeKind::Normal
                && nt.fields.len() >= 2
                && !nt.templates.is_empty()
        })
        .min_by_key(|nt| nt.id.0)
        .ok_or_else(|| Error::NotFound("tipo de nota Básico".into()))
}
