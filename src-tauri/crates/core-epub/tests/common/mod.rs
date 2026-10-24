#![allow(dead_code)]

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use core_epub::testkit::{container_xml, xhtml_doc, zip_entries};
use core_epub::{EpubBook, EpubError, SectionText};

pub fn open(bytes: Vec<u8>) -> Result<EpubBook, EpubError> {
    core_epub::open(Arc::new(bytes))
}

pub fn texts(book: &EpubBook) -> Vec<SectionText> {
    book.texts(&AtomicBool::new(false), &mut |_, _| {})
        .expect("texts")
}

/// A hand-written EPUB: `OEBPS/content.opf` with `manifest`/`spine`/`metadata` fragments and
/// the given files (paths inside the zip).
pub struct Custom {
    pub version: &'static str,
    pub metadata: String,
    pub manifest: String,
    pub spine: String,
    pub spine_attrs: String,
    pub files: Vec<(String, Vec<u8>)>,
}

impl Custom {
    /// One chapter `OEBPS/text/ch1.xhtml` with `body`.
    pub fn one_chapter(body: &str) -> Self {
        Self {
            version: "3.0",
            metadata: "<dc:title>Custom</dc:title><dc:language>en</dc:language>".into(),
            manifest:
                "<item id=\"ch1\" href=\"text/ch1.xhtml\" media-type=\"application/xhtml+xml\"/>"
                    .into(),
            spine: "<itemref idref=\"ch1\"/>".into(),
            spine_attrs: String::new(),
            files: vec![(
                "OEBPS/text/ch1.xhtml".into(),
                xhtml_doc("Chapter", body).into_bytes(),
            )],
        }
    }

    pub fn file(mut self, path: &str, bytes: impl Into<Vec<u8>>) -> Self {
        self.files.push((path.into(), bytes.into()));
        self
    }

    pub fn manifest(mut self, items: &str) -> Self {
        self.manifest.push_str(items);
        self
    }

    pub fn opf(&self) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><package xmlns=\"http://www.idpf.org/2007/opf\" \
             version=\"{}\" unique-identifier=\"id\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">{}</metadata>\
             <manifest>{}</manifest><spine{}>{}</spine></package>",
            self.version, self.metadata, self.manifest, self.spine_attrs, self.spine
        )
    }

    pub fn build(&self) -> Vec<u8> {
        let mut entries = vec![
            (
                "META-INF/container.xml".to_owned(),
                container_xml("OEBPS/content.opf").into_bytes(),
            ),
            ("OEBPS/content.opf".to_owned(), self.opf().into_bytes()),
        ];
        entries.extend(self.files.iter().cloned());
        zip_entries(&entries)
    }
}
