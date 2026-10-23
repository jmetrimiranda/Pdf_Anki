//! Code cards in the app store (spec 11.1, 14): notetype role mappings, per-note extra accepted
//! answers/required prefixes, and the code settings.

use core_store::{
    CODE_EXTRA_MAX_CHARS, CODE_EXTRA_MAX_ENTRIES, CodeMappingFields, CodeRole, Store, StoreError,
    setting_keys as keys,
};
use serde_json::{Value, json};

fn fields(q: &str, a: &str, n: Option<&str>) -> CodeMappingFields {
    CodeMappingFields {
        question: q.into(),
        answer: a.into(),
        notes: n.map(Into::into),
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn raw_mapping(store: &Store, id: i64) -> (String, String, i64, i64) {
    store
        .connection()
        .query_row(
            "SELECT role, fields, updated_at, deleted FROM notetype_mapping WHERE anki_notetype_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
}

#[test]
fn mapping_crud_orders_by_notetype_id() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.code_mappings().unwrap().is_empty());
    store
        .set_code_mapping(
            20,
            Some((
                CodeRole::Command,
                fields(" Frente ", "Comando", Some("Explicação")),
            )),
        )
        .unwrap();
    store
        .set_code_mapping(10, Some((CodeRole::Program, fields("Q", "A", None))))
        .unwrap();
    let rows = store.code_mappings().unwrap();
    assert_eq!(
        rows.iter().map(|r| r.notetype_id).collect::<Vec<_>>(),
        [10, 20]
    );
    assert_eq!(rows[1].role, CodeRole::Command);
    assert_eq!(
        rows[1].fields,
        fields("Frente", "Comando", Some("Explicação")),
        "field names are trimmed"
    );
    assert_eq!(rows[0].fields.notes, None);

    // Update replaces role and fields; an empty notes field means none.
    store
        .set_code_mapping(
            20,
            Some((CodeRole::Command, fields("Frente", "Verso", Some("  ")))),
        )
        .unwrap();
    let row = store
        .code_mappings()
        .unwrap()
        .into_iter()
        .find(|r| r.notetype_id == 20)
        .unwrap();
    assert_eq!(row.fields, fields("Frente", "Verso", None));
}

#[test]
fn mapping_fields_column_json_shape() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_code_mapping(
            7,
            Some((
                CodeRole::Command,
                fields("Frente", "Comando", Some("Explicação")),
            )),
        )
        .unwrap();
    let (role, json_text, _, deleted) = raw_mapping(&store, 7);
    assert_eq!(role, "code_command");
    assert_eq!(deleted, 0);
    let value: Value = serde_json::from_str(&json_text).unwrap();
    assert_eq!(
        value,
        json!({"question": "Frente", "answer": "Comando", "notes": "Explicação"})
    );
    store
        .set_code_mapping(7, Some((CodeRole::Program, fields("A", "B", None))))
        .unwrap();
    let (role, json_text, _, _) = raw_mapping(&store, 7);
    assert_eq!(role, "code_program");
    let value: Value = serde_json::from_str(&json_text).unwrap();
    assert_eq!(
        value,
        json!({"question": "A", "answer": "B", "notes": null})
    );
    // The role serializes with the column vocabulary.
    assert_eq!(json!(CodeRole::Command), json!("code_command"));
    assert_eq!(json!(CodeRole::Program), json!("code_program"));
}

#[test]
fn mapping_tombstone_and_resurrect() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_code_mapping(5, Some((CodeRole::Command, fields("F", "C", None))))
        .unwrap();
    let (_, _, first, _) = raw_mapping(&store, 5);
    store.set_code_mapping(5, None).unwrap();
    let (_, _, second, deleted) = raw_mapping(&store, 5);
    assert_eq!(deleted, 1, "removal is a tombstone");
    assert!(second > first);
    assert!(store.code_mappings().unwrap().is_empty());
    // Removing again or removing an unknown id is a no-op.
    store.set_code_mapping(5, None).unwrap();
    store.set_code_mapping(99, None).unwrap();
    assert_eq!(raw_mapping(&store, 5).2, second);

    store
        .set_code_mapping(5, Some((CodeRole::Command, fields("F", "C2", None))))
        .unwrap();
    let (_, _, third, deleted) = raw_mapping(&store, 5);
    assert_eq!(deleted, 0);
    assert!(third > second);
    assert_eq!(store.code_mappings().unwrap()[0].fields.answer, "C2");
}

#[test]
fn mapping_ignores_vocab_rows() {
    let store = Store::open_in_memory().unwrap();
    store
        .connection()
        .execute(
            "INSERT INTO notetype_mapping (anki_notetype_id, role, fields, updated_at)
             VALUES (3, 'vocab', '{}', 1)",
            [],
        )
        .unwrap();
    assert!(store.code_mappings().unwrap().is_empty());
    store.set_code_mapping(3, None).unwrap();
    assert_eq!(
        raw_mapping(&store, 3).3,
        0,
        "a vocab mapping is not removed"
    );
}

#[test]
fn mapping_validation() {
    let store = Store::open_in_memory().unwrap();
    for bad in [
        fields("", "C", None),
        fields("F", "  ", None),
        fields("F", "F", None),
        fields("F", "C", Some("C")),
    ] {
        let err = store
            .set_code_mapping(1, Some((CodeRole::Command, bad.clone())))
            .unwrap_err();
        assert!(matches!(err, StoreError::InvalidInput(_)), "{bad:?}: {err}");
    }
    assert!(store.code_mappings().unwrap().is_empty());
}

#[test]
fn role_check_constraint_holds() {
    let store = Store::open_in_memory().unwrap();
    let err = store.connection().execute(
        "INSERT INTO notetype_mapping (anki_notetype_id, role, fields, updated_at)
         VALUES (1, 'code_other', '{}', 1)",
        [],
    );
    assert!(err.is_err(), "unknown role rejected by CHECK");
    let err = store.connection().execute(
        "INSERT INTO notetype_mapping (anki_notetype_id, role, fields, updated_at)
         VALUES (1, 'code_command', 'not json', 1)",
        [],
    );
    assert!(err.is_err(), "fields must be JSON");
}

#[test]
fn mapping_updated_at_is_monotonic() {
    let store = Store::open_in_memory().unwrap();
    let mut last = 0;
    for i in 0..20 {
        let mapping = (i % 3 != 2).then(|| (CodeRole::Command, fields("F", "C", None)));
        store.set_code_mapping(1, mapping).unwrap();
        let (_, _, at, _) = raw_mapping(&store, 1);
        assert!(at > last, "write {i}: {at} > {last}");
        last = at;
    }
}

#[test]
fn extra_roundtrip_trims_dedupes_and_keeps_order() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.code_note_extra(42).unwrap(), None);
    let saved = store
        .set_code_note_extra(
            42,
            &strings(&[
                " ros2 topic list ",
                "",
                "ros2 topic list",
                "ros2 topic list -t",
                "   ",
            ]),
            &strings(&["sudo", "sudo "]),
        )
        .unwrap();
    assert_eq!(saved.accepted, ["ros2 topic list", "ros2 topic list -t"]);
    assert_eq!(saved.requires, ["sudo"]);
    assert_eq!(store.code_note_extra(42).unwrap(), Some(saved.clone()));

    // JSON columns hold plain string arrays.
    let (accepted, requires): (String, String) = store
        .connection()
        .query_row(
            "SELECT accepted, requires FROM code_note_extra WHERE note_id = 42",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&accepted).unwrap(),
        json!(["ros2 topic list", "ros2 topic list -t"])
    );
    assert_eq!(
        serde_json::from_str::<Value>(&requires).unwrap(),
        json!(["sudo"])
    );

    // camelCase for the IPC contract.
    assert_eq!(
        serde_json::to_value(&saved).unwrap(),
        json!({
            "noteId": 42,
            "accepted": ["ros2 topic list", "ros2 topic list -t"],
            "requires": ["sudo"],
            "updatedAt": saved.updated_at,
        })
    );
}

#[test]
fn extra_tombstone_and_resurrect() {
    let store = Store::open_in_memory().unwrap();
    let first = store.set_code_note_extra(1, &strings(&["a"]), &[]).unwrap();
    let cleared = store
        .set_code_note_extra(1, &strings(&[" "]), &strings(&[""]))
        .unwrap();
    assert!(cleared.accepted.is_empty() && cleared.requires.is_empty());
    assert!(cleared.updated_at > first.updated_at);
    assert_eq!(store.code_note_extra(1).unwrap(), None);
    let deleted: i64 = store
        .connection()
        .query_row(
            "SELECT deleted FROM code_note_extra WHERE note_id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted, 1);

    let back = store
        .set_code_note_extra(1, &[], &strings(&["sudo"]))
        .unwrap();
    assert!(back.updated_at > cleared.updated_at);
    assert_eq!(store.code_note_extra(1).unwrap(), Some(back));

    // Clearing a note that never had extras writes nothing.
    store.set_code_note_extra(2, &[], &[]).unwrap();
    let count: i64 = store
        .connection()
        .query_row(
            "SELECT count(*) FROM code_note_extra WHERE note_id = 2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn extra_validation() {
    let store = Store::open_in_memory().unwrap();
    let too_many: Vec<String> = (0..=CODE_EXTRA_MAX_ENTRIES)
        .map(|i| format!("cmd {i}"))
        .collect();
    assert!(matches!(
        store.set_code_note_extra(1, &too_many, &[]),
        Err(StoreError::InvalidInput(_))
    ));
    // Duplicates don't count against the limit.
    let mut at_limit: Vec<String> = too_many[..CODE_EXTRA_MAX_ENTRIES].to_vec();
    at_limit.push("cmd 0".into());
    assert_eq!(
        store
            .set_code_note_extra(1, &at_limit, &[])
            .unwrap()
            .accepted
            .len(),
        CODE_EXTRA_MAX_ENTRIES
    );
    let long = "é".repeat(CODE_EXTRA_MAX_CHARS + 1);
    assert!(matches!(
        store.set_code_note_extra(2, &[], &[long]),
        Err(StoreError::InvalidInput(_))
    ));
    let ok = "é".repeat(CODE_EXTRA_MAX_CHARS);
    store.set_code_note_extra(2, &[ok], &[]).unwrap();
}

#[test]
fn extra_corrupt_json_is_an_error_not_a_panic() {
    let store = Store::open_in_memory().unwrap();
    store
        .connection()
        .execute(
            "INSERT INTO code_note_extra (note_id, accepted, requires, updated_at)
             VALUES (9, '{\"a\":1}', '[]', 1)",
            [],
        )
        .unwrap();
    assert!(matches!(
        store.code_note_extra(9),
        Err(StoreError::Corrupt(_))
    ));
}

#[test]
fn code_settings_defaults_and_validation() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(
        store.setting(keys::CODE_SUGGEST_EASY).unwrap(),
        json!(false)
    );
    assert_eq!(
        store.setting(keys::CODE_SUGGEST_EASY_SECS).unwrap(),
        json!(10)
    );
    assert_eq!(
        store.setting(keys::CODE_OUTPUT_EXACT).unwrap(),
        json!(false)
    );
    assert_eq!(
        store.setting(keys::CODE_CPP_BACKEND).unwrap(),
        json!("auto")
    );
    assert_eq!(store.setting(keys::RUNNER_URL).unwrap(), json!(null));

    store
        .set_setting(keys::CODE_SUGGEST_EASY, json!(true))
        .unwrap();
    store
        .set_setting(keys::CODE_SUGGEST_EASY_SECS, json!(600))
        .unwrap();
    store
        .set_setting(keys::CODE_SUGGEST_EASY_SECS, json!(1))
        .unwrap();
    store
        .set_setting(keys::CODE_CPP_BACKEND, json!("remote"))
        .unwrap();
    store
        .set_setting(keys::CODE_OUTPUT_EXACT, json!(true))
        .unwrap();
    let all = store.all_settings().unwrap();
    assert_eq!(all["code_suggest_easy"], json!(true));
    assert_eq!(all["code_suggest_easy_secs"], json!(1));
    assert_eq!(all["code_cpp_backend"], json!("remote"));
    assert_eq!(all["code_output_exact"], json!(true));

    for (key, value) in [
        (keys::CODE_SUGGEST_EASY_SECS, json!(0)),
        (keys::CODE_SUGGEST_EASY_SECS, json!(601)),
        (keys::CODE_SUGGEST_EASY_SECS, json!(2.5)),
        (keys::CODE_SUGGEST_EASY_SECS, json!(null)),
        (keys::CODE_SUGGEST_EASY, json!("yes")),
        (keys::CODE_CPP_BACKEND, json!("vps")),
        (keys::CODE_OUTPUT_EXACT, json!(null)),
    ] {
        let err = store.set_setting(key, value.clone()).unwrap_err();
        assert!(
            matches!(err, StoreError::InvalidSetting { .. }),
            "{key} = {value}: {err}"
        );
    }
}
