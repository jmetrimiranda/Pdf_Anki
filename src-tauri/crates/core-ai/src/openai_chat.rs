//! GPT (OpenAI) and DeepSeek through the Chat Completions API (plan 2.3, 2.5): one adapter, two dialects.
//!
//! - **OpenAI** (`POST /v1/chat/completions`, `Authorization: Bearer`): structured output with
//!   `response_format: json_schema` (strict), `max_completion_tokens` (visible + reasoning), `reasoning_effort`
//!   (`none` where the model has it for "mínimo"), `store: false`, `service_tier: "default"`; no sampling
//!   parameters. Refusals come in `message.refusal`.
//! - **DeepSeek** (`POST /chat/completions`): only `response_format: json_object` — the schema goes in the system
//!   prompt (the prompt must say "JSON"), the validation in Rust is the guarantee; `max_tokens`; thinking off for
//!   "mínimo" (`thinking: {type: "disabled"}`), `reasoning_effort` otherwise. An empty `content` (documented) is an
//!   invalid answer and gets the engine's one retry. The cache fields are read where either of the documented
//!   places puts them.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{AiError, Result};
use crate::http;
use crate::prices::ModelPrice;
use crate::provider::{BoxFuture, Provider};
use crate::types::{ApiKey, Completion, CompletionRequest, Effort, ProviderKind, Stop, Usage};

pub const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    OpenAi,
    DeepSeek,
}

impl Dialect {
    fn kind(self) -> ProviderKind {
        match self {
            Self::OpenAi => ProviderKind::Openai,
            Self::DeepSeek => ProviderKind::Deepseek,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "GPT",
            Self::DeepSeek => "DeepSeek",
        }
    }
}

pub struct OpenAiChatProvider {
    client: reqwest::Client,
    base: String,
    dialect: Dialect,
}

impl OpenAiChatProvider {
    pub fn openai() -> Self {
        Self::with_base_url(Dialect::OpenAi, OPENAI_BASE_URL)
    }

    pub fn deepseek() -> Self {
        Self::with_base_url(Dialect::DeepSeek, DEEPSEEK_BASE_URL)
    }

    /// `base` ends where `/chat/completions` and `/models` start (tests: a local server).
    pub fn with_base_url(dialect: Dialect, base: &str) -> Self {
        Self {
            client: http::client(),
            base: base.trim_end_matches('/').to_owned(),
            dialect,
        }
    }
}

/// The level sent for an app effort, among the ones the model accepts (`levels`, from the price table).
fn level(effort: Effort, levels: &[String], none_for_minimum: bool) -> Option<&'static str> {
    let has = |l: &str| levels.iter().any(|x| x == l);
    let wanted: &[&'static str] = match effort {
        Effort::Minimum if none_for_minimum => &["none"],
        Effort::Minimum | Effort::Low => &["low", "minimal", "medium"],
        Effort::Medium => &["medium", "high", "low"],
        Effort::High => &["high", "medium"],
    };
    wanted.iter().copied().find(|l| has(l))
}

/// The request body (pure, unit-tested).
pub fn request_body(dialect: Dialect, req: &CompletionRequest, price: &ModelPrice) -> Value {
    match dialect {
        Dialect::OpenAi => {
            let mut body = json!({
                "model": req.model,
                "messages": [
                    { "role": "system", "content": req.system },
                    { "role": "user", "content": req.user },
                ],
                "max_completion_tokens": req.max_output_tokens,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": { "name": req.schema_name, "schema": req.schema, "strict": true },
                },
                // Nothing kept for "distillation or evals"; never a pricier tier (plan 2.1, 2.3).
                "store": false,
                "service_tier": "default",
            });
            if price.effort_param == "openai"
                && let Some(l) = level(
                    req.effort,
                    &price.effort_levels,
                    price.thinking_off == "none",
                )
            {
                body["reasoning_effort"] = json!(l);
            }
            body
        }
        Dialect::DeepSeek => {
            // json_object mode: the prompt must ask for JSON and show its shape.
            let system = format!(
                "{}\n\nResponda só com um objeto JSON que siga este JSON Schema:\n{}",
                req.system, req.schema
            );
            let mut body = json!({
                "model": req.model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": req.user },
                ],
                "max_tokens": req.max_output_tokens,
                "response_format": { "type": "json_object" },
            });
            if price.effort_param == "deepseek" {
                if req.effort == Effort::Minimum && price.thinking_off == "disabled" {
                    body["thinking"] = json!({ "type": "disabled" });
                } else if let Some(l) = level(req.effort, &price.effort_levels, false) {
                    body["reasoning_effort"] = json!(l);
                }
            }
            body
        }
    }
}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    message: Option<Message>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    refusal: Option<String>,
}

#[derive(Deserialize)]
struct RawUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    prompt_tokens_details: Option<PromptDetails>,
    #[serde(default)]
    completion_tokens_details: Option<CompletionDetails>,
    // DeepSeek (top level in its schema).
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct PromptDetails {
    #[serde(default)]
    cached_tokens: Option<u64>,
    // DeepSeek (inside the details in some of its examples).
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct CompletionDetails {
    #[serde(default)]
    reasoning_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Deserialize)]
struct ErrorDetail {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    code: Option<Value>,
}

/// Parses a 200 response.
pub fn parse_response(body: &str) -> Result<Completion> {
    let r: Response = serde_json::from_str(body).map_err(|_| AiError::InvalidOutput)?;
    let choice = r.choices.into_iter().next();
    let (message, finish) = match choice {
        Some(c) => (c.message, c.finish_reason),
        None => (None, None),
    };
    let refused = message
        .as_ref()
        .and_then(|m| m.refusal.as_deref())
        .is_some_and(|r| !r.trim().is_empty());
    let text = message.and_then(|m| m.content).unwrap_or_default();
    let stop = if refused {
        Stop::Refused
    } else {
        match finish.as_deref() {
            Some("stop") => Stop::Done,
            Some("length") => Stop::Length,
            Some("content_filter") => Stop::Refused,
            _ => Stop::Other,
        }
    };
    let usage = r.usage.map(|u| {
        let cached = u
            .prompt_cache_hit_tokens
            .or_else(|| {
                u.prompt_tokens_details
                    .as_ref()
                    .and_then(|d| d.cached_tokens.or(d.prompt_cache_hit_tokens))
            })
            .unwrap_or(0)
            .min(u.prompt_tokens);
        Usage {
            input: u.prompt_tokens - cached,
            cached_input: cached,
            cache_write: 0,
            // Reasoning is inside `completion_tokens` (billed as output).
            output: u.completion_tokens,
            thinking: u
                .completion_tokens_details
                .and_then(|d| d.reasoning_tokens)
                .unwrap_or(0),
        }
    });
    Ok(Completion { text, usage, stop })
}

async fn error_from(dialect: Dialect, resp: reqwest::Response, model: &str) -> AiError {
    let status = resp.status().as_u16();
    let retry = http::retry_after(resp.headers());
    let detail = resp
        .text()
        .await
        .ok()
        .and_then(|b| serde_json::from_str::<ErrorBody>(&b).ok())
        .map(|e| e.error);
    // OpenAI: `insufficient_quota`; DeepSeek: HTTP 402 "Insufficient Balance".
    if status == 402 {
        return AiError::ProviderSpendLimit(dialect.name());
    }
    let code = detail
        .as_ref()
        .and_then(|d| d.code.as_ref())
        .and_then(Value::as_str)
        .map(str::to_owned);
    let kind = code.or_else(|| detail.and_then(|d| d.kind));
    if kind.as_deref() == Some("model_not_found") {
        return AiError::ModelNotFound(model.to_owned());
    }
    http::status_error(dialect.name(), status, kind.as_deref(), retry, model)
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

impl Provider for OpenAiChatProvider {
    fn kind(&self) -> ProviderKind {
        self.dialect.kind()
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
                .post(format!("{}/chat/completions", self.base))
                .bearer_auth(key.expose())
                .json(&request_body(self.dialect, req, price))
                .send()
                .await
                .map_err(|e| http::transport_error(&e))?;
            if !resp.status().is_success() {
                return Err(error_from(self.dialect, resp, &req.model).await);
            }
            let body = resp.text().await.map_err(|e| http::transport_error(&e))?;
            parse_response(&body)
        })
    }

    /// OpenAI: `GET /models/{model}`. DeepSeek has no per-model route: `GET /models` and look for it. No tokens.
    fn test_key<'a>(&'a self, key: &'a ApiKey, model: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let url = match self.dialect {
                Dialect::OpenAi => format!("{}/models/{model}", self.base),
                Dialect::DeepSeek => format!("{}/models", self.base),
            };
            let resp = self
                .client
                .get(url)
                .bearer_auth(key.expose())
                .send()
                .await
                .map_err(|e| http::transport_error(&e))?;
            if !resp.status().is_success() {
                return Err(error_from(self.dialect, resp, model).await);
            }
            if self.dialect == Dialect::DeepSeek {
                let list: ModelList = resp.json().await.map_err(|_| AiError::InvalidOutput)?;
                if !list.data.iter().any(|m| m.id == model) {
                    return Err(AiError::ModelNotFound(model.to_owned()));
                }
            }
            Ok(())
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
            max_output_tokens: 2000,
            effort,
        }
    }

    #[test]
    fn openai_effort_and_json_schema() {
        let t = PriceTable::built_in();
        let luna = t.get(ProviderKind::Openai, "gpt-6-luna").unwrap();
        let sol = t.get(ProviderKind::Openai, "gpt-6.1-sol").unwrap();
        let b = request_body(Dialect::OpenAi, &req("gpt-6-luna", Effort::Minimum), luna);
        assert_eq!(b["reasoning_effort"], "none");
        assert_eq!(b["max_completion_tokens"], 2000);
        assert_eq!(b["response_format"]["json_schema"]["strict"], true);
        assert_eq!(b["store"], false);
        assert!(b.get("temperature").is_none() && b.get("max_tokens").is_none());
        // Sol has no `none`: its lowest level.
        let b = request_body(Dialect::OpenAi, &req("gpt-6.1-sol", Effort::Minimum), sol);
        assert_eq!(b["reasoning_effort"], "low");
        let b = request_body(Dialect::OpenAi, &req("gpt-6.1-sol", Effort::High), sol);
        assert_eq!(b["reasoning_effort"], "high");
    }

    #[test]
    fn deepseek_json_object_with_the_schema_in_the_prompt() {
        let t = PriceTable::built_in();
        let flash = t.get(ProviderKind::Deepseek, "deepseek-flash").unwrap();
        let b = request_body(
            Dialect::DeepSeek,
            &req("deepseek-flash", Effort::Minimum),
            flash,
        );
        assert_eq!(b["response_format"]["type"], "json_object");
        assert_eq!(b["thinking"]["type"], "disabled");
        assert!(b.get("reasoning_effort").is_none());
        assert_eq!(b["max_tokens"], 2000);
        let system = b["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("JSON") && system.contains(r#"{"type":"object"}"#));
        // Medium has no exact level: the next one up.
        let b = request_body(
            Dialect::DeepSeek,
            &req("deepseek-flash", Effort::Medium),
            flash,
        );
        assert_eq!(b["reasoning_effort"], "high");
    }

    #[test]
    fn parses_refusals_cuts_and_both_cache_layouts() {
        let ok = parse_response(
            r#"{"choices":[{"message":{"content":"{}","refusal":null},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":100,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":30},
                "completion_tokens_details":{"reasoning_tokens":10}}}"#,
        )
        .unwrap();
        assert_eq!(ok.stop, Stop::Done);
        let u = ok.usage.unwrap();
        assert_eq!(
            (u.input, u.cached_input, u.output, u.thinking),
            (70, 30, 40, 10)
        );
        let refused = parse_response(
            r#"{"choices":[{"message":{"content":null,"refusal":"no"},"finish_reason":"stop"}]}"#,
        )
        .unwrap();
        assert_eq!(refused.stop, Stop::Refused);
        let cut = parse_response(
            r#"{"choices":[{"message":{"content":"{\"a"},"finish_reason":"length"}]}"#,
        )
        .unwrap();
        assert_eq!(cut.stop, Stop::Length);
        let ds = parse_response(
            r#"{"choices":[{"message":{"content":""},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":50,"completion_tokens":5,"prompt_cache_hit_tokens":20,"prompt_cache_miss_tokens":30}}"#,
        )
        .unwrap();
        assert_eq!(ds.text, "");
        let u = ds.usage.unwrap();
        assert_eq!((u.input, u.cached_input), (30, 20));
    }
}
