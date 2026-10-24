//! Library and book files (spec 6.5, 6.6, 7.1): import (PDF here, EPUB in [`crate::epub`]), versions saved by
//! PdfCraft, export, covers and the words of a page. Plain [`AppState`] methods; the commands only move them off the runtime.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use core_pdf::{DocHandle, LEITOR_BOOK_UID_KEY, PageWords, PdfError, PdfMeta};
use core_store::{
    Book, BookFormat, BookPatch, LibraryEntry, NewBook, ReadingPosition, book_uid_of,
};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::files;
use crate::state::AppState;

/// Longest side of the library cover, in pixels (a grid card at 2x is about 2 × 220 px).
pub const COVER_PX: u32 = 600;
/// Pages sampled for "parece escaneado" at import.
const TEXT_SAMPLE_PAGES: usize = 40;
/// Largest file accepted from PdfCraft or from disk.
pub const MAX_PDF_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AddOutcome {
    /// A new book.
    Created,
    /// Already in the library; nothing changed.
    Existing,
    /// A removed book is back.
    Restored,
    /// The file carries the `LeitorBookUid` of a library book and became its current version.
    NewVersion,
    /// The file carries the `LeitorBookUid` of a library book but differs from its current
    /// version. Nothing changed: the UI asks before calling again with `replace`, because the file
    /// may be an older copy than the current version.
    OtherVersion,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedBook {
    pub book: LibraryEntry,
    pub outcome: AddOutcome,
}

/// `book_open`: the book and where to open it: the 0-based page (PDF) or section (EPUB), and for EPUB the last
/// CFI position.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookOpen {
    pub book: LibraryEntry,
    pub page: u32,
    pub format: BookFormat,
    pub cfi: Option<String>,
}

/// `book_save_version`: `changed` is false when the bytes were already the current version.
/// `kept_newer` is true when the save was based on an older version than the current one (a
/// version imported while the book was open in PdfCraft): that current version was kept as a
/// `replaced-` copy instead of being pruned later.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVersion {
    pub file_hash: String,
    pub file_version: u32,
    pub changed: bool,
    pub kept_newer: bool,
}

/// What `library_update` accepts from the UI (a subset of `core_store::BookPatch`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct LibraryPatch {
    pub title: Option<String>,
    #[serde(deserialize_with = "double_option")]
    pub author: Option<Option<String>>,
    pub language: Option<String>,
    #[serde(deserialize_with = "double_option")]
    pub collection_folder: Option<Option<String>>,
    pub pages: Option<u32>,
    #[serde(deserialize_with = "double_option")]
    pub content_deck_id: Option<Option<i64>>,
}

fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

impl From<LibraryPatch> for BookPatch {
    fn from(p: LibraryPatch) -> Self {
        BookPatch {
            title: p.title,
            author: p.author,
            language: p.language,
            collection_folder: p.collection_folder,
            pages: p.pages,
            content_deck_id: p.content_deck_id,
            ..BookPatch::default()
        }
    }
}

/// What a file is, read before anything is copied.
struct Imported {
    sha: String,
    bytes: Arc<Vec<u8>>,
    file_name: String,
    title: String,
    author: Option<String>,
    pages: u32,
    has_text: bool,
    leitor_book_uid: Option<String>,
    /// Encrypted with a user password: no text, no cover until it is opened in PdfCraft.
    locked: bool,
}

impl AppState {
    pub fn library_list(&self) -> Result<Vec<LibraryEntry>, AppError> {
        self.with_store(|s| s.list_library())
    }

    /// Adds a PDF to the library (spec 6.6). Nothing is copied unless the file is a readable PDF.
    /// A file stamped with the `LeitorBookUid` of a library book whose current version differs only
    /// replaces that version when `replace` is set (otherwise: [`AddOutcome::OtherVersion`]); the
    /// replaced version is kept as a `replaced-` copy that pruning never deletes.
    pub fn library_add(&self, path: &Path, replace: bool) -> Result<AddedBook, AppError> {
        if check_extension(path)? == BookFormat::Epub {
            return self.library_add_epub(path);
        }
        let imported = self.read_import(path)?;
        let _guard = self.library_guard();
        let target = imported
            .leitor_book_uid
            .as_deref()
            .filter(|u| *u != imported.sha);
        let outcome = match target {
            Some(uid) => self.import_stamped(uid, &imported, replace)?,
            None => self.import_plain(&imported)?,
        };
        let uid = target.unwrap_or(&imported.sha).to_owned();
        let book = self.library_entry(&uid)?;
        tracing::info!(book_uid = %uid, ?outcome, version = book.book.file_version, "library add");
        Ok(AddedBook { book, outcome })
    }

    fn read_import(&self, path: &Path) -> Result<Imported, AppError> {
        let shown = path.display().to_string();
        let len = std::fs::metadata(path)
            .map_err(|e| AppError::read_file(&shown, &e))?
            .len();
        if len > MAX_PDF_BYTES {
            return Err(too_big());
        }
        let bytes = Arc::new(std::fs::read(path).map_err(|e| AppError::read_file(&shown, &e))?);
        let sha = book_uid_of(&bytes);
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "livro.pdf".to_owned());
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Sem título".to_owned());

        let (meta, locked) = match self.pdf().inspect(Arc::clone(&bytes), None) {
            Ok(meta) => (meta, false),
            Err(PdfError::NeedsPassword) => (
                PdfMeta {
                    page_count: 0,
                    title: None,
                    author: None,
                    leitor_book_uid: None,
                    warnings: Vec::new(),
                },
                true,
            ),
            Err(e) => return Err(invalid_pdf(&shown, &e)),
        };
        if !meta.warnings.is_empty() {
            tracing::debug!(path = %shown, warnings = ?meta.warnings, "pdf repaired on import");
        }
        let has_text = locked || self.has_text(&bytes);
        Ok(Imported {
            sha,
            bytes,
            file_name,
            title: meta.title.unwrap_or(stem),
            author: meta.author,
            pages: u32::try_from(meta.page_count).unwrap_or(u32::MAX),
            has_text,
            leitor_book_uid: meta.leitor_book_uid,
            locked,
        })
    }

    /// "Parece escaneado" (spec 6.6). A file whose text cannot be sampled counts as text, so it
    /// is never flagged by mistake.
    fn has_text(&self, bytes: &Arc<Vec<u8>>) -> bool {
        let doc = match self.pdf().open(Arc::clone(bytes), None) {
            Ok(doc) => doc,
            Err(e) => {
                tracing::warn!(error = ?e, "text sample: open failed");
                return true;
            }
        };
        let stats = self.pdf().text_stats(doc, TEXT_SAMPLE_PAGES);
        self.pdf().close(doc);
        match stats {
            Ok(stats) => !stats.looks_scanned(),
            Err(e) => {
                tracing::warn!(error = ?e, "text sample failed");
                true
            }
        }
    }

    /// A file without our stamp (or stamped with its own hash): `book_uid` = sha256.
    fn import_plain(&self, im: &Imported) -> Result<AddOutcome, AppError> {
        let uid = im.sha.as_str();
        let existing = self.with_store(|s| s.get_book(uid))?;
        if let Some(book) = existing {
            // Same book: keep it. Only bring the file back if this device lost it.
            if book.file_hash == im.sha && self.current_file(&book).is_err() {
                let rel = self
                    .files()
                    .write_version(uid, book.file_version, &im.sha, &im.bytes)?;
                self.with_store(|s| s.set_book_file(uid, Some(&rel), Some(&im.sha)))?;
            }
            return Ok(AddOutcome::Existing);
        }
        let version = self.next_version_any(uid, &im.sha)?.unwrap_or(1);
        let outcome = self.write_and_add(uid, version, im)?;
        Ok(outcome)
    }

    /// A file carrying `LeitorBookUid` = `uid` (an exported or re-added version of that book).
    fn import_stamped(
        &self,
        uid: &str,
        im: &Imported,
        replace: bool,
    ) -> Result<AddOutcome, AppError> {
        let existing = self.with_store(|s| s.get_book(uid))?;
        match existing {
            Some(book) if book.file_hash == im.sha => Ok(AddOutcome::Existing),
            Some(_) if !replace => Ok(AddOutcome::OtherVersion),
            Some(book) => {
                // Nothing is lost (spec 16): the version being replaced stays on disk.
                self.keep_replaced(&book)?;
                let previous = book.local_path.clone();
                let version = book.file_version.saturating_add(1);
                let rel = self
                    .files()
                    .write_version(uid, version, &im.sha, &im.bytes)?;
                let recorded = self.with_store(|s| s.record_file_version(uid, &im.sha, &rel));
                let recorded = recorded.inspect_err(|_| self.remove_rel(&rel))?;
                self.after_new_version(uid, &rel, previous.as_deref(), recorded.file_version);
                self.write_cover(uid, recorded.file_version, im);
                Ok(AddOutcome::NewVersion)
            }
            None => {
                // Removed (tombstone): restore it with this file as a new version. Unknown on
                // this device: the stamp still names the book, so it keeps its identity.
                let version = self.next_version_any(uid, &im.sha)?;
                let outcome = self.write_and_add(uid, version.unwrap_or(1), im)?;
                Ok(match outcome {
                    AddOutcome::Restored => AddOutcome::NewVersion,
                    other => other,
                })
            }
        }
    }

    /// Writes the file as version `version` of `uid` and adds (or restores) the book row.
    fn write_and_add(
        &self,
        uid: &str,
        version: u32,
        im: &Imported,
    ) -> Result<AddOutcome, AppError> {
        let rel = self
            .files()
            .write_version(uid, version, &im.sha, &im.bytes)?;
        let new = NewBook {
            book_uid: uid.to_owned(),
            title: im.title.clone(),
            author: im.author.clone(),
            language: None,
            format: BookFormat::Pdf,
            file_name: im.file_name.clone(),
            pages: im.pages,
            has_text: im.has_text,
            file_hash: im.sha.clone(),
            local_path: Some(rel.clone()),
        };
        let added = self
            .with_store(|s| s.add_book(&new))
            .inspect_err(|_| self.remove_rel(&rel))?;
        let book = added.book;
        if book.local_path.as_deref() == Some(rel.as_str()) {
            self.files().prune(uid, &[&rel], book.file_version);
        }
        self.write_cover(uid, book.file_version, im);
        Ok(match added.outcome {
            core_store::AddOutcome::Created => AddOutcome::Created,
            core_store::AddOutcome::Existing => AddOutcome::Existing,
            core_store::AddOutcome::Restored => AddOutcome::Restored,
        })
    }

    /// For a book row in any state (tombstones included): the version `file_hash` gets when it
    /// is added (the current one if unchanged, else the next). `None` when there is no row.
    pub(crate) fn next_version_any(
        &self,
        uid: &str,
        file_hash: &str,
    ) -> Result<Option<u32>, AppError> {
        let row = self.with_store(|s| {
            use rusqlite::OptionalExtension;
            s.connection()
                .query_row(
                    "SELECT file_version, file_hash FROM book WHERE book_uid = ?1",
                    [uid],
                    |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(core_store::StoreError::from)
        })?;
        Ok(row.map(|(v, h)| {
            if h == file_hash {
                v
            } else {
                v.saturating_add(1)
            }
        }))
    }

    fn write_cover(&self, uid: &str, version: u32, im: &Imported) {
        if im.locked {
            return;
        }
        match self.render_cover(&im.bytes) {
            Ok(png) => {
                if let Err(e) = self.files().write_cover(uid, version, &png) {
                    tracing::warn!(book_uid = %uid, %e, "could not cache the cover");
                }
            }
            Err(e) => tracing::warn!(book_uid = %uid, error = ?e, "no cover"),
        }
    }

    fn render_cover(&self, bytes: &Arc<Vec<u8>>) -> Result<Vec<u8>, PdfError> {
        let doc = self.pdf().open(Arc::clone(bytes), None)?;
        let png = self.pdf().cover_png(doc, COVER_PX);
        self.pdf().close(doc);
        png
    }

    /// The cover of the current version (cached under `covers/`), or `None` when the book is unknown or has no
    /// cover (locked or unreadable first page; an EPUB without a cover image). PDF covers are PNG; EPUB covers are
    /// the book's own image (PNG, JPEG, GIF or WebP; see [`image_type`]).
    pub fn cover_png(&self, uid: &str) -> Result<Option<Vec<u8>>, AppError> {
        let Some(book) = self.with_store(|s| s.get_book(uid))? else {
            return Ok(None);
        };
        let cached = self.files().cover_path(uid, book.file_version);
        if let Ok(png) = std::fs::read(&cached) {
            return Ok(Some(png));
        }
        if book.format == BookFormat::Epub {
            let Some(image) = self.epub_cover(&book) else {
                return Ok(None);
            };
            if let Err(e) = self.files().write_cover(uid, book.file_version, &image) {
                tracing::warn!(book_uid = %uid, %e, "could not cache the cover");
            }
            return Ok(Some(image));
        }
        let bytes = Arc::new(self.read_current(&book)?);
        match self.render_cover(&bytes) {
            Ok(png) => {
                if let Err(e) = self.files().write_cover(uid, book.file_version, &png) {
                    tracing::warn!(book_uid = %uid, %e, "could not cache the cover");
                }
                Ok(Some(png))
            }
            Err(e) => {
                tracing::debug!(book_uid = %uid, error = ?e, "no cover");
                Ok(None)
            }
        }
    }

    pub fn library_remove(&self, uid: &str) -> Result<(), AppError> {
        // Its OCR stops (it would hold the OCR slot and every core for nothing); a job past its last cancel point
        // finds the book gone under the lock and writes nothing.
        self.ocr_cancel(uid);
        let _guard = self.library_guard();
        self.with_store(|s| s.remove_book(uid))?;
        self.invalidate_docs(uid);
        self.invalidate_epub(uid);
        self.ocr_forget(uid);
        self.files().remove_book(uid);
        Ok(())
    }

    pub fn library_update(&self, uid: &str, patch: LibraryPatch) -> Result<LibraryEntry, AppError> {
        let patch = BookPatch::from(patch);
        self.with_store(|s| s.update_book(uid, &patch))?;
        self.library_entry(uid)
    }

    pub fn book_open(&self, uid: &str) -> Result<BookOpen, AppError> {
        let book = self.library_entry(uid)?;
        let page = book.position.as_ref().map_or(0, |p| p.page);
        let page = if book.book.pages > 0 {
            page.min(book.book.pages - 1)
        } else {
            page
        };
        let format = book.book.format;
        let cfi = match format {
            BookFormat::Epub => book.position.as_ref().and_then(|p| p.cfi.clone()),
            BookFormat::Pdf => None,
        };
        Ok(BookOpen {
            book,
            page,
            format,
            cfi,
        })
    }

    pub fn library_entry(&self, uid: &str) -> Result<LibraryEntry, AppError> {
        self.with_store(|s| {
            let book = s
                .get_book(uid)?
                .ok_or_else(|| core_store::StoreError::BookNotFound(uid.to_owned()))?;
            let position = s.get_reading_position(uid)?;
            let vocab_scanned = s.latest_vocab_scan(uid, true)?.is_some();
            Ok(LibraryEntry {
                book,
                position,
                vocab_scanned,
            })
        })
    }

    fn book(&self, uid: &str) -> Result<Book, AppError> {
        self.with_store(|s| {
            s.get_book(uid)?
                .ok_or_else(|| core_store::StoreError::BookNotFound(uid.to_owned()))
        })
    }

    /// Where the current version is on disk.
    pub fn current_file(&self, book: &Book) -> Result<PathBuf, AppError> {
        let path = book
            .local_path
            .as_deref()
            .and_then(|p| self.files().resolve(p))
            .ok_or_else(file_missing)?;
        if path.is_file() {
            Ok(path)
        } else {
            tracing::warn!(book_uid = %book.book_uid, path = %path.display(), "book file missing");
            Err(file_missing())
        }
    }

    pub fn current_file_path(&self, uid: &str) -> Result<PathBuf, AppError> {
        self.current_file(&self.book(uid)?)
    }

    fn read_current(&self, book: &Book) -> Result<Vec<u8>, AppError> {
        let path = self.current_file(book)?;
        std::fs::read(&path).map_err(|e| {
            tracing::warn!(path = %path.display(), %e, "could not read the book file");
            file_missing()
        })
    }

    /// The bytes of the current version (what `pdfcraft:open` gets).
    pub fn book_bytes(&self, uid: &str) -> Result<Vec<u8>, AppError> {
        self.read_current(&self.book(uid)?)
    }

    /// Stores what PdfCraft saved (`pdfcraft:save`) as the book's new current version.
    pub fn book_save_version(&self, uid: &str, bytes: Vec<u8>) -> Result<SavedVersion, AppError> {
        self.book_save_version_from(uid, bytes, None)
    }

    /// Like [`book_save_version`](Self::book_save_version), with the `file_version` the PdfCraft
    /// tab was opened from. When the current version is newer than that base (a stamped copy was
    /// imported while the tab was open, and PdfCraft kept editing the old content), the save still
    /// becomes current (it holds the user's latest edits) but the version it supersedes is kept as
    /// a `replaced-` copy, so pruning never deletes it (spec 16: nothing is lost).
    pub fn book_save_version_from(
        &self,
        uid: &str,
        bytes: Vec<u8>,
        base_version: Option<u32>,
    ) -> Result<SavedVersion, AppError> {
        if !bytes.starts_with(b"%PDF-") {
            return Err(AppError::new(
                "pdf_invalid",
                "O PdfCraft enviou um arquivo que não é PDF; a versão não foi salva.",
            ));
        }
        if bytes.len() as u64 > MAX_PDF_BYTES {
            return Err(too_big());
        }
        if self.book(uid)?.format == BookFormat::Epub {
            return Err(AppError::new(
                "not_pdf",
                "Livros EPUB não têm versões: as anotações ficam no app.",
            ));
        }
        let bytes = Arc::new(bytes);
        match core_pdf::read_info(Arc::clone(&bytes), LEITOR_BOOK_UID_KEY) {
            Ok(None) => {}
            Ok(Some(stamp)) if stamp == uid => {}
            Ok(Some(stamp)) => {
                tracing::warn!(book_uid = %uid, %stamp, "save of another book refused");
                return Err(AppError::new(
                    "pdf_foreign",
                    "Este arquivo pertence a outro livro da biblioteca; a versão não foi salva.",
                ));
            }
            // An encrypted save cannot be checked without its password; it came from the
            // reader that has this book open.
            Err(PdfError::NeedsPassword) => {}
            Err(e) => return Err(invalid_pdf("arquivo salvo pelo PdfCraft", &e)),
        }

        let _guard = self.library_guard();
        let book = self.book(uid)?;
        self.save_version_locked(&book, bytes, base_version)
    }

    /// The OCR's save (spec 7.2): `bytes` become the new version only if `base_version` is still the current one,
    /// checked and committed under the library lock, and `after_commit` runs under that same lock (so no PdfCraft
    /// save can come between the new version and what the OCR keeps about it). `Ok(None)` when the current
    /// version is no longer `base_version` (PdfCraft saved meanwhile): nothing was written, start over from the
    /// newer version. `proceed` also runs under the lock, first: its error (e.g. the job was cancelled, as library
    /// removal does before it takes the lock) stops the save. `bytes` must be a PDF stamped with this book's
    /// `LeitorBookUid`.
    pub(crate) fn book_save_version_if_current(
        &self,
        uid: &str,
        bytes: Vec<u8>,
        base_version: u32,
        proceed: &dyn Fn() -> Result<(), AppError>,
        after_commit: impl FnOnce(&SavedVersion),
    ) -> Result<Option<SavedVersion>, AppError> {
        if bytes.len() as u64 > MAX_PDF_BYTES {
            return Err(too_big());
        }
        let _guard = self.library_guard();
        proceed()?;
        let book = self.book(uid)?;
        if book.format != BookFormat::Pdf {
            return Err(AppError::new(
                "not_pdf",
                "Livros EPUB não têm versões: as anotações ficam no app.",
            ));
        }
        if book.file_version != base_version {
            return Ok(None);
        }
        let saved = self.save_version_locked(&book, Arc::new(bytes), Some(base_version))?;
        after_commit(&saved);
        Ok(Some(saved))
    }

    /// The part of a save that runs under [`library_guard`](Self::library_guard), with `book` read under it.
    fn save_version_locked(
        &self,
        book: &Book,
        bytes: Arc<Vec<u8>>,
        base_version: Option<u32>,
    ) -> Result<SavedVersion, AppError> {
        let uid = book.book_uid.as_str();
        let stale_base = base_version.is_some_and(|base| base != book.file_version);
        // A save based on a version from before an OCR gets the text layer back (spec 7.2).
        let bytes = if stale_base {
            Arc::new(self.ocr_merge_into_save(uid, Arc::unwrap_or_clone(bytes), base_version)?)
        } else {
            bytes
        };
        let file_hash = book_uid_of(&bytes);
        if file_hash == book.file_hash && self.current_file(book).is_ok() {
            return Ok(SavedVersion {
                file_hash,
                file_version: book.file_version,
                changed: false,
                kept_newer: false,
            });
        }
        if file_hash == book.file_hash {
            // Same content but the file is gone: put it back under the current version.
            let rel = self
                .files()
                .write_version(uid, book.file_version, &file_hash, &bytes)?;
            self.with_store(|s| s.set_book_file(uid, Some(&rel), Some(&file_hash)))?;
            return Ok(SavedVersion {
                file_hash,
                file_version: book.file_version,
                changed: false,
                kept_newer: false,
            });
        }
        // The book moved to another PC's version (from the library server, not on this device yet) while this tab
        // was open: the save must not overwrite that version (spec 16) — it goes to a conflict copy.
        // A tab already sent to a copy keeps going there (even once the new version is downloaded here).
        if let Some(base) = base_version.filter(|_| stale_base)
            && (book.local_hash.as_deref() != Some(book.file_hash.as_str())
                || self.library_has_stale_copy(uid, base))
        {
            let created = self.library_stale_save(book, base, Arc::unwrap_or_clone(bytes))?;
            // The tab's base stays the old version, so its next saves are stale too and go to the same copy.
            return Ok(SavedVersion {
                file_hash: book.file_hash.clone(),
                file_version: base,
                changed: false,
                kept_newer: created.is_some(),
            });
        }
        if stale_base {
            tracing::warn!(
                book_uid = %uid,
                base = ?base_version,
                current = book.file_version,
                "save based on an older version; keeping the current one"
            );
            self.keep_replaced(book)?;
        }
        let version = book.file_version.saturating_add(1);
        let rel = self
            .files()
            .write_version(uid, version, &file_hash, &bytes)?;
        let recorded = self
            .with_store(|s| s.record_file_version(uid, &file_hash, &rel))
            .inspect_err(|_| self.remove_rel(&rel))?;
        self.after_new_version(uid, &rel, book.local_path.as_deref(), recorded.file_version);
        tracing::info!(book_uid = %uid, version = recorded.file_version, "book version saved");
        Ok(SavedVersion {
            file_hash: recorded.file_hash,
            file_version: recorded.file_version,
            changed: recorded.changed,
            kept_newer: stale_base,
        })
    }

    /// A new version of `book` from bytes already checked (a conflict copy's next save), under the library lock.
    pub(crate) fn save_version_unchecked(
        &self,
        book: &Book,
        bytes: Vec<u8>,
    ) -> Result<SavedVersion, AppError> {
        self.save_version_locked(book, Arc::new(bytes), None)
    }

    /// Keeps the new and the previous version files, drops older ones and old covers.
    fn after_new_version(&self, uid: &str, new_rel: &str, previous: Option<&str>, version: u32) {
        let mut keep = vec![new_rel];
        keep.extend(previous);
        self.files()
            .prune(uid, &keep, version.saturating_sub(1).max(1));
        self.invalidate_docs(uid);
    }

    /// Copies the current version of `book` to its `replaced-` file (kept until the book is
    /// removed). A book whose file is gone from this device has nothing to keep.
    fn keep_replaced(&self, book: &Book) -> Result<(), AppError> {
        let Ok(bytes) = self.read_current(book) else {
            return Ok(());
        };
        self.files()
            .write_replaced(&book.book_uid, book.file_version, &book.file_hash, &bytes)?;
        Ok(())
    }

    pub(crate) fn remove_rel(&self, rel: &str) {
        if let Some(path) = self.files().resolve(rel) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// "Exportar cópia": the current version at `dest`, always carrying `LeitorBookUid` so that
    /// adding it back finds the book.
    pub fn book_export(&self, uid: &str, dest: &Path) -> Result<(), AppError> {
        let book = self.book(uid)?;
        if book.format == BookFormat::Epub {
            // The file never changes (annotations live in the app): a plain copy.
            check_export_path_as(dest, "epub")?;
            let bytes = self.read_current(&book)?;
            return files::write_atomic(dest, &bytes).map_err(|e| files::write_error(dest, &e));
        }
        check_export_path(dest)?;
        let bytes = self.book_bytes(uid)?;
        let shared = Arc::new(bytes);
        let out = match core_pdf::read_info(Arc::clone(&shared), LEITOR_BOOK_UID_KEY) {
            Ok(Some(_)) | Err(_) => shared,
            Ok(None) => match core_pdf::stamp_info(&shared, LEITOR_BOOK_UID_KEY, uid) {
                Ok(stamped) => Arc::new(stamped),
                Err(e) => {
                    tracing::warn!(book_uid = %uid, error = ?e, "export without stamp");
                    shared
                }
            },
        };
        files::write_atomic(dest, &out).map_err(|e| files::write_error(dest, &e))
    }

    /// Writes bytes PdfCraft saved for a tab that is not a library book ("Salvar como").
    pub fn export_bytes(&self, dest: &Path, bytes: &[u8]) -> Result<(), AppError> {
        check_export_path(dest)?;
        if bytes.len() as u64 > MAX_PDF_BYTES {
            return Err(too_big());
        }
        files::write_atomic(dest, bytes).map_err(|e| files::write_error(dest, &e))
    }

    /// The words of a page of the current version (spec 6.3), with their rects.
    pub fn doc_words(&self, uid: &str, page: u32) -> Result<PageWords, AppError> {
        let book = self.book(uid)?;
        let doc = self.book_doc(&book)?;
        let page = usize::try_from(page).unwrap_or(usize::MAX);
        Ok(self.pdf().page_words(doc, page)?)
    }

    /// The open PDF of a book's current version (`not_pdf` for an EPUB).
    pub(crate) fn book_doc(&self, book: &Book) -> Result<DocHandle, AppError> {
        if book.format != BookFormat::Pdf {
            return Err(crate::epub::not_pdf());
        }
        self.cached_doc(&book.book_uid, &book.file_hash, || {
            let bytes = Arc::new(self.read_current(book)?);
            Ok(self.pdf().open(bytes, None)?)
        })
    }

    pub fn position_get(&self, uid: &str) -> Result<Option<ReadingPosition>, AppError> {
        self.with_store(|s| s.get_reading_position(uid))
    }

    /// Saves the page from `pdfcraft:page` (0-based) or, for an EPUB, the section and the CFI of the reader;
    /// `progress` is clamped to 0..=1. An invalid CFI is `invalid_input`.
    pub fn position_set(
        &self,
        uid: &str,
        page: u32,
        progress: f64,
        cfi: Option<String>,
    ) -> Result<ReadingPosition, AppError> {
        let progress = if progress.is_finite() {
            progress.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let cfi = cfi.map(|c| c.trim().to_owned()).filter(|c| !c.is_empty());
        if let Some(c) = &cfi
            && !core_epub::is_valid_cfi(c)
        {
            return Err(AppError::new(
                "invalid_input",
                "A posição de leitura (CFI) é inválida.",
            ));
        }
        let pos = ReadingPosition {
            page,
            progress,
            cfi,
            ..ReadingPosition::default()
        };
        self.with_store(|s| s.set_reading_position(uid, &pos))
    }
}

fn check_extension(path: &Path) -> Result<BookFormat, AppError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("pdf") => Ok(BookFormat::Pdf),
        Some("epub") => Ok(BookFormat::Epub),
        _ => Err(AppError::new(
            "unsupported_format",
            "Formato não suportado: escolha um arquivo PDF ou EPUB.",
        )),
    }
}

fn check_export_path(dest: &Path) -> Result<(), AppError> {
    check_export_path_as(dest, "pdf")
}

fn check_export_path_as(dest: &Path, ext: &str) -> Result<(), AppError> {
    let matches = dest
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext));
    if !dest.is_absolute() || !matches {
        return Err(AppError::new(
            "invalid_path",
            format!("Escolha um caminho de arquivo .{ext} para exportar."),
        ));
    }
    Ok(())
}

/// The image type of a cover from its magic bytes (`None` for anything else, SVG included).
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn invalid_pdf(what: &str, e: &PdfError) -> AppError {
    tracing::warn!(what, error = ?e, "unreadable pdf");
    AppError::new("pdf_invalid", e.to_string())
}

fn file_missing() -> AppError {
    AppError::new(
        "file_missing",
        "O arquivo deste livro não está neste computador.",
    )
}

fn too_big() -> AppError {
    AppError::new(
        "pdf_too_big",
        "O arquivo passa de 2 GB e não pode ser aberto.",
    )
}
