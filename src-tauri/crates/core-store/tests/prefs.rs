//! Per-book preferences of this device (spec 10.1, 10.2): defaults, patch, clear, validation, removed books.

use core_store::{BookFormat, BookPrefs, BookPrefsPatch, NewBook, Store, StoreError, book_uid_of};

fn store_with_book(title: &str) -> (Store, String) {
    let mut store = Store::open_in_memory().unwrap();
    let uid = book_uid_of(title.as_bytes());
    store
        .add_book(&NewBook {
            book_uid: uid.clone(),
            title: title.into(),
            author: None,
            language: None,
            format: BookFormat::Pdf,
            file_name: format!("{title}.pdf"),
            pages: 10,
            has_text: true,
            file_hash: uid.clone(),
            local_path: None,
        })
        .unwrap();
    (store, uid)
}

#[test]
fn defaults_when_nothing_was_saved() {
    let (store, uid) = store_with_book("Animal Farm");
    assert_eq!(store.book_prefs(&uid).unwrap(), BookPrefs::default());
}

#[test]
fn patch_updates_only_the_given_fields_and_null_clears() {
    let (mut store, uid) = store_with_book("Animal Farm");
    let prefs = store
        .set_book_prefs(
            &uid,
            &BookPrefsPatch {
                last_card_deck_id: Some(Some(10)),
                last_card_kind: Some(Some("cloze".into())),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        prefs,
        BookPrefs {
            last_card_deck_id: Some(10),
            last_card_kind: Some("cloze".into()),
            review_deck_id: None,
        }
    );
    let prefs = store
        .set_book_prefs(
            &uid,
            &BookPrefsPatch {
                review_deck_id: Some(Some(20)),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(prefs.last_card_deck_id, Some(10), "untouched");
    assert_eq!(prefs.review_deck_id, Some(20));

    let prefs = store
        .set_book_prefs(
            &uid,
            &BookPrefsPatch {
                last_card_deck_id: Some(None),
                last_card_kind: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        prefs,
        BookPrefs {
            last_card_deck_id: None,
            last_card_kind: None,
            review_deck_id: Some(20),
        }
    );
    assert_eq!(store.book_prefs(&uid).unwrap(), prefs, "persisted");

    // Every kind of the form is accepted.
    for kind in core_store::CARD_KINDS {
        let p = store
            .set_book_prefs(
                &uid,
                &BookPrefsPatch {
                    last_card_kind: Some(Some(kind.into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(p.last_card_kind.as_deref(), Some(kind));
    }
}

#[test]
fn patch_json_distinguishes_missing_from_null() {
    let patch: BookPrefsPatch =
        serde_json::from_str(r#"{"lastCardDeckId": null, "reviewDeckId": 3}"#).unwrap();
    assert_eq!(
        patch,
        BookPrefsPatch {
            last_card_deck_id: Some(None),
            last_card_kind: None,
            review_deck_id: Some(Some(3)),
        }
    );
    let json = serde_json::to_value(BookPrefs {
        last_card_deck_id: Some(1),
        last_card_kind: Some("vocab".into()),
        review_deck_id: None,
    })
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!({"lastCardDeckId": 1, "lastCardKind": "vocab", "reviewDeckId": null})
    );
}

#[test]
fn invalid_kind_is_rejected_and_nothing_changes() {
    let (mut store, uid) = store_with_book("Animal Farm");
    for kind in ["", "Basic", "essay", "code_command"] {
        let err = store
            .set_book_prefs(
                &uid,
                &BookPrefsPatch {
                    last_card_deck_id: Some(Some(1)),
                    last_card_kind: Some(Some(kind.into())),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(matches!(err, StoreError::InvalidInput(_)), "{kind}: {err}");
    }
    assert_eq!(store.book_prefs(&uid).unwrap(), BookPrefs::default());
}

#[test]
fn unknown_invalid_and_removed_books() {
    let (mut store, uid) = store_with_book("Animal Farm");
    let unknown = "f".repeat(64);
    assert!(matches!(
        store.book_prefs(&unknown),
        Err(StoreError::BookNotFound(_))
    ));
    assert!(matches!(
        store.set_book_prefs(&unknown, &BookPrefsPatch::default()),
        Err(StoreError::BookNotFound(_))
    ));
    assert!(matches!(
        store.book_prefs("not-a-uid"),
        Err(StoreError::InvalidBookUid(_))
    ));

    store
        .set_book_prefs(
            &uid,
            &BookPrefsPatch {
                review_deck_id: Some(Some(7)),
                ..Default::default()
            },
        )
        .unwrap();
    store.remove_book(&uid).unwrap();
    assert!(matches!(
        store.book_prefs(&uid),
        Err(StoreError::BookNotFound(_))
    ));
    assert!(matches!(
        store.set_book_prefs(&uid, &BookPrefsPatch::default()),
        Err(StoreError::BookNotFound(_))
    ));
    let rows: i64 = store
        .connection()
        .query_row("SELECT count(*) FROM book_prefs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0, "remove_book deletes the prefs row");
}
