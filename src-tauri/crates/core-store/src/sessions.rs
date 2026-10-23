//! Reading sessions (spec 6.4): continuous intervals of active reading of one book.
//!
//! The app feeds a [`ReadingTracker`] with what it sees: `start`/`activity` while a document is in
//! front of the reader (PdfCraft's `pdfcraft:activity` and `pdfcraft:page`), `stop` when the user
//! switches app tab or document, opens the mini review, hides or closes the window, and `tick`
//! every few seconds so inactivity is noticed. Rules:
//!
//! - One open session at a time. Activity for another book closes the current one (`Doc`).
//! - A session ends after [`IDLE_MS`] without activity; its end is the **last activity**, so idle
//!   time is never counted. Explicit stops end it now (within `IDLE_MS` of the last activity).
//! - While open, the row's `last_heartbeat_at` (= last activity) and `pages` are written at most
//!   every [`HEARTBEAT_MS`], and only if there was activity since the last write. After a crash,
//!   [`ReadingTracker::recover`] closes the row at its last heartbeat.
//! - On close, sessions shorter than [`MIN_MS`] are deleted; longer than [`MAX_MS`] are split into
//!   equal consecutive chunks of at most 12 h (the first keeps the uid). Each page goes to the
//!   chunk in which it was first seen (after a crash, to the first chunk).
//! - `sent_to_painel_at` stays NULL: the outbox to the Painel comes in Phase 9.
//!
//! All times come from an injectable [`Clock`], so the rules are tested without sleeping.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Result, Store, StoreError};

/// Persist the open session at most this often (ms).
pub const HEARTBEAT_MS: i64 = 30_000;
/// A session ends after this long without activity (ms).
pub const IDLE_MS: i64 = 120_000;
/// Shorter sessions are discarded (ms).
pub const MIN_MS: i64 = 60_000;
/// Longer sessions are split (ms).
pub const MAX_MS: i64 = 12 * 3_600_000;

/// Source of the current time, epoch ms UTC.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// The system clock ([`crate::now_ms`]).
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        crate::now_ms()
    }
}

/// A clock moved by hand, for tests (share it as `Arc<ManualClock>`).
#[derive(Debug, Default)]
pub struct ManualClock(pub AtomicI64);

impl ManualClock {
    pub fn new(now_ms: i64) -> Self {
        Self(AtomicI64::new(now_ms))
    }

    pub fn set(&self, now_ms: i64) {
        self.0.store(now_ms, Ordering::SeqCst);
    }

    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

impl<C: Clock + ?Sized> Clock for Arc<C> {
    fn now_ms(&self) -> i64 {
        (**self).now_ms()
    }
}

/// Why a session ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StopReason {
    /// The user left the "Leitor" app tab.
    Tab,
    /// Another document came to the front.
    Doc,
    /// The app went to the background.
    Hidden,
    /// The window is closing.
    Close,
    /// No activity for 2 minutes.
    Idle,
    /// The mini review of the book's Anki panel opened.
    Review,
}

/// The session being recorded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionInfo {
    pub uid: String,
    pub book_uid: String,
    pub started_at: i64,
    pub last_activity_at: i64,
    /// `last_heartbeat_at` as last written to the database.
    pub last_heartbeat_at: i64,
    /// Distinct 0-based pages seen so far, sorted.
    pub pages: Vec<u32>,
}

/// A `reading_session` row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSessionRow {
    pub uid: String,
    pub book_uid: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub last_heartbeat_at: i64,
    /// Distinct 0-based pages, sorted.
    pub pages: Vec<u32>,
    pub sent_to_painel_at: Option<i64>,
}

/// What closing a session produced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedSession {
    pub book_uid: String,
    pub reason: StopReason,
    pub started_at: i64,
    pub ended_at: i64,
    /// Shorter than a minute: the row was deleted.
    pub discarded: bool,
    /// The rows written: one, several after a split, none when discarded.
    pub sessions: Vec<ReadingSessionRow>,
}

/// Sessions left open by a crash and closed at startup.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    /// Rows written (after splitting).
    pub closed: Vec<ReadingSessionRow>,
    /// Open rows deleted for being shorter than a minute.
    pub discarded: usize,
}

struct Open {
    info: OpenSessionInfo,
    /// Page → when it was first seen in this session.
    first_seen: BTreeMap<u32, i64>,
    /// Activity since the last write.
    dirty: bool,
    /// When the row was last written (tracker clock).
    written_at: i64,
}

/// Records reading sessions in the store. See the module docs for the rules.
pub struct ReadingTracker<C: Clock> {
    clock: C,
    open: Option<Open>,
}

impl<C: Clock> ReadingTracker<C> {
    pub const HEARTBEAT_MS: i64 = HEARTBEAT_MS;
    pub const IDLE_MS: i64 = IDLE_MS;
    pub const MIN_MS: i64 = MIN_MS;
    pub const MAX_MS: i64 = MAX_MS;

    pub fn new(clock: C) -> Self {
        Self { clock, open: None }
    }

    pub fn clock(&self) -> &C {
        &self.clock
    }

    /// At startup: every row left open (a crash) is closed at its last heartbeat and finalized
    /// (discarded if short, split if long). The tracker's own open session, if any, is skipped.
    pub fn recover(&mut self, store: &mut Store) -> Result<RecoveryReport> {
        let own = self.open.as_ref().map(|o| o.info.uid.clone());
        let mut stmt = store.conn.prepare(
            "SELECT uid, book_uid, started_at, last_heartbeat_at, pages FROM reading_session
             WHERE ended_at IS NULL ORDER BY started_at",
        )?;
        let open: Vec<(String, String, i64, i64, String)> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let mut report = RecoveryReport::default();
        for (uid, book_uid, started_at, heartbeat, pages) in open {
            if own.as_deref() == Some(uid.as_str()) {
                continue;
            }
            // All pages go to the first chunk: their times were lost with the crash.
            let pages: Vec<(u32, i64)> = parse_pages(&pages)
                .into_iter()
                .map(|p| (p, started_at))
                .collect();
            let ended_at = heartbeat.max(started_at);
            let rows = store.finalize_session(&uid, &book_uid, started_at, ended_at, &pages)?;
            if rows.is_empty() {
                report.discarded += 1;
            }
            report.closed.extend(rows);
        }
        Ok(report)
    }

    /// Starts recording `book_uid` at `page`; returns the session uid. If that book's session is
    /// already open and active, this is just activity. Another book's session is stopped first.
    pub fn start(&mut self, store: &mut Store, book_uid: &str, page: u32) -> Result<String> {
        let now = self.clock.now_ms();
        if let Some(open) = &mut self.open
            && open.info.book_uid == book_uid
            && now - open.info.last_activity_at < IDLE_MS
        {
            open.touch(page, now);
            let uid = open.info.uid.clone();
            self.persist_if_due(store, now)?;
            return Ok(uid);
        }
        if self.open.is_some() {
            self.stop(store, StopReason::Doc)?;
        }
        if store.get_book(book_uid)?.is_none() {
            return Err(StoreError::BookNotFound(book_uid.to_owned()));
        }
        let uid = uuid::Uuid::new_v4().to_string();
        store.conn.execute(
            "INSERT INTO reading_session (uid, book_uid, started_at, last_heartbeat_at, pages)
             VALUES (?1, ?2, ?3, ?3, ?4)",
            params![uid, book_uid, now, pages_json(&[page])],
        )?;
        self.open = Some(Open {
            info: OpenSessionInfo {
                uid: uid.clone(),
                book_uid: book_uid.to_owned(),
                started_at: now,
                last_activity_at: now,
                last_heartbeat_at: now,
                pages: vec![page],
            },
            first_seen: BTreeMap::from([(page, now)]),
            dirty: false,
            written_at: now,
        });
        Ok(uid)
    }

    /// The reader is active on `page` of `book_uid` (a heartbeat). Starts a session if none is
    /// open or another book's is; after a gap of [`IDLE_MS`] the old session is closed at its last
    /// activity and a new one starts.
    pub fn activity(&mut self, store: &mut Store, book_uid: &str, page: u32) -> Result<()> {
        let now = self.clock.now_ms();
        match &mut self.open {
            Some(open)
                if open.info.book_uid == book_uid && now - open.info.last_activity_at < IDLE_MS =>
            {
                open.touch(page, now);
                self.persist_if_due(store, now)
            }
            _ => self.start(store, book_uid, page).map(|_| ()),
        }
    }

    /// Ends the open session, if any. `Idle` (or a session already idle) ends at the last
    /// activity; the other reasons end now.
    pub fn stop(&mut self, store: &mut Store, reason: StopReason) -> Result<Option<ClosedSession>> {
        let Some(open) = self.open.take() else {
            return Ok(None);
        };
        let now = self.clock.now_ms();
        let idle = now - open.info.last_activity_at >= IDLE_MS;
        let (reason, ended_at) = if reason == StopReason::Idle || idle {
            (StopReason::Idle, open.info.last_activity_at)
        } else {
            (reason, now)
        };
        let started_at = open.info.started_at;
        let ended_at = ended_at.max(started_at);
        let pages: Vec<(u32, i64)> = open.first_seen.into_iter().collect();
        let sessions = store.finalize_session(
            &open.info.uid,
            &open.info.book_uid,
            started_at,
            ended_at,
            &pages,
        )?;
        Ok(Some(ClosedSession {
            book_uid: open.info.book_uid,
            reason,
            started_at,
            ended_at,
            discarded: sessions.is_empty(),
            sessions,
        }))
    }

    /// Like [`stop`](Self::stop), but only if the open session is `book_uid`'s: a late stop for a
    /// book the reader already left must not close the session of the book now in front.
    pub fn stop_book(
        &mut self,
        store: &mut Store,
        book_uid: &str,
        reason: StopReason,
    ) -> Result<Option<ClosedSession>> {
        match &self.open {
            Some(open) if open.info.book_uid == book_uid => self.stop(store, reason),
            _ => Ok(None),
        }
    }

    /// Call every few seconds: closes an idle session at its last activity and writes a due
    /// heartbeat.
    pub fn tick(&mut self, store: &mut Store) -> Result<()> {
        let now = self.clock.now_ms();
        let Some(open) = &self.open else {
            return Ok(());
        };
        if now - open.info.last_activity_at >= IDLE_MS {
            self.stop(store, StopReason::Idle)?;
            return Ok(());
        }
        self.persist_if_due(store, now)
    }

    /// The session being recorded, if any.
    pub fn current(&self) -> Option<&OpenSessionInfo> {
        self.open.as_ref().map(|o| &o.info)
    }

    fn persist_if_due(&mut self, store: &mut Store, now: i64) -> Result<()> {
        let Some(open) = &mut self.open else {
            return Ok(());
        };
        if !open.dirty || now - open.written_at < HEARTBEAT_MS {
            return Ok(());
        }
        let heartbeat = open.info.last_activity_at;
        store.conn.execute(
            "UPDATE reading_session SET last_heartbeat_at = ?2, pages = ?3
             WHERE uid = ?1 AND ended_at IS NULL",
            params![open.info.uid, heartbeat, pages_json(&open.info.pages)],
        )?;
        open.info.last_heartbeat_at = heartbeat;
        open.dirty = false;
        open.written_at = now;
        Ok(())
    }
}

impl Open {
    fn touch(&mut self, page: u32, now: i64) {
        self.info.last_activity_at = now;
        self.dirty = true;
        if let std::collections::btree_map::Entry::Vacant(e) = self.first_seen.entry(page) {
            e.insert(now);
            self.info.pages = self.first_seen.keys().copied().collect();
        }
    }
}

fn pages_json(pages: &[u32]) -> String {
    let mut v = pages.to_vec();
    v.sort_unstable();
    v.dedup();
    serde_json::to_string(&v).unwrap_or_else(|_| "[]".into())
}

/// Tolerant: a malformed column reads as no pages rather than failing recovery.
fn parse_pages(json: &str) -> Vec<u32> {
    let mut v: Vec<u32> = serde_json::from_str(json).unwrap_or_default();
    v.sort_unstable();
    v.dedup();
    v
}

/// `n` equal consecutive chunks of `[start, end)`, each at most [`MAX_MS`]: the `n + 1` bounds.
fn chunk_bounds(start: i64, end: i64) -> Vec<i64> {
    let d = end - start;
    let n = if d > MAX_MS {
        (d + MAX_MS - 1) / MAX_MS
    } else {
        1
    };
    (0..=n)
        .map(|k| start + ((d as i128 * k as i128) / n as i128) as i64)
        .collect()
}

impl Store {
    /// Closes the open row `uid` at `ended_at`: deletes it if shorter than [`MIN_MS`], splits it
    /// if longer than [`MAX_MS`]. `pages` carries each page's first-seen time. Returns the rows
    /// written (empty when discarded or when the row no longer exists).
    pub(crate) fn finalize_session(
        &mut self,
        uid: &str,
        book_uid: &str,
        started_at: i64,
        ended_at: i64,
        pages: &[(u32, i64)],
    ) -> Result<Vec<ReadingSessionRow>> {
        let tx = self.conn.transaction()?;
        if ended_at - started_at < MIN_MS {
            tx.execute("DELETE FROM reading_session WHERE uid = ?1", params![uid])?;
            tx.commit()?;
            return Ok(Vec::new());
        }
        let bounds = chunk_bounds(started_at, ended_at);
        let chunks = bounds.len() - 1;
        let mut chunk_pages: Vec<Vec<u32>> = vec![Vec::new(); chunks];
        for &(page, seen) in pages {
            let k = bounds[..chunks]
                .iter()
                .rposition(|b| *b <= seen)
                .unwrap_or(0);
            chunk_pages[k].push(page);
        }
        let mut rows = Vec::with_capacity(chunks);
        for k in 0..chunks {
            let mut p = std::mem::take(&mut chunk_pages[k]);
            p.sort_unstable();
            p.dedup();
            let row = ReadingSessionRow {
                uid: if k == 0 {
                    uid.to_owned()
                } else {
                    uuid::Uuid::new_v4().to_string()
                },
                book_uid: book_uid.to_owned(),
                started_at: bounds[k],
                ended_at: Some(bounds[k + 1]),
                last_heartbeat_at: bounds[k + 1],
                pages: p,
                sent_to_painel_at: None,
            };
            if k == 0 {
                let updated = tx.execute(
                    "UPDATE reading_session
                     SET started_at = ?2, ended_at = ?3, last_heartbeat_at = ?3, pages = ?4
                     WHERE uid = ?1",
                    params![uid, row.started_at, row.ended_at, pages_json(&row.pages)],
                )?;
                if updated == 0 {
                    // Gone (the book was purged): nothing to close.
                    return Ok(Vec::new());
                }
            } else {
                tx.execute(
                    "INSERT INTO reading_session
                         (uid, book_uid, started_at, ended_at, last_heartbeat_at, pages)
                     VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                    params![
                        row.uid,
                        row.book_uid,
                        row.started_at,
                        row.ended_at,
                        pages_json(&row.pages)
                    ],
                )?;
            }
            rows.push(row);
        }
        tx.commit()?;
        Ok(rows)
    }

    /// Reading sessions, oldest first, of one book or of all.
    pub fn list_reading_sessions(&self, book_uid: Option<&str>) -> Result<Vec<ReadingSessionRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM reading_session WHERE ?1 IS NULL OR book_uid = ?1
             ORDER BY started_at, uid"
        ))?;
        let rows = stmt
            .query_map(params![book_uid], session_from_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// One reading session row by uid.
    pub fn reading_session(&self, uid: &str) -> Result<Option<ReadingSessionRow>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM reading_session WHERE uid = ?1"),
                params![uid],
                session_from_row,
            )
            .optional()?)
    }
}

const SESSION_COLUMNS: &str =
    "uid, book_uid, started_at, ended_at, last_heartbeat_at, pages, sent_to_painel_at";

fn session_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingSessionRow> {
    Ok(ReadingSessionRow {
        uid: r.get(0)?,
        book_uid: r.get(1)?,
        started_at: r.get(2)?,
        ended_at: r.get(3)?,
        last_heartbeat_at: r.get(4)?,
        pages: parse_pages(&r.get::<_, String>(5)?),
        sent_to_painel_at: r.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_are_equal_and_at_most_twelve_hours() {
        assert_eq!(chunk_bounds(0, 1000), [0, 1000]);
        assert_eq!(chunk_bounds(0, MAX_MS), [0, MAX_MS]);
        let b = chunk_bounds(10, 10 + 25 * 3_600_000);
        assert_eq!(b.len(), 4);
        assert_eq!((b[0], b[3]), (10, 10 + 25 * 3_600_000));
        assert!(b.windows(2).all(|w| w[1] - w[0] <= MAX_MS && w[1] > w[0]));
    }

    #[test]
    fn pages_json_is_sorted_and_distinct() {
        assert_eq!(pages_json(&[3, 1, 3, 2]), "[1,2,3]");
        assert_eq!(parse_pages("[5,1,5]"), [1, 5]);
        assert!(parse_pages("oops").is_empty());
    }
}
