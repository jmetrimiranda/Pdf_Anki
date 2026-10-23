//! Spec 12.8: a 300-page book (about 100 thousand words) is scanned in at most 20 s on the desktop, and scanning
//! another range afterwards takes seconds without reading the PDF again.
//!
//! The book is generated here (seeded pseudo-random English sentences with inflections, a few repeated proper names,
//! a running header and page numbers); nothing is committed. Release build:
//! `cargo test --release -p leitor-estudos --test vocab_perf -- --ignored --nocapture`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use core_anki::fixture::{self, FixtureOptions};
use core_vocab::{RangeSpec, ScanConfig};
use leitor_app::{AppState, JobStage};

mod common;

const PAGES: usize = 300;
const WORDS: usize = 100_000;
const FULL_LIMIT: Duration = Duration::from_secs(20);
const RANGE_LIMIT: Duration = Duration::from_secs(3);

const NOUNS: &[&str] = &[
    "animal",
    "farm",
    "windmill",
    "pig",
    "horse",
    "man",
    "child",
    "house",
    "barn",
    "field",
    "harvest",
    "dog",
    "sheep",
    "hen",
    "cow",
    "song",
    "book",
    "word",
    "night",
    "morning",
    "winter",
    "summer",
    "year",
    "day",
    "time",
    "work",
    "food",
    "water",
    "tree",
    "road",
    "village",
    "window",
    "door",
    "wall",
    "table",
    "letter",
    "story",
    "meeting",
    "speech",
    "rule",
    "law",
    "leader",
    "friend",
    "enemy",
    "battle",
    "victory",
    "flag",
    "voice",
    "face",
    "hand",
    "eye",
    "head",
    "heart",
    "mind",
    "idea",
    "plan",
    "reason",
    "question",
    "answer",
    "problem",
    "danger",
    "machine",
    "stone",
    "brick",
    "wood",
    "grass",
    "corn",
    "milk",
    "apple",
    "egg",
    "seed",
    "rain",
    "snow",
    "wind",
    "sun",
    "moon",
    "star",
    "river",
    "hill",
    "garden",
    "kitchen",
    "school",
    "teacher",
    "student",
    "lesson",
    "memory",
    "dream",
    "fear",
    "hope",
    "anger",
    "silence",
    "noise",
    "crowd",
    "farmer",
    "neighbour",
    "market",
];
const VERBS: &[&str] = &[
    "work",
    "walk",
    "talk",
    "look",
    "watch",
    "listen",
    "learn",
    "teach",
    "build",
    "carry",
    "pull",
    "push",
    "open",
    "close",
    "start",
    "finish",
    "help",
    "call",
    "answer",
    "ask",
    "remember",
    "forget",
    "believe",
    "explain",
    "agree",
    "decide",
    "follow",
    "lead",
    "plant",
    "gather",
    "repair",
    "destroy",
    "defend",
    "attack",
    "celebrate",
    "complain",
    "promise",
    "refuse",
    "obey",
    "order",
    "shout",
    "whisper",
    "laugh",
    "cry",
    "sleep",
    "dream",
    "wait",
    "hurry",
    "climb",
    "jump",
    "fall",
    "rise",
    "change",
    "move",
    "turn",
    "return",
    "visit",
    "share",
];
const ADJS: &[&str] = &[
    "old", "young", "big", "small", "long", "short", "hard", "soft", "warm", "cold", "dark",
    "bright", "quiet", "loud", "happy", "sad", "angry", "tired", "strong", "weak", "clever",
    "foolish", "brave", "proud", "humble", "rich", "poor", "kind", "cruel", "honest", "loyal",
    "careful", "busy", "free", "equal", "great", "simple",
];
const ADVS: &[&str] = &[
    "slowly",
    "quickly",
    "quietly",
    "loudly",
    "carefully",
    "happily",
    "sadly",
    "often",
];
const NAMES: &[&str] = &[
    "Napoleon", "Snowball", "Boxer", "Squealer", "Clover", "Benjamin", "Jones",
];
const IRREGULAR: &[&str] = &[
    "went", "came", "took", "gave", "saw", "knew", "thought", "made", "ran", "built", "felt",
    "said", "children", "men", "mice", "geese", "feet", "better", "worse", "best",
];
const DETS: &[&str] = &[
    "the", "a", "this", "that", "every", "some", "their", "his", "her",
];
const PREPS: &[&str] = &[
    "in", "on", "near", "under", "behind", "with", "without", "across", "from", "into",
];

/// SplitMix64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[(self.next() % xs.len() as u64) as usize]
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

fn plural(n: &str) -> String {
    if n.ends_with('y') && !n.ends_with("ey") {
        format!("{}ies", &n[..n.len() - 1])
    } else if n.ends_with('s') || n.ends_with("ch") || n.ends_with("sh") {
        format!("{n}es")
    } else {
        format!("{n}s")
    }
}

fn inflect_verb(v: &str, rng: &mut Rng) -> String {
    let stem = v.strip_suffix('e').unwrap_or(v);
    match rng.next() % 4 {
        0 => v.to_string(),
        1 => format!("{stem}ed").replace("eed", "ed"),
        2 => format!("{stem}ing"),
        _ => plural(v),
    }
}

/// A pronounceable made-up word (most are not in WordNet: they stand for a book's long tail of rare words).
fn rare_word(rng: &mut Rng) -> String {
    const ONSETS: &[&str] = &[
        "b", "br", "c", "cr", "d", "f", "g", "gl", "h", "l", "m", "n", "p", "pl", "r", "s", "st",
        "t", "tr", "v",
    ];
    const VOWELS: &[&str] = &["a", "e", "i", "o", "u", "ai", "ou"];
    let id = rng.next() % 6000;
    let mut r = Rng(id);
    let mut w = String::new();
    for _ in 0..(2 + id % 2) {
        w.push_str(r.pick(ONSETS));
        w.push_str(r.pick(VOWELS));
    }
    w.push_str(r.pick(&["n", "r", "l", "st", "m"]));
    w
}

fn noun_phrase(rng: &mut Rng) -> String {
    let mut out = String::from(rng.pick(DETS));
    if rng.chance(40) {
        out.push(' ');
        out.push_str(rng.pick(ADJS));
    }
    out.push(' ');
    if rng.chance(25) {
        out.push_str(&rare_word(rng));
        return out;
    }
    let n = rng.pick(NOUNS);
    if rng.chance(35) {
        out.push_str(&plural(n));
    } else {
        out.push_str(n);
    }
    out
}

fn sentence(rng: &mut Rng) -> String {
    let mut words: Vec<String> = Vec::new();
    if rng.chance(25) {
        words.push(rng.pick(NAMES).to_string());
    } else {
        words.push(noun_phrase(rng));
    }
    if rng.chance(10) {
        words.push(rng.pick(IRREGULAR).to_string());
    } else {
        words.push(inflect_verb(rng.pick(VERBS), rng));
    }
    words.push(noun_phrase(rng));
    if rng.chance(50) {
        words.push(rng.pick(PREPS).to_string());
        if rng.chance(30) {
            words.push(rng.pick(NAMES).to_string());
        } else {
            words.push(noun_phrase(rng));
        }
    }
    if rng.chance(30) {
        words.push(rng.pick(ADVS).to_string());
    }
    if rng.chance(20) {
        words.push(format!("and {}", noun_phrase(rng)));
    }
    let mut s = words.join(" ");
    if let Some(first) = s.get(..1) {
        s = format!("{}{}", first.to_uppercase(), &s[1..]);
    }
    s.push('.');
    s
}

fn book_pages(seed: u64) -> Vec<String> {
    let mut rng = Rng(seed);
    let per_page = WORDS / PAGES;
    (0..PAGES)
        .map(|_| {
            let mut page = String::new();
            let mut count = 0;
            while count < per_page {
                let s = sentence(&mut rng);
                count += s.split_whitespace().count();
                if !page.is_empty() {
                    page.push(' ');
                }
                page.push_str(&s);
            }
            page
        })
        .collect()
}

#[test]
#[ignore = "release-only timing: cargo test --release -p leitor-estudos --test vocab_perf -- --ignored"]
fn three_hundred_pages_in_twenty_seconds() {
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
    let started = Instant::now();
    common::use_lexicon(&state);
    let lexicon = started.elapsed();

    let pages = book_pages(0x1EE7);
    let words: usize = pages.iter().map(|p| p.split_whitespace().count()).sum();
    let marks: Vec<common::Mark> = (0..10)
        .map(|i| {
            common::mark(
                [
                    "Cap 1", "Cap 2", "Cap 3", "Cap 4", "Cap 5", "Cap 6", "Cap 7", "Cap 8",
                    "Cap 9", "Cap 10",
                ][i],
                i * 30,
                vec![],
            )
        })
        .collect();
    let started = Instant::now();
    let bytes = common::book_pdf(&pages, "Animal Farm", &marks);
    let generated = started.elapsed();
    let pdf = common::write(dir.path(), "big.pdf", &bytes);
    let uid = state.library_add(&pdf, false).unwrap().book.book.book_uid;
    let root = info.decks[fixture::DECK_VOCAB];

    // Full scan: text + table + compare.
    let started = Instant::now();
    let job = state
        .vocab_scan_start(&uid, root, vec![], RangeSpec::All, ScanConfig::default())
        .unwrap();
    let end = state
        .job_wait(&job.job_id, Duration::from_secs(300))
        .unwrap();
    let full = started.elapsed();
    assert_eq!(end.stage, JobStage::Done, "{end:?}");
    assert!(!end.reused);
    assert_eq!(state.vocab_text_extractions(), 1);
    let report = state.vocab_report(&uid).unwrap().unwrap();

    // Another range: the table is reused, no PDF read.
    let started = Instant::now();
    let job = state
        .vocab_scan_start(
            &uid,
            root,
            vec![],
            RangeSpec::Pages {
                text: "21-45, 60, 72-80".into(),
            },
            ScanConfig::default(),
        )
        .unwrap();
    let end = state
        .job_wait(&job.job_id, Duration::from_secs(60))
        .unwrap();
    let range = started.elapsed();
    assert_eq!(end.stage, JobStage::Done, "{end:?}");
    assert!(end.reused);
    assert_eq!(state.vocab_text_extractions(), 1, "no new extraction");

    // Warm marks of a page.
    state.vocab_marks(&uid, &[100]).unwrap();
    let started = Instant::now();
    let marked = state.vocab_marks(&uid, &[101]).unwrap();
    let marks_ms = started.elapsed();

    eprintln!(
        "vocab_perf: {PAGES} pages, {words} words, {} tokens, {} lemmas in report; lexicon {lexicon:?}, pdf {generated:?}, \
         full scan {full:?}, range scan {range:?}, marks of a page {marks_ms:?} ({} marks)",
        report.metrics.total_tokens,
        report.rows.len(),
        marked[0].marks.len()
    );
    assert!(words >= 95_000, "{words} words");
    assert!(full <= FULL_LIMIT, "full scan took {full:?}");
    assert!(range <= RANGE_LIMIT, "range scan took {range:?}");
    state.shutdown();
}
