//! EPUB data (spec 7.1, 14): `epub_annotation` CRUD with tombstones and the `book_text` cache.

use core_store::{
    BookFormat, BookTextRow, EpubAnnotationKind, EpubAnnotationRow, NewBook, ReadingPosition,
    Store, StoreError, book_uid_of,
};

fn add(store: &mut Store, bytes: &[u8], format: BookFormat) -> String {
    let uid = book_uid_of(bytes);
    let ext = match format {
        BookFormat::Pdf => "pdf",
        BookFormat::Epub => "epub",
    };
    store
        .add_book(&NewBook {
            book_uid: uid.clone(),
            title: "Livro".into(),
            author: None,
            language: None,
            format,
            file_name: format!("livro.{ext}"),
            pages: 4,
            has_text: true,
            file_hash: uid.clone(),
            local_path: Some(format!("books/{uid}/v1.{ext}")),
        })
        .unwrap();
    uid
}

fn note(uid: &str, book: &str) -> EpubAnnotationRow {
    EpubAnnotationRow {
        uid: uid.into(),
        book_uid: book.into(),
        kind: EpubAnnotationKind::Highlight,
        cfi: "epubcfi(/6/4!/4/2,/1:0,/1:12)".into(),
        text: Some("The windmill".into()),
        color: Some("#fff000".into()),
        comment: None,
        updated_at: 0,
    }
}

#[test]
fn annotations_round_trip_and_tombstone() {
    let mut store = Store::open_in_memory().unwrap();
    let book = add(&mut store, b"epub-1", BookFormat::Epub);
    let a = store.upsert_epub_annotation(&note("a1", &book)).unwrap();
    assert!(a.updated_at > 0);
    let mut b = note("a2", &book);
    b.kind = EpubAnnotationKind::Bookmark;
    b.cfi = "epubcfi(/6/8!/4/2/1:0)".into();
    b.text = None;
    b.color = None;
    store.upsert_epub_annotation(&b).unwrap();
    let list = store.list_epub_annotations(&book).unwrap();
    assert_eq!(
        list.iter().map(|a| a.uid.as_str()).collect::<Vec<_>>(),
        vec!["a1", "a2"]
    );
    assert_eq!(list[0], a);

    // Update: same uid, new comment and color; updated_at goes up.
    let mut edit = note("a1", &book);
    edit.kind = EpubAnnotationKind::Note;
    edit.comment = Some("lembrar".into());
    edit.color = Some("#ff8a00".into());
    let edited = store.upsert_epub_annotation(&edit).unwrap();
    assert!(edited.updated_at > a.updated_at);
    let got = store.get_epub_annotation("a1").unwrap().unwrap();
    assert_eq!(got.kind, EpubAnnotationKind::Note);
    assert_eq!(got.comment.as_deref(), Some("lembrar"));

    // Delete: a tombstone that keeps the row for sync, bumped updated_at.
    assert!(store.delete_epub_annotation("a1").unwrap());
    assert!(!store.delete_epub_annotation("a1").unwrap());
    assert!(!store.delete_epub_annotation("nope").unwrap());
    assert!(store.get_epub_annotation("a1").unwrap().is_none());
    let (deleted, at): (i64, i64) = store
        .connection()
        .query_row(
            "SELECT deleted, updated_at FROM epub_annotation WHERE uid = 'a1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(deleted, 1);
    assert!(at > edited.updated_at);
    assert_eq!(store.list_epub_annotations(&book).unwrap().len(), 1);

    // Upserting a deleted uid brings it back.
    store.upsert_epub_annotation(&note("a1", &book)).unwrap();
    assert_eq!(store.list_epub_annotations(&book).unwrap().len(), 2);
}

#[test]
fn annotations_are_checked() {
    let mut store = Store::open_in_memory().unwrap();
    let epub = add(&mut store, b"epub-2", BookFormat::Epub);
    let pdf = add(&mut store, b"pdf-2", BookFormat::Pdf);
    let other = add(&mut store, b"epub-3", BookFormat::Epub);
    let err = |r: Result<EpubAnnotationRow, StoreError>| r.unwrap_err().code();

    assert_eq!(
        err(store.upsert_epub_annotation(&note("x", &pdf))),
        "invalid_input"
    );
    let missing = "f".repeat(64);
    assert_eq!(
        err(store.upsert_epub_annotation(&note("x", &missing))),
        "book_not_found"
    );
    assert_eq!(
        err(store.upsert_epub_annotation(&note("x", "abc"))),
        "invalid_book_uid"
    );
    let mut bad = note("x", &epub);
    bad.cfi = " ".into();
    assert_eq!(err(store.upsert_epub_annotation(&bad)), "invalid_input");
    bad = note("x", &epub);
    bad.cfi = format!("epubcfi(/6/{})", "2/".repeat(3000));
    assert_eq!(err(store.upsert_epub_annotation(&bad)), "invalid_input");
    bad = note("", &epub);
    assert_eq!(err(store.upsert_epub_annotation(&bad)), "invalid_input");
    bad = note("x", &epub);
    bad.comment = Some("a".repeat(20_001));
    assert_eq!(err(store.upsert_epub_annotation(&bad)), "invalid_input");
    bad = note("x", &epub);
    bad.color = Some(String::new());
    assert_eq!(err(store.upsert_epub_annotation(&bad)), "invalid_input");

    // A uid never moves to another book.
    store.upsert_epub_annotation(&note("x", &epub)).unwrap();
    assert_eq!(
        err(store.upsert_epub_annotation(&note("x", &other))),
        "invalid_input"
    );
}

#[test]
fn annotations_and_text_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("leitor.sqlite");
    let book;
    {
        let mut store = Store::open(&path).unwrap();
        book = add(&mut store, b"epub-4", BookFormat::Epub);
        store.upsert_epub_annotation(&note("k", &book)).unwrap();
        store
            .replace_book_text(
                &book,
                &[
                    BookTextRow {
                        unit: 0,
                        label: Some("Capa".into()),
                        text: String::new(),
                    },
                    BookTextRow {
                        unit: 1,
                        label: None,
                        text: "Chapter one text".into(),
                    },
                ],
            )
            .unwrap();
        store
            .set_reading_position(
                &book,
                &ReadingPosition {
                    page: 1,
                    cfi: Some("epubcfi(/6/4!/4/2/1:0)".into()),
                    progress: 0.4,
                    ..ReadingPosition::default()
                },
            )
            .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.list_epub_annotations(&book).unwrap()[0].uid, "k");
    let text = store.book_text(&book).unwrap();
    assert_eq!(text.len(), 2);
    assert_eq!(text[1].text, "Chapter one text");
    assert_eq!(
        store.book_text_labels(&book).unwrap(),
        vec![(0, Some("Capa".into())), (1, None)]
    );
    let pos = store.get_reading_position(&book).unwrap().unwrap();
    assert_eq!(pos.cfi.as_deref(), Some("epubcfi(/6/4!/4/2/1:0)"));
    assert_eq!(pos.page, 1);
}

#[test]
fn book_text_is_replaced_and_cleared() {
    let mut store = Store::open_in_memory().unwrap();
    let book = add(&mut store, b"epub-5", BookFormat::Epub);
    let rows = |n: u32| -> Vec<BookTextRow> {
        (0..n)
            .map(|u| BookTextRow {
                unit: u,
                label: Some(format!("Cap {u}")),
                text: format!("text {u}"),
            })
            .collect()
    };
    store.replace_book_text(&book, &rows(5)).unwrap();
    store.replace_book_text(&book, &rows(2)).unwrap();
    assert_eq!(store.book_text(&book).unwrap(), rows(2));
    store.clear_book_text(&book).unwrap();
    assert!(store.book_text(&book).unwrap().is_empty());
    assert_eq!(
        store
            .replace_book_text(&"e".repeat(64), &rows(1))
            .unwrap_err()
            .code(),
        "book_not_found"
    );
}

#[test]
fn removing_a_book_tombstones_annotations_and_hard_delete_cascades() {
    let mut store = Store::open_in_memory().unwrap();
    let book = add(&mut store, b"epub-6", BookFormat::Epub);
    store.upsert_epub_annotation(&note("r1", &book)).unwrap();
    store
        .replace_book_text(
            &book,
            &[BookTextRow {
                unit: 0,
                label: None,
                text: "t".into(),
            }],
        )
        .unwrap();
    store.remove_book(&book).unwrap();
    let deleted: i64 = store
        .connection()
        .query_row(
            "SELECT deleted FROM epub_annotation WHERE uid = 'r1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted, 1);
    assert!(store.get_epub_annotation("r1").unwrap().is_none());

    // A hard delete of the book row (never done by the app, but the FK must hold) removes everything.
    store
        .connection()
        .execute("DELETE FROM book WHERE book_uid = ?1", [&book])
        .unwrap();
    let count = |table: &str| -> i64 {
        store
            .connection()
            .query_row(
                &format!("SELECT count(*) FROM {table} WHERE book_uid = ?1"),
                [&book],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!(count("epub_annotation"), 0);
    assert_eq!(count("book_text"), 0);
}
