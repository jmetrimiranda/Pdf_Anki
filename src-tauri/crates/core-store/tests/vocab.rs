//! Vocabulary scanning in the app store (spec 12, 14): the per-page lemma table, scans, overrides, the `vocab`
//! mapping role and the vocabulary settings.

use std::time::Instant;

use core_store::{
    BookFormat, BookLemmaPageRow, BookLemmaRow, CodeMappingFields, CodeRole, NewBook, NewVocabScan,
    Store, StoreError, VocabDerivedPolicy, VocabOverrideStatus, VocabScanMetrics, VocabScanStatus,
    VocabSettings, VocabSuspendedPolicy, VocabTableState, book_uid_of, setting_keys as keys,
};
use serde_json::json;

fn store_with_book() -> (Store, String) {
    let mut store = Store::open_in_memory().unwrap();
    let uid = book_uid_of(b"vocab book");
    store
        .add_book(&NewBook {
            book_uid: uid.clone(),
            title: "Animal Farm".into(),
            author: None,
            language: None,
            format: BookFormat::Pdf,
            file_name: "farm.pdf".into(),
            pages: 300,
            has_text: true,
            file_hash: uid.clone(),
            local_path: None,
        })
        .unwrap();
    (store, uid)
}

fn page_row(lemma: &str, unit: u32, occurrences: u32) -> BookLemmaPageRow {
    BookLemmaPageRow {
        lemma: lemma.into(),
        unit,
        occurrences,
        form: lemma.into(),
        forms: json!([[lemma, occurrences]]),
        example: unit
            .is_multiple_of(2)
            .then(|| format!("An example with {lemma} on page {unit}.")),
        example_span: unit
            .is_multiple_of(2)
            .then(|| json!([11, 11 + lemma.len()])),
    }
}

fn lemma_row(lemma: &str, units: &[u32]) -> BookLemmaRow {
    BookLemmaRow {
        lemma: lemma.into(),
        pos: Some("n".into()),
        occurrences: units.len() as u32,
        first_unit: units[0],
        example: Some(format!("The {lemma}.")),
        example_span: Some(json!([4, 4 + lemma.len()])),
        units: units.to_vec(),
        is_proper: false,
        zipf: Some(3.5),
        forms: json!([lemma]),
    }
}

fn state(version: &str, pages: u32) -> VocabTableState {
    VocabTableState {
        text_version: version.into(),
        algo_version: 1,
        page_count: pages,
        built_at: 0,
        repeated_lines: vec!["animal farm #".into()],
    }
}

#[test]
fn table_replace_and_read_by_ranges() {
    let (mut store, uid) = store_with_book();
    assert_eq!(store.vocab_table_state(&uid).unwrap(), None);
    let pages = vec![
        page_row("windmill", 0, 2),
        page_row("farm", 0, 1),
        page_row("windmill", 3, 1),
        page_row("animal", 5, 4),
        page_row("farm", 9, 1),
    ];
    let lemmas = vec![
        lemma_row("windmill", &[0, 3]),
        lemma_row("farm", &[0, 9]),
        lemma_row("animal", &[5]),
    ];
    store
        .replace_vocab_table(&uid, &state("1:abc", 10), &lemmas, &pages)
        .unwrap();
    let st = store.vocab_table_state(&uid).unwrap().unwrap();
    assert_eq!(
        (st.text_version.as_str(), st.algo_version, st.page_count),
        ("1:abc", 1, 10)
    );
    assert!(st.built_at > 0);
    assert_eq!(st.repeated_lines, vec!["animal farm #".to_string()]);

    let all = store.vocab_table_pages(&uid, &[[0, u32::MAX]]).unwrap();
    assert_eq!(all.len(), 5);
    let order: Vec<(u32, &str)> = all.iter().map(|r| (r.unit, r.lemma.as_str())).collect();
    assert_eq!(
        order,
        [
            (0, "farm"),
            (0, "windmill"),
            (3, "windmill"),
            (5, "animal"),
            (9, "farm")
        ]
    );
    assert_eq!(all[1], pages[0], "round trip of every field");
    assert_eq!(all[2].example, None);

    // Inclusive, merged ranges; no duplicates; empty selects nothing.
    let some = store
        .vocab_table_pages(&uid, &[[3, 5], [4, 4], [9, 9]])
        .unwrap();
    let units: Vec<u32> = some.iter().map(|r| r.unit).collect();
    assert_eq!(units, [3, 5, 9]);
    assert!(store.vocab_table_pages(&uid, &[]).unwrap().is_empty());
    assert!(store.vocab_table_pages(&uid, &[[6, 8]]).unwrap().is_empty());

    let read = store.vocab_table_lemmas(&uid).unwrap();
    let names: Vec<&str> = read.iter().map(|l| l.lemma.as_str()).collect();
    assert_eq!(
        names,
        ["farm", "windmill", "animal"],
        "by (first unit, lemma)"
    );
    assert_eq!(read[1], lemmas[0]);

    // Replacing drops every old row.
    store
        .replace_vocab_table(
            &uid,
            &state("1:def", 10),
            &[lemma_row("pig", &[1])],
            &[page_row("pig", 1, 1)],
        )
        .unwrap();
    assert_eq!(
        store.vocab_table_state(&uid).unwrap().unwrap().text_version,
        "1:def"
    );
    let all = store.vocab_table_pages(&uid, &[[0, u32::MAX]]).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(store.vocab_table_lemmas(&uid).unwrap().len(), 1);
    let version: String = store
        .connection()
        .query_row(
            "SELECT DISTINCT text_version FROM book_lemma_page",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(version, "1:def");

    store.clear_vocab_table(&uid).unwrap();
    assert_eq!(store.vocab_table_state(&uid).unwrap(), None);
    assert!(
        store
            .vocab_table_pages(&uid, &[[0, u32::MAX]])
            .unwrap()
            .is_empty()
    );
    assert!(store.vocab_table_lemmas(&uid).unwrap().is_empty());
}

#[test]
fn table_replace_is_all_or_nothing() {
    let (mut store, uid) = store_with_book();
    store
        .replace_vocab_table(
            &uid,
            &state("v1", 2),
            &[lemma_row("farm", &[0])],
            &[page_row("farm", 0, 1)],
        )
        .unwrap();
    // A duplicate page row violates the primary key: nothing changes.
    let err = store
        .replace_vocab_table(
            &uid,
            &state("v2", 2),
            &[],
            &[page_row("pig", 1, 1), page_row("pig", 1, 2)],
        )
        .unwrap_err();
    assert_eq!(err.code(), "store_sqlite");
    assert_eq!(
        store.vocab_table_state(&uid).unwrap().unwrap().text_version,
        "v1"
    );
    assert_eq!(
        store.vocab_table_pages(&uid, &[[0, 9]]).unwrap()[0].lemma,
        "farm"
    );
    // Forms must be an array; an empty version and unknown books are refused.
    let mut bad = page_row("pig", 1, 1);
    bad.forms = json!({"pig": 1});
    assert!(matches!(
        store.replace_vocab_table(&uid, &state("v2", 2), &[], &[bad]),
        Err(StoreError::InvalidInput(_))
    ));
    assert!(matches!(
        store.replace_vocab_table(&uid, &state(" ", 2), &[], &[]),
        Err(StoreError::InvalidInput(_))
    ));
    let other = "d".repeat(64);
    assert!(matches!(
        store.replace_vocab_table(&other, &state("v", 1), &[], &[]),
        Err(StoreError::BookNotFound(_))
    ));
    assert!(matches!(
        store.vocab_table_state("nope"),
        Err(StoreError::InvalidBookUid(_))
    ));
}

/// 100k page rows (a 300-page book) are written in well under a second and a range reads back quickly.
#[test]
fn hundred_thousand_page_rows_are_fast() {
    let (mut store, uid) = store_with_book();
    let words: Vec<String> = (0..340).map(|i| format!("lemma{i:03}")).collect();
    let mut pages = Vec::with_capacity(102_000);
    for unit in 0..300u32 {
        for w in &words {
            pages.push(page_row(w, unit, 1 + unit % 3));
        }
    }
    let lemmas: Vec<BookLemmaRow> = words
        .iter()
        .map(|w| lemma_row(w, &(0..300).collect::<Vec<u32>>()))
        .collect();
    let t = Instant::now();
    store
        .replace_vocab_table(&uid, &state("v", 300), &lemmas, &pages)
        .unwrap();
    let write = t.elapsed();
    let t = Instant::now();
    let range = store.vocab_table_pages(&uid, &[[20, 44]]).unwrap();
    let read = t.elapsed();
    println!(
        "{} page rows: write {write:?}, read 25 pages {read:?}",
        pages.len()
    );
    assert_eq!(range.len(), 25 * 340);
    let limit = if cfg!(debug_assertions) { 3.0 } else { 1.0 };
    assert!(write.as_secs_f64() < limit, "{write:?}");
    assert!(read.as_secs_f64() < 0.5, "{read:?}");
}

fn new_scan(uid: &str) -> NewVocabScan {
    NewVocabScan {
        book_uid: uid.into(),
        root_deck_id: 5,
        deck_ids: vec![5, 6, 7],
        config: json!({"knownIvlDays": 21}),
        range: json!({"kind": "pages", "pages": [[20, 44]], "label": "p. 21–45"}),
    }
}

#[test]
fn scan_lifecycle_and_recovery() {
    let (mut store, uid) = store_with_book();
    assert!(store.latest_vocab_scan(&uid, false).unwrap().is_none());
    let first = store.insert_vocab_scan(&new_scan(&uid)).unwrap();
    let scanned = |store: &Store| {
        store
            .list_library()
            .unwrap()
            .iter()
            .any(|e| e.book.book_uid == uid && e.vocab_scanned)
    };
    // A running scan doesn't make the book "scanned" for the library.
    assert!(!scanned(&store));
    let row = store.vocab_scan(&first).unwrap().unwrap();
    assert_eq!(row.status, VocabScanStatus::Running);
    assert_eq!(row.deck_ids, [5, 6, 7]);
    assert_eq!(row.range["label"], "p. 21–45");
    assert_eq!(row.metrics, None);
    assert!(!row.has_report);

    let metrics = VocabScanMetrics {
        total_tokens: 12_000,
        cov_known: 0.941,
        cov_with_learning: 0.953,
        unknown_lemmas: 800,
        words_to_95: Some(40),
        words_to_98: None,
    };
    store
        .finish_vocab_scan(&first, &metrics, "1:abc", r#"{"lemmas":[]}"#)
        .unwrap();
    let done = store.vocab_scan(&first).unwrap().unwrap();
    assert_eq!(done.status, VocabScanStatus::Done);
    assert!(scanned(&store));
    assert_eq!(done.metrics, Some(metrics));
    assert_eq!(done.text_version.as_deref(), Some("1:abc"));
    assert!(done.has_report);
    assert_eq!(
        store.vocab_scan_report(&first).unwrap().as_deref(),
        Some(r#"{"lemmas":[]}"#)
    );
    // Finishing twice, or with a report that isn't JSON, is refused.
    assert!(
        store
            .finish_vocab_scan(&first, &metrics, "1:abc", "{}")
            .is_err()
    );
    let second = store.insert_vocab_scan(&new_scan(&uid)).unwrap();
    assert!(matches!(
        store.finish_vocab_scan(&second, &metrics, "1:abc", "not json"),
        Err(StoreError::InvalidInput(_))
    ));

    // Latest: any status vs. only done ones.
    assert_eq!(
        store.latest_vocab_scan(&uid, false).unwrap().unwrap().uid,
        second
    );
    assert_eq!(
        store.latest_vocab_scan(&uid, true).unwrap().unwrap().uid,
        first
    );

    assert!(
        store
            .end_vocab_scan(&second, VocabScanStatus::Cancelled, None)
            .unwrap()
    );
    assert!(
        !store
            .end_vocab_scan(&second, VocabScanStatus::Failed, Some("x"))
            .unwrap(),
        "only running scans end"
    );
    assert!(
        store
            .end_vocab_scan(&second, VocabScanStatus::Done, None)
            .is_err()
    );
    assert_eq!(
        store.vocab_scan(&second).unwrap().unwrap().status,
        VocabScanStatus::Cancelled
    );

    // Startup recovery: running scans become failed with a message.
    let third = store.insert_vocab_scan(&new_scan(&uid)).unwrap();
    assert_eq!(store.recover_vocab_scans().unwrap(), 1);
    let failed = store.vocab_scan(&third).unwrap().unwrap();
    assert_eq!(failed.status, VocabScanStatus::Failed);
    assert!(failed.error.is_some());
    assert_eq!(store.recover_vocab_scans().unwrap(), 0);

    // Unknown books, and range/config that aren't objects.
    let mut bad = new_scan(&"e".repeat(64));
    assert!(matches!(
        store.insert_vocab_scan(&bad),
        Err(StoreError::BookNotFound(_))
    ));
    bad.book_uid = uid.clone();
    bad.range = json!("all");
    assert!(matches!(
        store.insert_vocab_scan(&bad),
        Err(StoreError::InvalidInput(_))
    ));
    assert!(store.vocab_scan("missing").unwrap().is_none());
}

#[test]
fn finishing_a_scan_keeps_only_the_latest_report_of_the_book() {
    let (mut store, uid) = store_with_book();
    let other = book_uid_of(b"another book");
    store
        .add_book(&NewBook {
            book_uid: other.clone(),
            title: "Other".into(),
            author: None,
            language: None,
            format: BookFormat::Pdf,
            file_name: "other.pdf".into(),
            pages: 10,
            has_text: true,
            file_hash: other.clone(),
            local_path: None,
        })
        .unwrap();
    let metrics = VocabScanMetrics {
        total_tokens: 10,
        cov_known: 0.5,
        cov_with_learning: 0.5,
        unknown_lemmas: 5,
        words_to_95: None,
        words_to_98: None,
    };
    let elsewhere = store.insert_vocab_scan(&new_scan(&other)).unwrap();
    store
        .finish_vocab_scan(&elsewhere, &metrics, "1:x", r#"{"n":0}"#)
        .unwrap();

    let mut uids = Vec::new();
    for n in 0..3 {
        let scan = store.insert_vocab_scan(&new_scan(&uid)).unwrap();
        store
            .finish_vocab_scan(&scan, &metrics, "1:abc", &format!(r#"{{"n":{n}}}"#))
            .unwrap();
        uids.push(scan);
    }
    let failed = store.insert_vocab_scan(&new_scan(&uid)).unwrap();
    store
        .end_vocab_scan(&failed, VocabScanStatus::Failed, Some("x"))
        .unwrap();

    let reports: i64 = store
        .connection()
        .query_row(
            "SELECT count(*) FROM vocab_scan WHERE book_uid = ?1 AND report IS NOT NULL",
            [&uid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(reports, 1, "older reports of the book are dropped");
    assert_eq!(
        store.vocab_scan_report(&uids[2]).unwrap().as_deref(),
        Some(r#"{"n":2}"#)
    );
    for old in &uids[..2] {
        assert_eq!(store.vocab_scan_report(old).unwrap(), None);
        let row = store.vocab_scan(old).unwrap().unwrap();
        assert!(!row.has_report);
        assert_eq!(
            row.status,
            VocabScanStatus::Done,
            "the row and its metrics stay"
        );
        assert_eq!(row.metrics, Some(metrics));
    }
    assert_eq!(
        store.latest_vocab_scan(&uid, true).unwrap().unwrap().uid,
        uids[2]
    );
    // Other books keep theirs.
    assert_eq!(
        store.vocab_scan_report(&elsewhere).unwrap().as_deref(),
        Some(r#"{"n":0}"#)
    );
}

fn stamp(store: &Store, lemma: &str) -> (i64, i64) {
    store
        .connection()
        .query_row(
            "SELECT updated_at, deleted FROM vocab_override WHERE lemma = ?1",
            [lemma],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
}

#[test]
fn overrides_soft_delete_and_resurrect() {
    let mut store = Store::open_in_memory().unwrap();
    store
        .set_vocab_overrides(
            &[" Windmill ".into(), "boxer".into(), "".into()],
            Some(VocabOverrideStatus::Known),
        )
        .unwrap();
    store
        .set_vocab_overrides(&["napoleon".into()], Some(VocabOverrideStatus::Proper))
        .unwrap();
    assert_eq!(
        store.vocab_overrides().unwrap(),
        [
            ("boxer".to_string(), VocabOverrideStatus::Known),
            ("napoleon".to_string(), VocabOverrideStatus::Proper),
            ("windmill".to_string(), VocabOverrideStatus::Known),
        ]
    );
    let before = stamp(&store, "windmill");
    store
        .set_vocab_overrides(&["windmill".into()], None)
        .unwrap();
    let after = stamp(&store, "windmill");
    assert_eq!(after.1, 1, "tombstone");
    assert!(after.0 > before.0, "updated_at bumped");
    assert_eq!(store.vocab_overrides().unwrap().len(), 2);
    // Removing an unknown lemma does nothing; setting again resurrects.
    store.set_vocab_overrides(&["ghost".into()], None).unwrap();
    store
        .set_vocab_overrides(&["windmill".into()], Some(VocabOverrideStatus::Ignored))
        .unwrap();
    let again = stamp(&store, "windmill");
    assert_eq!(again.1, 0);
    assert!(again.0 > after.0);
    assert!(
        store
            .vocab_overrides()
            .unwrap()
            .contains(&("windmill".to_string(), VocabOverrideStatus::Ignored))
    );
}

fn code_fields() -> CodeMappingFields {
    CodeMappingFields {
        question: "Frente".into(),
        answer: "Comando".into(),
        notes: None,
    }
}

#[test]
fn vocab_and_code_mappings_are_exclusive() {
    let store = Store::open_in_memory().unwrap();
    store.set_vocab_mapping(10, " Word ").unwrap();
    store.set_vocab_mapping(11, "Front").unwrap();
    assert!(matches!(
        store.set_vocab_mapping(12, "  "),
        Err(StoreError::InvalidInput(_))
    ));
    let rows = store.vocab_mappings().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].notetype_id, rows[0].field.as_str()), (10, "Word"));
    let fields: String = store
        .connection()
        .query_row(
            "SELECT fields FROM notetype_mapping WHERE anki_notetype_id = 10",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&fields).unwrap(),
        json!({"word": "Word"})
    );
    // Re-mapping the same type to another field is fine.
    store.set_vocab_mapping(10, "Palavra").unwrap();
    assert_eq!(store.vocab_mappings().unwrap()[0].field, "Palavra");

    // A code role can't take a vocab type…
    let err = store
        .set_code_mapping(10, Some((CodeRole::Command, code_fields())))
        .unwrap_err();
    assert_eq!(err.code(), "mapping_conflict");
    assert!(
        err.to_string()
            .starts_with("Este tipo de nota já é usado como"),
        "{err}"
    );
    assert!(store.code_mappings().unwrap().is_empty());
    // …and vice versa.
    store
        .set_code_mapping(20, Some((CodeRole::Program, code_fields())))
        .unwrap();
    let err = store.set_vocab_mapping(20, "Word").unwrap_err();
    assert!(matches!(err, StoreError::MappingConflict { .. }), "{err}");
    assert!(err.to_string().contains("tipo Programa"), "{err}");
    assert_eq!(store.code_mappings().unwrap().len(), 1);

    // Once the other role is removed, the type is free.
    store.set_code_mapping(20, None).unwrap();
    store.set_vocab_mapping(20, "Word").unwrap();
    store.remove_vocab_mapping(10).unwrap();
    store
        .set_code_mapping(10, Some((CodeRole::Command, code_fields())))
        .unwrap();
    let vocab: Vec<i64> = store
        .vocab_mappings()
        .unwrap()
        .iter()
        .map(|m| m.notetype_id)
        .collect();
    assert_eq!(vocab, [11, 20]);
    // Removing a vocab mapping never removes a code one.
    store.remove_vocab_mapping(10).unwrap();
    assert_eq!(store.code_mappings().unwrap().len(), 1);
}

#[test]
fn vocab_settings_defaults_and_round_trip() {
    let mut store = Store::open_in_memory().unwrap();
    let defaults = store.vocab_settings().unwrap();
    assert_eq!(defaults, VocabSettings::default());
    assert_eq!(defaults.known_ivl_days, 21);
    assert!(!defaults.count_young);
    assert_eq!(defaults.suspended_policy, VocabSuspendedPolicy::Ignore);
    assert!(defaults.function_words_known);
    assert_eq!(defaults.derived_policy, VocabDerivedPolicy::Card);
    assert_eq!(
        store.setting(keys::VOCAB_DERIVED_POLICY).unwrap(),
        json!("card")
    );
    assert_eq!(
        store.setting(keys::VOCAB_EXCLUDED_DECK_IDS).unwrap(),
        json!([])
    );

    let custom = VocabSettings {
        root_deck_id: Some(42),
        known_ivl_days: 30,
        count_young: true,
        suspended_policy: VocabSuspendedPolicy::Known,
        function_words_known: false,
        derived_policy: VocabDerivedPolicy::Known,
        excluded_deck_ids: vec![7, 9],
    };
    store.set_vocab_settings(&custom).unwrap();
    assert_eq!(store.vocab_settings().unwrap(), custom);
    assert_eq!(
        store.setting(keys::VOCAB_DERIVED_POLICY).unwrap(),
        json!("known")
    );

    // Invalid values are refused as a whole.
    let bad = VocabSettings {
        known_ivl_days: 0,
        ..VocabSettings::default()
    };
    assert!(store.set_vocab_settings(&bad).is_err());
    assert_eq!(store.vocab_settings().unwrap(), custom);
    assert!(
        store
            .set_setting(keys::VOCAB_EXCLUDED_DECK_IDS, json!(["a"]))
            .is_err()
    );
    assert!(
        store
            .set_setting(keys::VOCAB_DERIVED_POLICY, json!("maybe"))
            .is_err()
    );
}
