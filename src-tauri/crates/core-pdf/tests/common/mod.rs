//! PDF fixtures for the core tests (spec 20), built with PdfCraft's testkit so nothing large is
//! committed. Shared by the integration tests; not every test uses every builder.
#![allow(dead_code)]

use std::sync::Arc;

use pdfcraft_testkit::{Pdf, stream_obj};

pub const SAMPLE: &[u8] = include_bytes!("../fixtures/sample.pdf");

pub struct PageSpec {
    pub media: [f32; 4],
    pub rotate: i32,
    pub crop: Option<[f32; 4]>,
    pub content: String,
}

impl PageSpec {
    pub fn text(x: f32, y: f32, s: &str) -> Self {
        Self {
            media: [0.0, 0.0, 300.0, 200.0],
            rotate: 0,
            crop: None,
            content: format!("BT /F1 18 Tf {x} {y} Td ({s}) Tj ET"),
        }
    }

    /// A Letter page with `lines` of 11 pt text.
    pub fn lines(lines: &[String]) -> Self {
        let mut content = String::from("BT /F1 11 Tf 14 TL 72 720 Td");
        for l in lines {
            content.push_str(&format!(" ({}) Tj T*", escape(l)));
        }
        content.push_str(" ET");
        Self {
            media: [0.0, 0.0, 612.0, 792.0],
            rotate: 0,
            crop: None,
            content,
        }
    }
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

/// A bookmark: title, target page, children.
pub struct Mark(pub &'static str, pub usize, pub Vec<Mark>);

/// UTF-16BE text string, so titles can hold any character.
pub fn pdf_text(s: &str) -> String {
    let mut hex = String::from("<FEFF");
    for u in s.encode_utf16() {
        hex.push_str(&format!("{u:04X}"));
    }
    hex.push('>');
    hex
}

/// A valid PDF (classic xref) with Helvetica text pages, an optional outline and Info entries
/// (`(key, value)` pairs, values written as text strings).
pub fn build_pdf(pages: &[PageSpec], outline: &[Mark], info: &[(&str, &str)]) -> Vec<u8> {
    // 1 catalog, 2 page tree, 3 font, then (page, content) pairs, then the outline, then Info.
    let page_obj = |i: usize| 4 + 2 * i;
    let mut objs: Vec<Vec<u8>> = Vec::new();
    let outline_root = 4 + 2 * pages.len();
    objs.push(if outline.is_empty() {
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()
    } else {
        format!("<< /Type /Catalog /Pages 2 0 R /Outlines {outline_root} 0 R >>").into_bytes()
    });
    let kids: Vec<String> = (0..pages.len())
        .map(|i| format!("{} 0 R", page_obj(i)))
        .collect();
    objs.push(
        format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        )
        .into_bytes(),
    );
    objs.push(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    );
    for (i, p) in pages.iter().enumerate() {
        let [a, b, c, d] = p.media;
        let crop = p
            .crop
            .map(|[a, b, c, d]| format!(" /CropBox [{a} {b} {c} {d}]"))
            .unwrap_or_default();
        objs.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [{a} {b} {c} {d}]{crop} /Rotate {} /Contents {} 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
                p.rotate,
                page_obj(i) + 1
            )
            .into_bytes(),
        );
        objs.push(stream_obj("", p.content.as_bytes()));
    }
    if !outline.is_empty() {
        fn count(marks: &[Mark]) -> usize {
            marks.iter().map(|m| 1 + count(&m.2)).sum()
        }
        fn emit(
            marks: &[Mark],
            parent: usize,
            next: &mut usize,
            out: &mut Vec<(usize, String)>,
            page_obj: &dyn Fn(usize) -> usize,
        ) -> Vec<usize> {
            let ids: Vec<usize> = marks
                .iter()
                .map(|m| {
                    let id = *next;
                    *next += 1 + count(&m.2);
                    id
                })
                .collect();
            for (k, m) in marks.iter().enumerate() {
                let mut d = format!(
                    "<< /Title {} /Parent {parent} 0 R /Dest [{} 0 R /Fit]",
                    pdf_text(m.0),
                    page_obj(m.1)
                );
                if k > 0 {
                    d.push_str(&format!(" /Prev {} 0 R", ids[k - 1]));
                }
                if k + 1 < ids.len() {
                    d.push_str(&format!(" /Next {} 0 R", ids[k + 1]));
                }
                let mut child_next = ids[k] + 1;
                let children = emit(&m.2, ids[k], &mut child_next, out, page_obj);
                if let (Some(f), Some(l)) = (children.first(), children.last()) {
                    d.push_str(&format!(
                        " /First {f} 0 R /Last {l} 0 R /Count {}",
                        children.len()
                    ));
                }
                d.push_str(" >>");
                out.push((ids[k], d));
            }
            ids
        }
        let mut items = Vec::new();
        let mut next = outline_root + 1;
        let top = emit(outline, outline_root, &mut next, &mut items, &page_obj);
        objs.push(
            format!(
                "<< /Type /Outlines /First {} 0 R /Last {} 0 R /Count {} >>",
                top[0],
                top[top.len() - 1],
                count(outline)
            )
            .into_bytes(),
        );
        items.sort_by_key(|(id, _)| *id);
        objs.extend(items.into_iter().map(|(_, d)| d.into_bytes()));
    }
    let mut pdf = Pdf::new();
    if !info.is_empty() {
        let entries: String = info
            .iter()
            .map(|(k, v)| format!(" /{k} {}", pdf_text(v)))
            .collect();
        objs.push(format!("<<{entries} >>").into_bytes());
        pdf = pdf.trailer_entry(&format!("/Info {} 0 R", objs.len()));
    }
    pdf.objs(objs).build()
}

/// Three pages: plain, `/Rotate 90`, and an offset `/CropBox`; with a two-level outline.
pub fn book() -> Vec<u8> {
    let plain = PageSpec::text(20.0, 100.0, "Hello world from page one");
    let rotated = PageSpec {
        rotate: 90,
        ..PageSpec::text(20.0, 100.0, "Rotated words here")
    };
    let cropped = PageSpec {
        crop: Some([50.0, 50.0, 250.0, 150.0]),
        ..PageSpec::text(60.0, 100.0, "Cropped text")
    };
    build_pdf(
        &[plain, rotated, cropped],
        &[
            Mark("Capítulo 1", 0, vec![Mark("Seção 1.1", 1, vec![])]),
            Mark("Capítulo 2", 2, vec![]),
        ],
        &[("Title", "Livro de teste"), ("Author", "Autora")],
    )
}

/// `n` Letter pages of running text (about 45 lines each), page number on every page.
pub fn long_book(n: usize) -> Vec<u8> {
    const WORDS: &[&str] = &[
        "reading", "study", "chapter", "memory", "card", "review", "practice", "language",
        "window", "garden", "river", "mountain", "evening", "question", "answer", "history",
    ];
    let pages: Vec<PageSpec> = (0..n)
        .map(|p| {
            let lines: Vec<String> = (0..45)
                .map(|l| {
                    let mut line = format!("Page {} line {}:", p + 1, l + 1);
                    for w in 0..10 {
                        line.push(' ');
                        line.push_str(WORDS[(p * 7 + l * 3 + w) % WORDS.len()]);
                    }
                    line
                })
                .collect();
            PageSpec::lines(&lines)
        })
        .collect();
    build_pdf(&pages, &[], &[("Title", "Livro longo")])
}

/// A scanned book: `pages` pages that only paint an image (no text at all).
pub fn scanned(pages: usize) -> Vec<u8> {
    // 1 catalog, 2 pages, 3 image, 4 content, then one page object per page.
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 5 + i)).collect();
    // A 4x4 grey "scan".
    let pixels: Vec<u8> = (0..16u8).map(|i| 0x40 + i * 8).collect();
    let mut pdf = Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R >>")
        .obj(format!(
            "<< /Type /Pages /Kids [{}] /Count {pages} >>",
            kids.join(" ")
        ))
        .stream(
            "/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8",
            pixels,
        )
        .stream("", b"q 400 0 0 600 100 100 cm /Im1 Do Q");
    for _ in 0..pages {
        pdf = pdf.obj(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 3 0 R >> >> >>",
        );
    }
    pdf.build()
}

/// One text page with two comments in `/Annots`: a sticky note and a highlight.
pub fn commented() -> Vec<u8> {
    Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R >>")
        .obj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
        .obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R 7 0 R] >>")
        .stream("", b"BT /F1 18 Tf 20 100 Td (Commented page text) Tj ET")
        .obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        .obj("<< /Type /Annot /Subtype /Text /Rect [250 150 270 170] /Contents (A note about this page) /T (Leitora) /Name /Comment >>")
        .obj("<< /Type /Annot /Subtype /Highlight /Rect [18 95 120 120] /QuadPoints [18 120 120 120 18 95 120 95] /C [1 1 0] /Contents (Important) >>")
        .build()
}

/// A text page encrypted with `algorithm`, user password `user`, owner password `owner`.
pub fn protected(algorithm: pdfcraft_cos::Algorithm, user: &str, owner: &str) -> Vec<u8> {
    let plain = build_pdf(&[PageSpec::text(20.0, 100.0, "Secret page")], &[], &[]);
    let mut doc = match pdfcraft_cos::Document::open(Arc::new(plain)) {
        Ok(d) => d,
        Err(e) => panic!("fixture parses: {e}"),
    };
    let set = doc.set_encryption(&pdfcraft_cos::NewEncryption {
        algorithm,
        user_password: user,
        owner_password: owner,
        permissions: -1,
        encrypt_metadata: true,
        seed: [7; 32],
    });
    assert!(set.is_ok(), "encrypts: {set:?}");
    match pdfcraft_cos::write_full(&doc, &Default::default()) {
        Ok(b) => b,
        Err(e) => panic!("writes: {e}"),
    }
}

/// `r` in `[x, y, w, h]` lies inside a `width` × `height` page (half a point of slack).
pub fn inside(r: &[f32; 4], width: f32, height: f32) -> bool {
    const EPS: f32 = 0.5;
    r[0] >= -EPS
        && r[1] >= -EPS
        && r[2] > 0.0
        && r[3] > 0.0
        && r[0] + r[2] <= width + EPS
        && r[1] + r[3] <= height + EPS
}

/// Width and height from a PNG's IHDR.
pub fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "PNG signature");
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    (w, h)
}
