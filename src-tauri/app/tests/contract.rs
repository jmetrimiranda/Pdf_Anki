//! Contract snapshot (spec 15, 20): the JSON keys of the Anki values the core sends to the UI.
//!
//! The Rust side serializes real values from the fixture collection and compares the key sets with
//! `web/src/lib/core/__fixtures__/contract.json`; Vitest (`contract.test.ts`) checks the mock core
//! against the same file, so the Rust serde types, the TS types and the mock cannot drift apart.
//! `LEITOR_UPDATE_CONTRACT=1 cargo test -p leitor-estudos --test contract` rewrites the snapshot.
//!
//! `Values.*` entries are value-level samples (not key sets) of text the UI shows as is: rslib's
//! pt-BR interval labels and the formats of the browser "Due" column, so the mock cannot show
//! labels users never see.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use core_anki::anki::prelude::I18n;
use core_anki::anki::scheduler::timespan::{answer_button_time, answer_button_time_collapsible};
use core_anki::fixture::{self, FixtureOptions};
use core_anki::study::StudyOwner;
use core_anki::study::{AvTag, StudyNext};
use core_store::setting_keys as keys;
use leitor_app::secrets::MemoryStore;
use leitor_app::{
    AnkiSyncStatus, AppState, BookPanelPatch, DeepLink, FullSyncResult, StudyOwnerChange,
    SyncErrorInfo, SyncState,
};
use serde_json::Value;

mod common;

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn snapshot_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../web/src/lib/core/__fixtures__/contract.json")
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v
        .as_object()
        .unwrap_or_else(|| panic!("not an object: {v}"))
        .keys()
        .cloned()
        .collect();
    k.sort();
    k
}

/// Records `name → keys`, asserting every sample of the same name has the same keys.
fn record(out: &mut BTreeMap<String, Vec<String>>, name: &str, v: &Value) {
    let k = keys(v);
    if let Some(prev) = out.get(name) {
        assert_eq!(prev, &k, "{name} serialized with different keys");
    } else {
        out.insert(name.to_string(), k);
    }
}

/// Records a value-level sample, asserting every sample of the same name is equal.
fn record_values(out: &mut BTreeMap<String, Vec<String>>, name: &str, values: Vec<String>) {
    if let Some(prev) = out.get(name) {
        assert_eq!(prev, &values, "{name} differs between samples");
    } else {
        out.insert(name.to_string(), values);
    }
}

/// A "Due" cell reduced to its format: digit runs become `9` ("Novo #9", "9-9-9", "(9-9-9)").
fn due_format(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_digit() {
            if !out.ends_with('9') {
                out.push('9');
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Interval label samples `"<seconds>=<label>"` (and `"<seconds><<collapse>=<label>"` for the
/// collapsed learn-ahead form), rendered by rslib with the collection's pt-BR translations.
fn interval_label_samples() -> Vec<String> {
    let tr = I18n::new(&["pt-BR"]);
    const DAY: u32 = 86_400;
    let mut out: Vec<String> = [
        30,
        90,
        600,
        3 * 3600 + 720,
        DAY,
        4 * DAY,
        25 * DAY,
        37 * DAY,
        200 * DAY,
        400 * DAY,
        800 * DAY,
    ]
    .into_iter()
    .map(|s| format!("{s}={}", answer_button_time(s as f32, &tr)))
    .collect();
    for s in [60, 360, 600] {
        out.push(format!(
            "{s}<1200={}",
            answer_button_time_collapsible(s, 1200, &tr)
        ));
    }
    out
}

fn record_av(out: &mut BTreeMap<String, Vec<String>>, list: &Value) {
    for tag in list.as_array().unwrap() {
        let kind = tag["kind"].as_str().unwrap();
        record(out, &format!("AvTag.{kind}"), tag);
    }
}

#[test]
fn serde_shapes_match_the_ts_contract() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let info = fixture::build(&data.join("anki"), FixtureOptions::default()).unwrap();
    let state = AppState::with_secret_store(
        data,
        Arc::new(core_store::SystemClock),
        Arc::new(MemoryStore::default()),
    );
    let mut out = BTreeMap::new();

    // Deck tree.
    let tree = serde_json::to_value(block_on(state.anki_deck_tree()).unwrap()).unwrap();
    record(&mut out, "DeckTree", &tree);
    record(&mut out, "DeckNode", &tree["decks"][0]);
    record(&mut out, "StudiedToday", &tree["studiedToday"]);

    // Label sets of new cards ("again|hard|good").
    let mut new_buttons: BTreeSet<String> = BTreeSet::new();
    // Study: the first card of every fixture deck, its answer side and the "done" state.
    for id in info.decks.values() {
        let next = block_on(state.anki_study_next(*id, None)).unwrap();
        let card_id = next.card().map(|c| c.card_id);
        let v = serde_json::to_value(&next).unwrap();
        match &next {
            StudyNext::Card { .. } => {
                record(&mut out, "StudyNext.card", &v);
                let card = &v["card"];
                record(&mut out, "StudyCard", card);
                record_code(&mut out, card);
                record(&mut out, "QueueCounts", &card["counts"]);
                record_av(&mut out, &card["questionAv"]);
                record_av(&mut out, &card["answerAv"]);
                if !card["source"].is_null() {
                    record(&mut out, "SourceLink", &card["source"]);
                }
                if card["queue"] == "new" {
                    let buttons = card["buttons"].as_array().unwrap();
                    // Again/hard/good only: the easy interval of a new card is fuzzed (3-5 days).
                    let labels: Vec<&str> = buttons
                        .iter()
                        .take(3)
                        .map(|b| b.as_str().unwrap())
                        .collect();
                    new_buttons.insert(labels.join("|"));
                }
            }
            StudyNext::Done { .. } => record(&mut out, "StudyNext.done", &v),
        }
        if let Some(cid) = card_id {
            let typed = Some("x".to_string());
            let side = block_on(state.anki_show_answer(cid, typed)).unwrap();
            let side = serde_json::to_value(side).unwrap();
            record(&mut out, "AnswerSide", &side);
            record_av(&mut out, &side["av"]);
        }
    }
    let empty = block_on(state.anki_deck_create("Contrato vazio".into())).unwrap();
    let done = serde_json::to_value(block_on(state.anki_study_next(empty, None)).unwrap()).unwrap();
    record(&mut out, "StudyNext.done", &done);
    state.anki_study_close(None).unwrap();
    // The audio and TTS notes are not first cards of their decks: serialize tags directly.
    let tts = AvTag::Tts {
        text: "hello".into(),
        lang: "en_US".into(),
        voices: vec![],
        speed: 1.0,
    };
    record(&mut out, "AvTag.tts", &serde_json::to_value(tts).unwrap());
    let sound = AvTag::Sound {
        file: fixture::AUDIO_FILE.into(),
    };
    record(
        &mut out,
        "AvTag.sound",
        &serde_json::to_value(sound).unwrap(),
    );

    // Notetypes, browse rows and backups.
    let nts = serde_json::to_value(block_on(state.anki_notetypes()).unwrap()).unwrap();
    for nt in nts.as_array().unwrap() {
        record(&mut out, "NotetypeInfo", nt);
        for f in nt["fields"].as_array().unwrap() {
            record(&mut out, "FieldInfo", f);
        }
    }
    let ids = block_on(state.anki_search(String::new(), None)).unwrap();
    let rows = serde_json::to_value(
        block_on(state.anki_browse_rows(ids.into_iter().take(20).collect())).unwrap(),
    )
    .unwrap();
    for row in rows.as_array().unwrap() {
        record(&mut out, "BrowseRow", row);
    }
    // Formats of the "Due" column, with a suspended card for the parenthesized form.
    let mut due: BTreeSet<String> = BTreeSet::new();
    let all = block_on(state.anki_search(String::new(), None)).unwrap();
    let mut seen = Vec::new();
    for chunk in all.chunks(200) {
        seen.extend(block_on(state.anki_browse_rows(chunk.to_vec())).unwrap());
    }
    let review = seen
        .iter()
        .find(|r| !r.due.starts_with("Novo"))
        .map(|r| r.card_id)
        .expect("the fixture has a review card");
    block_on(state.anki_cards_suspend(vec![review], true)).unwrap();
    seen.extend(block_on(state.anki_browse_rows(vec![review])).unwrap());
    block_on(state.anki_cards_suspend(vec![review], false)).unwrap();
    due.extend(seen.iter().map(|r| due_format(&r.due)));
    record_values(
        &mut out,
        "Values.browseDueFormats",
        due.into_iter().collect(),
    );
    record_values(&mut out, "Values.intervalLabels", interval_label_samples());
    record_values(
        &mut out,
        "Values.newCardButtons",
        new_buttons.into_iter().collect(),
    );
    let backup_info = block_on(state.anki_backup_now()).unwrap();
    let backup = serde_json::to_value(&backup_info).unwrap();
    record(&mut out, "BackupInfo", &backup);

    // Sync: the real logged-out status and a constructed one with every optional field set
    // (all keys are always serialized, so both must agree).
    let off = state.anki_sync_status().unwrap();
    assert_eq!(off.state, SyncState::Off);
    record(
        &mut out,
        "AnkiSyncStatus",
        &serde_json::to_value(&off).unwrap(),
    );
    let error = SyncErrorInfo {
        code: "anki_sync_offline".into(),
        message: "Sem conexão com o servidor de sincronização.".into(),
    };
    let full = AnkiSyncStatus {
        state: SyncState::FullSyncRequired,
        url: Some("http://ankisync-dev:8080/".into()),
        user: Some("test".into()),
        logged_in: true,
        certificate_fingerprint: Some("AA:BB".into()),
        first_sync_pending: false,
        last_sync_at: Some(1_761_000_000_000),
        last_error: Some(error.clone()),
        full_sync: Some(core_anki::FullSyncChoice {
            upload_ok: true,
            download_ok: true,
        }),
        next_retry_at: Some(1_761_000_015_000),
        media_syncing: false,
        media_error: Some("Falha ao sincronizar a mídia.".into()),
        server_message: Some("Mensagem do servidor".into()),
    };
    let full_json = serde_json::to_value(&full).unwrap();
    record(&mut out, "AnkiSyncStatus", &full_json);
    record(&mut out, "SyncErrorInfo", &full_json["lastError"]);
    record(&mut out, "FullSyncChoice", &full_json["fullSync"]);
    let result = FullSyncResult {
        status: off,
        backup: backup_info,
    };
    let result = serde_json::to_value(&result).unwrap();
    record(&mut out, "FullSyncResult", &result);
    record(&mut out, "BackupInfo", &result["backup"]);
    record(
        &mut out,
        "SyncErrorInfo",
        &serde_json::to_value(&error).unwrap(),
    );
    // Book panel (spec 10): a library book titled like the fixture's "Livros::Animal Farm" deck, its content deck set,
    // the Fonte note of the fixture, the mini-review and "Definir palavra" with a vocabulary folder.
    let pdf = common::write(
        dir.path(),
        "Animal Farm.pdf",
        &common::text_pdf(3, "Animal Farm"),
    );
    let added = state.library_add(&pdf, false).unwrap();
    let uid = added.book.book.book_uid.clone();
    let farm = info.decks[fixture::DECK_ANIMAL_FARM];
    let patch = BookPanelPatch {
        content_deck_id: Some(Some(farm)),
        ..BookPanelPatch::default()
    };
    let panel = serde_json::to_value(block_on(state.book_panel_set(&uid, patch)).unwrap()).unwrap();
    record(&mut out, "BookPanelInfo", &panel);
    record(&mut out, "BookDeckInfo", &panel["vocabDeck"]);
    record(&mut out, "BookDeckInfo", &panel["contentDeck"]);
    record(&mut out, "QueueCounts", &panel["vocabDeck"]["counts"]);
    let cards = block_on(state.anki_book_cards(fixture::BOOK_UID.into())).unwrap();
    assert!(!cards.is_empty());
    for c in &cards {
        record(&mut out, "BookCard", &serde_json::to_value(c).unwrap());
    }
    let words = info.decks[fixture::DECK_WORDS];
    let opened = block_on(state.anki_mini_review_open(farm)).unwrap();
    let opened = serde_json::to_value(&opened).unwrap();
    record(&mut out, "MiniReviewOpened", &opened);
    let closed = serde_json::to_value(block_on(state.anki_mini_review_close()).unwrap()).unwrap();
    record(&mut out, "MiniReviewClosed", &closed);
    let change = StudyOwnerChange {
        owner: Some(StudyOwner::Panel),
        preempted: Some(StudyOwner::Tab),
    };
    record(
        &mut out,
        "StudyOwnerChange",
        &serde_json::to_value(change).unwrap(),
    );
    state
        .with_store(|s| s.set_setting(keys::VOCAB_ROOT_DECK_ID, words.into()))
        .unwrap();
    let def = block_on(state.vocab_define("windmills", Some(&uid))).unwrap();
    assert!(def.note.is_some(), "the fixture has a windmill note");
    let def = serde_json::to_value(&def).unwrap();
    record(&mut out, "WordDefinition", &def);
    record(&mut out, "WordDefinition.note", &def["note"]);
    let link = DeepLink {
        book_uid: fixture::BOOK_UID.into(),
        page: 37,
        unit: core_anki::study::SourceUnit::Page,
        cfi: None,
        query: Some("windmill".into()),
    };
    record(&mut out, "DeepLink", &serde_json::to_value(link).unwrap());
    let link = leitor_app::parse_deep_link(&format!(
        "leitor://livro/{}?cap=2&cfi=epubcfi(%2F6%2F6!%2F4%2F2%2F1%3A0)&q=pigs",
        fixture::BOOK_UID
    ))
    .unwrap();
    record(&mut out, "DeepLink", &serde_json::to_value(link).unwrap());
    code_samples(&state, &info, &mut out);
    state.shutdown();
    vocab_samples(&mut out);
    ai_samples(&mut out);

    for required in [
        "StudyNext.card",
        "StudyNext.done",
        "StudyCard",
        "AvTag.sound",
        "AvTag.tts",
        "SourceLink",
        "AnswerSide",
        "BrowseRow",
        "NotetypeInfo",
        "BackupInfo",
        "AnkiSyncStatus",
        "SyncErrorInfo",
        "FullSyncChoice",
        "FullSyncResult",
        "BookPanelInfo",
        "BookDeckInfo",
        "BookCard",
        "MiniReviewOpened",
        "MiniReviewClosed",
        "StudyOwnerChange",
        "WordDefinition",
        "WordDefinition.note",
        "DeepLink",
        "CodeCard",
        "CodeCardFields",
        "CodeMapping",
        "CodeMappingFields",
        "CodeNoteExtra",
        "CodeAcceptResult",
        "CppRunResult",
        "CppCompileResult",
        "CppRunOutput",
        "CodeStatus",
        "CppStatus",
        "LocalCppStatus",
        "RemoteCppStatus",
        "CodeSettings",
        "RunnerTestResult",
        "CodeFormatted",
        "ImportPreview",
        "ImportItem",
        "CodeImportResult",
        "VocabSettings",
        "VocabConfig",
        "VocabFolder",
        "VocabFolderRoot",
        "VocabFolderDeck",
        "VocabFolderNotetype",
        "VocabMapping",
        "VocabOutline",
        "VocabOutlineItem",
        "ResolvedRange",
        "VocabJob",
        "JobProgress",
        "JobError",
        "VocabReport",
        "VocabReportFolder",
        "VocabDeckNaming",
        "VocabMetrics",
        "VocabCurvePoint",
        "VocabChapter",
        "VocabRow",
        "VocabLemmaRef",
        "VocabPageMarks",
        "VocabMark",
        "VocabDeckResult",
        "VocabWordAdded",
        "VocabDataInfo",
        "VocabDataSource",
        "BookPanelVocab",
        "BookOpen",
        "EpubAnnotation",
        "EpubSectionMarks",
        "EpubMarkWord",
        "OcrInfo",
        "OcrStarted",
        "OcrJobInfo",
        "AiSettings",
        "AiFunctionSettings",
        "AiProviderInfo",
        "AiKeyTest",
        "AiModelPrice",
        "AiUsage",
        "AiUsageTotal",
        "AiEstimate",
        "AiJudgeResult",
        "AiCardProposal",
        "AiWordSense",
        "AiQueueInfo",
        "AiQueueItem",
    ] {
        assert!(
            out.contains_key(required),
            "the fixture produced no {required}"
        );
    }

    let actual = serde_json::to_string_pretty(&out).unwrap() + "\n";
    let path = snapshot_path();
    if std::env::var_os("LEITOR_UPDATE_CONTRACT").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run with LEITOR_UPDATE_CONTRACT=1)",
            path.display()
        )
    });
    let expected: BTreeMap<String, Vec<String>> = serde_json::from_str(&expected).unwrap();
    assert_eq!(out, expected, "Rust serde shapes differ from contract.json");
}

/// `StudyCard.code` of a code card (`null` for the others).
fn record_code(out: &mut BTreeMap<String, Vec<String>>, card: &Value) {
    let code = &card["code"];
    if !code.is_null() {
        record(out, "CodeCard", code);
        record(out, "CodeCardFields", &code["fields"]);
    }
}

/// Code cards (spec 11): the mapped user type studied as a code card, the mapping, extras,
/// "Contestar", C++ results, status/settings and the Markdown import of the spec's example.
fn code_samples(
    state: &AppState,
    info: &fixture::FixtureInfo,
    out: &mut BTreeMap<String, Vec<String>>,
) {
    use leitor_app::code::{
        CodeFormatted, CodeStatus, CppBackendEffective, CppStatus, LocalCppStatus, RemoteCppStatus,
        RunnerTestResult,
    };

    let user = info.notetypes["usuarioComando"];
    let fields = core_store::CodeMappingFields {
        question: "Frente".into(),
        answer: "Comando".into(),
        notes: Some("Explicação".into()),
    };
    let list = block_on(state.code_mapping_set(user, Some(fields))).unwrap();
    let mapping = serde_json::to_value(&list[0]).unwrap();
    record(out, "CodeMapping", &mapping);
    record(out, "CodeMappingFields", &mapping["fields"]);
    // The mapped user card, studied as a code card.
    let ros = info.decks["ROS 2 — Revisão"];
    let mut next = block_on(state.anki_study_next(ros, None)).unwrap();
    let mut mapped = false;
    for _ in 0..20 {
        let StudyNext::Card { card } = &next else {
            break;
        };
        let v = serde_json::to_value(card).unwrap();
        record(out, "StudyCard", &v);
        record_code(out, &v);
        if card.code.as_ref().is_some_and(|c| c.notetype_id == user) {
            mapped = true;
            break;
        }
        next = block_on(state.anki_answer(card.card_id, 3, 1000)).unwrap();
    }
    assert!(
        mapped,
        "the mapped user card was not studied as a code card"
    );
    state.anki_study_close(None).unwrap();

    let note = info.notes["comandoUsuario"];
    let extra = state
        .code_note_extra_set(note, vec!["ls -la".into()], vec!["sudo".into()])
        .unwrap();
    record(out, "CodeNoteExtra", &serde_json::to_value(&extra).unwrap());
    let accepted = block_on(state.code_accept_answer(note, "ls -l -a".into())).unwrap();
    record(
        out,
        "CodeAcceptResult",
        &serde_json::to_value(&accepted).unwrap(),
    );

    // C++ results are built here so the snapshot does not depend on a compiler being installed.
    let run = core_cpp::CppRunResult {
        backend: core_cpp::Backend::Local,
        compiler: Some("g++ (Debian 12.2.0-14) 12.2.0".into()),
        compile: core_cpp::CompileResult {
            ok: true,
            stderr: String::new(),
            time_ms: 420,
        },
        run: Some(core_cpp::RunResult {
            exit_code: Some(0),
            signal: None,
            stdout: "PASS quadrado(3) == 9\n".into(),
            stderr: String::new(),
            time_ms: 3,
            timed_out: false,
            truncated: false,
        }),
    };
    let run = serde_json::to_value(&run).unwrap();
    record(out, "CppRunResult", &run);
    record(out, "CppCompileResult", &run["compile"]);
    record(out, "CppRunOutput", &run["run"]);
    let status = CodeStatus {
        cpp: CppStatus {
            local: Some(LocalCppStatus {
                compiler: Some("g++ (Debian 12.2.0-14) 12.2.0".into()),
                clang_format: true,
            }),
            remote: RemoteCppStatus {
                url: Some("http://runner-proxy:8080/".into()),
                token_set: true,
            },
        },
        cpp_backend: CppBackendEffective::Local,
    };
    let status = serde_json::to_value(&status).unwrap();
    record(out, "CodeStatus", &status);
    record(out, "CppStatus", &status["cpp"]);
    record(out, "LocalCppStatus", &status["cpp"]["local"]);
    record(out, "RemoteCppStatus", &status["cpp"]["remote"]);
    let real = serde_json::to_value(state.code_status().unwrap()).unwrap();
    record(out, "CodeStatus", &real);
    record(out, "RemoteCppStatus", &real["cpp"]["remote"]);
    let settings = serde_json::to_value(state.code_settings_get().unwrap()).unwrap();
    record(out, "CodeSettings", &settings);
    let test = RunnerTestResult {
        ok: false,
        message: "Informe o endereço e o token do runner.".into(),
    };
    record(
        out,
        "RunnerTestResult",
        &serde_json::to_value(&test).unwrap(),
    );
    let real = block_on(state.code_runner_test()).unwrap();
    record(
        out,
        "RunnerTestResult",
        &serde_json::to_value(&real).unwrap(),
    );
    let formatted = CodeFormatted {
        formatted: "int main() {}\n".into(),
        formatter: Some("clang-format"),
    };
    record(
        out,
        "CodeFormatted",
        &serde_json::to_value(&formatted).unwrap(),
    );

    let example = include_str!("../../crates/core-code/tests/fixtures/import_example.md");
    let preview =
        serde_json::to_value(block_on(state.code_import_markdown(example.into())).unwrap())
            .unwrap();
    record(out, "ImportPreview", &preview);
    for item in preview["items"].as_array().unwrap() {
        record(out, "ImportItem", item);
    }
    let words = info.decks[fixture::DECK_WORDS];
    let imported = block_on(state.code_import_commit(example.into(), words, vec![0, 1])).unwrap();
    assert_eq!(imported.added, 2);
    record(
        out,
        "CodeImportResult",
        &serde_json::to_value(&imported).unwrap(),
    );
}

/// Vocabulary scanning (spec 12, 15): a book with an outline scanned against the fixture's vocabulary folder, its
/// report (a row of each group), marks, a generated deck, "Adicionar ao deck do livro", jobs and the panel summary.
fn vocab_samples(out: &mut BTreeMap<String, Vec<String>>) {
    use core_vocab::{RangeSpec, RowGroup, ScanConfig};
    use leitor_app::{JobKind, JobProgress, JobStage, VocabDeckOptions};
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let info = fixture::build(
        &data.join("anki"),
        FixtureOptions {
            vocab: true,
            ..FixtureOptions::default()
        },
    )
    .unwrap();
    let state = Arc::new(AppState::with_secret_store(
        data,
        Arc::new(core_store::SystemClock),
        Arc::new(MemoryStore::default()),
    ));
    common::use_lexicon(&state);
    let root = info.decks[fixture::DECK_VOCAB];

    let settings = state
        .vocab_settings_set(
            serde_json::from_value(serde_json::json!({ "rootDeckId": root })).unwrap(),
        )
        .unwrap();
    let settings = val(&settings);
    record(out, "VocabSettings", &settings);
    record(out, "VocabConfig", &settings["config"]);
    let folder = val(&state.vocab_folder(root).unwrap());
    record(out, "VocabFolder", &folder);
    record(out, "VocabFolderRoot", &folder["root"]);
    for d in folder["decks"].as_array().unwrap() {
        record(out, "VocabFolderDeck", d);
    }
    for n in folder["notetypes"].as_array().unwrap() {
        record(out, "VocabFolderNotetype", n);
    }
    state
        .vocab_mapping_set(info.notetypes["vocabWord"], "Word".into())
        .unwrap();
    for m in state.vocab_mapping_get().unwrap() {
        record(out, "VocabMapping", &val(&m));
    }

    let openings = [
        "It was a day.",
        "It was a cold day in the winter.",
        "The day was long.",
        "It was night again.",
        "So it was.",
        "Time went by.",
    ];
    let pages: Vec<String> = openings
        .iter()
        .map(|o| {
            format!(
                "{o} The animals of the farm work in the barn. All the learning of the pigs was quick. Then \
                 Napoleon said that a slow learner would look up the word windmill."
            )
        })
        .collect();
    let pdf = common::write(
        dir.path(),
        "farm.pdf",
        &common::book_pdf(
            &pages,
            "Animal Farm",
            &[
                common::mark("Cap 1", 0, vec![common::mark("Parte 1", 1, vec![])]),
                common::mark("Cap 2", 3, vec![]),
            ],
        ),
    );
    let uid = state.library_add(&pdf, false).unwrap().book.book.book_uid;
    let outline = val(&state.vocab_outline(&uid).unwrap());
    record(out, "VocabOutline", &outline);
    record(out, "VocabOutlineItem", &outline["items"][0]);
    record(out, "VocabOutlineItem", &outline["items"][0]["children"][0]);
    for range in [
        RangeSpec::All,
        RangeSpec::Pages {
            text: "2-3, 5".into(),
        },
        RangeSpec::Outline {
            ids: vec!["0".into()],
        },
    ] {
        record(
            out,
            "ResolvedRange",
            &val(&state.vocab_range_check(&uid, &range).unwrap()),
        );
    }
    let job = state
        .vocab_scan_start(&uid, root, vec![], RangeSpec::All, ScanConfig::default())
        .unwrap();
    record(out, "VocabJob", &val(&job));
    let end = state
        .job_wait(&job.job_id, Duration::from_secs(120))
        .unwrap();
    assert_eq!(end.stage, JobStage::Done, "{end:?}");
    record(out, "JobProgress", &val(&end));
    let failed = JobProgress {
        job_id: "j".into(),
        kind: JobKind::VocabScan,
        book_uid: uid.clone(),
        scan_uid: "s".into(),
        stage: JobStage::Failed,
        done: 0,
        total: 0,
        reused: false,
        error: Some(leitor_app::jobs::JobError {
            code: "vocab_needs_ocr".into(),
            message: "OCR".into(),
        }),
        ocr: None,
    };
    let failed = val(&failed);
    record(out, "JobProgress", &failed);
    record(out, "JobError", &failed["error"]);

    let report = state.vocab_report(&uid).unwrap().unwrap();
    let groups: BTreeSet<String> = report
        .rows
        .iter()
        .map(|r| format!("{:?}", r.group))
        .collect();
    for g in [RowGroup::Main, RowGroup::Forms, RowGroup::Proper] {
        assert!(
            groups.contains(&format!("{g:?}")),
            "no {g:?} row: {groups:?}"
        );
    }
    let json = val(&report);
    record(out, "VocabReport", &json);
    record(out, "VocabReportFolder", &json["folder"]);
    record(out, "ResolvedRange", &json["range"]);
    record(out, "VocabConfig", &json["config"]);
    record(out, "VocabDeckNaming", &json["deck"]);
    record(out, "VocabMetrics", &json["metrics"]);
    for p in json["metrics"]["curve"].as_array().unwrap() {
        record(out, "VocabCurvePoint", p);
    }
    for c in json["chapters"].as_array().unwrap() {
        record(out, "VocabChapter", c);
    }
    for r in json["rows"].as_array().unwrap() {
        record(out, "VocabRow", r);
        for k in ["base", "family"] {
            if !r[k].is_null() {
                record(out, "VocabLemmaRef", &r[k]);
            }
        }
    }
    let marks = val(&state.vocab_marks(&uid, &[0, 1]).unwrap());
    for p in marks.as_array().unwrap() {
        record(out, "VocabPageMarks", p);
        for m in p["marks"].as_array().unwrap() {
            record(out, "VocabMark", m);
        }
    }
    let deck = state
        .vocab_generate_deck(
            &uid,
            &report.scan_uid,
            vec!["learner".into(), "barn".into()],
            VocabDeckOptions::default(),
        )
        .unwrap();
    record(out, "VocabDeckResult", &val(&deck));
    if let Some(p) = state.vocab_running_job(&uid) {
        state.job_wait(&p.job_id, Duration::from_secs(120));
    }
    let added = state.vocab_add_word(&uid, "pig", 1, "pigs").unwrap();
    record(out, "VocabWordAdded", &val(&added));
    let data_info = val(&state.vocab_data_info());
    record(out, "VocabDataInfo", &data_info);
    let source = leitor_app::vocab::VocabDataSource {
        name: "Open English WordNet".into(),
        version: "2025".into(),
        license: "CC-BY-4.0".into(),
        url: Some("https://en-word.net/".into()),
    };
    record(out, "VocabDataSource", &val(&source));
    if !data_info["wordnet"].is_null() {
        record(out, "VocabDataSource", &data_info["wordnet"]);
    }
    let panel = val(&block_on(state.book_panel_info_at(&uid, Some(0))).unwrap());
    record(out, "BookPanelInfo", &panel);
    record(out, "BookPanelVocab", &panel["vocab"]);
    let def = val(&block_on(state.vocab_define("learners", Some(&uid))).unwrap());
    record(out, "WordDefinition", &def);
    if !def["family"].is_null() {
        record(out, "VocabLemmaRef", &def["family"]);
    }
    epub_ocr_samples(&state, dir.path(), root, &uid, out);
    state.shutdown();
}

/// Phase 7 (spec 7, 15): an EPUB of the library (book_open, annotations, scan marks) and the OCR shapes.
fn epub_ocr_samples(
    state: &Arc<AppState>,
    dir: &std::path::Path,
    root: i64,
    pdf_uid: &str,
    out: &mut BTreeMap<String, Vec<String>>,
) {
    use core_epub::testkit::{ChapterSpec, EpubBuilder, EpubVersion};
    use std::time::Duration;

    let text = "<p>All the learning of the pigs was quick. Then Napoleon said that a slow learner would look up \
                the word windmill.</p>";
    let bytes = EpubBuilder::new(EpubVersion::V3)
        .title("Animal Farm EPUB")
        .chapter(ChapterSpec::new("Part One", text).child(ChapterSpec::new("Chapter 1", text)))
        .chapter(ChapterSpec::new("Part Two", text))
        .build();
    let path = common::write(dir, "farm.epub", &bytes);
    let uid = state.library_add(&path, false).unwrap().book.book.book_uid;
    state
        .position_set(&uid, 1, 0.3, Some("epubcfi(/6/4!/4/2/1:0)".into()))
        .unwrap();
    let open = val(&state.book_open(&uid).unwrap());
    record(out, "BookOpen", &open);
    let pdf_open = val(&state.book_open(pdf_uid).unwrap());
    record(out, "BookOpen", &pdf_open);
    let input: leitor_app::EpubAnnotationInput = serde_json::from_value(serde_json::json!({
        "bookUid": uid, "kind": "highlight", "cfi": "epubcfi(/6/4!/4/2,/1:0,/1:7)", "text": "All the", "color": "#fff000"
    }))
    .unwrap();
    let a = val(&state.epub_annotation_upsert(input).unwrap());
    record(out, "EpubAnnotation", &a);
    for a in state.epub_annotation_list(&uid).unwrap() {
        record(out, "EpubAnnotation", &val(&a));
    }
    let job = state
        .vocab_scan_start(
            &uid,
            root,
            vec![],
            core_vocab::RangeSpec::All,
            core_vocab::ScanConfig::default(),
        )
        .unwrap();
    let end = state
        .job_wait(&job.job_id, Duration::from_secs(120))
        .unwrap();
    assert_eq!(end.stage, leitor_app::JobStage::Done, "{end:?}");
    let marks = state.vocab_epub_marks(&uid, &[0, 1, 2]).unwrap();
    for m in &marks {
        let v = val(m);
        record(out, "EpubSectionMarks", &v);
        for w in v["words"].as_array().unwrap() {
            record(out, "EpubMarkWord", w);
        }
    }

    // OCR (spec 7.2): what the library and the panel read, the start answer and the summary of a finished job.
    let scanned = common::write(dir, "scan.pdf", &common::scanned_pdf(2));
    let scanned = state
        .library_add(&scanned, false)
        .unwrap()
        .book
        .book
        .book_uid;
    let info = val(&state.ocr_info(&scanned).unwrap());
    record(out, "OcrInfo", &info);
    let started = leitor_app::ocr::OcrStarted {
        job_id: "j".into(),
        already_running: false,
    };
    record(out, "OcrStarted", &val(&started));
    let summary = leitor_app::jobs::OcrJobInfo {
        words: 120,
        pages_read: 2,
        pages_skipped: 0,
        file_version: Some(2),
        ms_per_page: Some(900),
    };
    record(out, "OcrJobInfo", &val(&summary));
}

fn val<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap()
}

/// The AI shapes (Phase 8), with a simulated Claude: no network, no real key.
fn ai_samples(out: &mut BTreeMap<String, Vec<String>>) {
    use core_ai::simulated::SimulatedProvider;
    use core_ai::{Completion, ProviderKind, Stop, Usage};
    use leitor_app::ai::{AiFunctionPatch, AiSettingsPatch};
    use leitor_app::ai_features::{AiEstimateRequest, AiJudgeRequest};

    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::with_secret_store(
        dir.path().join("data"),
        Arc::new(core_store::SystemClock),
        Arc::new(MemoryStore::default()),
    ));
    let done = |text: &str| -> core_ai::Result<Completion> {
        Ok(Completion {
            text: text.into(),
            usage: Some(Usage {
                input: 100,
                output: 50,
                ..Usage::default()
            }),
            stop: Stop::Done,
        })
    };
    state
        .ai_hub()
        .set_provider(Arc::new(SimulatedProvider::new(
            ProviderKind::Anthropic,
            vec![
                done(r#"{"veredito":"quase","explicacao":"Faltou o sudo.","nota_sugerida":2}"#),
                done(r#"{"cards":[{"tipo":"basico","campos":[{"nome":"frente","valor":"F"},{"nome":"verso","valor":"V"}],"tags":["t"]}]}"#),
                done(r#"{"itens":[{"lema":"mill","classe":"noun","definicao":"a building for grinding grain","traducao":"moinho"}]}"#),
            ],
        )));
    let on = AiFunctionPatch {
        provider: Some(Some(ProviderKind::Anthropic)),
        ..AiFunctionPatch::default()
    };
    state
        .ai_settings_set(AiSettingsPatch {
            enrich: Some(on.clone()),
            judge: Some(on),
            consent: vec![ProviderKind::Anthropic],
            ..AiSettingsPatch::default()
        })
        .unwrap();
    let settings = val(&state
        .ai_key_set(ProviderKind::Anthropic, "test-key-TEST")
        .unwrap());
    record(out, "AiSettings", &settings);
    record(out, "AiFunctionSettings", &settings["enrich"]);
    record(out, "AiFunctionSettings", &settings["judge"]);
    for p in settings["providers"].as_array().unwrap() {
        record(out, "AiProviderInfo", p);
    }
    record(
        out,
        "AiKeyTest",
        &val(&block_on(state.ai_key_test(ProviderKind::Anthropic)).unwrap()),
    );
    for p in state.ai_prices_get().unwrap() {
        record(out, "AiModelPrice", &val(&p));
    }
    let estimate = state
        .ai_estimate(AiEstimateRequest::Cards {
            text: "ROS 2 é um framework.".into(),
            kind: core_ai::prompts::CardKind::Basico,
            n: 2,
        })
        .unwrap();
    record(out, "AiEstimate", &val(&estimate));
    let judge = AiJudgeRequest {
        language: "bash".into(),
        question: "q".into(),
        answer: "a".into(),
        user_answer: "b".into(),
        auto_verdict: "almost".into(),
        ..AiJudgeRequest::default()
    };
    record(
        out,
        "AiJudgeResult",
        &val(&block_on(state.ai_judge_code(judge, false)).unwrap()),
    );
    let cards = block_on(state.ai_cards_from_text(
        "ROS 2 é um framework.".into(),
        core_ai::prompts::CardKind::Basico,
        2,
        false,
    ))
    .unwrap();
    record(out, "AiCardProposal", &val(&cards[0]));
    let sense =
        block_on(state.ai_define_word("mill".into(), None, "The mill.".into(), false)).unwrap();
    record(out, "AiWordSense", &val(&sense));
    let usage = val(&state.ai_usage().unwrap());
    record(out, "AiUsage", &usage);
    record(out, "AiUsageTotal", &usage["day"][0]);
    state
        .with_store(|s| {
            s.ai_queue_add(
                7,
                "mill",
                "n",
                "The mill.",
                r#"{"definicao":"","traducao":""}"#,
            )
        })
        .unwrap();
    let queue = val(&state.ai_queue_get().unwrap());
    record(out, "AiQueueInfo", &queue);
    record(out, "AiQueueItem", &queue["items"][0]);
}
