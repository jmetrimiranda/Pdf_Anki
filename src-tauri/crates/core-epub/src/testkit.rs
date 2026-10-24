//! Synthetic EPUBs for tests (feature `testkit`). Everything is generated in code; no binary
//! fixture is committed. Used by this crate's tests and, as a dev-dependency, by the app's.
//!
//! ```ignore
//! let bytes = EpubBuilder::new(EpubVersion::V3)
//!     .title("Livro")
//!     .chapter(ChapterSpec::new("Part I", "<p>Intro</p>").child(ChapterSpec::new("Ch 1", "<p>One</p>")))
//!     .build();
//! ```

use std::io::{Cursor, Write};

use zip::CompressionMethod;
use zip::write::{SimpleFileOptions, ZipWriter};

pub use crate::EpubVersion;

/// One chapter: its own XHTML file (or, with `fragment`, a `<section id>` inside the file of its
/// nearest ancestor that has one) and a TOC entry, children nested below it.
#[derive(Debug, Clone, Default)]
pub struct ChapterSpec {
    pub title: String,
    /// Body content (XHTML), inserted after an `<h1>` (`<h2>` for fragments) with the title.
    pub body_xhtml: String,
    pub children: Vec<ChapterSpec>,
    /// Lives at `#fragment` inside the parent's file instead of a file of its own.
    pub fragment: Option<String>,
}

impl ChapterSpec {
    pub fn new(title: impl Into<String>, body_xhtml: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            body_xhtml: body_xhtml.into(),
            ..Self::default()
        }
    }

    pub fn child(mut self, child: ChapterSpec) -> Self {
        self.children.push(child);
        self
    }

    /// Makes this chapter a `#id` fragment inside its parent's file.
    pub fn in_parent(mut self, id: impl Into<String>) -> Self {
        self.fragment = Some(id.into());
        self
    }
}

/// An extra zip entry, optionally listed in the manifest.
#[derive(Debug, Clone)]
pub struct ExtraFile {
    /// Path inside the zip.
    pub path: String,
    pub bytes: Vec<u8>,
    /// `Some((id, media type))` adds a manifest item.
    pub manifest: Option<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct EpubBuilder {
    version: EpubVersion,
    title: String,
    authors: Vec<String>,
    language: String,
    identifier: String,
    chapters: Vec<ChapterSpec>,
    nav: bool,
    ncx: bool,
    cover_png: Option<Vec<u8>>,
    image: bool,
    non_linear: Vec<usize>,
    extra_files: Vec<ExtraFile>,
    container: bool,
}

/// Escapes text for XML content and attribute values.
pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Directory of the package inside the zip.
const ROOT: &str = "OEBPS";

struct FileOut {
    name: String,
    title: String,
    body: String,
}

struct Flat {
    /// (title, href relative to ROOT, children)
    toc: Vec<TocOut>,
    files: Vec<FileOut>,
}

struct TocOut {
    title: String,
    href: String,
    children: Vec<TocOut>,
}

impl EpubBuilder {
    /// An empty book; EPUB 3 gets a nav document, EPUB 2 an NCX (see `with_nav`/`with_ncx`).
    pub fn new(version: EpubVersion) -> Self {
        Self {
            version,
            title: "Livro de teste".into(),
            authors: vec!["Autora Teste".into()],
            language: "en".into(),
            identifier: "urn:uuid:00000000-0000-4000-8000-000000000001".into(),
            chapters: Vec::new(),
            nav: version == EpubVersion::V3,
            ncx: version == EpubVersion::V2,
            cover_png: None,
            image: false,
            non_linear: Vec::new(),
            extra_files: Vec::new(),
            container: true,
        }
    }

    /// A small book with a 3-level TOC (Part I > Chapter 1 > Section 1.1 in its own file, a
    /// fragment child, Part II > Chapter 2), an image and a PNG cover.
    pub fn sample(version: EpubVersion) -> Self {
        Self::new(version)
            .title("Amostra")
            .chapter(
                ChapterSpec::new("Part I", "<p>The first part begins here.</p>").child(
                    ChapterSpec::new("Chapter 1", "<p>The cat sat on the mat.</p>")
                        .child(ChapterSpec::new(
                            "Section 1.1",
                            "<p>Deeper inside the first chapter.</p>",
                        ))
                        .child(
                            ChapterSpec::new("Section 1.2", "<p>A fragment of the same file.</p>")
                                .in_parent("s1-2"),
                        ),
                ),
            )
            .chapter(
                ChapterSpec::new("Part II", "<p>The second part.</p>").child(ChapterSpec::new(
                    "Chapter 2",
                    "<p>Dogs bark at the moon.</p>",
                )),
            )
            .with_image(true)
            .cover_png(Some(tiny_png(8, 12, [200, 40, 40])))
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    /// Replaces the authors with one.
    pub fn author(mut self, author: impl Into<String>) -> Self {
        self.authors = vec![author.into()];
        self
    }

    pub fn authors(mut self, authors: &[&str]) -> Self {
        self.authors = authors.iter().map(|a| (*a).to_owned()).collect();
        self
    }

    pub fn language(mut self, language: impl Into<String>) -> Self {
        self.language = language.into();
        self
    }

    pub fn identifier(mut self, identifier: impl Into<String>) -> Self {
        self.identifier = identifier.into();
        self
    }

    pub fn chapter(mut self, chapter: ChapterSpec) -> Self {
        self.chapters.push(chapter);
        self
    }

    pub fn chapters(mut self, chapters: Vec<ChapterSpec>) -> Self {
        self.chapters.extend(chapters);
        self
    }

    pub fn with_nav(mut self, nav: bool) -> Self {
        self.nav = nav;
        self
    }

    pub fn with_ncx(mut self, ncx: bool) -> Self {
        self.ncx = ncx;
        self
    }

    /// Cover image (manifest `cover-image` property on EPUB 3 plus `<meta name="cover">`).
    pub fn cover_png(mut self, png: Option<Vec<u8>>) -> Self {
        self.cover_png = png;
        self
    }

    /// Embeds a small PNG (`images/figure.png`) in the first chapter file.
    pub fn with_image(mut self, image: bool) -> Self {
        self.image = image;
        self
    }

    /// Marks the spine item of chapter file `index` (0-based, in file order) `linear="no"`.
    pub fn non_linear(mut self, index: usize) -> Self {
        self.non_linear.push(index);
        self
    }

    pub fn extra_file(mut self, file: ExtraFile) -> Self {
        self.extra_files.push(file);
        self
    }

    /// Leaves `META-INF/container.xml` out (the OPF is still in the zip).
    pub fn with_container(mut self, container: bool) -> Self {
        self.container = container;
        self
    }

    fn flatten(&self) -> Flat {
        let mut files: Vec<FileOut> = Vec::new();
        fn walk(
            chapters: &[ChapterSpec],
            files: &mut Vec<FileOut>,
            current: Option<usize>,
        ) -> Vec<TocOut> {
            let mut out = Vec::new();
            for ch in chapters {
                let (file, href) = match (&ch.fragment, current) {
                    (Some(id), Some(parent)) => {
                        let f = &mut files[parent];
                        f.body.push_str(&format!(
                            "<section id=\"{}\"><h2>{}</h2>{}</section>",
                            escape(id),
                            escape(&ch.title),
                            ch.body_xhtml
                        ));
                        (parent, format!("{}#{}", f.name, id))
                    }
                    _ => {
                        let name = format!("text/ch{:02}.xhtml", files.len() + 1);
                        files.push(FileOut {
                            name: name.clone(),
                            title: ch.title.clone(),
                            body: format!("<h1>{}</h1>{}", escape(&ch.title), ch.body_xhtml),
                        });
                        (files.len() - 1, name)
                    }
                };
                let children = walk(&ch.children, files, Some(file));
                out.push(TocOut {
                    title: ch.title.clone(),
                    href,
                    children,
                });
            }
            out
        }
        let toc = walk(&self.chapters, &mut files, None);
        Flat { toc, files }
    }

    /// The EPUB bytes: `mimetype` first and stored, then the container, package and content.
    pub fn build(&self) -> Vec<u8> {
        zip_entries(&self.entries())
    }

    /// The entries `build` zips (without `mimetype`), for tests that tweak a file.
    pub fn entries(&self) -> Vec<(String, Vec<u8>)> {
        let mut flat = self.flatten();
        if self.image
            && let Some(first) = flat.files.first_mut()
        {
            first
                .body
                .push_str("<p><img src=\"../images/figure.png\" alt=\"Figura\"/></p>");
        }
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        if self.container {
            entries.push((
                "META-INF/container.xml".into(),
                container_xml(&format!("{ROOT}/content.opf")).into_bytes(),
            ));
        }
        let mut manifest = String::new();
        let mut spine = String::new();
        for (i, f) in flat.files.iter().enumerate() {
            let id = format!("ch{:02}", i + 1);
            manifest.push_str(&format!(
                "<item id=\"{id}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
                f.name
            ));
            let linear = if self.non_linear.contains(&i) {
                " linear=\"no\""
            } else {
                ""
            };
            spine.push_str(&format!("<itemref idref=\"{id}\"{linear}/>"));
            entries.push((
                format!("{ROOT}/{}", f.name),
                xhtml_doc(&f.title, &f.body).into_bytes(),
            ));
        }
        if self.image {
            manifest.push_str(
                "<item id=\"figure\" href=\"images/figure.png\" media-type=\"image/png\"/>",
            );
            entries.push((
                format!("{ROOT}/images/figure.png"),
                tiny_png(4, 4, [30, 120, 200]),
            ));
        }
        let mut meta_cover = String::new();
        if let Some(png) = &self.cover_png {
            let props = if self.version == EpubVersion::V3 {
                " properties=\"cover-image\""
            } else {
                ""
            };
            manifest.push_str(&format!("<item id=\"cover-image\" href=\"images/cover.png\" media-type=\"image/png\"{props}/>"));
            meta_cover = "<meta name=\"cover\" content=\"cover-image\"/>".into();
            entries.push((format!("{ROOT}/images/cover.png"), png.clone()));
        }
        if self.nav {
            manifest.push_str("<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>");
            entries.push((
                format!("{ROOT}/nav.xhtml"),
                nav_xhtml(&flat.toc).into_bytes(),
            ));
        }
        let mut spine_toc = String::new();
        if self.ncx {
            manifest.push_str(
                "<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>",
            );
            spine_toc = " toc=\"ncx\"".into();
            entries.push((
                format!("{ROOT}/toc.ncx"),
                ncx_xml(&self.identifier, &self.title, &flat.toc).into_bytes(),
            ));
        }
        for extra in &self.extra_files {
            if let Some((id, media_type)) = &extra.manifest {
                let href = extra
                    .path
                    .strip_prefix(&format!("{ROOT}/"))
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("../{}", extra.path));
                manifest.push_str(&format!(
                    "<item id=\"{id}\" href=\"{href}\" media-type=\"{media_type}\"/>"
                ));
            }
            entries.push((extra.path.clone(), extra.bytes.clone()));
        }
        let version = if self.version == EpubVersion::V3 {
            "3.0"
        } else {
            "2.0"
        };
        let creators: String = self
            .authors
            .iter()
            .map(|a| format!("<dc:creator>{}</dc:creator>", escape(a)))
            .collect();
        let modified = if self.version == EpubVersion::V3 {
            "<meta property=\"dcterms:modified\">2026-01-01T00:00:00Z</meta>"
        } else {
            ""
        };
        let opf = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <package xmlns=\"http://www.idpf.org/2007/opf\" version=\"{version}\" unique-identifier=\"bookid\">\
             <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\
             <dc:identifier id=\"bookid\">{}</dc:identifier><dc:title>{}</dc:title>{creators}\
             <dc:language>{}</dc:language>{modified}{meta_cover}</metadata>\
             <manifest>{manifest}</manifest><spine{spine_toc}>{spine}</spine></package>",
            escape(&self.identifier),
            escape(&self.title),
            escape(&self.language),
        );
        entries.insert(
            usize::from(self.container),
            (format!("{ROOT}/content.opf"), opf.into_bytes()),
        );
        entries
    }
}

pub fn container_xml(opf_path: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\
         <rootfiles><rootfile full-path=\"{}\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>",
        escape(opf_path)
    )
}

/// A complete XHTML document around `body`.
pub fn xhtml_doc(title: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE html>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\">\
         <head><title>{}</title></head><body>{body}</body></html>",
        escape(title)
    )
}

fn nav_xhtml(toc: &[TocOut]) -> String {
    fn list(items: &[TocOut]) -> String {
        let mut s = String::from("<ol>");
        for i in items {
            s.push_str(&format!(
                "<li><a href=\"{}\">{}</a>",
                escape(&i.href),
                escape(&i.title)
            ));
            if !i.children.is_empty() {
                s.push_str(&list(&i.children));
            }
            s.push_str("</li>");
        }
        s.push_str("</ol>");
        s
    }
    xhtml_doc(
        "Sumário",
        &format!(
            "<nav epub:type=\"toc\" id=\"toc\"><h1>Sumário</h1>{}</nav>",
            list(toc)
        ),
    )
}

fn ncx_xml(uid: &str, title: &str, toc: &[TocOut]) -> String {
    fn points(items: &[TocOut], order: &mut usize) -> String {
        let mut s = String::new();
        for i in items {
            *order += 1;
            s.push_str(&format!(
                "<navPoint id=\"np{0}\" playOrder=\"{0}\"><navLabel><text>{1}</text></navLabel><content src=\"{2}\"/>",
                *order,
                escape(&i.title),
                escape(&i.href)
            ));
            s.push_str(&points(&i.children, order));
            s.push_str("</navPoint>");
        }
        s
    }
    let mut order = 0;
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\">\
         <head><meta name=\"dtb:uid\" content=\"{}\"/></head><docTitle><text>{}</text></docTitle>\
         <navMap>{}</navMap></ncx>",
        escape(uid),
        escape(title),
        points(toc, &mut order)
    )
}

/// Zips `entries` after a stored `mimetype` entry (`application/epub+zip`), deflating the rest.
/// An entry named `mimetype` in `entries` replaces the default one.
pub fn zip_entries(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mimetype = entries
        .iter()
        .find(|(n, _)| n == "mimetype")
        .map(|(_, b)| b.clone())
        .unwrap_or_else(|| b"application/epub+zip".to_vec());
    let mut all = vec![("mimetype".to_owned(), mimetype)];
    all.extend(entries.iter().filter(|(n, _)| n != "mimetype").cloned());
    zip_raw(&all)
}

/// Zips `entries` exactly as given (`mimetype` stored, everything else deflated).
pub fn zip_raw(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        let method = if name == "mimetype" {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        let options = SimpleFileOptions::default().compression_method(method);
        w.start_file(name.as_str(), options).expect("zip entry");
        w.write_all(bytes).expect("zip write");
    }
    w.finish().expect("zip finish").into_inner()
}

/// A `w`×`h` PNG of one colour.
pub fn tiny_png(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().expect("png header");
        let data: Vec<u8> = (0..w * h).flat_map(|_| rgb).collect();
        writer.write_image_data(&data).expect("png data");
        writer.finish().expect("png finish");
    }
    out
}

/// Deterministic pseudo-random bytes (xorshift64*).
pub fn garbage(seed: u64, len: usize) -> Vec<u8> {
    let mut rng = Rng::new(seed);
    (0..len).map(|_| rng.next_u64() as u8).collect()
}

/// The first `at` bytes.
pub fn truncated(bytes: &[u8], at: usize) -> Vec<u8> {
    bytes[..at.min(bytes.len())].to_vec()
}

/// A small deterministic PRNG for mutation tests.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }
}

fn simple_book() -> EpubBuilder {
    EpubBuilder::new(EpubVersion::V3)
        .chapter(ChapterSpec::new("One", "<p>First chapter text.</p>"))
        .chapter(ChapterSpec::new("Two", "<p>Second chapter text.</p>"))
}

/// An EPUB whose only chapter inflates to 64 MiB (≈1000:1): `TooLarge`, at open (ratio) or when
/// the text is read (section limit).
pub fn zip_bomb() -> Vec<u8> {
    let mut chapter = b"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>".to_vec();
    chapter.resize(chapter.len() + (64 << 20), b'a');
    chapter.extend_from_slice(b"</p></body></html>");
    let mut entries: Vec<(String, Vec<u8>)> = simple_book()
        .entries()
        .into_iter()
        .filter(|(n, _)| n != "OEBPS/text/ch01.xhtml")
        .collect();
    entries.push(("OEBPS/text/ch01.xhtml".into(), chapter));
    zip_entries(&entries)
}

/// Adobe-ADEPT-style DRM: `META-INF/encryption.xml` encrypting a content document with AES and
/// a `META-INF/rights.xml`.
pub fn drm_epub() -> Vec<u8> {
    let mut entries = simple_book().entries();
    entries.push((
        "META-INF/encryption.xml".into(),
        encryption_xml(
            "http://www.w3.org/2001/04/xmlenc#aes128-cbc",
            "OEBPS/text/ch01.xhtml",
        )
        .into_bytes(),
    ));
    entries.push((
        "META-INF/rights.xml".into(),
        b"<?xml version=\"1.0\"?><adept:rights xmlns:adept=\"http://ns.adobe.com/adept\"/>"
            .to_vec(),
    ));
    zip_entries(&entries)
}

/// `META-INF/encryption.xml` with one `EncryptedData` entry.
pub fn encryption_xml(algorithm: &str, uri: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><encryption xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\" \
         xmlns:enc=\"http://www.w3.org/2001/04/xmlenc#\"><enc:EncryptedData>\
         <enc:EncryptionMethod Algorithm=\"{}\"/><enc:CipherData><enc:CipherReference URI=\"{}\"/>\
         </enc:CipherData></enc:EncryptedData></encryption>",
        escape(algorithm),
        escape(uri)
    )
}

/// A book whose zip entries carry the "encrypted" flag (traditional zip encryption): `Drm`.
pub fn encrypted_entries_epub() -> Vec<u8> {
    let mut bytes = simple_book().build();
    let mut i = 0;
    while i + 10 < bytes.len() {
        match &bytes[i..i + 4] {
            b"PK\x03\x04" => bytes[i + 6] |= 1,
            b"PK\x01\x02" => bytes[i + 8] |= 1,
            _ => {}
        }
        i += 1;
    }
    bytes
}

/// A valid EPUB without `META-INF/container.xml` (opens through the first `*.opf`).
pub fn without_container() -> Vec<u8> {
    simple_book().with_container(false).build()
}

/// A valid EPUB with neither nav nor NCX (fallback TOC from the headings).
pub fn without_toc() -> Vec<u8> {
    simple_book().with_nav(false).with_ncx(false).build()
}

/// Active content the reader must neutralise: `<script>`, `<body onload>`, inline handlers,
/// `javascript:` links, an `<iframe>`, an `<object>` and SVG scripts; each would set
/// `window.parent.__epubScriptRan`. The text extraction keeps only "Safe text stays." and "link".
pub fn script_epub() -> Vec<u8> {
    const RAN: &str = "window.parent.__epubScriptRan = true";
    let body = format!(
        "<h1>Scripted</h1><script>{RAN};</script>\
         <p onclick=\"{RAN}\">Safe text stays.</p>\
         <img src=\"missing.png\" onerror=\"{RAN}\" alt=\"x\"/>\
         <p><a href=\"javascript:{RAN}\">link</a></p>\
         <iframe src=\"javascript:{RAN}\"></iframe>\
         <object data=\"data:text/html,&lt;script&gt;{RAN}&lt;/script&gt;\"></object>\
         <svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"{RAN}\"><script>{RAN};</script></svg>"
    );
    let doc = xhtml_doc("Scripted", &body).replace("<body>", &format!("<body onload=\"{RAN}\">"));
    let mut entries = EpubBuilder::new(EpubVersion::V3)
        .title("Scripts")
        .chapter(ChapterSpec::new("Scripted", ""))
        .entries();
    for (name, bytes) in &mut entries {
        if name == "OEBPS/text/ch01.xhtml" {
            *bytes = doc.clone().into_bytes();
        }
    }
    zip_entries(&entries)
}
