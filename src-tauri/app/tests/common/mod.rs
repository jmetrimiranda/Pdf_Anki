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
