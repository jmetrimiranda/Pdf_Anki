//! Vocabulary scanning support (spec 12.1, 12.3 B/F): whole-book text in parallel, the text fingerprint of a file
//! version, the outline of the current version (bookmarks PdfCraft writes) and broken outlines.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use common::*;
use core_pdf::{
    ExtractOptions, OutlineItem, PdfCore, PdfError, extract_book_text, text_fingerprint,
};
use pdfcraft_testkit::Pdf;

fn arc(bytes: &[u8]) -> Arc<Vec<u8>> {
    Arc::new(bytes.to_vec())
}

fn extract_all(bytes: &[u8], opts: ExtractOptions) -> Vec<core_pdf::PageText> {
    let cancel = AtomicBool::new(false);
    extract_book_text(arc(bytes), None, opts, &cancel, &mut |_, _| {}).expect("extract")
}

// ---------------------------------------------------------------- extract_book_text

#[test]
fn book_text_is_in_order_and_matches_page_words() {
    let bytes = long_book(23);
    let core = PdfCore::new();
    let h = core.open(arc(&bytes), None).expect("open");
    let mut calls = Vec::new();
    let cancel = AtomicBool::new(false);
    let pages = extract_book_text(
        arc(&bytes),
        None,
        ExtractOptions {
            pages: None,
            threads: 3,
        },
        &cancel,
        &mut |done, total| calls.push((done, total)),
    )
    .expect("extract");
    assert_eq!(pages.len(), 23);
    for (i, p) in pages.iter().enumerate() {
        assert_eq!(p.page, i);
        assert!(p.ok);
        // Same text as the marks' source (page_words), so table and marks agree.
        assert_eq!(
            p.text,
            core.page_words(h, i).expect("words").text,
            "page {i}"
        );
        assert!(
            p.text.starts_with(&format!("Page {} line 1:", i + 1)),
            "{}",
            p.text
        );
    }
    assert_eq!(calls.len(), 23);
    assert_eq!(calls.last(), Some(&(23, 23)));
    assert!(calls.windows(2).all(|w| w[1].0 == w[0].0 + 1));

    // One thread gives the same result.
    let single = extract_all(
        &bytes,
        ExtractOptions {
            pages: None,
            threads: 1,
        },
    );
    assert_eq!(single, pages);
}

#[test]
fn selected_pages_are_sorted_deduplicated_and_bounded() {
    let bytes = book();
    let pages = extract_all(
        &bytes,
        ExtractOptions {
            pages: Some(vec![2, 0, 2, 99]),
            threads: 2,
        },
    );
    let got: Vec<(usize, &str)> = pages.iter().map(|p| (p.page, p.text.as_str())).collect();
    assert_eq!(got, [(0, "Hello world from page one"), (2, "Cropped text")]);
    assert!(
        extract_all(
            &bytes,
            ExtractOptions {
                pages: Some(vec![]),
                threads: 2
            }
        )
        .is_empty()
    );
}

#[test]
fn cancel_stops_with_a_typed_error() {
    let bytes = long_book(40);
    let cancel = AtomicBool::new(true);
    let err = extract_book_text(
        arc(&bytes),
        None,
        ExtractOptions::default(),
        &cancel,
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(err, PdfError::Cancelled);
    assert_eq!(err.code(), "cancelled");
    assert_eq!(
        err.to_string(),
        "A leitura do texto do livro foi cancelada."
    );

    // Cancelled from the progress callback after a few pages.
    let cancel = AtomicBool::new(false);
    let mut seen = 0;
    let err = extract_book_text(
        arc(&bytes),
        None,
        ExtractOptions {
            pages: None,
            threads: 2,
        },
        &cancel,
        &mut |done, _| {
            seen = done;
            if done == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
    )
    .unwrap_err();
    assert_eq!(err, PdfError::Cancelled);
    assert!(seen < 40, "stopped early ({seen})");
}

#[test]
fn damaged_pages_never_stop_the_book() {
    // Page 2 has a corrupt Flate content stream, page 3 a content that is not a stream.
    let bytes = Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R >>")
        .obj("<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>")
        .obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << /Font << /F1 9 0 R >> >> >>")
        .obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 7 0 R /Resources << /Font << /F1 9 0 R >> >> >>")
        .obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 8 0 R /Resources << /Font << /F1 9 0 R >> >> >>")
        .stream("", b"BT /F1 18 Tf 20 100 Td (First page) Tj ET")
        .stream("/Filter /FlateDecode", b"this is not zlib data at all")
        .obj("(not a stream)")
        .obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        .build();
    let pages = extract_all(&bytes, ExtractOptions::default());
    assert_eq!(pages.len(), 3);
    assert_eq!(pages[0].text, "First page");
    assert!(pages[0].ok);
    for p in &pages[1..] {
        assert!(p.text.trim().is_empty() || !p.ok, "{p:?}");
    }
    // The fingerprint copes with them too.
    text_fingerprint(arc(&bytes), None).expect("fingerprint");
}

#[test]
fn garbage_and_passwords() {
    let cancel = AtomicBool::new(false);
    for bad in [&b""[..], b"%PDF-1.7\n garbage", b"not a pdf"] {
        assert!(
            extract_book_text(
                arc(bad),
                None,
                ExtractOptions::default(),
                &cancel,
                &mut |_, _| {}
            )
            .is_err()
        );
        assert!(text_fingerprint(arc(bad), None).is_err());
    }
    let bytes = protected(pdfcraft_cos::Algorithm::Aes128, "user", "owner");
    let err = extract_book_text(
        arc(&bytes),
        None,
        ExtractOptions::default(),
        &cancel,
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(err, PdfError::NeedsPassword);
    for pw in ["user", "owner"] {
        let pages = extract_book_text(
            arc(&bytes),
            Some(pw),
            ExtractOptions::default(),
            &cancel,
            &mut |_, _| {},
        )
        .expect("with password");
        assert_eq!(pages[0].text, "Secret page", "{pw}");
        text_fingerprint(arc(&bytes), Some(pw)).expect("fingerprint with password");
    }
}

// ---------------------------------------------------------------- text_fingerprint

fn add_highlight(bytes: &[u8]) -> Vec<u8> {
    let mut doc = pdfcraft_cos::Document::open(arc(bytes)).expect("cos open");
    let quad = pdfcraft_annot::rect_quad([18.0, 95.0, 120.0, 120.0]);
    let shape = pdfcraft_annot::Shape::TextMarkup {
        kind: pdfcraft_annot::Markup::Highlight,
        quads: vec![quad],
    };
    let new = pdfcraft_annot::NewAnnotation {
        page: 0,
        style: pdfcraft_annot::Style::default_for(&shape),
        shape,
        contents: "Importante".into(),
        author: "Leitora".into(),
    };
    let meta = pdfcraft_annot::Meta {
        date: Some(pdfcraft_cos::pdf_date(1_700_000_000)),
        id: "leitor-test-1".into(),
    };
    pdfcraft_annot::add_annotation(&mut doc, &new, &meta).expect("annotation");
    pdfcraft_cos::write_incremental(&doc, &Default::default()).expect("save")
}

#[test]
fn fingerprint_ignores_annotations_and_bookmarks_but_not_text() {
    let original = book();
    let base = text_fingerprint(arc(&original), None).expect("fingerprint");
    assert_eq!(base.len(), 64);
    assert!(base.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    assert_eq!(
        text_fingerprint(arc(&original), None).expect("again"),
        base,
        "deterministic"
    );

    // An annotation saved by PdfCraft's annotation code (incremental save): same text, same fingerprint.
    let annotated = add_highlight(&original);
    assert_ne!(annotated, original);
    assert_eq!(
        text_fingerprint(arc(&annotated), None).expect("annotated"),
        base
    );
    // So is the text read back.
    let a = extract_all(&annotated, ExtractOptions::default());
    let b = extract_all(&original, ExtractOptions::default());
    assert_eq!(a, b);

    // A bookmark (PdfCraft's outline code) and a full rewrite (streams re-encoded) keep it too.
    let mut doc = pdfcraft_cos::Document::open(arc(&annotated)).expect("open");
    pdfcraft_organize::add_bookmark(&mut doc, &[], 0, "Marcador", 2).expect("bookmark");
    let marked = pdfcraft_cos::write_incremental(&doc, &Default::default()).expect("save");
    assert_eq!(text_fingerprint(arc(&marked), None).expect("marked"), base);
    let full = pdfcraft_cos::write_full(
        &doc,
        &pdfcraft_cos::SaveOptions {
            object_streams: true,
            ..Default::default()
        },
    )
    .expect("full save");
    assert_eq!(text_fingerprint(arc(&full), None).expect("rewritten"), base);

    // A change of the page text (or of the page count) changes it.
    let mut changed_pages = vec![
        PageSpec::text(20.0, 100.0, "Hello world from page ONE"),
        PageSpec::text(20.0, 100.0, "Rotated words here"),
        PageSpec::text(60.0, 100.0, "Cropped text"),
    ];
    changed_pages[1].rotate = 90;
    changed_pages[2].crop = Some([50.0, 50.0, 250.0, 150.0]);
    let changed = build_pdf(&changed_pages, &[], &[]);
    assert_ne!(
        text_fingerprint(arc(&changed), None).expect("changed"),
        base
    );
    let fewer = build_pdf(&changed_pages[..2], &[], &[]);
    assert_ne!(
        text_fingerprint(arc(&fewer), None).expect("fewer"),
        text_fingerprint(arc(&changed), None).expect("changed")
    );
}

// ---------------------------------------------------------------- outline of the current version

fn outline_of(bytes: &[u8]) -> Vec<OutlineItem> {
    let core = PdfCore::new();
    let h = core.open(arc(bytes), None).expect("open");
    core.outline(h).expect("outline")
}

fn flat(items: &[OutlineItem], depth: usize, out: &mut Vec<(usize, String, Option<usize>)>) {
    for i in items {
        out.push((depth, i.title.clone(), i.page));
        flat(&i.children, depth + 1, out);
    }
}

#[test]
fn bookmarks_written_by_pdfcraft_are_read_from_the_saved_version() {
    // A file without an outline: the user adds bookmarks in PdfCraft (its outline code) and the app saves the
    // new version; the core reads them from that version.
    let pages: Vec<PageSpec> = (0..6)
        .map(|i| PageSpec::text(20.0, 100.0, &format!("Page number {}", i + 1)))
        .collect();
    let original = build_pdf(&pages, &[], &[]);
    assert!(outline_of(&original).is_empty());
    let mut doc = pdfcraft_cos::Document::open(arc(&original)).expect("open");
    let cap1 = pdfcraft_organize::add_bookmark(&mut doc, &[], 0, "Capítulo 1", 0).expect("cap 1");
    pdfcraft_organize::add_bookmark(&mut doc, &[], 1, "Capítulo 2", 3).expect("cap 2");
    pdfcraft_organize::add_bookmark(&mut doc, &cap1, 0, "Seção 1.1", 1).expect("nested");
    let saved = pdfcraft_cos::write_incremental(&doc, &Default::default()).expect("save");
    let mut got = Vec::new();
    flat(&outline_of(&saved), 0, &mut got);
    assert_eq!(
        got,
        [
            (0, "Capítulo 1".to_string(), Some(0)),
            (1, "Seção 1.1".to_string(), Some(1)),
            (0, "Capítulo 2".to_string(), Some(3)),
        ]
    );

    // A bookmark added to a book that already has an outline (the user's own marker) shows up with it.
    let mut doc = pdfcraft_cos::Document::open(arc(&book())).expect("open");
    pdfcraft_organize::add_bookmark(&mut doc, &[0], 9, "Meu marcador", 2).expect("user bookmark");
    let saved = pdfcraft_cos::write_incremental(&doc, &Default::default()).expect("save");
    let mut got = Vec::new();
    flat(&outline_of(&saved), 0, &mut got);
    assert_eq!(
        got,
        [
            (0, "Capítulo 1".to_string(), Some(0)),
            (1, "Seção 1.1".to_string(), Some(1)),
            (1, "Meu marcador".to_string(), Some(2)),
            (0, "Capítulo 2".to_string(), Some(2)),
        ]
    );
}

/// An outline whose items point nowhere: `page` is `None`.
#[test]
fn bookmarks_without_destination_have_no_page() {
    let bytes = Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>")
        .obj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
        .obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>")
        .stream("", b"")
        .obj("<< /Type /Outlines /First 6 0 R /Last 7 0 R /Count 2 >>")
        .obj("<< /Title (Sem destino) /Parent 5 0 R /Next 7 0 R >>")
        .obj("<< /Title (Destino quebrado) /Parent 5 0 R /Prev 6 0 R /Dest [99 0 R /Fit] >>")
        .build();
    let mut got = Vec::new();
    flat(&outline_of(&bytes), 0, &mut got);
    assert_eq!(
        got,
        [
            (0, "Sem destino".to_string(), None),
            (0, "Destino quebrado".to_string(), None),
        ]
    );
}

/// Cyclic and broken `/Outlines` never panic or hang: open succeeds (or fails cleanly) and the outline is finite.
#[test]
fn broken_and_cyclic_outlines_are_safe() {
    let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>";
    let cases: Vec<(&str, Vec<String>)> = vec![
        // An item whose /Next is itself.
        (
            "self next",
            vec!["<< /Type /Outlines /First 6 0 R /Last 6 0 R >>".into(),
                 "<< /Title (Loop) /Parent 5 0 R /Next 6 0 R /Dest [3 0 R /Fit] >>".into()],
        ),
        // Two items pointing at each other, and a child that is its own parent's /First.
        (
            "ring and nesting cycle",
            vec!["<< /Type /Outlines /First 6 0 R /Last 7 0 R >>".into(),
                 "<< /Title (A) /Parent 5 0 R /Next 7 0 R /First 6 0 R /Last 6 0 R /Dest [3 0 R /Fit] >>".into(),
                 "<< /Title (B) /Parent 5 0 R /Next 6 0 R /Prev 6 0 R /First 5 0 R >>".into()],
        ),
        // /First points to a missing object; titles of the wrong type.
        (
            "dangling",
            vec!["<< /Type /Outlines /First 40 0 R /Last 41 0 R /Count 5 >>".into(),
                 "<< /Title 42 /Parent 5 0 R >>".into()],
        ),
        // /Outlines is not a dictionary.
        ("not a dict", vec!["[1 2 3]".into(), "null".into()]),
    ];
    for (name, objs) in cases {
        let mut pdf = Pdf::new()
            .obj("<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>")
            .obj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
            .obj(page)
            .stream("", b"BT /F1 12 Tf 20 100 Td (x) Tj ET");
        for o in objs {
            pdf = pdf.obj(o);
        }
        let bytes = pdf.build();
        let core = PdfCore::new();
        match core.open(arc(&bytes), None) {
            Ok(h) => {
                let outline = core.outline(h).expect("outline");
                let mut got = Vec::new();
                flat(&outline, 0, &mut got);
                assert!(got.len() < 100, "{name}: {got:?}");
            }
            Err(e) => assert!(!matches!(e, PdfError::Internal(_)), "{name}: {e:?}"),
        }
        // PdfCraft's own outline writer copes with it too (the user adding a bookmark to such a file).
        if let Ok(mut doc) = pdfcraft_cos::Document::open(arc(&bytes)) {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                pdfcraft_organize::add_bookmark(&mut doc, &[], 0, "Novo", 0).map(|_| ())
            }));
            assert!(r.is_ok(), "{name}: add_bookmark panicked");
        }
    }
}

// ---------------------------------------------------------------- performance

/// ~100k words on 300 Letter pages of generated English-like text (not committed).
fn generated_book(pages: usize, lines: usize, words_per_line: usize) -> (Vec<u8>, usize) {
    const SYLLABLES: &[&str] = &[
        "an", "ber", "cor", "dal", "en", "fin", "gor", "hal", "in", "jor", "kel", "lan", "mor",
        "nel", "or", "pra", "quin", "ros", "sal", "tor", "ul", "ven", "wil", "yor",
    ];
    const COMMON: &[&str] = &[
        "the",
        "of",
        "and",
        "to",
        "a",
        "in",
        "was",
        "he",
        "that",
        "it",
        "with",
        "his",
        "on",
        "for",
        "as",
        "windmill",
        "animals",
        "farm",
        "learning",
        "quickly",
        "happiness",
        "building",
        "feeling",
    ];
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut total = 0;
    let specs: Vec<PageSpec> = (0..pages)
        .map(|_| {
            let lines: Vec<String> = (0..lines)
                .map(|_| {
                    let words: Vec<String> = (0..words_per_line)
                        .map(|_| {
                            let r = next();
                            if r % 3 == 0 {
                                let n = 1 + (r >> 8) as usize % 3;
                                (0..n)
                                    .map(|k| {
                                        SYLLABLES[((r >> (16 + 5 * k)) as usize) % SYLLABLES.len()]
                                    })
                                    .collect()
                            } else {
                                COMMON[(r >> 8) as usize % COMMON.len()].to_string()
                            }
                        })
                        .collect();
                    total += words.len();
                    words.join(" ")
                })
                .collect();
            PageSpec::lines(&lines)
        })
        .collect();
    (build_pdf(&specs, &[], &[("Title", "Livro gerado")]), total)
}

/// Spec 12.8: a 300-page / 100k-word book is read in ≤ 12 s here (dev/test build, 4 cores), leaving headroom for
/// the 20 s full scan. Ignored by default (slow); the final suite runs it with `--ignored`.
#[test]
#[ignore = "performance: run with --ignored"]
fn three_hundred_pages_hundred_thousand_words() {
    let (bytes, words) = generated_book(300, 42, 8);
    assert!(words >= 100_000, "{words}");
    let cancel = AtomicBool::new(false);
    let opts = ExtractOptions::default();
    let threads = opts.threads;
    let t = Instant::now();
    let pages =
        extract_book_text(arc(&bytes), None, opts, &cancel, &mut |_, _| {}).expect("extract");
    let took = t.elapsed();
    let t = Instant::now();
    let fp = text_fingerprint(arc(&bytes), None).expect("fingerprint");
    let fp_took = t.elapsed();
    let read_words: usize = pages
        .iter()
        .map(|p| p.text.split_whitespace().count())
        .sum();
    println!(
        "300 pages / {words} words ({} KB): extract_book_text with {threads} threads {took:?}, text_fingerprint {fp_took:?} ({fp})",
        bytes.len() / 1024
    );
    assert_eq!(pages.len(), 300);
    assert!(pages.iter().all(|p| p.ok));
    assert_eq!(read_words, words);
    assert!(took.as_secs_f64() <= 12.0, "{took:?}");
    assert!(fp_took.as_secs_f64() <= 2.0, "{fp_took:?}");
}
