//! Gemini through Google's native Interactions API (plan 2.4; read in the API reference and the structured-output
//! guide on 24/10/2026):
//!
//! - `POST /v1beta/interactions` with the key in the `x-goog-api-key` header (never `?key=` in the URL, so it can't
//!   end up in a URL log);
//! - `system_instruction` is a string, `input` the user text;
//! - `generation_config: {thinking_level, max_output_tokens}` — 3.x models can't turn thinking off: "mínimo" is the
//!   model's lowest level (`minimal` on 3.5 Flash-Lite, `low` on 3.8 Flash);
//! - structured output: top-level `response_format: {type: "text", mime_type: "application/json", schema}`;
//! - `store: false` (the API keeps interactions by default);
//! - the answer is in `steps[]` of type `model_output`, as `content[]` items of type `text`; `status: "incomplete"`
//!   means it was cut at `max_output_tokens`;
//! - usage: `total_input_tokens`, `total_cached_tokens` (part of the input), `total_output_tokens` and, apart from it,
//!   `total_thought_tokens` (the reference's example adds them up to `total_tokens`): both are billed as output.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{AiError, Result};
use crate::http;
use crate::prices::ModelPrice;
use crate::provider::{BoxFuture, Provider};
use crate::types::{ApiKey, Completion, CompletionRequest, Effort, ProviderKind, Stop, Usage};

pub const BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const NAME: &str = "Gemini";

pub struct GeminiProvider {
    client: reqwest::Client,
    base: String,
}

impl Default for GeminiProvider {
    fn default() -> Self {
        Self::with_base_url(BASE_URL)
    }
}

impl GeminiProvider {
    /// `base` ends where `/interactions` and `/models` start (tests: a local server).
    pub fn with_base_url(base: &str) -> Self {
        Self {
            client: http::client(),
            base: base.trim_end_matches('/').to_owned(),
        }
    }
}

/// The thinking level sent for an app effort, among the model's (`minimal` only where it exists).
fn thinking_level(effort: Effort, levels: &[String]) -> Option<&'static str> {
    let has = |l: &str| levels.iter().any(|x| x == l);
    let wanted: &[&'static str] = match effort {
        Effort::Minimum => &["minimal", "low"],
        Effort::Low => &["low", "minimal"],
        Effort::Medium => &["medium", "high", "low"],
        Effort::High => &["high", "medium"],
    };
    wanted.iter().copied().find(|l| has(l))
}

/// The request body (pure, unit-tested).
pub fn request_body(req: &CompletionRequest, price: &ModelPrice) -> Value {
    let mut generation = json!({ "max_output_tokens": req.max_output_tokens });
    if price.effort_param == "gemini"
        && let Some(l) = thinking_level(req.effort, &price.effort_levels)
    {
        generation["thinking_level"] = json!(l);
    }
    json!({
        "model": req.model,
        "system_instruction": req.system,
        "input": req.user,
        "generation_config": generation,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": req.schema },
        "store": false,
    })
}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    steps: Vec<Step>,
    #[serde(default)]
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct Step {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    content: Vec<Part>,
}

#[derive(Deserialize)]
struct Part {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct RawUsage {
    #[serde(default)]
    total_input_tokens: u64,
    #[serde(default)]
    total_cached_tokens: u64,
    #[serde(default)]
    total_output_tokens: u64,
    #[serde(default)]
    total_thought_tokens: u64,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Deserialize)]
struct ErrorDetail {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    details: Vec<Value>,
}

/// Parses a 200 response.
pub fn parse_response(body: &str) -> Result<Completion> {
    let r: Response = serde_json::from_str(body).map_err(|_| AiError::InvalidOutput)?;
    let text = r
        .steps
        .iter()
        .filter(|s| s.kind == "model_output")
        .flat_map(|s| s.content.iter())
        .filter(|p| p.kind == "text")
        .filter_map(|p| p.text.as_deref())
        .collect::<String>();
    let stop = match r.status.as_deref() {
        Some("completed") => Stop::Done,
        Some("incomplete") => Stop::Length,
        _ => Stop::Other,
    };
    let usage = r.usage.map(|u| {
        let cached = u.total_cached_tokens.min(u.total_input_tokens);
        Usage {
            input: u.total_input_tokens - cached,
            cached_input: cached,
            cache_write: 0,
            output: u.total_output_tokens + u.total_thought_tokens,
            thinking: u.total_thought_tokens,
        }
    });
    Ok(Completion { text, usage, stop })
}

async fn error_from(resp: reqwest::Response, model: &str) -> AiError {
    let status = resp.status().as_u16();
    let retry = http::retry_after(resp.headers());
    let detail = resp
        .text()
        .await
        .ok()
        .and_then(|b| serde_json::from_str::<ErrorBody>(&b).ok())
        .map(|e| e.error);
    // Google answers a bad key with 400 INVALID_ARGUMENT and the reason API_KEY_INVALID in the details.
    let reason_is = |r: &str| {
        detail.as_ref().is_some_and(|d| {
            d.details
                .iter()
                .any(|x| x.get("reason").and_then(Value::as_str) == Some(r))
        })
    };
    if reason_is("API_KEY_INVALID") {
        return AiError::Auth(NAME);
    }
    let kind = detail.and_then(|d| d.status);
    match kind.as_deref() {
        Some("PERMISSION_DENIED" | "UNAUTHENTICATED") => AiError::Auth(NAME),
        Some("NOT_FOUND") => AiError::ModelNotFound(model.to_owned()),
        Some("RESOURCE_EXHAUSTED") => AiError::RateLimited {
            retry_after_secs: retry,
        },
        _ => http::status_error(NAME, status, kind.as_deref(), retry, model),
    }
}

impl Provider for GeminiProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Gemini
    }

    fn complete<'a>(
        &'a self,
        key: &'a ApiKey,
        req: &'a CompletionRequest,
        price: &'a ModelPrice,
    ) -> BoxFuture<'a, Completion> {
        Box::pin(async move {
            let resp = self
                .client
                .post(format!("{}/interactions", self.base))
                .header("x-goog-api-key", key.expose())
                .json(&request_body(req, price))
                .send()
                .await
                .map_err(|e| http::transport_error(&e))?;
            if !resp.status().is_success() {
                return Err(error_from(resp, &req.model).await);
            }
            let body = resp.text().await.map_err(|e| http::transport_error(&e))?;
            parse_response(&body)
        })
    }

    /// `GET /models/{model}`: no tokens.
    fn test_key<'a>(&'a self, key: &'a ApiKey, model: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let resp = self
                .client
                .get(format!("{}/models/{model}", self.base))
                .header("x-goog-api-key", key.expose())
                .send()
                .await
                .map_err(|e| http::transport_error(&e))?;
            if resp.status().is_success() {
                Ok(())
            } else {
                Err(error_from(resp, model).await)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prices::PriceTable;

    fn req(model: &str, effort: Effort) -> CompletionRequest {
        CompletionRequest {
            model: model.into(),
            system: "sys".into(),
            user: "user".into(),
            schema: json!({"type": "object"}),
            schema_name: "juiz",
            max_output_tokens: 4000,
            effort,
        }
    }

    #[test]
    fn levels_format_and_no_key_in_the_body() {
        let t = PriceTable::built_in();
        let lite = t
            .get(ProviderKind::Gemini, "gemini-3.5-flash-lite")
            .unwrap();
        let flash = t.get(ProviderKind::Gemini, "gemini-3.8-flash").unwrap();
        let b = request_body(&req("gemini-3.5-flash-lite", Effort::Minimum), lite);
        assert_eq!(b["generation_config"]["thinking_level"], "minimal");
        assert_eq!(b["generation_config"]["max_output_tokens"], 4000);
        assert_eq!(b["response_format"]["mime_type"], "application/json");
        assert_eq!(b["response_format"]["type"], "text");
        assert_eq!(
            (b["store"].as_bool(), b["system_instruction"].as_str()),
            (Some(false), Some("sys"))
        );
        // 3.8 Flash has no "minimal".
        let b = request_body(&req("gemini-3.8-flash", Effort::Minimum), flash);
        assert_eq!(b["generation_config"]["thinking_level"], "low");
        let b = request_body(&req("gemini-3.8-flash", Effort::High), flash);
        assert_eq!(b["generation_config"]["thinking_level"], "high");
    }

    #[test]
    fn output_and_thought_tokens_are_both_billed() {
        let c = parse_response(
            r#"{"id":"i1","object":"interaction","status":"completed","steps":[{"type":"model_output",
                "content":[{"type":"text","text":"{\"a\":"},{"type":"text","text":"1}"}]}],
                "usage":{"total_input_tokens":100,"total_cached_tokens":40,"total_output_tokens":20,
                "total_thought_tokens":22,"total_tokens":142}}"#,
        )
        .unwrap();
        assert_eq!((c.text.as_str(), c.stop), (r#"{"a":1}"#, Stop::Done));
        let u = c.usage.unwrap();
        assert_eq!(
            (u.input, u.cached_input, u.output, u.thinking),
            (60, 40, 42, 22)
        );
        let cut = parse_response(r#"{"status":"incomplete","steps":[]}"#).unwrap();
        assert_eq!(cut.stop, Stop::Length);
    }
}
