//! Prints how the engine sees words (lemma, POS, alternatives, Zipf, function word, family bases, definition).
//!
//!   cargo run -p core-vocab --example vocab_probe -- <data dir> went children learning quickly …
//!
//! `<data dir>` holds vocab-en.sqlite (scripts/build-wordnet.sh → data/generated/vocab).

use std::path::PathBuf;

use core_vocab::{DATA_FILE, Lexicon, lemmatize};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: vocab_probe <data dir> <word>…");
        std::process::exit(2);
    };
    let t = std::time::Instant::now();
    let lex = match Lexicon::open(&PathBuf::from(dir).join(DATA_FILE)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    println!("loaded {} lemmas in {:?}", lex.lemma_count(), t.elapsed());
    for w in args {
        let l = lemmatize(&w, &lex, None);
        println!(
            "{w}: lemma={} pos={:?} alts={:?} zipf={:?} function={} lower_lemma={} cased_lemma={} family={:?} def={:?}",
            l.lemma,
            l.pos,
            l.alts,
            lex.zipf(&w),
            lex.is_function_word(&w),
            lex.has_lowercase_lemma(&w.to_lowercase()),
            lex.has_capitalized_lemma(&w),
            lex.family_bases(&l.lemma),
            lex.definition(&l.lemma, l.pos).map(|d| d.1),
        );
    }
}
