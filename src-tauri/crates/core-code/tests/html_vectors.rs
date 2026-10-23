//! The vectors shared with the web editor (`codeField.ts`): entries with `text` must write exactly
//! `html` and read back `readsAs` (default: `text`); entries without `text` are fields written by
//! Anki's editor that must read as `readsAs`.

use core_code::{code_to_html, html_to_code};
use serde_json::Value;

fn vectors() -> Vec<Value> {
    let raw = include_str!("fixtures/code_html_vectors.json");
    serde_json::from_str(raw).expect("valid vectors file")
}

#[test]
fn shared_vectors_both_directions() {
    let vectors = vectors();
    assert!(vectors.len() >= 25, "the vectors file lost entries");
    for v in &vectors {
        let name = v["name"].as_str().expect("name");
        let html = v["html"].as_str().expect("html");
        let reads_as = v.get("readsAs").and_then(Value::as_str);
        match v.get("text").and_then(Value::as_str) {
            Some(text) => {
                assert_eq!(code_to_html(text), html, "write: {name}");
                assert_eq!(html_to_code(html), reads_as.unwrap_or(text), "read: {name}");
            }
            None => {
                let reads_as = reads_as.expect("readsAs without text");
                assert_eq!(html_to_code(html), reads_as, "read: {name}");
            }
        }
    }
}

#[test]
fn round_trip_is_exact_for_arbitrary_text() {
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let alphabet: Vec<char> = "ab <>&;#x0123\t \n/divbrp&nbsp;é✓🚀\u{a0}"
        .chars()
        .collect();
    for _ in 0..2000 {
        let len = (next(&mut seed) % 40) as usize;
        let s: String = (0..len)
            .map(|_| alphabet[(next(&mut seed) % alphabet.len() as u64) as usize])
            .collect();
        assert_eq!(html_to_code(&code_to_html(&s)), s, "{s:?}");
    }
}

#[test]
fn reading_random_html_never_panics() {
    let mut seed: u64 = 42;
    let pieces = [
        "<", ">", "&", ";", "#", "x", "<div>", "</div>", "<br", "<br>", "<p>", "&#", "&#x", "1",
        "F", "é", "\r", "\n", " ", "\u{feff}", "_", "/",
    ];
    for _ in 0..5000 {
        let n = (next(&mut seed) % 30) as usize;
        let s: String = (0..n)
            .map(|_| pieces[(next(&mut seed) % pieces.len() as u64) as usize])
            .collect();
        let _ = html_to_code(&s);
    }
}

fn next(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}
