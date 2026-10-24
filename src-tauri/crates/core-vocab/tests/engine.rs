//! The comparison, metrics and report rules with a small in-memory lexicon (no data pack needed).

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use core_vocab::{
    BookTable, CompareInput, KnownIndex, KnownNote, Lexicon, NoteStatus, OutlineNode,
    OverrideStatus, PageInput, Pos, RangeSpec, RowGroup, RowOrder, ScanConfig, ScanResult, Status,
    StatusSource, SuspendedPolicy, TestLexicon, VocabNoteCtx, VocabRow, build_book_table, chapters,
    compare, order_rows, resolve_range, vocab_note_fields,
};

fn lex() -> Lexicon {
    Lexicon::from_parts(
        TestLexicon::default()
            .with_lemmas(Pos::Noun, &["cat", "dog", "owl", "fox", "elk"])
            .with_definition("owl", Pos::Noun, "a bird of prey that hunts at night")
            .with_stopwords(&["the"])
            .with_zipf(&[
                ("the", 7.7),
                ("cat", 4.5),
                ("dog", 4.9),
                ("owl", 3.4),
                ("fox", 3.8),
                ("elk", 2.1),
            ]),
    )
}

/// Page text with `n` copies of each word, lowercase, as one long sentence per word group.
fn page(words: &[(&str, usize)]) -> String {
    words
        .iter()
        .map(|(w, n)| vec![*w; *n].join(" "))
        .collect::<Vec<_>>()
        .join(" ")
        + "."
}

fn table(lex: &Lexicon, texts: &[String]) -> BookTable {
    let pages: Vec<PageInput> = texts
        .iter()
        .enumerate()
        .map(|(i, t)| PageInput {
            unit: i as u32,
            text: t,
        })
        .collect();
    build_book_table(&pages, lex, &AtomicBool::new(false), &mut |_, _| {}).expect("table")
}

fn notes(words: &[(&str, NoteStatus)]) -> Vec<KnownNote> {
    words
        .iter()
        .enumerate()
        .map(|(i, (w, s))| KnownNote {
            note_id: i as i64 + 1,
            field_html: (*w).to_string(),
            status: *s,
        })
        .collect()
}

struct Scan<'a> {
    lex: &'a Lexicon,
    table: &'a BookTable,
    known: Vec<KnownNote>,
    config: ScanConfig,
    overrides: HashMap<String, OverrideStatus>,
    previous: HashMap<String, i64>,
    range: RangeSpec,
    outline: Vec<OutlineNode>,
}

impl<'a> Scan<'a> {
    fn new(lex: &'a Lexicon, table: &'a BookTable, known: &[(&str, NoteStatus)]) -> Self {
        Scan {
            lex,
            table,
            known: notes(known),
            config: ScanConfig::default(),
            overrides: HashMap::new(),
            previous: HashMap::new(),
            range: RangeSpec::All,
            outline: Vec::new(),
        }
    }

    fn run(&self) -> ScanResult {
        let idx = KnownIndex::build(&self.known, self.lex, &self.config);
        let range =
            resolve_range(&self.range, &self.outline, self.table.page_count).expect("range");
        let chapters = chapters(&self.outline, self.table.page_count);
        compare(CompareInput {
            lemmas: &self.table.lemmas,
            pages: &self.table.pages,
            range: &range,
            chapters: &chapters,
            known: &idx,
            overrides: &self.overrides,
            previous_notes: &self.previous,
            config: &self.config,
            lex: self.lex,
        })
    }
}

fn row<'r>(r: &'r ScanResult, lemma: &str) -> &'r VocabRow {
    r.rows
        .iter()
        .find(|x| x.lemma == lemma)
        .unwrap_or_else(|| panic!("no row {lemma}"))
}

fn hundred() -> String {
    page(&[
        ("the", 50),
        ("cat", 30),
        ("dog", 10),
        ("owl", 5),
        ("fox", 3),
        ("elk", 2),
    ])
}

const KNOWN: &[(&str, NoteStatus)] = &[("cat", NoteStatus::Mature), ("dog", NoteStatus::Learning)];

#[test]
fn coverage_and_curve_by_hand() {
    let lex = lex();
    let t = table(&lex, &[hundred()]);
    let r = Scan::new(&lex, &t, KNOWN).run();
    let m = &r.metrics;
    assert_eq!(m.total_tokens, 100);
    assert_eq!(m.known_tokens, 80);
    assert_eq!(m.learning_tokens, 10);
    assert!((m.coverage_known - 0.80).abs() < 1e-9);
    assert!((m.coverage_with_learning - 0.90).abs() < 1e-9);
    assert_eq!(m.unknown_lemmas, 3);
    assert_eq!(m.unknown_lemmas_repeated, 3);
    // 90% → +owl 95% → +fox 98% → +elk 100%.
    assert_eq!(m.words_to_95, 1);
    assert_eq!(m.words_to_98, 2);
    let curve: Vec<(u32, f64)> = m
        .curve
        .iter()
        .map(|p| (p.n, (p.coverage * 100.0).round()))
        .collect();
    assert_eq!(curve, vec![(0, 90.0), (1, 95.0), (2, 98.0), (3, 100.0)]);
    assert_eq!(row(&r, "the").status_source, Some(StatusSource::Function));
    assert_eq!(row(&r, "cat").status, Status::Known);
    assert_eq!(row(&r, "dog").status, Status::Learning);
    let owl = row(&r, "owl");
    assert_eq!(
        (owl.status, owl.default_selected, owl.occurrences),
        (Status::Unknown, true, 5)
    );
    assert!(owl.rare.eq(&false));
    assert!(row(&r, "elk").rare);
    assert!(!row(&r, "dog").default_selected);
}

#[test]
fn already_reached_targets_are_zero() {
    let lex = lex();
    let t = table(&lex, &[page(&[("the", 99), ("owl", 1)])]);
    let r = Scan::new(&lex, &t, &[]).run();
    assert_eq!((r.metrics.words_to_95, r.metrics.words_to_98), (0, 0));
}

#[test]
fn function_word_option() {
    let lex = lex();
    let t = table(&lex, &[hundred()]);
    let mut s = Scan::new(&lex, &t, KNOWN);
    s.config.function_words_known = false;
    let r = s.run();
    assert_eq!(r.metrics.known_tokens, 30);
    assert_eq!(row(&r, "the").status, Status::Unknown);
}

#[test]
fn overrides_win() {
    let lex = lex();
    let t = table(&lex, &[hundred()]);
    let mut s = Scan::new(&lex, &t, KNOWN);
    s.overrides.insert("owl".into(), OverrideStatus::Known);
    s.overrides.insert("elk".into(), OverrideStatus::Ignored);
    s.overrides.insert("fox".into(), OverrideStatus::Proper);
    s.overrides.insert("cat".into(), OverrideStatus::Ignored);
    let r = s.run();
    assert_eq!(row(&r, "owl").status_source, Some(StatusSource::Override));
    assert_eq!(row(&r, "elk").status, Status::Ignored);
    assert_eq!(row(&r, "fox").group, RowGroup::Proper);
    // Total without ignored (elk 2, cat 30) and proper (fox 3).
    assert_eq!(r.metrics.total_tokens, 65);
    assert_eq!(r.metrics.known_tokens, 55);
    assert_eq!(r.metrics.proper_lemmas, 1);
}

#[test]
fn suspended_and_young_policies() {
    let lex = lex();
    let t = table(&lex, &[hundred()]);
    let mut s = Scan::new(
        &lex,
        &t,
        &[("cat", NoteStatus::Mature), ("dog", NoteStatus::Suspended)],
    );
    let r = s.run();
    assert_eq!(row(&r, "dog").status, Status::Suspended);
    assert!(
        !row(&r, "dog").default_selected,
        "already a note in the folder"
    );
    assert_eq!(r.metrics.unknown_lemmas, 4);
    s.config.suspended_policy = SuspendedPolicy::Known;
    assert_eq!(row(&s.run(), "dog").status, Status::Known);

    let mut s = Scan::new(&lex, &t, KNOWN);
    s.config.count_young = true;
    let r = s.run();
    assert_eq!(row(&r, "dog").status, Status::Known);
    assert_eq!(r.metrics.known_tokens, 90);
    // New in the deck counts with learning.
    let r = Scan::new(&lex, &t, &[("dog", NoteStatus::New)]).run();
    assert_eq!(row(&r, "dog").status, Status::New);
    assert_eq!(r.metrics.learning_tokens, 10);
}

#[test]
fn previous_scan_notes_are_not_selected() {
    let lex = lex();
    let t = table(&lex, &[hundred()]);
    let mut s = Scan::new(&lex, &t, KNOWN);
    s.previous.insert("owl".into(), 42);
    let r = s.run();
    let owl = row(&r, "owl");
    assert_eq!(owl.existing_note_id, Some(42));
    assert!(!owl.default_selected);
    assert!(row(&r, "fox").default_selected);
}

#[test]
fn metrics_only_for_the_range_and_chapters() {
    let lex = lex();
    let p1 = page(&[("cat", 10), ("owl", 10)]);
    let p2 = page(&[("cat", 5), ("fox", 5)]);
    let p3 = page(&[("dog", 4), ("elk", 1)]);
    let t = table(&lex, &[p1, p2, p3]);
    let mut s = Scan::new(&lex, &t, KNOWN);
    s.outline = vec![
        OutlineNode {
            title: "One".into(),
            page: Some(0),
            children: vec![],
        },
        OutlineNode {
            title: "Two".into(),
            page: Some(1),
            children: vec![],
        },
    ];
    s.range = RangeSpec::Pages { text: "2-3".into() };
    let r = s.run();
    assert_eq!(r.metrics.total_tokens, 15);
    assert_eq!(r.metrics.known_tokens, 5);
    assert!(r.rows.iter().all(|x| x.lemma != "owl"));
    let cat = row(&r, "cat");
    assert_eq!(
        (cat.first_page, cat.occurrences, cat.pages.clone()),
        (1, 5, vec![1])
    );
    // Only the chapters touching the range, counted over the intersection.
    assert_eq!(r.chapters.len(), 1);
    assert_eq!(r.chapters[0].label, "Two");
    assert_eq!(r.chapters[0].total_tokens, 15);
    assert_eq!(row(&r, "fox").chapter, Some(2));

    s.range = RangeSpec::Outline {
        ids: vec!["0".into()],
    };
    let r = s.run();
    assert_eq!(r.metrics.total_tokens, 20);
    assert_eq!(r.chapters.len(), 1);
}

#[test]
fn orders_rows() {
    let lex = lex();
    let t = table(
        &lex,
        &[page(&[("fox", 1), ("owl", 3)]), page(&[("elk", 5)])],
    );
    let mut rows = Scan::new(&lex, &t, &[]).run().rows;
    order_rows(&mut rows, RowOrder::Reading);
    assert_eq!(
        rows.iter().map(|r| r.lemma.as_str()).collect::<Vec<_>>(),
        ["fox", "owl", "elk"]
    );
    order_rows(&mut rows, RowOrder::Frequency);
    assert_eq!(
        rows.iter().map(|r| r.lemma.as_str()).collect::<Vec<_>>(),
        ["elk", "owl", "fox"]
    );
}

#[test]
fn note_fields() {
    let lex = Lexicon::from_parts(TestLexicon::sample().with_definition(
        "windmill",
        Pos::Noun,
        "a mill <powered> by wind",
    ));
    let text = "The animals worked very hard to finish the building of the windmill & the barn before winter.".to_string();
    let t = table(&lex, &[String::new(), text]);
    let r = Scan::new(&lex, &t, &[]).run();
    let w = row(&r, "windmill");
    let f = vocab_note_fields(
        w,
        &VocabNoteCtx {
            book_uid: "uid-1".into(),
            title: "Animal Farm".into(),
            defn: lex.definition("windmill", w.pos),
            book_occurrences: 41,
            card2: false,
        },
    );
    assert_eq!(f.palavra, "windmill");
    assert_eq!(f.lema, "windmill");
    assert_eq!(f.classe, "substantivo");
    assert_eq!(f.definicao, "a mill &lt;powered&gt; by wind");
    assert_eq!(f.traducao, "");
    assert_eq!(
        f.exemplo,
        "The animals worked very hard to finish the building of the <b>windmill</b> &amp; the barn before winter."
    );
    assert_eq!((f.fonte_page, f.fonte_query.as_str()), (2, "windmill"));
    assert_eq!(f.frequencia, "41");
    assert_eq!(f.familia, "");
    assert_eq!(f.card2, "");
}

#[test]
fn results_serialize_camel_case() {
    let lex = lex();
    let t = table(&lex, &[hundred()]);
    let r = Scan::new(&lex, &t, KNOWN).run();
    let v = serde_json::to_value(&r).expect("json");
    assert!(v["metrics"]["wordsTo95"].is_number());
    let owl = v["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .find(|x| x["lemma"] == "owl")
        .expect("owl");
    assert_eq!(owl["status"], "unknown");
    assert_eq!(owl["group"], "main");
    assert_eq!(owl["pos"], "n");
    assert_eq!(owl["defaultSelected"], true);
    let spec: RangeSpec = serde_json::from_str(r#"{"kind":"pages","text":"21-45"}"#).expect("spec");
    assert_eq!(
        spec,
        RangeSpec::Pages {
            text: "21-45".into()
        }
    );
    let cfg: ScanConfig = serde_json::from_str(r#"{"derivedPolicy":"known"}"#).expect("cfg");
    assert_eq!(cfg.known_ivl_days, 21);
}

/// Spec 12.3 D.3/D.4: a morphy candidate kept only because it is in the user's index ("vlog" is not in WordNet)
/// makes the inflected forms known, in the report and in the reading marks; a WordNet lemma of another part of
/// speech ("new" from "news") is not a candidate.
#[test]
fn index_only_candidates_count_as_known() {
    let lex = Lexicon::from_parts(
        TestLexicon::default()
            .with_lemmas(Pos::Noun, &["cat", "news"])
            .with_lemmas(Pos::Adj, &["new"])
            .with_zipf(&[("cat", 4.5), ("news", 5.0), ("new", 6.0)]),
    );
    let t = table(
        &lex,
        &[page(&[
            ("vlogs", 3),
            ("vlogged", 2),
            ("news", 2),
            ("cat", 1),
            ("blogs", 1),
        ])],
    );
    let known = &[
        ("vlog", NoteStatus::Mature),
        ("new", NoteStatus::Mature),
        ("blog", NoteStatus::Learning),
    ];
    let r = Scan::new(&lex, &t, known).run();
    for w in ["vlogs", "vlogged"] {
        let x = row(&r, w);
        assert_eq!(
            (x.status, x.status_source, x.default_selected),
            (Status::Known, Some(StatusSource::Deck), false),
            "{w}"
        );
    }
    assert_eq!(row(&r, "blogs").status, Status::Learning);
    assert_eq!(row(&r, "news").status, Status::Unknown);
    assert_eq!(row(&r, "cat").status, Status::Unknown);

    let idx = KnownIndex::build(&notes(known), &lex, &ScanConfig::default());
    let oracle = core_vocab::StatusOracle::new(
        idx,
        HashMap::new(),
        ScanConfig::default(),
        std::sync::Arc::new(lex),
    );
    let marks = oracle.classify_words(&[("vlogs", false), ("news", false), ("blogs", false)]);
    assert_eq!(marks[0], None);
    assert_eq!(
        marks[1].as_ref().map(|m| m.status),
        Some(core_vocab::MarkStatus::Unknown)
    );
    assert_eq!(
        marks[2].as_ref().map(|m| m.status),
        Some(core_vocab::MarkStatus::Learning)
    );
    // The detailed status behind the colors (EPUB marks): same words, same verdicts.
    let detailed = oracle.classify_detailed(&[("vlogs", false), ("news", false), ("blogs", false)]);
    assert_eq!(detailed[0], None);
    assert_eq!(detailed[1].as_ref().map(|d| d.1), Some(Status::Unknown));
    assert_eq!(detailed[2].as_ref().map(|d| d.1), Some(Status::Learning));
    // Same lemmas as the marks.
    assert_eq!(
        detailed[1].as_ref().map(|d| d.0.as_str()),
        marks[1].as_ref().map(|m| m.lemma.as_str())
    );
}
