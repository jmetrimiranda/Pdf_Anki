//! The app's own SQLite database (docs/PROJETO.md 14). The Anki collection lives in its own file and
//! is owned by `core-anki`; this crate keeps everything else: library and file versions, reading
//! positions and sessions ([`ReadingTracker`], spec 6.4), EPUB annotations (PDF annotations live
//! inside the PDF, spec 6.5), per-book preferences of this device, settings, code-card mappings and
//! extras (spec 11.1), the vocabulary scans, lemma tables, overrides and mappings (spec 12), AI usage and the
//! outbox.
//!
//! Conventions:
//! - **Timestamps** (`added_at`, `updated_at`, `started_at`, …) are `INTEGER` Unix epoch
//!   **milliseconds in UTC** ([`now_ms`]). They compare and sort numerically and need no parsing.
//! - **Sync columns** (section 16): every record that syncs between devices has a stable key
//!   (`book_uid`, an Anki id or a UUID `uid`), `updated_at` and `deleted` (0/1 tombstone). Every
//!   write through this crate bumps `updated_at`; removals are soft deletes.
//! - **Booleans** are `INTEGER` 0/1 and **JSON** columns are `TEXT` checked with `json_valid`.
//! - Tables are `STRICT`; enum-like columns carry `CHECK` constraints.
//!
//! [`Store`] wraps one [`rusqlite::Connection`]; it is `Send` but not `Sync`, so share it behind a
//! `Mutex` (or give it its own thread).

mod code;
mod error;
mod library;
mod prefs;
mod schema;
mod sessions;
mod settings;
mod vocab;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

pub use code::{
    CODE_EXTRA_MAX_CHARS, CODE_EXTRA_MAX_ENTRIES, CodeMappingFields, CodeMappingRow, CodeNoteExtra,
    CodeRole,
};
pub use error::{Result, StoreError};
pub use library::{
    AddOutcome, AddedBook, Book, BookFormat, BookPatch, FileVersion, LibraryEntry, NewBook,
    OcrStatus, ReadingPosition, book_uid_of, book_uid_of_reader, is_valid_book_uid,
};
pub use prefs::{BookPrefs, BookPrefsPatch, CARD_KINDS};
pub use schema::SCHEMA_VERSION;
pub use sessions::{
    Clock, ClosedSession, ManualClock, OpenSessionInfo, ReadingSessionRow, ReadingTracker,
    RecoveryReport, StopReason, SystemClock,
};
pub use settings::keys as setting_keys;
pub use settings::{VocabDerivedPolicy, VocabSettings, VocabSuspendedPolicy};
pub use vocab::{
    BookLemmaPageRow, BookLemmaRow, NewVocabScan, VOCAB_RANGE_ALL, VocabMappingRow,
    VocabOverrideStatus, VocabScanMetrics, VocabScanRow, VocabScanStatus, VocabTableState,
};

/// Handle to the app database.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Opens (creating if needed) the database at `path`, enables WAL and foreign keys, and runs
    /// pending migrations. Parent directories are created.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(StoreError::Io)?;
        }
        let conn = Connection::open(path)?;
        // `journal_mode` returns the resulting mode as a row.
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    /// An in-memory database (tests and tooling). No WAL: it doesn't apply to memory databases.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        schema::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// The schema version currently stored in `PRAGMA user_version`.
    pub fn schema_version(&self) -> Result<u32> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    /// Escape hatch for code in this workspace that needs tables without a typed API yet.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

/// Current time as Unix epoch milliseconds (UTC). A clock before 1970 yields 0.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
