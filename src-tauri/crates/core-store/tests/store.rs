use core_store::{
    AddOutcome, BookFormat, BookPatch, NewBook, OcrStatus, ReadingPosition, SCHEMA_VERSION, Store,
    StoreError, book_uid_of, book_uid_of_reader, setting_keys as keys,
};
use serde_json::json;

const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn new_book(bytes: &[u8]) -> NewBook {
    NewBook {
        book_uid: book_uid_of(bytes),
        title: "Animal Farm".into(),
        author: Some("George Orwell".into()),
        language: None,
        format: BookFormat::Pdf,
        file_name: "animal-farm.pdf".into(),
        pages: 120,
        has_text: true,
        file_hash: book_uid_of(bytes),
        local_path: Some("/books/animal-farm.pdf".into()),
    }
}

fn table_count(store: &Store) -> i64 {
    store
        .connection()
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn sha256_known_vector() {
    assert_eq!(book_uid_of(b"abc"), ABC_SHA256);
    assert_eq!(book_uid_of_reader(&b"abc"[..]).unwrap(), ABC_SHA256);
    let big = vec![7u8; 200_000];
    assert_eq!(book_uid_of_reader(&big[..]).unwrap(), book_uid_of(&big));
}

#[test]
fn migrations_are_idempotent_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/app.sqlite");
    let tables;
    {
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        tables = table_count(&store);
        assert_eq!(
            tables, 22,
            "16 tables + book_prefs (V3) + book_lemma_page and book_lemma_state (V4) + ai_queue (V5) \
             + library_sync_seen and library_sync_file (V6)"
        );
        store.add_book(&new_book(b"x")).unwrap();
        let mode: String = store
            .connection()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(table_count(&store), tables);
    assert_eq!(store.list_books().unwrap().len(), 1);
    let fk: bool = store
        .connection()
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert!(fk);
}

#[test]
fn newer_schema_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    drop(Store::open(&path).unwrap());
    rusqlite_set_version(&path, SCHEMA_VERSION + 1);
    let err = Store::open(&path).err().unwrap();
    assert!(matches!(err, StoreError::SchemaTooNew { .. }), "{err}");
    assert_eq!(err.code(), "store_schema_too_new");
}

fn rusqlite_set_version(path: &std::path::Path, v: u32) {
    let store = Store::open(path).unwrap();
    store
        .connection()
        .execute_batch(&format!("PRAGMA user_version = {v}"))
        .unwrap();
}

#[test]
fn adding_twice_keeps_one_row() {
    let mut store = Store::open_in_memory().unwrap();
    let first = store.add_book(&new_book(b"pdf")).unwrap();
    assert_eq!(first.outcome, AddOutcome::Created);
    assert_eq!(first.book.language, "en");
    assert!(first.book.downloaded);

    store
        .update_book(
            &first.book.book_uid,
            &BookPatch {
                title: Some("A Revolução dos Bichos".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let second = store.add_book(&new_book(b"pdf")).unwrap();
    assert_eq!(second.outcome, AddOutcome::Existing);
    // User edits survive a re-import of the same file.
    assert_eq!(second.book.title, "A Revolução dos Bichos");
    assert_eq!(store.list_books().unwrap().len(), 1);
    let rows: i64 = store
        .connection()
        .query_row("SELECT count(*) FROM book", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn remove_tombstones_and_readd_restores() {
    let mut store = Store::open_in_memory().unwrap();
    let uid = store.add_book(&new_book(b"pdf")).unwrap().book.book_uid;
    store
        .set_reading_position(
            &uid,
            &ReadingPosition {
                page: 3,
                ..Default::default()
            },
        )
        .unwrap();
    store
        .connection()
        .execute(
            "INSERT INTO epub_annotation (uid, book_uid, kind, cfi, updated_at) VALUES ('a1', ?1, 'highlight', 'epubcfi(/6/4)', 0)",
            [&uid],
        )
        .unwrap();

    store.remove_book(&uid).unwrap();
    store.remove_book(&uid).unwrap(); // idempotent
    assert!(store.list_books().unwrap().is_empty());
    assert!(store.get_book(&uid).unwrap().is_none());
    assert!(store.get_reading_position(&uid).unwrap().is_none());
    let (book_deleted, ann_deleted, pos_deleted): (i64, i64, i64) = store
        .connection()
        .query_row(
            "SELECT (SELECT deleted FROM book WHERE book_uid = ?1),
                    (SELECT deleted FROM epub_annotation WHERE uid = 'a1'),
                    (SELECT deleted FROM reading_position WHERE book_uid = ?1)",
            [&uid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((book_deleted, ann_deleted, pos_deleted), (1, 1, 1));
    assert!(matches!(
        store.update_book(&uid, &BookPatch::default()),
        Err(StoreError::BookNotFound(_))
    ));

    let again = store.add_book(&new_book(b"pdf")).unwrap();
    assert_eq!(again.outcome, AddOutcome::Restored);
    assert_eq!(store.list_books().unwrap().len(), 1);
}

#[test]
fn position_round_trip() {
    let mut store = Store::open_in_memory().unwrap();
    let uid = store.add_book(&new_book(b"pdf")).unwrap().book.book_uid;
    assert!(store.get_reading_position(&uid).unwrap().is_none());
    let pos = ReadingPosition {
        page: 41,
        offset: 123.5,
        cfi: None,
        progress: 0.35,
        updated_at: 0,
    };
    let saved = store.set_reading_position(&uid, &pos).unwrap();
    assert!(saved.updated_at > 0);
    assert_eq!(store.get_reading_position(&uid).unwrap(), Some(saved));

    let bad = ReadingPosition {
        progress: f64::NAN,
        ..pos.clone()
    };
    assert!(matches!(
        store.set_reading_position(&uid, &bad),
        Err(StoreError::InvalidInput(_))
    ));
    let unknown = book_uid_of(b"unknown");
    assert!(matches!(
        store.set_reading_position(&unknown, &pos),
        Err(StoreError::BookNotFound(_))
    ));
    assert!(matches!(
        store.get_reading_position("../etc"),
        Err(StoreError::InvalidBookUid(_))
    ));
}

#[test]
fn update_book_patch() {
    let mut store = Store::open_in_memory().unwrap();
    let added = store.add_book(&new_book(b"pdf")).unwrap().book;
    let patch: BookPatch = serde_json::from_value(json!({
        "author": null,
        "renderer": "pdfjs",
        "fileHash": "ignored",
        "contentDeckId": 1700000000000i64,
        "ocrStatus": "done",
    }))
    .unwrap();
    let b = store.update_book(&added.book_uid, &patch).unwrap();
    assert_eq!(b.author, None);
    assert_eq!(b.file_hash, added.file_hash, "not patchable");
    assert_eq!(b.content_deck_id, Some(1_700_000_000_000));
    assert_eq!(b.ocr_status, OcrStatus::Done);
    assert_eq!(b.title, added.title);
    assert!(b.updated_at >= added.updated_at);

    let empty_title = BookPatch {
        title: Some("  ".into()),
        ..Default::default()
    };
    assert!(matches!(
        store.update_book(&added.book_uid, &empty_title),
        Err(StoreError::InvalidInput(_))
    ));
}

#[test]
fn invalid_book_uid_is_rejected() {
    let mut store = Store::open_in_memory().unwrap();
    let mut book = new_book(b"pdf");
    book.book_uid = book.book_uid.to_uppercase();
    let err = store.add_book(&book).unwrap_err();
    assert_eq!(err.code(), "invalid_book_uid");
}

#[test]
fn settings_defaults_and_validation() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(
        store.setting(keys::VOCAB_KNOWN_IVL_DAYS).unwrap(),
        json!(21)
    );
    assert_eq!(
        store.setting_as::<u32>(keys::VOCAB_KNOWN_IVL_DAYS).unwrap(),
        21
    );
    assert_eq!(
        store.setting(keys::VOCAB_COUNT_YOUNG).unwrap(),
        json!(false)
    );
    assert_eq!(
        store.setting(keys::AI_ENRICH_PROVIDER).unwrap(),
        json!(null)
    );
    assert_eq!(store.setting(keys::AI_LIMIT_MONTH_USD).unwrap(), json!(5.0));
    assert_eq!(store.setting(keys::AI_PRICE_OVERRIDES).unwrap(), json!({}));
    assert!(
        store
            .set_setting(keys::AI_JUDGE_MAX_TOKENS, json!(4000))
            .is_err(),
        "the judge answers in at most 2000 tokens"
    );
    assert!(store.set_setting(keys::AI_CONSENT, json!([])).is_err());

    store
        .set_setting(keys::VOCAB_KNOWN_IVL_DAYS, json!(30))
        .unwrap();
    assert_eq!(
        store.setting_as::<i64>(keys::VOCAB_KNOWN_IVL_DAYS).unwrap(),
        30
    );
    store
        .set_setting(keys::VOCAB_SUSPENDED_POLICY, json!("known"))
        .unwrap();
    assert_eq!(
        store.all_settings().unwrap()["vocab_suspended_policy"],
        json!("known")
    );
    assert!(
        store.all_settings().unwrap().get("reading_theme").is_none(),
        "the old reader's settings are gone"
    );

    for (key, value) in [
        (keys::VOCAB_KNOWN_IVL_DAYS, json!(0)),
        (keys::VOCAB_KNOWN_IVL_DAYS, json!("21")),
        (keys::VOCAB_SUSPENDED_POLICY, json!("rosa")),
        (keys::VOCAB_SUSPENDED_POLICY, json!(null)),
    ] {
        let err = store.set_setting(key, value).unwrap_err();
        assert!(matches!(err, StoreError::InvalidSetting { .. }), "{err}");
    }
    assert!(matches!(
        store.setting("nope"),
        Err(StoreError::UnknownSetting(_))
    ));

    store.reset_setting(keys::VOCAB_KNOWN_IVL_DAYS).unwrap();
    assert_eq!(
        store.setting(keys::VOCAB_KNOWN_IVL_DAYS).unwrap(),
        json!(21)
    );

    // A stored value this version can't read falls back to the default.
    store
        .connection()
        .execute(
            "INSERT INTO settings (key, value) VALUES ('vocab_count_young', '\"maybe\"')",
            [],
        )
        .unwrap();
    assert_eq!(
        store.setting(keys::VOCAB_COUNT_YOUNG).unwrap(),
        json!(false)
    );
}

#[test]
fn sync_settings_defaults_and_validation() {
    let store = Store::open_in_memory().unwrap();
    for key in [
        keys::ANKI_SYNC_URL,
        keys::ANKI_SYNC_USER,
        keys::ANKI_SYNC_CA_CERT,
        keys::ANKI_SYNC_LAST_AT,
        keys::ANKI_SYNC_FIRST_DONE,
    ] {
        assert_eq!(store.setting(key).unwrap(), json!(null), "{key}");
    }
    let pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    store
        .set_setting(keys::ANKI_SYNC_CA_CERT, json!(pem))
        .unwrap();
    assert_eq!(store.setting(keys::ANKI_SYNC_CA_CERT).unwrap(), json!(pem));
    store
        .set_setting(keys::ANKI_SYNC_LAST_AT, json!(1_761_000_000_000_i64))
        .unwrap();
    assert_eq!(
        store
            .setting_as::<Option<i64>>(keys::ANKI_SYNC_LAST_AT)
            .unwrap(),
        Some(1_761_000_000_000)
    );
    store
        .set_setting(
            keys::ANKI_SYNC_FIRST_DONE,
            json!("test@http://ankisync:8080/"),
        )
        .unwrap();
    for (key, value) in [
        (keys::ANKI_SYNC_LAST_AT, json!(-1)),
        (keys::ANKI_SYNC_LAST_AT, json!("ontem")),
        (keys::ANKI_SYNC_CA_CERT, json!(42)),
        (keys::ANKI_SYNC_FIRST_DONE, json!(true)),
    ] {
        let err = store.set_setting(key, value).unwrap_err();
        assert!(matches!(err, StoreError::InvalidSetting { .. }), "{err}");
    }
    store
        .set_setting(keys::ANKI_SYNC_LAST_AT, json!(null))
        .unwrap();
    assert_eq!(store.setting(keys::ANKI_SYNC_LAST_AT).unwrap(), json!(null));
    let all = store.all_settings().unwrap();
    for key in [
        "anki_sync_ca_cert",
        "anki_sync_last_at",
        "anki_sync_first_done",
    ] {
        assert!(all.contains_key(key), "{key}");
    }
    // Secrets never live in the settings.
    assert!(
        all.keys()
            .all(|k| !k.contains("hkey") && !k.contains("password"))
    );
}

#[test]
fn schema_constraints_hold() {
    let mut store = Store::open_in_memory().unwrap();
    let uid = store.add_book(&new_book(b"pdf")).unwrap().book.book_uid;
    let conn = store.connection();
    let bad_kind = conn.execute(
        "INSERT INTO epub_annotation (uid, book_uid, kind, cfi, updated_at) VALUES ('a', ?1, 'scribble', 'epubcfi(/6/2)', 0)",
        [&uid],
    );
    assert!(bad_kind.is_err());
    let bad_json = conn.execute(
        "INSERT INTO outbox (uid, kind, payload, created_at) VALUES ('o', 'x', '{oops', 0)",
        [],
    );
    assert!(bad_json.is_err());
    let orphan = conn.execute(
        "INSERT INTO reading_session (uid, book_uid, started_at, last_heartbeat_at) VALUES ('s', ?1, 0, 0)",
        [book_uid_of(b"missing")],
    );
    assert!(orphan.is_err(), "foreign keys must be enforced");
}
