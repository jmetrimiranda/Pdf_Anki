//! Typed key/value settings (section 14). Only known keys are accepted; each has a default and a
//! value shape that is validated on write. Secrets (sync key, AI key, Painel token) never live
//! here: they go to the system keychain.

use rusqlite::{OptionalExtension, params};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::{Result, Store, StoreError};

/// Setting keys. Add new settings here and in [`SPECS`].
pub mod keys {
    pub const VOCAB_ROOT_DECK_ID: &str = "vocab_root_deck_id";
    pub const VOCAB_KNOWN_IVL_DAYS: &str = "vocab_known_ivl_days";
    pub const VOCAB_COUNT_YOUNG: &str = "vocab_count_young";
    pub const VOCAB_SUSPENDED_POLICY: &str = "vocab_suspended_policy";
    pub const VOCAB_FUNCTION_WORDS_KNOWN: &str = "vocab_function_words_known";
    pub const ANKI_SYNC_URL: &str = "anki_sync_url";
    pub const ANKI_SYNC_USER: &str = "anki_sync_user";
    pub const RUNNER_URL: &str = "runner_url";
    pub const AI_PROVIDER: &str = "ai_provider";
    pub const AI_BASE_URL: &str = "ai_base_url";
    pub const AI_MODEL_FAST: &str = "ai_model_fast";
    pub const AI_MODEL_STRONG: &str = "ai_model_strong";
    pub const AI_MONTHLY_LIMIT_USD: &str = "ai_monthly_limit_usd";
    pub const PAINEL_URL: &str = "painel_url";
    pub const PAINEL_INTEGRATION_ENABLED: &str = "painel_integration_enabled";
}

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Int { min: i64 },
    Number { min: f64 },
    Text,
    Choice(&'static [&'static str]),
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

use keys::*;

const SPECS: &[Spec] = &[
    spec(VOCAB_ROOT_DECK_ID, Kind::Int { min: i64::MIN }, true, null),
    spec(VOCAB_KNOWN_IVL_DAYS, Kind::Int { min: 1 }, false, || {
        21.into()
    }),
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
    spec(ANKI_SYNC_URL, Kind::Text, true, null),
    spec(ANKI_SYNC_USER, Kind::Text, true, null),
    spec(RUNNER_URL, Kind::Text, true, null),
    spec(
        AI_PROVIDER,
        Kind::Choice(&["anthropic", "openai_compatible"]),
        true,
        null,
    ),
    spec(AI_BASE_URL, Kind::Text, true, null),
    spec(AI_MODEL_FAST, Kind::Text, false, || {
        "claude-haiku-5-5".into()
    }),
    spec(AI_MODEL_STRONG, Kind::Text, false, || {
        "claude-sonnet-5-5".into()
    }),
    spec(AI_MONTHLY_LIMIT_USD, Kind::Number { min: 0.0 }, true, null),
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
        Kind::Int { min } => match value.as_i64() {
            Some(n) if n >= min => Ok(()),
            Some(_) => Err(invalid(format!("o mínimo é {min}."))),
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
