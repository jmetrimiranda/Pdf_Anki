//! Fixtures for the app integration tests: small PDFs built in memory (spec 20).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use leitor_app::AppState;
use pdfcraft_testkit::Pdf;

pub fn state(dir: &Path) -> AppState {
    AppState::new(dir.join("data"))
}

pub fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

/// `pages` Letter pages with a few lines of Helvetica text each, plus Info Title/Author.
pub fn text_pdf(pages: usize, title: &str) -> Vec<u8> {
    let mut objs: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {pages} >>",
            (0..pages)
                .map(|i| format!("{} 0 R", 4 + 2 * i))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .into_bytes(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    ];
    for p in 0..pages {
        objs.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
                5 + 2 * p
            )
            .into_bytes(),
        );
        let mut content = String::from("BT /F1 12 Tf 14 TL 72 720 Td");
        for l in 0..6 {
            content.push_str(&format!(
                " ({}) Tj T*",
                escape(&format!(
                    "Page {} line {} reading study memory",
                    p + 1,
                    l + 1
                ))
            ));
        }
        content.push_str(" ET");
        objs.push(pdfcraft_testkit::stream_obj("", content.as_bytes()));
    }
    objs.push(format!("<< /Title ({}) /Author (Autora) >>", escape(title)).into_bytes());
    let info = objs.len();
    Pdf::new()
        .objs(objs)
        .trailer_entry(&format!("/Info {info} 0 R"))
        .build()
}

/// Pages that only paint an image: "parece escaneado".
pub fn scanned_pdf(pages: usize) -> Vec<u8> {
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 5 + i)).collect();
    let pixels: Vec<u8> = (0..16u8).map(|i| 0x40 + i * 8).collect();
    let mut pdf = Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R >>")
        .obj(format!("<< /Type /Pages /Kids [{}] /Count {pages} >>", kids.join(" ")))
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

/// A text page encrypted with a user password.
pub fn protected_pdf() -> Vec<u8> {
    let mut doc = pdfcraft_cos::Document::open(Arc::new(text_pdf(1, "Segredo"))).unwrap();
    doc.set_encryption(&pdfcraft_cos::NewEncryption {
        algorithm: pdfcraft_cos::Algorithm::Aes256,
        user_password: "senha",
        owner_password: "dono",
        permissions: -1,
        encrypt_metadata: true,
        seed: [7; 32],
    })
    .unwrap();
    pdfcraft_cos::write_full(&doc, &Default::default()).unwrap()
}

/// What PdfCraft's bridge sends on save: the original plus an incremental revision with a
/// highlight annotation on page 1 and `LeitorBookUid` in the Info dictionary.
pub fn annotated_version(original: &[u8], book_uid: &str) -> Vec<u8> {
    use pdfcraft_cos::{Dict, ObjRef, Object};
    let mut doc = pdfcraft_cos::Document::open(Arc::new(original.to_vec())).unwrap();
    let mut annot = Dict::new();
    annot.set("Type", Object::name("Annot"));
    annot.set("Subtype", Object::name("Highlight"));
    let rect: Vec<Object> = [72, 700, 300, 716].into_iter().map(Object::from).collect();
    annot.set("Rect", rect);
    let quads: Vec<Object> = [72, 716, 300, 716, 72, 700, 300, 700]
        .into_iter()
        .map(Object::from)
        .collect();
    annot.set("QuadPoints", quads);
    let color: Vec<Object> = [1, 1, 0].into_iter().map(Object::from).collect();
    annot.set("C", color);
    let annot = doc.add(annot);
    // Page 1 is object 4 in `text_pdf`.
    let page = ObjRef {
        num: 4,
        generation: 0,
    };
    doc.update_dict(page, |d| d.set("Annots", vec![Object::from(annot)]))
        .unwrap();
    let bytes = pdfcraft_cos::write_incremental(&doc, &Default::default()).unwrap();
    core_pdf::stamp_info(&bytes, core_pdf::LEITOR_BOOK_UID_KEY, book_uid).unwrap()
}

/// A bookmark of [`book_pdf`]: title, 0-based page, children.
pub struct Mark {
    pub title: &'static str,
    pub page: usize,
    pub children: Vec<Mark>,
}

pub fn mark(title: &'static str, page: usize, children: Vec<Mark>) -> Mark {
    Mark {
        title,
        page,
        children,
    }
}

/// Wraps text into lines of at most `width` chars.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.len() + 1 + word.len() > width {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// Letter pages of Helvetica text (one string per page, wrapped at 80 chars), a running header with the title and
/// a page number footer on every page, Info Title/Author and an outline. Page 1 is object 4 (like [`text_pdf`], so
/// [`annotated_version`] works on it). ASCII text only.
pub fn book_pdf(pages: &[String], title: &str, outline: &[Mark]) -> Vec<u8> {
    let n = pages.len();
    let mut objs: Vec<Vec<u8>> = vec![
        Vec::new(), // catalog, filled below
        format!(
            "<< /Type /Pages /Kids [{}] /Count {n} >>",
            (0..n)
                .map(|i| format!("{} 0 R", 4 + 2 * i))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .into_bytes(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    ];
    for (p, text) in pages.iter().enumerate() {
        objs.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
                5 + 2 * p
            )
            .into_bytes(),
        );
        let mut content = format!(
            "BT /F1 9 Tf 72 760 Td ({}) Tj ET BT /F1 11 Tf 14 TL 72 720 Td",
            escape(&title.to_uppercase())
        );
        for line in wrap(text, 80) {
            content.push_str(&format!(" ({}) Tj T*", escape(&line)));
        }
        content.push_str(&format!(" ET BT /F1 9 Tf 300 40 Td ({}) Tj ET", p + 1));
        objs.push(pdfcraft_testkit::stream_obj("", content.as_bytes()));
    }
    // Outline: the root, then the items depth-first.
    let root = objs.len() + 1;
    objs.push(Vec::new());
    fn place(
        marks: &[Mark],
        parent: usize,
        objs: &mut Vec<Vec<u8>>,
    ) -> (Option<usize>, Option<usize>, usize) {
        let ids: Vec<usize> = marks
            .iter()
            .map(|_| {
                objs.push(Vec::new());
                objs.len()
            })
            .collect();
        let mut count = 0;
        for (i, m) in marks.iter().enumerate() {
            let (first, last, below) = place(&m.children, ids[i], objs);
            count += 1 + below;
            let mut d = format!(
                "<< /Title ({}) /Parent {parent} 0 R /Dest [{} 0 R /XYZ null null null]",
                escape(m.title),
                4 + 2 * m.page
            );
            if i > 0 {
                d.push_str(&format!(" /Prev {} 0 R", ids[i - 1]));
            }
            if i + 1 < ids.len() {
                d.push_str(&format!(" /Next {} 0 R", ids[i + 1]));
            }
            if let (Some(f), Some(l)) = (first, last) {
                d.push_str(&format!(" /First {f} 0 R /Last {l} 0 R /Count {below}"));
            }
            d.push_str(" >>");
            objs[ids[i] - 1] = d.into_bytes();
        }
        (ids.first().copied(), ids.last().copied(), count)
    }
    let (first, last, count) = place(outline, root, &mut objs);
    objs[root - 1] = match (first, last) {
        (Some(f), Some(l)) => {
            format!("<< /Type /Outlines /First {f} 0 R /Last {l} 0 R /Count {count} >>")
                .into_bytes()
        }
        _ => b"<< /Type /Outlines /Count 0 >>".to_vec(),
    };
    objs[0] = format!("<< /Type /Catalog /Pages 2 0 R /Outlines {root} 0 R >>").into_bytes();
    objs.push(format!("<< /Title ({}) /Author (George Orwell) >>", escape(title)).into_bytes());
    let info = objs.len();
    Pdf::new()
        .objs(objs)
        .trailer_entry(&format!("/Info {info} 0 R"))
        .build()
}

/// Uses the data pack when built, else the test lexicon (or fails with `LEITOR_REQUIRE_VOCAB_DATA`).
pub fn use_lexicon(state: &AppState) {
    let pack = leitor_app::vocab::data::source_tree_dir();
    // `LEITOR_TEST_SAMPLE_LEXICON=1` runs the tests with the small lexicon even when the pack is built.
    let sample = std::env::var_os("LEITOR_TEST_SAMPLE_LEXICON").is_some();
    if !sample && pack.join(core_vocab::DATA_FILE).is_file() {
        if let Some(generated) = pack.parent() {
            state.set_vocab_resource_dir(generated.to_path_buf());
        }
        state.vocab_lexicon().expect("the data pack opens");
        return;
    }
    assert!(
        sample || std::env::var_os("LEITOR_REQUIRE_VOCAB_DATA").is_none(),
        "data pack missing in {}: run scripts/build-wordnet.sh",
        pack.display()
    );
    state.set_vocab_lexicon(Arc::new(core_vocab::Lexicon::from_parts(
        core_vocab::TestLexicon::sample(),
    )));
}
