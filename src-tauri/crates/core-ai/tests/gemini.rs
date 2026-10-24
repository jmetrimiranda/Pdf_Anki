//! Gemini through the native Interactions API, against a local server replaying recorded responses (shapes from the
//! official API reference and structured-output guide). No real call, no real key.

mod common;

use std::sync::Arc;

use common::{MemLedger, recorded, serve};
use core_ai::gemini::GeminiProvider;
use core_ai::limits::{Caps, Origin};
use core_ai::prompts::{self, EnrichItem, EnrichOut, JudgeInput, JudgeOut};
use core_ai::{
    ApiKey, CallSpec, CompletionRequest, Effort, Engine, Feature, PriceTable, Provider,
    ProviderKind,
};

const KEY: &str = "test-key-gemini-FAKE9012";

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

fn judge() -> CompletionRequest {
    let (system, user) = prompts::judge_prompt(&JudgeInput {
        linguagem: "bash".into(),
        pergunta: "Instalar o turtlesim".into(),
        resposta: "sudo apt install ros-humble-turtlesim".into(),
        resposta_usuario: "apt install ros-humble-turtlesim".into(),
        veredito_auto: "quase".into(),
        ..JudgeInput::default()
    });
    CompletionRequest {
        model: "gemini-3.8-flash".into(),
        system,
        user,
        schema: prompts::judge_schema(),
        schema_name: "juiz",
        max_output_tokens: 2000,
        effort: Effort::Low,
    }
}

#[tokio::test]
async fn enrichment_sends_the_native_request_and_bills_output_plus_thoughts() {
    let (base, fake) = serve(vec![(200, recorded("gemini", "enrich_ok"), None)]).await;
    let p = GeminiProvider::with_base_url(&base);
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Gemini, "gemini-3.5-flash-lite")
        .unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let ledger = Arc::new(MemLedger::default());
    let engine = Engine::new(ledger.clone());
    let sent = items();
    let (system, user) = prompts::enrich_prompt(&sent);
    let req = CompletionRequest {
        model: "gemini-3.5-flash-lite".into(),
        system,
        user,
        schema: prompts::enrich_schema(),
        schema_name: "vocabulario",
        max_output_tokens: 4000,
        effort: Effort::Minimum,
    };
    let spec = CallSpec {
        provider: &p,
        key: &key,
        price,
        feature: Feature::Enrich,
        caps: Caps::default(),
        origin: Origin::Background,
    };
    let out: EnrichOut = engine
        .structured(&spec, &req, |o: &EnrichOut| {
            prompts::validate_enrich(&sent, o)
        })
        .await
        .unwrap();
    assert_eq!(out.itens[0].traducao, "moinho de vento");
    let seen = fake.seen.lock().unwrap();
    let (path, headers, body) = &seen[0];
    assert_eq!(path, "/interactions", "the key never goes in the URL");
    assert_eq!(headers["x-goog-api-key"], KEY);
    assert_eq!(body["generation_config"]["thinking_level"], "minimal");
    assert_eq!(body["generation_config"]["max_output_tokens"], 4000);
    assert_eq!(body["response_format"]["schema"]["required"][0], "itens");
    assert_eq!(body["store"], false);
    assert!(
        body["system_instruction"]
            .as_str()
            .unwrap()
            .contains("dicionário")
    );
    let rec = &ledger.records.lock().unwrap()[0];
    assert_eq!(
        (rec.usage.input, rec.usage.output, rec.usage.thinking),
        (640, 96, 12)
    );
    assert!((rec.cost_usd - (640.0 * 0.30 + 96.0 * 2.50) / 1e6).abs() < 1e-12);
}

#[tokio::test]
async fn judge_cut_and_errors_without_the_key() {
    let prices = PriceTable::built_in();
    let price = prices
        .get(ProviderKind::Gemini, "gemini-3.8-flash")
        .unwrap();
    let key = ApiKey::new(KEY).unwrap();
    let (base, fake) = serve(vec![
        (200, recorded("gemini", "judge_ok"), None),
        (200, recorded("gemini", "incomplete"), None),
        (200, recorded("gemini", "incomplete"), None),
        (400, recorded("gemini", "error_key"), None),
        (429, recorded("gemini", "error_exhausted"), Some("30")),
        (200, recorded("gemini", "model"), None),
        (404, recorded("gemini", "error_not_found"), None),
    ])
    .await;
    let p = GeminiProvider::with_base_url(&base);
    let engine = Engine::new(Arc::new(MemLedger::default()));
    let spec = CallSpec {
        provider: &p,
        key: &key,
        price,
        feature: Feature::Judge,
        caps: Caps::default(),
        origin: Origin::Foreground { confirmed: false },
    };
    let out: JudgeOut = engine
        .structured(&spec, &judge(), prompts::validate_judge)
        .await
        .unwrap();
    assert_eq!(out.nota_sugerida, 2);
    assert_eq!(
        fake.seen.lock().unwrap()[0].2["generation_config"]["thinking_level"],
        "low"
    );
    let e = engine
        .structured::<JudgeOut>(&spec, &judge(), prompts::validate_judge)
        .await
        .unwrap_err();
    assert_eq!(e.code(), "ai_truncated");
    for expected in ["ai_auth", "ai_rate_limited"] {
        let e = engine.call(&spec, &judge()).await.unwrap_err();
        let shown = format!("{e} {e:?} {}", serde_json::to_string(&e).unwrap());
        assert!(!shown.contains("FAKE9012"), "{shown}");
        assert_eq!(e.code(), expected);
    }
    p.test_key(&key, "gemini-3.5-flash-lite").await.unwrap();
    assert_eq!(
        p.test_key(&key, "gemini-nao-existe")
            .await
            .unwrap_err()
            .code(),
        "ai_model_not_found"
    );
    assert_eq!(
        fake.seen.lock().unwrap()[5].0,
        "/models/gemini-3.5-flash-lite"
    );
}
