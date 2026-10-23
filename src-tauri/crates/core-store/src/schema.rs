//! Versioned migrations keyed on `PRAGMA user_version`. Migration `i` (0-based) upgrades the
//! schema from version `i` to `i + 1`. Never edit a shipped migration: append a new one.

use rusqlite::Connection;

use crate::{Result, StoreError};

const MIGRATIONS: &[&str] = &[V1, V2, V3, V4];

/// Schema version this build creates and understands.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let found: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(StoreError::SchemaTooNew {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(found as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // PRAGMA doesn't take bound parameters; the value is our own integer.
        tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1))?;
        tx.commit()?;
    }
    Ok(())
}

/// Section 14 of docs/PROJETO.md. Comments mark the tables that don't sync (section 16).
const V1: &str = r#"
CREATE TABLE settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;

CREATE TABLE book (
    book_uid          TEXT PRIMARY KEY NOT NULL
                      CHECK (length(book_uid) = 64 AND book_uid NOT GLOB '*[^0-9a-f]*'),
    title             TEXT NOT NULL,
    author            TEXT,
    language          TEXT NOT NULL DEFAULT 'en',
    format            TEXT NOT NULL CHECK (format IN ('pdf', 'epub')),
    file_name         TEXT NOT NULL,
    pages             INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0),
    has_text          INTEGER NOT NULL DEFAULT 1 CHECK (has_text IN (0, 1)),
    ocr_status        TEXT NOT NULL DEFAULT 'none'
                      CHECK (ocr_status IN ('none', 'running', 'done', 'failed')),
    renderer          TEXT NOT NULL DEFAULT 'pdfcraft' CHECK (renderer IN ('pdfcraft', 'pdfjs')),
    content_deck_id   INTEGER,
    collection_folder TEXT,
    added_at          INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    deleted           INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE INDEX book_updated_at ON book (updated_at);

-- Doesn't sync: each device knows which files it has.
CREATE TABLE book_file (
    book_uid   TEXT PRIMARY KEY NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    local_path TEXT,
    downloaded INTEGER NOT NULL DEFAULT 0 CHECK (downloaded IN (0, 1))
) STRICT;

CREATE TABLE reading_position (
    book_uid   TEXT PRIMARY KEY NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    page       INTEGER NOT NULL DEFAULT 0 CHECK (page >= 0),
    "offset"   REAL NOT NULL DEFAULT 0,
    cfi        TEXT,
    progress   REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE INDEX reading_position_updated_at ON reading_position (updated_at);

-- Doesn't sync: sessions go to the Painel through the outbox (section 6.4).
CREATE TABLE reading_session (
    uid               TEXT PRIMARY KEY NOT NULL,
    book_uid          TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
    last_heartbeat_at INTEGER NOT NULL CHECK (last_heartbeat_at >= started_at),
    pages             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pages)),
    sent_to_painel_at INTEGER
) STRICT;
CREATE INDEX reading_session_book ON reading_session (book_uid, started_at);
CREATE INDEX reading_session_open ON reading_session (book_uid) WHERE ended_at IS NULL;
CREATE INDEX reading_session_unsent ON reading_session (started_at)
    WHERE ended_at IS NOT NULL AND sent_to_painel_at IS NULL;

CREATE TABLE annotation (
    uid        TEXT PRIMARY KEY NOT NULL,
    book_uid   TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('highlight', 'underline', 'note', 'bookmark')),
    page       INTEGER CHECK (page IS NULL OR page >= 0),
    cfi        TEXT,
    quads      TEXT CHECK (quads IS NULL OR json_valid(quads)),
    text       TEXT,
    color      TEXT,
    comment    TEXT,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    CHECK (page IS NOT NULL OR cfi IS NOT NULL)
) STRICT;
CREATE INDEX annotation_book ON annotation (book_uid, page);
CREATE INDEX annotation_updated_at ON annotation (updated_at);

-- Cache, rebuildable.
CREATE TABLE book_text (
    book_uid TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    unit     INTEGER NOT NULL CHECK (unit >= 0),
    label    TEXT,
    text     TEXT NOT NULL,
    PRIMARY KEY (book_uid, unit)
) STRICT;

-- OCR words; syncs as the derived `.ocr` file, not as rows.
CREATE TABLE ocr_word (
    book_uid TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    page     INTEGER NOT NULL CHECK (page >= 0),
    words    TEXT NOT NULL CHECK (json_valid(words)),
    PRIMARY KEY (book_uid, page)
) STRICT;

CREATE TABLE notetype_mapping (
    anki_notetype_id INTEGER PRIMARY KEY NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('vocab', 'code_command', 'code_program')),
    fields           TEXT NOT NULL CHECK (json_valid(fields)),
    updated_at       INTEGER NOT NULL,
    deleted          INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE INDEX notetype_mapping_updated_at ON notetype_mapping (updated_at);

CREATE TABLE code_note_extra (
    note_id    INTEGER PRIMARY KEY NOT NULL,
    accepted   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accepted)),
    requires   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(requires)),
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE INDEX code_note_extra_updated_at ON code_note_extra (updated_at);

-- Cache, doesn't sync. Metric columns stay NULL until the scan finishes.
CREATE TABLE vocab_scan (
    uid               TEXT PRIMARY KEY NOT NULL,
    book_uid          TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    created_at        INTEGER NOT NULL,
    root_deck_id      INTEGER NOT NULL,
    deck_ids          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(deck_ids)),
    config            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
    total_tokens      INTEGER,
    cov_known         REAL,
    cov_with_learning REAL,
    unknown_lemmas    INTEGER,
    words_to_95       INTEGER,
    words_to_98       INTEGER,
    status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'done', 'failed', 'cancelled'))
) STRICT;
CREATE INDEX vocab_scan_book ON vocab_scan (book_uid, created_at);

-- Cache, rebuildable.
CREATE TABLE book_lemma (
    book_uid     TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    lemma        TEXT NOT NULL,
    pos          TEXT,
    occurrences  INTEGER NOT NULL CHECK (occurrences >= 0),
    first_unit   INTEGER NOT NULL CHECK (first_unit >= 0),
    example      TEXT,
    example_span TEXT CHECK (example_span IS NULL OR json_valid(example_span)),
    units        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(units)),
    is_proper    INTEGER NOT NULL DEFAULT 0 CHECK (is_proper IN (0, 1)),
    zipf         REAL,
    PRIMARY KEY (book_uid, lemma)
) STRICT;

CREATE TABLE vocab_override (
    lemma      TEXT PRIMARY KEY NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('known', 'ignored', 'proper')),
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE INDEX vocab_override_updated_at ON vocab_override (updated_at);

CREATE TABLE vocab_enrichment_cache (
    lemma        TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    payload      TEXT NOT NULL CHECK (json_valid(payload)),
    PRIMARY KEY (lemma, context_hash)
) STRICT;

CREATE TABLE ai_usage (
    uid        TEXT PRIMARY KEY NOT NULL,
    at         INTEGER NOT NULL,
    feature    TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    tokens_in  INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
    tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
    cost_usd   REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0)
) STRICT;
CREATE INDEX ai_usage_at ON ai_usage (at);

-- Events for the Painel (Appendix A.5).
CREATE TABLE outbox (
    uid        TEXT PRIMARY KEY NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT
) STRICT;
CREATE INDEX outbox_created_at ON outbox (created_at);

-- library-sync cursors.
CREATE TABLE sync_state (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;
"#;

/// Spec 1.1 (sections 6.5 and 14): PDF annotations live inside the PDF (PdfCraft), so the app's
/// annotation table becomes EPUB-only; a book has a current file version with its own hash; the
/// PDF.js renderer choice and the OCR word table are gone.
///
/// Only `ALTER TABLE ADD/DROP COLUMN`, never the rebuild procedure: with `foreign_keys = ON`,
/// dropping and recreating `book` would cascade-delete every child row.
const V2: &str = r#"
ALTER TABLE book ADD COLUMN file_hash TEXT NOT NULL DEFAULT ''
    CHECK (file_hash = '' OR (length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'));
UPDATE book SET file_hash = book_uid;
ALTER TABLE book ADD COLUMN file_version INTEGER NOT NULL DEFAULT 1 CHECK (file_version >= 1);
ALTER TABLE book DROP COLUMN renderer;

ALTER TABLE book_file ADD COLUMN local_hash TEXT
    CHECK (local_hash IS NULL OR (length(local_hash) = 64 AND local_hash NOT GLOB '*[^0-9a-f]*'));
UPDATE book_file SET local_hash = (SELECT file_hash FROM book WHERE book.book_uid = book_file.book_uid)
    WHERE local_path IS NOT NULL;

DROP TABLE annotation;
DROP TABLE ocr_word;

CREATE TABLE epub_annotation (
    uid        TEXT PRIMARY KEY NOT NULL,
    book_uid   TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('highlight', 'underline', 'note', 'bookmark')),
    cfi        TEXT NOT NULL,
    text       TEXT,
    color      TEXT,
    comment    TEXT,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE INDEX epub_annotation_book ON epub_annotation (book_uid);
CREATE INDEX epub_annotation_updated_at ON epub_annotation (updated_at);
"#;

/// Phase 4 (spec 10.1, 10.2): per-book preferences of this device — the deck and type last used for a card from
/// the selection and the deck of "Revisar aqui". Doesn't sync (device-local, section 16).
const V3: &str = r#"
-- Doesn't sync: device-local preferences.
CREATE TABLE book_prefs (
    book_uid          TEXT PRIMARY KEY NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    last_card_deck_id INTEGER NULL,
    last_card_kind    TEXT NULL CHECK (last_card_kind IS NULL OR last_card_kind IN
                          ('basic', 'cloze', 'codeCommand', 'codeProgram', 'vocab')),
    review_deck_id    INTEGER NULL,
    updated_at        INTEGER NOT NULL
) STRICT;
"#;

/// Phase 6 (spec 12.1, 12.3 F, 14): vocabulary scans of a range of the book with their report, and the per-page lemma
/// table (`book_lemma_page`) computed once per version of the book's text, so scanning another range never re-reads
/// the PDF. `book_lemma_state` is the table's completeness marker: the rows are valid only when the state row
/// matches the current text version and algorithm (it is written in the same transaction as the rows).
///
/// Only `ALTER TABLE ADD COLUMN` and `CREATE`, never the rebuild procedure (see V2).
const V4: &str = r#"
ALTER TABLE vocab_scan ADD COLUMN range TEXT NOT NULL DEFAULT '{"kind":"all"}' CHECK (json_valid(range));
ALTER TABLE vocab_scan ADD COLUMN text_version TEXT;
ALTER TABLE vocab_scan ADD COLUMN report TEXT CHECK (report IS NULL OR json_valid(report));
ALTER TABLE vocab_scan ADD COLUMN error TEXT;

ALTER TABLE book_lemma ADD COLUMN forms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(forms));
ALTER TABLE book_lemma ADD COLUMN text_version TEXT NOT NULL DEFAULT '';

-- Cache per page, rebuildable; doesn't sync.
CREATE TABLE book_lemma_page (
    book_uid     TEXT NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    lemma        TEXT NOT NULL,
    unit         INTEGER NOT NULL CHECK (unit >= 0),
    occurrences  INTEGER NOT NULL CHECK (occurrences >= 0),
    form         TEXT NOT NULL,
    forms        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(forms)),
    example      TEXT,
    example_span TEXT CHECK (example_span IS NULL OR json_valid(example_span)),
    text_version TEXT NOT NULL,
    PRIMARY KEY (book_uid, lemma, unit)
) STRICT;
CREATE INDEX book_lemma_page_unit ON book_lemma_page (book_uid, unit);

-- Completeness marker of book_lemma/book_lemma_page; doesn't sync.
CREATE TABLE book_lemma_state (
    book_uid     TEXT PRIMARY KEY NOT NULL REFERENCES book (book_uid) ON DELETE CASCADE,
    text_version TEXT NOT NULL,
    algo_version INTEGER NOT NULL,
    page_count   INTEGER NOT NULL CHECK (page_count >= 0),
    built_at     INTEGER NOT NULL,
    -- Repeated header/footer lines removed by the cleanup (JSON list of normalized keys): the highlight skips them.
    repeated_lines TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(repeated_lines))
) STRICT;
"#;

#[cfg(test)]
mod tests {
    use super::*;

    const UID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const UID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .expect("pragma");
        stmt.query_map([], |r| r.get(0))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows")
    }

    fn tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .expect("schema");
        stmt.query_map([], |r| r.get(0))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows")
    }

    /// A real V1 file with data in the tables V2 touches is upgraded in place, rows kept.
    #[test]
    fn v1_database_with_data_migrates_to_v2() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.sqlite");
        {
            let mut conn = Connection::open(&path).expect("open");
            conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
            let tx = conn.transaction().expect("tx");
            tx.execute_batch(V1).expect("v1");
            tx.execute_batch("PRAGMA user_version = 1")
                .expect("version");
            tx.commit().expect("commit");
            conn.execute_batch(&format!(
                r#"
                INSERT INTO book (book_uid, title, format, file_name, pages, renderer, added_at, updated_at)
                    VALUES ('{UID_A}', 'Livro A', 'pdf', 'a.pdf', 10, 'pdfjs', 1, 2),
                           ('{UID_B}', 'Livro B', 'epub', 'b.epub', 0, 'pdfcraft', 3, 4);
                INSERT INTO book_file (book_uid, local_path, downloaded)
                    VALUES ('{UID_A}', '/books/a.pdf', 1), ('{UID_B}', NULL, 0);
                INSERT INTO reading_position (book_uid, page, progress, updated_at)
                    VALUES ('{UID_A}', 7, 0.7, 5);
                INSERT INTO reading_session (uid, book_uid, started_at, ended_at, last_heartbeat_at, pages)
                    VALUES ('s1', '{UID_A}', 100, 200, 190, '[1,2]');
                INSERT INTO annotation (uid, book_uid, kind, page, updated_at)
                    VALUES ('n1', '{UID_A}', 'highlight', 1, 6);
                INSERT INTO ocr_word (book_uid, page, words) VALUES ('{UID_A}', 0, '[]');
                "#
            ))
            .expect("v1 rows");
        }

        let mut conn = Connection::open(&path).expect("reopen");
        conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
        migrate(&mut conn).expect("migrate");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("version");
        // Later migrations run too; the V2 changes are checked below.
        assert_eq!(version, SCHEMA_VERSION);

        let book_cols = columns(&conn, "book");
        assert!(!book_cols.iter().any(|c| c == "renderer"), "{book_cols:?}");
        assert!(book_cols.iter().any(|c| c == "file_hash"));
        assert!(book_cols.iter().any(|c| c == "file_version"));
        assert!(
            columns(&conn, "book_file")
                .iter()
                .any(|c| c == "local_hash")
        );
        let t = tables(&conn);
        assert!(t.iter().any(|n| n == "epub_annotation"), "{t:?}");
        assert!(
            !t.iter().any(|n| n == "annotation" || n == "ocr_word"),
            "{t:?}"
        );

        let books: Vec<(String, String, String, i64)> = conn
            .prepare("SELECT book_uid, title, file_hash, file_version FROM book ORDER BY book_uid")
            .expect("prepare")
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows");
        assert_eq!(
            books,
            [
                (UID_A.into(), "Livro A".into(), UID_A.into(), 1),
                (UID_B.into(), "Livro B".into(), UID_B.into(), 1),
            ]
        );
        let files: Vec<(String, Option<String>, Option<String>)> = conn
            .prepare("SELECT book_uid, local_path, local_hash FROM book_file ORDER BY book_uid")
            .expect("prepare")
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows");
        assert_eq!(
            files,
            [
                (
                    UID_A.into(),
                    Some("/books/a.pdf".into()),
                    Some(UID_A.into())
                ),
                (UID_B.into(), None, None),
            ]
        );
        let (page, sessions): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT page FROM reading_position), (SELECT count(*) FROM reading_session)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("children");
        assert_eq!((page, sessions), (7, 1), "children survive the migration");

        // The new constraints hold.
        assert!(
            conn.execute(
                &format!("UPDATE book SET file_version = 0 WHERE book_uid = '{UID_A}'"),
                []
            )
            .is_err()
        );
        assert!(
            conn.execute(
                &format!("UPDATE book SET file_hash = 'XYZ' WHERE book_uid = '{UID_A}'"),
                []
            )
            .is_err()
        );
        assert!(
            conn.execute(
                &format!(
                    "INSERT INTO epub_annotation (uid, book_uid, kind, cfi, updated_at) VALUES ('e', '{UID_B}', 'scribble', 'epubcfi(/6/2)', 0)"
                ),
                []
            )
            .is_err()
        );
        conn.execute(
            &format!(
                "INSERT INTO epub_annotation (uid, book_uid, kind, cfi, updated_at) VALUES ('e', '{UID_B}', 'note', 'epubcfi(/6/2)', 0)"
            ),
            [],
        )
        .expect("epub annotation");
        // Running the migrations again changes nothing.
        migrate(&mut conn).expect("idempotent");
    }

    /// A real V2 file with books is upgraded to V3: rows kept, `book_prefs` usable and constrained.
    #[test]
    fn v2_database_with_data_migrates_to_v3() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.sqlite");
        {
            let mut conn = Connection::open(&path).expect("open");
            conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
            for (i, sql) in [V1, V2].iter().enumerate() {
                let tx = conn.transaction().expect("tx");
                tx.execute_batch(sql).expect("migration");
                tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))
                    .expect("version");
                tx.commit().expect("commit");
            }
            conn.execute_batch(&format!(
                r#"
                INSERT INTO book (book_uid, title, format, file_name, pages, content_deck_id, file_hash, added_at, updated_at)
                    VALUES ('{UID_A}', 'Livro A', 'pdf', 'a.pdf', 10, 42, '{UID_A}', 1, 2),
                           ('{UID_B}', 'Livro B', 'epub', 'b.epub', 0, NULL, '{UID_B}', 3, 4);
                INSERT INTO reading_position (book_uid, page, progress, updated_at)
                    VALUES ('{UID_A}', 7, 0.7, 5);
                "#
            ))
            .expect("v2 rows");
        }

        let mut conn = Connection::open(&path).expect("reopen");
        conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
        migrate(&mut conn).expect("migrate");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
        const { assert!(SCHEMA_VERSION >= 3) };
        assert!(tables(&conn).iter().any(|t| t == "book_prefs"));
        assert_eq!(
            columns(&conn, "book_prefs"),
            [
                "book_uid",
                "last_card_deck_id",
                "last_card_kind",
                "review_deck_id",
                "updated_at"
            ]
        );
        let (books, deck, page): (i64, i64, i64) = conn
            .query_row(
                &format!(
                    "SELECT (SELECT count(*) FROM book),
                            (SELECT content_deck_id FROM book WHERE book_uid = '{UID_A}'),
                            (SELECT page FROM reading_position)"
                ),
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("rows");
        assert_eq!(
            (books, deck, page),
            (2, 42, 7),
            "data survives the migration"
        );

        conn.execute(
            &format!(
                "INSERT INTO book_prefs (book_uid, last_card_deck_id, last_card_kind, updated_at)
                 VALUES ('{UID_A}', 5, 'cloze', 1)"
            ),
            [],
        )
        .expect("prefs row");
        assert!(
            conn.execute(
                &format!(
                    "INSERT INTO book_prefs (book_uid, last_card_kind, updated_at) VALUES ('{UID_B}', 'essay', 1)"
                ),
                []
            )
            .is_err(),
            "unknown card kind"
        );
        let unknown = "c".repeat(64);
        assert!(
            conn.execute(
                &format!("INSERT INTO book_prefs (book_uid, updated_at) VALUES ('{unknown}', 1)"),
                []
            )
            .is_err(),
            "foreign key"
        );
        migrate(&mut conn).expect("idempotent");
    }

    /// A real V3 file with a book, a scan, lemmas and mappings is upgraded to V4: rows kept, the new columns get
    /// their defaults, the new tables are usable and constrained.
    #[test]
    fn v3_database_with_data_migrates_to_v4() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.sqlite");
        {
            let mut conn = Connection::open(&path).expect("open");
            conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
            for (i, sql) in [V1, V2, V3].iter().enumerate() {
                let tx = conn.transaction().expect("tx");
                tx.execute_batch(sql).expect("migration");
                tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))
                    .expect("version");
                tx.commit().expect("commit");
            }
            conn.execute_batch(&format!(
                r#"
                INSERT INTO book (book_uid, title, format, file_name, pages, file_hash, added_at, updated_at)
                    VALUES ('{UID_A}', 'Livro A', 'pdf', 'a.pdf', 10, '{UID_A}', 1, 2);
                INSERT INTO vocab_scan (uid, book_uid, created_at, root_deck_id, deck_ids, config, total_tokens,
                                        cov_known, status)
                    VALUES ('s1', '{UID_A}', 10, 5, '[5,6]', '{{"a":1}}', 100, 0.9, 'done');
                INSERT INTO book_lemma (book_uid, lemma, occurrences, first_unit, units)
                    VALUES ('{UID_A}', 'windmill', 3, 2, '[2,4]');
                INSERT INTO notetype_mapping (anki_notetype_id, role, fields, updated_at)
                    VALUES (7, 'vocab', '{{"word":"Word"}}', 1);
                INSERT INTO book_prefs (book_uid, last_card_kind, updated_at) VALUES ('{UID_A}', 'vocab', 3);
                "#
            ))
            .expect("v3 rows");
        }

        let mut conn = Connection::open(&path).expect("reopen");
        conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
        migrate(&mut conn).expect("migrate");
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
        const { assert!(SCHEMA_VERSION >= 4) };
        let t = tables(&conn);
        assert!(t.iter().any(|n| n == "book_lemma_page"), "{t:?}");
        assert!(t.iter().any(|n| n == "book_lemma_state"), "{t:?}");
        for col in ["range", "text_version", "report", "error"] {
            assert!(
                columns(&conn, "vocab_scan").iter().any(|c| c == col),
                "{col}"
            );
        }
        for col in ["forms", "text_version"] {
            assert!(
                columns(&conn, "book_lemma").iter().any(|c| c == col),
                "{col}"
            );
        }

        let (range, total, report): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT range, total_tokens, report FROM vocab_scan WHERE uid = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("scan");
        assert_eq!(
            (range.as_str(), total, report),
            (r#"{"kind":"all"}"#, 100, None)
        );
        let (forms, version, units): (String, String, String) = conn
            .query_row(
                "SELECT forms, text_version, units FROM book_lemma WHERE lemma = 'windmill'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("lemma");
        assert_eq!(
            (forms.as_str(), version.as_str(), units.as_str()),
            ("[]", "", "[2,4]")
        );
        let (mappings, prefs): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM notetype_mapping), (SELECT count(*) FROM book_prefs)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("counts");
        assert_eq!((mappings, prefs), (1, 1), "data survives the migration");

        // The new constraints hold.
        assert!(
            conn.execute(
                "UPDATE vocab_scan SET range = 'not json' WHERE uid = 's1'",
                []
            )
            .is_err()
        );
        assert!(
            conn.execute("UPDATE vocab_scan SET report = '{' WHERE uid = 's1'", [])
                .is_err()
        );
        let page = |lemma: &str, unit: i64, occ: i64, forms: &str| {
            conn.execute(
                &format!(
                    "INSERT INTO book_lemma_page (book_uid, lemma, unit, occurrences, form, forms, text_version)
                     VALUES ('{UID_A}', '{lemma}', {unit}, {occ}, '{lemma}', '{forms}', 'v1')"
                ),
                [],
            )
        };
        page("windmill", 2, 1, "[]").expect("page row");
        assert!(page("windmill", 2, 1, "[]").is_err(), "primary key");
        assert!(page("farm", -1, 1, "[]").is_err(), "unit >= 0");
        assert!(page("farm", 1, -1, "[]").is_err(), "occurrences >= 0");
        assert!(page("farm", 1, 1, "x").is_err(), "forms is JSON");
        let unknown = "c".repeat(64);
        assert!(
            conn.execute(
                &format!(
                    "INSERT INTO book_lemma_state (book_uid, text_version, algo_version, page_count, built_at)
                     VALUES ('{unknown}', 'v', 1, 1, 1)"
                ),
                [],
            )
            .is_err(),
            "foreign key"
        );
        conn.execute(
            &format!(
                "INSERT INTO book_lemma_state (book_uid, text_version, algo_version, page_count, built_at)
                 VALUES ('{UID_A}', 'v', 1, 10, 1)"
            ),
            [],
        )
        .expect("state row");
        // Deleting the book cascades to the new tables.
        conn.execute(&format!("DELETE FROM book WHERE book_uid = '{UID_A}'"), [])
            .expect("delete");
        let left: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM book_lemma_page) + (SELECT count(*) FROM book_lemma_state)",
                [],
                |r| r.get(0),
            )
            .expect("left");
        assert_eq!(left, 0);
        migrate(&mut conn).expect("idempotent");
    }
}
