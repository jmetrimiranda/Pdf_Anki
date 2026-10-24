//! Typed key/value settings (section 14). Only known keys are accepted; each has a default and a
//! value shape that is validated on write. Secrets (sync key, AI key, Painel token) never live
//! here: they go to the system keychain.

use rusqlite::{OptionalExtension, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{Result, Store, StoreError};

/// Setting keys. Add new settings here and in [`SPECS`].
pub mod keys {
    pub const VOCAB_ROOT_DECK_ID: &str = "vocab_root_deck_id";
    pub const VOCAB_KNOWN_IVL_DAYS: &str = "vocab_known_ivl_days";
    pub const VOCAB_COUNT_YOUNG: &str = "vocab_count_young";
    pub const VOCAB_SUSPENDED_POLICY: &str = "vocab_suspended_policy";
    pub const VOCAB_FUNCTION_WORDS_KNOWN: &str = "vocab_function_words_known";
    /// Derivatives of known words (spec 12.3 I): `card` (default, they become cards) or `known`.
    pub const VOCAB_DERIVED_POLICY: &str = "vocab_derived_policy";
    /// Subdecks of the vocabulary folder left out of the scan (JSON array of deck ids).
    pub const VOCAB_EXCLUDED_DECK_IDS: &str = "vocab_excluded_deck_ids";
    pub const ANKI_SYNC_URL: &str = "anki_sync_url";
    pub const ANKI_SYNC_USER: &str = "anki_sync_user";
    /// Extra root certificate (PEM, public data) trusted for the sync server, e.g. a dev CA.
    pub const ANKI_SYNC_CA_CERT: &str = "anki_sync_ca_cert";
    /// Epoch ms of the last successful sync.
    pub const ANKI_SYNC_LAST_AT: &str = "anki_sync_last_at";
    /// The account (`user@endpoint`) whose first sync (always a download) completed.
    pub const ANKI_SYNC_FIRST_DONE: &str = "anki_sync_first_done";
    pub const RUNNER_URL: &str = "runner_url";
    /// Code review (spec 11.2): suggest "Fácil" when the answer is correct in under
    /// [`CODE_SUGGEST_EASY_SECS`] seconds. Off by default.
    pub const CODE_SUGGEST_EASY: &str = "code_suggest_easy";
    /// Threshold in seconds for [`CODE_SUGGEST_EASY`] (1..=600, default 10).
    pub const CODE_SUGGEST_EASY_SECS: &str = "code_suggest_easy_secs";
    /// Program cards in mode `saida`: compare the output exactly (default: ignore trailing whitespace).
    pub const CODE_OUTPUT_EXACT: &str = "code_output_exact";
    /// Where C++ runs (spec 11.5): `auto` (local compiler, else the runner), `local` or `remote`.
    pub const CODE_CPP_BACKEND: &str = "code_cpp_backend";
    /// AI (plan `docs/planos/fase-8.md` 6.1): provider, model and effort per function. No provider = AI off.
    /// "Definir palavra" and "Cards a partir de um trecho" use the enrichment ones.
    pub const AI_ENRICH_PROVIDER: &str = "ai_enrich_provider";
    /// `None` = the provider's default model for the function (`model-prices.toml`).
    pub const AI_ENRICH_MODEL: &str = "ai_enrich_model";
    pub const AI_ENRICH_EFFORT: &str = "ai_enrich_effort";
    /// Output tokens per enrichment call (≤ 4000; batches of up to 40 words).
    pub const AI_ENRICH_MAX_TOKENS: &str = "ai_enrich_max_tokens";
    pub const AI_JUDGE_PROVIDER: &str = "ai_judge_provider";
    pub const AI_JUDGE_MODEL: &str = "ai_judge_model";
    pub const AI_JUDGE_EFFORT: &str = "ai_judge_effort";
    /// Output tokens per judge call (≤ 2000).
    pub const AI_JUDGE_MAX_TOKENS: &str = "ai_judge_max_tokens";
    /// Spending caps over every provider, in US$ (local calendar day and month).
    pub const AI_LIMIT_DAY_USD: &str = "ai_limit_day_usd";
    pub const AI_LIMIT_MONTH_USD: &str = "ai_limit_month_usd";
    /// A foreground call whose worst case is above this asks first; the background queue pauses instead.
    pub const AI_CONFIRM_ABOVE_USD: &str = "ai_confirm_above_usd";
    /// The user's price edits: `{"<provider>/<model>": {"input", "cachedInput"?, "cacheWrite"?, "output"}}`.
    pub const AI_PRICE_OVERRIDES: &str = "ai_price_overrides";
    /// Enrich new vocabulary notes in the background (only words added while it is on).
    pub const AI_BACKGROUND_ENRICH: &str = "ai_background_enrich";
    pub const AI_BACKGROUND_PAUSED: &str = "ai_background_paused";
    /// Providers the user agreed to send data to: `{"<provider>": <epoch ms>}`.
    pub const AI_CONSENT: &str = "ai_consent";
    /// Library sync (spec 16): the server, the library user and this device's name. The token is in the keychain.
    pub const LIBRARY_SYNC_URL: &str = "library_sync_url";
    pub const LIBRARY_SYNC_USER: &str = "library_sync_user";
    pub const LIBRARY_SYNC_DEVICE: &str = "library_sync_device";
    /// Epoch ms of the last complete library sync.
    pub const LIBRARY_SYNC_LAST_AT: &str = "library_sync_last_at";
    pub const PAINEL_URL: &str = "painel_url";
    pub const PAINEL_INTEGRATION_ENABLED: &str = "painel_integration_enabled";
}

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Int {
        min: i64,
        max: i64,
    },
    Number {
        min: f64,
    },
    Text,
    Choice(&'static [&'static str]),
    /// JSON array of integers.
    IntList,
    /// JSON object (its members are checked by the code that reads it).
    Object,
}

struct Spec {
    key: &'static str,
    kind: Kind,
    nullable: bool,
    default: fn() -> Value,
}

const fn spec(key: &'static str, kind: Kind, nullable: bool, default: fn() -> Value) -> Spec {
    Spec {
        key,
        kind,
        nullable,
        default,
    }
}

fn null() -> Value {
    Value::Null
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// AI providers with an adapter (`core-ai`).
const AI_PROVIDERS: &[&str] = &["anthropic", "openai", "gemini", "deepseek"];
/// `core_ai::Effort`.
const AI_EFFORTS: &[&str] = &["minimum", "low", "medium", "high"];

use keys::*;

const SPECS: &[Spec] = &[
    spec(
        VOCAB_ROOT_DECK_ID,
        Kind::Int {
            min: i64::MIN,
            max: i64::MAX,
        },
        true,
        null,
    ),
    spec(
        VOCAB_KNOWN_IVL_DAYS,
        Kind::Int {
            min: 1,
            max: i64::MAX,
        },
        false,
        || 21.into(),
    ),
    spec(VOCAB_COUNT_YOUNG, Kind::Bool, false, || false.into()),
    spec(
        VOCAB_SUSPENDED_POLICY,
        Kind::Choice(&["ignore", "known"]),
        false,
        || "ignore".into(),
    ),
    spec(VOCAB_FUNCTION_WORDS_KNOWN, Kind::Bool, false, || {
        true.into()
    }),
    spec(
        VOCAB_DERIVED_POLICY,
        Kind::Choice(&["card", "known"]),
        false,
        || "card".into(),
    ),
    spec(VOCAB_EXCLUDED_DECK_IDS, Kind::IntList, false, || {
        Value::Array(Vec::new())
    }),
    spec(ANKI_SYNC_URL, Kind::Text, true, null),
    spec(ANKI_SYNC_USER, Kind::Text, true, null),
    spec(ANKI_SYNC_CA_CERT, Kind::Text, true, null),
    spec(
        ANKI_SYNC_LAST_AT,
        Kind::Int {
            min: 0,
            max: i64::MAX,
        },
        true,
        null,
    ),
    spec(ANKI_SYNC_FIRST_DONE, Kind::Text, true, null),
    spec(RUNNER_URL, Kind::Text, true, null),
    spec(CODE_SUGGEST_EASY, Kind::Bool, false, || false.into()),
    spec(
        CODE_SUGGEST_EASY_SECS,
        Kind::Int { min: 1, max: 600 },
        false,
        || 10.into(),
    ),
    spec(CODE_OUTPUT_EXACT, Kind::Bool, false, || false.into()),
    spec(
        CODE_CPP_BACKEND,
        Kind::Choice(&["auto", "local", "remote"]),
        false,
        || "auto".into(),
    ),
    spec(AI_ENRICH_PROVIDER, Kind::Choice(AI_PROVIDERS), true, null),
    spec(AI_ENRICH_MODEL, Kind::Text, true, null),
    spec(AI_ENRICH_EFFORT, Kind::Choice(AI_EFFORTS), false, || {
        "minimum".into()
    }),
    spec(
        AI_ENRICH_MAX_TOKENS,
        Kind::Int {
            min: 500,
            max: 4000,
        },
        false,
        || 4000.into(),
    ),
    spec(AI_JUDGE_PROVIDER, Kind::Choice(AI_PROVIDERS), true, null),
    spec(AI_JUDGE_MODEL, Kind::Text, true, null),
    spec(AI_JUDGE_EFFORT, Kind::Choice(AI_EFFORTS), false, || {
        "low".into()
    }),
    spec(
        AI_JUDGE_MAX_TOKENS,
        Kind::Int {
            min: 500,
            max: 2000,
        },
        false,
        || 2000.into(),
    ),
    spec(AI_LIMIT_DAY_USD, Kind::Number { min: 0.0 }, false, || {
        1.0.into()
    }),
    spec(AI_LIMIT_MONTH_USD, Kind::Number { min: 0.0 }, false, || {
        5.0.into()
    }),
    spec(
        AI_CONFIRM_ABOVE_USD,
        Kind::Number { min: 0.0 },
        false,
        || 0.05.into(),
    ),
    spec(AI_PRICE_OVERRIDES, Kind::Object, false, empty_object),
    spec(AI_BACKGROUND_ENRICH, Kind::Bool, false, || false.into()),
    spec(AI_BACKGROUND_PAUSED, Kind::Bool, false, || false.into()),
    spec(AI_CONSENT, Kind::Object, false, empty_object),
    spec(LIBRARY_SYNC_URL, Kind::Text, true, null),
    spec(LIBRARY_SYNC_USER, Kind::Text, true, null),
    spec(LIBRARY_SYNC_DEVICE, Kind::Text, true, null),
    spec(
        LIBRARY_SYNC_LAST_AT,
        Kind::Int {
            min: 0,
            max: i64::MAX,
        },
        true,
        null,
    ),
    spec(PAINEL_URL, Kind::Text, true, null),
    spec(PAINEL_INTEGRATION_ENABLED, Kind::Bool, false, || {
        false.into()
    }),
];

fn find_spec(key: &str) -> Result<&'static Spec> {
    SPECS
        .iter()
        .find(|s| s.key == key)
        .ok_or_else(|| StoreError::UnknownSetting(key.to_owned()))
}

fn validate(spec: &Spec, value: &Value) -> Result<()> {
    let invalid = |reason: String| StoreError::InvalidSetting {
        key: spec.key.to_owned(),
        reason,
    };
    if value.is_null() {
        return if spec.nullable {
            Ok(())
        } else {
            Err(invalid("o valor não pode ser vazio.".into()))
        };
    }
    match spec.kind {
        Kind::Bool if value.is_boolean() => Ok(()),
        Kind::Bool => Err(invalid("esperado verdadeiro ou falso.".into())),
        Kind::Int { min, max } => match value.as_i64() {
            Some(n) if n >= min && n <= max => Ok(()),
            Some(n) if n < min => Err(invalid(format!("o mínimo é {min}."))),
            Some(_) => Err(invalid(format!("o máximo é {max}."))),
            None => Err(invalid("esperado um número inteiro.".into())),
        },
        Kind::Number { min } => match value.as_f64() {
            Some(n) if n.is_finite() && n >= min => Ok(()),
            Some(_) => Err(invalid(format!("o mínimo é {min}."))),
            None => Err(invalid("esperado um número.".into())),
        },
        Kind::Text if value.is_string() => Ok(()),
        Kind::Text => Err(invalid("esperado um texto.".into())),
        Kind::Choice(options) => match value.as_str() {
            Some(s) if options.contains(&s) => Ok(()),
            _ => Err(invalid(format!("valores aceitos: {}.", options.join(", ")))),
        },
        Kind::IntList => match value.as_array() {
            Some(items) if items.iter().all(|v| v.as_i64().is_some()) => Ok(()),
            _ => Err(invalid("esperada uma lista de números inteiros.".into())),
        },
        Kind::Object if value.is_object() => Ok(()),
        Kind::Object => Err(invalid("esperado um objeto.".into())),
    }
}

impl Store {
    /// The stored value of `key`, or its default. Stored values that no longer validate (e.g.
    /// written by a newer version) fall back to the default.
    pub fn setting(&self, key: &str) -> Result<Value> {
        let spec = find_spec(key)?;
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        let value = stored
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(|v| validate(spec, v).is_ok());
        Ok(value.unwrap_or_else(spec.default))
    }

    /// [`Store::setting`] deserialized into `T`.
    pub fn setting_as<T: DeserializeOwned>(&self, key: &str) -> Result<T> {
        serde_json::from_value(self.setting(key)?).map_err(|e| StoreError::InvalidSetting {
            key: key.to_owned(),
            reason: e.to_string(),
        })
    }

    /// Validates and stores `value` for `key`.
    pub fn set_setting(&self, key: &str, value: Value) -> Result<()> {
        validate(find_spec(key)?, &value)?;
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    /// Removes the stored value so `key` reads as its default again.
    pub fn reset_setting(&self, key: &str) -> Result<()> {
        find_spec(key)?;
        self.conn
            .execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Every known setting with its effective value (stored or default).
    pub fn all_settings(&self) -> Result<Map<String, Value>> {
        SPECS
            .iter()
            .map(|s| Ok((s.key.to_owned(), self.setting(s.key)?)))
            .collect()
    }
}

/// What to do with suspended notes of the vocabulary folder (spec 12.1 step 4).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VocabSuspendedPolicy {
    /// Suspended notes don't count (default).
    #[default]
    Ignore,
    /// Suspended notes count as known.
    Known,
}

/// Derivatives of known words (spec 12.3 I).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VocabDerivedPolicy {
    /// They become cards, with the family shown (default).
    #[default]
    Card,
    /// They count as known.
    Known,
}

/// The vocabulary settings (spec 12.1), with their defaults.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabSettings {
    pub root_deck_id: Option<i64>,
    /// "Known" = mature: interval of at least this many days (default 21).
    pub known_ivl_days: u32,
    /// Count young cards as known (default off).
    pub count_young: bool,
    pub suspended_policy: VocabSuspendedPolicy,
    /// Function words ("the", "of") count as known (default on).
    pub function_words_known: bool,
    pub derived_policy: VocabDerivedPolicy,
    pub excluded_deck_ids: Vec<i64>,
}

impl Default for VocabSettings {
    fn default() -> Self {
        Self {
            root_deck_id: None,
            known_ivl_days: 21,
            count_young: false,
            suspended_policy: VocabSuspendedPolicy::Ignore,
            function_words_known: true,
            derived_policy: VocabDerivedPolicy::Card,
            excluded_deck_ids: Vec::new(),
        }
    }
}

impl Store {
    /// The vocabulary settings (stored values or defaults).
    pub fn vocab_settings(&self) -> Result<VocabSettings> {
        let ivl: i64 = self.setting_as(VOCAB_KNOWN_IVL_DAYS)?;
        Ok(VocabSettings {
            root_deck_id: self.setting_as(VOCAB_ROOT_DECK_ID)?,
            known_ivl_days: u32::try_from(ivl).unwrap_or(u32::MAX),
            count_young: self.setting_as(VOCAB_COUNT_YOUNG)?,
            suspended_policy: self.setting_as(VOCAB_SUSPENDED_POLICY)?,
            function_words_known: self.setting_as(VOCAB_FUNCTION_WORDS_KNOWN)?,
            derived_policy: self.setting_as(VOCAB_DERIVED_POLICY)?,
            excluded_deck_ids: self.setting_as(VOCAB_EXCLUDED_DECK_IDS)?,
        })
    }

    /// Validates and stores every vocabulary setting (all or nothing).
    pub fn set_vocab_settings(&mut self, v: &VocabSettings) -> Result<()> {
        let entries: [(&str, Value); 7] = [
            (VOCAB_ROOT_DECK_ID, to_json(&v.root_deck_id)?),
            (VOCAB_KNOWN_IVL_DAYS, Value::from(v.known_ivl_days)),
            (VOCAB_COUNT_YOUNG, Value::from(v.count_young)),
            (VOCAB_SUSPENDED_POLICY, to_json(&v.suspended_policy)?),
            (
                VOCAB_FUNCTION_WORDS_KNOWN,
                Value::from(v.function_words_known),
            ),
            (VOCAB_DERIVED_POLICY, to_json(&v.derived_policy)?),
            (VOCAB_EXCLUDED_DECK_IDS, to_json(&v.excluded_deck_ids)?),
        ];
        for (key, value) in &entries {
            validate(find_spec(key)?, value)?;
        }
        let tx = self.conn.transaction()?;
        for (key, value) in entries {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

fn to_json<T: Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| StoreError::InvalidInput(e.to_string()))
}
