//! Nothing panics on arbitrary input (fuzz-ish, deterministic).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use core_vocab::{
    BaseRef, CompareInput, KnownIndex, KnownNote, Lexicon, NoteStatus, OutlineNode, PageInput,
    RangeSpec, RowGroup, ScanConfig, Status, StatusOracle, TestLexicon, VocabNoteCtx, VocabRow,
    build_book_table, chapters, clean_field, clean_pages, compare, lemmatize, outline_ranges,
    parse_pages, resolve_range, sample_tokens, single_word, slug, suggest_field, vocab_deck_names,
    vocab_note_fields,
};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const PIECES: &[&str] = &[
    "the",
    "Napoleon",
    "windmill",
    "learning",
    "'s",
    "n't",
    "’",
    "-\n",
    "\n",
    " ",
    ".",
    "!",
    "?",
    "—",
    "–",
    "-",
    "1984",
    "XIV",
    "I",
    "http://x.y/z",
    "a@b.c",
    "é",
    "\u{301}",
    "🐷",
    "日本語",
    "\u{0}",
    "\u{AD}",
    "\t",
    "\"",
    "(",
    ")",
    "[",
    "]",
    "{{c1::",
    "}}",
    "<b>",
    "</b>",
    "&amp;",
    "&#x;",
    "[sound:",
    "look",
    "up",
    "Mr.",
    "U.S.A.",
    "o'clock",
    "ﬁ",
    "İ",
    "ß",
    "\u{200B}",
    "\u{FEFF}",
    "\r\n",
];

fn garbage(rng: &mut Rng, len: usize) -> String {
    let mut s = String::new();
    for _ in 0..len {
        if rng.below(10) == 0 {
            // A random scalar value.
            let c = char::from_u32((rng.next() % 0x11_0000) as u32).unwrap_or('?');
            s.push(c);
        } else {
            s.push_str(PIECES[rng.below(PIECES.len())]);
        }
    }
    s
}

fn outline(rng: &mut Rng, depth: usize) -> Vec<OutlineNode> {
    (0..rng.below(4))
        .map(|_| OutlineNode {
            title: garbage(rng, 3),
            page: if rng.below(4) == 0 {
                None
            } else {
                Some((rng.next() % 400) as u32)
            },
            children: if depth < 4 {
                outline(rng, depth + 1)
            } else {
                Vec::new()
            },
        })
        .collect()
}

#[test]
fn engine_never_panics_on_garbage() {
    let lex = Arc::new(Lexicon::from_parts(TestLexicon::sample()));
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for round in 0..60 {
        let n_pages = rng.below(12);
        let texts: Vec<String> = (0..n_pages)
            .map(|_| {
                let len = rng.below(300);
                garbage(&mut rng, len)
            })
            .collect();
        let pages: Vec<PageInput> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| PageInput {
                unit: (i * (1 + round % 3)) as u32,
                text: t,
            })
            .collect();
        let _ = clean_pages(&pages);
        let table =
            build_book_table(&pages, &lex, &AtomicBool::new(false), &mut |_, _| {}).expect("table");
        let notes: Vec<KnownNote> = (0..rng.below(20))
            .map(|i| KnownNote {
                note_id: i as i64,
                field_html: garbage(&mut rng, 4),
                status: [
                    NoteStatus::Mature,
                    NoteStatus::Learning,
                    NoteStatus::New,
                    NoteStatus::Suspended,
                ][i % 4],
            })
            .collect();
        let idx = KnownIndex::build(&notes, &lex, &ScanConfig::default());
        let ol = outline(&mut rng, 0);
        let page_count = table.page_count;
        let _ = outline_ranges(&ol, page_count);
        let chs = chapters(&ol, page_count);
        let specs = [
            RangeSpec::All,
            RangeSpec::Pages {
                text: garbage(&mut rng, 3),
            },
            RangeSpec::Pages {
                text: format!("1-{}", page_count.max(1)),
            },
            RangeSpec::Outline {
                ids: vec!["0".into(), "0.0".into(), garbage(&mut rng, 1)],
            },
            RangeSpec::Outline {
                ids: vec!["0".into()],
            },
        ];
        for spec in &specs {
            let Ok(range) = resolve_range(spec, &ol, page_count) else {
                continue;
            };
            let r = compare(CompareInput {
                lemmas: &table.lemmas,
                pages: &table.pages,
                range: &range,
                chapters: &chs,
                known: &idx,
                overrides: &HashMap::new(),
                previous_notes: &HashMap::new(),
                config: &ScanConfig::default(),
                lex: &lex,
            });
            assert!(r.metrics.coverage_known <= 1.0 + 1e-9);
            for row in r.rows.iter().take(5) {
                let _ = vocab_note_fields(
                    row,
                    &VocabNoteCtx {
                        book_uid: "u".into(),
                        title: "t".into(),
                        defn: None,
                        book_occurrences: 1,
                        card2: true,
                    },
                );
            }
            let _ = vocab_deck_names(
                Some(&garbage(&mut rng, 2)),
                &garbage(&mut rng, 2),
                &range,
                round % 2 == 0,
            );
        }
        let oracle = StatusOracle::new(idx, HashMap::new(), ScanConfig::default(), lex.clone());
        let words: Vec<String> = (0..20).map(|_| garbage(&mut rng, 1)).collect();
        let pairs: Vec<(&str, bool)> = words
            .iter()
            .map(|w| (w.as_str(), rng.below(2) == 0))
            .collect();
        assert_eq!(oracle.classify_words(&pairs).len(), pairs.len());
        let _ = sample_tokens(&pages, &lex, None, rng.below(50), round as u64);
        let g = garbage(&mut rng, 20);
        let _ = (
            clean_field(&g),
            slug(&g),
            single_word(&g),
            lemmatize(&g, &lex, None),
            parse_pages(&g, 10),
        );
        let _ = suggest_field(&[g.clone(), garbage(&mut rng, 2)]);
    }
}

#[test]
fn huge_inputs() {
    let lex = Lexicon::from_parts(TestLexicon::sample());
    let word = "a".repeat(1_000_000);
    let line = "pig ".repeat(50_000);
    let pages = [
        PageInput {
            unit: 0,
            text: &word,
        },
        PageInput {
            unit: u32::MAX,
            text: &line,
        },
        PageInput { unit: 5, text: "" },
    ];
    let t = build_book_table(&pages, &lex, &AtomicBool::new(false), &mut |_, _| {}).expect("table");
    assert_eq!(t.page_count, u32::MAX);
    assert!(
        t.lemmas
            .iter()
            .any(|l| l.lemma == "pig" && l.occurrences == 50_000)
    );
    assert!(parse_pages(&"1,".repeat(100_000), 10).is_err());
    let _ = lemmatize(&word, &lex, None);
    let _ = clean_field(&"<".repeat(100_000));
}

#[test]
fn note_fields_with_bad_spans() {
    let row = VocabRow {
        lemma: "x".into(),
        form: "X".into(),
        pos: None,
        group: RowGroup::Forms,
        status: Status::Known,
        status_source: None,
        occurrences: 1,
        first_page: u32::MAX,
        pages: vec![],
        zipf: None,
        rare: true,
        example: Some("é🐷".into()),
        example_span: Some([1, 99]),
        example_page: None,
        base: Some(BaseRef {
            lemma: "y".into(),
            status: Status::Known,
        }),
        family: None,
        existing_note_id: None,
        default_selected: false,
        chapter: None,
        position: 0,
    };
    let f = vocab_note_fields(
        &row,
        &VocabNoteCtx {
            book_uid: "u".into(),
            title: "t".into(),
            defn: None,
            book_occurrences: 0,
            card2: false,
        },
    );
    assert_eq!(f.palavra, "x");
    assert_eq!(f.fonte_page, u32::MAX);
}
