//! `.apkg` import/export (docs/PROJETO.md 8.5). `.colpkg` replacement lives in
//! [`crate::AnkiService::import_colpkg`]; backups in [`crate::backup`].
//!
//! Packages are untrusted input: every failure becomes [`Error::InvalidPackage`] with a pt-BR
//! message, never a panic.

use std::io::Read;
use std::path::Path;

use anki::collection::Collection;
use anki::import_export::package::{ExportAnkiPackageOptions, ImportAnkiPackageOptions};
use anki::import_export::{ImportError, NoteLog};
use anki::prelude::{AnkiError, DeckId};
use anki::search::SearchNode;
use anki::services::ImportExportService;

use crate::error::{Error, Result};
use crate::types::{ExportOptions, ExportResult, ImportSummary};

const ZIP_MAGIC: &[u8; 4] = b"PK\x03\x04";

/// Imports an `.apkg` with the collection's saved import options (the same presets the Anki
/// import page shows).
pub fn import_apkg(col: &mut Collection, path: &Path) -> Result<ImportSummary> {
    validate_package(path, "apkg")?;
    let options: ImportAnkiPackageOptions =
        ImportExportService::get_import_anki_package_presets(col)?;
    let log = col
        .import_apkg(path, options)
        .map_err(package_error)?
        .output;
    Ok(summary(&log))
}

/// Exports one deck and its subdecks as `.apkg`; returns the number of notes written.
pub fn export_apkg(
    col: &mut Collection,
    deck_id: i64,
    path: &Path,
    opts: ExportOptions,
) -> Result<ExportResult> {
    if col.get_deck(DeckId(deck_id))?.is_none() {
        return Err(Error::NotFound(format!("baralho {deck_id}")));
    }
    let notes = col.export_apkg(
        path,
        ExportAnkiPackageOptions {
            with_scheduling: opts.with_scheduling,
            with_deck_configs: opts.with_scheduling,
            with_media: opts.with_media,
            legacy: false,
        },
        SearchNode::from_deck_id(DeckId(deck_id), true),
        None,
    )?;
    Ok(ExportResult {
        notes: u32::try_from(notes).unwrap_or(u32::MAX),
    })
}

/// Groups Anki's per-note import log the way the import dialog summary does.
pub fn summary(log: &NoteLog) -> ImportSummary {
    let n = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
    ImportSummary {
        added: n(log.new.len()),
        updated: n(log.updated.len()),
        duplicates: n(log.duplicate.len()),
        conflicts: n(log.conflicting.len()),
        skipped: n(log.first_field_match.len()
            + log.missing_notetype.len()
            + log.missing_deck.len()
            + log.empty_first_field.len()),
    }
}

/// Cheap checks before handing a package to rslib: extension, existing non-empty file, zip
/// magic.
pub(crate) fn validate_package(path: &Path, extension: &str) -> Result<()> {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension));
    if !ext_ok {
        return Err(Error::InvalidPackage(format!(
            "o arquivo precisa ter a extensão .{extension}."
        )));
    }
    let meta = std::fs::metadata(path).map_err(|_| {
        Error::InvalidPackage(format!("o arquivo {} não foi encontrado.", path.display()))
    })?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(Error::InvalidPackage("o arquivo está vazio.".into()));
    }
    let mut magic = [0u8; 4];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_ok();
    if !read || &magic != ZIP_MAGIC {
        return Err(Error::InvalidPackage(
            "o arquivo não é um pacote do Anki (não é um arquivo zip).".into(),
        ));
    }
    Ok(())
}

/// Maps rslib package errors to pt-BR [`Error::InvalidPackage`] messages. Aborts and errors
/// unrelated to the package content keep their own variant.
pub(crate) fn package_error(err: AnkiError) -> Error {
    let message = match &err {
        AnkiError::Interrupted => return Error::from(err),
        AnkiError::ImportError { source } => match source {
            ImportError::TooNew => {
                "o pacote foi criado por uma versão mais nova do Anki.".to_string()
            }
            ImportError::MediaImportFailed { info } => {
                format!("não foi possível importar a mídia ({info}).")
            }
            ImportError::NotetypeKindMergeConflict => {
                "um tipo de nota do pacote conflita com um tipo da coleção (normal × cloze)."
                    .to_string()
            }
            _ => "o arquivo está corrompido ou não é um pacote do Anki.".to_string(),
        },
        _ => "o arquivo está corrompido ou não é um pacote do Anki.".to_string(),
    };
    tracing::warn!(error = ?err, "package rejected");
    Error::InvalidPackage(message)
}
