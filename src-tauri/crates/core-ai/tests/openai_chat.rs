//! GPT (OpenAI) and DeepSeek through the shared Chat Completions adapter, against a local server replaying recorded
//! responses (shapes from the official API references). No real call, no real key.

mod common;

use std::sync::Arc;

use common::{MemLedger, recorded, serve};
use core_ai::limits::{Caps, Origin};
use core_ai::openai_chat::{Dialect, OpenAiChatProvider};
use core_ai::prompts::{self, EnrichItem, EnrichOut, JudgeInput, JudgeOut};
use core_ai::{
    ApiKey, CallSpec, CompletionRequest, Effort, Engine, Feature, PriceTable, Provider,
    ProviderKind,
};

const KEY: &str = "test-key-openai-FAKE1234";

fn judge(model: &str) -> CompletionRequest {
    let (system, user) = prompts::judge_prompt(&JudgeInput {
        linguagem: "bash".into(),
        pergunta: "Instalar o turtlesim".into(),
        resposta: "sudo apt install ros-humble-turtlesim".into(),
        resposta_usuario: "apt install ros-humble-turtlesim".into(),
        veredito_auto: "quase".into(),
        ..JudgeInput::default()
    });
    CompletionRequest {
        model: model.into(),
        system,
        user,
        schema: prompts::judge_schema(),
        schema_name: "juiz",
        max_output_tokens: 2000,
        effort: Effort::Low,
    }
}

fn items() -> Vec<EnrichItem> {
    vec![
        EnrichItem {
            lema: "windmill".into(),
            classe: "noun".into(),
            frase: "The windmill was finished.".into(),
        },
        EnrichItem {
            lema: "pasture".into(),
            classe: "noun".into(),
            frase: "The pasture which lay below.".into(),
        },
    ]
}

fn enrich(model: &str) -> CompletionRequest {
    let (system, user) = prompts::enrich_prompt(&items());
    CompletionRequest {
        model: model.into(),
        system,
        user,
        schema: prompts::enrich_schema(),
        schema_name: "vocabulario",
        max_output_tokens: 4000,
        effort: Effort::Minimum,
    }
}

fn spec<'a>(
    p: &'a dyn Provider,
    key: &'a ApiKey,
    price: &'a core_ai::ModelPrice,
    feature: Feature,
) -> CallSpec<'a> {
    CallSpec {
        provider: p,
        key,
        price,
        feature,
        caps: Caps::default(),
        origin: Origin::Foreground { confirmed: false },
    }
}

#[tokio::test]
async fn gpt_judge_sends_strict_json_schema_and_bills_reasoning_as_output() {
    let (base, fake) = serve(vec![(200, recorded("openai", "judge_ok"), None)]).await;
    let p = OpenAiChatProvider::with_base_url(Dialect::OpenAi, &base);
    let prices = PriceTable::built_in();
    let price = prices.get(ProviderKind::Openai, "gpt-6.1-sol").unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let ledger = Arc::new(MemLedger::default());
    let engine = Engine::new(ledger.clone());
    let out: JudgeOut = engine
        .structured(
            &spec(&p, &key, price, Feature::Judge),
            &judge("gpt-6.1-sol"),
            prompts::validate_judge,
        )
        .await
        .unwrap();
    assert_eq!((out.veredito.as_str(), out.nota_sugerida), ("quase", 2));
    let seen = fake.seen.lock().unwrap();
    let (path, headers, body) = &seen[0];
    assert_eq!(path, "/chat/completions");
    assert_eq!(headers["authorization"], format!("Bearer {KEY}").as_str());
    assert_eq!(body["response_format"]["json_schema"]["strict"], true);
    assert_eq!(body["response_format"]["json_schema"]["name"], "juiz");
    assert_eq!(body["reasoning_effort"], "low");
    assert_eq!(
        (body["store"].as_bool(), body["service_tier"].as_str()),
        (Some(false), Some("default"))
    );
    assert_eq!(body["max_completion_tokens"], 2000);
    for k in ["temperature", "top_p", "logprobs", "max_tokens"] {
        assert!(body.get(k).is_none(), "{k}");
    }
    let rec = &ledger.records.lock().unwrap()[0];
    assert_eq!(
        (rec.usage.input, rec.usage.output, rec.usage.thinking),
        (420, 96, 41)
    );
    assert!((rec.cost_usd - (420.0 * 2.0 + 96.0 * 10.0) / 1e6).abs() < 1e-12);
}

#[tokio::test]
async fn gpt_enrichment_with_cached_input_luna_reasoning_none() {
    let (base, fake) = serve(vec![(200, recorded("openai", "enrich_ok"), None)]).await;
    let p = OpenAiChatProvider::with_base_url(Dialect::OpenAi, &base);
    let prices = PriceTable::built_in();
    let price = prices.get(ProviderKind::Openai, "gpt-6-luna").unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let ledger = Arc::new(MemLedger::default());
    let engine = Engine::new(ledger.clone());
    let sent = items();
    let out: EnrichOut = engine
        .structured(
            &spec(&p, &key, price, Feature::Enrich),
            &enrich("gpt-6-luna"),
            |o: &EnrichOut| prompts::validate_enrich(&sent, o),
        )
        .await
        .unwrap();
    assert_eq!(out.itens[1].traducao, "pasto");
    assert_eq!(fake.seen.lock().unwrap()[0].2["reasoning_effort"], "none");
    let rec = &ledger.records.lock().unwrap()[0];
    assert_eq!((rec.usage.input, rec.usage.cached_input), (98, 512));
}

#[tokio::test]
async fn gpt_cut_refusal_and_errors_without_the_key() {
    let prices = PriceTable::built_in();
    let price = prices.get(ProviderKind::Openai, "gpt-6.1-sol").unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let (base, fake) = serve(vec![
        (200, recorded("openai", "length"), None),
        (200, recorded("openai", "length"), None),
        (200, recorded("openai", "refusal"), None),
        (401, recorded("openai", "error_auth"), None),
        (429, recorded("openai", "error_quota"), None),
        (429, recorded("openai", "error_rate_limit"), Some("20")),
        (404, recorded("openai", "error_not_found"), None),
    ])
    .await;
    let p = OpenAiChatProvider::with_base_url(Dialect::OpenAi, &base);
    let engine = Engine::new(Arc::new(MemLedger::default()));
    let s = spec(&p, &key, price, Feature::Judge);
    let e = engine
        .structured::<JudgeOut>(&s, &judge("gpt-6.1-sol"), prompts::validate_judge)
        .await
        .unwrap_err();
    assert_eq!(e.code(), "ai_truncated");
    // The retry after a cut goes at the model's lowest level (Sol has no "none").
    assert_eq!(fake.seen.lock().unwrap()[1].2["reasoning_effort"], "low");
    let e = engine
        .structured::<JudgeOut>(&s, &judge("gpt-6.1-sol"), prompts::validate_judge)
        .await
        .unwrap_err();
    assert_eq!(e.code(), "ai_refused");
    let mut codes = Vec::new();
    for _ in 0..3 {
        let e = engine.call(&s, &judge("gpt-6.1-sol")).await.unwrap_err();
        let shown = format!("{e} {e:?} {}", serde_json::to_string(&e).unwrap());
        // OpenAI echoes part of the key in its error message: it never reaches ours.
        assert!(
            !shown.contains("test-key") && !shown.contains("1234"),
            "{shown}"
        );
        codes.push(e);
    }
    assert_eq!(codes[0].code(), "ai_auth");
    assert_eq!(codes[1].code(), "ai_provider_spend_limit");
    assert_eq!(
        codes[2],
        core_ai::AiError::RateLimited {
            retry_after_secs: Some(20)
        }
    );
    assert_eq!(
        p.test_key(&key, "gpt-nao-existe").await.unwrap_err().code(),
        "ai_model_not_found"
    );
}

#[tokio::test]
async fn gpt_test_key_reads_the_model() {
    let (base, fake) = serve(vec![(200, recorded("openai", "model"), None)]).await;
    let p = OpenAiChatProvider::with_base_url(Dialect::OpenAi, &base);
    p.test_key(&ApiKey::new(KEY).unwrap(), "gpt-6-luna")
        .await
        .unwrap();
    assert_eq!(fake.seen.lock().unwrap()[0].0, "/models/gpt-6-luna");
}

#[tokio::test]
async fn deepseek_json_object_retry_on_empty_content_cache_and_balance() {
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Deepseek, "deepseek-flash")
        .unwrap();
    let key = ApiKey::new("test-key-deepseek-FAKE5678").unwrap();
    let (base, fake) = serve(vec![
        (200, recorded("deepseek", "empty"), None),
        (200, recorded("deepseek", "enrich_ok"), None),
        (402, recorded("deepseek", "error_balance"), None),
        (200, recorded("deepseek", "models"), None),
        (200, recorded("deepseek", "models"), None),
    ])
    .await;
    let p = OpenAiChatProvider::with_base_url(Dialect::DeepSeek, &base);
    let ledger = Arc::new(MemLedger::default());
    let engine = Engine::new(ledger.clone());
    let s = CallSpec {
        origin: Origin::Background,
        ..spec(&p, &key, price, Feature::Enrich)
    };
    let sent = items();
    let out: EnrichOut = engine
        .structured(&s, &enrich("deepseek-flash"), |o: &EnrichOut| {
            prompts::validate_enrich(&sent, o)
        })
        .await
        .unwrap();
    assert_eq!(out.itens[0].traducao, "moinho de vento");
    {
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "an empty answer gets the one retry");
        let body = &seen[0].2;
        assert_eq!(body["response_format"]["type"], "json_object");
        assert_eq!(body["thinking"]["type"], "disabled");
        assert_eq!(body["max_tokens"], 4000);
        assert!(
            body["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("JSON Schema")
        );
    }
    let recs = ledger.records.lock().unwrap().clone();
    assert_eq!(recs.len(), 2, "both calls billed");
    assert_eq!((recs[1].usage.input, recs[1].usage.cached_input), (60, 640));

    let e = engine
        .call(&s, &enrich("deepseek-flash"))
        .await
        .unwrap_err();
    assert_eq!(e.code(), "ai_provider_spend_limit");
    // "Testar chave": the list of models (no per-model route).
    p.test_key(&key, "deepseek-flash").await.unwrap();
    assert_eq!(
        p.test_key(&key, "deepseek-nao-existe")
            .await
            .unwrap_err()
            .code(),
        "ai_model_not_found"
    );
    assert_eq!(fake.seen.lock().unwrap()[3].0, "/models");
}
