//! The manual check of spec 12.8 for a plain-text book: samples tokens with lemma and status into a CSV to review
//! ("aguardando um livro real do usuário"). Pages are separated by form feeds (`\f`, as `pdftotext` writes them).
//! The app has the PDF version (`cargo run -p leitor-estudos --example vocab_sample`).
//!
//!   cargo run -p core-vocab --example vocab_sample_text -- <data dir> book.txt [n=100] [seed=1] > sample.csv

use std::path::PathBuf;

use core_vocab::{DATA_FILE, Lexicon, PageInput, sample_tokens, to_csv};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: vocab_sample_text <data dir> <book.txt> [n] [seed]");
        std::process::exit(2);
    }
    let lex = match Lexicon::open(&PathBuf::from(&args[0]).join(DATA_FILE)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let text = match std::fs::read(&args[1]) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) => {
            eprintln!("{}: {e}", args[1]);
            std::process::exit(1);
        }
    };
    let n = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100);
    let seed = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let pages: Vec<PageInput> = text
        .split('\u{c}')
        .enumerate()
        .map(|(i, t)| PageInput {
            unit: i as u32,
            text: t,
        })
        .collect();
    print!("{}", to_csv(&sample_tokens(&pages, &lex, None, n, seed)));
}
