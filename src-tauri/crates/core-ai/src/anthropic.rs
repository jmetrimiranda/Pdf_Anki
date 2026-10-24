//! Claude through Anthropic's own Messages API (plan 2.2):
//! `POST /v1/messages` with `x-api-key` and `anthropic-version: 2026-10-21`, structured output through
//! `output_config.format` (json_schema), the effort explicit on every call, and thinking turned off for "mínimo" the
//! way each model allows (`disabled` on Haiku 5.5, `between_tools` on Sonnet 5.5). No sampling parameters
//! (`temperature`/`top_p`/`top_k` are a 400 on this API version).

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{AiError, Result};
use crate::http;
use crate::prices::ModelPrice;
use crate::provider::{BoxFuture, Provider};
use crate::types::{ApiKey, Completion, CompletionRequest, Effort, ProviderKind, Stop, Usage};

pub const BASE_URL: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2026-10-21";
const NAME: &str = "Claude";

pub struct AnthropicProvider {
    client: reqwest::Client,
    base: String,
}

impl Default for AnthropicProvider {
    fn default() -> Self {
        Self::with_base_url(BASE_URL)
    }
}

impl AnthropicProvider {
    /// Tests point it at a local server that replays recorded responses.
    pub fn with_base_url(base: &str) -> Self {
        Self {
            client: http::client(),
            base: base.trim_end_matches('/').to_owned(),
        }
    }
}

/// The request body (pure, unit-tested).
pub fn request_body(req: &CompletionRequest, price: &ModelPrice) -> Value {
    let mut output_config = json!({ "format": { "type": "json_schema", "schema": req.schema } });
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_output_tokens,
        "system": req.system,
        "messages": [{ "role": "user", "content": req.user }],
        // Never a pricier tier than the standard one (plan 2.1).
        "service_tier": "standard_only",
    });
    let has_effort = price.effort_param == "anthropic";
    let effort = match req.effort {
        Effort::Minimum | Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
    };
    if has_effort {
        output_config["effort"] = json!(effort);
    }
    if req.effort == Effort::Minimum {
        match price.thinking_off.as_str() {
            "disabled" => body["thinking"] = json!({ "type": "disabled" }),
            "between_tools" => body["thinking"] = json!({ "type": "between_tools" }),
            _ => {}
        }
    }
    body["output_config"] = output_config;
    body
}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    content: Vec<Block>,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct RawUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    output_tokens_details: Option<OutputDetails>,
}

#[derive(Deserialize)]
struct OutputDetails {
    #[serde(default)]
    thinking_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Deserialize)]
struct ErrorDetail {
    #[serde(rename = "type")]
    kind: String,
}

/// Parses a 200 response. Blocks are read by type: thinking blocks may come first.
pub fn parse_response(body: &str) -> Result<Completion> {
    let r: Response = serde_json::from_str(body).map_err(|_| AiError::InvalidOutput)?;
    let text = r
        .content
        .iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text.as_deref())
        .collect::<String>();
    let stop = match r.stop_reason.as_deref() {
        Some("end_turn") | Some("stop_sequence") => Stop::Done,
        Some("max_tokens") => Stop::Length,
        Some("refusal") => Stop::Refused,
        _ => Stop::Other,
    };
    let usage = r.usage.map(|u| Usage {
        input: u.input_tokens,
        cached_input: u.cache_read_input_tokens.unwrap_or(0),
        cache_write: u.cache_creation_input_tokens.unwrap_or(0),
        output: u.output_tokens,
        thinking: u
            .output_tokens_details
            .and_then(|d| d.thinking_tokens)
            .unwrap_or(0),
    });
    Ok(Completion { text, usage, stop })
}

async fn error_from(resp: reqwest::Response, model: &str) -> AiError {
    let status = resp.status().as_u16();
    let retry = http::retry_after(resp.headers());
    let kind = resp
        .text()
        .await
        .ok()
        .and_then(|b| serde_json::from_str::<ErrorBody>(&b).ok())
        .map(|e| e.error.kind);
    if status == 529 || kind.as_deref() == Some("overloaded_error") {
        return AiError::Server(529);
    }
    http::status_error(NAME, status, kind.as_deref(), retry, model)
}

impl Provider for AnthropicProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
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
                .post(format!("{}/v1/messages", self.base))
                .header("x-api-key", key.expose())
                .header("anthropic-version", API_VERSION)
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

    fn test_key<'a>(&'a self, key: &'a ApiKey, model: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let resp = self
                .client
                .get(format!("{}/v1/models/{model}", self.base))
                .header("x-api-key", key.expose())
                .header("anthropic-version", API_VERSION)
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
            user: "usr".into(),
            schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            schema_name: "t",
            max_output_tokens: 4000,
            effort,
        }
    }

    #[test]
    fn minimum_turns_thinking_off_the_way_each_model_allows() {
        let t = PriceTable::built_in();
        let haiku = t.get(ProviderKind::Anthropic, "claude-haiku-5-5").unwrap();
        let sonnet = t.get(ProviderKind::Anthropic, "claude-sonnet-5-5").unwrap();
        let b = request_body(&req("claude-haiku-5-5", Effort::Minimum), haiku);
        assert_eq!(b["thinking"], json!({ "type": "disabled" }));
        assert_eq!(b["output_config"]["effort"], "low");
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert_eq!(b["max_tokens"], 4000);
        assert_eq!(b["service_tier"], "standard_only");
        let b = request_body(&req("claude-sonnet-5-5", Effort::Minimum), sonnet);
        assert_eq!(b["thinking"], json!({ "type": "between_tools" }));
        // "Baixo" keeps adaptive thinking at low effort.
        let b = request_body(&req("claude-sonnet-5-5", Effort::Low), sonnet);
        assert!(b.get("thinking").is_none());
        assert_eq!(b["output_config"]["effort"], "low");
        for k in ["temperature", "top_p", "top_k"] {
            assert!(b.get(k).is_none());
        }
    }

    #[test]
    fn parses_text_after_thinking_blocks_and_usage() {
        let c = parse_response(
            r#"{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"{\"a\":1}"}],
                "stop_reason":"end_turn",
                "usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":0,
                         "output_tokens":30,"output_tokens_details":{"thinking_tokens":12}}}"#,
        )
        .unwrap();
        assert_eq!(c.text, r#"{"a":1}"#);
        assert_eq!(c.stop, Stop::Done);
        assert_eq!(
            c.usage,
            Some(Usage {
                input: 10,
                cached_input: 5,
                cache_write: 0,
                output: 30,
                thinking: 12
            })
        );
        assert_eq!(
            parse_response(r#"{"content":[],"stop_reason":"max_tokens"}"#)
                .unwrap()
                .stop,
            Stop::Length
        );
        assert_eq!(
            parse_response(r#"{"content":[],"stop_reason":"refusal"}"#)
                .unwrap()
                .stop,
            Stop::Refused
        );
        assert_eq!(
            parse_response("not json").unwrap_err().code(),
            "ai_invalid_output"
        );
    }
}
