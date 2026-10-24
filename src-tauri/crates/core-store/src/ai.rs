//! AI bookkeeping (plan `docs/planos/fase-8.md` 3.6, 5.3): one `ai_usage` row per billed call, the enrichment cache
//! (lemma + hash of the sentence → the validated answer) and the background enrichment queue. All device-local: none
//! of these tables syncs.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::{Result, Store, StoreError, now_ms};

/// One billed AI call.
#[derive(Clone, Debug, PartialEq)]
pub struct AiUsageRow {
    /// Epoch ms (UTC) of the answer.
    pub at: i64,
    /// `enrich`, `define`, `cards` or `judge`.
    pub feature: String,
    pub provider: String,
    pub model: String,
    pub tokens_in: u64,
    pub tokens_cached_in: u64,
    pub tokens_cache_write: u64,
    pub tokens_out: u64,
    /// Part of `tokens_out` (when the provider reports it).
    pub tokens_thinking: u64,
    pub cost_usd: f64,
    /// No usage came back: billed at the worst case.
    pub estimated: bool,
    /// `checked_at` of the prices used (YYYY-MM-DD).
    pub prices_checked_at: Option<String>,
}

/// Spending of one provider and feature since a moment.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageTotal {
    pub provider: String,
    pub feature: String,
    pub calls: u32,
    pub cost_usd: f64,
}

/// One word waiting for the background enrichment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQueueRow {
    pub uid: String,
    pub note_id: i64,
    pub lemma: String,
    /// WordNet part of speech (`n`, `v`…), empty when unknown.
    pub pos: String,
    /// The sentence of the book where the word was added (the only text sent).
    pub sentence: String,
    /// JSON `{"definicao", "traducao"}`: the fields as the app wrote them.
    pub left_fields: String,
    pub created_at: i64,
    /// `pending` or `failed`.
    pub state: String,
    pub attempts: u32,
    pub error: Option<String>,
}

fn u64_sql(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn queue_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AiQueueRow> {
    Ok(AiQueueRow {
        uid: r.get(0)?,
        note_id: r.get(1)?,
        lemma: r.get(2)?,
        pos: r.get(3)?,
        sentence: r.get(4)?,
        left_fields: r.get(5)?,
        created_at: r.get(6)?,
        state: r.get(7)?,
        attempts: r.get(8)?,
        error: r.get(9)?,
    })
}

const QUEUE_COLUMNS: &str =
    "uid, note_id, lemma, pos, sentence, left_fields, created_at, state, attempts, error";

impl Store {
    pub fn add_ai_usage(&self, row: &AiUsageRow) -> Result<()> {
        if !row.cost_usd.is_finite() || row.cost_usd < 0.0 {
            return Err(StoreError::InvalidInput(format!(
                "custo inválido: {}",
                row.cost_usd
            )));
        }
        self.conn.execute(
            "INSERT INTO ai_usage (uid, at, feature, provider, model, tokens_in, tokens_out, cost_usd,
                tokens_cached_in, tokens_cache_write, tokens_thinking, estimated, prices_checked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                uuid::Uuid::new_v4().to_string(),
                row.at,
                row.feature,
                row.provider,
                row.model,
                u64_sql(row.tokens_in),
                u64_sql(row.tokens_out),
                row.cost_usd,
                u64_sql(row.tokens_cached_in),
                u64_sql(row.tokens_cache_write),
                u64_sql(row.tokens_thinking),
                row.estimated,
                row.prices_checked_at,
            ],
        )?;
        Ok(())
    }

    /// Total spent from `since_ms` on, over every provider.
    pub fn ai_spent_since(&self, since_ms: i64) -> Result<f64> {
        Ok(self.conn.query_row(
            "SELECT coalesce(sum(cost_usd), 0) FROM ai_usage WHERE at >= ?1",
            params![since_ms],
            |r| r.get(0),
        )?)
    }

    /// Spending per provider and feature from `since_ms` on.
    pub fn ai_usage_totals(&self, since_ms: i64) -> Result<Vec<AiUsageTotal>> {
        let mut stmt = self.conn.prepare(
            "SELECT provider, feature, count(*), sum(cost_usd) FROM ai_usage WHERE at >= ?1
             GROUP BY provider, feature ORDER BY provider, feature",
        )?;
        let rows = stmt
            .query_map(params![since_ms], |r| {
                Ok(AiUsageTotal {
                    provider: r.get(0)?,
                    feature: r.get(1)?,
                    calls: r.get(2)?,
                    cost_usd: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// The cached enrichment of `lemma` in the sentence with `context_hash` (a JSON payload).
    pub fn ai_enrichment_get(&self, lemma: &str, context_hash: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT payload FROM vocab_enrichment_cache WHERE lemma = ?1 AND context_hash = ?2",
                params![lemma, context_hash],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn ai_enrichment_put(&self, lemma: &str, context_hash: &str, payload: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO vocab_enrichment_cache (lemma, context_hash, payload) VALUES (?1, ?2, ?3)
             ON CONFLICT (lemma, context_hash) DO UPDATE SET payload = excluded.payload",
            params![lemma, context_hash, payload],
        )?;
        Ok(())
    }

    /// Queues a note for the background enrichment; a note already queued is left as is. Returns whether it was added.
    pub fn ai_queue_add(
        &self,
        note_id: i64,
        lemma: &str,
        pos: &str,
        sentence: &str,
        left_fields: &str,
    ) -> Result<bool> {
        let now = now_ms();
        let n = self.conn.execute(
            "INSERT INTO ai_queue (uid, note_id, lemma, pos, sentence, left_fields, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT (note_id) DO NOTHING",
            params![
                uuid::Uuid::new_v4().to_string(),
                note_id,
                lemma,
                pos,
                sentence,
                left_fields,
                now
            ],
        )?;
        Ok(n == 1)
    }

    /// The whole queue, oldest first (failed items after the pending ones).
    pub fn ai_queue_list(&self) -> Result<Vec<AiQueueRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {QUEUE_COLUMNS} FROM ai_queue ORDER BY state = 'failed', created_at, uid"
        ))?;
        let rows = stmt
            .query_map([], queue_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Up to `limit` pending items, oldest first.
    pub fn ai_queue_pending(&self, limit: u32) -> Result<Vec<AiQueueRow>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {QUEUE_COLUMNS} FROM ai_queue WHERE state = 'pending' ORDER BY created_at, uid LIMIT ?1"
        ))?;
        let rows = stmt
            .query_map(params![limit], queue_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Removes an item (done, or removed by the user). Returns whether it existed.
    pub fn ai_queue_remove(&self, uid: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM ai_queue WHERE uid = ?1", params![uid])?
            == 1)
    }

    /// Counts a failed attempt; after `max_attempts` the item stops being retried (`failed`, kept with the error).
    pub fn ai_queue_failed_attempt(&self, uid: &str, error: &str, max_attempts: u32) -> Result<()> {
        self.conn.execute(
            "UPDATE ai_queue SET attempts = attempts + 1, error = ?2, updated_at = ?3,
                state = CASE WHEN attempts + 1 >= ?4 THEN 'failed' ELSE state END
             WHERE uid = ?1",
            params![uid, error, now_ms(), max_attempts],
        )?;
        Ok(())
    }

    /// Puts the failed items back in line.
    pub fn ai_queue_retry_failed(&self) -> Result<u32> {
        let n = self.conn.execute(
            "UPDATE ai_queue SET state = 'pending', attempts = 0, error = NULL, updated_at = ?1
             WHERE state = 'failed'",
            params![now_ms()],
        )?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(at: i64, provider: &str, feature: &str, cost: f64) -> AiUsageRow {
        AiUsageRow {
            at,
            feature: feature.into(),
            provider: provider.into(),
            model: "m".into(),
            tokens_in: 10,
            tokens_cached_in: 0,
            tokens_cache_write: 0,
            tokens_out: 5,
            tokens_thinking: 0,
            cost_usd: cost,
            estimated: false,
            prices_checked_at: Some("2026-10-24".into()),
        }
    }

    #[test]
    fn usage_sums_and_totals() {
        let store = Store::open_in_memory().unwrap();
        store
            .add_ai_usage(&usage(100, "anthropic", "judge", 0.25))
            .unwrap();
        store
            .add_ai_usage(&usage(200, "anthropic", "enrich", 0.5))
            .unwrap();
        store
            .add_ai_usage(&usage(300, "anthropic", "enrich", 0.125))
            .unwrap();
        assert!(
            store
                .add_ai_usage(&usage(300, "x", "enrich", f64::NAN))
                .is_err()
        );
        assert_eq!(store.ai_spent_since(0).unwrap(), 0.875);
        assert_eq!(store.ai_spent_since(200).unwrap(), 0.625);
        assert_eq!(store.ai_spent_since(301).unwrap(), 0.0);
        let totals = store.ai_usage_totals(0).unwrap();
        assert_eq!(totals.len(), 2);
        assert_eq!(
            (
                totals[0].feature.as_str(),
                totals[0].calls,
                totals[0].cost_usd
            ),
            ("enrich", 2, 0.625)
        );
    }

    #[test]
    fn enrichment_cache_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.ai_enrichment_get("mill", "h").unwrap(), None);
        store.ai_enrichment_put("mill", "h", r#"{"a":1}"#).unwrap();
        store.ai_enrichment_put("mill", "h", r#"{"a":2}"#).unwrap();
        assert_eq!(
            store.ai_enrichment_get("mill", "h").unwrap().as_deref(),
            Some(r#"{"a":2}"#)
        );
        assert!(store.ai_enrichment_put("mill", "h", "not json").is_err());
    }

    #[test]
    fn queue_lifecycle() {
        let store = Store::open_in_memory().unwrap();
        let left = r#"{"definicao":"","traducao":""}"#;
        assert!(
            store
                .ai_queue_add(1, "mill", "n", "The mill.", left)
                .unwrap()
        );
        assert!(!store.ai_queue_add(1, "mill", "n", "Again.", left).unwrap());
        assert!(store.ai_queue_add(2, "pasture", "", "", "{}").unwrap());
        assert!(store.ai_queue_add(3, "x", "", "", "not json").is_err());
        let pending = store.ai_queue_pending(10).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].sentence, "The mill.");
        assert_eq!(pending[0].left_fields, left);
        store
            .ai_queue_failed_attempt(&pending[0].uid, "ai_offline", 3)
            .unwrap();
        assert_eq!(store.ai_queue_pending(10).unwrap().len(), 2);
        store
            .ai_queue_failed_attempt(&pending[0].uid, "ai_invalid_output", 2)
            .unwrap();
        let pending_now = store.ai_queue_pending(10).unwrap();
        assert_eq!(pending_now.len(), 1);
        let list = store.ai_queue_list().unwrap();
        assert_eq!(list[1].state, "failed");
        assert_eq!(list[1].attempts, 2);
        assert_eq!(list[1].error.as_deref(), Some("ai_invalid_output"));
        assert_eq!(store.ai_queue_retry_failed().unwrap(), 1);
        assert_eq!(store.ai_queue_pending(1).unwrap().len(), 1);
        assert!(store.ai_queue_remove(&pending[1].uid).unwrap());
        assert!(!store.ai_queue_remove(&pending[1].uid).unwrap());
        assert_eq!(store.ai_queue_list().unwrap().len(), 1);
    }
}
