//! Performance targets (spec 12.8; release only, `cargo test --release -p core-vocab -- --ignored`): the table of a
//! 300-page / 100k-word book in ≤ 2 s on one core, comparing ~10k lemmas in ≤ 300 ms, loading the lexicon in
//! ≤ 1.5 s. The text is generated from the frequency list (nothing is committed).

mod common;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use core_vocab::{
    CompareInput, DATA_FILE, KnownIndex, KnownNote, Lexicon, NoteStatus, PageInput, RangeSpec,
    ScanConfig, build_book_table, compare, resolve_range,
};

fn words(limit: usize) -> Vec<String> {
    let conn = rusqlite::Connection::open(common::data_dir().join(DATA_FILE)).expect("db");
    let mut st = conn
        .prepare("SELECT word FROM freq WHERE word GLOB '[a-z]*' AND word NOT GLOB '*[^a-z]*' ORDER BY zipf DESC, word LIMIT ?1")
        .expect("stmt");
    st.query_map([limit as i64], |r| r.get::<_, String>(0))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("words")
}

/// ~100k words in 300 pages: half from the 300 most frequent words, half uniform over the top 20k.
pub fn generated_book(vocab: &[String]) -> Vec<String> {
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut pages = Vec::with_capacity(300);
    for _ in 0..300 {
        let mut page = String::new();
        let mut count = 0;
        while count < 334 {
            let len = 8 + (next() % 14) as usize;
            for i in 0..len {
                let pick = if next() % 2 == 0 {
                    (next() % 300) as usize
                } else {
                    (next() % vocab.len() as u64) as usize
                };
                let w = &vocab[pick.min(vocab.len() - 1)];
                if i == 0 {
                    let mut c = w.chars();
                    if let Some(f) = c.next() {
                        page.extend(f.to_uppercase());
                        page.push_str(c.as_str());
                    }
                } else {
                    page.push(' ');
                    page.push_str(w);
                }
                if i > 0 && i % 9 == 0 {
                    page.push('\n');
                }
            }
            page.push_str(". ");
            count += len;
        }
        pages.push(page);
    }
    pages
}

#[test]
#[ignore = "release-mode performance test"]
fn perf_lexicon_table_compare() {
    let t = Instant::now();
    let Some(_) = common::lexicon() else { return };
    let lex = Lexicon::open(&common::data_dir().join(DATA_FILE)).expect("open");
    let open = t.elapsed();
    eprintln!("Lexicon::open: {open:?}");
    assert!(open.as_secs_f64() <= 1.5, "open took {open:?}");

    let vocab = words(20_000);
    let texts = generated_book(&vocab);
    let pages: Vec<PageInput> = texts
        .iter()
        .enumerate()
        .map(|(i, t)| PageInput {
            unit: i as u32,
            text: t,
        })
        .collect();
    let n_words: usize = texts.iter().map(|t| t.split_whitespace().count()).sum();
    assert!(n_words >= 100_000, "{n_words}");

    let t = Instant::now();
    let table =
        build_book_table(&pages, &lex, &AtomicBool::new(false), &mut |_, _| {}).expect("table");
    let build = t.elapsed();
    eprintln!(
        "table: {n_words} words, {} lemmas, {} page rows in {build:?}",
        table.lemmas.len(),
        table.pages.len()
    );
    assert!(build.as_secs_f64() <= 2.0, "table took {build:?}");
    assert!(table.lemmas.len() >= 10_000, "{}", table.lemmas.len());

    let notes: Vec<KnownNote> = vocab
        .iter()
        .take(5_000)
        .enumerate()
        .map(|(i, w)| KnownNote {
            note_id: i as i64,
            field_html: w.clone(),
            status: NoteStatus::Mature,
        })
        .collect();
    let config = ScanConfig::default();
    let idx = KnownIndex::build(&notes, &lex, &config);
    let range = resolve_range(&RangeSpec::All, &[], table.page_count).expect("range");
    let t = Instant::now();
    let r = compare(CompareInput {
        lemmas: &table.lemmas,
        pages: &table.pages,
        range: &range,
        chapters: &[],
        known: &idx,
        overrides: &HashMap::new(),
        previous_notes: &HashMap::new(),
        config: &config,
        lex: &lex,
    });
    let cmp = t.elapsed();
    eprintln!(
        "compare: {} rows in {cmp:?}, coverage {:.3}, to 98%: {}",
        r.rows.len(),
        r.metrics.coverage_known,
        r.metrics.words_to_98
    );
    assert!(cmp.as_secs_f64() <= 0.3, "compare took {cmp:?}");

    // A second range is only a comparison (no text, no table).
    let range = resolve_range(
        &RangeSpec::Pages {
            text: "21-45, 60, 72-80".into(),
        },
        &[],
        table.page_count,
    )
    .expect("r");
    let t = Instant::now();
    let r2 = compare(CompareInput {
        lemmas: &table.lemmas,
        pages: &table.pages,
        range: &range,
        chapters: &[],
        known: &idx,
        overrides: &HashMap::new(),
        previous_notes: &HashMap::new(),
        config: &config,
        lex: &lex,
    });
    eprintln!("range compare: {} rows in {:?}", r2.rows.len(), t.elapsed());
    assert!(r2.metrics.total_tokens < r.metrics.total_tokens);
}
