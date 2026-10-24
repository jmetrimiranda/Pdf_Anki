//! Optional AI for the Leitor (spec 13, plan `docs/planos/fase-8.md`). Off by default; every call leaves from Rust
//! (never the webview), needs the provider's key from the system keychain, is checked against the daily and monthly
//! spending caps before it goes out, and is billed from the usage the API returns × `model-prices.toml`.
//!
//! Pure Rust with no desktop APIs (keeps the iOS door open).

pub mod anthropic;
pub mod cost;
pub mod engine;
pub mod error;
pub mod gemini;
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

/// The real adapter of each provider (plan 2.1).
pub fn provider_for(kind: ProviderKind) -> Option<Box<dyn Provider>> {
    match kind {
        ProviderKind::Anthropic => Some(Box::new(anthropic::AnthropicProvider::default())),
        ProviderKind::Openai => Some(Box::new(openai_chat::OpenAiChatProvider::openai())),
        ProviderKind::Deepseek => Some(Box::new(openai_chat::OpenAiChatProvider::deepseek())),
        ProviderKind::Gemini => Some(Box::new(gemini::GeminiProvider::default())),
        // Built from its URL by the app (`openai_chat::OpenAiChatProvider::compatible`).
        ProviderKind::Custom => None,
    }
}

/// A URL on this computer (`localhost` or a loopback address such as `127.0.0.1` and `::1`): a custom server there
/// costs nothing and is outside the spending caps (plan 0.3).
pub fn is_local_url(url: &str) -> bool {
    url::Url::parse(url.trim()).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && match u.host() {
                Some(url::Host::Domain(d)) => d == "localhost",
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            }
    })
}

/// The custom provider's URL as stored: `http(s)://host[:port][/path]`, no credentials, query or fragment, no
/// trailing `/`. Plain `http` only on this computer: a remote server gets the key, so it must be `https`.
pub fn check_base_url(url: &str) -> std::result::Result<String, &'static str> {
    let invalid =
        "Endereço inválido: use algo como http://localhost:11434/v1 ou https://servidor/v1.";
    let text = url.trim().trim_end_matches('/');
    if text.is_empty()
        || text.len() > 300
        || text.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(invalid);
    }
    let u = url::Url::parse(text).map_err(|_| invalid)?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(invalid);
    }
    if u.scheme() == "http" && !is_local_url(text) {
        return Err("Um servidor remoto precisa de https (a chave vai junto em cada chamada).");
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_urls() {
        for u in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:8080",
            "https://LOCALHOST/v1",
        ] {
            assert!(is_local_url(u), "{u}");
        }
        for u in [
            "https://openrouter.ai/api/v1",
            "http://localhost.evil.com/v1",
            "http://10.0.0.2/v1",
            "ftp://localhost",
            "localhost:11434",
        ] {
            assert!(!is_local_url(u), "{u}");
        }
    }

    #[test]
    fn base_urls() {
        assert_eq!(
            check_base_url(" http://localhost:11434/v1/ ").unwrap(),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            check_base_url("https://openrouter.ai/api/v1").unwrap(),
            "https://openrouter.ai/api/v1"
        );
        for bad in [
            "",
            "localhost:11434",
            "http://openrouter.ai/api/v1",
            "https://user:pw@host/v1",
            "https://host/v1?x=1",
            "https://host/v1#a",
            "file:///etc/passwd",
            "https://host/ v1",
        ] {
            assert!(check_base_url(bad).is_err(), "{bad}");
        }
    }
}
