//! The model price table (plan 3.2): `model-prices.toml`, built into the binary, plus the user's overrides.

use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, Utc, Weekday};
use serde::{Deserialize, Serialize};

use crate::error::{AiError, Result};
use crate::types::ProviderKind;

const BUILT_IN: &str = include_str!("../model-prices.toml");

/// US$ per million tokens.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub input: f64,
    /// Price of cached input; defaults to `input` when the provider has no cache discount.
    #[serde(default, alias = "cached_input")]
    pub cached_input: Option<f64>,
    #[serde(default, alias = "cache_write")]
    pub cache_write: Option<f64>,
    pub output: f64,
}

impl Rates {
    fn cached(&self) -> f64 {
        self.cached_input.unwrap_or(self.input)
    }

    fn write(&self) -> f64 {
        self.cache_write.unwrap_or(self.input)
    }

    fn max(self, o: Rates) -> Rates {
        Rates {
            input: self.input.max(o.input),
            cached_input: Some(self.cached().max(o.cached())),
            cache_write: Some(self.write().max(o.write())),
            output: self.output.max(o.output),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Tier {
    #[serde(default)]
    pub min_prompt_tokens: Option<u64>,
    #[serde(default)]
    pub valid_from: Option<NaiveDate>,
    /// "HH:MM-HH:MM" in UTC.
    #[serde(default)]
    pub utc_windows: Vec<String>,
    /// "mon-fri" or empty (every day).
    #[serde(default)]
    pub weekdays: Option<String>,
    #[serde(flatten)]
    pub rates: Rates,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelPrice {
    pub provider: String,
    pub id: String,
    #[serde(default)]
    pub role_default: Option<String>,
    pub checked_at: NaiveDate,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(flatten)]
    pub rates: Rates,
    #[serde(default = "none_str")]
    pub effort_param: String,
    #[serde(default)]
    pub effort_levels: Vec<String>,
    /// How "mínimo" turns thinking off; empty = it can't be turned off.
    #[serde(default)]
    pub thinking_off: String,
    #[serde(default = "unverified")]
    pub max_tokens_includes_thinking: String,
    #[serde(default, rename = "tier")]
    pub tiers: Vec<Tier>,
}

fn none_str() -> String {
    "none".into()
}

fn unverified() -> String {
    "unverified".into()
}

impl ModelPrice {
    /// The rates billed for a call made at `at` with this prompt size.
    pub fn rates_at(&self, at: DateTime<Utc>, prompt_tokens: u64) -> Rates {
        let mut rates = self.rates;
        for tier in &self.tiers {
            if tier_applies(tier, at, prompt_tokens) {
                rates = tier.rates;
            }
        }
        rates
    }

    /// The most expensive rates that could apply to a call at `at` (any time window counts as possible):
    /// the pre-call estimate never under-reserves (plan 3.6).
    pub fn worst_rates(&self, at: DateTime<Utc>, prompt_tokens: u64) -> Rates {
        let mut rates = self.rates;
        for tier in &self.tiers {
            let size_ok = tier.min_prompt_tokens.is_none_or(|m| prompt_tokens >= m);
            let date_ok = tier.valid_from.is_none_or(|d| at.date_naive() >= d);
            if size_ok && date_ok {
                rates = rates.max(tier.rates);
            }
        }
        rates
    }

    /// The estimate reserves twice the output cap when it isn't known whether thinking counts in it.
    pub fn output_cap_factor(&self) -> u32 {
        if self.max_tokens_includes_thinking == "yes" {
            1
        } else {
            2
        }
    }

    pub fn is_stale(&self, today: NaiveDate) -> bool {
        (today - self.checked_at).num_days() > 90
    }
}

fn tier_applies(tier: &Tier, at: DateTime<Utc>, prompt_tokens: u64) -> bool {
    if tier.min_prompt_tokens.is_some_and(|m| prompt_tokens < m) {
        return false;
    }
    if tier.valid_from.is_some_and(|d| at.date_naive() < d) {
        return false;
    }
    if tier.weekdays.as_deref() == Some("mon-fri")
        && matches!(at.weekday(), Weekday::Sat | Weekday::Sun)
    {
        return false;
    }
    if !tier.utc_windows.is_empty() {
        let now = at.time();
        return tier.utc_windows.iter().any(|w| in_window(w, now));
    }
    true
}

fn in_window(window: &str, now: NaiveTime) -> bool {
    let Some((a, b)) = window.split_once('-') else {
        return false;
    };
    let (Ok(a), Ok(b)) = (
        NaiveTime::parse_from_str(a.trim(), "%H:%M"),
        NaiveTime::parse_from_str(b.trim(), "%H:%M"),
    ) else {
        return false;
    };
    if a <= b {
        now >= a && now < b
    } else {
        now >= a || now < b
    }
}

#[derive(Debug, Deserialize)]
struct File {
    schema: u32,
    #[serde(rename = "model")]
    models: Vec<ModelPrice>,
}

/// The built-in table plus the user's overrides (an override replaces the model with the same provider and id).
#[derive(Debug, Clone)]
pub struct PriceTable {
    models: Vec<ModelPrice>,
}

impl PriceTable {
    pub fn built_in() -> Self {
        Self::parse(BUILT_IN).expect("model-prices.toml is valid (unit-tested)")
    }

    pub fn parse(text: &str) -> Result<Self> {
        let file: File = toml::from_str(text)
            .map_err(|e| AiError::Internal(format!("model-prices.toml: {e}")))?;
        if file.schema != 1 {
            return Err(AiError::Internal(format!(
                "model-prices.toml: schema {} desconhecido",
                file.schema
            )));
        }
        Ok(Self {
            models: file.models,
        })
    }

    pub fn with_overrides(mut self, overrides: &[ModelPrice]) -> Self {
        for o in overrides {
            match self
                .models
                .iter_mut()
                .find(|m| m.provider == o.provider && m.id == o.id)
            {
                Some(m) => *m = o.clone(),
                None => self.models.push(o.clone()),
            }
        }
        self
    }

    pub fn models(&self) -> &[ModelPrice] {
        &self.models
    }

    pub fn get(&self, provider: ProviderKind, model: &str) -> Result<&ModelPrice> {
        self.models
            .iter()
            .find(|m| m.provider == provider.id() && m.id == model)
            .ok_or_else(|| AiError::ModelUnpriced(model.to_owned()))
    }

    /// The default model of a provider for a function (`role_default`).
    pub fn default_model(&self, provider: ProviderKind, role: &str) -> Option<&str> {
        self.models
            .iter()
            .find(|m| m.provider == provider.id() && m.role_default.as_deref() == Some(role))
            .map(|m| m.id.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, 0, 0).unwrap()
    }

    #[test]
    fn built_in_table_has_every_default_model_with_source_and_date() {
        let t = PriceTable::built_in();
        for p in ProviderKind::FIXED {
            for role in ["enrich", "judge"] {
                let id = t
                    .default_model(p, role)
                    .unwrap_or_else(|| panic!("{p:?} {role}"));
                let m = t.get(p, id).unwrap();
                assert!(
                    m.source
                        .as_deref()
                        .is_some_and(|s| s.starts_with("https://")),
                    "{id}"
                );
                assert!(m.rates.input > 0.0 && m.rates.output > 0.0, "{id}");
                assert!(!m.effort_levels.is_empty(), "{id}");
            }
        }
        assert_eq!(
            t.default_model(ProviderKind::Anthropic, "enrich"),
            Some("claude-haiku-5-5")
        );
        assert_eq!(
            t.default_model(ProviderKind::Anthropic, "judge"),
            Some("claude-sonnet-5-5")
        );
    }

    #[test]
    fn tiers_by_prompt_size_date_and_time() {
        let t = PriceTable::built_in();
        let haiku = t.get(ProviderKind::Anthropic, "claude-haiku-5-5").unwrap();
        assert_eq!(haiku.rates_at(at(2026, 10, 24, 12), 1_000).input, 0.10);
        assert_eq!(haiku.rates_at(at(2026, 10, 24, 12), 200_000).input, 0.50);

        let flash = t.get(ProviderKind::Gemini, "gemini-3.8-flash").unwrap();
        assert_eq!(flash.rates_at(at(2026, 12, 31, 12), 10).output, 3.75);
        assert_eq!(flash.rates_at(at(2027, 1, 1, 0), 10).output, 7.50);

        let ds = t.get(ProviderKind::Deepseek, "deepseek-flash").unwrap();
        // Friday 02:00 UTC is peak; Friday 12:00 and Saturday 02:00 are off-peak.
        assert_eq!(ds.rates_at(at(2026, 10, 23, 2), 10).input, 0.30);
        assert_eq!(ds.rates_at(at(2026, 10, 23, 12), 10).input, 0.15);
        assert_eq!(ds.rates_at(at(2026, 10, 24, 2), 10).input, 0.15);
        // The estimate always takes the peak price.
        assert_eq!(ds.worst_rates(at(2026, 10, 24, 12), 10).input, 0.30);
        assert_eq!(ds.output_cap_factor(), 2);
        assert_eq!(haiku.output_cap_factor(), 1);
    }

    #[test]
    fn overrides_replace_or_add() {
        let mut m = PriceTable::built_in()
            .get(ProviderKind::Anthropic, "claude-haiku-5-5")
            .unwrap()
            .clone();
        m.rates.output = 9.0;
        let mut new = m.clone();
        new.id = "claude-novo".into();
        let t = PriceTable::built_in().with_overrides(&[m, new]);
        assert_eq!(
            t.get(ProviderKind::Anthropic, "claude-haiku-5-5")
                .unwrap()
                .rates
                .output,
            9.0
        );
        assert!(t.get(ProviderKind::Anthropic, "claude-novo").is_ok());
        assert_eq!(
            t.get(ProviderKind::Anthropic, "nao-existe")
                .unwrap_err()
                .code(),
            "ai_model_unpriced"
        );
    }
}
