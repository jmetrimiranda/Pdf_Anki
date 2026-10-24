//! EPUB data (spec 7.1, 14): the highlights, notes and bookmarks of EPUB books (`epub_annotation`, CFI ranges; PDF
//! annotations live inside the PDF) and the per-section text cache (`book_text`, rebuildable) that search and the
//! vocabulary scan read instead of re-opening the EPUB.
//!
//! The CFI syntax is checked by the app (`core_epub::is_valid_cfi`); this module only bounds sizes and keeps the
//! sync conventions: every write bumps `updated_at`, removals are tombstones.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::library::{EpubAnnotationKind, check_uid, require_book};
use crate::{BookFormat, Result, Store, StoreError, now_ms};

/// Longest CFI accepted, in bytes.
pub const EPUB_CFI_MAX_BYTES: usize = 4096;
/// Longest quoted text or comment of an annotation, in chars.
pub const EPUB_ANNOTATION_TEXT_MAX_CHARS: usize = 20_000;
/// Longest color value (`#rrggbb`, a named swatch), in bytes.
pub const EPUB_COLOR_MAX_BYTES: usize = 32;
/// Longest annotation uid, in bytes.
pub const EPUB_UID_MAX_BYTES: usize = 64;

/// An `epub_annotation` row (non-deleted when read through [`Store::list_epub_annotations`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubAnnotationRow {
    /// Stable key (a UUID from the app).
    pub uid: String,
    pub book_uid: String,
    pub kind: EpubAnnotationKind,
    /// `epubcfi(...)` of the range (highlight, underline, note) or the point (bookmark).
    pub cfi: String,
    /// The quoted text, when there is one.
    pub text: Option<String>,
    pub color: Option<String>,
    pub comment: Option<String>,
    /// Set by the store on write (epoch ms, UTC); ignored on input.
    #[serde(default)]
    pub updated_at: i64,
}

/// A `book_text` row: the plain text of one unit of a book (an EPUB section, 0-based spine order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTextRow {
    pub unit: u32,
    /// The section's label from the table of contents, when it has one.
    pub label: Option<String>,
    pub text: String,
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::InvalidInput(message.into())
}

fn check_annotation(a: &EpubAnnotationRow) -> Result<()> {
    if a.uid.trim().is_empty() || a.uid.len() > EPUB_UID_MAX_BYTES {
        return Err(invalid("identificador de anotação inválido."));
    }
    if a.cfi.trim().is_empty() || a.cfi.len() > EPUB_CFI_MAX_BYTES {
        return Err(invalid("posição (CFI) da anotação inválida."));
    }
    for (what, value) in [("O trecho", &a.text), ("O comentário", &a.comment)] {
        if value
            .as_ref()
            .is_some_and(|v| v.chars().count() > EPUB_ANNOTATION_TEXT_MAX_CHARS)
        {
            return Err(invalid(format!(
                "{what} passa de {EPUB_ANNOTATION_TEXT_MAX_CHARS} caracteres."
            )));
        }
    }
    if a.color
        .as_ref()
        .is_some_and(|c| c.is_empty() || c.len() > EPUB_COLOR_MAX_BYTES)
    {
        return Err(invalid("cor da anotação inválida."));
    }
    Ok(())
}

fn annotation_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EpubAnnotationRow> {
    Ok(EpubAnnotationRow {
        uid: r.get(0)?,
        book_uid: r.get(1)?,
        kind: r.get(2)?,
        cfi: r.get(3)?,
        text: r.get(4)?,
        color: r.get(5)?,
        comment: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

const ANNOTATION_COLUMNS: &str = "uid, book_uid, kind, cfi, text, color, comment, updated_at";

impl Store {
    /// The non-deleted annotations of a book, oldest change first (`updated_at`, then `uid`).
    pub fn list_epub_annotations(&self, book_uid: &str) -> Result<Vec<EpubAnnotationRow>> {
        check_uid(book_uid)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {ANNOTATION_COLUMNS} FROM epub_annotation
             WHERE book_uid = ?1 AND deleted = 0 ORDER BY updated_at, uid"
        ))?;
        let rows = stmt
            .query_map(params![book_uid], annotation_from_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// A non-deleted annotation by uid.
    pub fn get_epub_annotation(&self, uid: &str) -> Result<Option<EpubAnnotationRow>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {ANNOTATION_COLUMNS} FROM epub_annotation WHERE uid = ?1 AND deleted = 0"
                ),
                params![uid],
                annotation_from_row,
            )
            .optional()?)
    }

    /// Inserts or updates an annotation by `uid` (a tombstoned one comes back), with `updated_at` = now. The book
    /// must be a non-deleted EPUB; an existing uid cannot move to another book. Returns the stored row.
    pub fn upsert_epub_annotation(&mut self, a: &EpubAnnotationRow) -> Result<EpubAnnotationRow> {
        check_uid(&a.book_uid)?;
        check_annotation(a)?;
        let tx = self.conn.transaction()?;
        let book = require_book(&tx, &a.book_uid)?;
        if book.format != BookFormat::Epub {
            return Err(invalid(
                "anotações do app são só para livros EPUB (as do PDF ficam no próprio arquivo).",
            ));
        }
        let owner: Option<String> = tx
            .query_row(
                "SELECT book_uid FROM epub_annotation WHERE uid = ?1",
                params![a.uid],
                |r| r.get(0),
            )
            .optional()?;
        if owner.as_deref().is_some_and(|o| o != a.book_uid) {
            return Err(invalid("a anotação pertence a outro livro."));
        }
        // Strictly increasing per row, so a change made in the same millisecond still wins a sync.
        let previous: Option<i64> = tx
            .query_row(
                "SELECT updated_at FROM epub_annotation WHERE uid = ?1",
                params![a.uid],
                |r| r.get(0),
            )
            .optional()?;
        let now = previous.map_or(now_ms(), |p| now_ms().max(p.saturating_add(1)));
        tx.execute(
            "INSERT INTO epub_annotation (uid, book_uid, kind, cfi, text, color, comment, updated_at, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
             ON CONFLICT (uid) DO UPDATE
             SET kind = excluded.kind, cfi = excluded.cfi, text = excluded.text, color = excluded.color,
                 comment = excluded.comment, updated_at = max(excluded.updated_at, updated_at + 1), deleted = 0",
            params![
                a.uid, a.book_uid, a.kind, a.cfi, a.text, a.color, a.comment, now
            ],
        )?;
        tx.commit()?;
        Ok(EpubAnnotationRow {
            updated_at: now,
            ..a.clone()
        })
    }

    /// Tombstones an annotation (`deleted = 1`, `updated_at` bumped). Returns whether a live row was deleted;
    /// unknown or already deleted uids are a no-op.
    pub fn delete_epub_annotation(&mut self, uid: &str) -> Result<bool> {
        let previous: Option<i64> = self
            .conn
            .query_row(
                "SELECT updated_at FROM epub_annotation WHERE uid = ?1 AND deleted = 0",
                params![uid],
                |r| r.get(0),
            )
            .optional()?;
        let Some(previous) = previous else {
            return Ok(false);
        };
        let now = now_ms().max(previous.saturating_add(1));
        let n = self.conn.execute(
            "UPDATE epub_annotation SET deleted = 1, updated_at = max(?2, updated_at + 1) WHERE uid = ?1 AND deleted = 0",
            params![uid, now],
        )?;
        Ok(n > 0)
    }

    /// Replaces the text cache of a book with `rows` (in one transaction).
    pub fn replace_book_text(&mut self, book_uid: &str, rows: &[BookTextRow]) -> Result<()> {
        check_uid(book_uid)?;
        let tx = self.conn.transaction()?;
        if tx
            .query_row(
                "SELECT 1 FROM book WHERE book_uid = ?1",
                params![book_uid],
                |_| Ok(()),
            )
            .optional()?
            .is_none()
        {
            return Err(StoreError::BookNotFound(book_uid.to_owned()));
        }
        tx.execute(
            "DELETE FROM book_text WHERE book_uid = ?1",
            params![book_uid],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO book_text (book_uid, unit, label, text) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (book_uid, unit) DO UPDATE SET label = excluded.label, text = excluded.text",
            )?;
            for r in rows {
                stmt.execute(params![book_uid, r.unit, r.label, r.text])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The text cache of a book, by unit (empty when never stored).
    pub fn book_text(&self, book_uid: &str) -> Result<Vec<BookTextRow>> {
        check_uid(book_uid)?;
        let mut stmt = self
            .conn
            .prepare("SELECT unit, label, text FROM book_text WHERE book_uid = ?1 ORDER BY unit")?;
        let rows = stmt
            .query_map(params![book_uid], |r| {
                Ok(BookTextRow {
                    unit: r.get(0)?,
                    label: r.get(1)?,
                    text: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// The labels of a book's units (no text), by unit.
    pub fn book_text_labels(&self, book_uid: &str) -> Result<Vec<(u32, Option<String>)>> {
        check_uid(book_uid)?;
        let mut stmt = self
            .conn
            .prepare("SELECT unit, label FROM book_text WHERE book_uid = ?1 ORDER BY unit")?;
        let rows = stmt
            .query_map(params![book_uid], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Drops the text cache of a book.
    pub fn clear_book_text(&mut self, book_uid: &str) -> Result<()> {
        check_uid(book_uid)?;
        self.conn.execute(
            "DELETE FROM book_text WHERE book_uid = ?1",
            params![book_uid],
        )?;
        Ok(())
    }
}
