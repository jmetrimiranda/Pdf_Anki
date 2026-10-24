//! EPUB books through `AppState` (spec 7.1, 10, 12, 14, 15, 20, 21 Phase 7): import of EPUB 2 and EPUB 3 books built
//! in code (`core_epub::testkit`), typed errors for garbage/DRM/zip bombs, the cover over the `pdf` protocol, the
//! reading position with its CFI, the highlights/notes/bookmarks of the reader (`epub_annotation`, tombstones, survive
//! a restart), and the vocabulary scan with sections as units (TOC ranges, "cap." page ranges, chapters by the
//! top-level TOC, a range rescan without reading text, `?cap=` Fonte links, `vocab_epub_marks`, cards of the book).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use core_anki::fixture::{self, FixtureOptions};
use core_anki::study::SourceUnit;
use core_epub::testkit::{self, ChapterSpec, EpubBuilder, EpubVersion};
use core_store::{BookFormat, EpubAnnotationKind, book_uid_of};
use core_vocab::{RangeSpec, ScanConfig};
use leitor_app::library::AddOutcome;
use leitor_app::{AppState, EpubAnnotationInput, JobStage, VocabDeckOptions};
use tauri::http::header;

mod common;

const TITLE: &str = "The Farm Book";
const WAIT: Duration = Duration::from_secs(180);

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

/// A line in every section: a PDF scan would drop it as a running header; an EPUB keeps it.
const COMMON: &str = "<p>The animals of the farm work in the barn.</p>";

/// Sections (0-based): 0 Part One, 1 Chapter 1, 2 Chapter 2, 3 Part Two, 4 Chapter 3, 5 Epilogue.
fn farm_book(version: EpubVersion) -> Vec<u8> {
    let body = |text: &str| format!("<p>{text}</p>{COMMON}");
    EpubBuilder::new(version)
        .title(TITLE)
        .authors(&["George Orwell", "Ana Autora"])
        .language("en-GB")
        .chapter(
            ChapterSpec::new(
                "Part One",
                body(
                    "The pigs and the horses were happy. The harvest was good and the hay was big. Then Napoleon \
                     said that the dogs had to watch the sheep.",
                ),
            )
            .child(ChapterSpec::new(
                "Chapter 1",
                body(
                    "All the learning of the pigs was quick. The sheep sang a song in the night. Then Napoleon said \
                     that a slow learner had a good feeling.",
                ),
            ))
            .child(ChapterSpec::new(
                "Chapter 2",
                body(
                    "The building of the windmill was slow. The horses watched the windmills and the pigs. Then \
                     Napoleon saw the geese and the windmill.",
                ),
            )),
        )
        .chapter(
            ChapterSpec::new(
                "Part Two",
                body("The geese walked to the river and the ducks followed the geese."),
            )
            .child(ChapterSpec::new(
                "Chapter 3",
                body("The children and the mice ran from the dog. The geese were loud."),
            )),
        )
        .chapter(ChapterSpec::new(
            "Epilogue",
            body("Then Napoleon gave the man a book about happiness."),
        ))
        .with_image(true)
        .cover_png(Some(testkit::tiny_png(6, 9, [10, 120, 60])))
        .build()
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    common::write(dir, name, bytes)
}

fn books_dir_is_empty(data: &Path) -> bool {
    std::fs::read_dir(data.join("books")).map_or(true, |mut d| d.next().is_none())
}

fn input(book: &str, kind: EpubAnnotationKind, cfi: &str) -> EpubAnnotationInput {
    serde_json::from_value(serde_json::json!({
        "bookUid": book,
        "kind": kind,
        "cfi": cfi,
    }))
    .unwrap()
}

#[test]
fn epub2_and_epub3_import_with_metadata_cover_and_bytes() {
    for version in [EpubVersion::V2, EpubVersion::V3] {
        let tmp = tempfile::tempdir().unwrap();
        let state = common::state(tmp.path());
        let bytes = EpubBuilder::sample(version).build();
        let path = write(tmp.path(), "amostra.epub", &bytes);
        let added = state.library_add(&path, false).unwrap();
        assert_eq!(added.outcome, AddOutcome::Created, "{version:?}");
        let book = &added.book.book;
        assert_eq!(book.book_uid, book_uid_of(&bytes));
        assert_eq!(book.file_hash, book.book_uid);
        assert_eq!(book.format, BookFormat::Epub);
        assert_eq!(book.title, "Amostra");
        assert_eq!(book.author.as_deref(), Some("Autora Teste"));
        assert_eq!(book.language, "en");
        assert_eq!(book.file_name, "amostra.epub");
        // Part I, Chapter 1 (+ the fragment of Section 1.2), Section 1.1, Part II, Chapter 2.
        assert_eq!(book.pages, 5, "{version:?}");
        assert!(book.has_text);
        assert_eq!(book.file_version, 1);
        assert!(
            book.local_path.as_deref().unwrap().ends_with(".epub"),
            "{:?}",
            book.local_path
        );
        assert_eq!(state.book_bytes(&book.book_uid).unwrap(), bytes);

        // The cover is the book's own image, served with its type.
        let res = leitor_app::cover_response(&state, &book.book_uid, false);
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
        assert!(res.body().starts_with(b"\x89PNG"));
        // Also when the cover cache is gone.
        std::fs::remove_dir_all(state.data_dir().join("covers")).unwrap();
        let res = leitor_app::cover_response(&state, &book.book_uid, true);
        assert_eq!(res.status(), 200);
        assert!(res.body().is_empty(), "HEAD has no body");

        // Re-import: nothing changes.
        let again = state.library_add(&path, false).unwrap();
        assert_eq!(again.outcome, AddOutcome::Existing);
        assert_eq!(state.library_list().unwrap().len(), 1);

        // book_open: format, first section, no CFI yet.
        let open = state.book_open(&book.book_uid).unwrap();
        assert_eq!(open.format, BookFormat::Epub);
        assert_eq!(open.page, 0);
        assert_eq!(open.cfi, None);
        state.shutdown();
    }
}

#[test]
fn metadata_fallbacks_and_no_cover() {
    let tmp = tempfile::tempdir().unwrap();
    let state = common::state(tmp.path());
    let bytes = EpubBuilder::new(EpubVersion::V3)
        .title("   ")
        .authors(&[])
        .language("")
        .chapter(ChapterSpec::new("Only", "<p>Some words to read here.</p>"))
        .build();
    let path = write(tmp.path(), "Meu Livro.epub", &bytes);
    let book = state.library_add(&path, false).unwrap().book.book;
    assert_eq!(book.title, "Meu Livro");
    assert_eq!(book.author, None);
    assert_eq!(book.language, "en");
    assert_eq!(book.pages, 1);
    assert_eq!(
        leitor_app::cover_response(&state, &book.book_uid, false).status(),
        404
    );
    state.shutdown();
}

#[test]
fn garbage_drm_and_zip_bombs_are_typed_errors_and_nothing_is_copied() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let state = AppState::new(data.clone());
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("garbage.epub", testkit::garbage(7, 4096), "epub_invalid"),
        ("empty.epub", Vec::new(), "epub_invalid"),
        (
            "truncated.epub",
            testkit::truncated(&EpubBuilder::sample(EpubVersion::V3).build(), 300),
            "epub_invalid",
        ),
        ("drm.epub", testkit::drm_epub(), "epub_drm"),
        (
            "encrypted.epub",
            testkit::encrypted_entries_epub(),
            "epub_drm",
        ),
        ("bomb.epub", testkit::zip_bomb(), "epub_too_big"),
    ];
    for (name, bytes, code) in cases {
        let path = write(tmp.path(), name, &bytes);
        let err = state.library_add(&path, false).unwrap_err();
        assert_eq!(err.code, code, "{name}: {err:?}");
        assert!(!err.message.is_empty());
    }
    assert!(state.library_list().unwrap().is_empty());
    assert!(books_dir_is_empty(&data));
    // A missing file is a read error, not a panic.
    let err = state
        .library_add(&tmp.path().join("nao-existe.epub"), false)
        .unwrap_err();
    assert!(!err.code.is_empty());
    state.shutdown();
}

#[test]
fn position_with_cfi_survives_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let path = write(tmp.path(), "farm.epub", &farm_book(EpubVersion::V3));
    let uid;
    {
        let state = AppState::new(data.clone());
        uid = state.library_add(&path, false).unwrap().book.book.book_uid;
        let cfi = "epubcfi(/6/8!/4/2/1:5)";
        let pos = state
            .position_set(&uid, 3, 0.45, Some(cfi.to_owned()))
            .unwrap();
        assert_eq!(pos.cfi.as_deref(), Some(cfi));
        for bad in ["nope", "epubcfi(/6/4", "epubcfi(/6/\u{1}4!/2)"] {
            let e = state
                .position_set(&uid, 3, 0.5, Some(bad.to_owned()))
                .unwrap_err();
            assert_eq!(e.code, "invalid_input", "{bad:?}");
        }
        state.shutdown();
    }
    let state = AppState::new(data);
    let open = state.book_open(&uid).unwrap();
    assert_eq!(open.page, 3);
    assert_eq!(open.cfi.as_deref(), Some("epubcfi(/6/8!/4/2/1:5)"));
    let pos = state.position_get(&uid).unwrap().unwrap();
    assert!((pos.progress - 0.45).abs() < 1e-9);
    // A page beyond the last section opens the last one.
    state.position_set(&uid, 99, 1.0, None).unwrap();
    assert_eq!(state.book_open(&uid).unwrap().page, 5);
    assert_eq!(state.book_open(&uid).unwrap().cfi, None);
    state.shutdown();
}

#[test]
fn annotations_round_trip_with_tombstones_and_survive_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let path = write(tmp.path(), "farm.epub", &farm_book(EpubVersion::V2));
    let pdf = write(tmp.path(), "a.pdf", &common::text_pdf(2, "PDF"));
    let (uid, pdf_uid, highlight_uid, bookmark_uid);
    {
        let state = AppState::new(data.clone());
        uid = state.library_add(&path, false).unwrap().book.book.book_uid;
        pdf_uid = state.library_add(&pdf, false).unwrap().book.book.book_uid;

        let mut h = input(
            &uid,
            EpubAnnotationKind::Highlight,
            "epubcfi(/6/6!/4/2,/1:4,/1:12)",
        );
        h.text = Some("windmill".into());
        h.color = Some("#FFF000".into());
        let h = state.epub_annotation_upsert(h).unwrap();
        assert_eq!(h.section, 2);
        assert_eq!(h.color.as_deref(), Some("#fff000"));
        assert_eq!(h.text.as_deref(), Some("windmill"));
        assert!(!h.uid.is_empty());
        highlight_uid = h.uid.clone();

        let b = state
            .epub_annotation_upsert(input(
                &uid,
                EpubAnnotationKind::Bookmark,
                "epubcfi(/6/12!/4/2/1:0)",
            ))
            .unwrap();
        assert_eq!(b.section, 5);
        bookmark_uid = b.uid.clone();

        // A note on the highlight: same uid, a comment; updated_at goes up.
        let mut n = input(
            &uid,
            EpubAnnotationKind::Note,
            "epubcfi(/6/6!/4/2,/1:4,/1:12)",
        );
        n.uid = Some(highlight_uid.clone());
        n.comment = Some("lembrar do moinho".into());
        n.color = Some("#ff8a00".into());
        let n = state.epub_annotation_upsert(n).unwrap();
        assert_eq!(n.uid, highlight_uid);
        assert!(n.updated_at > h.updated_at);
        assert_eq!(n.kind, EpubAnnotationKind::Note);

        // Refused: bad CFI syntax, a section the book doesn't have, a bad color or uid, a PDF book, an unknown book.
        let bad = |i: EpubAnnotationInput| state.epub_annotation_upsert(i).unwrap_err().code;
        assert_eq!(
            bad(input(&uid, EpubAnnotationKind::Highlight, "garbage")),
            "invalid_input"
        );
        assert_eq!(
            bad(input(
                &uid,
                EpubAnnotationKind::Highlight,
                "epubcfi(/6/40!/4/2/1:0)"
            )),
            "invalid_input"
        );
        let mut c = input(
            &uid,
            EpubAnnotationKind::Highlight,
            "epubcfi(/6/4!/4/2/1:0)",
        );
        c.color = Some("yellow".into());
        assert_eq!(bad(c), "invalid_input");
        let mut u = input(
            &uid,
            EpubAnnotationKind::Highlight,
            "epubcfi(/6/4!/4/2/1:0)",
        );
        u.uid = Some("a b/c".into());
        assert_eq!(bad(u), "invalid_input");
        assert_eq!(
            bad(input(
                &pdf_uid,
                EpubAnnotationKind::Highlight,
                "epubcfi(/6/4!/4/2/1:0)"
            )),
            "not_epub"
        );
        assert_eq!(
            bad(input(
                &"e".repeat(64),
                EpubAnnotationKind::Highlight,
                "epubcfi(/6/4!/4/2/1:0)"
            )),
            "book_not_found"
        );
        assert_eq!(
            state.epub_annotation_list(&pdf_uid).unwrap_err().code,
            "not_epub"
        );

        let list = state.epub_annotation_list(&uid).unwrap();
        assert_eq!(list.len(), 2);
        state.epub_annotation_delete(&bookmark_uid).unwrap();
        // Deleting twice (or an unknown uid) is a no-op.
        state.epub_annotation_delete(&bookmark_uid).unwrap();
        state.epub_annotation_delete("nao-existe").unwrap();
        state.shutdown();
    }
    let state = AppState::new(data);
    let list = state.epub_annotation_list(&uid).unwrap();
    assert_eq!(list.len(), 1);
    let a = &list[0];
    assert_eq!(a.uid, highlight_uid);
    assert_eq!(a.section, 2);
    assert_eq!(a.comment.as_deref(), Some("lembrar do moinho"));
    assert_eq!(a.color.as_deref(), Some("#ff8a00"));
    // The tombstone stays in the database for the library sync.
    let deleted: i64 = state
        .with_store(|s| {
            Ok(s.connection()
                .query_row(
                    "SELECT deleted FROM epub_annotation WHERE uid = ?1",
                    [&bookmark_uid],
                    |r| r.get(0),
                )
                .unwrap())
        })
        .unwrap();
    assert_eq!(deleted, 1);
    // Removing the book tombstones what is left.
    state.library_remove(&uid).unwrap();
    let live: i64 = state
        .with_store(|s| {
            Ok(s.connection()
                .query_row(
                    "SELECT count(*) FROM epub_annotation WHERE book_uid = ?1 AND deleted = 0",
                    [&uid],
                    |r| r.get(0),
                )
                .unwrap())
        })
        .unwrap();
    assert_eq!(live, 0);
    state.shutdown();
}

#[test]
fn pdf_only_actions_refuse_epubs_and_export_copies_the_file() {
    let tmp = tempfile::tempdir().unwrap();
    let state = common::state(tmp.path());
    let bytes = farm_book(EpubVersion::V3);
    let uid = state
        .library_add(&write(tmp.path(), "farm.epub", &bytes), false)
        .unwrap()
        .book
        .book
        .book_uid;
    let e = state
        .book_save_version(&uid, b"%PDF-1.4".to_vec())
        .unwrap_err();
    assert_eq!(e.code, "not_pdf");
    assert_eq!(
        e.message,
        "Livros EPUB não têm versões: as anotações ficam no app."
    );
    assert_eq!(state.doc_words(&uid, 0).unwrap_err().code, "not_pdf");
    // "Exportar cópia": the .epub as it is.
    let dest = tmp.path().join("copia.epub");
    state.book_export(&uid, &dest).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    assert_eq!(
        state
            .book_export(&uid, &tmp.path().join("copia.pdf"))
            .unwrap_err()
            .code,
        "invalid_path"
    );
    state.shutdown();
}

#[test]
fn missing_toc_gives_a_fallback_outline() {
    let tmp = tempfile::tempdir().unwrap();
    let state = common::state(tmp.path());
    let uid = state
        .library_add(
            &write(tmp.path(), "sem-sumario.epub", &testkit::without_toc()),
            false,
        )
        .unwrap()
        .book
        .book
        .book_uid;
    let outline = state.vocab_outline(&uid).unwrap();
    assert_eq!(outline.page_count, 2);
    let titles: Vec<&str> = outline.items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles, ["One", "Two"]);
    assert_eq!(outline.items[0].start_page, Some(0));
    assert_eq!(outline.items[1].end_page, Some(1));
    state.shutdown();
}

/// The fixture collection with its vocabulary folder and the farm EPUB in the library.
struct Env {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    uid: String,
    root: i64,
}

impl Env {
    fn new() -> Self {
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
        let state = Arc::new(AppState::new(data));
        common::use_lexicon(&state);
        let path = write(dir.path(), "farm.epub", &farm_book(EpubVersion::V3));
        let uid = state.library_add(&path, false).unwrap().book.book.book_uid;
        Self {
            dir,
            state,
            uid,
            root: info.decks[fixture::DECK_VOCAB],
        }
    }

    fn scan(&self, range: RangeSpec) -> leitor_app::VocabReport {
        self.settle();
        let job = self
            .state
            .vocab_scan_start(&self.uid, self.root, vec![], range, ScanConfig::default())
            .unwrap();
        let p = self.state.job_wait(&job.job_id, WAIT).unwrap();
        assert_eq!(p.stage, JobStage::Done, "{p:?}");
        let report = self.state.vocab_report(&self.uid).unwrap().unwrap();
        assert_eq!(report.scan_uid, job.scan_uid);
        report
    }

    fn settle(&self) {
        if let Some(p) = self.state.vocab_running_job(&self.uid) {
            let end = self.state.job_wait(&p.job_id, WAIT).unwrap();
            assert!(end.stage.is_terminal());
        }
    }

    fn outline_id(&self, title: &str) -> String {
        fn find(items: &[core_vocab::OutlineRangeItem], title: &str) -> Option<String> {
            items.iter().find_map(|i| {
                if i.title == title {
                    Some(i.id.clone())
                } else {
                    find(&i.children, title)
                }
            })
        }
        let outline = self.state.vocab_outline(&self.uid).unwrap();
        find(&outline.items, title).unwrap_or_else(|| panic!("no {title} in {outline:?}"))
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.settle();
        self.state.shutdown();
        let _ = &self.dir;
    }
}

fn units_of(report: &leitor_app::VocabReport) -> std::collections::BTreeSet<u32> {
    report
        .rows
        .iter()
        .flat_map(|r| r.pages.iter().copied())
        .collect()
}

#[test]
fn vocabulary_scan_uses_sections_and_the_toc() {
    let env = Env::new();
    let outline = env.state.vocab_outline(&env.uid).unwrap();
    assert_eq!(outline.page_count, 6);
    let tops: Vec<&str> = outline.items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(tops, ["Part One", "Part Two", "Epilogue"]);
    assert_eq!(outline.items[0].children.len(), 2);

    // Whole book: chapters are the top-level TOC items.
    let full = env.scan(RangeSpec::All);
    assert_eq!(full.range.display, "Livro inteiro");
    assert!(full.metrics.total_tokens > 50, "{:?}", full.metrics);
    let chapters: Vec<(&str, u32, u32)> = full
        .chapters
        .iter()
        .map(|c| (c.label.as_str(), c.start_page, c.end_page))
        .collect();
    assert_eq!(
        chapters,
        [("Part One", 0, 2), ("Part Two", 3, 4), ("Epilogue", 5, 5)]
    );
    // No line is a running header in an EPUB: the line of every section counts on every section.
    let barn = full
        .rows
        .iter()
        .find(|r| r.lemma == "barn")
        .map(|r| r.pages.clone());
    if let Some(pages) = barn {
        assert_eq!(pages, vec![0, 1, 2, 3, 4, 5]);
    }
    let table_state = env
        .state
        .with_store(|s| s.vocab_table_state(&env.uid))
        .unwrap()
        .unwrap();
    assert!(table_state.repeated_lines.is_empty());
    assert!(
        table_state.text_version.contains(":epub:"),
        "{}",
        table_state.text_version
    );
    // The section texts came from the import's cache: nothing was extracted again.
    assert_eq!(env.state.vocab_text_extractions(), 0);

    // A nested TOC item with children: its section and its children's, nothing else.
    let part_two = env.outline_id("Part Two");
    let r = env.scan(RangeSpec::Outline {
        ids: vec![part_two],
    });
    assert_eq!(r.range.pages, vec![[3, 4]]);
    assert_eq!(r.range.label.as_deref(), Some("Part Two"));
    assert_eq!(r.range.display, "Part Two (cap. 4–5)");
    assert!(!r.rows.is_empty());
    assert!(
        units_of(&r).iter().all(|u| (3..=4).contains(u)),
        "{:?}",
        units_of(&r)
    );

    // "Páginas" are chapters (1-based sections) for an EPUB, timed: the table is reused.
    let before = env.state.vocab_text_extractions();
    let t = Instant::now();
    let r = env.scan(RangeSpec::Pages { text: "2-3".into() });
    let took = t.elapsed();
    assert!(took <= Duration::from_secs(3), "range rescan took {took:?}");
    assert_eq!(env.state.vocab_text_extractions(), before);
    assert_eq!(r.range.pages, vec![[1, 2]]);
    assert_eq!(r.range.label.as_deref(), Some("cap. 2-3"));
    assert_eq!(r.range.display, "cap. 2–3");
    assert_eq!(r.deck.range_tag.as_deref(), Some("trecho::cap-2-3"));
    assert_eq!(r.deck.subdeck.as_deref(), Some("cap. 2-3"));
    assert!(units_of(&r).iter().all(|u| (1..=2).contains(u)));
    // Errors speak of chapters.
    let e = env
        .state
        .vocab_range_check(&env.uid, &RangeSpec::Pages { text: "9".into() })
        .unwrap_err();
    assert_eq!(e.code, "vocab_invalid_range");
    assert_eq!(
        e.message,
        "O capítulo 9 não existe (o livro tem 6 capítulos)."
    );
}

#[test]
fn a_missing_text_cache_is_extracted_once() {
    let env = Env::new();
    env.state
        .with_store(|s| s.clear_book_text(&env.uid))
        .unwrap();
    env.scan(RangeSpec::All);
    assert_eq!(env.state.vocab_text_extractions(), 1);
    assert_eq!(
        env.state
            .with_store(|s| s.book_text(&env.uid))
            .unwrap()
            .len(),
        6
    );
    env.scan(RangeSpec::Pages { text: "1".into() });
    assert_eq!(env.state.vocab_text_extractions(), 1);
}

#[test]
fn deck_fonte_points_at_chapters_and_marks_color_forms() {
    let env = Env::new();
    // Marks need a scan first.
    assert_eq!(
        env.state.vocab_epub_marks(&env.uid, &[0]).unwrap_err().code,
        "vocab_not_scanned"
    );
    let full = env.scan(RangeSpec::All);
    let candidates: Vec<String> = full
        .rows
        .iter()
        .filter(|r| r.default_selected)
        .take(3)
        .map(|r| r.lemma.clone())
        .collect();
    assert!(!candidates.is_empty(), "{:?}", full.rows);
    let out = env
        .state
        .vocab_generate_deck(
            &env.uid,
            &full.scan_uid,
            candidates.clone(),
            VocabDeckOptions {
                per_chapter: true,
                ..VocabDeckOptions::default()
            },
        )
        .unwrap();
    env.settle();
    assert!(out.created > 0, "{out:?}");
    for id in &out.note_ids {
        let note = block_on(env.state.anki_note_get(*id)).unwrap();
        let fonte = note
            .fields
            .iter()
            .find(|f| f.contains("leitor://livro/"))
            .unwrap_or_else(|| panic!("no Fonte in {:?}", note.fields));
        assert!(
            fonte.contains(&format!("leitor://livro/{}?cap=", env.uid)),
            "{fonte}"
        );
        let link = core_anki::study::source::parse_source(fonte).unwrap();
        assert_eq!(link.unit, SourceUnit::Chapter);
        assert!((1..=6).contains(&link.page));
        assert!(
            link.label.starts_with(&format!("{TITLE}, ")),
            "{}",
            link.label
        );
        assert!(!link.label.contains("p. "), "{}", link.label);
        assert!(
            note.tags.iter().any(|t| t.starts_with("cap::")),
            "{:?}",
            note.tags
        );
    }
    // Per-chapter subdecks: the panel finds the chapter of a section through the top-level TOC.
    let chapter_of = |section: u32| {
        block_on(env.state.book_panel_info_at(&env.uid, Some(section)))
            .unwrap()
            .chapter_deck
            .map(|d| d.name)
    };
    let names: Vec<String> = out.decks.clone();
    for (section, cap) in [(1u32, "Cap 01"), (4, "Cap 02"), (5, "Cap 03")] {
        let wanted = format!("Vocabulário::Livros::{TITLE}::{cap}");
        if names.contains(&wanted) {
            assert_eq!(chapter_of(section).as_deref(), Some(wanted.as_str()));
        }
    }

    // "Cards deste capítulo": the generated notes come back as chapters.
    let cards = block_on(env.state.anki_book_cards(env.uid.clone())).unwrap();
    assert_eq!(cards.len(), out.note_ids.len());
    assert!(
        cards
            .iter()
            .all(|c| c.unit == SourceUnit::Chapter && c.cfi.is_none())
    );

    // Marks: coral/amber forms of up to 5 sections; never a proper noun.
    let marks = env
        .state
        .vocab_epub_marks(&env.uid, &[0, 1, 2, 3, 4])
        .unwrap();
    assert_eq!(
        marks.iter().map(|m| m.section).collect::<Vec<_>>(),
        [0, 1, 2, 3, 4]
    );
    let words: Vec<&leitor_app::EpubMarkWord> = marks.iter().flat_map(|m| &m.words).collect();
    assert!(!words.is_empty(), "{marks:?}");
    for w in &words {
        assert_eq!(w.form, w.form.to_lowercase());
        assert!(!w.form.contains(' '));
        let color = match w.status {
            core_vocab::Status::Unknown | core_vocab::Status::Suspended => "#d85a30",
            core_vocab::Status::Learning | core_vocab::Status::New => "#ba7517",
            other => panic!("unexpected status {other:?} for {}", w.form),
        };
        assert_eq!(w.color, color, "{w:?}");
        assert_ne!(w.lemma, "napoleon");
    }
    assert!(!words.iter().any(|w| w.form == "napoleon"));
    assert_eq!(
        env.state
            .vocab_epub_marks(&env.uid, &[0, 1, 2, 3, 4, 5])
            .unwrap_err()
            .code,
        "invalid_input"
    );
    // PDF-only and EPUB-only marks never mix.
    assert_eq!(
        env.state.vocab_marks(&env.uid, &[0]).unwrap_err().code,
        "not_pdf"
    );
}

#[test]
fn book_cards_keep_the_chapter_and_cfi_of_a_selection_card() {
    let env = Env::new();
    let uid = env.uid.clone();
    let fonte = core_anki::study::source::source_html_section(
        &uid,
        TITLE,
        3,
        "Chapter 2",
        Some("epubcfi(/6/6!/4/2,/1:4,/1:12)"),
        "the windmill",
    );
    let nid = env
        .state
        .anki_handles()
        .unwrap()
        .svc
        .call_blocking(move |col| {
            let nt = col
                .get_notetype_by_name(core_anki::notetypes::BASIC_LEITOR)?
                .ok_or_else(|| core_anki::Error::NotFound("notetype".into()))?;
            let mut note = nt.new_note();
            note.set_field(0, "Moinho")?;
            note.set_field(1, "windmill")?;
            note.set_field(2, fonte)?;
            col.add_note(&mut note, core_anki::anki::prelude::DeckId(1))?;
            Ok(note.id.0)
        })
        .unwrap();
    let cards = block_on(env.state.anki_book_cards(uid)).unwrap();
    let card = cards.iter().find(|c| c.note_id == nid).unwrap();
    assert_eq!((card.page, card.unit), (3, SourceUnit::Chapter));
    assert_eq!(card.cfi.as_deref(), Some("epubcfi(/6/6!/4/2,/1:4,/1:12)"));
    assert_eq!(card.query.as_deref(), Some("the windmill"));
}
