//! AI settings, keys, prices and spending through the app (plan `docs/planos/fase-8.md` 4, 5.2, 6.3), with the keys
//! in an in-memory keychain and the Claude adapter aimed at a local fake server. No real call, no real key.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use core_ai::anthropic::AnthropicProvider;
use core_ai::{ProviderKind, Rates};
use core_store::AiUsageRow;
use leitor_app::AppState;
use leitor_app::ai::{AiFunctionPatch, AiSettingsPatch};
use leitor_app::secrets::MemoryStore;

const KEY: &str = "test-key-anthropic-MARK7777";

fn state(dir: &std::path::Path) -> (AppState, Arc<MemoryStore>) {
    let secrets = Arc::new(MemoryStore::default());
    let state = AppState::with_secret_store(
        dir.to_path_buf(),
        Arc::new(core_store::SystemClock),
        secrets.clone(),
    );
    (state, secrets)
}

type Seen = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// A server answering `GET /v1/models/{id}` with the scripted statuses; records path and `x-api-key`.
fn fake_server(rt: &tokio::runtime::Runtime, statuses: Vec<u16>) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let replies = Arc::new(Mutex::new(VecDeque::from(statuses)));
    let s = seen.clone();
    let app = Router::new().fallback(move |uri: Uri, headers: HeaderMap| {
        let (s, replies) = (s.clone(), replies.clone());
        async move {
            let key = headers
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            s.lock().unwrap().push((uri.path().to_owned(), key));
            let status = replies.lock().unwrap().pop_front().unwrap_or(500);
            let body = if status == 200 {
                r#"{"type":"model","id":"claude-haiku-5-5","display_name":"Claude Haiku 5.5"}"#
            } else {
                r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
            };
            (StatusCode::from_u16(status).unwrap(), body).into_response()
        }
    });
    let listener = rt
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let addr = listener.local_addr().unwrap();
    rt.spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

fn enrich(provider: Option<ProviderKind>) -> AiSettingsPatch {
    AiSettingsPatch {
        enrich: Some(AiFunctionPatch {
            provider: Some(provider),
            ..AiFunctionPatch::default()
        }),
        ..AiSettingsPatch::default()
    }
}

#[test]
fn ai_is_off_by_default_and_needs_consent_per_activation() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state(dir.path());
    let s = state.ai_settings_get().unwrap();
    assert_eq!(s.enrich.provider, None);
    assert_eq!(s.judge.provider, None);
    assert_eq!(
        (s.limit_day_usd, s.limit_month_usd, s.confirm_above_usd),
        (1.0, 5.0, 0.05)
    );
    assert_eq!(
        (s.enrich.max_output_tokens, s.judge.max_output_tokens),
        (4000, 2000)
    );
    assert!(!s.background_enrich);
    let claude = &s.providers[0];
    assert_eq!(
        (claude.id, claude.available, claude.has_key),
        (ProviderKind::Anthropic, true, false)
    );
    assert!(!s.providers[1].available, "GPT arrives in its own commit");

    // Activating without the dialog's consent is refused; with it, the default model applies.
    let e = state
        .ai_settings_set(enrich(Some(ProviderKind::Anthropic)))
        .unwrap_err();
    assert_eq!(e.code, "ai_consent_required");
    let mut patch = enrich(Some(ProviderKind::Anthropic));
    patch.consent = vec![ProviderKind::Anthropic];
    let s = state.ai_settings_set(patch).unwrap();
    assert_eq!(s.enrich.provider, Some(ProviderKind::Anthropic));
    assert_eq!(
        s.enrich.effective_model.as_deref(),
        Some("claude-haiku-5-5")
    );
    assert_eq!(s.enrich.effort, core_ai::Effort::Minimum);

    // Changing the effort or the model of an active function doesn't ask again.
    let s = state
        .ai_settings_set(AiSettingsPatch {
            enrich: Some(AiFunctionPatch {
                model: Some(Some("claude-sonnet-5-5".into())),
                effort: Some(core_ai::Effort::Low),
                ..AiFunctionPatch::default()
            }),
            limit_day_usd: Some(0.5),
            ..AiSettingsPatch::default()
        })
        .unwrap();
    assert_eq!(
        s.enrich.effective_model.as_deref(),
        Some("claude-sonnet-5-5")
    );
    assert_eq!(s.limit_day_usd, 0.5);

    // A model without a price is refused; a provider without an adapter too.
    let e = state
        .ai_settings_set(AiSettingsPatch {
            enrich: Some(AiFunctionPatch {
                model: Some(Some("claude-nao-existe".into())),
                ..AiFunctionPatch::default()
            }),
            ..AiSettingsPatch::default()
        })
        .unwrap_err();
    assert_eq!(e.code, "ai_model_unpriced");
    let mut patch = enrich(Some(ProviderKind::Openai));
    patch.consent = vec![ProviderKind::Openai];
    assert_eq!(
        state.ai_settings_set(patch).unwrap_err().code,
        "ai_provider_unavailable"
    );

    // Turning off needs no consent; turning on again asks again.
    let s = state.ai_settings_set(enrich(None)).unwrap();
    assert_eq!((s.enrich.provider, s.enrich.effective_model), (None, None));
    let e = state
        .ai_settings_set(enrich(Some(ProviderKind::Anthropic)))
        .unwrap_err();
    assert_eq!(e.code, "ai_consent_required");

    // Out-of-range values are refused by the settings table.
    let e = state
        .ai_settings_set(AiSettingsPatch {
            judge: Some(AiFunctionPatch {
                max_output_tokens: Some(4000),
                ..AiFunctionPatch::default()
            }),
            ..AiSettingsPatch::default()
        })
        .unwrap_err();
    assert_eq!(e.code, "invalid_setting");
}

#[test]
fn keys_live_in_the_keychain_and_only_their_end_is_shown() {
    let dir = tempfile::tempdir().unwrap();
    let (state, secrets) = state(dir.path());
    assert_eq!(
        state
            .ai_key_set(ProviderKind::Anthropic, "  ")
            .unwrap_err()
            .code,
        "invalid_input"
    );
    let s = state
        .ai_key_set(ProviderKind::Anthropic, &format!(" {KEY}\n"))
        .unwrap();
    assert_eq!(secrets.accounts(), vec!["ai:anthropic".to_owned()]);
    let claude = &s.providers[0];
    assert!(claude.has_key);
    assert_eq!(claude.key_suffix.as_deref(), Some("7777"));
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("MARK7777") && !json.contains(KEY), "{json}");
    // Not in the database either.
    let db = std::fs::read(state.store_path()).unwrap_or_default();
    assert!(!String::from_utf8_lossy(&db).contains("MARK"));

    let s = state.ai_key_delete(ProviderKind::Anthropic).unwrap();
    assert!(!s.providers[0].has_key);
    assert!(secrets.accounts().is_empty());
}

#[test]
fn test_key_makes_one_tokenless_call_and_none_without_a_key() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state(dir.path());
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (base, seen) = fake_server(&rt, vec![200, 401]);
    state
        .ai_hub()
        .set_provider(Arc::new(AnthropicProvider::with_base_url(&base)));

    let e = rt
        .block_on(state.ai_key_test(ProviderKind::Anthropic))
        .unwrap_err();
    assert_eq!(e.code, "ai_no_key");
    assert!(seen.lock().unwrap().is_empty(), "no key, no request");

    state.ai_key_set(ProviderKind::Anthropic, KEY).unwrap();
    let ok = rt
        .block_on(state.ai_key_test(ProviderKind::Anthropic))
        .unwrap();
    assert!(ok.ok, "{ok:?}");
    assert_eq!(ok.model, "claude-haiku-5-5");
    let bad = rt
        .block_on(state.ai_key_test(ProviderKind::Anthropic))
        .unwrap();
    assert_eq!((bad.ok, bad.code.as_deref()), (false, Some("ai_auth")));
    assert!(!bad.message.contains("MARK"));
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, "/v1/models/claude-haiku-5-5");
    assert_eq!(seen[0].1.as_deref(), Some(KEY));
}

#[test]
fn prices_can_be_edited_restored_and_added() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state(dir.path());
    let prices = state.ai_prices_get().unwrap();
    let haiku = prices
        .iter()
        .find(|p| p.model == "claude-haiku-5-5")
        .unwrap();
    assert_eq!(
        (haiku.input, haiku.output, haiku.edited),
        (0.10, 0.50, false)
    );
    assert!(haiku.has_tiers);
    assert!(
        prices.iter().any(|p| p.provider == "deepseek"),
        "the 4 providers are in the table"
    );

    let rates = Rates {
        input: 0.2,
        cached_input: None,
        cache_write: None,
        output: 1.0,
    };
    let prices = state
        .ai_prices_set(ProviderKind::Anthropic, "claude-haiku-5-5", Some(rates))
        .unwrap();
    let haiku = prices
        .iter()
        .find(|p| p.model == "claude-haiku-5-5")
        .unwrap();
    assert_eq!(
        (haiku.input, haiku.output, haiku.edited, haiku.has_tiers),
        (0.2, 1.0, true, false)
    );
    let prices = state
        .ai_prices_set(ProviderKind::Anthropic, "claude-haiku-5-5", None)
        .unwrap();
    let haiku = prices
        .iter()
        .find(|p| p.model == "claude-haiku-5-5")
        .unwrap();
    assert_eq!((haiku.input, haiku.edited), (0.10, false));

    // A new model becomes usable once it has a price.
    state
        .ai_prices_set(ProviderKind::Anthropic, "claude-novo-6", Some(rates))
        .unwrap();
    let mut patch = enrich(Some(ProviderKind::Anthropic));
    patch.consent = vec![ProviderKind::Anthropic];
    patch.enrich.as_mut().unwrap().model = Some(Some("claude-novo-6".into()));
    let s = state.ai_settings_set(patch).unwrap();
    assert_eq!(s.enrich.effective_model.as_deref(), Some("claude-novo-6"));

    let bad = Rates {
        input: -1.0,
        ..rates
    };
    assert!(
        state
            .ai_prices_set(ProviderKind::Anthropic, "x", Some(bad))
            .is_err()
    );
    assert!(
        state
            .ai_prices_set(ProviderKind::Anthropic, "a/b", Some(rates))
            .is_err()
    );
}

#[test]
fn usage_sums_today_and_this_month_per_provider() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = state(dir.path());
    let row = |at: i64, feature: &str, cost: f64| AiUsageRow {
        at,
        feature: feature.into(),
        provider: "anthropic".into(),
        model: "claude-haiku-5-5".into(),
        tokens_in: 100,
        tokens_cached_in: 0,
        tokens_cache_write: 0,
        tokens_out: 50,
        tokens_thinking: 0,
        cost_usd: cost,
        estimated: false,
        prices_checked_at: Some("2026-10-24".into()),
    };
    let now = core_store::now_ms();
    state
        .with_store(|s| {
            s.add_ai_usage(&row(now, "enrich", 0.5))?;
            s.add_ai_usage(&row(now, "judge", 0.375))?;
            // Long ago: in no period.
            s.add_ai_usage(&row(0, "judge", 3.0))
        })
        .unwrap();
    let u = state.ai_usage().unwrap();
    assert_eq!((u.day_usd, u.month_usd), (0.875, 0.875));
    assert_eq!(
        u.state,
        core_ai::BudgetState::Warning,
        "0.875 of US$ 1 is past 80%"
    );
    assert_eq!(u.day.len(), 2);
    state
        .with_store(|s| s.add_ai_usage(&row(now, "enrich", 0.125)))
        .unwrap();
    assert_eq!(
        state.ai_usage().unwrap().state,
        core_ai::BudgetState::Blocked
    );
}

/// A configured Claude (consent + key) answering from `script`.
fn configured(
    dir: &std::path::Path,
    script: Vec<core_ai::Result<core_ai::Completion>>,
) -> (Arc<AppState>, Arc<core_ai::simulated::SimulatedProvider>) {
    let (state, _) = state(dir);
    let state = Arc::new(state);
    let sim = Arc::new(core_ai::simulated::SimulatedProvider::new(
        ProviderKind::Anthropic,
        script,
    ));
    state.ai_hub().set_provider(sim.clone());
    let both = AiFunctionPatch {
        provider: Some(Some(ProviderKind::Anthropic)),
        ..AiFunctionPatch::default()
    };
    state
        .ai_settings_set(AiSettingsPatch {
            enrich: Some(both.clone()),
            judge: Some(both),
            consent: vec![ProviderKind::Anthropic],
            ..AiSettingsPatch::default()
        })
        .unwrap();
    state.ai_key_set(ProviderKind::Anthropic, KEY).unwrap();
    (state, sim)
}

fn answer(text: &str) -> core_ai::Result<core_ai::Completion> {
    Ok(core_ai::Completion {
        text: text.into(),
        usage: Some(core_ai::Usage {
            input: 400,
            output: 90,
            ..core_ai::Usage::default()
        }),
        stop: core_ai::Stop::Done,
    })
}

fn judge_request() -> leitor_app::ai_features::AiJudgeRequest {
    leitor_app::ai_features::AiJudgeRequest {
        language: "bash".into(),
        question: "Instalar o turtlesim".into(),
        answer: "sudo apt install ros-humble-turtlesim".into(),
        user_answer: "apt install ros-humble-turtlesim".into(),
        auto_verdict: "almost".into(),
        diffs: "faltou sudo".into(),
        ..Default::default()
    }
}

#[test]
fn judge_cards_and_define_with_the_simulated_provider() {
    let dir = tempfile::tempdir().unwrap();
    let (state, sim) = configured(
        dir.path(),
        vec![
            answer(r#"{"veredito":"quase","explicacao":"Faltou o sudo.","nota_sugerida":2}"#),
            answer(
                r#"{"cards":[{"tipo":"basico","campos":[{"nome":"frente","valor":"O que é ROS?"},{"nome":"verso","valor":"Um framework"},{"nome":"extra","valor":"x"}],"tags":["ros 2"]}]}"#,
            ),
            answer(
                r#"{"itens":[{"lema":"windmill","classe":"noun","definicao":"a building that uses wind power","traducao":"moinho de vento"}]}"#,
            ),
        ],
    );
    let rt = tokio::runtime::Runtime::new().unwrap();

    let judged = rt
        .block_on(state.ai_judge_code(judge_request(), false))
        .unwrap();
    assert_eq!(
        (judged.veredito.as_str(), judged.nota_sugerida),
        ("quase", 2)
    );
    let req = sim.last_request().unwrap();
    assert_eq!(
        (req.model.as_str(), req.max_output_tokens),
        ("claude-sonnet-5-5", 2000)
    );
    assert_eq!(req.effort, core_ai::Effort::Low);

    let cards = rt
        .block_on(state.ai_cards_from_text(
            "ROS 2 é um framework de robótica.".into(),
            core_ai::prompts::CardKind::Basico,
            3,
            false,
        ))
        .unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(
        cards[0].fields.keys().collect::<Vec<_>>(),
        ["frente", "verso"],
        "unknown fields dropped"
    );
    assert_eq!(cards[0].tags, ["ros_2"]);
    let e = rt
        .block_on(state.ai_cards_from_text(
            "x".into(),
            core_ai::prompts::CardKind::Cloze,
            11,
            false,
        ))
        .unwrap_err();
    assert_eq!(e.code, "invalid_input");

    let sense = rt
        .block_on(state.ai_define_word(
            "Windmill".into(),
            None,
            "The windmill was  finished.".into(),
            false,
        ))
        .unwrap();
    assert_eq!(
        (sense.translation.as_str(), sense.cached),
        ("moinho de vento", false)
    );
    assert!(
        sim.last_request()
            .unwrap()
            .user
            .contains("The windmill was finished.")
    );
    // The same word in the same sentence comes from the cache: no call.
    let again = rt
        .block_on(state.ai_define_word(
            "windmill".into(),
            None,
            "The windmill was finished.".into(),
            false,
        ))
        .unwrap();
    assert!(again.cached);
    assert_eq!(sim.calls(), 3);

    let usage = state.ai_usage().unwrap();
    let features: Vec<&str> = usage.day.iter().map(|t| t.feature.as_str()).collect();
    assert_eq!(features, ["cards", "define", "judge"]);
}

#[test]
fn caps_confirmation_and_missing_key_stop_the_call_before_it_leaves() {
    let dir = tempfile::tempdir().unwrap();
    let ok = r#"{"veredito":"quase","explicacao":"Faltou o sudo.","nota_sugerida":2}"#;
    let (state, sim) = configured(dir.path(), vec![answer(ok)]);
    let rt = tokio::runtime::Runtime::new().unwrap();

    // Above the confirmation threshold: asks; confirmed: goes.
    state
        .ai_settings_set(AiSettingsPatch {
            confirm_above_usd: Some(0.0001),
            ..AiSettingsPatch::default()
        })
        .unwrap();
    let e = rt
        .block_on(state.ai_judge_code(judge_request(), false))
        .unwrap_err();
    assert_eq!(e.code, "ai_needs_confirmation");
    assert!(e.message.contains("US$"), "{}", e.message);
    assert_eq!(sim.calls(), 0);
    rt.block_on(state.ai_judge_code(judge_request(), true))
        .unwrap();
    assert_eq!(sim.calls(), 1);

    // A cap the worst case would cross: blocked, with the spending in the message.
    state
        .ai_settings_set(AiSettingsPatch {
            limit_day_usd: Some(0.001),
            ..AiSettingsPatch::default()
        })
        .unwrap();
    let e = rt
        .block_on(state.ai_judge_code(judge_request(), true))
        .unwrap_err();
    assert_eq!(e.code, "ai_limit_reached");
    assert!(e.message.contains("hoje"), "{}", e.message);
    assert_eq!(sim.calls(), 1);

    // No key: nothing leaves.
    state.ai_key_delete(ProviderKind::Anthropic).unwrap();
    let e = rt
        .block_on(state.ai_judge_code(judge_request(), true))
        .unwrap_err();
    assert_eq!(e.code, "ai_no_key");
    assert_eq!(sim.calls(), 1);

    // AI off for the function.
    state
        .ai_settings_set(AiSettingsPatch {
            judge: Some(AiFunctionPatch {
                provider: Some(None),
                ..AiFunctionPatch::default()
            }),
            ..AiSettingsPatch::default()
        })
        .unwrap();
    let e = rt
        .block_on(state.ai_judge_code(judge_request(), true))
        .unwrap_err();
    assert_eq!(e.code, "ai_disabled");
}
