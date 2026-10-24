//! One AI call end to end (plan 3.6): estimate the worst case, reserve it against the caps (or refuse/ask for
//! confirmation), call the provider, record the real cost from the usage the API returned, release the reservation.
//! Structured calls validate the JSON and retry once with the error; a cut at the output cap retries once at the
//! model's lowest thinking setting (plan 0.2, item 6).

use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use serde::de::DeserializeOwned;

use crate::cost::{actual_usd, estimate_input_tokens, worst_case_usd};
use crate::error::{AiError, Result};
use crate::limits::{Budget, Caps, Origin, Spent};
use crate::prices::ModelPrice;
use crate::provider::Provider;
use crate::types::{
    ApiKey, Completion, CompletionRequest, Effort, Feature, ProviderKind, Stop, Usage,
};

/// One billed call, as stored in `ai_usage`.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageRecord {
    pub at: DateTime<Utc>,
    pub feature: Feature,
    pub provider: ProviderKind,
    pub model: String,
    pub usage: Usage,
    pub cost_usd: f64,
    /// No usage came back: the call is recorded at its worst case.
    pub estimated: bool,
    pub prices_checked_at: NaiveDate,
}

/// Where spending is read from and written to (the app's SQLite store).
pub trait Ledger: Send + Sync {
    /// Spent today and this month (local calendar), over every provider.
    fn spent(&self) -> Result<Spent>;
    fn record(&self, rec: &UsageRecord) -> Result<()>;
}

/// Everything one call needs besides the request.
pub struct CallSpec<'a> {
    pub provider: &'a dyn Provider,
    pub key: &'a ApiKey,
    pub price: &'a ModelPrice,
    pub feature: Feature,
    pub caps: Caps,
    pub origin: Origin,
}

#[derive(Clone)]
pub struct Engine {
    budget: Budget,
    ledger: Arc<dyn Ledger>,
}

impl Engine {
    pub fn new(ledger: Arc<dyn Ledger>) -> Self {
        Self {
            budget: Budget::default(),
            ledger,
        }
    }

    pub fn budget(&self) -> &Budget {
        &self.budget
    }

    pub fn ledger(&self) -> &Arc<dyn Ledger> {
        &self.ledger
    }

    /// The worst case of a request, as shown before a call and checked against the caps.
    pub fn worst_case(&self, price: &ModelPrice, req: &CompletionRequest) -> f64 {
        let input = estimate_input_tokens(&req.system)
            + estimate_input_tokens(&req.user)
            + estimate_input_tokens(&req.schema.to_string());
        worst_case_usd(price, Utc::now(), input, req.max_output_tokens)
    }

    /// One raw call with budget and accounting. Failures before an answer (network, auth…) aren't billed.
    pub async fn call(&self, spec: &CallSpec<'_>, req: &CompletionRequest) -> Result<Completion> {
        let worst = self.worst_case(spec.price, req);
        let spent = self.ledger.spent()?;
        let reservation = self.budget.reserve(spec.caps, spent, worst, spec.origin)?;
        let result = spec.provider.complete(spec.key, req, spec.price).await;
        if let Ok(c) = &result {
            let at = Utc::now();
            let (usage, cost, estimated) = match c.usage {
                Some(u) => (u, actual_usd(spec.price, at, &u), false),
                None => (Usage::default(), worst, true),
            };
            self.ledger.record(&UsageRecord {
                at,
                feature: spec.feature,
                provider: spec.provider.kind(),
                model: req.model.clone(),
                usage,
                cost_usd: cost,
                estimated,
                prices_checked_at: spec.price.checked_at,
            })?;
        }
        drop(reservation);
        result
    }

    /// A structured call: parse + validate, one retry with the error, one retry at minimum effort if cut.
    pub async fn structured<T: DeserializeOwned>(
        &self,
        spec: &CallSpec<'_>,
        req: &CompletionRequest,
        validate: impl Fn(&T) -> std::result::Result<(), String>,
    ) -> Result<T> {
        let mut req = req.clone();
        let mut retried_invalid = false;
        let mut retried_cut = false;
        loop {
            let c = self.call(spec, &req).await?;
            match c.stop {
                Stop::Refused => return Err(AiError::Refused),
                Stop::Length => {
                    if !retried_cut && req.effort != Effort::Minimum {
                        retried_cut = true;
                        req.effort = Effort::Minimum;
                        continue;
                    }
                    return Err(AiError::Truncated);
                }
                Stop::Done | Stop::Other => {}
            }
            let parsed = serde_json::from_str::<T>(extract_json(&c.text))
                .map_err(|e| format!("JSON inválido: {e}"))
                .and_then(|v| validate(&v).map(|()| v));
            match parsed {
                Ok(v) => return Ok(v),
                Err(why) if !retried_invalid => {
                    retried_invalid = true;
                    req.user = format!(
                        "{}\n\nSua resposta anterior foi recusada pela validação: {why}. Responda de novo, só com \
                         JSON válido no schema.",
                        req.user
                    );
                }
                Err(_) => return Err(AiError::InvalidOutput),
            }
        }
    }
}

/// The JSON object in a reply (tolerates a ```json fence some providers add in JSON mode).
fn extract_json(text: &str) -> &str {
    let t = text.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prices::PriceTable;
    use crate::simulated::SimulatedProvider;
    use serde_json::json;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemLedger {
        spent: Mutex<Spent>,
        records: Mutex<Vec<UsageRecord>>,
    }

    impl Ledger for MemLedger {
        fn spent(&self) -> Result<Spent> {
            Ok(*self.spent.lock().unwrap())
        }
        fn record(&self, rec: &UsageRecord) -> Result<()> {
            let mut s = self.spent.lock().unwrap();
            s.day_usd += rec.cost_usd;
            s.month_usd += rec.cost_usd;
            self.records.lock().unwrap().push(rec.clone());
            Ok(())
        }
    }

    fn req(effort: Effort) -> CompletionRequest {
        CompletionRequest {
            model: "claude-sonnet-5-5".into(),
            system: "s".into(),
            user: "u".into(),
            schema: json!({}),
            schema_name: "t",
            max_output_tokens: 2000,
            effort,
        }
    }

    fn done(text: &str, output: u64) -> Result<Completion> {
        Ok(Completion {
            text: text.into(),
            usage: Some(Usage {
                input: 100,
                output,
                ..Usage::default()
            }),
            stop: Stop::Done,
        })
    }

    #[derive(serde::Deserialize, Debug)]
    struct Out {
        n: u8,
    }

    fn run(
        sim: &SimulatedProvider,
        ledger: Arc<MemLedger>,
        caps: Caps,
        effort: Effort,
    ) -> (Result<Out>, Arc<MemLedger>) {
        let prices = PriceTable::built_in();
        let price = prices
            .get(ProviderKind::Anthropic, "claude-sonnet-5-5")
            .unwrap()
            .clone();
        let key = ApiKey::new("test-key-TEST").unwrap();
        let engine = Engine::new(ledger.clone());
        let spec = CallSpec {
            provider: sim,
            key: &key,
            price: &price,
            feature: Feature::Judge,
            caps,
            origin: Origin::Foreground { confirmed: false },
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let r = rt.block_on(engine.structured::<Out>(&spec, &req(effort), |o| {
            if o.n <= 4 {
                Ok(())
            } else {
                Err("n deve ser até 4".into())
            }
        }));
        (r, ledger)
    }

    #[test]
    fn records_the_real_cost_and_retries_invalid_json_once() {
        let sim = SimulatedProvider::new(
            ProviderKind::Anthropic,
            vec![done("```json\n{\"n\": 9}\n```", 50), done("{\"n\": 3}", 40)],
        );
        let (r, ledger) = run(&sim, Arc::default(), Caps::default(), Effort::Low);
        assert_eq!(r.unwrap().n, 3);
        assert_eq!(sim.calls(), 2);
        let recs = ledger.records.lock().unwrap();
        assert_eq!(recs.len(), 2, "both calls are billed");
        assert!((recs[1].cost_usd - (100.0 * 2.0 + 40.0 * 10.0) / 1e6).abs() < 1e-12);
        assert!(
            sim.last_request()
                .unwrap()
                .user
                .contains("recusada pela validação")
        );
    }

    #[test]
    fn a_cut_answer_retries_once_at_minimum_effort() {
        let cut = Ok(Completion {
            text: "{\"n".into(),
            usage: Some(Usage::default()),
            stop: Stop::Length,
        });
        let sim = SimulatedProvider::new(
            ProviderKind::Anthropic,
            vec![cut.clone(), done("{\"n\": 1}", 10)],
        );
        let (r, _) = run(&sim, Arc::default(), Caps::default(), Effort::Low);
        assert_eq!(r.unwrap().n, 1);
        assert_eq!(sim.last_request().unwrap().effort, Effort::Minimum);
        let sim = SimulatedProvider::new(ProviderKind::Anthropic, vec![cut]);
        let (r, _) = run(&sim, Arc::default(), Caps::default(), Effort::Minimum);
        assert_eq!(r.unwrap_err().code(), "ai_truncated");
    }

    #[test]
    fn no_call_leaves_once_a_cap_is_reached() {
        let sim = SimulatedProvider::new(ProviderKind::Anthropic, vec![done("{\"n\": 1}", 10)]);
        let ledger = Arc::new(MemLedger::default());
        *ledger.spent.lock().unwrap() = Spent {
            day_usd: 1.0,
            month_usd: 1.0,
        };
        let (r, _) = run(&sim, ledger, Caps::default(), Effort::Low);
        assert_eq!(r.unwrap_err().code(), "ai_limit_reached");
        assert_eq!(sim.calls(), 0);
    }

    #[test]
    fn missing_usage_is_recorded_at_the_worst_case() {
        let sim = SimulatedProvider::new(
            ProviderKind::Anthropic,
            vec![Ok(Completion {
                text: "{\"n\": 2}".into(),
                usage: None,
                stop: Stop::Done,
            })],
        );
        let (r, ledger) = run(&sim, Arc::default(), Caps::default(), Effort::Low);
        assert_eq!(r.unwrap().n, 2);
        let recs = ledger.records.lock().unwrap();
        assert!(recs[0].estimated && recs[0].cost_usd > 0.0);
    }
}
