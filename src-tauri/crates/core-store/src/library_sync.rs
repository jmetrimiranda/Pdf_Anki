//! The records the library sync exchanges (spec 16, docs/planos/fase-9a.md): `book`, `reading_position`,
//! `epub_annotation`, `vocab_override`, `notetype_mapping` and `code_note_extra`, each as `{kind, key, updatedAt,
//! deleted, data}` with the table's own `updated_at` (never bumped when a remote record is applied).
//!
//! `library_sync_seen` keeps the version of each record this device last exchanged with the server: what differs from
//! it is outgoing (so a record that came from the server is not sent back), and `library_sync_file` keeps the file
//! hash the server last confirmed for each book (the `base` of the next upload).

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Result, Store, StoreError};

/// The kinds that sync, in the order they are applied (books before what hangs off them).
pub const SYNC_KINDS: [&str; 6] = [
    "book",
    "reading_position",
    "epub_annotation",
    "vocab_override",
    "notetype_mapping",
    "code_note_extra",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    pub kind: String,
    pub key: String,
    pub updated_at: i64,
    pub deleted: bool,
    pub data: Value,
}

/// What [`Store::sync_apply`] did with a remote record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncApplied {
    /// The local row now matches the record.
    Applied,
    /// The local row is newer: it stays and goes to the server next.
    LocalNewer,
    /// The book it belongs to is unknown here (its tombstone was purged): ignored.
    Orphan,
}

/// The file of a book as the server last confirmed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncedFile {
    pub hash: String,
    pub version: u32,
}

fn bad(kind: &str, why: impl std::fmt::Display) -> StoreError {
    StoreError::InvalidInput(format!("registro {kind} inválido: {why}"))
}

fn text(data: &Value, kind: &str, field: &str) -> Result<String> {
    data.get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| bad(kind, format!("falta {field}")))
}

fn opt_text(data: &Value, field: &str) -> Option<String> {
    data.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn int(data: &Value, kind: &str, field: &str) -> Result<i64> {
    data.get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad(kind, format!("falta {field}")))
}

fn json_text(data: &Value, kind: &str, field: &str) -> Result<String> {
    let v = data
        .get(field)
        .ok_or_else(|| bad(kind, format!("falta {field}")))?;
    Ok(v.to_string())
}

/// `(updated_at)` of a local row, `None` when there is none.
fn local_updated_at(
    tx: &Transaction<'_>,
    sql: &str,
    key: &dyn rusqlite::ToSql,
) -> Result<Option<i64>> {
    Ok(tx.query_row(sql, [key], |r| r.get(0)).optional()?)
}

fn book_exists(tx: &Transaction<'_>, uid: &str) -> Result<bool> {
    Ok(tx
        .query_row("SELECT 1 FROM book WHERE book_uid = ?1", [uid], |_| Ok(()))
        .optional()?
        .is_some())
}

fn int_key(kind: &str, key: &str) -> Result<i64> {
    key.parse().map_err(|_| bad(kind, "chave não numérica"))
}

impl Store {
    /// Every syncable row (tombstones included), in [`SYNC_KINDS`] order.
    pub fn sync_records(&self) -> Result<Vec<SyncRecord>> {
        let mut out = Vec::new();
        let c = &self.conn;
        {
            let mut stmt = c.prepare(
                "SELECT book_uid, title, author, language, format, file_name, pages, has_text, content_deck_id,
                        collection_folder, added_at, file_hash, file_version, updated_at, deleted
                 FROM book ORDER BY book_uid",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(SyncRecord {
                    kind: "book".into(),
                    key: r.get(0)?,
                    data: json!({
                        "title": r.get::<_, String>(1)?,
                        "author": r.get::<_, Option<String>>(2)?,
                        "language": r.get::<_, String>(3)?,
                        "format": r.get::<_, String>(4)?,
                        "fileName": r.get::<_, String>(5)?,
                        "pages": r.get::<_, i64>(6)?,
                        "hasText": r.get::<_, bool>(7)?,
                        "contentDeckId": r.get::<_, Option<i64>>(8)?,
                        "collectionFolder": r.get::<_, Option<String>>(9)?,
                        "addedAt": r.get::<_, i64>(10)?,
                        "fileHash": r.get::<_, String>(11)?,
                        "fileVersion": r.get::<_, i64>(12)?,
                    }),
                    updated_at: r.get(13)?,
                    deleted: r.get(14)?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        {
            let mut stmt = c.prepare(
                r#"SELECT book_uid, page, "offset", cfi, progress, updated_at, deleted FROM reading_position
                   ORDER BY book_uid"#,
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(SyncRecord {
                    kind: "reading_position".into(),
                    key: r.get(0)?,
                    data: json!({
                        "page": r.get::<_, i64>(1)?,
                        "offset": r.get::<_, f64>(2)?,
                        "cfi": r.get::<_, Option<String>>(3)?,
                        "progress": r.get::<_, f64>(4)?,
                    }),
                    updated_at: r.get(5)?,
                    deleted: r.get(6)?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        {
            let mut stmt = c.prepare(
                "SELECT uid, book_uid, kind, cfi, text, color, comment, updated_at, deleted FROM epub_annotation
                 ORDER BY uid",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(SyncRecord {
                    kind: "epub_annotation".into(),
                    key: r.get(0)?,
                    data: json!({
                        "bookUid": r.get::<_, String>(1)?,
                        "kind": r.get::<_, String>(2)?,
                        "cfi": r.get::<_, String>(3)?,
                        "text": r.get::<_, Option<String>>(4)?,
                        "color": r.get::<_, Option<String>>(5)?,
                        "comment": r.get::<_, Option<String>>(6)?,
                    }),
                    updated_at: r.get(7)?,
                    deleted: r.get(8)?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        {
            let mut stmt = c.prepare(
                "SELECT lemma, status, updated_at, deleted FROM vocab_override ORDER BY lemma",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(SyncRecord {
                    kind: "vocab_override".into(),
                    key: r.get(0)?,
                    data: json!({ "status": r.get::<_, String>(1)? }),
                    updated_at: r.get(2)?,
                    deleted: r.get(3)?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        {
            let mut stmt = c.prepare(
                "SELECT anki_notetype_id, role, fields, updated_at, deleted FROM notetype_mapping
                 ORDER BY anki_notetype_id",
            )?;
            let rows = stmt.query_map([], |r| {
                let fields: String = r.get(2)?;
                Ok(SyncRecord {
                    kind: "notetype_mapping".into(),
                    key: r.get::<_, i64>(0)?.to_string(),
                    data: json!({
                        "role": r.get::<_, String>(1)?,
                        "fields": serde_json::from_str::<Value>(&fields).unwrap_or(Value::Null),
                    }),
                    updated_at: r.get(3)?,
                    deleted: r.get(4)?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        {
            let mut stmt = c.prepare(
                "SELECT note_id, accepted, requires, updated_at, deleted FROM code_note_extra ORDER BY note_id",
            )?;
            let rows = stmt.query_map([], |r| {
                let accepted: String = r.get(1)?;
                let requires: String = r.get(2)?;
                Ok(SyncRecord {
                    kind: "code_note_extra".into(),
                    key: r.get::<_, i64>(0)?.to_string(),
                    data: json!({
                        "accepted": serde_json::from_str::<Value>(&accepted).unwrap_or(json!([])),
                        "requires": serde_json::from_str::<Value>(&requires).unwrap_or(json!([])),
                    }),
                    updated_at: r.get(3)?,
                    deleted: r.get(4)?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        Ok(out)
    }

    /// The records that changed since they were last exchanged with the server.
    pub fn sync_outgoing(&self) -> Result<Vec<SyncRecord>> {
        let seen: std::collections::HashMap<(String, String), i64> = {
            let mut stmt = self
                .conn
                .prepare("SELECT kind, key, updated_at FROM library_sync_seen")?;
            stmt.query_map([], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        Ok(self
            .sync_records()?
            .into_iter()
            .filter(|r| seen.get(&(r.kind.clone(), r.key.clone())) != Some(&r.updated_at))
            .collect())
    }

    /// Records that `(kind, key)` was exchanged at `updated_at`.
    pub fn sync_mark_seen(&self, kind: &str, key: &str, updated_at: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO library_sync_seen (kind, key, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (kind, key) DO UPDATE SET updated_at = excluded.updated_at",
            params![kind, key, updated_at],
        )?;
        Ok(())
    }

    /// Forgets every exchanged version (a new server or account: the next sync starts over as a first sync).
    pub fn sync_forget(&self) -> Result<()> {
        self.conn.execute_batch(
            "DELETE FROM library_sync_seen; DELETE FROM library_sync_file;
             DELETE FROM sync_state WHERE key LIKE 'library.%';",
        )?;
        Ok(())
    }

    /// Forgets what was exchanged (seen versions, confirmed files) but not the account: after a new or restored
    /// server database, everything is compared and sent again with the normal rules.
    pub fn sync_forget_exchanged(&self) -> Result<()> {
        self.conn
            .execute_batch("DELETE FROM library_sync_seen; DELETE FROM library_sync_file;")?;
        Ok(())
    }

    pub fn sync_state_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn sync_state_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn sync_file(&self, book_uid: &str) -> Result<Option<SyncedFile>> {
        Ok(self
            .conn
            .query_row(
                "SELECT hash, version FROM library_sync_file WHERE book_uid = ?1",
                [book_uid],
                |r| {
                    Ok(SyncedFile {
                        hash: r.get(0)?,
                        version: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn sync_set_file(&self, book_uid: &str, f: &SyncedFile) -> Result<()> {
        self.conn.execute(
            "INSERT INTO library_sync_file (book_uid, hash, version) VALUES (?1, ?2, ?3)
             ON CONFLICT (book_uid) DO UPDATE SET hash = excluded.hash, version = excluded.version",
            params![book_uid, f.hash, f.version],
        )?;
        Ok(())
    }

    /// Makes the server's file (`hash`, `version`) the book's current one, only while the book is still at
    /// `expected` (a save made meanwhile wins and goes up on the next run). `updated_at` is untouched; the local
    /// version number only grows (an open tab's next save is then seen as stale). Returns whether it changed.
    pub fn sync_adopt_file(
        &self,
        book_uid: &str,
        expected: &str,
        hash: &str,
        version: u32,
    ) -> Result<bool> {
        crate::library::check_uid(book_uid)?;
        Ok(self.conn.execute(
            "UPDATE book SET file_hash = ?3, file_version = max(file_version + 1, ?4)
             WHERE book_uid = ?1 AND file_hash = ?2 AND file_hash <> ?3",
            params![book_uid, expected, hash, version],
        )? == 1)
    }

    /// Applies a record from the server. The newer `updated_at` wins; a tie goes to the server (its version arrived
    /// there last). `server_wins` (the first sync of this device) applies it whatever the clocks say. The record is
    /// marked as seen at its own `updated_at` either way, so a newer local row is still sent afterwards.
    pub fn sync_apply(&mut self, rec: &SyncRecord, server_wins: bool) -> Result<SyncApplied> {
        let tx = self.conn.transaction()?;
        let kind = rec.kind.as_str();
        let d = &rec.data;
        let local = match kind {
            "book" => local_updated_at(
                &tx,
                "SELECT updated_at FROM book WHERE book_uid = ?1",
                &rec.key,
            )?,
            "reading_position" => local_updated_at(
                &tx,
                "SELECT updated_at FROM reading_position WHERE book_uid = ?1",
                &rec.key,
            )?,
            "epub_annotation" => local_updated_at(
                &tx,
                "SELECT updated_at FROM epub_annotation WHERE uid = ?1",
                &rec.key,
            )?,
            "vocab_override" => local_updated_at(
                &tx,
                "SELECT updated_at FROM vocab_override WHERE lemma = ?1",
                &rec.key,
            )?,
            "notetype_mapping" => local_updated_at(
                &tx,
                "SELECT updated_at FROM notetype_mapping WHERE anki_notetype_id = ?1",
                &int_key(kind, &rec.key)?,
            )?,
            "code_note_extra" => local_updated_at(
                &tx,
                "SELECT updated_at FROM code_note_extra WHERE note_id = ?1",
                &int_key(kind, &rec.key)?,
            )?,
            other => return Err(bad(other, "tipo desconhecido")),
        };
        let mark = |tx: &Transaction<'_>| -> Result<()> {
            tx.execute(
                "INSERT INTO library_sync_seen (kind, key, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (kind, key) DO UPDATE SET updated_at = excluded.updated_at",
                params![kind, rec.key, rec.updated_at],
            )?;
            Ok(())
        };
        // The first sync takes the server's version, but only for keys this device never exchanged (a first sync
        // that failed halfway doesn't revert edits made since).
        let seen: bool = tx
            .query_row(
                "SELECT 1 FROM library_sync_seen WHERE kind = ?1 AND key = ?2",
                params![kind, rec.key],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let force = server_wins && !seen;
        if !force && local.is_some_and(|l| l > rec.updated_at) {
            mark(&tx)?;
            tx.commit()?;
            return Ok(SyncApplied::LocalNewer);
        }
        let (at, del) = (rec.updated_at, rec.deleted);
        match kind {
            "book" => {
                crate::library::check_uid(&rec.key)?;
                let was_deleted: Option<bool> = tx
                    .query_row(
                        "SELECT deleted FROM book WHERE book_uid = ?1",
                        [&rec.key],
                        |r| r.get(0),
                    )
                    .optional()?;
                // The file (hash, version) is NOT taken from the record for a book this device knows: a metadata
                // change from a device with an old copy would point it back at an old file. It comes from the
                // server's list of files (`sync_adopt_file`); a new book starts at the record's file.
                tx.execute(
                    "INSERT INTO book (book_uid, title, author, language, format, file_name, pages, has_text,
                        content_deck_id, collection_folder, added_at, file_hash, file_version, updated_at, deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                     ON CONFLICT (book_uid) DO UPDATE SET title = excluded.title, author = excluded.author,
                        language = excluded.language, format = excluded.format, file_name = excluded.file_name,
                        pages = excluded.pages, has_text = excluded.has_text,
                        content_deck_id = excluded.content_deck_id, collection_folder = excluded.collection_folder,
                        added_at = excluded.added_at, updated_at = excluded.updated_at, deleted = excluded.deleted",
                    params![
                        rec.key,
                        text(d, kind, "title")?,
                        opt_text(d, "author"),
                        opt_text(d, "language").unwrap_or_else(|| "en".into()),
                        text(d, kind, "format")?,
                        text(d, kind, "fileName")?,
                        int(d, kind, "pages")?,
                        d.get("hasText").and_then(Value::as_bool).unwrap_or(true),
                        d.get("contentDeckId").and_then(Value::as_i64),
                        opt_text(d, "collectionFolder"),
                        int(d, kind, "addedAt")?,
                        text(d, kind, "fileHash")?,
                        int(d, kind, "fileVersion")?,
                        at,
                        del,
                    ],
                )?;
                // A book new on this device has no file yet ("Baixar").
                tx.execute(
                    "INSERT OR IGNORE INTO book_file (book_uid, local_path, downloaded) VALUES (?1, NULL, 0)",
                    [&rec.key],
                )?;
                // Back from a local tombstone: the files it pointed at were removed with it.
                if was_deleted == Some(true) && !del {
                    tx.execute(
                        "UPDATE book_file SET local_path = NULL, local_hash = NULL, downloaded = 0 WHERE book_uid = ?1",
                        [&rec.key],
                    )?;
                }
                if del {
                    tx.execute(
                        "DELETE FROM library_sync_file WHERE book_uid = ?1",
                        [&rec.key],
                    )?;
                }
            }
            "reading_position" => {
                if !book_exists(&tx, &rec.key)? {
                    mark(&tx)?;
                    tx.commit()?;
                    return Ok(SyncApplied::Orphan);
                }
                tx.execute(
                    r#"INSERT INTO reading_position (book_uid, page, "offset", cfi, progress, updated_at, deleted)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                       ON CONFLICT (book_uid) DO UPDATE SET page = excluded.page, "offset" = excluded."offset",
                          cfi = excluded.cfi, progress = excluded.progress, updated_at = excluded.updated_at,
                          deleted = excluded.deleted"#,
                    params![
                        rec.key,
                        int(d, kind, "page")?.max(0),
                        d.get("offset").and_then(Value::as_f64).unwrap_or(0.0),
                        opt_text(d, "cfi"),
                        d.get("progress").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 1.0),
                        at,
                        del,
                    ],
                )?;
            }
            "epub_annotation" => {
                let book = text(d, kind, "bookUid")?;
                if !book_exists(&tx, &book)? {
                    mark(&tx)?;
                    tx.commit()?;
                    return Ok(SyncApplied::Orphan);
                }
                tx.execute(
                    "INSERT INTO epub_annotation (uid, book_uid, kind, cfi, text, color, comment, updated_at, deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT (uid) DO UPDATE SET book_uid = excluded.book_uid, kind = excluded.kind,
                        cfi = excluded.cfi, text = excluded.text, color = excluded.color,
                        comment = excluded.comment, updated_at = excluded.updated_at, deleted = excluded.deleted",
                    params![
                        rec.key,
                        book,
                        text(d, kind, "kind")?,
                        text(d, kind, "cfi")?,
                        opt_text(d, "text"),
                        opt_text(d, "color"),
                        opt_text(d, "comment"),
                        at,
                        del,
                    ],
                )?;
            }
            "vocab_override" => {
                tx.execute(
                    "INSERT INTO vocab_override (lemma, status, updated_at, deleted) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (lemma) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
                        deleted = excluded.deleted",
                    params![rec.key, text(d, kind, "status")?, at, del],
                )?;
            }
            "notetype_mapping" => {
                tx.execute(
                    "INSERT INTO notetype_mapping (anki_notetype_id, role, fields, updated_at, deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (anki_notetype_id) DO UPDATE SET role = excluded.role, fields = excluded.fields,
                        updated_at = excluded.updated_at, deleted = excluded.deleted",
                    params![int_key(kind, &rec.key)?, text(d, kind, "role")?, json_text(d, kind, "fields")?, at, del],
                )?;
            }
            "code_note_extra" => {
                tx.execute(
                    "INSERT INTO code_note_extra (note_id, accepted, requires, updated_at, deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (note_id) DO UPDATE SET accepted = excluded.accepted, requires = excluded.requires,
                        updated_at = excluded.updated_at, deleted = excluded.deleted",
                    params![
                        int_key(kind, &rec.key)?,
                        json_text(d, kind, "accepted")?,
                        json_text(d, kind, "requires")?,
                        at,
                        del
                    ],
                )?;
            }
            _ => unreachable!("checked above"),
        }
        mark(&tx)?;
        tx.commit()?;
        Ok(SyncApplied::Applied)
    }
}
