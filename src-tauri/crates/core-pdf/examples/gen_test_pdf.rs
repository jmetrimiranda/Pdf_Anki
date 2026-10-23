//! Writes a large text-only PDF for performance checks (spec 21, Phase 1). Never committed.
//!
//! `cargo run -p core-pdf --example gen_test_pdf -- --pages 500 OUT.pdf`
//!
//! Every page is a Letter page with 45 lines of Helvetica text that starts with
//! "Page N line M:", and the file has a one-entry-per-50-pages outline, so the page number
//! seen in the viewer can be checked against the text.

use std::process::ExitCode;

use pdfcraft_testkit::{Pdf, stream_obj};

const WORDS: &[&str] = &[
    "reading", "study", "chapter", "memory", "card", "review", "practice", "language", "window",
    "garden", "river", "mountain", "evening", "question", "answer", "history",
];

fn main() -> ExitCode {
    let mut pages = 500usize;
    let mut out = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--pages" => match args.next().and_then(|n| n.parse().ok()) {
                Some(n) if n > 0 => pages = n,
                _ => return usage("--pages needs a positive number"),
            },
            "-h" | "--help" => return usage(""),
            _ if out.is_none() => out = Some(a),
            _ => return usage("only one output path"),
        }
    }
    let Some(out) = out else {
        return usage("missing output path");
    };
    let bytes = build(pages);
    match std::fs::write(&out, &bytes) {
        Ok(()) => {
            println!("{out}: {pages} pages, {} KB", bytes.len() / 1024);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("cannot write {out}: {e}");
            ExitCode::FAILURE
        }
    }
}

fn usage(error: &str) -> ExitCode {
    if !error.is_empty() {
        eprintln!("error: {error}");
    }
    eprintln!("usage: gen_test_pdf [--pages N] OUT.pdf");
    if error.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    }
}

fn build(n: usize) -> Vec<u8> {
    // 1 catalog, 2 page tree, 3 font, (page, content) pairs, outline root, outline items.
    let page_obj = |i: usize| 4 + 2 * i;
    let outline_root = 4 + 2 * n;
    let marks: Vec<usize> = (0..n).step_by(50).collect();
    let mut objs: Vec<Vec<u8>> = vec![
        format!("<< /Type /Catalog /Pages 2 0 R /Outlines {outline_root} 0 R >>").into_bytes(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {n} >>",
            (0..n)
                .map(|i| format!("{} 0 R", page_obj(i)))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .into_bytes(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    ];
    for p in 0..n {
        objs.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
                page_obj(p) + 1
            )
            .into_bytes(),
        );
        let mut content = String::from("BT /F1 11 Tf 14 TL 72 720 Td");
        for l in 0..45 {
            content.push_str(&format!(" (Page {} line {}:", p + 1, l + 1));
            for w in 0..10 {
                content.push(' ');
                content.push_str(WORDS[(p * 7 + l * 3 + w) % WORDS.len()]);
            }
            content.push_str(") Tj T*");
        }
        content.push_str(" ET");
        objs.push(stream_obj("", content.as_bytes()));
    }
    let first = outline_root + 1;
    let last = outline_root + marks.len();
    objs.push(
        format!(
            "<< /Type /Outlines /First {first} 0 R /Last {last} 0 R /Count {} >>",
            marks.len()
        )
        .into_bytes(),
    );
    for (k, &page) in marks.iter().enumerate() {
        let id = first + k;
        let mut d = format!(
            "<< /Title (Part {}) /Parent {outline_root} 0 R /Dest [{} 0 R /Fit]",
            k + 1,
            page_obj(page)
        );
        if k > 0 {
            d.push_str(&format!(" /Prev {} 0 R", id - 1));
        }
        if id < last {
            d.push_str(&format!(" /Next {} 0 R", id + 1));
        }
        d.push_str(" >>");
        objs.push(d.into_bytes());
    }
    objs.push(
        format!("<< /Title (Generated book, {n} pages) /Producer (core-pdf gen_test_pdf) >>")
            .into_bytes(),
    );
    let info = objs.len();
    Pdf::new()
        .objs(objs)
        .trailer_entry(&format!("/Info {info} 0 R"))
        .build()
}
