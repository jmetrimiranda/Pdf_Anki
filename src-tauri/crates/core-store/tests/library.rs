//! Library v1.1: file versions (spec 6.5), the library listing with positions (spec 6.6).

use core_store::{
    AddOutcome, BookFormat, BookPatch, NewBook, OcrStatus, ReadingPosition, Store, StoreError,
    book_uid_of,
};

fn new_book(bytes: &[u8], title: &str) -> NewBook {
    NewBook {
        book_uid: book_uid_of(bytes),
        title: title.into(),
        author: None,
        language: None,
        format: BookFormat::Pdf,
        file_name: format!("{title}.pdf"),
        pages: 10,
        has_text: true,
        file_hash: book_uid_of(bytes),
        local_path: Some(format!("/books/{title}.pdf")),
    }
}

fn set_times(store: &Store, uid: &str, added_at: i64, position_at: Option<i64>) {
    store
        .connection()
        .execute(
            "UPDATE book SET added_at = ?2 WHERE book_uid = ?1",
            rusqlite::params![uid, added_at],
        )
        .unwrap();
    if let Some(at) = position_at {
        store
            .connection()
            .execute(
                "UPDATE reading_position SET updated_at = ?2 WHERE book_uid = ?1",
                rusqlite::params![uid, at],
            )
            .unwrap();
    }
}

#[test]
fn new_books_start_at_version_one() {
    let mut store = Store::open_in_memory().unwrap();
    let added = store.add_book(&new_book(b"a", "a")).unwrap();
    assert_eq!(added.outcome, AddOutcome::Created);
    let b = added.book;
    assert_eq!(b.file_hash, b.book_uid);
    assert_eq!(b.file_version, 1);
    assert_eq!(b.local_hash.as_deref(), Some(b.book_uid.as_str()));
    assert!(b.downloaded);

    let json = serde_json::to_value(&b).unwrap();
    for key in ["fileHash", "fileVersion", "localHash", "localPath"] {
        assert!(json.get(key).is_some(), "{key} in {json}");
    }
    assert!(json.get("renderer").is_none());

    let mut bad = new_book(b"b", "b");
    bad.file_hash = "nope".into();
    assert!(matches!(
        store.add_book(&bad),
        Err(StoreError::InvalidInput(_))
    ));
}

#[test]
fn record_file_version_increments_only_on_new_hashes() {
    let mut store = Store::open_in_memory().unwrap();
    let uid = store.add_book(&new_book(b"v1", "v")).unwrap().book.book_uid;

    // Same hash: nothing changes.
    let before = store.get_book(&uid).unwrap().unwrap();
    let same = store
        .record_file_version(&uid, &uid, "/books/elsewhere.pdf")
        .unwrap();
    assert!(!same.changed);
    assert_eq!(
        (same.file_hash.as_str(), same.file_version),
        (uid.as_str(), 1)
    );
    assert_eq!(store.get_book(&uid).unwrap().unwrap(), before);

    // A new version.
    let v2 = book_uid_of(b"v2");
    let rec = store
        .record_file_version(&uid, &v2, "/books/v.2.pdf")
        .unwrap();
    assert!(rec.changed);
    assert_eq!(rec.file_version, 2);
    let b = store.get_book(&uid).unwrap().unwrap();
    assert_eq!(b.book_uid, uid, "book_uid never changes");
    assert_eq!(b.file_hash, v2);
    assert_eq!(b.file_version, 2);
    assert_eq!(b.local_path.as_deref(), Some("/books/v.2.pdf"));
    assert_eq!(b.local_hash.as_deref(), Some(v2.as_str()));
    assert!(b.updated_at >= before.updated_at);

    let v3 = book_uid_of(b"v3");
    assert_eq!(
        store
            .record_file_version(&uid, &v3, "/books/v.3.pdf")
            .unwrap()
            .file_version,
        3
    );
    // Recording the current version again is still a no-op.
    assert!(
        !store
            .record_file_version(&uid, &v3, "/x.pdf")
            .unwrap()
            .changed
    );

    for bad in ["", "ABC", &"A".repeat(64), &"g".repeat(64)] {
        assert!(
            matches!(
                store.record_file_version(&uid, bad, "/x.pdf"),
                Err(StoreError::InvalidInput(_))
            ),
            "{bad:?}"
        );
    }
    assert!(matches!(
        store.record_file_version(&book_uid_of(b"unknown"), &v2, "/x.pdf"),
        Err(StoreError::BookNotFound(_))
    ));
    store.remove_book(&uid).unwrap();
    assert!(matches!(
        store.record_file_version(&uid, &book_uid_of(b"v4"), "/x.pdf"),
        Err(StoreError::BookNotFound(_))
    ));
}

#[test]
fn reimporting_a_later_version_keeps_the_book_and_its_file() {
    let mut store = Store::open_in_memory().unwrap();
    let uid = store
        .add_book(&new_book(b"orig", "o"))
        .unwrap()
        .book
        .book_uid;
    // An exported copy with annotations carries LeitorBookUid = uid but hashes differently.
    let mut later = new_book(b"orig", "o");
    later.file_hash = book_uid_of(b"annotated copy");
    later.local_path = Some("/books/copy.pdf".into());
    let again = store.add_book(&later).unwrap();
    assert_eq!(again.outcome, AddOutcome::Existing);
    assert_eq!(again.book.file_hash, uid, "the current version is kept");
    assert_eq!(again.book.local_path.as_deref(), Some("/books/o.pdf"));

    // Without a local file, the imported one becomes this device's copy.
    store.set_book_file(&uid, None, None).unwrap();
    let b = store.get_book(&uid).unwrap().unwrap();
    assert_eq!(
        (b.local_path, b.local_hash, b.downloaded),
        (None, None, false)
    );
    let again = store.add_book(&later).unwrap();
    assert_eq!(again.book.local_path.as_deref(), Some("/books/copy.pdf"));
    assert_eq!(again.book.local_hash, Some(later.file_hash.clone()));

    // Removed (with an OCR left running) and re-added from that copy: restored with its hash as a new
    // version, and with no OCR status of the removed book (no job runs for it).
    store
        .update_book(
            &uid,
            &BookPatch {
                ocr_status: Some(OcrStatus::Running),
                ..BookPatch::default()
            },
        )
        .unwrap();
    store.remove_book(&uid).unwrap();
    let restored = store.add_book(&later).unwrap();
    assert_eq!(restored.outcome, AddOutcome::Restored);
    assert_eq!(restored.book.file_hash, later.file_hash);
    assert_eq!(restored.book.file_version, 2);
    assert_eq!(restored.book.ocr_status, OcrStatus::None);
}

#[test]
fn set_book_file_records_the_local_hash() {
    let mut store = Store::open_in_memory().unwrap();
    let uid = store.add_book(&new_book(b"f", "f")).unwrap().book.book_uid;
    let h = book_uid_of(b"other");
    store
        .set_book_file(&uid, Some("/books/f2.pdf"), Some(&h))
        .unwrap();
    let b = store.get_book(&uid).unwrap().unwrap();
    assert_eq!(b.local_path.as_deref(), Some("/books/f2.pdf"));
    assert_eq!(b.local_hash.as_deref(), Some(h.as_str()));
    assert!(b.downloaded);
    // A hash without a path is meaningless and dropped.
    store.set_book_file(&uid, None, Some(&h)).unwrap();
    assert_eq!(store.get_book(&uid).unwrap().unwrap().local_hash, None);
    assert!(matches!(
        store.set_book_file(&uid, Some("/x"), Some("bad")),
        Err(StoreError::InvalidInput(_))
    ));
}

#[test]
fn library_lists_positions_most_recent_first() {
    let mut store = Store::open_in_memory().unwrap();
    let a = store.add_book(&new_book(b"a", "a")).unwrap().book.book_uid;
    let b = store.add_book(&new_book(b"b", "b")).unwrap().book.book_uid;
    let c = store.add_book(&new_book(b"c", "c")).unwrap().book.book_uid;
    let gone = store.add_book(&new_book(b"d", "d")).unwrap().book.book_uid;
    store.remove_book(&gone).unwrap();
    store
        .set_reading_position(
            &a,
            &ReadingPosition {
                page: 4,
                progress: 0.5,
                ..Default::default()
            },
        )
        .unwrap();
    // a: added first but read last; b: added at 2000, never opened; c: added at 3000.
    set_times(&store, &a, 1000, Some(5000));
    set_times(&store, &b, 2000, None);
    set_times(&store, &c, 3000, None);

    let lib = store.list_library().unwrap();
    let order: Vec<&str> = lib.iter().map(|e| e.book.book_uid.as_str()).collect();
    assert_eq!(order, [a.as_str(), c.as_str(), b.as_str()]);
    let pos = lib[0].position.as_ref().unwrap();
    assert_eq!((pos.page, pos.progress, pos.updated_at), (4, 0.5, 5000));
    assert!(lib[1].position.is_none());

    // Flattened: the book's fields sit next to `position`.
    let json = serde_json::to_value(&lib[0]).unwrap();
    assert_eq!(json["bookUid"], serde_json::json!(a));
    assert_eq!(json["position"]["page"], serde_json::json!(4));
    assert_eq!(json["fileVersion"], serde_json::json!(1));

    // Reading c now moves it to the top.
    store
        .set_reading_position(&c, &ReadingPosition::default())
        .unwrap();
    assert_eq!(store.list_library().unwrap()[0].book.book_uid, c);
}

#[test]
fn epub_annotation_table_exists_and_pdf_tables_are_gone() {
    let mut store = Store::open_in_memory().unwrap();
    let uid = store.add_book(&new_book(b"e", "e")).unwrap().book.book_uid;
    let conn = store.connection();
    conn.execute(
        "INSERT INTO epub_annotation (uid, book_uid, kind, cfi, text, color, comment, updated_at)
         VALUES ('n', ?1, 'note', 'epubcfi(/6/4!/4/2)', 'texto', '#ffeb3b', 'nota', 1)",
        [&uid],
    )
    .unwrap();
    for table in ["annotation", "ocr_word"] {
        assert!(
            conn.execute(&format!("SELECT * FROM {table}"), []).is_err(),
            "{table} must be gone"
        );
    }
    assert!(
        conn.execute(
            "INSERT INTO epub_annotation (uid, book_uid, kind, updated_at) VALUES ('x', ?1, 'note', 1)",
            [&uid],
        )
        .is_err(),
        "cfi is required"
    );
}
