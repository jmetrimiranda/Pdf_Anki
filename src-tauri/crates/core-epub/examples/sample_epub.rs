//! Writes a sample EPUB 3 of "The Time Machine" (H. G. Wells, 1895, public domain; first part
//! of chapters I–VI) with a nested TOC (Part I > Chapters I–III, Part II > Chapters IV–VI), an
//! image and a cover. Used for captures and the mock comparison.
//!
//!   cargo run -p core-epub --features testkit --example sample_epub -- <out.epub>

use core_epub::testkit::{ChapterSpec, EpubBuilder, EpubVersion, escape, tiny_png};

const TEXT: &str = include_str!("time_machine.txt");

/// `_word_` (Gutenberg italics) → `<em>word</em>`, everything else escaped.
fn paragraph(p: &str) -> String {
    let mut out = String::from("<p>");
    for (i, part) in escape(p).split('_').enumerate() {
        if i % 2 == 1 {
            out.push_str(&format!("<em>{part}</em>"));
        } else {
            out.push_str(part);
        }
    }
    out.push_str("</p>");
    out
}

fn main() {
    let Some(out) = std::env::args().nth(1) else {
        eprintln!("uso: sample_epub <saída.epub>");
        std::process::exit(2);
    };
    let chapters: Vec<ChapterSpec> = TEXT
        .split("## ")
        .filter(|c| !c.trim().is_empty())
        .map(|c| {
            let mut paras = c.split("\n\n").map(str::trim).filter(|p| !p.is_empty());
            let title = paras.next().unwrap_or_default();
            ChapterSpec::new(title, paras.map(paragraph).collect::<String>())
        })
        .collect();
    let mut chapters = chapters.into_iter();
    let mut part = |title: &str, intro: &str| {
        chapters.by_ref().take(3).fold(
            ChapterSpec::new(title, format!("<p><em>{intro}</em></p>")),
            ChapterSpec::child,
        )
    };
    let part1 = part(
        "Part I",
        "The Time Traveller explains his theory and shows his machine.",
    );
    let part2 = part("Part II", "The Time Traveller tells his story.");
    let bytes = EpubBuilder::new(EpubVersion::V3)
        .title("The Time Machine")
        .author("H. G. Wells")
        .language("en")
        .identifier("urn:leitor:sample:the-time-machine")
        .chapter(part1)
        .chapter(part2)
        .with_image(true)
        .cover_png(Some(tiny_png(300, 450, [52, 73, 94])))
        .with_ncx(true)
        .build();
    if let Err(e) = std::fs::write(&out, &bytes) {
        eprintln!("não foi possível gravar {out}: {e}");
        std::process::exit(1);
    }
    println!("{out}: {} bytes", bytes.len());
}
