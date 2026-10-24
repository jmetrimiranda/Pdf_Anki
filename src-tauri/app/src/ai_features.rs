//! The AI functions (plan `docs/planos/fase-8.md` 1.1, Appendix C of the spec): the code judge, cards from a passage,
//! "Definir com IA" and the enrichment of a generated deck. Each one sends only what the plan's table 5.1 lists, goes
//! through the caps and the confirmation, and validates the answer before anything reaches a note.
//!
//! The deck enrichment is a job (progress, cancel) that fills `vocab_enrichment_cache` batch by batch; "Gerar deck"
//! with AI then reads the cache, so a cancelled or failed job loses nothing already paid for.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use core_ai::prompts::{
    self, CardKind, CardsOut, EnrichAnswer, EnrichItem, EnrichOut, JudgeInput, JudgeOut,
};
use core_ai::{AiError, BudgetState, CallSpec, CompletionRequest, Feature, Function, Origin};
use core_vocab::{Pos, RowGroup, VocabRow};
use serde::{Deserialize, Serialize};

use crate::ai::AiTarget;
use crate::error::AppError;
use crate::jobs::{JobHandle, JobKind, JobSink, JobStage, Started};
use crate::state::AppState;

/// Longest text accepted in one field of a request (a code answer, a sentence).
const MAX_FIELD_CHARS: usize = 20_000;
/// Longest example sentence sent for a word.
const MAX_SENTENCE_CHARS: usize = 600;

/// `ai_judge_code` (C.1): everything comes from the review screen, which already ran the checker.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiJudgeRequest {
    pub language: String,
    pub question: String,
    pub answer: String,
    pub accepted: Vec<String>,
    pub user_answer: String,
    /// The checker's verdict (`almost`, `wrong`, `unverifiable`…).
    pub auto_verdict: String,
    /// The checker's differences, as shown.
    pub diffs: String,
}

/// `ai_define_word` (C.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWordSense {
    pub lemma: String,
    /// `noun`, `verb`, `adj`, `adv`, `prep`, `conj`, `pron`, `det`, `interj` or `phrase`.
    pub class: String,
    pub definition: String,
    pub translation: String,
    /// From the cache: nothing was sent.
    pub cached: bool,
}

/// One proposed card (C.4): the fields by the prompt's names (`frente`/`verso`, `texto`…), not saved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCardProposal {
    pub fields: BTreeMap<String, String>,
    pub tags: Vec<String>,
}

/// What `ai_estimate` is asked about.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "feature")]
pub enum AiEstimateRequest {
    /// "Criar cards com IA".
    Cards {
        text: String,
        kind: CardKind,
        n: u32,
    },
    /// "Gerar deck" with AI definitions: the lemmas of a report.
    #[serde(rename_all = "camelCase")]
    Deck {
        book_uid: String,
        scan_uid: String,
        lemmas: Vec<String>,
    },
}

/// `ai_estimate`: the most the calls can cost, before anything is sent.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEstimate {
    pub worst_usd: f64,
    pub calls: u32,
    /// Words already in the cache (cost zero).
    pub cached: u32,
    /// Words that will be sent.
    pub to_send: u32,
    /// Above the confirmation threshold: the action asks first.
    pub needs_confirmation: bool,
    /// Spending state including this estimate.
    pub state: BudgetState,
    pub provider: String,
    pub model: String,
}

/// `ai_enrich_start`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEnrichStarted {
    /// `None` when every word was already in the cache.
    pub job_id: Option<String>,
    pub already_running: bool,
    pub cached: u32,
    pub to_send: u32,
}

fn too_long(what: &str) -> AppError {
    AppError::new(
        "invalid_input",
        format!("{what} é longo demais para enviar à IA."),
    )
}

fn check_len(what: &str, s: &str) -> Result<(), AppError> {
    if s.chars().count() > MAX_FIELD_CHARS {
        Err(too_long(what))
    } else {
        Ok(())
    }
}

/// The class sent with a word (the prompt's vocabulary).
pub(crate) fn class_of(pos: Option<Pos>) -> &'static str {
    match pos {
        Some(Pos::Noun) => "noun",
        Some(Pos::Verb) => "verb",
        Some(Pos::Adj) => "adj",
        Some(Pos::Adv) => "adv",
        None => "",
    }
}

/// The part of speech of an answer, when it is one of WordNet's four.
pub(crate) fn pos_of_class(class: &str) -> Option<Pos> {
    match class {
        "noun" => Some(Pos::Noun),
        "verb" => Some(Pos::Verb),
        "adj" => Some(Pos::Adj),
        "adv" => Some(Pos::Adv),
        _ => None,
    }
}

/// The Portuguese label of an answer's class (the note's "Classe").
pub(crate) fn class_label_pt(class: &str) -> Option<&'static str> {
    Some(match class {
        "noun" => "substantivo",
        "verb" => "verbo",
        "adj" => "adjetivo",
        "adv" => "advérbio",
        "prep" => "preposição",
        "conj" => "conjunção",
        "pron" => "pronome",
        "det" => "determinante",
        "interj" => "interjeição",
        "phrase" => "expressão",
        _ => return None,
    })
}

fn sentence(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_SENTENCE_CHARS)
        .collect()
}

fn request(
    t: &AiTarget,
    (system, user): (String, String),
    schema: serde_json::Value,
    name: &'static str,
) -> CompletionRequest {
    CompletionRequest {
        model: t.model.clone(),
        system,
        user,
        schema,
        schema_name: name,
        max_output_tokens: t.max_output_tokens,
        effort: t.effort,
    }
}

fn spec<'a>(t: &'a AiTarget, feature: Feature, origin: Origin) -> CallSpec<'a> {
    CallSpec {
        provider: t.provider.as_ref(),
        key: &t.key,
        price: &t.price,
        feature,
        caps: t.caps,
        origin,
    }
}

fn foreground(confirmed: bool) -> Origin {
    Origin::Foreground { confirmed }
}

/// The enrichment items of one batch request.
fn enrich_request(t: &AiTarget, items: &[EnrichItem]) -> CompletionRequest {
    request(
        t,
        prompts::enrich_prompt(items),
        prompts::enrich_schema(),
        "vocabulario",
    )
}

/// Reads the cached answer of `item`.
fn cached(
    store: &core_store::Store,
    item: &EnrichItem,
) -> core_store::Result<Option<EnrichAnswer>> {
    Ok(store
        .ai_enrichment_get(&item.lema, &prompts::context_hash(&item.frase))?
        .and_then(|p| serde_json::from_str(&p).ok()))
}

impl AppState {
    /// "Pedir avaliação da IA" (C.1). The suggested rating is only a suggestion: the user rates.
    pub async fn ai_judge_code(
        self: &Arc<Self>,
        req: AiJudgeRequest,
        confirmed: bool,
    ) -> Result<JudgeOut, AppError> {
        for (what, s) in [
            ("A pergunta", &req.question),
            ("A resposta de referência", &req.answer),
            ("A sua resposta", &req.user_answer),
            ("O resultado do verificador", &req.diffs),
        ] {
            check_len(what, s)?;
        }
        check_len("A lista de respostas aceitas", &req.accepted.concat())?;
        let t = self.ai_target(Function::Judge)?;
        let input = JudgeInput {
            linguagem: req.language,
            pergunta: req.question,
            resposta: req.answer,
            aceitas: req.accepted,
            resposta_usuario: req.user_answer,
            veredito_auto: req.auto_verdict,
            diffs: req.diffs,
        };
        let r = request(
            &t,
            prompts::judge_prompt(&input),
            prompts::judge_schema(),
            "juiz",
        );
        let out = self
            .ai_engine()
            .structured(
                &spec(&t, Feature::Judge, foreground(confirmed)),
                &r,
                prompts::validate_judge,
            )
            .await?;
        Ok(out)
    }

    /// "Criar cards com IA" (C.4): proposals only; the screen adds the ones the user keeps.
    pub async fn ai_cards_from_text(
        self: &Arc<Self>,
        text: String,
        kind: CardKind,
        n: u32,
        confirmed: bool,
    ) -> Result<Vec<AiCardProposal>, AppError> {
        let (t, r) = self.ai_cards_request(&text, kind, n)?;
        let out: CardsOut = self
            .ai_engine()
            .structured(
                &spec(&t, Feature::Cards, foreground(confirmed)),
                &r,
                |o: &CardsOut| prompts::validate_cards(kind, n, o),
            )
            .await?;
        Ok(out
            .cards
            .into_iter()
            .map(|c| AiCardProposal {
                fields: c
                    .campos
                    .into_iter()
                    .filter(|f| kind.fields().contains(&f.nome.as_str()))
                    .map(|f| (f.nome, f.valor.trim().to_owned()))
                    .collect(),
                tags: c
                    .tags
                    .into_iter()
                    .map(|t| t.trim().replace(' ', "_"))
                    .filter(|t| !t.is_empty())
                    .collect(),
            })
            .collect())
    }

    fn ai_cards_request(
        &self,
        text: &str,
        kind: CardKind,
        n: u32,
    ) -> Result<(AiTarget, CompletionRequest), AppError> {
        if !(1..=10).contains(&n) {
            return Err(AppError::new("invalid_input", "Peça de 1 a 10 cards."));
        }
        if text.trim().is_empty() {
            return Err(AppError::new(
                "invalid_input",
                "Selecione um trecho do livro.",
            ));
        }
        check_len("O trecho", text)?;
        let t = self.ai_target(Feature::Cards.function())?;
        let r = request(
            &t,
            prompts::cards_prompt(text, kind, n),
            prompts::cards_schema(),
            "cards",
        );
        Ok((t, r))
    }

    /// "Definir com IA" (C.3): the sense of `lemma` in `sentence`. The cache answers first, at no cost.
    pub async fn ai_define_word(
        self: &Arc<Self>,
        lemma: String,
        pos: Option<Pos>,
        sentence_text: String,
        confirmed: bool,
    ) -> Result<AiWordSense, AppError> {
        let lemma = lemma.trim().to_lowercase();
        if lemma.is_empty() || lemma.chars().count() > 64 {
            return Err(AppError::new("invalid_input", "Selecione uma só palavra."));
        }
        let item = EnrichItem {
            lema: lemma.clone(),
            classe: class_of(pos).to_owned(),
            frase: sentence(&sentence_text),
        };
        if let Some(a) = self.with_store(|s| cached(s, &item))? {
            return Ok(AiWordSense {
                lemma,
                class: a.classe,
                definition: a.definicao,
                translation: a.traducao,
                cached: true,
            });
        }
        let t = self.ai_target(Feature::Define.function())?;
        let items = [item];
        let r = enrich_request(&t, &items);
        let out: EnrichOut = self
            .ai_engine()
            .structured(
                &spec(&t, Feature::Define, foreground(confirmed)),
                &r,
                |o: &EnrichOut| prompts::validate_enrich(&items, o),
            )
            .await?;
        let a = out.itens.into_iter().next().ok_or(AiError::InvalidOutput)?;
        self.ai_cache_put(&items[0], &a)?;
        Ok(AiWordSense {
            lemma,
            class: a.classe,
            definition: a.definicao,
            translation: a.traducao,
            cached: false,
        })
    }

    fn ai_cache_put(&self, item: &EnrichItem, a: &EnrichAnswer) -> Result<(), AppError> {
        let payload = serde_json::to_string(a).map_err(AppError::internal)?;
        self.with_store(|s| {
            s.ai_enrichment_put(&item.lema, &prompts::context_hash(&item.frase), &payload)
        })
    }

    /// The enrichment items of the chosen rows of a report (the same rows "Gerar deck" turns into notes).
    fn ai_deck_items(
        &self,
        book_uid: &str,
        scan_uid: &str,
        lemmas: &[String],
    ) -> Result<Vec<EnrichItem>, AppError> {
        let report = self
            .vocab_report_of(scan_uid)?
            .filter(|r| r.book_uid == book_uid)
            .ok_or_else(crate::vocab::not_scanned)?;
        let wanted: HashSet<String> = lemmas.iter().map(|l| l.trim().to_lowercase()).collect();
        let mut seen = HashSet::new();
        Ok(report
            .rows
            .iter()
            .filter(|r| {
                wanted.contains(&r.lemma)
                    && r.group != RowGroup::Proper
                    && seen.insert(r.lemma.clone())
            })
            .map(enrich_item)
            .collect())
    }

    /// Splits items into (cached, to send).
    fn ai_split_cached(&self, items: Vec<EnrichItem>) -> Result<(u32, Vec<EnrichItem>), AppError> {
        self.with_store(|s| {
            let mut hits = 0;
            let mut send = Vec::new();
            for item in items {
                if cached(s, &item)?.is_some() {
                    hits += 1;
                } else {
                    send.push(item);
                }
            }
            Ok((hits, send))
        })
    }

    /// The most the calls of an action can cost, and whether it would ask for confirmation.
    pub fn ai_estimate(self: &Arc<Self>, req: AiEstimateRequest) -> Result<AiEstimate, AppError> {
        let (t, requests, cached_n, to_send) = match req {
            AiEstimateRequest::Cards { text, kind, n } => {
                let (t, r) = self.ai_cards_request(&text, kind, n)?;
                (t, vec![r], 0, 0)
            }
            AiEstimateRequest::Deck {
                book_uid,
                scan_uid,
                lemmas,
            } => {
                let items = self.ai_deck_items(&book_uid, &scan_uid, &lemmas)?;
                let (hits, send) = self.ai_split_cached(items)?;
                let t = self.ai_target(Function::Enrich)?;
                let batch = prompts::enrich_batch_size(t.max_output_tokens);
                let reqs: Vec<_> = send.chunks(batch).map(|c| enrich_request(&t, c)).collect();
                let n = send.len() as u32;
                (t, reqs, hits, n)
            }
        };
        let engine = self.ai_engine();
        let worst: f64 = requests
            .iter()
            .map(|r| engine.worst_case(&t.price, r))
            .sum();
        let spent = engine.ledger().spent()?;
        let after = core_ai::Spent {
            day_usd: spent.day_usd + worst,
            month_usd: spent.month_usd + worst,
        };
        Ok(AiEstimate {
            worst_usd: worst,
            calls: requests.len() as u32,
            cached: cached_n,
            to_send,
            needs_confirmation: worst > t.caps.confirm_above_usd,
            state: engine.budget().state(t.caps, after),
            provider: t.provider.kind().id().to_owned(),
            model: t.model,
        })
    }

    /// Enriches the chosen words of a report with AI, batch by batch, into the cache (a job: progress and cancel).
    /// The whole job is confirmed at once when its worst case is above the threshold.
    pub fn ai_enrich_start(
        self: &Arc<Self>,
        book_uid: &str,
        scan_uid: &str,
        lemmas: Vec<String>,
        confirmed: bool,
    ) -> Result<AiEnrichStarted, AppError> {
        if let Some(running) = self.vocab.jobs.running_for(JobKind::AiEnrich, book_uid) {
            return Ok(AiEnrichStarted {
                job_id: Some(running.job_id),
                already_running: true,
                cached: 0,
                to_send: 0,
            });
        }
        let items = self.ai_deck_items(book_uid, scan_uid, &lemmas)?;
        let (hits, send) = self.ai_split_cached(items)?;
        if send.is_empty() {
            return Ok(AiEnrichStarted {
                job_id: None,
                already_running: false,
                cached: hits,
                to_send: 0,
            });
        }
        let t = self.ai_target(Function::Enrich)?;
        let batch = prompts::enrich_batch_size(t.max_output_tokens);
        let engine = self.ai_engine();
        let worst: f64 = send
            .chunks(batch)
            .map(|c| engine.worst_case(&t.price, &enrich_request(&t, c)))
            .sum();
        if worst > t.caps.confirm_above_usd && !confirmed {
            return Err(AiError::NeedsConfirmation(worst).into());
        }
        let job =
            match self
                .vocab
                .jobs
                .start(JobKind::AiEnrich, book_uid, scan_uid, self.ai_job_sink())
            {
                Started::New(job) => job,
                Started::Running(running) => {
                    return Ok(AiEnrichStarted {
                        job_id: Some(running.job_id),
                        already_running: true,
                        cached: hits,
                        to_send: 0,
                    });
                }
            };
        let started = AiEnrichStarted {
            job_id: Some(job.job_id().to_owned()),
            already_running: false,
            cached: hits,
            to_send: send.len() as u32,
        };
        let state = Arc::clone(self);
        std::thread::Builder::new()
            .name("ai-enrich".into())
            .spawn(move || state.run_ai_enrich(job, t, send, batch))
            .map_err(AppError::internal)?;
        Ok(started)
    }

    fn ai_job_sink(&self) -> JobSink {
        let slot = Arc::clone(&self.ui_sink);
        Arc::new(move |p| crate::anki::emit_with(&slot, crate::anki::UiEvent::Job(p)))
    }

    fn run_ai_enrich(
        self: Arc<Self>,
        job: JobHandle,
        t: AiTarget,
        items: Vec<EnrichItem>,
        batch: usize,
    ) {
        let total = items.len() as u64;
        job.stage(JobStage::Ai, total);
        let engine = self.ai_engine();
        let mut done = 0u64;
        for chunk in items.chunks(batch) {
            if job.is_cancelled() || self.is_shutting_down() {
                job.cancelled();
                return;
            }
            let r = enrich_request(&t, chunk);
            // The user confirmed the whole job (or it was under the threshold).
            let call_spec = spec(&t, Feature::Enrich, foreground(true));
            let call = engine.structured(&call_spec, &r, |o: &EnrichOut| {
                prompts::validate_enrich(chunk, o)
            });
            match tauri::async_runtime::block_on(call) {
                Ok(out) => {
                    for (item, answer) in chunk.iter().zip(&out.itens) {
                        if let Err(e) = self.ai_cache_put(item, answer) {
                            job.failed(&e.code, &e.message);
                            return;
                        }
                    }
                    done += chunk.len() as u64;
                    job.progress(done, total);
                }
                Err(e) => {
                    let e = AppError::from(e);
                    tracing::info!(code = %e.code, "AI enrichment stopped");
                    job.failed(&e.code, &e.message);
                    return;
                }
            }
        }
        job.done();
    }

    /// The cached AI answers of `rows` ("Gerar deck" with AI): lemma → answer.
    pub(crate) fn ai_cached_answers(
        &self,
        rows: &[VocabRow],
    ) -> Result<HashMap<String, EnrichAnswer>, AppError> {
        self.with_store(|s| {
            let mut out = HashMap::new();
            for row in rows {
                if let Some(a) = cached(s, &enrich_item(row))? {
                    out.insert(row.lemma.clone(), a);
                }
            }
            Ok(out)
        })
    }
}

/// The item sent for a report row: lemma, class and the example sentence of the book (nothing else).
pub(crate) fn enrich_item(row: &VocabRow) -> EnrichItem {
    EnrichItem {
        lema: row.lemma.clone(),
        classe: class_of(row.pos).to_owned(),
        frase: row.example.as_deref().map(sentence).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_map_both_ways() {
        for pos in Pos::ALL {
            assert_eq!(pos_of_class(class_of(Some(pos))), Some(pos));
        }
        assert_eq!(pos_of_class("prep"), None);
        assert_eq!(class_label_pt("phrase"), Some("expressão"));
        assert_eq!(class_label_pt("x"), None);
    }

    #[test]
    fn sentences_are_squashed_and_cut() {
        assert_eq!(sentence("  The \n mill  "), "The mill");
        assert_eq!(
            sentence(&"a ".repeat(1000)).chars().count(),
            MAX_SENTENCE_CHARS
        );
    }
}
