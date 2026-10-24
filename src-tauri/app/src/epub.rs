//! EPUB books in the app (spec 7.1, 14, 15): import (`library_add` with a `.epub`), the parsed books cache, the
//! per-section text cache (`book_text`), the table of contents as the vocabulary outline, and the highlights, notes
//! and bookmarks of the EPUB reader (`epub_annotation`, CFI ranges). The reader itself is foliate-js in the UI; the
//! file never changes (annotations live in the app database), so an EPUB book has exactly one version.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use core_epub::{EpubBook, EpubError};
use core_store::{
    Book, BookFormat, BookTextRow, EpubAnnotationKind, EpubAnnotationRow, NewBook, book_uid_of,
};
use core_vocab::OutlineNode;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::library::{AddOutcome, AddedBook};
use crate::state::{AppState, lock};

/// Largest EPUB accepted for import.
pub const MAX_EPUB_BYTES: u64 = 512 * 1024 * 1024;
/// EPUB books kept parsed (the open book and the previous one).
const EPUB_CACHE_SIZE: usize = 2;

/// An EPUB highlight, underline, note or bookmark (`epub_annotation_list`/`epub_annotation_upsert`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubAnnotation {
    pub uid: String,
    pub book_uid: String,
    pub kind: EpubAnnotationKind,
    /// `epubcfi(...)` of the range (or point, for bookmarks).
    pub cfi: String,
    /// 0-based section (spine order) the CFI points into.
    pub section: u32,
    pub text: Option<String>,
    /// `#rrggbb` (PdfCraft's swatches), `None` for the default color of the kind.
    pub color: Option<String>,
    pub comment: Option<String>,
    /// Epoch ms, UTC.
    pub updated_at: i64,
}

/// What `epub_annotation_upsert` takes: a new annotation (`uid` absent) or a change of an existing one.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpubAnnotationInput {
    #[serde(default)]
    pub uid: Option<String>,
    pub book_uid: String,
    pub kind: EpubAnnotationKind,
    pub cfi: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// One word form to color in the EPUB reader ("Realçar vocabulário", spec 12.7).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubMarkWord {
    /// Lowercase surface form as in the text (typographic apostrophes normalised to `'`).
    pub form: String,
    pub lemma: String,
    /// `unknown`/`suspended` (coral) or `learning`/`new` (amber).
    pub status: core_vocab::Status,
    /// `#d85a30` (unknown, suspended) or `#ba7517` (learning, new in the deck).
    pub color: String,
}

/// The forms to color in one section (`vocab_epub_marks`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubSectionMarks {
    pub section: u32,
    pub words: Vec<EpubMarkWord>,
}

/// Coral: unknown or suspended.
pub const MARK_UNKNOWN_COLOR: &str = "#d85a30";
/// Amber: learning or new in the deck.
pub const MARK_LEARNING_COLOR: &str = "#ba7517";

/// The parsed EPUBs kept by [`AppState`]: `(book_uid, file_hash, book)`, most recently used last.
pub(crate) type EpubCache =
    std::sync::Mutex<std::collections::VecDeque<(String, String, Arc<EpubBook>)>>;

pub(crate) fn epub_error(e: &EpubError) -> AppError {
    if !matches!(e, EpubError::Cancelled) {
        tracing::warn!(error = ?e, "epub");
    }
    AppError::new(e.code(), e.to_string())
}

pub(crate) fn not_pdf() -> AppError {
    AppError::new(
        "not_pdf",
        "Este livro é um EPUB: essa ação vale só para PDF.",
    )
}

pub(crate) fn not_epub() -> AppError {
    AppError::new("not_epub", "Este livro não é um EPUB.")
}

fn too_big() -> AppError {
    AppError::new(
        "epub_too_big",
        "O EPUB passa de 512 MB e não pode ser aberto.",
    )
}

fn invalid(message: &str) -> AppError {
    AppError::new("invalid_input", message)
}

/// `en-US` → `en`, `pt_BR` → `pt`; anything that is not a language subtag → `en`.
pub fn primary_language(tag: Option<&str>) -> String {
    let primary = tag
        .unwrap_or("")
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if (2..=8).contains(&primary.len()) && primary.bytes().all(|b| b.is_ascii_lowercase()) {
        primary
    } else {
        "en".to_owned()
    }
}

/// `#rrggbb` (any case) → lowercase; anything else is refused.
fn normalize_color(color: &str) -> Option<String> {
    let hex = color.trim().strip_prefix('#')?;
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_ascii_lowercase()))
}

fn valid_annotation_uid(uid: &str) -> bool {
    !uid.is_empty()
        && uid.len() <= core_store::EPUB_UID_MAX_BYTES
        && uid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Non-whitespace chars of the texts (the "parece escaneado" measure of PDFs).
fn text_chars<'a>(texts: impl IntoIterator<Item = &'a str>) -> usize {
    texts
        .into_iter()
        .map(|t| t.chars().filter(|c| !c.is_whitespace()).count())
        .sum()
}

/// A form as the EPUB reader matches it: lowercase, typographic apostrophes as `'`.
pub fn mark_form(form: &str) -> String {
    form.replace(['\u{2019}', '\u{2018}', '\u{02BC}'], "'")
        .to_lowercase()
}

impl AppState {
    /// Adds an EPUB to the library (spec 7.1, 6.6). Nothing is copied unless the file is a readable EPUB. The
    /// book's identity is the sha256 of the file, which never changes (no `LeitorBookUid`: annotations live in the
    /// app database).
    pub(crate) fn library_add_epub(&self, path: &Path) -> Result<AddedBook, AppError> {
        let shown = path.display().to_string();
        let len = std::fs::metadata(path)
            .map_err(|e| AppError::read_file(&shown, &e))?
            .len();
        if len > MAX_EPUB_BYTES {
            return Err(too_big());
        }
        let bytes = Arc::new(std::fs::read(path).map_err(|e| AppError::read_file(&shown, &e))?);
        let uid = book_uid_of(&bytes);
        let book = core_epub::open(Arc::clone(&bytes)).map_err(|e| epub_error(&e))?;
        let never = AtomicBool::new(false);
        let texts = book
            .texts(&never, &mut |_, _| {})
            .map_err(|e| epub_error(&e))?;
        let meta = book.meta();
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Sem título".to_owned());
        let title = meta
            .title
            .as_deref()
            .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|t| !t.is_empty())
            .unwrap_or(stem);
        let authors: Vec<&str> = meta
            .authors
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .collect();
        let author = (!authors.is_empty()).then(|| authors.join(", "));
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "livro.epub".to_owned());
        let has_text =
            text_chars(texts.iter().map(|t| t.text.as_str())) >= core_pdf::TextStats::MIN_CHARS;
        let rows: Vec<BookTextRow> = texts
            .into_iter()
            .map(|t| BookTextRow {
                unit: t.section,
                label: t.label,
                text: t.text,
            })
            .collect();
        let pages = u32::try_from(book.sections().len()).unwrap_or(u32::MAX);

        let _guard = self.library_guard();
        if let Some(existing) = self.with_store(|s| s.get_book(&uid))? {
            if existing.format != BookFormat::Epub {
                return Err(AppError::internal("a PDF book has the sha256 of this EPUB"));
            }
            // Same book: keep it. Only bring the file back if this device lost it.
            if self.current_file(&existing).is_err() {
                let rel = self
                    .files()
                    .write_epub(&uid, existing.file_version, &uid, &bytes)?;
                self.with_store(|s| s.set_book_file(&uid, Some(&rel), Some(&uid)))?;
            }
            let entry = self.library_entry(&uid)?;
            tracing::info!(book_uid = %uid, "library add (epub): existing");
            return Ok(AddedBook {
                book: entry,
                outcome: AddOutcome::Existing,
            });
        }
        let version = self.next_version_any(&uid, &uid)?.unwrap_or(1);
        let rel = self.files().write_epub(&uid, version, &uid, &bytes)?;
        let new = NewBook {
            book_uid: uid.clone(),
            title,
            author,
            language: Some(primary_language(meta.language.as_deref())),
            format: BookFormat::Epub,
            file_name,
            pages,
            has_text,
            file_hash: uid.clone(),
            local_path: Some(rel.clone()),
        };
        let added = self
            .with_store(|s| {
                let added = s.add_book(&new)?;
                s.replace_book_text(&uid, &rows)?;
                Ok(added)
            })
            .inspect_err(|_| self.remove_rel(&rel))?;
        if added.book.local_path.as_deref() == Some(rel.as_str()) {
            self.files().prune(&uid, &[&rel], added.book.file_version);
        }
        if let Some(cover) = book.cover()
            && let Err(e) = self
                .files()
                .write_cover(&uid, added.book.file_version, &cover.bytes)
        {
            tracing::warn!(book_uid = %uid, %e, "could not cache the cover");
        }
        let outcome = match added.outcome {
            core_store::AddOutcome::Created => AddOutcome::Created,
            core_store::AddOutcome::Existing => AddOutcome::Existing,
            core_store::AddOutcome::Restored => AddOutcome::Restored,
        };
        tracing::info!(book_uid = %uid, ?outcome, sections = pages, "library add (epub)");
        Ok(AddedBook {
            book: self.library_entry(&uid)?,
            outcome,
        })
    }

    /// The parsed EPUB of a book's current file (kept for the last [`EPUB_CACHE_SIZE`] books).
    pub(crate) fn epub_book(&self, book: &Book) -> Result<Arc<EpubBook>, AppError> {
        if book.format != BookFormat::Epub {
            return Err(not_epub());
        }
        {
            let mut cache = lock(&self.epubs);
            if let Some(i) = cache
                .iter()
                .position(|(u, h, _)| *u == book.book_uid && *h == book.file_hash)
                && let Some(entry) = cache.remove(i)
            {
                let parsed = Arc::clone(&entry.2);
                cache.push_back(entry);
                return Ok(parsed);
            }
        }
        // Parsed without the lock: a big book must not block another one.
        let bytes = Arc::new(self.book_bytes(&book.book_uid)?);
        let parsed = Arc::new(core_epub::open(bytes).map_err(|e| epub_error(&e))?);
        let mut cache = lock(&self.epubs);
        cache.retain(|(u, _, _)| *u != book.book_uid);
        cache.push_back((
            book.book_uid.clone(),
            book.file_hash.clone(),
            Arc::clone(&parsed),
        ));
        while cache.len() > EPUB_CACHE_SIZE {
            cache.pop_front();
        }
        Ok(parsed)
    }

    /// Forgets the parsed EPUB of a book (removed from the library).
    pub(crate) fn invalidate_epub(&self, uid: &str) {
        lock(&self.epubs).retain(|(u, _, _)| u != uid);
    }

    /// The cover of an EPUB read from the file (when the cover cache is gone).
    pub(crate) fn epub_cover(&self, book: &Book) -> Option<Vec<u8>> {
        let parsed = self.epub_book(book).ok()?;
        parsed.cover().map(|c| c.bytes)
    }

    /// The text of every section of an EPUB: the `book_text` cache, or read from the file (and cached) when the
    /// cache is missing. A read counts as a text extraction (`vocab_text_extractions`).
    pub(crate) fn epub_section_texts(
        &self,
        book: &Book,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u32, u32),
    ) -> Result<Vec<BookTextRow>, AppError> {
        let uid = book.book_uid.clone();
        let cached = self.with_store(|s| s.book_text(&uid))?;
        if !cached.is_empty() && cached.len() == book.pages as usize {
            return Ok(cached);
        }
        let parsed = self.epub_book(book)?;
        self.vocab.text_extractions.fetch_add(1, Ordering::Relaxed);
        let texts = parsed.texts(cancel, progress).map_err(|e| match e {
            EpubError::Cancelled => AppError::new("cancelled", "Escaneamento cancelado."),
            other => epub_error(&other),
        })?;
        let rows: Vec<BookTextRow> = texts
            .into_iter()
            .map(|t| BookTextRow {
                unit: t.section,
                label: t.label,
                text: t.text,
            })
            .collect();
        self.with_store(|s| s.replace_book_text(&uid, &rows))?;
        Ok(rows)
    }

    /// The fingerprint of an EPUB's text (`core_epub::fingerprint_of` over the cached section texts).
    pub(crate) fn epub_text_fingerprint(&self, book: &Book) -> Result<String, AppError> {
        let never = AtomicBool::new(false);
        let rows = self.epub_section_texts(book, &never, &mut |_, _| {})?;
        let texts: Vec<core_epub::SectionText> = rows
            .into_iter()
            .map(|r| core_epub::SectionText {
                section: r.unit,
                label: r.label,
                text: r.text,
            })
            .collect();
        Ok(core_epub::fingerprint_of(&texts))
    }

    /// The table of contents as the vocabulary outline (`page` = 0-based section) and the section count. Items
    /// without a section are kept without a page, like PDF outline items without a destination.
    pub(crate) fn epub_outline_nodes(
        &self,
        book: &Book,
    ) -> Result<(u32, Vec<OutlineNode>), AppError> {
        let parsed = self.epub_book(book)?;
        fn nodes(items: &[core_epub::TocItem]) -> Vec<OutlineNode> {
            items
                .iter()
                .map(|i| OutlineNode {
                    title: i.title.clone(),
                    page: i.section,
                    children: nodes(&i.children),
                })
                .collect()
        }
        let count = u32::try_from(parsed.sections().len()).unwrap_or(u32::MAX);
        Ok((count, nodes(parsed.toc())))
    }

    /// The table-of-contents label of each section (by 0-based section), from the text cache.
    pub(crate) fn epub_section_labels(&self, uid: &str) -> Vec<Option<String>> {
        let labels = self
            .with_store(|s| s.book_text_labels(uid))
            .unwrap_or_default();
        let mut out: Vec<Option<String>> = Vec::new();
        for (unit, label) in labels {
            let i = unit as usize;
            if out.len() <= i {
                out.resize(i + 1, None);
            }
            out[i] = label;
        }
        out
    }

    fn epub_of(&self, uid: &str) -> Result<(Book, Arc<EpubBook>), AppError> {
        let book = self.with_store(|s| {
            s.get_book(uid)?
                .ok_or_else(|| core_store::StoreError::BookNotFound(uid.to_owned()))
        })?;
        let parsed = self.epub_book(&book)?;
        Ok((book, parsed))
    }

    fn annotation_out(row: EpubAnnotationRow, parsed: &EpubBook) -> EpubAnnotation {
        let section = parsed
            .section_for_cfi(&row.cfi)
            .or_else(|| core_epub::section_of_cfi(&row.cfi))
            .unwrap_or(0);
        EpubAnnotation {
            uid: row.uid,
            book_uid: row.book_uid,
            kind: row.kind,
            cfi: row.cfi,
            section,
            text: row.text,
            color: row.color,
            comment: row.comment,
            updated_at: row.updated_at,
        }
    }

    /// `epub_annotation_list`: the book's highlights, notes and bookmarks, oldest change first.
    pub fn epub_annotation_list(&self, uid: &str) -> Result<Vec<EpubAnnotation>, AppError> {
        let (_, parsed) = self.epub_of(uid)?;
        let rows = self.with_store(|s| s.list_epub_annotations(uid))?;
        Ok(rows
            .into_iter()
            .map(|r| Self::annotation_out(r, &parsed))
            .collect())
    }

    /// `epub_annotation_upsert`: creates (no `uid`) or changes an annotation. The CFI must point into a section of
    /// the book; the color is `#rrggbb`.
    pub fn epub_annotation_upsert(
        &self,
        input: EpubAnnotationInput,
    ) -> Result<EpubAnnotation, AppError> {
        let uid = match input.uid.as_deref().map(str::trim) {
            None | Some("") => uuid::Uuid::new_v4().to_string(),
            Some(u) if valid_annotation_uid(u) => u.to_owned(),
            Some(_) => return Err(invalid("Identificador de anotação inválido.")),
        };
        let cfi = input.cfi.trim().to_owned();
        if !core_epub::is_valid_cfi(&cfi) || cfi.len() > core_store::EPUB_CFI_MAX_BYTES {
            return Err(invalid("A posição da anotação no livro é inválida."));
        }
        let color = match input.color.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(c) => {
                Some(normalize_color(c).ok_or_else(|| invalid("Cor de anotação inválida."))?)
            }
        };
        let (book, parsed) = self.epub_of(&input.book_uid)?;
        if parsed.section_for_cfi(&cfi).is_none() {
            return Err(invalid("A posição da anotação não existe neste livro."));
        }
        let clean = |v: Option<String>| v.filter(|t| !t.trim().is_empty());
        let row = EpubAnnotationRow {
            uid,
            book_uid: book.book_uid,
            kind: input.kind,
            cfi,
            text: clean(input.text),
            color,
            comment: clean(input.comment),
            updated_at: 0,
        };
        let stored = self.with_store(|s| s.upsert_epub_annotation(&row))?;
        Ok(Self::annotation_out(stored, &parsed))
    }

    /// `epub_annotation_delete`: tombstones the annotation (an unknown uid is a no-op).
    pub fn epub_annotation_delete(&self, annotation_uid: &str) -> Result<(), AppError> {
        self.with_store(|s| s.delete_epub_annotation(annotation_uid))?;
        Ok(())
    }

    /// `vocab_epub_marks`: for each section (at most [`crate::vocab::MAX_EPUB_MARK_SECTIONS`]), the word forms the
    /// reader colors — forms of the section's lemmas (book table) whose status is unknown/suspended (coral) or
    /// learning/new (amber); proper nouns, ignored, known and function words get no color.
    pub fn vocab_epub_marks(
        &self,
        uid: &str,
        sections: &[u32],
    ) -> Result<Vec<EpubSectionMarks>, AppError> {
        let max = crate::vocab::MAX_EPUB_MARK_SECTIONS;
        if sections.len() > max {
            return Err(AppError::new(
                "invalid_input",
                format!("Peça no máximo {max} capítulos de cada vez."),
            ));
        }
        let book = self.vocab_book(uid)?;
        if book.format != BookFormat::Epub {
            return Err(not_epub());
        }
        if self.with_store(|s| s.vocab_table_state(uid))?.is_none() {
            return Err(crate::vocab::not_scanned());
        }
        let oracle = self.vocab_oracle(uid)?;
        let proper: std::collections::HashSet<String> = self
            .with_store(|s| s.vocab_table_lemmas(uid))?
            .into_iter()
            .filter(|l| l.is_proper)
            .map(|l| l.lemma)
            .collect();
        let mut out = Vec::with_capacity(sections.len());
        for &section in sections {
            let rows = self.with_store(|s| s.vocab_table_pages(uid, &[[section, section]]))?;
            let mut words: Vec<EpubMarkWord> = Vec::new();
            for row in rows {
                if proper.contains(&row.lemma) {
                    continue;
                }
                let mut forms: Vec<String> =
                    serde_json::from_value::<Vec<(String, u32)>>(row.forms)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(f, _)| f)
                        .collect();
                forms.push(row.form);
                for form in forms {
                    let form = mark_form(&form);
                    // Phrasal verbs are colored word by word, through their own lemmas.
                    if form.is_empty()
                        || form.contains(char::is_whitespace)
                        || words.iter().any(|w| w.form == form)
                    {
                        continue;
                    }
                    let Some(Some((lemma, status))) =
                        oracle.classify_detailed(&[(form.as_str(), false)]).pop()
                    else {
                        continue;
                    };
                    let color = match status {
                        core_vocab::Status::Learning | core_vocab::Status::New => {
                            MARK_LEARNING_COLOR
                        }
                        _ => MARK_UNKNOWN_COLOR,
                    };
                    words.push(EpubMarkWord {
                        form,
                        lemma,
                        status,
                        color: color.to_owned(),
                    });
                }
            }
            words.sort_by(|a, b| a.form.cmp(&b.form));
            out.push(EpubSectionMarks { section, words });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_and_colors() {
        assert_eq!(primary_language(Some("en-US")), "en");
        assert_eq!(primary_language(Some(" PT_br ")), "pt");
        assert_eq!(primary_language(Some("")), "en");
        assert_eq!(primary_language(None), "en");
        assert_eq!(primary_language(Some("x")), "en");
        assert_eq!(primary_language(Some("e1")), "en");
        assert_eq!(normalize_color("#FFF000").as_deref(), Some("#fff000"));
        assert_eq!(normalize_color("fff000"), None);
        assert_eq!(normalize_color("#fff"), None);
        assert_eq!(normalize_color("#ggg000"), None);
        assert!(valid_annotation_uid("3f2a-B_9"));
        assert!(!valid_annotation_uid("a b"));
        assert!(!valid_annotation_uid(""));
        assert_eq!(mark_form("Napoleon\u{2019}s"), "napoleon's");
    }

    #[test]
    fn input_rejects_unknown_fields() {
        let ok: EpubAnnotationInput = serde_json::from_value(serde_json::json!({
            "bookUid": "a", "kind": "highlight", "cfi": "epubcfi(/6/2!/4)"
        }))
        .unwrap();
        assert_eq!(ok.uid, None);
        assert!(
            serde_json::from_value::<EpubAnnotationInput>(serde_json::json!({
                "bookUid": "a", "kind": "scribble", "cfi": "x"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<EpubAnnotationInput>(serde_json::json!({
                "bookUid": "a", "kind": "note", "cfi": "x", "section": 2
            }))
            .is_err()
        );
    }
}
