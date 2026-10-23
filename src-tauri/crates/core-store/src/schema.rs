//! Versioned migrations keyed on `PRAGMA user_version`. Migration `i` (0-based) upgrades the
//! schema from version `i` to `i + 1`. Never edit a shipped migration: append a new one.

use rusqlite::Connection;

use crate::{Result, StoreError};

const MIGRATIONS: &[&str] = &[V1, V2];

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
        assert_eq!(version, 2);

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
}
