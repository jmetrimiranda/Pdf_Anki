//! Text extraction per section (vocabulary scan, search), progress/cancel and the fingerprint.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use common::{Custom, open, texts};
use core_epub::testkit::{ChapterSpec, EpubBuilder, EpubVersion, script_epub};
use core_epub::{EpubError, fingerprint_of};

fn text_of(body: &str) -> String {
    let book = open(Custom::one_chapter(body).build()).unwrap();
    book.section_text(0).unwrap().text
}

#[test]
fn entities_nbsp_br_and_blocks() {
    let text = text_of(
        "<h1>Chapter&#160;One</h1><p>Caf&eacute; &amp; cr&#xE8;me&nbsp;br&ucirc;l&eacute; &mdash; &ldquo;yes&rdquo;&hellip;</p>\
         <p>line one<br/>line two<br />  line   three</p><ul><li>a</li><li>b</li></ul>\
         <blockquote>quoted</blockquote><table><tr><td>c1</td><td>c2</td></tr></table><p>x&copy;&unknown;</p>",
    );
    assert_eq!(
        text,
        "Chapter One\nCafé & crème brûlé — “yes”…\nline one\nline two\nline three\na\nb\nquoted\nc1 c2\nx©&unknown;"
    );
}

#[test]
fn script_style_and_hidden_content_are_skipped() {
    let text = text_of(
        "<style>p { color: red }</style><p>visible</p><script type=\"text/javascript\">var hidden = 1;</script>\
         <svg xmlns=\"http://www.w3.org/2000/svg\"><text>svgtext</text></svg><math><mi>x</mi></math>\
         <p><ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>字</p><template><p>tpl</p></template><noscript>ns</noscript>",
    );
    assert_eq!(text, "visible\n漢字");

    let book = open(script_epub()).unwrap();
    assert_eq!(
        book.section_text(0).unwrap().text,
        "Scripted\nSafe text stays.\nlink"
    );
}

#[test]
fn utf16_section_with_bom() {
    let doc = core_epub::testkit::xhtml_doc("U", "<p>Olá, mundo — ünïcode</p>")
        .replace("UTF-8", "UTF-16");
    for big_endian in [false, true] {
        let mut bytes: Vec<u8> = if big_endian {
            vec![0xFE, 0xFF]
        } else {
            vec![0xFF, 0xFE]
        };
        for unit in doc.encode_utf16() {
            bytes.extend(if big_endian {
                unit.to_be_bytes()
            } else {
                unit.to_le_bytes()
            });
        }
        let mut c = Custom::one_chapter("");
        c.files[0].1 = bytes;
        let book = open(c.build()).unwrap();
        assert_eq!(book.section_text(0).unwrap().text, "Olá, mundo — ünïcode");
    }
}

#[test]
fn windows_1252_declared_section() {
    let mut c = Custom::one_chapter("");
    c.files[0].1 = b"<?xml version=\"1.0\" encoding=\"windows-1252\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title></head>\
        <body><p>Caf\xE9 \x93quoted\x94 \x96 na\xEFve</p></body></html>"
        .to_vec();
    let book = open(c.build()).unwrap();
    assert_eq!(book.section_text(0).unwrap().text, "Café “quoted” – naïve");
}

#[test]
fn malformed_xhtml_is_still_extracted() {
    let mut c = Custom::one_chapter("");
    c.files[0].1 =
        b"<html><body><p>first <b>bold<p>second & third<br>fourth</i></div><p>fifth < sixth"
            .to_vec();
    let book = open(c.build()).unwrap();
    let text = book.section_text(0).unwrap().text;
    for word in [
        "first",
        "bold",
        "second & third",
        "fourth",
        "fifth",
        "sixth",
    ] {
        assert!(text.contains(word), "{word:?} missing in {text:?}");
    }
    // Garbage that isn't markup at all.
    let mut c = Custom::one_chapter("");
    c.files[0].1 = b"<<<<>>>> &&& <p <a =\"x>plain words</a>".to_vec();
    let book = open(c.build()).unwrap();
    assert!(book.section_text(0).is_ok());
}

#[test]
fn non_text_sections_are_empty() {
    let mut c = Custom::one_chapter("<p>x</p>");
    c.manifest
        .push_str("<item id=\"img\" href=\"p.png\" media-type=\"image/png\"/>");
    c.spine.push_str("<itemref idref=\"img\"/>");
    c.files.push((
        "OEBPS/p.png".into(),
        core_epub::testkit::tiny_png(1, 1, [0, 0, 0]),
    ));
    let book = open(c.build()).unwrap();
    let all = texts(&book);
    assert_eq!(all.len(), 2);
    assert_eq!(all[1].text, "");
}

#[test]
fn texts_progress_labels_and_cancel() {
    let book = open(EpubBuilder::sample(EpubVersion::V3).build()).unwrap();
    let mut seen = Vec::new();
    let all = book
        .texts(&AtomicBool::new(false), &mut |done, total| {
            seen.push((done, total))
        })
        .unwrap();
    assert_eq!(seen, [(1, 5), (2, 5), (3, 5), (4, 5), (5, 5)]);
    assert_eq!(all[1].label.as_deref(), Some("Chapter 1"));
    assert_eq!(
        all[1].text,
        "Chapter 1\nThe cat sat on the mat.\nSection 1.2\nA fragment of the same file."
    );
    assert!(
        all[0]
            .text
            .starts_with("Part I\nThe first part begins here.")
    );
    assert_eq!(
        all.iter().map(|t| t.section).collect::<Vec<_>>(),
        [0, 1, 2, 3, 4]
    );

    let cancel = AtomicBool::new(false);
    let r = book.texts(&cancel, &mut |done, _| {
        if done == 2 {
            cancel.store(true, Ordering::Relaxed);
        }
    });
    assert_eq!(r.unwrap_err(), EpubError::Cancelled);
    assert!(book.section_text(5).is_err());
}

#[test]
fn fingerprint_is_stable_and_follows_the_text() {
    let a = open(EpubBuilder::sample(EpubVersion::V3).build()).unwrap();
    let b = open(EpubBuilder::sample(EpubVersion::V2).build()).unwrap();
    // Same text, different packaging → same fingerprint.
    assert_eq!(a.text_fingerprint(), b.text_fingerprint());
    assert_eq!(a.text_fingerprint(), fingerprint_of(&texts(&a)));
    assert_eq!(a.text_fingerprint().len(), 64);
    let c = open(
        EpubBuilder::sample(EpubVersion::V3)
            .chapter(ChapterSpec::new("Appendix", "<p>More.</p>"))
            .build(),
    )
    .unwrap();
    assert_ne!(a.text_fingerprint(), c.text_fingerprint());
    let d = open(
        EpubBuilder::sample(EpubVersion::V3)
            .title("Other title")
            .build(),
    )
    .unwrap();
    assert_eq!(a.text_fingerprint(), d.text_fingerprint());
}

/// 100 chapters × 1 000 words (> 1 MB of text): open + texts() < 300 ms in release, < 1.5 s in debug.
#[test]
#[ignore = "performance; run with --release -- --ignored"]
fn perf_one_megabyte_epub() {
    let words = [
        "traveller",
        "machine",
        "civilisation",
        "underground",
        "incandescent",
        "fourth-dimension",
        "philosophical",
        "eloi",
        "morlocks",
        "sphinx",
    ];
    let chapters: Vec<ChapterSpec> = (0..100)
        .map(|c| {
            let body: String = (0..50)
                .map(|p| {
                    let para: Vec<&str> = (0..20)
                        .map(|w| words[(c * 31 + p * 7 + w) % words.len()])
                        .collect();
                    format!("<p>{}.</p>", para.join(" "))
                })
                .collect();
            ChapterSpec::new(format!("Chapter {c}"), body)
        })
        .collect();
    let bytes = EpubBuilder::new(EpubVersion::V3).chapters(chapters).build();
    let start = Instant::now();
    let book = open(bytes).unwrap();
    let all = texts(&book);
    let elapsed = start.elapsed();
    let total_words: usize = all.iter().map(|t| t.text.split_whitespace().count()).sum();
    let xhtml: usize = all.iter().map(|t| t.text.len()).sum();
    println!("open + texts: {elapsed:?} for {total_words} words, {xhtml} bytes of text");
    assert!(total_words >= 100_000);
    assert!(xhtml >= 1_000_000);
    let budget = if cfg!(debug_assertions) { 1500 } else { 300 };
    assert!(elapsed.as_millis() < budget, "{elapsed:?}");
}
