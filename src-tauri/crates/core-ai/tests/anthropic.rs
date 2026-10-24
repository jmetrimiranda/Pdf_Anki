//! The Claude adapter against a local server that replays recorded Anthropic responses (shapes from the official
//! Messages API reference). No real call, no real key. Checks the headers and body we send, the parsing of what comes
//! back, the error codes, the billing, and that the key never shows up in an error.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::Value;

use core_ai::anthropic::{API_VERSION, AnthropicProvider};
use core_ai::limits::{Caps, Origin, Spent};
use core_ai::prompts::{self, EnrichItem, EnrichOut, JudgeInput, JudgeOut};
use core_ai::{
    ApiKey, CallSpec, CompletionRequest, Effort, Engine, Feature, Ledger, PriceTable, ProviderKind,
};

const KEY: &str = "test-key-anthropic-FAKE1234";

/// Status, body and an optional `retry-after` header.
type Reply = (u16, &'static str, Option<&'static str>);

#[derive(Clone, Default)]
struct Fake {
    replies: Arc<Mutex<VecDeque<Reply>>>,
    seen: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>,
}

fn recorded(name: &str) -> &'static str {
    let path = format!(
        "{}/tests/recorded/anthropic/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    Box::leak(std::fs::read_to_string(path).unwrap().into_boxed_str())
}

async fn handle(State(f): State<Fake>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    f.seen
        .lock()
        .unwrap()
        .push((uri.path().to_owned(), headers, json));
    let (status, body, retry) = f
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("a scripted reply");
    let mut resp = (StatusCode::from_u16(status).unwrap(), body).into_response();
    resp.headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    if let Some(r) = retry {
        resp.headers_mut().insert("retry-after", r.parse().unwrap());
    }
    resp
}

async fn serve(replies: Vec<Reply>) -> (String, Fake) {
    let fake = Fake {
        replies: Arc::new(Mutex::new(replies.into())),
        ..Fake::default()
    };
    let app = Router::new().fallback(handle).with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), fake)
}

#[derive(Default)]
struct MemLedger {
    records: Mutex<Vec<core_ai::UsageRecord>>,
}

impl Ledger for MemLedger {
    fn spent(&self) -> core_ai::Result<Spent> {
        let total: f64 = self
            .records
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.cost_usd)
            .sum();
        Ok(Spent {
            day_usd: total,
            month_usd: total,
        })
    }
    fn record(&self, rec: &core_ai::UsageRecord) -> core_ai::Result<()> {
        self.records.lock().unwrap().push(rec.clone());
        Ok(())
    }
}

fn judge_request(max: u32) -> CompletionRequest {
    let (system, user) = prompts::judge_prompt(&JudgeInput {
        linguagem: "bash".into(),
        pergunta: "Instalar o turtlesim".into(),
        resposta: "sudo apt install ros-humble-turtlesim".into(),
        resposta_usuario: "apt install ros-humble-turtlesim".into(),
        veredito_auto: "quase".into(),
        diffs: "faltou sudo".into(),
        ..JudgeInput::default()
    });
    CompletionRequest {
        model: "claude-sonnet-5-5".into(),
        system,
        user,
        schema: prompts::judge_schema(),
        schema_name: "juiz",
        max_output_tokens: max,
        effort: Effort::Low,
    }
}

#[tokio::test]
async fn judge_call_sends_the_documented_request_and_bills_the_returned_usage() {
    let (base, fake) = serve(vec![(200, recorded("judge_ok"), None)]).await;
    let provider = AnthropicProvider::with_base_url(&base);
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Anthropic, "claude-sonnet-5-5")
        .unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let ledger = Arc::new(MemLedger::default());
    let engine = Engine::new(ledger.clone());
    let spec = CallSpec {
        provider: &provider,
        key: &key,
        price,
        feature: Feature::Judge,
        caps: Caps::default(),
        origin: Origin::Foreground { confirmed: false },
    };
    let out: JudgeOut = engine
        .structured(&spec, &judge_request(2000), prompts::validate_judge)
        .await
        .unwrap();
    assert_eq!(out.veredito, "quase");
    assert_eq!(out.nota_sugerida, 2);

    let seen = fake.seen.lock().unwrap();
    let (path, headers, body) = &seen[0];
    assert_eq!(path, "/v1/messages");
    assert_eq!(headers["x-api-key"], KEY);
    assert_eq!(headers["anthropic-version"], API_VERSION);
    assert_eq!(body["model"], "claude-sonnet-5-5");
    assert_eq!(body["max_tokens"], 2000);
    assert_eq!(body["output_config"]["effort"], "low");
    assert_eq!(body["output_config"]["format"]["type"], "json_schema");
    assert_eq!(
        body["output_config"]["format"]["schema"]["additionalProperties"],
        false
    );
    assert_eq!(body["service_tier"], "standard_only");
    for k in ["temperature", "top_p", "top_k", "thinking"] {
        assert!(body.get(k).is_none(), "{k} must not be sent at effort low");
    }
    // The untrusted answer sits inside the data block of the user message, not in the system prompt.
    assert!(
        body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("<dados>")
    );
    assert!(!body["system"].as_str().unwrap().contains("ros-humble"));

    let recs = ledger.records.lock().unwrap();
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0].usage.output, 96);
    assert_eq!(recs[0].usage.thinking, 41);
    assert!((recs[0].cost_usd - (412.0 * 2.0 + 96.0 * 10.0) / 1e6).abs() < 1e-12);
    assert!(!recs[0].estimated);
}

#[tokio::test]
async fn enrichment_batch_at_minimum_effort_turns_haiku_thinking_off() {
    let (base, fake) = serve(vec![(200, recorded("enrich_ok"), None)]).await;
    let provider = AnthropicProvider::with_base_url(&base);
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Anthropic, "claude-haiku-5-5")
        .unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let engine = Engine::new(Arc::new(MemLedger::default()));
    let items = vec![
        EnrichItem {
            lema: "windmill".into(),
            classe: "NOUN".into(),
            frase: "The windmill was finished.".into(),
        },
        EnrichItem {
            lema: "pasture".into(),
            classe: "NOUN".into(),
            frase: "The pasture which lay below.".into(),
        },
    ];
    let (system, user) = prompts::enrich_prompt(&items);
    let req = CompletionRequest {
        model: "claude-haiku-5-5".into(),
        system,
        user,
        schema: prompts::enrich_schema(),
        schema_name: "vocabulario",
        max_output_tokens: 4000,
        effort: Effort::Minimum,
    };
    let spec = CallSpec {
        provider: &provider,
        key: &key,
        price,
        feature: Feature::Enrich,
        caps: Caps::default(),
        origin: Origin::Background,
    };
    let out: EnrichOut = engine
        .structured(&spec, &req, |o: &EnrichOut| {
            prompts::validate_enrich(&items, o)
        })
        .await
        .unwrap();
    assert_eq!(out.itens[0].traducao, "moinho de vento");
    let seen = fake.seen.lock().unwrap();
    assert_eq!(
        seen[0].2["thinking"],
        serde_json::json!({ "type": "disabled" })
    );
    assert_eq!(seen[0].2["max_tokens"], 4000);
}

#[tokio::test]
async fn cut_and_refused_answers() {
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Anthropic, "claude-sonnet-5-5")
        .unwrap();
    let key = ApiKey::new(KEY).unwrap();

    // Cut at the cap twice (low effort, then minimum) → truncated; both calls are billed.
    let (base, fake) = serve(vec![
        (200, recorded("max_tokens"), None),
        (200, recorded("max_tokens"), None),
    ])
    .await;
    let provider = AnthropicProvider::with_base_url(&base);
    let ledger = Arc::new(MemLedger::default());
    let engine = Engine::new(ledger.clone());
    let spec = CallSpec {
        provider: &provider,
        key: &key,
        price,
        feature: Feature::Judge,
        caps: Caps::default(),
        origin: Origin::Foreground { confirmed: false },
    };
    let e = engine
        .structured::<JudgeOut>(&spec, &judge_request(2000), prompts::validate_judge)
        .await
        .unwrap_err();
    assert_eq!(e.code(), "ai_truncated");
    assert_eq!(ledger.records.lock().unwrap().len(), 2);
    assert_eq!(
        fake.seen.lock().unwrap()[1].2["thinking"],
        serde_json::json!({ "type": "between_tools" })
    );

    let (base, _) = serve(vec![(200, recorded("refusal"), None)]).await;
    let provider = AnthropicProvider::with_base_url(&base);
    let spec = CallSpec {
        provider: &provider,
        ..spec
    };
    let e = engine
        .structured::<JudgeOut>(&spec, &judge_request(2000), prompts::validate_judge)
        .await
        .unwrap_err();
    assert_eq!(e.code(), "ai_refused");
}

#[tokio::test]
async fn http_errors_become_codes_without_the_key() {
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Anthropic, "claude-sonnet-5-5")
        .unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let (base, _) = serve(vec![
        (401, recorded("error_auth"), None),
        (429, recorded("error_rate_limit"), Some("12")),
        (529, recorded("error_overloaded"), None),
    ])
    .await;
    let provider = AnthropicProvider::with_base_url(&base);
    let ledger = Arc::new(MemLedger::default());
    let engine = Engine::new(ledger.clone());
    let spec = CallSpec {
        provider: &provider,
        key: &key,
        price,
        feature: Feature::Judge,
        caps: Caps::default(),
        origin: Origin::Foreground { confirmed: false },
    };
    let mut codes = vec![];
    for _ in 0..3 {
        let e = engine.call(&spec, &judge_request(2000)).await.unwrap_err();
        let shown = format!("{e} {e:?} {}", serde_json::to_string(&e).unwrap());
        assert!(
            !shown.contains(KEY) && !shown.contains("FAKE1234"),
            "{shown}"
        );
        codes.push(e);
    }
    assert_eq!(codes[0].code(), "ai_auth");
    assert_eq!(
        codes[1],
        core_ai::AiError::RateLimited {
            retry_after_secs: Some(12)
        }
    );
    assert_eq!(codes[2].code(), "ai_server");
    // Nothing was billed: no answer came back.
    assert!(ledger.records.lock().unwrap().is_empty());
    // The key never appears in Debug output.
    assert_eq!(format!("{key:?}"), "ApiKey(***)");
    assert_eq!(key.suffix(), "1234");
}

#[tokio::test]
async fn offline_and_test_key() {
    // Nothing listens on this port: offline, no panic.
    let provider = AnthropicProvider::with_base_url("http://127.0.0.1:9");
    let key = ApiKey::new(KEY).unwrap();
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Anthropic, "claude-haiku-5-5")
        .unwrap();
    let engine = Engine::new(Arc::new(MemLedger::default()));
    let spec = CallSpec {
        provider: &provider,
        key: &key,
        price,
        feature: Feature::Define,
        caps: Caps::default(),
        origin: Origin::Foreground { confirmed: false },
    };
    assert_eq!(
        engine
            .call(&spec, &judge_request(100))
            .await
            .unwrap_err()
            .code(),
        "ai_offline"
    );

    // "Testar chave": GET /v1/models/{id}, no tokens.
    let (base, fake) = serve(vec![
        (200, recorded("model"), None),
        (404, recorded("error_not_found"), None),
        (401, recorded("error_auth"), None),
    ])
    .await;
    let provider = AnthropicProvider::with_base_url(&base);
    use core_ai::Provider;
    provider.test_key(&key, "claude-haiku-5-5").await.unwrap();
    assert_eq!(
        provider
            .test_key(&key, "claude-nao-existe")
            .await
            .unwrap_err()
            .code(),
        "ai_model_not_found"
    );
    assert_eq!(
        provider
            .test_key(&key, "claude-haiku-5-5")
            .await
            .unwrap_err()
            .code(),
        "ai_auth"
    );
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen[0].0, "/v1/models/claude-haiku-5-5");
    assert_eq!(seen[0].1["anthropic-version"], API_VERSION);
}

#[test]
fn no_key_pattern_in_versioned_test_data() {
    // Recorded responses and prompts carry no real-looking key (plan 4).
    let root = env!("CARGO_MANIFEST_DIR");
    for dir in [
        "tests/recorded/anthropic",
        "tests/recorded/openai",
        "tests/recorded/deepseek",
        "prompts",
    ] {
        for entry in std::fs::read_dir(format!("{root}/{dir}")).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            for pat in ["sk-ant-", "sk-proj-", "AIza"] {
                assert!(!text.contains(pat), "{dir}: {pat}");
            }
        }
    }
}
