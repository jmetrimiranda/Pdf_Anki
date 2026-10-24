//! Container/OPF/TOC parsing, metadata, sections and covers.

mod common;

use common::{Custom, open};
use core_epub::testkit::{
    ChapterSpec, EpubBuilder, EpubVersion, ExtraFile, tiny_png, xhtml_doc, zip_entries,
};
use core_epub::{EpubError, TocItem};

/// `(depth, title, section, fragment)` in pre-order.
fn outline(items: &[TocItem]) -> Vec<(usize, String, Option<u32>, Option<String>)> {
    fn walk(
        items: &[TocItem],
        depth: usize,
        out: &mut Vec<(usize, String, Option<u32>, Option<String>)>,
    ) {
        for i in items {
            out.push((depth, i.title.clone(), i.section, i.fragment.clone()));
            walk(&i.children, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(items, 0, &mut out);
    out
}

fn sample_outline() -> Vec<(usize, String, Option<u32>, Option<String>)> {
    vec![
        (0, "Part I".into(), Some(0), None),
        (1, "Chapter 1".into(), Some(1), None),
        (2, "Section 1.1".into(), Some(2), None),
        (2, "Section 1.2".into(), Some(1), Some("s1-2".into())),
        (0, "Part II".into(), Some(3), None),
        (1, "Chapter 2".into(), Some(4), None),
    ]
}

#[test]
fn epub2_with_ncx_only() {
    let book = open(EpubBuilder::sample(EpubVersion::V2).build()).unwrap();
    assert_eq!(book.meta().version, EpubVersion::V2);
    assert!(!book.toc_is_fallback());
    assert_eq!(outline(book.toc()), sample_outline());
    assert_eq!(book.sections().len(), 5);
    assert_eq!(book.toc()[0].href, "OEBPS/text/ch01.xhtml");
    for (i, s) in book.sections().iter().enumerate() {
        assert_eq!(s.index as usize, i);
        assert_eq!(s.href, format!("OEBPS/text/ch{:02}.xhtml", i + 1));
        assert_eq!(s.media_type, "application/xhtml+xml");
        assert!(s.linear);
    }
}

#[test]
fn epub3_with_nav_only() {
    let book = open(EpubBuilder::sample(EpubVersion::V3).build()).unwrap();
    assert_eq!(book.meta().version, EpubVersion::V3);
    assert!(!book.toc_is_fallback());
    assert_eq!(outline(book.toc()), sample_outline());
    // Nested three levels, the fragment child resolved to its parent's file.
    let section_1_2 = &book.toc()[0].children[0].children[1];
    assert_eq!(section_1_2.href, "OEBPS/text/ch02.xhtml");
    assert_eq!(section_1_2.fragment.as_deref(), Some("s1-2"));
    assert_eq!(book.section_label(2).as_deref(), Some("Section 1.1"));
    assert_eq!(book.section_label(1).as_deref(), Some("Chapter 1"));
    assert_eq!(book.section_label(0).as_deref(), Some("Part I"));
    assert_eq!(book.section_label(4).as_deref(), Some("Chapter 2"));
    assert_eq!(book.section_label(99), None);
}

#[test]
fn nav_wins_over_ncx_and_empty_nav_falls_back_to_ncx() {
    let builder = EpubBuilder::sample(EpubVersion::V3).with_ncx(true);
    let mut entries = builder.entries();
    for (name, bytes) in &mut entries {
        if name.ends_with("toc.ncx") {
            *bytes = String::from_utf8(bytes.clone())
                .unwrap()
                .replace(">Part I<", ">NCX Part I<")
                .into_bytes();
        }
    }
    let book = open(zip_entries(&entries)).unwrap();
    assert_eq!(book.toc()[0].title, "Part I");

    for (name, bytes) in &mut entries {
        if name.ends_with("nav.xhtml") {
            *bytes = xhtml_doc("Nav", "<nav epub:type=\"toc\"><ol></ol></nav><nav epub:type=\"landmarks\"><ol><li><a href=\"text/ch01.xhtml\">L</a></li></ol></nav>").into_bytes();
        }
    }
    let book = open(zip_entries(&entries)).unwrap();
    assert_eq!(book.toc()[0].title, "NCX Part I");
    assert!(!book.toc_is_fallback());
}

#[test]
fn toc_hrefs_relative_to_the_nav_dir_and_percent_encoded() {
    let mut c = Custom::one_chapter("<p>x</p>");
    c.manifest = "<item id=\"c1\" href=\"Text/Chapter%20One.xhtml\" media-type=\"application/xhtml+xml\"/>\
                  <item id=\"c2\" href=\"Text/caf%C3%A9.xhtml\" media-type=\"application/xhtml+xml\"/>\
                  <item id=\"nav\" href=\"Nav/nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>"
        .into();
    c.spine = "<itemref idref=\"c1\"/><itemref idref=\"c2\"/>".into();
    c.files = vec![
        ("OEBPS/Text/Chapter One.xhtml".into(), xhtml_doc("One", "<p>one</p>").into_bytes()),
        ("OEBPS/Text/café.xhtml".into(), xhtml_doc("Two", "<p>two</p>").into_bytes()),
        (
            "OEBPS/Nav/nav.xhtml".into(),
            xhtml_doc(
                "Nav",
                "<nav epub:type=\"toc\"><ol><li><a href=\"../Text/Chapter%20One.xhtml#sec%201\">  One\n </a></li>\
                 <li><span>Group</span><ol><li><a href=\"../Text/caf%C3%A9.xhtml\">Café</a></li></ol></li>\
                 <li><a href=\"http://example.com/\">External</a></li></ol></nav>",
            )
            .into_bytes(),
        ),
    ];
    let book = open(c.build()).unwrap();
    assert_eq!(book.sections()[0].href, "OEBPS/Text/Chapter One.xhtml");
    assert_eq!(book.sections()[1].href, "OEBPS/Text/café.xhtml");
    let toc = book.toc();
    assert_eq!(toc[0].title, "One");
    assert_eq!(toc[0].href, "OEBPS/Text/Chapter One.xhtml");
    assert_eq!(toc[0].fragment.as_deref(), Some("sec 1"));
    assert_eq!(toc[0].section, Some(0));
    // A heading without a link covers its first child.
    assert_eq!(toc[1].title, "Group");
    assert_eq!(toc[1].href, "");
    assert_eq!(toc[1].section, Some(1));
    assert_eq!(toc[1].children[0].section, Some(1));
    assert_eq!(toc[2].section, None);
    assert_eq!(
        book.section_of_href("OEBPS/Text/Chapter%20One.xhtml#x"),
        Some(0)
    );
    assert_eq!(book.section_of_href("OEBPS/Text/café.xhtml"), Some(1));
    assert_eq!(book.section_of_href("nope.xhtml"), None);
}

#[test]
fn missing_toc_falls_back_to_headings() {
    let book = open(core_epub::testkit::without_toc()).unwrap();
    assert!(book.toc_is_fallback());
    let titles: Vec<_> = book
        .toc()
        .iter()
        .map(|t| (t.title.as_str(), t.section))
        .collect();
    assert_eq!(titles, [("One", Some(0)), ("Two", Some(1))]);

    // No heading: the <title>; nothing at all: "Seção N". Non-linear sections are left out.
    let mut c = Custom::one_chapter("<p>no heading</p>");
    c.manifest.push_str(
        "<item id=\"ch2\" href=\"text/ch2.xhtml\" media-type=\"application/xhtml+xml\"/>\
         <item id=\"ch3\" href=\"text/ch3.xhtml\" media-type=\"application/xhtml+xml\"/>",
    );
    c.spine
        .push_str("<itemref idref=\"ch2\" linear=\"no\"/><itemref idref=\"ch3\"/>");
    c.files.push((
        "OEBPS/text/ch2.xhtml".into(),
        xhtml_doc("Notes", "<h1>Notes</h1>").into_bytes(),
    ));
    c.files.push((
        "OEBPS/text/ch3.xhtml".into(),
        b"<html><body><p>bare</p></body></html>".to_vec(),
    ));
    let book = open(c.build()).unwrap();
    assert!(book.toc_is_fallback());
    let titles: Vec<_> = book
        .toc()
        .iter()
        .map(|t| (t.title.as_str(), t.section))
        .collect();
    assert_eq!(titles, [("Chapter", Some(0)), ("Seção 3", Some(2))]);
}

#[test]
fn non_linear_spine_item_keeps_its_index() {
    let book = open(
        EpubBuilder::new(EpubVersion::V3)
            .chapter(ChapterSpec::new("A", "<p>a</p>"))
            .chapter(ChapterSpec::new("Notes", "<p>n</p>"))
            .chapter(ChapterSpec::new("C", "<p>c</p>"))
            .non_linear(1)
            .build(),
    )
    .unwrap();
    let linear: Vec<_> = book
        .sections()
        .iter()
        .map(|s| (s.index, s.linear))
        .collect();
    assert_eq!(linear, [(0, true), (1, false), (2, true)]);
    assert_eq!(book.section_for_cfi("epubcfi(/6/6!/4/2/1:0)"), Some(2));
    assert_eq!(book.section_for_cfi("epubcfi(/6/8!/4)"), None);
}

#[test]
fn itemrefs_without_manifest_item_are_skipped_like_foliate() {
    let mut c = Custom::one_chapter("<h1>A</h1>");
    c.manifest.push_str(
        "<item id=\"ch2\" href=\"text/ch2.xhtml\" media-type=\"application/xhtml+xml\"/>",
    );
    c.spine = "<itemref idref=\"ch1\"/><itemref idref=\"ghost\"/><itemref idref=\"ch2\"/>".into();
    c.files.push((
        "OEBPS/text/ch2.xhtml".into(),
        xhtml_doc("B", "<h1>B</h1>").into_bytes(),
    ));
    let book = open(c.build()).unwrap();
    assert_eq!(book.sections().len(), 2);
    assert_eq!(book.sections()[1].id, "ch2");
    assert_eq!(book.sections()[1].index, 1);
    assert_eq!(book.spine_position(1), Some(2));
    // The CFI keeps the itemref position: /6/6 is the third itemref = section 1.
    assert_eq!(core_epub::section_of_cfi("epubcfi(/6/6!/4)"), Some(2));
    assert_eq!(book.section_for_cfi("epubcfi(/6/6!/4)"), Some(1));
    assert_eq!(book.section_for_cfi("epubcfi(/6/4!/4)"), None);
}

#[test]
fn metadata() {
    let book = open(
        EpubBuilder::new(EpubVersion::V3)
            .title("  O   Livro ")
            .authors(&["Ana Souza", "Bruno Lima", "Ana Souza"])
            .language("pt-BR")
            .identifier("isbn:123")
            .chapter(ChapterSpec::new("A", "<p>a</p>"))
            .build(),
    )
    .unwrap();
    let meta = book.meta();
    assert_eq!(meta.title.as_deref(), Some("O Livro"));
    assert_eq!(meta.authors, ["Ana Souza", "Bruno Lima"]);
    assert_eq!(meta.language.as_deref(), Some("pt-BR"));
    assert_eq!(meta.identifier.as_deref(), Some("isbn:123"));

    let mut c = Custom::one_chapter("<p>x</p>");
    c.metadata = "<dc:identifier id=\"other\">urn:x</dc:identifier><dc:identifier id=\"id\">urn:main</dc:identifier>".into();
    let book = open(c.build()).unwrap();
    assert_eq!(book.meta().identifier.as_deref(), Some("urn:main"));
    assert_eq!(book.meta().title, None);
    assert!(book.meta().authors.is_empty());
    let json = serde_json::to_value(book.meta()).unwrap();
    assert_eq!(json["version"], "V3");
}

#[test]
fn opens_without_container_through_the_first_opf() {
    let book = open(core_epub::testkit::without_container()).unwrap();
    assert_eq!(book.sections().len(), 2);
}

fn png(rgb: [u8; 3]) -> Vec<u8> {
    tiny_png(3, 5, rgb)
}

#[test]
fn cover_from_each_strategy() {
    // 1. EPUB 3 cover-image property.
    let a = png([1, 0, 0]);
    let c = Custom::one_chapter("<p>x</p>")
        .manifest("<item id=\"c\" href=\"img/c.png\" media-type=\"image/png\" properties=\"cover-image\"/>")
        .file("OEBPS/img/c.png", a.clone());
    let cover = open(c.build()).unwrap().cover().unwrap();
    assert_eq!((cover.media_type.as_str(), cover.bytes), ("image/png", a));

    // 2. EPUB 2 <meta name="cover">.
    let b = png([2, 0, 0]);
    let mut c = Custom::one_chapter("<p>x</p>")
        .manifest("<item id=\"pic\" href=\"img/p.png\" media-type=\"image/png\"/>")
        .file("OEBPS/img/p.png", b.clone());
    c.metadata
        .push_str("<meta name=\"cover\" content=\"pic\"/>");
    assert_eq!(open(c.build()).unwrap().cover().unwrap().bytes, b);

    // 3. A manifest image whose id/href mentions "cover".
    let d = png([3, 0, 0]);
    let c = Custom::one_chapter("<p>x</p>")
        .manifest("<item id=\"i1\" href=\"img/other.png\" media-type=\"image/png\"/><item id=\"i2\" href=\"img/Front-Cover.png\" media-type=\"image/png\"/>")
        .file("OEBPS/img/other.png", png([9, 9, 9]))
        .file("OEBPS/img/Front-Cover.png", d.clone());
    assert_eq!(open(c.build()).unwrap().cover().unwrap().bytes, d);

    // 4. The first image of the first section (not even in the manifest).
    let e = png([4, 0, 0]);
    let c = Custom::one_chapter("<p><img src=\"../x/fig%201.png\" alt=\"\"/></p>")
        .file("OEBPS/x/fig 1.png", e.clone());
    assert_eq!(open(c.build()).unwrap().cover().unwrap().bytes, e);

    // The builder's cover (property + meta).
    let book = open(EpubBuilder::sample(EpubVersion::V2).build()).unwrap();
    assert_eq!(book.cover().unwrap().media_type, "image/png");
}

#[test]
fn svg_and_oversized_or_fake_covers_are_ignored() {
    let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
    let c = Custom::one_chapter("<p>x</p>")
        .manifest("<item id=\"c\" href=\"img/cover.svg\" media-type=\"image/svg+xml\" properties=\"cover-image\"/>")
        .file("OEBPS/img/cover.svg", svg);
    assert_eq!(open(c.build()).unwrap().cover(), None);

    // A "PNG" that isn't one.
    let c = Custom::one_chapter("<p>x</p>")
        .manifest("<item id=\"c\" href=\"img/c.png\" media-type=\"image/png\" properties=\"cover-image\"/>")
        .file("OEBPS/img/c.png", b"not an image".to_vec());
    assert_eq!(open(c.build()).unwrap().cover(), None);

    // Too big (> 10 MiB once inflated).
    let mut big = png([5, 5, 5]);
    big.extend(core_epub::testkit::garbage(7, 11 << 20));
    let c = Custom::one_chapter("<p>x</p>")
        .manifest("<item id=\"c\" href=\"img/c.png\" media-type=\"image/png\" properties=\"cover-image\"/>")
        .file("OEBPS/img/c.png", big);
    assert_eq!(open(c.build()).unwrap().cover(), None);
}

#[test]
fn ncx_found_by_media_type_in_another_dir() {
    let ncx = "<?xml version=\"1.0\"?><ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\"><navMap>\
               <navPoint id=\"a\"><navLabel><text>Só o NCX</text></navLabel><content src=\"../text/ch01.xhtml\"/></navPoint>\
               </navMap></ncx>";
    let book = open(
        EpubBuilder::new(EpubVersion::V2)
            .with_ncx(false)
            .chapter(ChapterSpec::new("A", "<p>a</p>"))
            .extra_file(ExtraFile {
                path: "OEBPS/misc/other.ncx".into(),
                bytes: ncx.as_bytes().to_vec(),
                manifest: Some(("ncx2".into(), "application/x-dtbncx+xml".into())),
            })
            .build(),
    )
    .unwrap();
    assert_eq!(book.toc()[0].title, "Só o NCX");
    assert_eq!(book.toc()[0].section, Some(0));
}

#[test]
fn no_sections_is_no_content() {
    let mut c = Custom::one_chapter("<p>x</p>");
    c.spine = String::new();
    assert_eq!(open(c.build()).unwrap_err(), EpubError::NoContent);
    let mut c = Custom::one_chapter("<p>x</p>");
    c.spine = "<itemref idref=\"ghost\"/>".into();
    assert_eq!(open(c.build()).unwrap_err(), EpubError::NoContent);
}
