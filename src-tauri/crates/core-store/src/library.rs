//! Library (section 6.6), file versions (section 6.5) and reading positions. A book's identity is
//! `book_uid`, the lowercase hex sha256 of the original file, shared with library-sync, the Painel
//! and `leitor://` links. It never changes: annotations saved by PdfCraft produce new *versions*
//! of the file, each with its own `file_hash` and an increasing `file_version`.

use std::io::Read;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::{Result, Store, StoreError, now_ms};

/// `book_uid` of a file's bytes: lowercase hex sha256.
pub fn book_uid_of(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Streaming variant of [`book_uid_of`] for large files.
pub fn book_uid_of_reader(mut reader: impl Read) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn is_valid_book_uid(uid: &str) -> bool {
    uid.len() == 64 && uid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_hash(hash: &str) -> Result<()> {
    if is_valid_book_uid(hash) {
        Ok(())
    } else {
        Err(StoreError::InvalidInput(format!(
            "hash de arquivo inválido: {hash:?} (esperado sha256 em hexadecimal minúsculo)."
        )))
    }
}

pub(crate) fn check_uid(uid: &str) -> Result<()> {
    if is_valid_book_uid(uid) {
        Ok(())
    } else {
        Err(StoreError::InvalidBookUid(uid.to_owned()))
    }
}

/// Enums stored as their lowercase serde name in a `CHECK`ed TEXT column.
macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }

        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }

        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                match value.as_str()? {
                    $($text => Ok(Self::$variant),)+
                    other => Err(FromSqlError::Other(
                        format!(concat!("unknown ", stringify!($name), " {:?}"), other).into(),
                    )),
                }
            }
        }
    };
}

text_enum!(BookFormat { Pdf => "pdf", Epub => "epub" });
text_enum!(OcrStatus { None => "none", Running => "running", Done => "done", Failed => "failed" });
text_enum!(
    /// Kind of an EPUB annotation (`epub_annotation.kind`, spec 7.1).
    EpubAnnotationKind { Highlight => "highlight", Underline => "underline", Note => "note", Bookmark => "bookmark" }
);

/// A book as listed in the library (non-deleted), joined with this device's file info.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub book_uid: String,
    pub title: String,
    pub author: Option<String>,
    pub language: String,
    pub format: BookFormat,
    pub file_name: String,
    pub pages: u32,
    pub has_text: bool,
    pub ocr_status: OcrStatus,
    /// sha256 of the current version of the file (equal to `book_uid` until a version is saved).
    pub file_hash: String,
    /// 1, 2, 3… one more for every saved version.
    pub file_version: u32,
    pub content_deck_id: Option<i64>,
    pub collection_folder: Option<String>,
    /// Epoch ms, UTC.
    pub added_at: i64,
    /// Epoch ms, UTC.
    pub updated_at: i64,
    /// Where the file is on this device (not synced).
    pub local_path: Option<String>,
    /// sha256 of the file at `local_path` (not synced). Differs from `file_hash` when this device
    /// holds another version than the current one.
    pub local_hash: Option<String>,
    pub downloaded: bool,
}

/// Metadata gathered when importing a file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBook {
    pub book_uid: String,
    pub title: String,
    pub author: Option<String>,
    /// Defaults to `en`.
    pub language: Option<String>,
    pub format: BookFormat,
    pub file_name: String,
    pub pages: u32,
    pub has_text: bool,
    /// sha256 of the imported file. Normally equal to `book_uid`; differs when the file is a
    /// later version of a book (it carries `LeitorBookUid`, spec 6.5).
    pub file_hash: String,
    /// The copy in the app folder, if the file is on this device (its hash is `file_hash`).
    pub local_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AddOutcome {
    /// A new row was created.
    Created,
    /// The book was already in the library; its metadata was kept.
    Existing,
    /// The book had been removed and is back (metadata refreshed from the import).
    Restored,
}

/// A library row: the book and where the reader stopped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    #[serde(flatten)]
    pub book: Book,
    pub position: Option<ReadingPosition>,
    /// The book has a finished vocabulary scan (the library menu offers "Relatório de vocabulário").
    #[serde(default)]
    pub vocab_scanned: bool,
}

/// The result of [`Store::record_file_version`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub file_hash: String,
    pub file_version: u32,
    /// `false` when the hash was already the current version (nothing was written).
    pub changed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedBook {
    pub book: Book,
    pub outcome: AddOutcome,
}

/// Partial update. A missing field is left alone; for nullable fields, an explicit `null` clears.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookPatch {
    pub title: Option<String>,
    #[serde(deserialize_with = "double_option")]
    pub author: Option<Option<String>>,
    pub language: Option<String>,
    #[serde(deserialize_with = "double_option")]
    pub content_deck_id: Option<Option<i64>>,
    #[serde(deserialize_with = "double_option")]
    pub collection_folder: Option<Option<String>>,
    pub pages: Option<u32>,
    pub has_text: Option<bool>,
    pub ocr_status: Option<OcrStatus>,
}

pub(crate) fn double_option<'de, T, D>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Where the reader was in a book. `page` is 0-based; `offset` is the scroll offset within the
/// page; `cfi` is for EPUB; `progress` is 0..=1.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub page: u32,
    pub offset: f64,
    pub cfi: Option<String>,
    pub progress: f64,
    /// Set by the store on write (epoch ms, UTC); ignored on input.
    #[serde(default)]
    pub updated_at: i64,
}

fn non_empty(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(StoreError::InvalidInput(format!(
            "{field} não pode ficar vazio."
        )))
    } else {
        Ok(())
    }
}

const BOOK_COLUMNS: &str = "b.book_uid, b.title, b.author, b.language, b.format, b.file_name, \
     b.pages, b.has_text, b.ocr_status, b.file_hash, b.file_version, b.content_deck_id, \
     b.collection_folder, b.added_at, b.updated_at, f.local_path, f.local_hash, f.downloaded";

const BOOK_COLUMN_COUNT: usize = 18;

fn book_from_row(r: &Row<'_>) -> rusqlite::Result<Book> {
    Ok(Book {
        book_uid: r.get(0)?,
        title: r.get(1)?,
        author: r.get(2)?,
        language: r.get(3)?,
        format: r.get(4)?,
        file_name: r.get(5)?,
        pages: r.get(6)?,
        has_text: r.get(7)?,
        ocr_status: r.get(8)?,
        file_hash: r.get(9)?,
        file_version: r.get(10)?,
        content_deck_id: r.get(11)?,
        collection_folder: r.get(12)?,
        added_at: r.get(13)?,
        updated_at: r.get(14)?,
        local_path: r.get(15)?,
        local_hash: r.get(16)?,
        downloaded: r.get::<_, Option<bool>>(17)?.unwrap_or(false),
    })
}

fn fetch_book(tx: &rusqlite::Connection, uid: &str) -> Result<Option<Book>> {
    Ok(tx
        .query_row(
            &format!(
                "SELECT {BOOK_COLUMNS} FROM book b LEFT JOIN book_file f USING (book_uid)
                 WHERE b.book_uid = ?1 AND b.deleted = 0"
            ),
            params![uid],
            book_from_row,
        )
        .optional()?)
}

pub(crate) fn require_book(tx: &rusqlite::Connection, uid: &str) -> Result<Book> {
    fetch_book(tx, uid)?.ok_or_else(|| StoreError::BookNotFound(uid.to_owned()))
}

/// `Some(deleted)` if the row exists, tombstoned or not.
fn book_state(tx: &Transaction<'_>, uid: &str) -> Result<Option<bool>> {
    Ok(tx
        .query_row(
            "SELECT deleted FROM book WHERE book_uid = ?1",
            params![uid],
            |r| r.get(0),
        )
        .optional()?)
}

impl Store {
    /// Adds a book, keyed by `book_uid`. Re-adding the same book is idempotent (its metadata
    /// and current version are kept); re-adding a removed book restores it with the imported
    /// metadata. The imported file becomes this device's copy unless the device already has one.
    pub fn add_book(&mut self, new: &NewBook) -> Result<AddedBook> {
        check_uid(&new.book_uid)?;
        check_hash(&new.file_hash)?;
        non_empty("O título", &new.title)?;
        non_empty("O nome do arquivo", &new.file_name)?;
        if let Some(path) = &new.local_path {
            non_empty("O caminho do arquivo", path)?;
        }
        let language = new.language.as_deref().unwrap_or("en");
        non_empty("O idioma", language)?;
        let now = now_ms();

        let tx = self.conn.transaction()?;
        let outcome = match book_state(&tx, &new.book_uid)? {
            None => {
                tx.execute(
                    "INSERT INTO book (book_uid, title, author, language, format, file_name, pages,
                                       has_text, file_hash, file_version, added_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)",
                    params![
                        new.book_uid,
                        new.title,
                        new.author,
                        language,
                        new.format,
                        new.file_name,
                        new.pages,
                        new.has_text,
                        new.file_hash,
                        now
                    ],
                )?;
                AddOutcome::Created
            }
            Some(true) => {
                tx.execute(
                    "UPDATE book SET title = ?2, author = ?3, language = ?4, format = ?5,
                                     file_name = ?6, pages = ?7, has_text = ?8,
                                     ocr_status = 'none',
                                     file_version = file_version + (file_hash <> ?9),
                                     file_hash = ?9, updated_at = max(?10, updated_at + 1), deleted = 0
                     WHERE book_uid = ?1",
                    params![
                        new.book_uid,
                        new.title,
                        new.author,
                        language,
                        new.format,
                        new.file_name,
                        new.pages,
                        new.has_text,
                        new.file_hash,
                        now
                    ],
                )?;
                AddOutcome::Restored
            }
            Some(false) => AddOutcome::Existing,
        };
        let keep_existing_file = outcome == AddOutcome::Existing;
        upsert_book_file(
            &tx,
            &new.book_uid,
            new.local_path.as_deref(),
            &new.file_hash,
            keep_existing_file,
        )?;
        let book = require_book(&tx, &new.book_uid)?;
        tx.commit()?;
        Ok(AddedBook { book, outcome })
    }

    /// The library: non-deleted books with their reading position, most recently read or added
    /// first (the later of the position's `updated_at` and the book's `added_at`).
    pub fn list_library(&self) -> Result<Vec<LibraryEntry>> {
        let mut stmt = self.conn.prepare(&format!(
            r#"SELECT {BOOK_COLUMNS}, p.page, p."offset", p.cfi, p.progress, p.updated_at,
                      EXISTS (SELECT 1 FROM vocab_scan v WHERE v.book_uid = b.book_uid AND v.status = 'done')
               FROM book b
               LEFT JOIN book_file f USING (book_uid)
               LEFT JOIN reading_position p ON p.book_uid = b.book_uid AND p.deleted = 0
               WHERE b.deleted = 0
               ORDER BY max(b.added_at, coalesce(p.updated_at, 0)) DESC, b.title"#
        ))?;
        let entries = stmt
            .query_map([], |r| {
                let book = book_from_row(r)?;
                let n = BOOK_COLUMN_COUNT;
                let position = match r.get::<_, Option<u32>>(n)? {
                    None => None,
                    Some(page) => Some(ReadingPosition {
                        page,
                        offset: r.get(n + 1)?,
                        cfi: r.get(n + 2)?,
                        progress: r.get(n + 3)?,
                        updated_at: r.get(n + 4)?,
                    }),
                };
                Ok(LibraryEntry {
                    book,
                    position,
                    vocab_scanned: r.get(n + 5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(entries)
    }

    /// Records a new saved version of a book's file (spec 6.5): the bytes with sha256
    /// `file_hash`, already written at `local_path`. If `file_hash` is the current version, nothing
    /// changes. Otherwise, in one transaction, the book's `file_hash` is replaced, `file_version`
    /// goes up by one, `updated_at` is bumped and this device's file points at `local_path`.
    pub fn record_file_version(
        &mut self,
        book_uid: &str,
        file_hash: &str,
        local_path: &str,
    ) -> Result<FileVersion> {
        check_uid(book_uid)?;
        check_hash(file_hash)?;
        non_empty("O caminho do arquivo", local_path)?;
        let tx = self.conn.transaction()?;
        let book = require_book(&tx, book_uid)?;
        if book.file_hash == file_hash {
            return Ok(FileVersion {
                file_hash: book.file_hash,
                file_version: book.file_version,
                changed: false,
            });
        }
        let file_version = book.file_version.saturating_add(1);
        tx.execute(
            "UPDATE book SET file_hash = ?2, file_version = ?3, updated_at = max(?4, updated_at + 1) WHERE book_uid = ?1",
            params![book_uid, file_hash, file_version, now_ms()],
        )?;
        upsert_book_file(&tx, book_uid, Some(local_path), file_hash, false)?;
        tx.commit()?;
        Ok(FileVersion {
            file_hash: file_hash.to_owned(),
            file_version,
            changed: true,
        })
    }

    /// Non-deleted books, most recently added first.
    pub fn list_books(&self) -> Result<Vec<Book>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {BOOK_COLUMNS} FROM book b LEFT JOIN book_file f USING (book_uid)
             WHERE b.deleted = 0 ORDER BY b.added_at DESC, b.title"
        ))?;
        let books = stmt
            .query_map([], book_from_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(books)
    }

    /// A non-deleted book, or `None`.
    pub fn get_book(&self, book_uid: &str) -> Result<Option<Book>> {
        check_uid(book_uid)?;
        fetch_book(&self.conn, book_uid)
    }

    pub fn update_book(&mut self, book_uid: &str, patch: &BookPatch) -> Result<Book> {
        check_uid(book_uid)?;
        let tx = self.conn.transaction()?;
        let mut b = require_book(&tx, book_uid)?;
        if let Some(title) = &patch.title {
            non_empty("O título", title)?;
            b.title = title.clone();
        }
        if let Some(language) = &patch.language {
            non_empty("O idioma", language)?;
            b.language = language.clone();
        }
        if let Some(author) = &patch.author {
            b.author = author.clone();
        }
        if let Some(deck) = patch.content_deck_id {
            b.content_deck_id = deck;
        }
        if let Some(folder) = &patch.collection_folder {
            b.collection_folder = folder.clone();
        }
        if let Some(pages) = patch.pages {
            b.pages = pages;
        }
        if let Some(has_text) = patch.has_text {
            b.has_text = has_text;
        }
        if let Some(status) = patch.ocr_status {
            b.ocr_status = status;
        }
        tx.execute(
            "UPDATE book SET title = ?2, author = ?3, language = ?4,
                             content_deck_id = ?5, collection_folder = ?6, pages = ?7,
                             has_text = ?8, ocr_status = ?9, updated_at = max(?10, updated_at + 1)
             WHERE book_uid = ?1",
            params![
                book_uid,
                b.title,
                b.author,
                b.language,
                b.content_deck_id,
                b.collection_folder,
                b.pages,
                b.has_text,
                b.ocr_status,
                now_ms()
            ],
        )?;
        let book = require_book(&tx, book_uid)?;
        tx.commit()?;
        Ok(book)
    }

    /// Soft-deletes a book, tombstones its EPUB annotations and reading position (section 16) and deletes its
    /// device-local preferences. Removing an already removed book is a no-op. The local file is left to the caller.
    pub fn remove_book(&mut self, book_uid: &str) -> Result<()> {
        check_uid(book_uid)?;
        let tx = self.conn.transaction()?;
        match book_state(&tx, book_uid)? {
            None => return Err(StoreError::BookNotFound(book_uid.to_owned())),
            Some(true) => return Ok(()),
            Some(false) => {}
        }
        let now = now_ms();
        for sql in [
            "UPDATE book SET deleted = 1, updated_at = max(?2, updated_at + 1) WHERE book_uid = ?1",
            "UPDATE epub_annotation SET deleted = 1, updated_at = max(?2, updated_at + 1)
             WHERE book_uid = ?1 AND deleted = 0",
            "UPDATE reading_position SET deleted = 1, updated_at = max(?2, updated_at + 1)
             WHERE book_uid = ?1 AND deleted = 0",
        ] {
            tx.execute(sql, params![book_uid, now])?;
        }
        // Device-local, no tombstone needed.
        tx.execute(
            "DELETE FROM book_prefs WHERE book_uid = ?1",
            params![book_uid],
        )?;
        // The file the library server confirmed is forgotten: a re-added book is sent again if needed.
        tx.execute(
            "DELETE FROM library_sync_file WHERE book_uid = ?1",
            params![book_uid],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Records where this device keeps the book's file and the sha256 of that file (or that it
    /// has none: `local_path = None` clears both).
    pub fn set_book_file(
        &mut self,
        book_uid: &str,
        local_path: Option<&str>,
        local_hash: Option<&str>,
    ) -> Result<()> {
        check_uid(book_uid)?;
        if let Some(hash) = local_hash {
            check_hash(hash)?;
        }
        let local_hash = local_path.and(local_hash);
        let tx = self.conn.transaction()?;
        if book_state(&tx, book_uid)?.is_none() {
            return Err(StoreError::BookNotFound(book_uid.to_owned()));
        }
        tx.execute(
            "INSERT INTO book_file (book_uid, local_path, local_hash, downloaded)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (book_uid) DO UPDATE
             SET local_path = excluded.local_path, local_hash = excluded.local_hash,
                 downloaded = excluded.downloaded",
            params![book_uid, local_path, local_hash, local_path.is_some()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_reading_position(&self, book_uid: &str) -> Result<Option<ReadingPosition>> {
        check_uid(book_uid)?;
        Ok(self
            .conn
            .query_row(
                r#"SELECT page, "offset", cfi, progress, updated_at FROM reading_position
                   WHERE book_uid = ?1 AND deleted = 0"#,
                params![book_uid],
                |r| {
                    Ok(ReadingPosition {
                        page: r.get(0)?,
                        offset: r.get(1)?,
                        cfi: r.get(2)?,
                        progress: r.get(3)?,
                        updated_at: r.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    /// Saves the position of a non-deleted book; returns it with the stored `updated_at`.
    pub fn set_reading_position(
        &mut self,
        book_uid: &str,
        pos: &ReadingPosition,
    ) -> Result<ReadingPosition> {
        check_uid(book_uid)?;
        if !pos.offset.is_finite() {
            return Err(StoreError::InvalidInput(
                "o deslocamento na página não é um número válido.".into(),
            ));
        }
        if !(0.0..=1.0).contains(&pos.progress) {
            return Err(StoreError::InvalidInput(
                "o progresso deve estar entre 0 e 1.".into(),
            ));
        }
        let tx = self.conn.transaction()?;
        require_book(&tx, book_uid)?;
        let now = now_ms();
        tx.execute(
            r#"INSERT INTO reading_position (book_uid, page, "offset", cfi, progress, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT (book_uid) DO UPDATE
               SET page = excluded.page, "offset" = excluded."offset", cfi = excluded.cfi,
                   progress = excluded.progress, updated_at = max(excluded.updated_at, updated_at + 1), deleted = 0"#,
            params![book_uid, pos.page, pos.offset, pos.cfi, pos.progress, now],
        )?;
        // Never before the version it replaces (a synced one may carry another device's later clock).
        let updated_at: i64 = tx.query_row(
            "SELECT updated_at FROM reading_position WHERE book_uid = ?1",
            params![book_uid],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(ReadingPosition {
            updated_at,
            ..pos.clone()
        })
    }
}

/// Points this device's file at `local_path` (hash `local_hash`). With `keep_existing`, a file the
/// device already has wins. Without a path, only makes sure the row exists.
fn upsert_book_file(
    tx: &Transaction<'_>,
    uid: &str,
    local_path: Option<&str>,
    local_hash: &str,
    keep_existing: bool,
) -> Result<()> {
    match local_path {
        Some(path) if keep_existing => tx.execute(
            "INSERT INTO book_file (book_uid, local_path, local_hash, downloaded)
             VALUES (?1, ?2, ?3, 1)
             ON CONFLICT (book_uid) DO UPDATE
             SET local_path = excluded.local_path, local_hash = excluded.local_hash, downloaded = 1
             WHERE book_file.local_path IS NULL",
            params![uid, path, local_hash],
        )?,
        Some(path) => tx.execute(
            "INSERT INTO book_file (book_uid, local_path, local_hash, downloaded)
             VALUES (?1, ?2, ?3, 1)
             ON CONFLICT (book_uid) DO UPDATE
             SET local_path = excluded.local_path, local_hash = excluded.local_hash, downloaded = 1",
            params![uid, path, local_hash],
        )?,
        None => tx.execute(
            "INSERT OR IGNORE INTO book_file (book_uid, local_path, downloaded) VALUES (?1, NULL, 0)",
            params![uid],
        )?,
    };
    Ok(())
}
