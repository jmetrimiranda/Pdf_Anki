//! Optional AI for the Leitor (spec 13, plan `docs/planos/fase-8.md`). Off by default; every call leaves from Rust
//! (never the webview), needs the provider's key from the system keychain, is checked against the daily and monthly
//! spending caps before it goes out, and is billed from the usage the API returns × `model-prices.toml`.
//!
//! Pure Rust with no desktop APIs (keeps the iOS door open).

pub mod anthropic;
pub mod cost;
pub mod engine;
pub mod error;
mod http;
pub mod limits;
pub mod openai_chat;
pub mod prices;
pub mod prompts;
pub mod provider;
pub mod simulated;
pub mod types;

pub use engine::{CallSpec, Engine, Ledger, UsageRecord};
pub use error::{AiError, Result};
pub use limits::{Budget, BudgetState, Caps, Origin, Spent};
pub use prices::{ModelPrice, PriceTable, Rates};
pub use provider::Provider;
pub use types::{
    ApiKey, Completion, CompletionRequest, Effort, Feature, Function, ProviderKind, Stop, Usage,
};

/// The real adapter of a provider (Gemini follows in its own commit, plan 6.5).
pub fn provider_for(kind: ProviderKind) -> Option<Box<dyn Provider>> {
    match kind {
        ProviderKind::Anthropic => Some(Box::new(anthropic::AnthropicProvider::default())),
        ProviderKind::Openai => Some(Box::new(openai_chat::OpenAiChatProvider::openai())),
        ProviderKind::Deepseek => Some(Box::new(openai_chat::OpenAiChatProvider::deepseek())),
        ProviderKind::Gemini => None,
    }
}
