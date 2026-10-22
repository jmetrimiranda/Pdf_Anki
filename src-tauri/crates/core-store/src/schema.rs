//! Versioned migrations keyed on `PRAGMA user_version`. Migration `i` (0-based) upgrades the
//! schema from version `i` to `i + 1`. Never edit a shipped migration: append a new one.

use rusqlite::Connection;

use crate::{Result, StoreError};

const MIGRATIONS: &[&str] = &[V1];

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
