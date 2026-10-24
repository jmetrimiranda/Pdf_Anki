//! Vocabulary scanning through `AppState` (spec 12, 15, 20, 21 Phase 6): a synthetic English book with an outline,
//! the fixture collection with its vocabulary folder (`FixtureOptions { vocab: true }`), scans of the whole book and
//! of ranges (the per-page table is reused: no new text extraction), the report groups (forms, families, proper
//! nouns), deck generation (names, tags, Fonte, Família, no duplicates across scans), the reading marks and the
//! popover's "Adicionar ao deck do livro", the jobs (progress, cancel, one per book, recovery) and the panel.
//!
//! Uses the data pack (`data/generated/vocab`, `scripts/build-wordnet.sh`) when present, else the small test
//! lexicon of `core-vocab`; with `LEITOR_REQUIRE_VOCAB_DATA=1` a missing pack fails the tests instead.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_anki::fixture::{self, FixtureInfo, FixtureOptions};
use core_vocab::{RangeSpec, RowGroup, ScanConfig, Status};
use leitor_app::{AppState, JobProgress, JobStage, ScanStarted, UiEvent, VocabDeckOptions};

mod common;

use common::mark;

const TITLE: &str = "Animal Farm";
const PAGES: usize = 60;
const WAIT: Duration = Duration::from_secs(180);

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

/// Openings that differ from page to page, so no line of the body repeats on many pages (the cleanup drops lines
/// found on more than 30% of the pages as running headers).
const OPENINGS: [&str; 7] = [
    "It was a day.",
    "It was a cold day in the winter.",
    "The day was long.",
    "It was night again.",
    "So it was.",
    "There was a time when all was well.",
    "Time went by.",
];

/// The text of a page (0-based): chapter 1 = pages 0–9, 2 = 10–19, 3 = 20–44 (section 3.1 from 29), 4 = 45–59.
pub fn page_text(p: usize) -> String {
    let common = format!(
        "{} The animals of the farm work in the barn.",
        OPENINGS[p % OPENINGS.len()]
    );
    let chapter = match p {
        0..=9 => {
            "The pigs and the horses were happy. The harvest was good and the hay was big. Then Napoleon said that \
             the dogs had to watch the sheep."
        }
        10..=19 => {
            "All the learning of the pigs was quick. The sheep sang a song in the night. Then Napoleon said that a \
             slow learner had a good feeling."
        }
        20..=44 => {
            "The building of the windmill was slow. The horses watched the windmills and the pigs. Then Napoleon \
             saw the geese and the windmill."
        }
        _ => {
            "The children and the mice ran from the dog. Then Napoleon gave the man a book about happiness."
        }
    };
    format!("{common} {chapter}")
}

fn book_bytes() -> Vec<u8> {
    let pages: Vec<String> = (0..PAGES).map(page_text).collect();
    common::book_pdf(
        &pages,
        TITLE,
        &[
            mark("Cap 1", 0, vec![]),
            mark("Cap 2", 10, vec![]),
            mark("Cap 3", 20, vec![mark("Secao 3.1", 29, vec![])]),
            mark("Cap 4", 45, vec![]),
        ],
    )
}

/// Runs in the job thread for every progress event.
type Hook = Arc<dyn Fn(&JobProgress) + Send + Sync>;

struct Env {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    info: FixtureInfo,
    uid: String,
    root: i64,
    events: Arc<Mutex<Vec<JobProgress>>>,
    original: Vec<u8>,
}

impl Env {
    fn new() -> Self {
        Self::with_sink(None)
    }

    /// `hook` runs in the job thread for every progress event (tests block or cancel there).
    fn with_sink(hook: Option<Hook>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root_dir: PathBuf = dir.path().to_path_buf();
        let data = root_dir.join("data");
        let info = fixture::build(
            &data.join("anki"),
            FixtureOptions {
                vocab: true,
                ..FixtureOptions::default()
            },
        )
        .unwrap();
        // Keys of the AI tests go to an in-memory keychain.
        let state = Arc::new(AppState::with_secret_store(
            data,
            Arc::new(core_store::SystemClock),
            Arc::new(leitor_app::secrets::MemoryStore::default()),
        ));
        common::use_lexicon(&state);
        let events: Arc<Mutex<Vec<JobProgress>>> = Arc::default();
        let seen = Arc::clone(&events);
        state.set_ui_sink(Arc::new(move |e| {
            if let UiEvent::Job(p) = e {
                if let Some(h) = &hook {
                    h(&p);
                }
                seen.lock().unwrap().push(p);
            }
        }));
        let original = book_bytes();
        let pdf = common::write(&root_dir, "farm.pdf", &original);
        let uid = state
            .library_add(&pdf, false)
            .unwrap()
            .book
            .book
            .book_uid
            .clone();
        let root = info.decks[fixture::DECK_VOCAB];
        Self {
            dir,
            state,
            info,
            uid,
            root,
            events,
            original,
        }
    }

    fn start(&self, range: RangeSpec) -> ScanStarted {
        self.state
            .vocab_scan_start(&self.uid, self.root, vec![], range, ScanConfig::default())
            .unwrap()
    }

    fn wait(&self, job: &ScanStarted) -> JobProgress {
        let p = self.state.job_wait(&job.job_id, WAIT).unwrap();
        assert!(p.stage.is_terminal(), "job still running: {p:?}");
        p
    }

    fn scan(&self, range: RangeSpec) -> (JobProgress, leitor_app::VocabReport) {
        self.settle();
        let job = self.start(range);
        let p = self.wait(&job);
        assert_eq!(p.stage, JobStage::Done, "{p:?}");
        let report = self.state.vocab_report(&self.uid).unwrap().unwrap();
        assert_eq!(report.scan_uid, job.scan_uid);
        (p, report)
    }

    /// Waits for the rescan a deck generation starts.
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

    fn generate(
        &self,
        scan_uid: &str,
        lemmas: &[&str],
        options: VocabDeckOptions,
    ) -> leitor_app::VocabDeckResult {
        let out = self
            .state
            .vocab_generate_deck(
                &self.uid,
                scan_uid,
                lemmas.iter().map(|s| s.to_string()).collect(),
                options,
            )
            .unwrap();
        self.settle();
        out
    }

    fn note(&self, id: i64) -> core_anki::notes::NoteData {
        block_on(self.state.anki_note_get(id)).unwrap()
    }

    fn deck_name(&self, id: i64) -> String {
        block_on(self.state.anki_deck_names())
            .unwrap()
            .into_iter()
            .find(|d| d.id == id)
            .map(|d| d.name)
            .unwrap_or_default()
    }

    fn stages(&self, job_id: &str) -> Vec<JobStage> {
        let mut out: Vec<JobStage> = Vec::new();
        for p in self.events.lock().unwrap().iter() {
            if p.job_id == job_id && out.last() != Some(&p.stage) {
                out.push(p.stage);
            }
        }
        out
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.settle();
        self.state.shutdown();
        let _ = &self.dir;
    }
}

fn row<'a>(report: &'a leitor_app::VocabReport, lemma: &str) -> &'a core_vocab::VocabRow {
    report
        .rows
        .iter()
        .find(|r| r.lemma == lemma)
        .unwrap_or_else(|| panic!("no row {lemma}"))
}

fn has_row(report: &leitor_app::VocabReport, lemma: &str) -> bool {
    report.rows.iter().any(|r| r.lemma == lemma)
}

// Field order of "Vocabulário · Livro".
const PALAVRA: usize = 0;
const CLASSE: usize = 2;
const DEFINICAO: usize = 3;
const TRADUCAO: usize = 4;
const EXEMPLO: usize = 5;
const FONTE: usize = 6;
const FAMILIA: usize = 8;

#[test]
fn full_scan_report() {
    let env = Env::new();
    // The folder is mandatory.
    let missing = env
        .state
        .vocab_scan_start(
            &env.uid,
            987_654_321,
            vec![],
            RangeSpec::All,
            ScanConfig::default(),
        )
        .unwrap_err();
    assert_eq!(missing.code, "vocab_folder_required");

    let (progress, report) = env.scan(RangeSpec::All);
    assert!(!progress.reused, "first scan reads the book");
    assert_eq!(env.state.vocab_text_extractions(), 1);
    assert_eq!(report.title, TITLE);
    assert_eq!(report.range.display, "Livro inteiro");
    assert_eq!(report.range.label, None);
    assert_eq!(report.folder.root_deck_id, env.root);
    assert_eq!(report.folder.root_name, fixture::DECK_VOCAB);
    assert_eq!(report.folder.deck_count, 4);
    assert_eq!(report.deck.base_name, "Vocabulário::Livros::Animal Farm");
    assert_eq!(report.deck.full_name, report.deck.base_name);
    assert_eq!(report.deck.range_tag, None);
    assert_eq!(report.deck.book_tag, "livro::animal-farm");

    let m = &report.metrics;
    assert!(m.total_tokens > 1000, "{m:?}");
    assert!(m.coverage_known > 0.0 && m.coverage_known < 1.0, "{m:?}");
    assert!(m.coverage_with_learning >= m.coverage_known);
    assert!(m.unknown_lemmas > 0);
    assert_eq!(report.chapters.len(), 4, "{:?}", report.chapters);

    // Forms of known words (learning ← learn ✓), families (learner → learn), proper nouns, folder statuses.
    let learning = row(&report, "learning");
    assert_eq!(learning.group, RowGroup::Forms, "{learning:?}");
    assert!(!learning.default_selected);
    let base = learning.base.as_ref().unwrap();
    assert_eq!((base.lemma.as_str(), base.status), ("learn", Status::Known));
    let learner = row(&report, "learner");
    assert_eq!(learner.group, RowGroup::Main);
    assert_eq!(learner.family.as_ref().unwrap().lemma, "learn");
    assert!(learner.default_selected);
    let napoleon = report
        .rows
        .iter()
        .find(|r| r.lemma.eq_ignore_ascii_case("napoleon"))
        .unwrap();
    assert_eq!(napoleon.group, RowGroup::Proper, "{napoleon:?}");
    assert_eq!(row(&report, "windmill").status, Status::Suspended);
    assert_eq!(row(&report, "farm").status, Status::Known);
    assert_eq!(row(&report, "animal").status, Status::New);
    let harvest = row(&report, "harvest");
    assert_eq!(harvest.status, Status::Unknown);
    assert_eq!(harvest.first_page, 0);
    assert!(harvest.example.as_deref().unwrap().contains("harvest"));
    // The running header and the page numbers are not words of the book.
    assert_eq!(row(&report, "farm").occurrences, PAGES as u32);
}

#[test]
fn range_scans_reuse_the_table() {
    let env = Env::new();
    let (_, full) = env.scan(RangeSpec::All);
    assert!(has_row(&full, "harvest"));
    assert_eq!(env.state.vocab_text_extractions(), 1);

    // Pages: metrics and rows only for the range, without reading the PDF again.
    let started = std::time::Instant::now();
    let (p, pages) = env.scan(RangeSpec::Pages {
        text: "21-45".into(),
    });
    assert!(p.reused, "{p:?}");
    assert_eq!(env.state.vocab_text_extractions(), 1);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(pages.range.pages, vec![[20, 44]]);
    assert_eq!(pages.range.label.as_deref(), Some("p. 21-45"));
    assert_eq!(
        pages.deck.full_name,
        "Vocabulário::Livros::Animal Farm::p. 21-45"
    );
    assert_eq!(pages.deck.range_tag.as_deref(), Some("trecho::p-21-45"));
    assert!(!has_row(&pages, "harvest"), "harvest is only in chapter 1");
    for r in &pages.rows {
        assert!(r.pages.iter().all(|p| (20..=44).contains(p)), "{r:?}");
    }
    assert!(pages.metrics.total_tokens < full.metrics.total_tokens);
    assert_eq!(row(&pages, "farm").occurrences, 25);

    // An outline item includes its children; its range ends before the next item of the same level or above.
    let cap3 = env.outline_id("Cap 3");
    let (p, outline) = env.scan(RangeSpec::Outline { ids: vec![cap3] });
    assert!(p.reused);
    assert_eq!(outline.range.pages, vec![[20, 44]]);
    assert_eq!(outline.range.label.as_deref(), Some("Cap 3"));
    assert_eq!(
        outline.deck.full_name,
        "Vocabulário::Livros::Animal Farm::Cap 3"
    );
    assert_eq!(outline.deck.range_tag.as_deref(), Some("trecho::cap-3"));
    let section = env.outline_id("Secao 3.1");
    let checked = env
        .state
        .vocab_range_check(&env.uid, &RangeSpec::Outline { ids: vec![section] })
        .unwrap();
    assert_eq!(checked.pages, vec![[29, 44]]);
    for bad in ["", "0", "61", "45-21", "abc", "3-"] {
        let e = env
            .state
            .vocab_range_check(&env.uid, &RangeSpec::Pages { text: bad.into() })
            .unwrap_err();
        assert_eq!(e.code, "vocab_invalid_range", "{bad:?}");
        assert!(!e.message.is_empty());
    }

    // A version saved with only an annotation keeps the table (same text fingerprint).
    let annotated = common::annotated_version(&env.original, &env.uid);
    let saved = env.state.book_save_version(&env.uid, annotated).unwrap();
    assert!(saved.changed);
    let (p, _) = env.scan(RangeSpec::Pages {
        text: "1-10, 46".into(),
    });
    assert!(
        p.reused,
        "an annotation-only version reuses the table: {p:?}"
    );
    assert_eq!(env.state.vocab_text_extractions(), 1);
    // A rescan repeats the last range.
    env.settle();
    let job = env.state.vocab_rescan(&env.uid).unwrap();
    assert_eq!(env.wait(&job).stage, JobStage::Done);
    let again = env.state.vocab_report(&env.uid).unwrap().unwrap();
    assert_eq!(again.range.pages, vec![[0, 9], [45, 45]]);
    assert_eq!(env.state.vocab_text_extractions(), 1);
}

#[test]
fn outline_shows_bookmarks_saved_by_pdfcraft() {
    let env = Env::new();
    let before = env.state.vocab_outline(&env.uid).unwrap();
    assert_eq!(before.page_count, PAGES as u32);
    assert_eq!(
        before
            .items
            .iter()
            .map(|i| i.title.as_str())
            .collect::<Vec<_>>(),
        ["Cap 1", "Cap 2", "Cap 3", "Cap 4"]
    );
    assert_eq!(
        (before.items[0].start_page, before.items[0].end_page),
        (Some(0), Some(9))
    );
    assert_eq!(before.items[2].children[0].title, "Secao 3.1");
    // A bookmark written the way PdfCraft writes it, saved as a new version of the book.
    let mut doc =
        pdfcraft_cos::Document::open(Arc::new(env.state.book_bytes(&env.uid).unwrap())).unwrap();
    pdfcraft_organize::add_bookmark(&mut doc, &[], 99, "Minha marca", 50).unwrap();
    let bytes = pdfcraft_cos::write_incremental(&doc, &Default::default()).unwrap();
    env.state.book_save_version(&env.uid, bytes).unwrap();
    let after = env.state.vocab_outline(&env.uid).unwrap();
    let mine = after
        .items
        .iter()
        .find(|i| i.title == "Minha marca")
        .unwrap_or_else(|| panic!("{after:?}"));
    assert_eq!((mine.start_page, mine.end_page), (Some(50), Some(59)));
    // Cap 4 now ends before the new bookmark.
    let cap4 = after.items.iter().find(|i| i.title == "Cap 4").unwrap();
    assert_eq!(cap4.end_page, Some(49));
    let range = env
        .state
        .vocab_range_check(
            &env.uid,
            &RangeSpec::Outline {
                ids: vec![mine.id.clone()],
            },
        )
        .unwrap();
    assert_eq!(range.pages, vec![[50, 59]]);
    assert_eq!(range.subdeck.as_deref(), Some("Minha marca"));
}

#[test]
fn rescan_finds_the_outline_items_again() {
    let env = Env::new();
    let cap3 = env.outline_id("Cap 3");
    let (_, first) = env.scan(RangeSpec::Outline { ids: vec![cap3] });
    assert_eq!(first.range.pages, vec![[20, 44]]);
    // A bookmark inserted at the top of the outline moves every index path ("2" → "3").
    let mut doc =
        pdfcraft_cos::Document::open(Arc::new(env.state.book_bytes(&env.uid).unwrap())).unwrap();
    pdfcraft_organize::add_bookmark(&mut doc, &[], 0, "Nota", 3).unwrap();
    let bytes = pdfcraft_cos::write_incremental(&doc, &Default::default()).unwrap();
    env.state.book_save_version(&env.uid, bytes).unwrap();
    assert_eq!(env.outline_id("Cap 3"), "3");
    env.settle();
    let job = env.state.vocab_rescan(&env.uid).unwrap();
    assert_eq!(env.wait(&job).stage, JobStage::Done);
    let again = env.state.vocab_report(&env.uid).unwrap().unwrap();
    assert_eq!(again.range.label.as_deref(), Some("Cap 3"));
    assert_eq!(again.range.pages, vec![[20, 44]]);
    assert_eq!(again.range.items, vec!["3".to_string()]);
}

#[test]
fn generated_decks_names_tags_and_no_duplicates() {
    let env = Env::new();
    let (_, full) = env.scan(RangeSpec::All);
    // Whole book: the book deck, reading order, the Fonte of the first occurrence, the family.
    let out = env.generate(
        &full.scan_uid,
        &["learner", "harvest", "pig", "windmill"],
        VocabDeckOptions::default(),
    );
    assert_eq!(out.deck_name, "Vocabulário::Livros::Animal Farm");
    assert_eq!(out.decks, vec![out.deck_name.clone()]);
    assert_eq!(env.deck_name(out.deck_id), out.deck_name);
    assert_eq!(out.created, 3);
    assert_eq!(out.skipped_existing, vec!["windmill".to_string()]);
    assert!(out.skipped_previous.is_empty());
    let notes: Vec<_> = out.note_ids.iter().map(|id| env.note(*id)).collect();
    let words: Vec<&str> = notes.iter().map(|n| n.fields[PALAVRA].as_str()).collect();
    assert_eq!(words, ["pig", "harvest", "learner"], "reading order");
    let pig = &notes[0];
    let pig_row = row(&full, "pig");
    assert_eq!(pig_row.first_page, 0);
    assert_eq!(
        pig.fields[FONTE],
        core_anki::study::source::source_html(&env.uid, TITLE, 1, "pigs")
    );
    assert!(
        pig.fields[EXEMPLO].contains("<b>pigs</b>"),
        "{}",
        pig.fields[EXEMPLO]
    );
    assert!(
        pig.tags.contains(&"livro::animal-farm".to_string()),
        "{:?}",
        pig.tags
    );
    assert!(pig.tags.contains(&"cap::01".to_string()), "{:?}", pig.tags);
    assert!(!pig.tags.iter().any(|t| t.starts_with("trecho::")));
    assert_eq!(notes[2].fields[FAMILIA], "learn");
    assert_eq!(notes[0].fields[FAMILIA], "");
    // New cards are studied in the plan's order.
    let due: Vec<i64> = notes
        .iter()
        .map(|n| {
            let cid = n.card_ids[0];
            env.state
                .anki_handles()
                .unwrap()
                .svc
                .call_blocking(move |col| {
                    Ok(col
                        .storage
                        .db()
                        .query_row("SELECT due FROM cards WHERE id = ?1", [cid], |r| {
                            r.get::<_, i64>(0)
                        })
                        .unwrap())
                })
                .unwrap()
        })
        .collect();
    assert!(due.windows(2).all(|w| w[0] < w[1]), "{due:?}");

    // The report shows them as notes of the book after the automatic rescan.
    let report = env.state.vocab_report(&env.uid).unwrap().unwrap();
    assert!(row(&report, "pig").existing_note_id.is_some());

    // An outline range: the range subdeck and the trecho tag; words of earlier scans are not added again.
    let cap3 = env.outline_id("Cap 3");
    let (_, r3) = env.scan(RangeSpec::Outline { ids: vec![cap3] });
    let out = env.generate(&r3.scan_uid, &["goose", "pig"], VocabDeckOptions::default());
    assert_eq!(out.deck_name, "Vocabulário::Livros::Animal Farm::Cap 3");
    assert_eq!(out.created, 1);
    assert_eq!(out.skipped_previous, vec!["pig".to_string()]);
    let goose = env.note(out.note_ids[0]);
    assert!(
        goose.tags.contains(&"trecho::cap-3".to_string()),
        "{:?}",
        goose.tags
    );
    assert!(goose.tags.contains(&"cap::03".to_string()));
    assert_eq!(env.deck_name(goose.deck_id), out.deck_name);

    // A page range: "p. 46-50" and trecho::p-46-50.
    let (_, r4) = env.scan(RangeSpec::Pages {
        text: "46-50".into(),
    });
    let out = env.generate(&r4.scan_uid, &["mouse"], VocabDeckOptions::default());
    assert_eq!(out.deck_name, "Vocabulário::Livros::Animal Farm::p. 46-50");
    let mouse = env.note(out.note_ids[0]);
    assert!(
        mouse.tags.contains(&"trecho::p-46-50".to_string()),
        "{:?}",
        mouse.tags
    );

    // Even moved out of the folder, a note made from this book is never created again.
    let words_deck = env.info.decks[fixture::DECK_WORDS];
    block_on(
        env.state
            .anki_cards_set_deck(pig.card_ids.clone(), words_deck),
    )
    .unwrap();
    let (_, again) = env.scan(RangeSpec::Pages {
        text: "21-45".into(),
    });
    assert!(row(&again, "pig").existing_note_id.is_some());
    let out = env.generate(
        &again.scan_uid,
        &["pig", "goose"],
        VocabDeckOptions::default(),
    );
    assert_eq!(out.created, 0);
    assert_eq!(
        out.skipped_previous.iter().collect::<BTreeSet<_>>(),
        ["goose".to_string(), "pig".to_string()].iter().collect()
    );

    // One subdeck per chapter, and the panel shows the chapter's subdeck.
    let (_, all) = env.scan(RangeSpec::All);
    let out = env.generate(
        &all.scan_uid,
        &["dog", "child"],
        VocabDeckOptions {
            per_chapter: true,
            ..VocabDeckOptions::default()
        },
    );
    assert_eq!(out.deck_name, "Vocabulário::Livros::Animal Farm");
    assert_eq!(
        out.decks,
        vec![
            "Vocabulário::Livros::Animal Farm::Cap 01".to_string(),
            "Vocabulário::Livros::Animal Farm::Cap 04".to_string(),
        ]
    );
    let panel = block_on(env.state.book_panel_info_at(&env.uid, Some(2))).unwrap();
    let chapter = panel.chapter_deck.unwrap();
    assert_eq!(chapter.name, "Vocabulário::Livros::Animal Farm::Cap 01");
    assert!(chapter.exists);
    let vocab = panel.vocab.unwrap();
    assert!(vocab.coverage_known > 0.0);
    assert_eq!(vocab.range_label, None);
    assert_eq!(panel.vocab_deck.name, "Vocabulário::Livros::Animal Farm");
    let panel = block_on(env.state.book_panel_info_at(&env.uid, Some(25))).unwrap();
    assert!(panel.chapter_deck.is_none(), "no Cap 03 subdeck");
}

/// "Gerar deck" with AI definitions (plan `docs/planos/fase-8.md` 5.1): the estimate, the job that fills the cache
/// batch by batch, the deck reading the cache. Simulated provider: no network, no real key.
#[test]
fn ai_definitions_fill_the_generated_deck_from_the_cache() {
    use core_ai::simulated::SimulatedProvider;
    use core_ai::{Completion, ProviderKind, Stop, Usage};
    use leitor_app::ai::{AiFunctionPatch, AiSettingsPatch};
    use leitor_app::ai_features::AiEstimateRequest;

    let env = Env::new();
    let (_, full) = env.scan(RangeSpec::All);
    let lemmas = ["pig", "harvest", "learner"];
    let wanted: Vec<String> = lemmas.iter().map(|l| l.to_string()).collect();
    // The rows are sent in the report's order, with their example sentence.
    let sent: Vec<&core_vocab::VocabRow> = full
        .rows
        .iter()
        .filter(|r| lemmas.contains(&r.lemma.as_str()))
        .collect();
    assert_eq!(sent.len(), 3);
    let answers: Vec<serde_json::Value> = sent
        .iter()
        .map(|r| {
            let (classe, def, pt) = match r.lemma.as_str() {
                "pig" => ("noun", "a farm animal kept for its meat", "porco"),
                "harvest" => ("noun", "the gathering of crops", "colheita"),
                _ => ("noun", "a person who is learning", "aprendiz"),
            };
            serde_json::json!({"lema": r.lemma, "classe": classe, "definicao": def, "traducao": pt})
        })
        .collect();
    let sim = Arc::new(SimulatedProvider::new(
        ProviderKind::Anthropic,
        vec![Ok(Completion {
            text: serde_json::json!({ "itens": answers }).to_string(),
            usage: Some(Usage {
                input: 600,
                output: 180,
                ..Usage::default()
            }),
            stop: Stop::Done,
        })],
    ));
    env.state.ai_hub().set_provider(sim.clone());

    // Without a configured provider nothing is estimated nor sent.
    let deck = || AiEstimateRequest::Deck {
        book_uid: env.uid.clone(),
        scan_uid: full.scan_uid.clone(),
        lemmas: wanted.clone(),
    };
    assert_eq!(
        env.state.ai_estimate(deck()).unwrap_err().code,
        "ai_disabled"
    );
    env.state
        .ai_settings_set(AiSettingsPatch {
            enrich: Some(AiFunctionPatch {
                provider: Some(Some(ProviderKind::Anthropic)),
                ..AiFunctionPatch::default()
            }),
            consent: vec![ProviderKind::Anthropic],
            ..AiSettingsPatch::default()
        })
        .unwrap();
    assert_eq!(env.state.ai_estimate(deck()).unwrap_err().code, "ai_no_key");
    env.state
        .ai_key_set(ProviderKind::Anthropic, "test-key-anthropic-TEST")
        .unwrap();

    let est = env.state.ai_estimate(deck()).unwrap();
    assert_eq!((est.to_send, est.cached, est.calls), (3, 0, 1));
    assert!(est.worst_usd > 0.0 && est.worst_usd < 0.05, "{est:?}");
    assert!(!est.needs_confirmation);
    assert_eq!(est.model, "claude-haiku-5-5");

    let started = env
        .state
        .ai_enrich_start(&env.uid, &full.scan_uid, wanted.clone(), false)
        .unwrap();
    assert_eq!((started.cached, started.to_send), (0, 3));
    let end = env
        .state
        .job_wait(started.job_id.as_deref().unwrap(), WAIT)
        .unwrap();
    assert_eq!(end.stage, JobStage::Done, "{end:?}");
    assert_eq!((end.done, end.total), (3, 3));
    let request = sim.last_request().unwrap();
    assert_eq!(request.max_output_tokens, 4000);
    assert!(!request.user.contains(TITLE), "the title is never sent");

    // Everything is cached now: no job, no call.
    let again = env
        .state
        .ai_enrich_start(&env.uid, &full.scan_uid, wanted.clone(), false)
        .unwrap();
    assert_eq!((again.job_id, again.cached, again.to_send), (None, 3, 0));
    assert_eq!(sim.calls(), 1);

    let out = env.generate(
        &full.scan_uid,
        &lemmas,
        VocabDeckOptions {
            enrich: leitor_app::vocab::deck::EnrichMode::Ai,
            ..VocabDeckOptions::default()
        },
    );
    let notes: Vec<_> = out.note_ids.iter().map(|id| env.note(*id)).collect();
    let pig = notes.iter().find(|n| n.fields[PALAVRA] == "pig").unwrap();
    assert_eq!(pig.fields[DEFINICAO], "a farm animal kept for its meat");
    assert_eq!(pig.fields[TRADUCAO], "porco");
    assert_eq!(pig.fields[CLASSE], "substantivo");

    let usage = env.state.ai_usage().unwrap();
    assert_eq!(usage.day.len(), 1);
    assert_eq!(
        (usage.day[0].feature.as_str(), usage.day[0].calls),
        ("enrich", 1)
    );
    assert!((usage.day_usd - (600.0 * 0.10 + 180.0 * 0.50) / 1e6).abs() < 1e-12);
}

/// Background enrichment (plan 5.3): only words added while it is on; an answer fills Definição/Tradução only where
/// the field is still as the app wrote it; a batch above the confirmation threshold pauses the queue.
#[test]
fn background_queue_enriches_new_words_without_overwriting_edits() {
    use core_ai::simulated::SimulatedProvider;
    use core_ai::{Completion, ProviderKind, Stop, Usage};
    use leitor_app::ai::{AiFunctionPatch, AiSettingsPatch};
    use leitor_app::ai_queue::QueueStep;

    let env = Env::new();
    let (_, full) = env.scan(RangeSpec::All);
    let answer = |items: serde_json::Value| -> core_ai::Result<Completion> {
        Ok(Completion {
            text: serde_json::json!({ "itens": items }).to_string(),
            usage: Some(Usage {
                input: 300,
                output: 80,
                ..Usage::default()
            }),
            stop: Stop::Done,
        })
    };
    let sim = Arc::new(SimulatedProvider::new(
        ProviderKind::Anthropic,
        vec![answer(serde_json::json!([
            {"lema": "pig", "classe": "noun", "definicao": "a farm animal", "traducao": "porco"},
            {"lema": "learner", "classe": "noun", "definicao": "a person who learns", "traducao": "aprendiz"}
        ]))],
    ));
    env.state.ai_hub().set_provider(sim.clone());
    env.state
        .ai_settings_set(AiSettingsPatch {
            enrich: Some(AiFunctionPatch {
                provider: Some(Some(ProviderKind::Anthropic)),
                ..AiFunctionPatch::default()
            }),
            consent: vec![ProviderKind::Anthropic],
            ..AiSettingsPatch::default()
        })
        .unwrap();
    env.state
        .ai_key_set(ProviderKind::Anthropic, "test-key-anthropic-TEST")
        .unwrap();
    let add = |lemma: &str| {
        let r = row(&full, lemma);
        env.state
            .vocab_add_word(&env.uid, lemma, r.first_page, &r.form)
            .unwrap()
            .note_id
    };

    // Off: words added now never enter the queue.
    let harvest = add("harvest");
    assert_eq!(env.state.ai_queue_get().unwrap().items.len(), 0);

    env.state
        .ai_settings_set(AiSettingsPatch {
            background_enrich: Some(true),
            ..AiSettingsPatch::default()
        })
        .unwrap();
    let pig = add("pig");
    let learner = add("learner");
    let queue = env.state.ai_queue_get().unwrap();
    assert_eq!((queue.enabled, queue.pending), (true, 2));
    assert!(
        queue.items[0].sentence.contains("pigs"),
        "{:?}",
        queue.items[0]
    );

    // The user writes their own translation before the queue runs: it stays.
    let mut fields = env.note(learner).fields;
    fields[TRADUCAO] = "estudante".into();
    block_on(env.state.anki_note_update(learner, fields, vec![])).unwrap();

    assert_eq!(env.state.ai_queue_step(), QueueStep::Worked);
    assert_eq!(sim.calls(), 1);
    let pig_note = env.note(pig);
    assert_eq!(pig_note.fields[TRADUCAO], "porco");
    assert_eq!(pig_note.fields[DEFINICAO], "a farm animal");
    let learner_note = env.note(learner);
    assert_eq!(
        learner_note.fields[TRADUCAO], "estudante",
        "an edit is never overwritten"
    );
    assert_eq!(learner_note.fields[DEFINICAO], "a person who learns");
    assert_eq!(
        env.note(harvest).fields[TRADUCAO],
        "",
        "never the words added before"
    );
    assert_eq!(env.state.ai_queue_get().unwrap().items.len(), 0);
    assert_eq!(env.state.ai_queue_step(), QueueStep::Idle);

    // A batch above the confirmation threshold pauses the queue and says why; nothing is sent.
    env.state
        .ai_settings_set(AiSettingsPatch {
            confirm_above_usd: Some(0.000_001),
            ..AiSettingsPatch::default()
        })
        .unwrap();
    add("windmill");
    assert_eq!(env.state.ai_queue_step(), QueueStep::Idle);
    let queue = env.state.ai_queue_get().unwrap();
    assert!(queue.paused);
    assert_eq!(queue.pending, 1);
    assert!(
        queue.status.as_deref().unwrap_or("").contains("pausada"),
        "{queue:?}"
    );
    assert_eq!(sim.calls(), 1);
    // Paused stays paused (the queue is kept).
    assert_eq!(env.state.ai_queue_step(), QueueStep::Idle);
    assert_eq!(env.state.ai_queue_get().unwrap().pending, 1);
}

#[test]
fn marks_underline_the_right_words() {
    let env = Env::new();
    let e = env.state.vocab_marks(&env.uid, &[21]).unwrap_err();
    assert_eq!(e.code, "vocab_not_scanned");
    env.scan(RangeSpec::All);
    let too_many: Vec<u32> = (0..21).collect();
    assert_eq!(
        env.state.vocab_marks(&env.uid, &too_many).unwrap_err().code,
        "invalid_input"
    );

    let page = 21;
    let words = env.state.doc_words(&env.uid, page).unwrap();
    let marks = env.state.vocab_marks(&env.uid, &[page]).unwrap();
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0].page, page);
    let marks = &marks[0].marks;
    // Every mark is exactly a word of the page (same text and rects), in page-word order.
    let mut at = 0;
    for m in marks {
        let i = words.words[at..]
            .iter()
            .position(|w| w.text == m.form && w.rects == m.rects)
            .unwrap_or_else(|| panic!("mark {m:?} is not a page word after {at}"))
            + at;
        at = i + 1;
    }
    let lemmas = |marks: &[leitor_app::VocabMark]| -> BTreeSet<String> {
        marks.iter().map(|m| m.lemma.clone()).collect()
    };
    let found = lemmas(marks);
    for unknown in ["windmill", "pig", "goose"] {
        assert!(found.contains(unknown), "{unknown} not marked: {found:?}");
    }
    let windmills: Vec<_> = marks.iter().filter(|m| m.lemma == "windmill").collect();
    assert_eq!(windmills.len(), 3, "windmill, windmills, windmill");
    assert!(
        windmills
            .iter()
            .all(|m| m.status == core_vocab::MarkStatus::Unknown)
    );
    let animals = marks.iter().find(|m| m.form == "animals").unwrap();
    assert_eq!(
        animals.status,
        core_vocab::MarkStatus::Learning,
        "new in the deck = amber"
    );
    for known in ["farm", "the", "of"] {
        assert!(!found.contains(known), "{known} is known");
    }
    assert!(!marks.iter().any(|m| m.form == "Napoleon"), "proper noun");

    // "Já sei" removes the mark at once.
    env.state
        .vocab_override_set(
            vec!["windmill".into()],
            Some(leitor_app::vocab::OverrideArg::Known),
        )
        .unwrap();
    let marks = env.state.vocab_marks(&env.uid, &[page]).unwrap();
    assert!(!lemmas(&marks[0].marks).contains("windmill"));

    // "Adicionar ao deck do livro": the word is new in the folder → amber, and the report says so after a rescan.
    let added = env
        .state
        .vocab_add_word(&env.uid, "pig", page, "pigs")
        .unwrap();
    assert_eq!(added.deck_name, "Vocabulário::Livros::Animal Farm");
    let note = env.note(added.note_id);
    assert_eq!(note.fields[PALAVRA], "pig");
    assert_eq!(
        note.fields[FONTE],
        core_anki::study::source::source_html(&env.uid, TITLE, page + 1, "pigs")
    );
    assert!(
        note.tags.contains(&"cap::03".to_string()),
        "{:?}",
        note.tags
    );
    let again = env
        .state
        .vocab_add_word(&env.uid, "pig", 3, "pigs")
        .unwrap();
    assert_eq!(again.note_id, added.note_id, "never twice");
    let marks = env.state.vocab_marks(&env.uid, &[page]).unwrap();
    let pig = marks[0].marks.iter().find(|m| m.lemma == "pig").unwrap();
    assert_eq!(pig.status, core_vocab::MarkStatus::Learning);
    env.settle();
    let job = env.state.vocab_rescan(&env.uid).unwrap();
    env.wait(&job);
    let report = env.state.vocab_report(&env.uid).unwrap().unwrap();
    assert_eq!(row(&report, "pig").status, Status::New);
    assert_eq!(row(&report, "windmill").status, Status::Known);

    // Warm marks are fast (spec 12.7: ≤ 50 ms per page; generous here for debug builds and slow CI).
    env.state.vocab_marks(&env.uid, &[page]).unwrap();
    let started = std::time::Instant::now();
    env.state.vocab_marks(&env.uid, &[page]).unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "{:?}",
        started.elapsed()
    );

    // "Definir palavra" knows the lemma, its status in the scan and the family.
    let def = block_on(env.state.vocab_define("learners", Some(&env.uid))).unwrap();
    assert_eq!(def.lemma, "learner");
    assert_eq!(def.family.unwrap().lemma, "learn");
    assert!(def.status.is_some());
}

#[test]
fn jobs_report_progress_cancel_and_one_scan_per_book() {
    // The hook blocks the first job at the text stage until the test lets it go.
    let (tx, rx) = mpsc::channel::<()>();
    let rx = Arc::new(Mutex::new(rx));
    let hold = Arc::new(Mutex::new(true));
    let gate = Arc::clone(&hold);
    let env = Env::with_sink(Some(Arc::new(move |p: &JobProgress| {
        if p.stage == JobStage::Text && *gate.lock().unwrap() {
            let _ = rx.lock().unwrap().recv_timeout(Duration::from_secs(60));
        }
    })));
    let first = env.start(RangeSpec::All);
    // While it runs, a second start of the same scan returns the same job.
    let second = env.start(RangeSpec::All);
    assert_eq!(second.job_id, first.job_id);
    assert_eq!(second.scan_uid, first.scan_uid);
    let status = env.state.job_status(&first.job_id).unwrap();
    assert!(!status.stage.is_terminal());
    // Cancel while reading the text.
    assert!(env.state.job_cancel(&first.job_id));
    tx.send(()).unwrap();
    let end = env.wait(&first);
    assert_eq!(end.stage, JobStage::Cancelled, "{end:?}");
    let row = env
        .state
        .with_store(|s| s.vocab_scan(&first.scan_uid))
        .unwrap()
        .unwrap();
    assert_eq!(row.status, core_store::VocabScanStatus::Cancelled);
    assert!(env.state.vocab_report(&env.uid).unwrap().is_none());
    assert!(env.state.job_status("unknown").is_none());

    // A full run reports its stages in order.
    *hold.lock().unwrap() = false;
    let job = env.start(RangeSpec::All);
    let end = env.wait(&job);
    assert_eq!(end.stage, JobStage::Done);
    assert_eq!(end.scan_uid, job.scan_uid);
    assert_eq!(
        env.stages(&job.job_id),
        [
            JobStage::Text,
            JobStage::Lemmas,
            JobStage::Known,
            JobStage::Compare,
            JobStage::Done
        ]
    );
    let job = env.start(RangeSpec::Pages { text: "5".into() });
    env.wait(&job);
    assert_eq!(
        env.stages(&job.job_id),
        [JobStage::Known, JobStage::Compare, JobStage::Done]
    );
    let events = env.events.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .filter(|e| e.job_id == job.job_id)
            .all(|e| e.reused)
    );

    // Another range while a scan runs (e.g. the rescan after a deck generation): the running scan stops and the new
    // one runs; its report is the one shown, never the other range's.
    let older = env.start(RangeSpec::Pages {
        text: "1-30".into(),
    });
    let newer = env.start(RangeSpec::Pages { text: "7".into() });
    assert_ne!(newer.job_id, older.job_id);
    assert!(
        env.state
            .job_status(&older.job_id)
            .is_none_or(|p| p.stage.is_terminal())
    );
    assert_eq!(env.wait(&newer).stage, JobStage::Done);
    let report = env.state.vocab_report(&env.uid).unwrap().unwrap();
    assert_eq!(report.scan_uid, newer.scan_uid);
    assert_eq!(report.range.pages, vec![[6, 6]]);

    // A scan left running by a crash is failed when the database opens again.
    let running = env
        .state
        .with_store(|s| {
            s.insert_vocab_scan(&core_store::NewVocabScan {
                book_uid: env.uid.clone(),
                root_deck_id: env.root,
                deck_ids: vec![],
                config: serde_json::json!({}),
                range: serde_json::json!({"kind": "all"}),
            })
        })
        .unwrap();
    let data = env.state.data_dir().to_path_buf();
    env.state.shutdown();
    let reopened = AppState::new(data);
    let row = reopened
        .with_store(|s| s.vocab_scan(&running))
        .unwrap()
        .unwrap();
    assert_eq!(row.status, core_store::VocabScanStatus::Failed);
    assert!(row.error.is_some());
    reopened.shutdown();
}

#[test]
fn settings_folder_and_mapping() {
    let env = Env::new();
    let s = env.state.vocab_settings_get().unwrap();
    assert_eq!(s.root_deck_id, None);
    assert_eq!(s.config, ScanConfig::default());
    let oxford = env.info.decks[fixture::DECK_VOCAB_OXFORD];
    let s = env
        .state
        .vocab_settings_set(
            serde_json::from_value(serde_json::json!({
                "rootDeckId": env.root,
                "excludedDeckIds": [oxford],
                "config": {"knownIvlDays": 30, "countYoung": true}
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(s.root_name.as_deref(), Some(fixture::DECK_VOCAB));
    assert_eq!(s.excluded_deck_ids, vec![oxford]);
    assert_eq!(s.config.known_ivl_days, 30);
    assert!(s.config.count_young);
    assert_eq!(
        env.state
            .vocab_settings_set(
                serde_json::from_value(serde_json::json!({"rootDeckId": 5})).unwrap()
            )
            .unwrap_err()
            .code,
        "deck_not_found"
    );

    let folder = env.state.vocab_folder(env.root).unwrap();
    assert_eq!(folder.root.name, fixture::DECK_VOCAB);
    assert_eq!(folder.decks[0].deck_id, env.root);
    assert_eq!(folder.decks.len(), 4);
    let word_nt = env.info.notetypes["vocabWord"];
    let front_nt = env.info.notetypes["vocabFront"];
    let word = folder
        .notetypes
        .iter()
        .find(|n| n.notetype_id == word_nt)
        .unwrap();
    assert_eq!(word.suggested_field, "Word");
    assert_eq!(word.mapped_field, None);
    assert_eq!(word.samples, ["learn", "happy", "glad", "quick", "feel"]);
    let front = folder
        .notetypes
        .iter()
        .find(|n| n.notetype_id == front_nt)
        .unwrap();
    assert_eq!(front.suggested_field, "Front");
    assert_eq!(front.samples.len(), 5);

    let samples = env
        .state
        .vocab_mapping_samples(env.root, vec![], front_nt, "Back".into())
        .unwrap();
    assert_eq!(samples[0], "interesse");
    let none = env
        .state
        .vocab_mapping_samples(env.root, vec![oxford], front_nt, "Front".into())
        .unwrap();
    assert!(none.is_empty(), "Oxford excluded");
    assert_eq!(
        env.state
            .vocab_mapping_samples(env.root, vec![], front_nt, "Nope".into())
            .unwrap_err()
            .code,
        "invalid_input"
    );
    env.state.vocab_mapping_set(word_nt, "Word".into()).unwrap();
    let mappings = env.state.vocab_mapping_get().unwrap();
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].field, "Word");
    let folder = env.state.vocab_folder(env.root).unwrap();
    let word = folder
        .notetypes
        .iter()
        .find(|n| n.notetype_id == word_nt)
        .unwrap();
    assert_eq!(word.mapped_field.as_deref(), Some("Word"));
    // A type with a code role cannot be a vocabulary type.
    let code = env.info.notetypes["usuarioComando"];
    block_on(env.state.code_mapping_set(
        code,
        Some(core_store::CodeMappingFields {
            question: "Frente".into(),
            answer: "Comando".into(),
            notes: None,
        }),
    ))
    .unwrap();
    assert_eq!(
        env.state
            .vocab_mapping_set(code, "Frente".into())
            .unwrap_err()
            .code,
        "mapping_conflict"
    );
    assert_eq!(
        env.state
            .vocab_mapping_set(word_nt, "Nope".into())
            .unwrap_err()
            .code,
        "invalid_input"
    );

    let info = env.state.vocab_data_info();
    assert!(info.available);
}
