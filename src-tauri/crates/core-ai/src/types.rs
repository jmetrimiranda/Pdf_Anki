//! The provider-neutral request/response types every adapter speaks.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The fixed providers (plan 2.1); the user-defined OpenAI-compatible URL comes later as `Custom`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Anthropic,
    Openai,
    Gemini,
    Deepseek,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 4] =
        [Self::Anthropic, Self::Openai, Self::Gemini, Self::Deepseek];

    pub fn id(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Gemini => "gemini",
            Self::Deepseek => "deepseek",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.id() == s)
    }

    /// The name shown in the UI.
    pub fn label(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude (Anthropic)",
            Self::Openai => "GPT (OpenAI)",
            Self::Gemini => "Gemini (Google)",
            Self::Deepseek => "DeepSeek",
        }
    }

    /// The keychain account of this provider's API key (plan 4).
    pub fn keychain_account(self) -> String {
        format!("ai:{}", self.id())
    }
}

/// The app's effort levels (plan 2.7); each adapter maps them to its provider's parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    /// Thinking off where the model allows it, otherwise its lowest setting.
    #[default]
    Minimum,
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "minimum" => Some(Self::Minimum),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

/// The two configurable functions (plan 2.6). "Definir palavra" and "Cards de um trecho" use `Enrich`'s settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Function {
    Enrich,
    Judge,
}

/// What each call is for: recorded in `ai_usage.feature`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    Enrich,
    Define,
    Cards,
    Judge,
}

impl Feature {
    pub fn function(self) -> Function {
        match self {
            Self::Judge => Function::Judge,
            Self::Enrich | Self::Define | Self::Cards => Function::Enrich,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Enrich => "enrich",
            Self::Define => "define",
            Self::Cards => "cards",
            Self::Judge => "judge",
        }
    }
}

/// An API key. Never printed: `Debug`/`Display` show `***`; only [`ApiKey::suffix`] leaves the core (plan 4).
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// Trims whitespace; an empty key is `None`.
    pub fn new(raw: &str) -> Option<Self> {
        let key = raw.trim();
        (!key.is_empty()).then(|| Self(key.to_owned()))
    }

    /// The raw key, for the HTTP header only.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    /// The last 4 characters shown in the UI ("•••• ABCD").
    pub fn suffix(&self) -> String {
        let chars: Vec<char> = self.0.chars().collect();
        chars[chars.len().saturating_sub(4)..].iter().collect()
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(***)")
    }
}

impl fmt::Display for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

/// One structured-output call.
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub system: String,
    pub user: String,
    /// JSON Schema of the answer (no min/max keywords; `additionalProperties: false`).
    pub schema: serde_json::Value,
    pub schema_name: &'static str,
    pub max_output_tokens: u32,
    pub effort: Effort,
}

/// Token counts as the provider returned them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Input tokens billed at the normal input price (not read from cache, not written to it).
    pub input: u64,
    pub cached_input: u64,
    pub cache_write: u64,
    /// Every billed output token, thinking included.
    pub output: u64,
    /// The thinking part of `output` (informational).
    pub thinking: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stop {
    Done,
    /// Cut at the output-token cap.
    Length,
    Refused,
    Other,
}

#[derive(Debug, Clone)]
pub struct Completion {
    /// The JSON text of the answer (validated by the caller).
    pub text: String,
    /// `None` when the provider sent no usage: the call is recorded at its worst case, flagged "estimated".
    pub usage: Option<Usage>,
    pub stop: Stop,
}
