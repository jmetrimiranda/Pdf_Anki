//! The HTTP client every adapter shares, and the mapping of transport and status errors to [`AiError`].
//! Response bodies of failed calls are never logged or shown: only a code derived from them.

use std::time::Duration;

use crate::error::AiError;

/// Spec 13: 60 s per call. No automatic HTTP retries (a retry is a second billed call, decided by the caller).
pub const TIMEOUT: Duration = Duration::from_secs(60);

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub fn transport_error(e: &reqwest::Error) -> AiError {
    if e.is_timeout() {
        AiError::Timeout
    } else {
        AiError::Offline
    }
}

/// A failed HTTP status. `error_type` is the provider's machine-readable error type, when it sent one.
pub fn status_error(
    provider: &'static str,
    status: u16,
    error_type: Option<&str>,
    retry_after_secs: Option<u64>,
    model: &str,
) -> AiError {
    let kind = error_type.unwrap_or_default();
    if kind.contains("spend") || kind.contains("billing") || kind.contains("quota") {
        return AiError::ProviderSpendLimit(provider);
    }
    match status {
        401 | 403 => AiError::Auth(provider),
        404 => AiError::ModelNotFound(model.to_owned()),
        429 => AiError::RateLimited { retry_after_secs },
        500..=599 => AiError::Server(status),
        _ => AiError::BadRequest(status),
    }
}

pub fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_become_codes() {
        assert_eq!(status_error("x", 401, None, None, "m").code(), "ai_auth");
        assert_eq!(
            status_error("x", 404, None, None, "m").code(),
            "ai_model_not_found"
        );
        assert_eq!(
            status_error("x", 429, None, Some(7), "m"),
            AiError::RateLimited {
                retry_after_secs: Some(7)
            }
        );
        assert_eq!(status_error("x", 529, None, None, "m").code(), "ai_server");
        assert_eq!(
            status_error("x", 400, None, None, "m").code(),
            "ai_bad_request"
        );
        assert_eq!(
            status_error("x", 400, Some("billing_error"), None, "m").code(),
            "ai_provider_spend_limit"
        );
    }
}
