//! Untrusted files never panic (spec 18): every damaged or hostile input is an `EpubError`.

mod common;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use common::{Custom, open};
use core_epub::testkit::{
    self, ChapterSpec, EpubBuilder, EpubVersion, Rng, container_xml, encryption_xml, garbage,
    truncated, zip_entries, zip_raw,
};
use core_epub::{EpubBook, EpubError};

/// Exercises every entry point of an opened book; none may panic (a caught panic would show up
/// as `EpubError::Internal`).
fn exercise(book: &EpubBook) {
    let never = AtomicBool::new(false);
    if let Err(e) = book.texts(&never, &mut |_, _| {}) {
        assert!(
            !matches!(e, EpubError::Internal(_)),
            "panic inside texts: {e:?}"
        );
    }
    for s in 0..book.sections().len() as u32 + 1 {
        if let Err(e) = book.section_text(s) {
            assert!(
                !matches!(e, EpubError::Internal(_)),
                "panic inside section_text: {e:?}"
            );
        }
        let _ = book.section_label(s);
    }
    let _ = book.cover();
    let _ = book.text_fingerprint();
    let _ = book.section_for_cfi("epubcfi(/6/4!/4/2)");
}

fn check(bytes: Vec<u8>) -> Result<(), EpubError> {
    match core_epub::open(Arc::new(bytes)) {
        Ok(book) => {
            exercise(&book);
            Ok(())
        }
        Err(EpubError::Internal(m)) => panic!("panic inside open: {m}"),
        Err(e) => Err(e),
    }
}

#[test]
fn two_thousand_mutations_never_panic() {
    let base = EpubBuilder::sample(EpubVersion::V3).with_ncx(true).build();
    let start = Instant::now();
    let mut rng = Rng::new(0x5EED);
    let mut errors = 0;
    for i in 0..2000 {
        let mut bytes = base.clone();
        match i % 5 {
            0 => {
                for _ in 0..1 + rng.below(8) {
                    let at = rng.below(bytes.len());
                    bytes[at] ^= 1 << rng.below(8);
                }
            }
            1 => bytes = truncated(&bytes, rng.below(bytes.len())),
            2 => {
                let at = rng.below(bytes.len());
                let len = 1 + rng.below(64);
                let junk = garbage(rng.next_u64(), len);
                let end = (at + len).min(bytes.len());
                bytes.splice(at..end, junk);
            }
            3 => {
                let at = rng.below(bytes.len());
                bytes.insert(at, rng.next_u64() as u8);
            }
            _ => {
                // Corrupt the central directory region (the last ~1 KiB) more aggressively.
                let tail = bytes.len().saturating_sub(1024);
                for _ in 0..1 + rng.below(16) {
                    let at = tail + rng.below(bytes.len() - tail);
                    bytes[at] = rng.next_u64() as u8;
                }
            }
        }
        errors += usize::from(check(bytes).is_err());
    }
    let elapsed = start.elapsed();
    println!("2000 mutations: {elapsed:?}, {errors} errors");
    assert!(
        errors > 100,
        "the mutations should break most files ({errors})"
    );
    assert!(elapsed.as_secs() < 10, "{elapsed:?}");
}

#[test]
fn garbage_empty_and_other_formats() {
    for len in [0, 1, 4, 100, 10_000] {
        assert_eq!(
            check(garbage(len as u64, len)),
            Err(EpubError::NotEpub),
            "garbage {len}"
        );
    }
    assert_eq!(check(Vec::new()), Err(EpubError::NotEpub));
    let pdf = b"%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF".to_vec();
    assert_eq!(check(pdf), Err(EpubError::NotEpub));
    // "PK" but not a zip.
    let mut fake = b"PK\x03\x04".to_vec();
    fake.extend(garbage(3, 500));
    assert_eq!(check(fake), Err(EpubError::NotEpub));
}

#[test]
fn zip_without_epub_structure() {
    let readme = zip_raw(&[("readme.txt".into(), b"hello".to_vec())]);
    assert_eq!(check(readme), Err(EpubError::NotEpub));
    let mimetype_only = zip_entries(&[]);
    assert_eq!(check(mimetype_only), Err(EpubError::NotEpub));
}

#[test]
fn container_pointing_to_a_missing_opf() {
    let bytes = zip_entries(&[(
        "META-INF/container.xml".into(),
        container_xml("OEBPS/missing.opf").into_bytes(),
    )]);
    assert!(matches!(check(bytes), Err(EpubError::Damaged(_))));
}

#[test]
fn opf_that_is_not_xml() {
    for opf in [
        &b"this is not xml"[..],
        b"<package><manifest",
        b"\x00\x01\x02\xFF",
        b"<?xml version='1.0'?><html/>",
    ] {
        let bytes = zip_entries(&[
            (
                "META-INF/container.xml".into(),
                container_xml("content.opf").into_bytes(),
            ),
            ("content.opf".into(), opf.to_vec()),
        ]);
        let r = check(bytes);
        assert!(matches!(r, Err(EpubError::Damaged(_))), "{opf:?}: {r:?}");
    }
}

#[test]
fn zip_bomb_is_too_large() {
    let bomb = testkit::zip_bomb();
    assert!(
        bomb.len() < 1 << 20,
        "the bomb itself stays small ({} bytes)",
        bomb.len()
    );
    let r = open(bomb).and_then(|b| b.texts(&AtomicBool::new(false), &mut |_, _| {}).map(|_| ()));
    assert_eq!(r, Err(EpubError::TooLarge));
}

#[test]
fn oversized_package_file_is_too_large() {
    let mut c = Custom::one_chapter("<p>x</p>");
    c.metadata.push_str(&format!(
        "<dc:description>{}</dc:description>",
        "a".repeat(5 << 20)
    ));
    // Highly compressible → caught by the ratio check or the 4 MiB package limit.
    assert_eq!(check(c.build()), Err(EpubError::TooLarge));
}

#[test]
fn drm_is_detected() {
    assert_eq!(check(testkit::drm_epub()), Err(EpubError::Drm));
    assert_eq!(
        check(testkit::encrypted_entries_epub()),
        Err(EpubError::Drm)
    );

    let base = EpubBuilder::new(EpubVersion::V3).chapter(ChapterSpec::new("A", "<p>a</p>"));
    // rights.xml alone.
    let mut entries = base.entries();
    entries.push(("META-INF/rights.xml".into(), b"<rights/>".to_vec()));
    assert_eq!(check(zip_entries(&entries)), Err(EpubError::Drm));
    // AES on a font is still DRM; obfuscated fonts are not.
    let mut entries = base.entries();
    entries.push((
        "META-INF/encryption.xml".into(),
        encryption_xml(
            "http://www.w3.org/2001/04/xmlenc#aes128-cbc",
            "OEBPS/fonts/a.otf",
        )
        .into_bytes(),
    ));
    assert_eq!(check(zip_entries(&entries)), Err(EpubError::Drm));
    for algorithm in [
        "http://www.idpf.org/2008/embedding",
        "http://ns.adobe.com/pdf/enc#RC",
    ] {
        let mut entries = base.entries();
        entries.push((
            "META-INF/encryption.xml".into(),
            encryption_xml(algorithm, "OEBPS/fonts/a.otf").into_bytes(),
        ));
        assert_eq!(check(zip_entries(&entries)), Ok(()), "{algorithm}");
        // ... but "obfuscating" a content document is not font obfuscation.
        let mut entries = base.entries();
        entries.push((
            "META-INF/encryption.xml".into(),
            encryption_xml(algorithm, "OEBPS/text/ch01.xhtml").into_bytes(),
        ));
        assert_eq!(
            check(zip_entries(&entries)),
            Err(EpubError::Drm),
            "{algorithm} on content"
        );
    }
}

#[test]
fn thirty_thousand_entries_is_too_large() {
    let mut entries = EpubBuilder::new(EpubVersion::V3)
        .chapter(ChapterSpec::new("A", "<p>a</p>"))
        .entries();
    for i in 0..30_000 {
        entries.push((format!("f/{i}"), Vec::new()));
    }
    assert_eq!(check(zip_entries(&entries)), Err(EpubError::TooLarge));
}

#[test]
fn deep_and_huge_tocs_are_bounded() {
    // 40 nested levels: kept down to the depth limit.
    let mut chapter = ChapterSpec::new("L39", "<p>deep</p>");
    for level in (0..39).rev() {
        chapter = ChapterSpec::new(format!("L{level}"), "<p>x</p>").child(chapter);
    }
    let book = open(EpubBuilder::new(EpubVersion::V3).chapter(chapter).build()).unwrap();
    let mut depth = 0;
    let mut items = book.toc();
    while let Some(first) = items.first() {
        depth += 1;
        items = &first.children;
    }
    assert_eq!(depth, core_epub::limits::MAX_TOC_DEPTH);

    // 12 000 TOC entries (all to one section): capped at 10 000.
    let lis: String = (0..12_000)
        .map(|i| format!("<li><a href=\"ch1.xhtml#p{i}\">{i}</a></li>"))
        .collect();
    let c = Custom::one_chapter("<p>x</p>")
        .manifest("<item id=\"nav\" href=\"text/nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>")
        .file("OEBPS/text/nav.xhtml", core_epub::testkit::xhtml_doc("n", &format!("<nav epub:type=\"toc\"><ol>{lis}</ol></nav>")));
    let book = open(c.build()).unwrap();
    assert_eq!(book.toc().len(), core_epub::limits::MAX_TOC_ITEMS);
}

#[test]
fn hostile_hrefs_stay_inside_the_zip() {
    let c = Custom::one_chapter("<p><img src=\"../../../../etc/passwd\"/></p>")
        .manifest("<item id=\"x\" href=\"../../../etc/hostname\" media-type=\"image/png\" properties=\"cover-image\"/>");
    let book = open(c.build()).unwrap();
    assert_eq!(book.cover(), None);
    exercise(&book);
}

#[test]
fn cfi_garbage() {
    let long = format!("epubcfi(/6/4!{})", "/4".repeat(5000));
    for cfi in [
        "",
        "epubcfi(",
        "epubcfi()",
        ")(",
        "epubcfi(/a/b)",
        "epubcfi(//)",
        "epubcfi(/6/4[[[)",
        long.as_str(),
    ] {
        assert_eq!(core_epub::section_of_cfi(cfi), None, "{cfi}");
    }
    assert!(core_epub::is_valid_cfi("epubcfi(/6/4!/4/2/1:0)"));
    assert!(!core_epub::is_valid_cfi("epubcfi(/6/4!/4\n)"));
    assert!(!core_epub::is_valid_cfi(&long));
}
