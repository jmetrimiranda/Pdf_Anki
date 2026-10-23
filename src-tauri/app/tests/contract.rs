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

use core_anki::anki::prelude::I18n;
use core_anki::anki::scheduler::timespan::{answer_button_time, answer_button_time_collapsible};
use core_anki::fixture::{self, FixtureOptions};
use core_anki::study::{AvTag, StudyNext};
use leitor_app::AppState;
use serde_json::Value;

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
    let state = AppState::new(data);
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
        let next = block_on(state.anki_study_next(*id)).unwrap();
        let card_id = next.card().map(|c| c.card_id);
        let v = serde_json::to_value(&next).unwrap();
        match &next {
            StudyNext::Card { .. } => {
                record(&mut out, "StudyNext.card", &v);
                let card = &v["card"];
                record(&mut out, "StudyCard", card);
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
    let done = serde_json::to_value(block_on(state.anki_study_next(empty)).unwrap()).unwrap();
    record(&mut out, "StudyNext.done", &done);
    state.anki_study_close().unwrap();
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
    let backup = serde_json::to_value(block_on(state.anki_backup_now()).unwrap()).unwrap();
    record(&mut out, "BackupInfo", &backup);
    state.shutdown();

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
