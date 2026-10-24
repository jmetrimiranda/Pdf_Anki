//! The records of the library sync (docs/planos/fase-9a.md): export, apply with last write wins, the first sync,
//! orphans, and what goes out after an exchange.

use core_store::{
    BookFormat, NewBook, ReadingPosition, Store, SyncApplied, SyncRecord, SyncedFile,
    VocabOverrideStatus, book_uid_of,
};
use serde_json::json;

fn book(bytes: &[u8]) -> NewBook {
    NewBook {
        book_uid: book_uid_of(bytes),
        title: "Animal Farm".into(),
        author: None,
        language: None,
        format: BookFormat::Pdf,
        file_name: "farm.pdf".into(),
        pages: 10,
        has_text: true,
        file_hash: book_uid_of(bytes),
        local_path: Some("books/x/v1.pdf".into()),
    }
}

fn find<'a>(recs: &'a [SyncRecord], kind: &str, key: &str) -> &'a SyncRecord {
    recs.iter()
        .find(|r| r.kind == kind && r.key == key)
        .unwrap_or_else(|| panic!("{kind} {key}"))
}

fn pos(page: u32) -> ReadingPosition {
    ReadingPosition {
        page,
        offset: 0.0,
        cfi: None,
        progress: 0.5,
        updated_at: 0,
    }
}

#[test]
fn records_go_from_one_store_to_another_unchanged() {
    let mut a = Store::open_in_memory().unwrap();
    let uid = a.add_book(&book(b"farm")).unwrap().book.book_uid;
    a.set_reading_position(&uid, &pos(3)).unwrap();
    a.set_vocab_overrides(&["windmill".into()], Some(VocabOverrideStatus::Known))
        .unwrap();
    let recs = a.sync_records().unwrap();
    let kinds: Vec<&str> = recs.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(kinds, ["book", "reading_position", "vocab_override"]);
    assert_eq!(find(&recs, "book", &uid).data["fileHash"], uid.as_str());

    let mut b = Store::open_in_memory().unwrap();
    for r in &recs {
        assert_eq!(b.sync_apply(r, true).unwrap(), SyncApplied::Applied);
    }
    assert_eq!(
        b.sync_records().unwrap(),
        recs,
        "same rows, same updated_at"
    );
    let got = b.get_book(&uid).unwrap().unwrap();
    assert_eq!(
        (got.local_path, got.local_hash),
        (None, None),
        "no file yet on B"
    );
    // Everything just came from the server: nothing goes back.
    assert!(b.sync_outgoing().unwrap().is_empty());
    assert_eq!(
        a.sync_outgoing().unwrap().len(),
        3,
        "A never exchanged anything"
    );
}

#[test]
fn newer_wins_ties_go_to_the_server_and_the_first_sync_takes_the_server_for_new_keys() {
    let mut s = Store::open_in_memory().unwrap();
    let uid = s.add_book(&book(b"farm")).unwrap().book.book_uid;
    let local = s.set_reading_position(&uid, &pos(5)).unwrap();
    let remote = |page: i64, at: i64| SyncRecord {
        kind: "reading_position".into(),
        key: uid.clone(),
        updated_at: at,
        deleted: false,
        data: json!({"page": page, "offset": 0.0, "cfi": null, "progress": 0.1}),
    };
    // Older than the local row: kept, and still outgoing.
    assert_eq!(
        s.sync_apply(&remote(1, local.updated_at - 1), false)
            .unwrap(),
        SyncApplied::LocalNewer
    );
    assert_eq!(s.get_reading_position(&uid).unwrap().unwrap().page, 5);
    assert!(
        s.sync_outgoing()
            .unwrap()
            .iter()
            .any(|r| r.kind == "reading_position")
    );
    // Same time: the server's.
    assert_eq!(
        s.sync_apply(&remote(2, local.updated_at), false).unwrap(),
        SyncApplied::Applied
    );
    assert_eq!(s.get_reading_position(&uid).unwrap().unwrap().page, 2);
    // A first sync forces the server's version only for keys never exchanged: this one was, so a newer local
    // edit (e.g. made after a first sync that failed halfway) is kept.
    s.set_reading_position(&uid, &pos(7)).unwrap();
    assert_eq!(
        s.sync_apply(&remote(4, 1), true).unwrap(),
        SyncApplied::LocalNewer
    );
    assert_eq!(s.get_reading_position(&uid).unwrap().unwrap().page, 7);

    // A key never exchanged: the server's, even when older.
    let other = s.add_book(&book(b"other")).unwrap().book.book_uid;
    s.set_reading_position(&other, &pos(9)).unwrap();
    let fresh = SyncRecord {
        key: other.clone(),
        ..remote(4, 1)
    };
    assert_eq!(s.sync_apply(&fresh, true).unwrap(), SyncApplied::Applied);
    assert_eq!(s.get_reading_position(&other).unwrap().unwrap().page, 4);
    assert!(
        !s.sync_outgoing()
            .unwrap()
            .iter()
            .any(|r| r.kind == "reading_position" && r.key == other)
    );
}

#[test]
fn orphans_tombstones_files_and_state() {
    let mut s = Store::open_in_memory().unwrap();
    let ghost = "0".repeat(64);
    let r = SyncRecord {
        kind: "epub_annotation".into(),
        key: "u1".into(),
        updated_at: 5,
        deleted: false,
        data: json!({"bookUid": ghost, "kind": "highlight", "cfi": "epubcfi(/6/2!/4)", "text": "x"}),
    };
    assert_eq!(s.sync_apply(&r, false).unwrap(), SyncApplied::Orphan);
    let bad = SyncRecord {
        kind: "nope".into(),
        ..r.clone()
    };
    assert!(s.sync_apply(&bad, false).is_err());

    // A remote tombstone hides the book here.
    let uid = s.add_book(&book(b"farm")).unwrap().book.book_uid;
    let mut rec = s
        .sync_records()
        .unwrap()
        .into_iter()
        .find(|r| r.kind == "book")
        .unwrap();
    rec.deleted = true;
    rec.updated_at += 10;
    s.sync_apply(&rec, false).unwrap();
    assert!(s.list_books().unwrap().is_empty());

    s.sync_set_file(
        &uid,
        &SyncedFile {
            hash: uid.clone(),
            version: 2,
        },
    )
    .unwrap();
    assert_eq!(s.sync_file(&uid).unwrap().unwrap().version, 2);
    // Compare-and-set: only while the book is still at the expected file; the version only grows.
    s.add_book(&book(b"farm")).unwrap();
    let before = s.get_book(&uid).unwrap().unwrap();
    assert!(
        !s.sync_adopt_file(&uid, &"b".repeat(64), &"a".repeat(64), 3)
            .unwrap()
    );
    assert!(
        s.sync_adopt_file(&uid, &before.file_hash, &"a".repeat(64), 1)
            .unwrap()
    );
    let after = s.get_book(&uid).unwrap().unwrap();
    assert_eq!(after.file_hash, "a".repeat(64));
    assert!(after.file_version > before.file_version);
    assert_eq!(
        after.updated_at, before.updated_at,
        "not a change of the record"
    );
    s.sync_state_set("library.cursor", "42").unwrap();
    assert_eq!(
        s.sync_state_get("library.cursor").unwrap().as_deref(),
        Some("42")
    );
    s.sync_forget().unwrap();
    assert_eq!(s.sync_state_get("library.cursor").unwrap(), None);
    assert_eq!(s.sync_file(&uid).unwrap(), None);
}
