//! End-to-end tests of `PdfCore` on the PDF test set of spec 20: text, scanned, outline,
//! comments, password, corrupted and rotated pages, plus `LeitorBookUid` and a 500-page book.

mod common;

use std::sync::Arc;
use std::time::Instant;

use common::*;
use core_pdf::{
    DocHandle, LEITOR_BOOK_UID_KEY, PdfCore, PdfError, TextStats, read_info, stamp_info,
};

fn open(core: &PdfCore, bytes: &[u8]) -> DocHandle {
    match core.open(Arc::new(bytes.to_vec()), None) {
        Ok(h) => h,
        Err(e) => panic!("open failed: {e:?}"),
    }
}

fn arc(bytes: &[u8]) -> Arc<Vec<u8>> {
    Arc::new(bytes.to_vec())
}

/// Decodes a PNG to (width, height, RGBA8 pixels).
fn decode_png(png: &[u8]) -> (u32, u32, Vec<u8>) {
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let mut reader = decoder.read_info().expect("png header");
    let mut buf = vec![0; reader.output_buffer_size().expect("buffer size")];
    let frame = reader.next_frame(&mut buf).expect("png frame");
    assert_eq!(frame.color_type, png::ColorType::Rgba);
    buf.truncate(frame.buffer_size());
    (frame.width, frame.height, buf)
}

// ---------------------------------------------------------------- text (sample.pdf)

#[test]
fn text_pdf_metadata_and_page_sizes() {
    let core = PdfCore::new();
    let meta = core.inspect(arc(SAMPLE), None).expect("inspect");
    assert_eq!(meta.page_count, 1);
    assert_eq!(meta.title.as_deref(), Some("untitled"));
    assert_eq!(meta.author.as_deref(), Some("anonymous"));
    assert_eq!(meta.leitor_book_uid, None);

    let h = open(&core, SAMPLE);
    let info = core.info(h).expect("info");
    assert_eq!(info.doc_id, h.to_string());
    assert_eq!(info.page_count, 1);
    assert!(
        (info.pages[0].width - 595.2756).abs() < 0.01
            && (info.pages[0].height - 841.8898).abs() < 0.01,
        "{:?}",
        info.pages[0]
    );
    assert_eq!(info.title.as_deref(), Some("untitled"));
    assert!(core.outline(h).expect("outline").is_empty());
    assert_eq!(core.open_documents(), [h]);
    core.close(h);
    assert!(core.open_documents().is_empty());
}

#[test]
fn text_pdf_words_have_rects_and_offsets() {
    let core = PdfCore::new();
    let h = open(&core, SAMPLE);
    let pw = core.page_words(h, 0).expect("words");
    assert!(!pw.words.is_empty());
    assert!((pw.width - 595.2756).abs() < 0.01);
    // Offsets are UTF-16 code units, like JS `text.slice(start, end)`.
    let units: Vec<u16> = pw.text.encode_utf16().collect();
    for (n, w) in pw.words.iter().enumerate() {
        assert_eq!(w.index, n);
        assert_eq!(String::from_utf16_lossy(&units[w.start..w.end]), w.text);
        assert!(!w.rects.is_empty(), "{w:?}");
        assert!(
            w.rects.iter().all(|r| inside(r, pw.width, pw.height)),
            "{w:?}"
        );
    }
    let summary: Vec<String> = pw
        .words
        .iter()
        .take(12)
        .map(|w| {
            let r = w.rects[0];
            format!(
                "{} {:?} [{:.0} {:.0} {:.0} {:.0}]",
                w.index, w.text, r[0], r[1], r[2], r[3]
            )
        })
        .collect();
    insta::assert_snapshot!("sample_first_words", summary.join("\n"));

    let json = serde_json::to_value(&pw).expect("json");
    assert!(
        json["words"][0]["rects"][0]
            .as_array()
            .is_some_and(|r| r.len() == 4)
    );
    assert_eq!(core.text_stats(h, 40).expect("stats").pages_with_text, 1);
}

#[test]
fn cover_is_a_png_within_the_size_bound_on_white() {
    let core = PdfCore::new();
    let h = open(&core, SAMPLE);
    let png = core.cover_png(h, 480).expect("cover");
    let (w, hgt, rgba) = decode_png(&png);
    assert_eq!(png_size(&png), (w, hgt));
    assert_eq!(hgt, 480, "portrait page: the height is the longest side");
    assert!((338..=340).contains(&w), "{w}");
    assert_eq!(&rgba[..4], &[255, 255, 255, 255], "white corner");
    assert!(rgba.chunks_exact(4).all(|p| p[3] == 255), "opaque");
    assert!(rgba.chunks_exact(4).any(|p| p[0] < 128), "text drawn");

    let small = core.cover_png(h, 64).expect("small cover");
    let (w, hgt) = png_size(&small);
    assert!(w <= 64 && hgt <= 64, "{w}x{hgt}");
    assert!(matches!(
        core.cover_png(h, 0),
        Err(PdfError::InvalidRequest(_))
    ));
}

#[test]
fn concurrent_calls_from_many_threads() {
    let core = Arc::new(PdfCore::new());
    let h = open(&core, &book());
    let threads: Vec<_> = (0..12)
        .map(|i| {
            let core = core.clone();
            std::thread::spawn(move || {
                let words = core.page_words(h, i % 3)?;
                let cover = core.cover_png(h, 120)?;
                Ok::<_, PdfError>((words.words.len(), cover.len()))
            })
        })
        .collect();
    for t in threads {
        let (words, cover) = t.join().expect("no panic").expect("calls ok");
        assert!(words > 0 && cover > 0);
    }
}

// ---------------------------------------------------------------- rotated and cropped

#[test]
fn rotated_and_cropped_pages_use_view_space() {
    let core = PdfCore::new();
    let h = open(&core, &book());
    let info = core.info(h).expect("info");
    assert_eq!(info.page_count, 3);
    let sizes: Vec<(f32, f32)> = info.pages.iter().map(|p| (p.width, p.height)).collect();
    assert_eq!(sizes, [(300.0, 200.0), (200.0, 300.0), (200.0, 100.0)]);

    let rotated = core.page_words(h, 1).expect("words");
    assert_eq!((rotated.width, rotated.height), (200.0, 300.0));
    let texts: Vec<&str> = rotated.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["Rotated", "words", "here"]);
    for w in &rotated.words {
        assert!(w.rects.iter().all(|r| inside(r, 200.0, 300.0)), "{w:?}");
        // Turned 90° clockwise, the line runs down the page: taller than wide.
        assert!(w.rects.iter().all(|r| r[3] > r[2]), "{w:?}");
    }

    let cropped = core.page_words(h, 2).expect("words");
    let texts: Vec<&str> = cropped.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["Cropped", "text"]);
    // The text starts at x = 60 in user space, 10 pt right of the crop's left edge.
    let first = cropped.words[0].rects[0];
    assert!((first[0] - 10.0).abs() < 2.0, "{first:?}");
    assert!(
        cropped
            .words
            .iter()
            .all(|w| w.rects.iter().all(|r| inside(r, 200.0, 100.0)))
    );

    // A book whose first page is rotated gets a landscape-turned-portrait cover.
    let first_rotated = build_pdf(
        &[PageSpec {
            rotate: 90,
            ..PageSpec::text(20.0, 100.0, "Turned")
        }],
        &[],
        &[],
    );
    let h = open(&core, &first_rotated);
    let (w, hgt) = png_size(&core.cover_png(h, 300).expect("cover"));
    assert_eq!((w, hgt), (200, 300));
}

// ---------------------------------------------------------------- outline

#[test]
fn outline_has_zero_based_pages_and_nesting() {
    let core = PdfCore::new();
    let bytes = book();
    let meta = core.inspect(arc(&bytes), None).expect("inspect");
    assert_eq!(meta.title.as_deref(), Some("Livro de teste"));
    assert_eq!(meta.author.as_deref(), Some("Autora"));
    let h = open(&core, &bytes);
    let outline = core.outline(h).expect("outline");
    let json = serde_json::to_value(&outline).expect("json");
    assert_eq!(
        json,
        serde_json::json!([
            { "title": "Capítulo 1", "page": 0, "children": [{ "title": "Seção 1.1", "page": 1, "children": [] }] },
            { "title": "Capítulo 2", "page": 2, "children": [] },
        ])
    );
}

// ---------------------------------------------------------------- scanned

#[test]
fn scanned_pdf_has_no_words_and_looks_scanned() {
    let core = PdfCore::new();
    let bytes = scanned(5);
    assert_eq!(
        core.inspect(arc(&bytes), None).expect("inspect").page_count,
        5
    );
    let h = open(&core, &bytes);
    assert!(core.page_words(h, 0).expect("words").words.is_empty());
    let stats = core.text_stats(h, 40).expect("stats");
    assert_eq!(
        stats,
        TextStats {
            pages_checked: 5,
            pages_with_text: 0
        }
    );
    assert!(stats.looks_scanned());
    let (_, _, rgba) = decode_png(&core.cover_png(h, 200).expect("cover"));
    assert!(
        rgba.chunks_exact(4).any(|p| p[0] < 0xc0),
        "the scan is drawn on the cover"
    );

    let text = open(&core, &long_book(3));
    assert!(!core.text_stats(text, 40).expect("stats").looks_scanned());
}

#[test]
fn scanned_detection_rule() {
    let s = |checked, with_text| TextStats {
        pages_checked: checked,
        pages_with_text: with_text,
    };
    assert!(s(10, 4).looks_scanned());
    assert!(
        !s(10, 5).looks_scanned(),
        "exactly half is not less than half"
    );
    assert!(!s(0, 0).looks_scanned());
    // Pages with 20 characters or fewer do not count as text.
    let short = build_pdf(
        &[
            PageSpec::text(20.0, 100.0, "Twenty chars exactly"), // 18 visible
            PageSpec::text(
                20.0,
                100.0,
                "This line has many more than twenty characters",
            ),
        ],
        &[],
        &[],
    );
    let core = PdfCore::new();
    let h = open(&core, &short);
    assert_eq!(core.text_stats(h, 40).expect("stats"), s(2, 1));
    assert_eq!(core.text_stats(h, 1).expect("stats"), s(1, 0));
    assert_eq!(core.text_stats(h, 0).expect("stats"), s(0, 0));
}

// ---------------------------------------------------------------- comments

#[test]
fn comments_do_not_disturb_metadata_or_words() {
    let core = PdfCore::new();
    let bytes = commented();
    let meta = core.inspect(arc(&bytes), None).expect("inspect");
    assert_eq!(meta.page_count, 1);
    let h = open(&core, &bytes);
    let words: Vec<String> = core
        .page_words(h, 0)
        .expect("words")
        .words
        .into_iter()
        .map(|w| w.text)
        .collect();
    assert_eq!(words, ["Commented", "page", "text"]);
    core.cover_png(h, 100).expect("cover");
}

// ---------------------------------------------------------------- passwords

#[test]
fn passwords_user_and_owner() {
    use pdfcraft_cos::Algorithm;
    let core = PdfCore::new();
    // AES-256 (R6) and RC4-128 (R3), where the owner password must be turned into the user one.
    for algorithm in [Algorithm::Aes256, Algorithm::Rc4_128, Algorithm::Aes128] {
        let bytes = arc(&protected(algorithm, "leitor", "dono"));
        assert_eq!(
            core.inspect(bytes.clone(), None).err(),
            Some(PdfError::NeedsPassword),
            "{algorithm:?}"
        );
        assert_eq!(
            core.open(bytes.clone(), Some("errada")).err(),
            Some(PdfError::WrongPassword),
            "{algorithm:?}"
        );
        for pw in ["leitor", "dono"] {
            let meta = core
                .inspect(bytes.clone(), Some(pw))
                .unwrap_or_else(|e| panic!("{algorithm:?} {pw}: {e:?}"));
            assert_eq!(meta.page_count, 1);
            let h = core
                .open(bytes.clone(), Some(pw))
                .unwrap_or_else(|e| panic!("{algorithm:?} {pw}: {e:?}"));
            assert_eq!(
                core.page_words(h, 0).expect("words").text,
                "Secret page",
                "{algorithm:?} {pw}"
            );
            core.cover_png(h, 100).expect("cover");
            core.close(h);
        }
    }
    assert_eq!(PdfError::NeedsPassword.code(), "pdf_needs_password");
    assert_eq!(PdfError::WrongPassword.http_status(), 403);
}

// ---------------------------------------------------------------- corrupted

#[test]
fn garbage_empty_and_pageless_input_are_errors() {
    let core = PdfCore::new();
    let zero_pages = pdfcraft_testkit::Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R >>")
        .obj("<< /Type /Pages /Kids [] /Count 0 >>")
        .build();
    let mut bogus_xref = book();
    let tail = b"startxref\n999999999999\n%%EOF\n";
    bogus_xref.extend_from_slice(tail);
    let mut huge_size = SAMPLE.to_vec();
    huge_size.extend_from_slice(
        b"\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4294967295 /Root 999999 0 R >>\nstartxref\n0\n%%EOF\n",
    );
    let inputs: Vec<Vec<u8>> = vec![
        Vec::new(),
        b"not a pdf at all".to_vec(),
        b"%PDF-1.7\n%%EOF\n".to_vec(),
        vec![0xff; 4096],
        zero_pages,
    ];
    for bytes in &inputs {
        let err = core.inspect(arc(bytes), None).expect_err("must fail");
        assert!(
            matches!(err, PdfError::Invalid(_) | PdfError::Unsupported(_)),
            "{err:?}"
        );
        assert_eq!(err.http_status(), 422);
        assert!(core.open(arc(bytes), None).is_err());
    }
    // Damaged structures may be repaired or refused, but must answer.
    for bytes in [bogus_xref, huge_size] {
        if let Ok(h) = core.open(arc(&bytes), None) {
            let _ = core.page_words(h, 0);
            let _ = core.cover_png(h, 64);
            core.close(h);
        }
        let _ = read_info(arc(&bytes), LEITOR_BOOK_UID_KEY);
        let _ = stamp_info(&bytes, LEITOR_BOOK_UID_KEY, &"a".repeat(64));
    }
    assert!(core.open_documents().is_empty());
}

#[test]
fn truncated_files_never_panic() {
    let core = PdfCore::new();
    assert!(core.open(arc(&SAMPLE[..300]), None).is_err());
    let book = book();
    let scan = scanned(2);
    for source in [SAMPLE, &book[..], &scan[..]] {
        // Cut points spread over the file plus a few pseudo-random ones (bounded for speed).
        let mut cuts: Vec<usize> = (0..source.len()).step_by(source.len() / 40 + 1).collect();
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..20 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            cuts.push((x % source.len() as u64) as usize);
        }
        for cut in cuts {
            let bytes = arc(&source[..cut]);
            let _ = core.inspect(bytes.clone(), None);
            let _ = read_info(bytes.clone(), LEITOR_BOOK_UID_KEY);
            let Ok(h) = core.open(bytes, None) else {
                continue;
            };
            // A recovered file may work or fail per page, but must answer.
            let _ = core.page_words(h, 0);
            let _ = core.text_stats(h, 3);
            let _ = core.cover_png(h, 48);
            core.close(h);
        }
    }
}

#[test]
fn bad_requests_are_typed_errors() {
    let core = PdfCore::new();
    let h = open(&core, SAMPLE);
    let err = core.page_words(h, 5).expect_err("out of range");
    assert!(matches!(err, PdfError::InvalidRequest(_)), "{err:?}");
    assert_eq!(err.http_status(), 400);
    assert_eq!(err.code(), "invalid_request");
    assert!(err.to_string().contains("página 6"), "{err}");

    core.close(h);
    core.close(h); // unknown handles are ignored
    assert_eq!(core.info(h).err(), Some(PdfError::UnknownDocument));
    assert_eq!(core.cover_png(h, 10).err(), Some(PdfError::UnknownDocument));
    assert_eq!(core.text_stats(h, 1).err(), Some(PdfError::UnknownDocument));
    assert_eq!(PdfError::UnknownDocument.http_status(), 404);
    assert_eq!("12".parse::<DocHandle>().ok(), Some(DocHandle(12)));
    assert!("x".parse::<DocHandle>().is_err());

    let err = serde_json::to_value(PdfError::WrongPassword).expect("json");
    assert_eq!(
        err,
        serde_json::json!({ "code": "pdf_wrong_password", "message": "Senha incorreta." })
    );
}

// ---------------------------------------------------------------- LeitorBookUid

#[test]
fn leitor_book_uid_stamp_and_read_round_trip() {
    let core = PdfCore::new();
    let uid = "0123456789abcdef".repeat(4);
    let original = book();
    assert_eq!(read_info(arc(&original), LEITOR_BOOK_UID_KEY), Ok(None));

    let stamped = stamp_info(&original, LEITOR_BOOK_UID_KEY, &uid).expect("stamp");
    assert!(stamped.len() > original.len());
    assert_eq!(
        &stamped[..original.len()],
        &original[..],
        "incremental: the original bytes are untouched"
    );
    assert_eq!(
        read_info(arc(&stamped), LEITOR_BOOK_UID_KEY),
        Ok(Some(uid.clone()))
    );
    let meta = core.inspect(arc(&stamped), None).expect("inspect");
    assert_eq!(meta.leitor_book_uid.as_deref(), Some(uid.as_str()));
    // Other metadata survives.
    assert_eq!(meta.title.as_deref(), Some("Livro de teste"));
    assert_eq!(meta.page_count, 3);

    // Idempotent: stamping the same value returns the same bytes.
    assert_eq!(
        stamp_info(&stamped, LEITOR_BOOK_UID_KEY, &uid).expect("again"),
        stamped
    );
    // A new value is a new revision.
    let other = "f".repeat(64);
    let restamped = stamp_info(&stamped, LEITOR_BOOK_UID_KEY, &other).expect("restamp");
    assert_eq!(
        core.inspect(arc(&restamped), None)
            .expect("inspect")
            .leitor_book_uid,
        Some(other)
    );

    // A file without an Info dictionary gets one.
    let bare = scanned(1);
    let stamped = stamp_info(&bare, LEITOR_BOOK_UID_KEY, &uid).expect("stamp bare");
    assert_eq!(
        core.inspect(arc(&stamped), None)
            .expect("inspect")
            .leitor_book_uid,
        Some(uid)
    );
}

#[test]
fn malformed_leitor_book_uid_is_ignored() {
    let core = PdfCore::new();
    for bad in ["not-a-uid", &"A".repeat(64), &"a".repeat(65)] {
        let bytes = build_pdf(
            &[PageSpec::text(20.0, 100.0, "x")],
            &[],
            &[(LEITOR_BOOK_UID_KEY, bad)],
        );
        assert_eq!(
            core.inspect(arc(&bytes), None)
                .expect("inspect")
                .leitor_book_uid,
            None,
            "{bad}"
        );
        // read_info reports the raw value; validation is the importer's job.
        assert_eq!(
            read_info(arc(&bytes), LEITOR_BOOK_UID_KEY),
            Ok(Some(bad.to_owned()))
        );
    }
    assert!(stamp_info(SAMPLE, "Bad Key", "x").is_err());
    assert!(matches!(
        read_info(arc(b"garbage"), LEITOR_BOOK_UID_KEY),
        Err(PdfError::Invalid(_))
    ));
}

// ---------------------------------------------------------------- 500 pages

#[test]
fn five_hundred_pages_import_quickly() {
    let bytes = arc(&long_book(500));
    let size_kb = bytes.len() / 1024;
    let core = PdfCore::new();
    let t = Instant::now();
    let meta = core.inspect(bytes.clone(), None).expect("inspect");
    let inspect = t.elapsed();
    let h = core.open(bytes, None).expect("open");
    let stats = core.text_stats(h, 40).expect("stats");
    let cover = core.cover_png(h, 480).expect("cover");
    let total = t.elapsed();
    let t = Instant::now();
    let last = core.page_words(h, 499).expect("last page words");
    let words = t.elapsed();
    println!(
        "500 pages ({size_kb} KB): inspect {inspect:?}, inspect+open+text_stats(40)+cover {total:?}, words of one page {words:?}"
    );
    assert_eq!(meta.page_count, 500);
    assert_eq!(stats.pages_checked, 40);
    assert_eq!(stats.pages_with_text, 40);
    assert!(!cover.is_empty());
    assert_eq!(last.words[0].text, "Page");
    assert_eq!(last.words[1].text, "500");
    // Spec target is 3 s; debug builds of this crate run with opt-level 1 (dependencies at 2)
    // and CI machines vary, so the debug bound is generous.
    let limit = if cfg!(debug_assertions) { 15.0 } else { 3.0 };
    assert!(total.as_secs_f32() < limit, "{total:?}");
}
