//! Vocabulary scanning (docs/PROJETO.md 12, 14): the per-page lemma table of a book (`book_lemma_page`, spec 12.3 F)
//! with its aggregate (`book_lemma`) and completeness marker (`book_lemma_state`), the scans (`vocab_scan`), the
//! manual overrides (`vocab_override`, syncs) and the `vocab` role of `notetype_mapping` (syncs).
//!
//! This crate knows nothing about the algorithm (no dependency on `core-vocab`): rows are plain data and the JSON
//! columns are `serde_json::Value`s that the caller shapes. The table is a cache keyed by a *text version* (the
//! caller builds it from the algorithm version and the text fingerprint of the book): it is valid only when
//! [`Store::vocab_table_state`] matches what the caller expects.

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::code::next_updated_at;
use crate::library::check_uid;
use crate::{Result, Store, StoreError, now_ms};

/// `vocab_scan.range` of a whole-book scan (the column default).
pub const VOCAB_RANGE_ALL: &str = r#"{"kind":"all"}"#;

/// The completeness marker of a book's lemma table.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabTableState {
    /// Version of the text the table was computed from (algorithm version + text fingerprint).
    pub text_version: String,
    /// Version of the algorithm that computed it.
    pub algo_version: i64,
    /// Pages (units) of the book when it was computed.
    pub page_count: u32,
    /// Epoch ms. Ignored by [`Store::replace_vocab_table`] when 0 (now is used).
    pub built_at: i64,
    /// Repeated header/footer lines the text cleanup removed (normalized keys), for the highlight.
    #[serde(default)]
    pub repeated_lines: Vec<String>,
}

/// One lemma of the whole book (`book_lemma`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookLemmaRow {
    pub lemma: String,
    pub pos: Option<String>,
    pub occurrences: u32,
    /// 0-based page (unit) of the first occurrence.
    pub first_unit: u32,
    pub example: Option<String>,
    /// Where to highlight the word in `example` (shape chosen by the caller), JSON.
    pub example_span: Option<Value>,
    /// Pages (units) where it occurs, ascending.
    pub units: Vec<u32>,
    pub is_proper: bool,
    pub zipf: Option<f64>,
    /// Original forms seen in the book (shape chosen by the caller), a JSON array.
    pub forms: Value,
}

/// One lemma on one page (`book_lemma_page`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookLemmaPageRow {
    pub lemma: String,
    /// 0-based page (unit).
    pub unit: u32,
    pub occurrences: u32,
    /// Most common original form on the page.
    pub form: String,
    /// Original forms on the page (shape chosen by the caller), a JSON array.
    pub forms: Value,
    /// First example sentence of the page.
    pub example: Option<String>,
    pub example_span: Option<Value>,
}

/// Status of a scan (`vocab_scan.status`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum VocabScanStatus {
    Running,
    Done,
    Failed,
    Cancelled,
}

impl VocabScanStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn from_column(text: &str) -> Option<Self> {
        Some(match text {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

/// A scan to record when it starts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewVocabScan {
    pub book_uid: String,
    pub root_deck_id: i64,
    /// Every deck read (root and included subdecks).
    pub deck_ids: Vec<i64>,
    /// The wizard's options, JSON object.
    pub config: Value,
    /// The range, JSON object (`{"kind":"all"}`, `{"kind":"outline",…}`, `{"kind":"pages",…}`).
    pub range: Value,
}

/// The metrics of a finished scan (spec 12.4), for the chosen range.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabScanMetrics {
    pub total_tokens: u64,
    pub cov_known: f64,
    pub cov_with_learning: f64,
    pub unknown_lemmas: u64,
    /// `None`: 95% is out of reach (or already reached: 0).
    pub words_to_95: Option<u64>,
    pub words_to_98: Option<u64>,
}

/// A `vocab_scan` row, without its report (see [`Store::vocab_scan_report`]).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabScanRow {
    pub uid: String,
    pub book_uid: String,
    pub created_at: i64,
    pub root_deck_id: i64,
    pub deck_ids: Vec<i64>,
    pub config: Value,
    pub range: Value,
    pub status: VocabScanStatus,
    /// `None` until the scan is done.
    pub metrics: Option<VocabScanMetrics>,
    pub text_version: Option<String>,
    pub error: Option<String>,
    pub has_report: bool,
}

/// Manual status of a lemma (`vocab_override.status`), for every book.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum VocabOverrideStatus {
    Known,
    Ignored,
    Proper,
}

impl VocabOverrideStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Known => "known",
            Self::Ignored => "ignored",
            Self::Proper => "proper",
        }
    }

    fn from_column(text: &str) -> Option<Self> {
        Some(match text {
            "known" => Self::Known,
            "ignored" => Self::Ignored,
            "proper" => Self::Proper,
            _ => return None,
        })
    }
}

/// The field holding the English word of a notetype of the vocabulary folder (`notetype_mapping` role `vocab`,
/// fields JSON `{"word": "<field name>"}`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabMappingRow {
    pub notetype_id: i64,
    pub field: String,
}

#[derive(Serialize, Deserialize)]
struct VocabMappingFields {
    word: String,
}

fn json_text(what: &str, value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(|e| StoreError::InvalidInput(format!("{what}: {e}")))
}

fn json_array(what: &str, value: &Value) -> Result<String> {
    if !value.is_array() {
        return Err(StoreError::InvalidInput(format!(
            "{what} precisa ser uma lista."
        )));
    }
    json_text(what, value)
}

fn json_object(what: &str, value: &Value) -> Result<String> {
    if !value.is_object() {
        return Err(StoreError::InvalidInput(format!(
            "{what} precisa ser um objeto."
        )));
    }
    json_text(what, value)
}

fn parse_json(column: &str, text: &str) -> Result<Value> {
    serde_json::from_str(text)
        .map_err(|e| StoreError::Corrupt(format!("{column} não é um JSON válido: {e}")))
}

fn opt_json(column: &str, text: Option<String>) -> Result<Option<Value>> {
    text.map(|t| parse_json(column, &t)).transpose()
}

fn to_u32(v: i64) -> u32 {
    u32::try_from(v.max(0)).unwrap_or(u32::MAX)
}

fn to_u64(v: Option<i64>) -> Option<u64> {
    v.map(|v| u64::try_from(v.max(0)).unwrap_or(0))
}

/// Sorted, merged inclusive ranges (`[first, last]`, `first <= last`).
fn merge_ranges(ranges: &[[u32; 2]]) -> Vec<[u32; 2]> {
    let mut sorted: Vec<[u32; 2]> = ranges.iter().map(|&[a, b]| [a.min(b), a.max(b)]).collect();
    sorted.sort_unstable();
    let mut out: Vec<[u32; 2]> = Vec::with_capacity(sorted.len());
    for r in sorted {
        match out.last_mut() {
            Some(last) if r[0] <= last[1].saturating_add(1) => last[1] = last[1].max(r[1]),
            _ => out.push(r),
        }
    }
    out
}

const SCAN_COLUMNS: &str = "uid, book_uid, created_at, root_deck_id, deck_ids, config, range, status,
     total_tokens, cov_known, cov_with_learning, unknown_lemmas, words_to_95, words_to_98, text_version, error,
     report IS NOT NULL";

fn scan_row(r: &Row<'_>) -> rusqlite::Result<RawScan> {
    Ok(RawScan {
        uid: r.get(0)?,
        book_uid: r.get(1)?,
        created_at: r.get(2)?,
        root_deck_id: r.get(3)?,
        deck_ids: r.get(4)?,
        config: r.get(5)?,
        range: r.get(6)?,
        status: r.get(7)?,
        total_tokens: r.get(8)?,
        cov_known: r.get(9)?,
        cov_with_learning: r.get(10)?,
        unknown_lemmas: r.get(11)?,
        words_to_95: r.get(12)?,
        words_to_98: r.get(13)?,
        text_version: r.get(14)?,
        error: r.get(15)?,
        has_report: r.get(16)?,
    })
}

struct RawScan {
    uid: String,
    book_uid: String,
    created_at: i64,
    root_deck_id: i64,
    deck_ids: String,
    config: String,
    range: String,
    status: String,
    total_tokens: Option<i64>,
    cov_known: Option<f64>,
    cov_with_learning: Option<f64>,
    unknown_lemmas: Option<i64>,
    words_to_95: Option<i64>,
    words_to_98: Option<i64>,
    text_version: Option<String>,
    error: Option<String>,
    has_report: bool,
}

impl RawScan {
    fn into_row(self) -> Result<VocabScanRow> {
        let status = VocabScanStatus::from_column(&self.status).ok_or_else(|| {
            StoreError::Corrupt(format!("vocab_scan.status desconhecido: {:?}", self.status))
        })?;
        let deck_ids: Vec<i64> = serde_json::from_str(&self.deck_ids).map_err(|e| {
            StoreError::Corrupt(format!("vocab_scan.deck_ids não é uma lista de ids: {e}"))
        })?;
        let metrics = match (
            status,
            self.total_tokens,
            self.cov_known,
            self.cov_with_learning,
        ) {
            (VocabScanStatus::Done, Some(total), Some(known), Some(learning)) => {
                Some(VocabScanMetrics {
                    total_tokens: to_u64(Some(total)).unwrap_or(0),
                    cov_known: known,
                    cov_with_learning: learning,
                    unknown_lemmas: to_u64(self.unknown_lemmas).unwrap_or(0),
                    words_to_95: to_u64(self.words_to_95),
                    words_to_98: to_u64(self.words_to_98),
                })
            }
            _ => None,
        };
        Ok(VocabScanRow {
            uid: self.uid,
            book_uid: self.book_uid,
            created_at: self.created_at,
            root_deck_id: self.root_deck_id,
            deck_ids,
            config: parse_json("vocab_scan.config", &self.config)?,
            range: parse_json("vocab_scan.range", &self.range)?,
            status,
            metrics,
            text_version: self.text_version,
            error: self.error,
            has_report: self.has_report,
        })
    }
}

impl Store {
    // ------------------------------------------------------------------ lemma table

    /// The completeness marker of the book's lemma table, or `None` when there is no complete table.
    pub fn vocab_table_state(&self, book_uid: &str) -> Result<Option<VocabTableState>> {
        check_uid(book_uid)?;
        let row: Option<(String, i64, i64, i64, String)> = self
            .conn
            .query_row(
                "SELECT text_version, algo_version, page_count, built_at, repeated_lines
                 FROM book_lemma_state WHERE book_uid = ?1",
                params![book_uid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        row.map(
            |(text_version, algo_version, page_count, built_at, repeated)| {
                Ok(VocabTableState {
                    text_version,
                    algo_version,
                    page_count: to_u32(page_count),
                    built_at,
                    repeated_lines: serde_json::from_str(&repeated).map_err(|e| {
                        StoreError::Corrupt(format!(
                            "book_lemma_state.repeated_lines não é uma lista: {e}"
                        ))
                    })?,
                })
            },
        )
        .transpose()
    }

    /// Replaces the book's whole lemma table (aggregate rows, page rows and state) in one transaction: the old
    /// rows are deleted, so a table is either the previous complete one or the new complete one. The book must be
    /// in the library (removed books too: the table is a cache). Every row gets `state.text_version`.
    pub fn replace_vocab_table(
        &mut self,
        book_uid: &str,
        state: &VocabTableState,
        lemmas: &[BookLemmaRow],
        pages: &[BookLemmaPageRow],
    ) -> Result<()> {
        check_uid(book_uid)?;
        if state.text_version.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "a versão do texto não pode ser vazia.".into(),
            ));
        }
        let built_at = if state.built_at > 0 {
            state.built_at
        } else {
            now_ms()
        };
        let tx = self.conn.transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM book WHERE book_uid = ?1)",
            params![book_uid],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(StoreError::BookNotFound(book_uid.to_owned()));
        }
        tx.execute(
            "DELETE FROM book_lemma_page WHERE book_uid = ?1",
            params![book_uid],
        )?;
        tx.execute(
            "DELETE FROM book_lemma WHERE book_uid = ?1",
            params![book_uid],
        )?;
        tx.execute(
            "DELETE FROM book_lemma_state WHERE book_uid = ?1",
            params![book_uid],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO book_lemma (book_uid, lemma, pos, occurrences, first_unit, example, example_span,
                                         units, is_proper, zipf, forms, text_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )?;
            for l in lemmas {
                let span = l
                    .example_span
                    .as_ref()
                    .map(|s| json_text("example_span", s))
                    .transpose()?;
                let units = serde_json::to_string(&l.units)
                    .map_err(|e| StoreError::InvalidInput(e.to_string()))?;
                stmt.execute(params![
                    book_uid,
                    l.lemma,
                    l.pos,
                    l.occurrences,
                    l.first_unit,
                    l.example,
                    span,
                    units,
                    l.is_proper,
                    l.zipf.filter(|z| z.is_finite()),
                    json_array("forms", &l.forms)?,
                    state.text_version,
                ])?;
            }
            let mut stmt = tx.prepare(
                "INSERT INTO book_lemma_page (book_uid, lemma, unit, occurrences, form, forms, example,
                                              example_span, text_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for p in pages {
                let span = p
                    .example_span
                    .as_ref()
                    .map(|s| json_text("example_span", s))
                    .transpose()?;
                stmt.execute(params![
                    book_uid,
                    p.lemma,
                    p.unit,
                    p.occurrences,
                    p.form,
                    json_array("forms", &p.forms)?,
                    p.example,
                    span,
                    state.text_version,
                ])?;
            }
        }
        tx.execute(
            "INSERT INTO book_lemma_state
                 (book_uid, text_version, algo_version, page_count, built_at, repeated_lines)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                book_uid,
                state.text_version,
                state.algo_version,
                state.page_count,
                built_at,
                serde_json::to_string(&state.repeated_lines).map_err(|e| {
                    StoreError::InvalidInput(format!("linhas repetidas inválidas: {e}"))
                })?
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Page rows of the book inside the inclusive 0-based page ranges `[first, last]` (overlaps are merged; an
    /// empty slice selects nothing), ordered by (unit, lemma). Use `&[[0, u32::MAX]]` for the whole book.
    pub fn vocab_table_pages(
        &self,
        book_uid: &str,
        ranges: &[[u32; 2]],
    ) -> Result<Vec<BookLemmaPageRow>> {
        check_uid(book_uid)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT lemma, unit, occurrences, form, forms, example, example_span FROM book_lemma_page
             WHERE book_uid = ?1 AND unit BETWEEN ?2 AND ?3 ORDER BY unit, lemma",
        )?;
        let mut out = Vec::new();
        for [first, last] in merge_ranges(ranges) {
            let rows = stmt.query_map(params![book_uid, first, last], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            })?;
            for row in rows {
                let (lemma, unit, occurrences, form, forms, example, span) = row?;
                out.push(BookLemmaPageRow {
                    lemma,
                    unit: to_u32(unit),
                    occurrences: to_u32(occurrences),
                    form,
                    forms: parse_json("book_lemma_page.forms", &forms)?,
                    example,
                    example_span: opt_json("book_lemma_page.example_span", span)?,
                });
            }
        }
        Ok(out)
    }

    /// Every aggregate row of the book's table, ordered by (first unit, lemma).
    pub fn vocab_table_lemmas(&self, book_uid: &str) -> Result<Vec<BookLemmaRow>> {
        check_uid(book_uid)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT lemma, pos, occurrences, first_unit, example, example_span, units, is_proper, zipf, forms
             FROM book_lemma WHERE book_uid = ?1 ORDER BY first_unit, lemma",
        )?;
        let rows = stmt.query_map(params![book_uid], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, bool>(7)?,
                r.get::<_, Option<f64>>(8)?,
                r.get::<_, String>(9)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (lemma, pos, occ, first, example, span, units, is_proper, zipf, forms) = row?;
            let units: Vec<u32> = serde_json::from_str(&units).map_err(|e| {
                StoreError::Corrupt(format!("book_lemma.units não é uma lista de páginas: {e}"))
            })?;
            out.push(BookLemmaRow {
                lemma,
                pos,
                occurrences: to_u32(occ),
                first_unit: to_u32(first),
                example,
                example_span: opt_json("book_lemma.example_span", span)?,
                units,
                is_proper,
                zipf,
                forms: parse_json("book_lemma.forms", &forms)?,
            });
        }
        Ok(out)
    }

    /// Deletes the book's lemma table (rows and state).
    pub fn clear_vocab_table(&mut self, book_uid: &str) -> Result<()> {
        check_uid(book_uid)?;
        let tx = self.conn.transaction()?;
        for table in ["book_lemma_state", "book_lemma_page", "book_lemma"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE book_uid = ?1"),
                params![book_uid],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------ scans

    /// Records a scan that starts now (status `running`); returns its uid.
    pub fn insert_vocab_scan(&self, scan: &NewVocabScan) -> Result<String> {
        check_uid(&scan.book_uid)?;
        let uid = uuid::Uuid::new_v4().to_string();
        let deck_ids = serde_json::to_string(&scan.deck_ids)
            .map_err(|e| StoreError::InvalidInput(e.to_string()))?;
        let inserted = self.conn.execute(
            "INSERT INTO vocab_scan (uid, book_uid, created_at, root_deck_id, deck_ids, config, range, status)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running' WHERE EXISTS (SELECT 1 FROM book WHERE book_uid = ?2)",
            params![
                uid,
                scan.book_uid,
                now_ms(),
                scan.root_deck_id,
                deck_ids,
                json_object("config", &scan.config)?,
                json_object("range", &scan.range)?,
            ],
        )?;
        if inserted == 0 {
            return Err(StoreError::BookNotFound(scan.book_uid.clone()));
        }
        Ok(uid)
    }

    /// Marks a running scan `done` with its metrics, the text version it read and its report (a JSON text, kept
    /// as is). Errors with `InvalidInput` when the scan is unknown or not running.
    ///
    /// Only the book's latest finished report is kept: in the same transaction the reports of its older scans are
    /// dropped (their rows and metrics stay), so rescans and range scans don't grow the database without bound.
    pub fn finish_vocab_scan(
        &mut self,
        uid: &str,
        metrics: &VocabScanMetrics,
        text_version: &str,
        report: &str,
    ) -> Result<()> {
        if serde_json::from_str::<serde::de::IgnoredAny>(report).is_err() {
            return Err(StoreError::InvalidInput(
                "o relatório não é um JSON válido.".into(),
            ));
        }
        let as_i64 = |v: u64| i64::try_from(v).unwrap_or(i64::MAX);
        let finite = |v: f64| if v.is_finite() { v } else { 0.0 };
        let tx = self.conn.transaction()?;
        let changed = tx.execute(
            "UPDATE vocab_scan SET status = 'done', total_tokens = ?2, cov_known = ?3, cov_with_learning = ?4,
                 unknown_lemmas = ?5, words_to_95 = ?6, words_to_98 = ?7, text_version = ?8, report = ?9,
                 error = NULL
             WHERE uid = ?1 AND status = 'running'",
            params![
                uid,
                as_i64(metrics.total_tokens),
                finite(metrics.cov_known),
                finite(metrics.cov_with_learning),
                as_i64(metrics.unknown_lemmas),
                metrics.words_to_95.map(as_i64),
                metrics.words_to_98.map(as_i64),
                text_version,
                report,
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::InvalidInput(format!(
                "escaneamento {uid:?} não está em andamento."
            )));
        }
        tx.execute(
            "UPDATE vocab_scan SET report = NULL
             WHERE book_uid = (SELECT book_uid FROM vocab_scan WHERE uid = ?1)
               AND uid <> ?1 AND report IS NOT NULL",
            params![uid],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Ends a running scan as `failed` or `cancelled` (`status` `Done`/`Running` are refused) with an optional
    /// message. A scan that is no longer running is left alone (returns `false`).
    pub fn end_vocab_scan(
        &self,
        uid: &str,
        status: VocabScanStatus,
        error: Option<&str>,
    ) -> Result<bool> {
        if !matches!(status, VocabScanStatus::Failed | VocabScanStatus::Cancelled) {
            return Err(StoreError::InvalidInput(
                "um escaneamento só termina como falho ou cancelado.".into(),
            ));
        }
        let changed = self.conn.execute(
            "UPDATE vocab_scan SET status = ?2, error = ?3 WHERE uid = ?1 AND status = 'running'",
            params![uid, status.as_str(), error],
        )?;
        Ok(changed > 0)
    }

    /// One scan (without its report).
    pub fn vocab_scan(&self, uid: &str) -> Result<Option<VocabScanRow>> {
        let raw = self
            .conn
            .query_row(
                &format!("SELECT {SCAN_COLUMNS} FROM vocab_scan WHERE uid = ?1"),
                params![uid],
                scan_row,
            )
            .optional()?;
        raw.map(RawScan::into_row).transpose()
    }

    /// The book's latest scan (any status, or only `done` ones), without its report.
    pub fn latest_vocab_scan(
        &self,
        book_uid: &str,
        done_only: bool,
    ) -> Result<Option<VocabScanRow>> {
        check_uid(book_uid)?;
        let raw = self
            .conn
            .query_row(
                &format!(
                    "SELECT {SCAN_COLUMNS} FROM vocab_scan
                     WHERE book_uid = ?1 AND (?2 = 0 OR status = 'done')
                     ORDER BY created_at DESC, rowid DESC LIMIT 1"
                ),
                params![book_uid, done_only],
                scan_row,
            )
            .optional()?;
        raw.map(RawScan::into_row).transpose()
    }

    /// The report JSON of a scan, when it has one.
    pub fn vocab_scan_report(&self, uid: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT report FROM vocab_scan WHERE uid = ?1",
                params![uid],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// At startup: scans left `running` by a previous run (crash, quit) become `failed`. Returns how many.
    pub fn recover_vocab_scans(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE vocab_scan SET status = 'failed', error = 'O app foi fechado durante o escaneamento.'
             WHERE status = 'running'",
            [],
        )?)
    }

    // ------------------------------------------------------------------ overrides

    /// Live manual statuses, ordered by lemma.
    pub fn vocab_overrides(&self) -> Result<Vec<(String, VocabOverrideStatus)>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT lemma, status FROM vocab_override WHERE deleted = 0 ORDER BY lemma",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (lemma, status) = row?;
            if let Some(status) = VocabOverrideStatus::from_column(&status) {
                out.push((lemma, status));
            }
        }
        Ok(out)
    }

    /// Sets (`Some`) or removes (`None`, tombstone) the manual status of each lemma (trimmed, lowercase; blank ones
    /// are skipped), in one transaction. Every touched row gets a newer `updated_at`.
    pub fn set_vocab_overrides(
        &mut self,
        lemmas: &[String],
        status: Option<VocabOverrideStatus>,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        for lemma in lemmas {
            let lemma = lemma.trim().to_lowercase();
            if lemma.is_empty() {
                continue;
            }
            let previous: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT updated_at, deleted FROM vocab_override WHERE lemma = ?1",
                    params![lemma],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let updated_at = next_updated_at(previous.map(|p| p.0));
            match status {
                Some(status) => {
                    tx.execute(
                        "INSERT INTO vocab_override (lemma, status, updated_at, deleted) VALUES (?1, ?2, ?3, 0)
                         ON CONFLICT (lemma) DO UPDATE SET status = excluded.status,
                             updated_at = excluded.updated_at, deleted = 0",
                        params![lemma, status.as_str(), updated_at],
                    )?;
                }
                None => {
                    if previous.is_some_and(|p| p.1 == 0) {
                        tx.execute(
                            "UPDATE vocab_override SET deleted = 1, updated_at = ?2 WHERE lemma = ?1",
                            params![lemma, updated_at],
                        )?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------ mappings

    /// Live `vocab` mappings, ordered by notetype id. Rows whose fields JSON doesn't parse are skipped.
    pub fn vocab_mappings(&self) -> Result<Vec<VocabMappingRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT anki_notetype_id, fields FROM notetype_mapping
             WHERE deleted = 0 AND role = 'vocab' ORDER BY anki_notetype_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (notetype_id, fields) = row?;
            let Ok(fields) = serde_json::from_str::<VocabMappingFields>(&fields) else {
                continue;
            };
            out.push(VocabMappingRow {
                notetype_id,
                field: fields.word,
            });
        }
        Ok(out)
    }

    /// Maps the field holding the English word of a notetype (trimmed, non-empty). Refused with
    /// [`StoreError::MappingConflict`] when the notetype has an active code role (the key is shared).
    pub fn set_vocab_mapping(&self, notetype_id: i64, field: &str) -> Result<()> {
        let field = field.trim();
        if field.is_empty() {
            return Err(StoreError::InvalidInput(
                "o campo da palavra não pode ser vazio.".into(),
            ));
        }
        let previous: Option<(String, i64, i64)> = self
            .conn
            .query_row(
                "SELECT role, updated_at, deleted FROM notetype_mapping WHERE anki_notetype_id = ?1",
                params![notetype_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((role, _, 0)) = &previous
            && role != "vocab"
        {
            return Err(StoreError::MappingConflict {
                role: role_label(role).to_owned(),
            });
        }
        let updated_at = next_updated_at(previous.as_ref().map(|p| p.1));
        let json = serde_json::to_string(&VocabMappingFields {
            word: field.to_owned(),
        })
        .map_err(|e| StoreError::InvalidInput(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO notetype_mapping (anki_notetype_id, role, fields, updated_at, deleted)
             VALUES (?1, 'vocab', ?2, ?3, 0)
             ON CONFLICT (anki_notetype_id) DO UPDATE SET role = excluded.role,
                 fields = excluded.fields, updated_at = excluded.updated_at, deleted = 0",
            params![notetype_id, json, updated_at],
        )?;
        Ok(())
    }

    /// Removes (tombstone) the `vocab` mapping of a notetype; a code mapping is left alone.
    pub fn remove_vocab_mapping(&self, notetype_id: i64) -> Result<()> {
        let previous: Option<i64> = self
            .conn
            .query_row(
                "SELECT updated_at FROM notetype_mapping WHERE anki_notetype_id = ?1",
                params![notetype_id],
                |r| r.get(0),
            )
            .optional()?;
        self.conn.execute(
            "UPDATE notetype_mapping SET deleted = 1, updated_at = ?2
             WHERE anki_notetype_id = ?1 AND deleted = 0 AND role = 'vocab'",
            params![notetype_id, next_updated_at(previous)],
        )?;
        Ok(())
    }
}

/// The pt-BR name of a mapping role, for [`StoreError::MappingConflict`].
pub(crate) fn role_label(role: &str) -> &'static str {
    match role {
        "vocab" => "tipo de vocabulário",
        "code_command" => "tipo Comando",
        "code_program" => "tipo Programa",
        _ => "outro papel",
    }
}

#[cfg(test)]
mod tests {
    use super::merge_ranges;

    #[test]
    fn ranges_merge() {
        assert_eq!(merge_ranges(&[]), Vec::<[u32; 2]>::new());
        assert_eq!(
            merge_ranges(&[[5, 9], [0, 2], [3, 4], [20, 21], [8, 12]]),
            [[0, 12], [20, 21]]
        );
        assert_eq!(merge_ranges(&[[9, 5]]), [[5, 9]]);
        assert_eq!(merge_ranges(&[[0, u32::MAX], [3, 4]]), [[0, u32::MAX]]);
    }
}
