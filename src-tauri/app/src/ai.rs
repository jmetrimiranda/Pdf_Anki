//! AI in the app (spec 13, plan `docs/planos/fase-8.md`): the settings of each function, the provider keys in the
//! system keychain, the price table with the user's edits and the spending of the day and the month. Every call
//! leaves from here (never from the webview), through [`core_ai::Engine`]: reserve the worst case against the caps,
//! call, record the real cost in `ai_usage`.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone};
use core_ai::limits::Caps;
use core_ai::{
    AiError, ApiKey, Budget, BudgetState, Effort, Engine, Function, Ledger, ModelPrice, PriceTable,
    Provider, ProviderKind, Rates, Spent, UsageRecord,
};
use core_store::{AiUsageRow, AiUsageTotal, Store, setting_keys as keys};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::book_panel::double_option;
use crate::error::AppError;
use crate::state::AppState;

/// The AI state shared by every call: the reservations of the calls in flight and the adapters.
pub struct AiHub {
    budget: Budget,
    /// The adapter of each provider; tests point them at a local fake server.
    providers: RwLock<HashMap<ProviderKind, Arc<dyn Provider>>>,
    /// The background enrichment worker.
    pub(crate) queue: crate::ai_queue::QueueHub,
}

impl Default for AiHub {
    fn default() -> Self {
        let providers = ProviderKind::ALL
            .into_iter()
            .filter_map(|k| core_ai::provider_for(k).map(|p| (k, Arc::from(p))))
            .collect();
        Self {
            budget: Budget::default(),
            providers: RwLock::new(providers),
            queue: Default::default(),
        }
    }
}

impl AiHub {
    /// Replaces the adapter of a provider (tests: an adapter aimed at a local server, or a simulated one).
    pub fn set_provider(&self, provider: Arc<dyn Provider>) {
        let kind = provider.kind();
        self.providers
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(kind, provider);
    }

    pub(crate) fn provider(&self, kind: ProviderKind) -> Option<Arc<dyn Provider>> {
        self.providers
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(&kind)
            .cloned()
    }

    fn available(&self, kind: ProviderKind) -> bool {
        self.provider(kind).is_some()
    }
}

impl From<AiError> for AppError {
    fn from(e: AiError) -> Self {
        // AI messages never carry provider bodies or keys (core-ai turns them into codes).
        AppError::new(e.code(), e.to_string())
    }
}

/// Start of the local day and month, as epoch ms: the caps follow the user's calendar.
fn period_starts(now: DateTime<Local>) -> (i64, i64) {
    let day = now.date_naive();
    let month = day.with_day(1).unwrap_or(day);
    let ms = |d: NaiveDate| {
        let midnight = NaiveDateTime::from(d);
        Local.from_local_datetime(&midnight).earliest().map_or_else(
            || midnight.and_utc().timestamp_millis(),
            |t| t.timestamp_millis(),
        )
    };
    (ms(day), ms(month))
}

fn spent(store: &Store) -> core_store::Result<Spent> {
    let (day, month) = period_starts(Local::now());
    Ok(Spent {
        day_usd: store.ai_spent_since(day)?,
        month_usd: store.ai_spent_since(month)?,
    })
}

/// `ai_usage` as the engine's ledger.
struct StoreLedger(Arc<AppState>);

impl Ledger for StoreLedger {
    fn spent(&self) -> core_ai::Result<Spent> {
        self.0
            .with_store(|s| spent(s))
            .map_err(|e| AiError::Internal(e.message))
    }

    fn record(&self, rec: &UsageRecord) -> core_ai::Result<()> {
        let row = AiUsageRow {
            at: rec.at.timestamp_millis(),
            feature: rec.feature.id().to_owned(),
            provider: rec.provider.id().to_owned(),
            model: rec.model.clone(),
            tokens_in: rec.usage.input,
            tokens_cached_in: rec.usage.cached_input,
            tokens_cache_write: rec.usage.cache_write,
            tokens_out: rec.usage.output,
            tokens_thinking: rec.usage.thinking,
            cost_usd: rec.cost_usd,
            estimated: rec.estimated,
            prices_checked_at: Some(rec.prices_checked_at.to_string()),
        };
        self.0
            .with_store(|s| s.add_ai_usage(&row))
            .map_err(|e| AiError::Internal(e.message))
    }
}

/// Provider, model and effort of one function.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFunctionSettings {
    /// `None` = this function is off.
    pub provider: Option<ProviderKind>,
    /// The model chosen by the user; `None` = the provider's default for the function.
    pub model: Option<String>,
    /// The model the calls use.
    pub effective_model: Option<String>,
    pub effort: Effort,
    pub max_output_tokens: u32,
}

/// One provider in Configurações → IA. The key itself never leaves the keychain: only its last 4 characters.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInfo {
    pub id: ProviderKind,
    pub label: &'static str,
    /// The adapter exists in this version.
    pub available: bool,
    pub has_key: bool,
    pub key_suffix: Option<String>,
}

/// `ai_settings_get`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub enrich: AiFunctionSettings,
    pub judge: AiFunctionSettings,
    pub limit_day_usd: f64,
    pub limit_month_usd: f64,
    pub confirm_above_usd: f64,
    pub background_enrich: bool,
    pub background_paused: bool,
    pub providers: Vec<AiProviderInfo>,
    /// `false` when the system keychain couldn't be read (keys can't be kept).
    pub keychain_available: bool,
}

/// A change to one function. A missing field is left alone; `provider: null` turns the function off.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiFunctionPatch {
    #[serde(deserialize_with = "double_option")]
    pub provider: Option<Option<ProviderKind>>,
    #[serde(deserialize_with = "double_option")]
    pub model: Option<Option<String>>,
    pub effort: Option<Effort>,
    pub max_output_tokens: Option<u32>,
}

/// `ai_settings_set`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettingsPatch {
    pub enrich: Option<AiFunctionPatch>,
    pub judge: Option<AiFunctionPatch>,
    pub limit_day_usd: Option<f64>,
    pub limit_month_usd: Option<f64>,
    pub confirm_above_usd: Option<f64>,
    pub background_enrich: Option<bool>,
    pub background_paused: Option<bool>,
    /// Providers the user just agreed to send data to (the activation dialog, plan 5.2). Choosing a provider for a
    /// function requires it in the same patch: every activation and every switch asks again.
    pub consent: Vec<ProviderKind>,
}

/// `ai_key_test`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyTest {
    pub ok: bool,
    /// The error code when not ok (`ai_auth`, `ai_model_not_found`, `ai_offline`…).
    pub code: Option<String>,
    pub message: String,
    pub model: String,
}

/// One model of the price table.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelPrice {
    pub provider: String,
    pub model: String,
    /// `enrich` or `judge` when it is that function's default model.
    pub role_default: Option<String>,
    pub checked_at: String,
    pub source: Option<String>,
    /// US$ per million tokens (base tier).
    pub input: f64,
    pub cached_input: Option<f64>,
    pub output: f64,
    /// Other prices apply to long prompts, some hours or from some date (see the table's source).
    pub has_tiers: bool,
    /// Edited by the user.
    pub edited: bool,
    /// Checked more than 90 days ago.
    pub stale: bool,
}

/// `ai_usage`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub day_usd: f64,
    pub month_usd: f64,
    pub limit_day_usd: f64,
    pub limit_month_usd: f64,
    /// Including the calls in flight.
    pub state: BudgetState,
    pub day: Vec<AiUsageTotal>,
    pub month: Vec<AiUsageTotal>,
}

/// What one function needs for a call.
pub(crate) struct AiTarget {
    pub provider: Arc<dyn Provider>,
    pub key: ApiKey,
    pub price: ModelPrice,
    pub model: String,
    pub effort: Effort,
    pub max_output_tokens: u32,
    pub caps: Caps,
}

fn function_keys(f: Function) -> [&'static str; 4] {
    match f {
        Function::Enrich => [
            keys::AI_ENRICH_PROVIDER,
            keys::AI_ENRICH_MODEL,
            keys::AI_ENRICH_EFFORT,
            keys::AI_ENRICH_MAX_TOKENS,
        ],
        Function::Judge => [
            keys::AI_JUDGE_PROVIDER,
            keys::AI_JUDGE_MODEL,
            keys::AI_JUDGE_EFFORT,
            keys::AI_JUDGE_MAX_TOKENS,
        ],
    }
}

fn role(f: Function) -> &'static str {
    match f {
        Function::Enrich => "enrich",
        Function::Judge => "judge",
    }
}

fn read_function(
    store: &Store,
    prices: &PriceTable,
    f: Function,
) -> core_store::Result<AiFunctionSettings> {
    let [p, m, e, t] = function_keys(f);
    let provider = store
        .setting_as::<Option<String>>(p)?
        .and_then(|s| ProviderKind::parse(&s));
    let model: Option<String> = store.setting_as(m)?;
    let effort = store
        .setting_as::<String>(e)
        .ok()
        .and_then(|s| Effort::parse(&s))
        .unwrap_or_default();
    let effective_model = provider.and_then(|p| {
        model
            .clone()
            .or_else(|| prices.default_model(p, role(f)).map(str::to_owned))
    });
    Ok(AiFunctionSettings {
        provider,
        model,
        effective_model,
        effort,
        max_output_tokens: store.setting_as(t)?,
    })
}

fn caps(store: &Store) -> core_store::Result<Caps> {
    Ok(Caps {
        day_usd: store.setting_as(keys::AI_LIMIT_DAY_USD)?,
        month_usd: store.setting_as(keys::AI_LIMIT_MONTH_USD)?,
        confirm_above_usd: store.setting_as(keys::AI_CONFIRM_ABOVE_USD)?,
    })
}

/// A stored price edit: the rates plus the day it was made.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceEdit {
    #[serde(flatten)]
    rates: Rates,
    edited_at: NaiveDate,
}

fn price_key(provider: ProviderKind, model: &str) -> String {
    format!("{}/{model}", provider.id())
}

/// The built-in table with the user's edits. An edit replaces the model's prices flat (no tiers).
fn price_table(store: &Store) -> core_store::Result<PriceTable> {
    let edits: Map<String, Value> = store.setting_as(keys::AI_PRICE_OVERRIDES)?;
    let built_in = PriceTable::built_in();
    let mut overrides = Vec::new();
    for (k, v) in edits {
        let Some((provider, model)) = k.split_once('/') else {
            continue;
        };
        let (Some(kind), Ok(edit)) = (
            ProviderKind::parse(provider),
            serde_json::from_value::<PriceEdit>(v),
        ) else {
            continue;
        };
        let mut price = match built_in.get(kind, model) {
            Ok(p) => p.clone(),
            Err(_) => ModelPrice {
                provider: kind.id().to_owned(),
                id: model.to_owned(),
                role_default: None,
                checked_at: edit.edited_at,
                source: None,
                rates: edit.rates,
                effort_param: "none".into(),
                effort_levels: Vec::new(),
                thinking_off: String::new(),
                max_tokens_includes_thinking: "unverified".into(),
                tiers: Vec::new(),
            },
        };
        price.rates = edit.rates;
        price.tiers.clear();
        price.checked_at = edit.edited_at;
        price.source = None;
        overrides.push(price);
    }
    Ok(built_in.with_overrides(&overrides))
}

fn check_rates(r: &Rates) -> Result<(), AppError> {
    let ok = |x: f64| x.is_finite() && (0.0..=10_000.0).contains(&x);
    if ok(r.input) && ok(r.output) && r.cached_input.is_none_or(ok) && r.cache_write.is_none_or(ok)
    {
        Ok(())
    } else {
        Err(AppError::new(
            "invalid_input",
            "Preço inválido: use valores em US$ por milhão de tokens, de 0 a 10 000.",
        ))
    }
}

fn check_key_text(key: &str) -> Result<&str, AppError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::new("invalid_input", "Cole a chave do provedor."));
    }
    if key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new(
            "invalid_input",
            "A chave tem caracteres inválidos (espaços ou quebras de linha).",
        ));
    }
    Ok(key)
}

fn keychain_error(e: AppError) -> AppError {
    if e.code == "keychain_unavailable" {
        AppError::new(
            e.code,
            "O chaveiro do sistema não está disponível; a chave de IA não foi guardada.",
        )
    } else {
        e
    }
}

fn unavailable(kind: ProviderKind) -> AppError {
    AppError::new(
        "ai_provider_unavailable",
        format!("{} chega numa próxima versão do app.", kind.label()),
    )
}

impl AppState {
    pub fn ai_hub(&self) -> &AiHub {
        &self.ai
    }

    fn ai_key(&self, kind: ProviderKind) -> Result<Option<ApiKey>, AppError> {
        Ok(self
            .sync
            .secrets
            .get(&kind.keychain_account())?
            .and_then(|k| ApiKey::new(&k)))
    }

    /// The engine of one call: the app's shared reservations, `ai_usage` as the ledger.
    pub(crate) fn ai_engine(self: &Arc<Self>) -> Engine {
        Engine::with_budget(
            self.ai.budget.clone(),
            Arc::new(StoreLedger(Arc::clone(self))),
        )
    }

    /// Everything a call of `f` needs; errors when the function is off, the adapter or the key is missing, or the
    /// model has no price. Never opens a connection.
    pub(crate) fn ai_target(&self, f: Function) -> Result<AiTarget, AppError> {
        let (settings, prices, caps) = self.with_store(|s| {
            let prices = price_table(s)?;
            Ok((read_function(s, &prices, f)?, prices, caps(s)?))
        })?;
        let kind = settings.provider.ok_or(AiError::Disabled)?;
        let provider = self.ai.provider(kind).ok_or_else(|| unavailable(kind))?;
        let model = settings.effective_model.ok_or(AiError::Disabled)?;
        let price = prices.get(kind, &model)?.clone();
        let key = self.ai_key(kind)?.ok_or(AiError::NoKey(kind.label()))?;
        Ok(AiTarget {
            provider,
            key,
            price,
            model,
            effort: settings.effort,
            max_output_tokens: settings.max_output_tokens,
            caps,
        })
    }

    pub fn ai_settings_get(&self) -> Result<AiSettings, AppError> {
        let mut keychain_available = true;
        let providers = ProviderKind::ALL
            .into_iter()
            .map(|kind| {
                let key = self.ai_key(kind).unwrap_or_else(|_| {
                    keychain_available = false;
                    None
                });
                AiProviderInfo {
                    id: kind,
                    label: kind.label(),
                    available: self.ai.available(kind),
                    has_key: key.is_some(),
                    key_suffix: key.map(|k| k.suffix()),
                }
            })
            .collect();
        self.with_store(|s| {
            let prices = price_table(s)?;
            let caps = caps(s)?;
            Ok(AiSettings {
                enrich: read_function(s, &prices, Function::Enrich)?,
                judge: read_function(s, &prices, Function::Judge)?,
                limit_day_usd: caps.day_usd,
                limit_month_usd: caps.month_usd,
                confirm_above_usd: caps.confirm_above_usd,
                background_enrich: s.setting_as(keys::AI_BACKGROUND_ENRICH)?,
                background_paused: s.setting_as(keys::AI_BACKGROUND_PAUSED)?,
                providers,
                keychain_available,
            })
        })
    }

    pub fn ai_settings_set(&self, patch: AiSettingsPatch) -> Result<AiSettings, AppError> {
        let mut writes: Vec<(&'static str, Value)> = Vec::new();
        let now = core_store::now_ms();
        self.with_store(|s| {
            let prices = price_table(s)?;
            Ok((
                prices.clone(),
                read_function(s, &prices, Function::Enrich)?,
                read_function(s, &prices, Function::Judge)?,
            ))
        })
        .and_then(|(prices, enrich, judge)| {
            for (f, current, p) in [
                (Function::Enrich, enrich, patch.enrich.as_ref()),
                (Function::Judge, judge, patch.judge.as_ref()),
            ] {
                let Some(p) = p else { continue };
                let [pk, mk, ek, tk] = function_keys(f);
                let provider = p.provider.unwrap_or(current.provider);
                let changed = provider != current.provider;
                if let Some(kind) = provider.filter(|_| changed) {
                    if !self.ai.available(kind) {
                        return Err(unavailable(kind));
                    }
                    if !patch.consent.contains(&kind) {
                        return Err(AppError::new(
                            "ai_consent_required",
                            format!(
                                "Confirme o que será enviado para {} antes de ativá-lo.",
                                kind.label()
                            ),
                        ));
                    }
                }
                if p.provider.is_some() {
                    writes.push((pk, serde_json::to_value(provider).unwrap_or(Value::Null)));
                }
                // A new provider starts on its default model unless the patch names one.
                let model = match &p.model {
                    Some(m) => m
                        .as_ref()
                        .map(|m| m.trim().to_owned())
                        .filter(|m| !m.is_empty()),
                    None if changed => None,
                    None => current.model.clone(),
                };
                if let (Some(kind), Some(m)) = (provider, &model) {
                    prices.get(kind, m)?;
                }
                if p.model.is_some() || changed {
                    writes.push((mk, serde_json::to_value(&model).unwrap_or(Value::Null)));
                }
                if let Some(e) = p.effort {
                    writes.push((ek, serde_json::to_value(e).unwrap_or(Value::Null)));
                }
                if let Some(t) = p.max_output_tokens {
                    writes.push((tk, t.into()));
                }
            }
            Ok(())
        })?;
        for (key, v) in [
            (keys::AI_LIMIT_DAY_USD, patch.limit_day_usd),
            (keys::AI_LIMIT_MONTH_USD, patch.limit_month_usd),
            (keys::AI_CONFIRM_ABOVE_USD, patch.confirm_above_usd),
        ] {
            if let Some(v) = v {
                writes.push((key, v.into()));
            }
        }
        if let Some(b) = patch.background_enrich {
            writes.push((keys::AI_BACKGROUND_ENRICH, b.into()));
        }
        if let Some(b) = patch.background_paused {
            writes.push((keys::AI_BACKGROUND_PAUSED, b.into()));
        }
        self.with_store(|s| {
            if !patch.consent.is_empty() {
                let mut consent: Map<String, Value> = s.setting_as(keys::AI_CONSENT)?;
                for kind in &patch.consent {
                    consent.insert(kind.id().to_owned(), now.into());
                }
                writes.push((keys::AI_CONSENT, Value::Object(consent)));
            }
            for (key, value) in writes {
                s.set_setting(key, value)?;
            }
            Ok(())
        })?;
        // A provider, key or cap change may unblock the background queue.
        self.ai_queue_kick();
        self.ai_settings_get()
    }

    pub fn ai_key_set(&self, provider: ProviderKind, key: &str) -> Result<AiSettings, AppError> {
        let key = check_key_text(key)?;
        self.sync
            .secrets
            .set(&provider.keychain_account(), key)
            .map_err(keychain_error)?;
        tracing::info!(provider = provider.id(), "AI key stored in the keychain");
        self.ai_queue_kick();
        self.ai_settings_get()
    }

    pub fn ai_key_delete(&self, provider: ProviderKind) -> Result<AiSettings, AppError> {
        self.sync
            .secrets
            .delete(&provider.keychain_account())
            .map_err(keychain_error)?;
        tracing::info!(provider = provider.id(), "AI key removed from the keychain");
        self.ai_settings_get()
    }

    /// "Testar chave" (plan 4): a call with no tokens, only on the user's click. The model is the one a function uses
    /// with this provider, else the provider's default for enrichment.
    pub async fn ai_key_test(&self, provider: ProviderKind) -> Result<AiKeyTest, AppError> {
        let adapter = self
            .ai
            .provider(provider)
            .ok_or_else(|| unavailable(provider))?;
        let key = self
            .ai_key(provider)?
            .ok_or(AiError::NoKey(provider.label()))?;
        let model = self.with_store(|s| {
            let prices = price_table(s)?;
            let mut model = None;
            for f in [Function::Enrich, Function::Judge] {
                let fs = read_function(s, &prices, f)?;
                if fs.provider == Some(provider) && model.is_none() {
                    model = fs.effective_model;
                }
            }
            Ok(model.or_else(|| prices.default_model(provider, "enrich").map(str::to_owned)))
        })?;
        let model = model.ok_or_else(|| AppError::internal("no default model"))?;
        Ok(match adapter.test_key(&key, &model).await {
            Ok(()) => AiKeyTest {
                ok: true,
                code: None,
                message: format!("Chave válida (modelo {model})."),
                model,
            },
            Err(e) => AiKeyTest {
                ok: false,
                code: Some(e.code().to_owned()),
                message: e.to_string(),
                model,
            },
        })
    }

    pub fn ai_prices_get(&self) -> Result<Vec<AiModelPrice>, AppError> {
        let today = Local::now().date_naive();
        self.with_store(|s| {
            let edits: Map<String, Value> = s.setting_as(keys::AI_PRICE_OVERRIDES)?;
            let table = price_table(s)?;
            Ok(table
                .models()
                .iter()
                .map(|m| AiModelPrice {
                    provider: m.provider.clone(),
                    model: m.id.clone(),
                    role_default: m.role_default.clone(),
                    checked_at: m.checked_at.to_string(),
                    source: m.source.clone(),
                    input: m.rates.input,
                    cached_input: m.rates.cached_input,
                    output: m.rates.output,
                    has_tiers: !m.tiers.is_empty(),
                    edited: edits.contains_key(&format!("{}/{}", m.provider, m.id)),
                    stale: m.is_stale(today),
                })
                .collect())
        })
    }

    /// Edits (or, with `rates: None`, restores) the price of a model. A model not in the table can be added: that is
    /// how a new model becomes usable (a model without a price is refused).
    pub fn ai_prices_set(
        &self,
        provider: ProviderKind,
        model: &str,
        rates: Option<Rates>,
    ) -> Result<Vec<AiModelPrice>, AppError> {
        let model = model.trim();
        if model.is_empty() || model.len() > 100 || model.contains('/') {
            return Err(AppError::new("invalid_input", "Nome de modelo inválido."));
        }
        if let Some(r) = &rates {
            check_rates(r)?;
        }
        let today = Local::now().date_naive();
        self.with_store(|s| {
            let mut edits: Map<String, Value> = s.setting_as(keys::AI_PRICE_OVERRIDES)?;
            let k = price_key(provider, model);
            match rates {
                Some(rates) => {
                    let edit = PriceEdit {
                        rates,
                        edited_at: today,
                    };
                    edits.insert(k, serde_json::to_value(edit).unwrap_or(Value::Null));
                }
                None => {
                    edits.remove(&k);
                }
            }
            s.set_setting(keys::AI_PRICE_OVERRIDES, Value::Object(edits))
        })?;
        self.ai_prices_get()
    }

    pub fn ai_usage(&self) -> Result<AiUsage, AppError> {
        let (day_start, month_start) = period_starts(Local::now());
        self.with_store(|s| {
            let caps = caps(s)?;
            let spent = spent(s)?;
            Ok(AiUsage {
                day_usd: spent.day_usd,
                month_usd: spent.month_usd,
                limit_day_usd: caps.day_usd,
                limit_month_usd: caps.month_usd,
                state: self.ai.budget.state(caps, spent),
                day: s.ai_usage_totals(day_start)?,
                month: s.ai_usage_totals(month_start)?,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods_start_at_local_midnight_and_the_first() {
        let now = Local.with_ymd_and_hms(2026, 10, 24, 15, 30, 0).unwrap();
        let (day, month) = period_starts(now);
        let d = Local.timestamp_millis_opt(day).unwrap();
        let m = Local.timestamp_millis_opt(month).unwrap();
        assert_eq!((d.day(), d.hour_of_day()), (24, 0));
        assert_eq!((m.month(), m.day(), m.hour_of_day()), (10, 1, 0));
    }

    trait Hour {
        fn hour_of_day(&self) -> u32;
    }

    impl Hour for DateTime<Local> {
        fn hour_of_day(&self) -> u32 {
            chrono::Timelike::hour(self)
        }
    }

    #[test]
    fn key_text_is_checked() {
        assert!(check_key_text("  ").is_err());
        assert!(check_key_text("abc def").is_err());
        assert!(
            check_key_text("abc\n").is_ok(),
            "trailing newline of a paste is trimmed"
        );
        assert_eq!(check_key_text(" test-key-1234 ").unwrap(), "test-key-1234");
    }

    #[test]
    fn rates_are_checked() {
        let r = |input: f64| Rates {
            input,
            cached_input: None,
            cache_write: None,
            output: 1.0,
        };
        assert!(check_rates(&r(0.1)).is_ok());
        assert!(check_rates(&r(-1.0)).is_err());
        assert!(check_rates(&r(f64::NAN)).is_err());
    }
}
