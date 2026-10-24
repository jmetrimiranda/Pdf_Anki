//! The server's SQLite: the records of every device (last write wins per key, a server sequence as the cursor), the
//! devices and their token hashes, the current file of each book and the uploads in progress.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

pub type Result<T> = rusqlite::Result<T>;

/// Kinds of records that sync (spec 16).
pub const KINDS: [&str; 6] = [
    "book",
    "reading_position",
    "epub_annotation",
    "vocab_override",
    "notetype_mapping",
    "code_note_extra",
];
/// Longest key (a lemma, a uid, a note id).
pub const MAX_KEY_LEN: usize = 200;
/// Largest record data (JSON).
pub const MAX_DATA_LEN: usize = 256 * 1024;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS record (
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    data       TEXT NOT NULL,
    seq        INTEGER NOT NULL UNIQUE,
    device     TEXT NOT NULL,
    -- When the server received this version (the cleanup's clock, never a device's).
    stored_at  INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
) STRICT;
CREATE INDEX IF NOT EXISTS record_seq ON record (seq);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', 0);
-- Identity of this database: a client whose cursor came from another one (a new volume) starts over.
INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', abs(random()));

CREATE TABLE IF NOT EXISTS device (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS file (
    book_uid   TEXT PRIMARY KEY NOT NULL,
    hash       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS upload (
    id         TEXT PRIMARY KEY NOT NULL,
    book_uid   TEXT NOT NULL,
    base       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    parts      INTEGER NOT NULL,
    device     TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
"#;

/// One record as it travels (camelCase JSON). `data` is kept as the client sent it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub kind: String,
    pub key: String,
    pub updated_at: i64,
    pub deleted: bool,
    pub data: Box<RawValue>,
    /// Set by the server.
    #[serde(default, skip_deserializing)]
    pub seq: i64,
}

impl PartialEq for Record {
    fn eq(&self, o: &Self) -> bool {
        self.kind == o.kind
            && self.key == o.key
            && self.updated_at == o.updated_at
            && self.deleted == o.deleted
            && self.data.get() == o.data.get()
            && self.seq == o.seq
    }
}

/// Outcome of one pushed record.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum PushResult {
    /// Stored with this sequence number.
    Accepted { kind: String, key: String, seq: i64 },
    /// The server has a newer version: here it is.
    Stale { current: Record },
}

/// The current file of a book.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub book_uid: String,
    pub hash: String,
    pub version: i64,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRow {
    pub id: String,
    pub book_uid: String,
    pub base: String,
    pub hash: String,
    pub size: i64,
    pub parts: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRow {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub last_seen: i64,
    pub revoked: bool,
}

pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    // FULL: a commit survives a power loss (WAL + NORMAL may roll back the last ones, and with them the sequence).
    conn.pragma_update(None, "synchronous", "FULL")?;
    init(conn)
}

pub fn open_in_memory() -> Result<Connection> {
    init(Connection::open_in_memory()?)
}

fn init(conn: Connection) -> Result<Connection> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

fn record_row(r: &rusqlite::Row<'_>) -> Result<Record> {
    let data: String = r.get(4)?;
    Ok(Record {
        kind: r.get(0)?,
        key: r.get(1)?,
        updated_at: r.get(2)?,
        deleted: r.get(3)?,
        data: RawValue::from_string(data).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?,
        seq: r.get(5)?,
    })
}

const RECORD_COLUMNS: &str = "kind, key, updated_at, deleted, data, seq";

/// Records after `since`, in sequence order, at most `limit`.
pub fn changes(conn: &Connection, since: i64, limit: u32) -> Result<Vec<Record>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RECORD_COLUMNS} FROM record WHERE seq > ?1 ORDER BY seq LIMIT ?2"
    ))?;
    stmt.query_map(params![since, limit], record_row)?.collect()
}

pub fn get(conn: &Connection, kind: &str, key: &str) -> Result<Option<Record>> {
    conn.query_row(
        &format!("SELECT {RECORD_COLUMNS} FROM record WHERE kind = ?1 AND key = ?2"),
        params![kind, key],
        record_row,
    )
    .optional()
}

/// The highest sequence number given out.
pub fn cursor(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT value FROM meta WHERE key = 'seq'", [], |r| r.get(0))
}

/// A database whose sequence is behind `mark` (the highest number ever given out, kept outside the file) was
/// restored from a backup: the sequence jumps to the mark (numbers are never reused) and the identity changes, so
/// every device starts over. Returns whether it did.
pub fn recover_sequence(conn: &mut Connection, mark: i64) -> Result<bool> {
    if cursor(conn)? >= mark {
        return Ok(false);
    }
    jump_sequence(conn, mark)?;
    Ok(true)
}

/// Moves the sequence up to `to` and gives the database a new identity, in one transaction: every device starts
/// over, and no number already handed out is given again.
pub fn jump_sequence(conn: &mut Connection, to: i64) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE meta SET value = max(value, ?1) WHERE key = 'seq'",
        params![to],
    )?;
    tx.execute(
        "UPDATE meta SET value = abs(random()) WHERE key = 'epoch'",
        [],
    )?;
    tx.commit()
}

/// The identity of this database (random, made once).
pub fn epoch(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT value FROM meta WHERE key = 'epoch'", [], |r| {
        r.get(0)
    })
}

/// Applies pushed records in one transaction: per key, the newer `updated_at` wins; a tie goes to the record that
/// arrives last (this one).
pub fn push(
    conn: &mut Connection,
    records: Vec<Record>,
    device: &str,
    now: i64,
) -> Result<Vec<PushResult>> {
    let tx = conn.transaction()?;
    let mut seq: i64 =
        tx.query_row("SELECT value FROM meta WHERE key = 'seq'", [], |r| r.get(0))?;
    let mut out = Vec::with_capacity(records.len());
    for rec in records {
        let current = tx
            .query_row(
                &format!("SELECT {RECORD_COLUMNS} FROM record WHERE kind = ?1 AND key = ?2"),
                params![rec.kind, rec.key],
                record_row,
            )
            .optional()?;
        if let Some(cur) = current
            && cur.updated_at > rec.updated_at
        {
            out.push(PushResult::Stale { current: cur });
            continue;
        }
        seq += 1;
        tx.execute(
            "INSERT INTO record (kind, key, updated_at, deleted, data, seq, device, stored_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (kind, key) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted,
                data = excluded.data, seq = excluded.seq, device = excluded.device, stored_at = excluded.stored_at",
            params![rec.kind, rec.key, rec.updated_at, rec.deleted, rec.data.get(), seq, device, now],
        )?;
        out.push(PushResult::Accepted {
            kind: rec.kind,
            key: rec.key,
            seq,
        });
    }
    tx.execute("UPDATE meta SET value = ?1 WHERE key = 'seq'", params![seq])?;
    tx.commit()?;
    Ok(out)
}

/// Tombstones the server received before `before` (epoch ms, server clock) are forgotten.
pub fn purge_tombstones(conn: &Connection, before: i64) -> Result<usize> {
    conn.execute(
        "DELETE FROM record WHERE deleted = 1 AND stored_at < ?1",
        params![before],
    )
}

/// Books whose deletion the server received before `before`: their files go.
pub fn deleted_books(conn: &Connection, before: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT f.book_uid FROM file f JOIN record r ON r.kind = 'book' AND r.key = f.book_uid
         WHERE r.deleted = 1 AND r.stored_at < ?1",
    )?;
    stmt.query_map(params![before], |r| r.get(0))?.collect()
}

// ---------------------------------------------------------------- devices

pub fn add_device(conn: &Connection, name: &str, token_hash: &str, now: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO device (name, token_hash, created_at, last_seen) VALUES (?1, ?2, ?3, ?3)",
        params![name, token_hash, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The live device of a token hash; refreshes its `last_seen`.
pub fn device_by_token(
    conn: &Connection,
    token_hash: &str,
    now: i64,
) -> Result<Option<(i64, String)>> {
    let found: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, name FROM device WHERE token_hash = ?1 AND revoked = 0",
            params![token_hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((id, _)) = &found {
        conn.execute(
            "UPDATE device SET last_seen = ?1 WHERE id = ?2",
            params![now, id],
        )?;
    }
    Ok(found)
}

pub fn revoke_device(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE device SET revoked = 1 WHERE id = ?1 AND revoked = 0",
        params![id],
    )? == 1)
}

/// Revokes every live device with this name. Returns how many.
pub fn revoke_device_named(conn: &Connection, name: &str) -> Result<usize> {
    conn.execute(
        "UPDATE device SET revoked = 1 WHERE name = ?1 AND revoked = 0",
        params![name],
    )
}

pub fn devices(conn: &Connection) -> Result<Vec<DeviceRow>> {
    let mut stmt =
        conn.prepare("SELECT id, name, created_at, last_seen, revoked FROM device ORDER BY id")?;
    stmt.query_map([], |r| {
        Ok(DeviceRow {
            id: r.get(0)?,
            name: r.get(1)?,
            created_at: r.get(2)?,
            last_seen: r.get(3)?,
            revoked: r.get(4)?,
        })
    })?
    .collect()
}

// ---------------------------------------------------------------- files and uploads

pub fn file(conn: &Connection, book_uid: &str) -> Result<Option<FileRow>> {
    conn.query_row(
        "SELECT book_uid, hash, version, size FROM file WHERE book_uid = ?1",
        params![book_uid],
        |r| {
            Ok(FileRow {
                book_uid: r.get(0)?,
                hash: r.get(1)?,
                version: r.get(2)?,
                size: r.get(3)?,
            })
        },
    )
    .optional()
}

/// The current file of every book.
pub fn files(conn: &Connection) -> Result<Vec<FileRow>> {
    let mut stmt =
        conn.prepare("SELECT book_uid, hash, version, size FROM file ORDER BY book_uid")?;
    stmt.query_map([], |r| {
        Ok(FileRow {
            book_uid: r.get(0)?,
            hash: r.get(1)?,
            version: r.get(2)?,
            size: r.get(3)?,
        })
    })?
    .collect()
}

pub fn set_file(conn: &Connection, f: &FileRow, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO file (book_uid, hash, version, size, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (book_uid) DO UPDATE SET hash = excluded.hash, version = excluded.version,
            size = excluded.size, updated_at = excluded.updated_at",
        params![f.book_uid, f.hash, f.version, f.size, now],
    )?;
    Ok(())
}

pub fn remove_file(conn: &Connection, book_uid: &str) -> Result<()> {
    conn.execute("DELETE FROM file WHERE book_uid = ?1", params![book_uid])?;
    Ok(())
}

pub fn add_upload(conn: &Connection, u: &UploadRow, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO upload (id, book_uid, base, hash, size, parts, device, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            u.id,
            u.book_uid,
            u.base,
            u.hash,
            u.size,
            u.parts,
            device,
            u.created_at
        ],
    )?;
    Ok(())
}

pub fn upload(conn: &Connection, id: &str) -> Result<Option<UploadRow>> {
    conn.query_row(
        "SELECT id, book_uid, base, hash, size, parts, created_at FROM upload WHERE id = ?1",
        params![id],
        |r| {
            Ok(UploadRow {
                id: r.get(0)?,
                book_uid: r.get(1)?,
                base: r.get(2)?,
                hash: r.get(3)?,
                size: r.get(4)?,
                parts: r.get(5)?,
                created_at: r.get(6)?,
            })
        },
    )
    .optional()
}

pub fn remove_upload(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM upload WHERE id = ?1", params![id])?;
    Ok(())
}

/// Uploads started before `before` (abandoned).
pub fn stale_uploads(conn: &Connection, before: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM upload WHERE created_at < ?1")?;
    stmt.query_map(params![before], |r| r.get(0))?.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(kind: &str, key: &str, at: i64, data: &str) -> Record {
        Record {
            kind: kind.into(),
            key: key.into(),
            updated_at: at,
            deleted: false,
            data: RawValue::from_string(data.into()).unwrap(),
            seq: 0,
        }
    }

    #[test]
    fn last_write_wins_and_ties_go_to_the_last_arrival() {
        let mut c = open_in_memory().unwrap();
        let r = push(&mut c, vec![rec("book", "a", 10, r#"{"t":1}"#)], "A", 1).unwrap();
        assert!(matches!(r[0], PushResult::Accepted { seq: 1, .. }));
        // Older: refused with the current version.
        let r = push(&mut c, vec![rec("book", "a", 5, r#"{"t":0}"#)], "B", 2).unwrap();
        let PushResult::Stale { current } = &r[0] else {
            panic!("{r:?}")
        };
        assert_eq!(current.data.get(), r#"{"t":1}"#);
        // Same time: the one arriving last wins.
        let r = push(&mut c, vec![rec("book", "a", 10, r#"{"t":2}"#)], "B", 3).unwrap();
        assert!(matches!(r[0], PushResult::Accepted { seq: 2, .. }));
        assert_eq!(
            get(&c, "book", "a").unwrap().unwrap().data.get(),
            r#"{"t":2}"#
        );
        assert_eq!(cursor(&c).unwrap(), 2);
        let all = changes(&c, 0, 10).unwrap();
        assert_eq!(all.len(), 1, "one row per key, at its latest seq");
        assert_eq!(all[0].seq, 2);
        assert!(changes(&c, 2, 10).unwrap().is_empty());
    }

    #[test]
    fn tombstones_and_deleted_books_are_purged() {
        let mut c = open_in_memory().unwrap();
        let mut t = rec("book", "b", 100, "{}");
        t.deleted = true;
        push(
            &mut c,
            vec![t, rec("vocab_override", "x", 100, "{}")],
            "A",
            100,
        )
        .unwrap();
        set_file(
            &c,
            &FileRow {
                book_uid: "b".into(),
                hash: "h".into(),
                version: 1,
                size: 3,
            },
            100,
        )
        .unwrap();
        assert_eq!(deleted_books(&c, 50).unwrap(), Vec::<String>::new());
        assert_eq!(deleted_books(&c, 200).unwrap(), vec!["b".to_string()]);
        assert_eq!(purge_tombstones(&c, 200).unwrap(), 1);
        assert_eq!(changes(&c, 0, 10).unwrap().len(), 1);
    }

    #[test]
    fn devices_are_found_by_token_and_revoked() {
        let c = open_in_memory().unwrap();
        let id = add_device(&c, "pc-a", "h1", 1).unwrap();
        assert_eq!(
            device_by_token(&c, "h1", 2).unwrap(),
            Some((id, "pc-a".into()))
        );
        assert_eq!(devices(&c).unwrap()[0].last_seen, 2);
        assert_eq!(revoke_device_named(&c, "pc-a").unwrap(), 1);
        assert_eq!(device_by_token(&c, "h1", 3).unwrap(), None);
        assert!(!revoke_device(&c, id).unwrap());
    }
}
