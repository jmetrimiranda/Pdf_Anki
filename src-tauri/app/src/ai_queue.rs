//! Background enrichment (plan `docs/planos/fase-8.md` 5.3): only the words added while it is on ("Adicionar ao deck
//! do livro", a Vocabulário card from the selection) wait in `ai_queue`; one worker thread sends them in batches,
//! respecting the caps. Never the library, never old decks.
//!
//! - The cache answers first (no cost).
//! - A batch whose worst case is above the confirmation threshold pauses the queue and tells the user (no
//!   confirmation in the background).
//! - Cap reached or no network: the queue waits and tries again later by itself.
//! - An answer fills Definição/Tradução only while the field still holds what the app wrote.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use core_ai::prompts::{self, EnrichAnswer, EnrichItem, EnrichOut};
use core_ai::{AiError, CallSpec, CompletionRequest, Feature, Function, Origin};
use core_store::{AiQueueRow, setting_keys as keys};
use core_vocab::Pos;
use serde::{Deserialize, Serialize};

use crate::ai_features::{class_of, enrich_item_of};
use crate::anki::UiEvent;
use crate::error::AppError;
use crate::state::{AppState, lock};

/// Event with the queue's state (`ai_queue_get`'s shape).
pub const AI_QUEUE_EVENT: &str = "ai://queue";
/// Attempts before an item stops being retried (invalid or refused answers).
const MAX_ATTEMPTS: u32 = 3;
/// Waits of the worker: after a network or provider problem, after a cap, when idle.
const RETRY_NETWORK: Duration = Duration::from_secs(60);
const RETRY_LIMIT: Duration = Duration::from_secs(15 * 60);
const IDLE: Duration = Duration::from_secs(30 * 60);

/// The worker's wake-up flag and its last message.
#[derive(Default)]
pub struct QueueHub {
    started: AtomicBool,
    wake: Mutex<bool>,
    cv: Condvar,
    status: Mutex<Option<String>>,
}

/// `ai_queue_get` and the `ai://queue` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiQueueInfo {
    pub enabled: bool,
    pub paused: bool,
    pub pending: u32,
    pub failed: u32,
    /// Why the queue isn't moving (cap reached, no network, paused above the threshold…).
    pub status: Option<String>,
    pub items: Vec<AiQueueRow>,
}

/// What one step of the worker did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueStep {
    /// Nothing to do (off, paused, empty, or waiting for the user to fix something).
    Idle,
    /// A batch went (or items were settled from the cache): go on.
    Worked,
    /// Try again after this long (network, cap).
    Wait(Duration),
}

/// The fields the app wrote into a queued note.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct LeftFields {
    definicao: String,
    traducao: String,
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Plain text of a short stored field (the Lema).
fn plain(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .trim()
        .to_owned()
}

impl AppState {
    fn ai_queue_hub(&self) -> &QueueHub {
        &self.ai.queue
    }

    fn ai_queue_status(&self, message: Option<String>) {
        *lock(&self.ai_queue_hub().status) = message;
    }

    /// Wakes the worker (a new item, a resume, a settings change).
    pub(crate) fn ai_queue_kick(&self) {
        let hub = self.ai_queue_hub();
        *lock(&hub.wake) = true;
        hub.cv.notify_all();
        self.emit_ai_queue();
    }

    /// Lets the worker see the shutdown (no event: the database is closing).
    pub(crate) fn ai_queue_kick_for_shutdown(&self) {
        let hub = self.ai_queue_hub();
        *lock(&hub.wake) = true;
        hub.cv.notify_all();
    }

    fn emit_ai_queue(&self) {
        match self.ai_queue_get() {
            Ok(info) => self.emit(UiEvent::AiQueue(info)),
            Err(e) => tracing::debug!(code = %e.code, "AI queue state unavailable"),
        }
    }

    /// Starts the worker thread (once per run).
    pub fn ai_queue_start(self: &Arc<Self>) {
        if self.ai_queue_hub().started.swap(true, Ordering::SeqCst) {
            return;
        }
        let state = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("ai-queue".into())
            .spawn(move || {
                while !state.is_shutting_down() {
                    let wait = match state.ai_queue_step() {
                        QueueStep::Worked => continue,
                        QueueStep::Idle => IDLE,
                        QueueStep::Wait(d) => d,
                    };
                    let hub = state.ai_queue_hub();
                    let mut woken = lock(&hub.wake);
                    if !*woken {
                        woken = hub
                            .cv
                            .wait_timeout(woken, wait)
                            .map(|(g, _)| g)
                            .unwrap_or_else(|p| p.into_inner().0);
                    }
                    *woken = false;
                }
            });
        if let Err(e) = spawned {
            tracing::warn!(%e, "could not start the AI queue");
        }
    }

    /// Queues a vocabulary note for the background enrichment, when it is on. The note's current Definição and
    /// Tradução are kept as "what the app wrote". Returns whether it was queued.
    pub(crate) fn ai_enqueue_note(
        &self,
        note_id: i64,
        lemma: Option<&str>,
        pos: Option<Pos>,
        sentence: &str,
    ) -> Result<bool, AppError> {
        if !self.with_store(|s| s.setting_as::<bool>(keys::AI_BACKGROUND_ENRICH))? {
            return Ok(false);
        }
        let Some(fields) = self
            .anki_handles()?
            .svc
            .call_blocking(move |col| core_anki::vocab::note_fields_by_name(col, note_id))?
        else {
            return Err(AppError::new("not_found", "A nota não existe mais."));
        };
        let (Some(definicao), Some(traducao)) = (fields.get("Definição"), fields.get("Tradução"))
        else {
            return Err(AppError::new(
                "invalid_input",
                "Só notas de Vocabulário (com Definição e Tradução) entram na fila da IA.",
            ));
        };
        let lemma = match lemma {
            Some(l) => l.trim().to_lowercase(),
            None => plain(
                fields
                    .get("Lema")
                    .or_else(|| fields.get("Palavra"))
                    .map_or("", |s| s),
            )
            .to_lowercase(),
        };
        if lemma.is_empty() {
            return Ok(false);
        }
        let left = serde_json::to_string(&LeftFields {
            definicao: definicao.clone(),
            traducao: traducao.clone(),
        })
        .map_err(AppError::internal)?;
        let sentence = crate::ai_features::sentence(sentence);
        let added =
            self.with_store(|s| s.ai_queue_add(note_id, &lemma, class_of(pos), &sentence, &left))?;
        if added {
            self.ai_queue_kick();
        }
        Ok(added)
    }

    /// "Criar card de Vocabulário pela seleção": the screen queues the note it just created.
    pub fn ai_queue_add_note(&self, note_id: i64, sentence: &str) -> Result<AiQueueInfo, AppError> {
        self.ai_enqueue_note(note_id, None, None, sentence)?;
        self.ai_queue_get()
    }

    pub fn ai_queue_get(&self) -> Result<AiQueueInfo, AppError> {
        let status = lock(&self.ai_queue_hub().status).clone();
        self.with_store(|s| {
            let items = s.ai_queue_list()?;
            let failed = items.iter().filter(|i| i.state == "failed").count() as u32;
            Ok(AiQueueInfo {
                enabled: s.setting_as(keys::AI_BACKGROUND_ENRICH)?,
                paused: s.setting_as(keys::AI_BACKGROUND_PAUSED)?,
                pending: items.len() as u32 - failed,
                failed,
                status,
                items,
            })
        })
    }

    /// Pausing keeps the queue as it is.
    pub fn ai_queue_set_paused(&self, paused: bool) -> Result<AiQueueInfo, AppError> {
        self.with_store(|s| s.set_setting(keys::AI_BACKGROUND_PAUSED, paused.into()))?;
        if !paused {
            self.ai_queue_status(None);
        }
        self.ai_queue_kick();
        self.ai_queue_get()
    }

    pub fn ai_queue_remove(&self, uid: &str) -> Result<AiQueueInfo, AppError> {
        self.with_store(|s| s.ai_queue_remove(uid))?;
        self.emit_ai_queue();
        self.ai_queue_get()
    }

    /// Puts the failed items back in line.
    pub fn ai_queue_retry(&self) -> Result<AiQueueInfo, AppError> {
        self.with_store(|s| s.ai_queue_retry_failed())?;
        self.ai_queue_kick();
        self.ai_queue_get()
    }

    /// Writes an answer into its note (only the fields still as the app left them) and settles the item.
    fn ai_queue_apply(&self, row: &AiQueueRow, a: &EnrichAnswer) -> Result<(), AppError> {
        let left: LeftFields = serde_json::from_str(&row.left_fields).unwrap_or_default();
        let (definicao, traducao) = (escape(&a.definicao), escape(&a.traducao));
        let note_id = row.note_id;
        let written = self.anki_handles()?.svc.call_blocking(move |col| {
            core_anki::vocab::fill_fields_if_unchanged(
                col,
                note_id,
                &[
                    ("Definição", &left.definicao, &definicao),
                    ("Tradução", &left.traducao, &traducao),
                ],
            )
        })?;
        if !written.is_empty() {
            self.vocab_notes_added();
        }
        self.with_store(|s| s.ai_queue_remove(&row.uid))?;
        Ok(())
    }

    /// One step of the worker: settles cached items, then sends one batch. Public for the tests, which drive the
    /// queue step by step instead of through the thread.
    pub fn ai_queue_step(self: &Arc<Self>) -> QueueStep {
        let step = self.ai_queue_step_inner();
        self.emit_ai_queue();
        step
    }

    fn ai_queue_step_inner(self: &Arc<Self>) -> QueueStep {
        let settings = self.with_store(|s| {
            Ok((
                s.setting_as::<bool>(keys::AI_BACKGROUND_ENRICH)?,
                s.setting_as::<bool>(keys::AI_BACKGROUND_PAUSED)?,
            ))
        });
        match settings {
            Ok((true, false)) => {}
            Ok(_) => return QueueStep::Idle,
            Err(e) => {
                tracing::warn!(code = %e.code, "AI queue: settings unavailable");
                return QueueStep::Wait(RETRY_NETWORK);
            }
        }
        let t = match self.ai_target(Function::Enrich) {
            Ok(t) => t,
            Err(e) => {
                self.ai_queue_status(Some(e.message));
                return QueueStep::Idle;
            }
        };
        let batch = prompts::enrich_batch_size(t.max_output_tokens);
        let pending = match self.with_store(|s| s.ai_queue_pending(batch as u32)) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(code = %e.code, "AI queue unreadable");
                return QueueStep::Wait(RETRY_NETWORK);
            }
        };
        if pending.is_empty() {
            self.ai_queue_status(None);
            return QueueStep::Idle;
        }
        // The cache first.
        let mut to_send: Vec<(AiQueueRow, EnrichItem)> = Vec::new();
        let mut settled = false;
        for row in pending {
            let item = enrich_item_of(&row.lemma, &row.pos, &row.sentence);
            match self.ai_cached(&item) {
                Ok(Some(a)) => {
                    if let Err(e) = self.ai_queue_apply(&row, &a) {
                        tracing::warn!(code = %e.code, "AI queue: could not fill a note");
                        return QueueStep::Wait(RETRY_NETWORK);
                    }
                    settled = true;
                }
                Ok(None) => to_send.push((row, item)),
                Err(e) => {
                    tracing::warn!(code = %e.code, "AI cache unreadable");
                    return QueueStep::Wait(RETRY_NETWORK);
                }
            }
        }
        if to_send.is_empty() {
            return if settled {
                QueueStep::Worked
            } else {
                QueueStep::Idle
            };
        }
        let items: Vec<EnrichItem> = to_send.iter().map(|(_, i)| i.clone()).collect();
        let (system, user) = prompts::enrich_prompt(&items);
        let req = CompletionRequest {
            model: t.model.clone(),
            system,
            user,
            schema: prompts::enrich_schema(),
            schema_name: "vocabulario",
            max_output_tokens: t.max_output_tokens,
            effort: t.effort,
        };
        let engine = self.ai_engine();
        let worst = engine.worst_case(&t.price, &req);
        if worst > t.caps.confirm_above_usd {
            return self.ai_queue_pause_above(worst, t.caps.confirm_above_usd);
        }
        let spec = CallSpec {
            provider: t.provider.as_ref(),
            key: &t.key,
            price: &t.price,
            feature: Feature::Enrich,
            caps: t.caps,
            origin: Origin::Background,
        };
        let call = engine.structured(&spec, &req, |o: &EnrichOut| {
            prompts::validate_enrich(&items, o)
        });
        match tauri::async_runtime::block_on(call) {
            Ok(out) => {
                for ((row, item), answer) in to_send.iter().zip(&out.itens) {
                    let done = self
                        .ai_cache_put(item, answer)
                        .and_then(|()| self.ai_queue_apply(row, answer));
                    if let Err(e) = done {
                        tracing::warn!(code = %e.code, "AI queue: could not save an answer");
                        return QueueStep::Wait(RETRY_NETWORK);
                    }
                }
                self.ai_queue_status(None);
                QueueStep::Worked
            }
            Err(e) => self.ai_queue_failed(e, &to_send, t.caps.confirm_above_usd),
        }
    }

    fn ai_queue_pause_above(&self, worst: f64, threshold: f64) -> QueueStep {
        if let Err(e) = self.with_store(|s| s.set_setting(keys::AI_BACKGROUND_PAUSED, true.into()))
        {
            tracing::warn!(code = %e.code, "AI queue: could not pause");
        }
        self.ai_queue_status(Some(format!(
            "Fila pausada: o próximo lote pode custar até US$ {worst:.4}, acima do limite de confirmação \
             (US$ {threshold:.2}). Retome a fila para enviar."
        )));
        tracing::info!(worst, "AI queue paused above the confirmation threshold");
        QueueStep::Idle
    }

    fn ai_queue_failed(
        &self,
        e: AiError,
        batch: &[(AiQueueRow, EnrichItem)],
        threshold: f64,
    ) -> QueueStep {
        let message = e.to_string();
        match e {
            AiError::NeedsConfirmation(worst) => self.ai_queue_pause_above(worst, threshold),
            AiError::LimitReached(_) => {
                self.ai_queue_status(Some(message));
                QueueStep::Wait(RETRY_LIMIT)
            }
            AiError::Offline
            | AiError::Timeout
            | AiError::RateLimited { .. }
            | AiError::Server(_) => {
                self.ai_queue_status(Some(message));
                QueueStep::Wait(RETRY_NETWORK)
            }
            AiError::InvalidOutput
            | AiError::Refused
            | AiError::Truncated
            | AiError::BadRequest(_) => {
                let code = e.code();
                let counted = self.with_store(|s| {
                    for (row, _) in batch {
                        s.ai_queue_failed_attempt(&row.uid, code, MAX_ATTEMPTS)?;
                    }
                    Ok(())
                });
                if let Err(e) = counted {
                    tracing::warn!(code = %e.code, "AI queue: could not count an attempt");
                }
                QueueStep::Worked
            }
            // Key, model, provider spending limit: the user must fix something; a settings change wakes the queue.
            _ => {
                self.ai_queue_status(Some(message));
                QueueStep::Idle
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_of_a_field() {
        assert_eq!(plain("<b>Windmill</b>&nbsp;"), "Windmill");
        assert_eq!(plain("rock &amp; roll"), "rock & roll");
    }
}
