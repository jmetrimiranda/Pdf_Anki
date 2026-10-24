//! Phase 9a acceptance (docs/planos/fase-9a.md) with two devices — PC A and PC B, each its own `AppState`, data dir
//! and keychain — against the real library server (`server/library-sync`) running in this process on 127.0.0.1.
//! No external network: runs in CI. The same flows against the compose server: `scripts/library-sync-test.sh`.

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use leitor_app::AppState;
use leitor_app::secrets::MemoryStore;
use leitor_library_sync::{AppState as Server, Config, router};

const PASSWORD: &str = "senha-de-teste-longa";

struct Net {
    rt: tokio::runtime::Runtime,
    addr: SocketAddr,
    dir: std::path::PathBuf,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Net {
    fn start(dir: &Path) -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let addr = rt.block_on(async {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap()
        });
        let mut net = Self {
            rt,
            addr,
            dir: dir.to_path_buf(),
            stop: None,
        };
        net.up();
        net
    }

    /// (Re)starts the server on the same address and data.
    fn up(&mut self) {
        let state = Server::open(Config {
            data_dir: self.dir.clone(),
            user: "leitor".into(),
            password: PASSWORD.into(),
            fail_delay: Duration::ZERO,
        })
        .unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let addr = self.addr;
        let listener = self
            .rt
            .block_on(tokio::net::TcpListener::bind(addr))
            .unwrap();
        self.rt.spawn(async move {
            axum::serve(listener, router(state))
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .unwrap();
        });
        self.stop = Some(tx);
    }

    /// The server goes away (both devices offline).
    fn down(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    /// The server comes back on the same address with an empty database (volume recreated).
    fn wipe(&mut self, dir: &Path) {
        self.down();
        self.dir = dir.to_path_buf();
        self.up();
    }

    fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

fn device(dir: &Path) -> Arc<AppState> {
    Arc::new(AppState::with_secret_store(
        dir.to_path_buf(),
        Arc::new(core_store::SystemClock),
        Arc::new(MemoryStore::default()),
    ))
}

fn block<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn connect(state: &Arc<AppState>, net: &Net, name: &str) {
    block(state.library_sync_login(&net.url(), "leitor", PASSWORD, name)).unwrap();
}

fn sync(state: &Arc<AppState>) -> leitor_app::library_sync::LibrarySyncReport {
    block(state.library_sync_run()).unwrap()
}

fn epub_bytes() -> Vec<u8> {
    use core_epub::testkit::{ChapterSpec, EpubBuilder, EpubVersion};
    EpubBuilder::new(EpubVersion::V3)
        .title("Animal Farm EPUB")
        .chapter(ChapterSpec::new(
            "Chapter 1",
            "<p>All animals are equal.</p>",
        ))
        .build()
}

fn annotation(state: &AppState, book: &str, text: &str) -> String {
    let input: leitor_app::EpubAnnotationInput = serde_json::from_value(serde_json::json!({
        "bookUid": book, "kind": "highlight", "cfi": "epubcfi(/6/2!/4/2/1:0)", "text": text, "color": "#fff000"
    }))
    .unwrap();
    state.epub_annotation_upsert(input).unwrap().uid
}

fn annotation_texts(state: &AppState, book: &str) -> Vec<String> {
    // From the database: the app's list also needs the file on this device.
    let mut t: Vec<String> = state
        .with_store(|s| s.list_epub_annotations(book))
        .unwrap()
        .into_iter()
        .filter_map(|a| a.text)
        .collect();
    t.sort();
    t
}

#[test]
fn two_pcs_exchange_everything_offline_changes_survive_and_conflicts_keep_a_copy() {
    let root = tempfile::tempdir().unwrap();
    let mut net = Net::start(&root.path().join("server"));
    let a = device(&root.path().join("a"));
    let b = device(&root.path().join("b"));

    // PC A: a PDF and an EPUB, reading, a highlight, a word marked known.
    let pdf = common::text_pdf(3, "Animal Farm");
    let pdf_path = common::write(root.path(), "farm.pdf", &pdf);
    let pdf_uid = a.library_add(&pdf_path, false).unwrap().book.book.book_uid;
    let epub_path = common::write(root.path(), "farm.epub", &epub_bytes());
    let epub_uid = a.library_add(&epub_path, false).unwrap().book.book.book_uid;
    a.position_set(&pdf_uid, 2, 0.5, None).unwrap();
    let a_note = annotation(&a, &epub_uid, "All animals");
    a.vocab_override_set(
        vec!["windmill".into()],
        Some(leitor_app::vocab::OverrideArg::Known),
    )
    .unwrap();

    connect(&a, &net, "PC A");
    let r = sync(&a);
    assert_eq!(r.uploaded, 2, "{r:?}");
    assert!(r.pushed >= 5, "{r:?}");
    assert!(r.conflicts.is_empty());

    // PC B: first sync downloads everything (the files on demand).
    connect(&b, &net, "PC B");
    let r = sync(&b);
    assert!(r.pulled >= 5, "{r:?}");
    assert_eq!(r.pushed, 0, "a first sync never sends what the server has");
    let listed = b.library_list().unwrap();
    assert_eq!(listed.len(), 2);
    let b_pdf = b.library_entry(&pdf_uid).unwrap();
    assert_eq!(b_pdf.position.as_ref().map(|p| p.page), Some(2));
    assert!(
        b_pdf.book.local_path.is_none(),
        "not downloaded yet: \"Baixar\""
    );
    assert_eq!(
        annotation_texts(&b, &epub_uid),
        vec!["All animals".to_string()]
    );
    assert!(
        b.vocab_override_list()
            .unwrap()
            .iter()
            .any(|(l, _)| l == "windmill")
    );
    block(b.library_download(&pdf_uid)).unwrap();
    assert_eq!(b.book_bytes(&pdf_uid).unwrap(), pdf);
    block(b.library_download(&epub_uid)).unwrap();

    // B reads further, highlights and removes A's highlight; A gets it all.
    std::thread::sleep(Duration::from_millis(5));
    b.position_set(&pdf_uid, 3, 0.9, None).unwrap();
    annotation(&b, &epub_uid, "are equal");
    b.epub_annotation_delete(&a_note).unwrap();
    sync(&b);
    sync(&a);
    assert_eq!(a.library_entry(&pdf_uid).unwrap().position.unwrap().page, 3);
    assert_eq!(
        annotation_texts(&a, &epub_uid),
        vec!["are equal".to_string()]
    );

    // Both offline: changes wait; nothing is lost when the server is back.
    net.down();
    std::thread::sleep(Duration::from_millis(5));
    a.vocab_override_set(
        vec!["pasture".into()],
        Some(leitor_app::vocab::OverrideArg::Known),
    )
    .unwrap();
    annotation(&b, &epub_uid, "four legs");
    let e = block(a.library_sync_run()).unwrap_err();
    assert_eq!(e.code, "library_offline");
    assert_eq!(
        block(b.library_sync_run()).unwrap_err().code,
        "library_offline"
    );
    net.up();
    sync(&a);
    sync(&b);
    sync(&a);
    for s in [&a, &b] {
        assert!(
            s.vocab_override_list()
                .unwrap()
                .iter()
                .any(|(l, _)| l == "pasture")
        );
        assert_eq!(
            annotation_texts(s, &epub_uid),
            vec!["are equal".to_string(), "four legs".to_string()]
        );
    }

    // The PDF annotated on both PCs without a sync in between: A's version goes first; B keeps its own as a
    // conflict copy, gets A's, and the copy reaches A.
    let a_v2 = common::annotated_version(&pdf, &pdf_uid);
    a.book_save_version(&pdf_uid, a_v2.clone()).unwrap();
    let b_v2 = common::annotated_version(&common::text_pdf(3, "Animal Farm (B)"), &pdf_uid);
    b.book_save_version(&pdf_uid, b_v2.clone()).unwrap();
    assert_eq!(sync(&a).uploaded, 1);
    let r = sync(&b);
    assert_eq!(r.conflicts.len(), 1, "{r:?}");
    assert!(
        r.conflicts[0].contains("cópia de conflito, PC B"),
        "{:?}",
        r.conflicts
    );
    assert!(
        b.library_entry(&pdf_uid)
            .unwrap()
            .book
            .local_hash
            .as_deref()
            != Some(core_store::book_uid_of(&a_v2).as_str())
    );
    block(b.library_download(&pdf_uid)).unwrap();
    assert_eq!(b.book_bytes(&pdf_uid).unwrap(), a_v2);
    sync(&b);
    sync(&a);
    let copy = a
        .library_list()
        .unwrap()
        .into_iter()
        .find(|e| e.book.title.contains("cópia de conflito"))
        .expect("the conflict copy reached A");
    block(a.library_download(&copy.book.book_uid)).unwrap();
    let copy_uid = copy.book.book_uid.clone();
    // The copy carries its own LeitorBookUid (not the original's): the same bytes on both PCs, and a save of the
    // copy is accepted as a version of the copy.
    let copy_bytes = a.book_bytes(&copy_uid).unwrap();
    assert_eq!(copy_bytes, b.book_bytes(&copy_uid).unwrap());
    assert_ne!(copy_bytes, b_v2);
    b.book_save_version(&copy_uid, common::annotated_version(&copy_bytes, &copy_uid))
        .unwrap();

    // B renames the book while its copy of the PDF is old, and reads further without downloading A's next
    // version: the title and the page reach A, and the book still points at A's latest file.
    let a_v3 = common::annotated_version(&a_v2, &pdf_uid);
    a.book_save_version(&pdf_uid, a_v3.clone()).unwrap();
    sync(&a);
    std::thread::sleep(Duration::from_millis(5));
    let mut patch: leitor_app::library::LibraryPatch =
        serde_json::from_value(serde_json::json!({})).unwrap();
    patch.title = Some("Animal Farm (renamed on B)".into());
    b.library_update(&pdf_uid, patch).unwrap();
    b.position_set(&pdf_uid, 1, 0.1, None).unwrap();
    sync(&b);
    sync(&a);
    let on_a = a.library_entry(&pdf_uid).unwrap();
    assert_eq!(on_a.book.title, "Animal Farm (renamed on B)");
    assert_eq!(on_a.position.unwrap().page, 1);
    assert_eq!(
        a.book_bytes(&pdf_uid).unwrap(),
        a_v3,
        "A's latest file stays the book's"
    );
    assert_eq!(on_a.book.file_hash, core_store::book_uid_of(&a_v3));
    block(b.library_download(&pdf_uid)).unwrap();
    assert_eq!(b.book_bytes(&pdf_uid).unwrap(), a_v3);

    // A deletion propagates (the book, its position and annotations).
    a.library_remove(&epub_uid).unwrap();
    sync(&a);
    sync(&b);
    assert!(
        b.library_list()
            .unwrap()
            .iter()
            .all(|e| e.book.book_uid != epub_uid)
    );
    assert!(annotation_texts(&b, &epub_uid).is_empty());
}

#[test]
fn the_first_sync_of_a_device_downloads_and_never_overwrites_the_server() {
    let root = tempfile::tempdir().unwrap();
    let net = Net::start(&root.path().join("server"));
    let a = device(&root.path().join("a"));
    let pdf = common::text_pdf(4, "Shared");
    let path = common::write(root.path(), "shared.pdf", &pdf);
    let uid = a.library_add(&path, false).unwrap().book.book.book_uid;
    a.position_set(&uid, 1, 0.25, None).unwrap();
    let v2 = common::annotated_version(&pdf, &uid);
    a.book_save_version(&uid, v2.clone()).unwrap();
    connect(&a, &net, "PC A");
    sync(&a);

    // C already has the original PDF and, later on its clock, another page.
    std::thread::sleep(Duration::from_millis(5));
    let c = device(&root.path().join("c"));
    c.library_add(&path, false).unwrap();
    c.position_set(&uid, 3, 0.75, None).unwrap();
    connect(&c, &net, "PC C");
    let r = sync(&c);
    assert_eq!(r.uploaded, 0, "the untouched original doesn't go up: {r:?}");
    assert!(r.conflicts.is_empty());
    assert_eq!(
        c.library_entry(&uid).unwrap().position.unwrap().page,
        1,
        "the server's version wins"
    );
    block(c.library_download(&uid)).unwrap();
    assert_eq!(c.book_bytes(&uid).unwrap(), v2);
    // A still sees its own position: the server was not overwritten.
    sync(&a);
    assert_eq!(a.library_entry(&uid).unwrap().position.unwrap().page, 1);

    // Logging out revokes the token on the server.
    block(c.library_sync_logout()).unwrap();
    assert_eq!(
        block(c.library_sync_run()).unwrap_err().code,
        "library_not_logged_in"
    );
}

/// A valid PDF over 100 MB: the text PDF plus an unreferenced 101 MB stream in an incremental update.
fn big_pdf() -> Vec<u8> {
    let base = common::text_pdf(2, "Big Book");
    let mut doc = pdfcraft_cos::Document::open(Arc::new(base)).unwrap();
    let filler: Vec<u8> = (0..101 * 1024 * 1024)
        .map(|i: usize| (i % 251) as u8)
        .collect();
    doc.add(pdfcraft_cos::Stream::from_raw(
        pdfcraft_cos::Dict::new(),
        filler,
    ));
    pdfcraft_cos::write_incremental(&doc, &Default::default()).unwrap()
}

/// The same exchange against the library server of compose.dev.yml (`scripts/library-sync-test.sh`, outside CI):
/// a book over 100 MB goes up in parts and comes down on the other PC; a conflict keeps a copy. Skipped unless
/// `LEITOR_LIBRARY_TEST_URL` names that server.
#[test]
fn external_server_two_pcs_and_a_book_over_100_mb() {
    let Ok(url) = std::env::var("LEITOR_LIBRARY_TEST_URL") else {
        eprintln!("skipped: LEITOR_LIBRARY_TEST_URL is not set (scripts/library-sync-test.sh)");
        return;
    };
    let password =
        std::env::var("LEITOR_LIBRARY_TEST_PASSWORD").unwrap_or_else(|_| PASSWORD.into());
    let root = tempfile::tempdir().unwrap();
    let a = device(&root.path().join("a"));
    let b = device(&root.path().join("b"));
    for (s, name) in [(&a, "PC A"), (&b, "PC B")] {
        block(s.library_sync_login(&url, "leitor", &password, name)).unwrap();
    }
    let big = big_pdf();
    assert!(big.len() > 100 * 1024 * 1024);
    let path = common::write(root.path(), "big.pdf", &big);
    let uid = a.library_add(&path, false).unwrap().book.book.book_uid;
    a.position_set(&uid, 1, 0.5, None).unwrap();
    assert_eq!(sync(&a).uploaded, 1);
    sync(&b);
    assert_eq!(b.library_entry(&uid).unwrap().position.unwrap().page, 1);
    block(b.library_download(&uid)).unwrap();
    assert_eq!(b.book_bytes(&uid).unwrap(), big);

    let small = common::text_pdf(2, "Conflict");
    let small_path = common::write(root.path(), "small.pdf", &small);
    let sid = a
        .library_add(&small_path, false)
        .unwrap()
        .book
        .book
        .book_uid;
    sync(&a);
    sync(&b);
    block(b.library_download(&sid)).unwrap();
    a.book_save_version(&sid, common::annotated_version(&small, &sid))
        .unwrap();
    b.book_save_version(
        &sid,
        common::annotated_version(&common::text_pdf(2, "Conflict B"), &sid),
    )
    .unwrap();
    sync(&a);
    assert_eq!(sync(&b).conflicts.len(), 1);
}

#[test]
fn an_outdated_tab_saves_into_a_conflict_copy_and_a_recreated_server_gets_everything_again() {
    let root = tempfile::tempdir().unwrap();
    let mut net = Net::start(&root.path().join("server"));
    let a = device(&root.path().join("a"));
    let b = device(&root.path().join("b"));
    let pdf = common::text_pdf(3, "Tabs");
    let path = common::write(root.path(), "tabs.pdf", &pdf);
    let uid = a.library_add(&path, false).unwrap().book.book.book_uid;
    connect(&a, &net, "PC A");
    connect(&b, &net, "PC B");
    sync(&a);
    sync(&b);
    block(b.library_download(&uid)).unwrap();
    // B's tab is open on its version 1.
    let tab_base = b.library_entry(&uid).unwrap().book.file_version;

    // A saves a new version; B adopts it (its copy is now outdated).
    let a_v2 = common::annotated_version(&pdf, &uid);
    a.book_save_version(&uid, a_v2.clone()).unwrap();
    sync(&a);
    sync(&b);
    let b_book = b.library_entry(&uid).unwrap().book;
    assert_eq!(b_book.file_hash, core_store::book_uid_of(&a_v2));
    assert!(b_book.file_version > tab_base);

    // The old tab saves: not over A's version — into a conflict copy; the next save goes to the same copy.
    let edit = common::annotated_version(&common::text_pdf(3, "Tabs edited on B"), &uid);
    let saved = b
        .book_save_version_from(&uid, edit.clone(), Some(tab_base))
        .unwrap();
    assert!(saved.kept_newer);
    assert_eq!(
        b.library_entry(&uid).unwrap().book.file_hash,
        core_store::book_uid_of(&a_v2)
    );
    let copies = || {
        b.library_list()
            .unwrap()
            .into_iter()
            .filter(|e| e.book.title.contains("cópia de conflito"))
            .collect::<Vec<_>>()
    };
    assert_eq!(copies().len(), 1);
    let first_version = copies()[0].book.file_version;
    b.book_save_version_from(&uid, common::annotated_version(&edit, &uid), Some(tab_base))
        .unwrap();
    assert_eq!(copies().len(), 1, "one copy per tab");
    assert!(copies()[0].book.file_version > first_version);
    sync(&b);
    sync(&a);
    block(a.library_download(&uid)).unwrap();
    assert_eq!(
        a.book_bytes(&uid).unwrap(),
        a_v2,
        "A's version stays the book's"
    );
    assert!(
        a.library_list()
            .unwrap()
            .iter()
            .any(|e| e.book.title.contains("cópia de conflito"))
    );

    // The server's volume is recreated: A sends its library again; a new PC gets it.
    net.wipe(&root.path().join("server-new"));
    connect(&a, &net, "PC A");
    sync(&a);
    let c = device(&root.path().join("c"));
    connect(&c, &net, "PC C");
    sync(&c);
    let titles: Vec<String> = c
        .library_list()
        .unwrap()
        .into_iter()
        .map(|e| e.book.title)
        .collect();
    assert_eq!(titles.len(), 2, "{titles:?}");
    block(c.library_download(&uid)).unwrap();
    assert_eq!(c.book_bytes(&uid).unwrap(), a_v2);
}
