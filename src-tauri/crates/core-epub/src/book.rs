use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

use crate::archive::{Archive, MAX_COVER, MAX_ENTRIES, MAX_SECTION, MAX_TOTAL_TEXT};
use crate::error::guard;
use crate::opf::{self, Package};
use crate::path::resolve;
use crate::xml::decode_document;
use crate::{CoverImage, EpubError, EpubMeta, Section, SectionText, TocItem, text, toc};

/// How much of a section is read to find its heading (fallback TOC) or its first image (cover).
const PREFIX: u64 = 256 << 10;

/// A parsed EPUB. Owns the file bytes; cheap to share (`Send + Sync`), every method takes `&self`.
#[derive(Clone)]
pub struct EpubBook {
    bytes: Arc<Vec<u8>>,
    archive: Archive,
    package: Package,
    sections: Vec<Section>,
    /// Section index → spine itemref position (they differ only when an itemref has no manifest item).
    spine_pos: Vec<u32>,
    by_href: HashMap<String, u32>,
    toc: Vec<TocItem>,
    toc_fallback: bool,
    labels: Vec<Option<String>>,
}

impl std::fmt::Debug for EpubBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EpubBook")
            .field("meta", &self.package.meta)
            .field("sections", &self.sections.len())
            .field("toc_items", &self.toc.len())
            .field("toc_fallback", &self.toc_fallback)
            .finish()
    }
}

/// Opens an EPUB from its bytes. Never panics; see `EpubError` for the failures.
pub fn open(bytes: Arc<Vec<u8>>) -> Result<EpubBook, EpubError> {
    guard(|| EpubBook::parse(bytes))
}

fn is_text_doc(section: &Section) -> bool {
    match section.media_type.as_str() {
        "application/xhtml+xml" | "text/html" | "application/xml" | "text/xml" | "text/plain" => {
            true
        }
        "" => {
            let h = section.href.to_ascii_lowercase();
            [".xhtml", ".html", ".htm", ".xml"]
                .iter()
                .any(|e| h.ends_with(e))
        }
        _ => false,
    }
}

/// Image type from the magic bytes (SVG and anything else: `None`).
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// SHA-256 over the section count and each section's text: what `EpubBook::text_fingerprint`
/// computes, for callers that already hold the texts.
pub fn fingerprint_of(texts: &[SectionText]) -> String {
    let mut h = Sha256::new();
    h.update(format!("core-epub/1\nsections:{}\n", texts.len()));
    for t in texts {
        h.update(format!("{}\t{}\n", t.section, t.text.len()));
        h.update(t.text.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

impl EpubBook {
    fn parse(bytes: Arc<Vec<u8>>) -> Result<Self, EpubError> {
        let archive = Archive::open(bytes.clone())?;
        let opf_path = opf::package_path(&archive)?;
        let package = opf::parse_package(&archive, &opf_path)?;
        opf::check_drm(&archive, &package)?;

        let mut sections = Vec::new();
        let mut spine_pos = Vec::new();
        for (pos, itemref) in package.spine.iter().enumerate() {
            // foliate-js drops itemrefs without a manifest item from `book.sections` too.
            let Some(item) = package.item(&itemref.idref) else {
                tracing::warn!(idref = %itemref.idref, "spine itemref without manifest item");
                continue;
            };
            if sections.len() >= MAX_ENTRIES {
                return Err(EpubError::TooLarge);
            }
            sections.push(Section {
                index: sections.len() as u32,
                id: item.id.clone(),
                href: item.href.clone(),
                media_type: item.media_type.clone(),
                linear: itemref.linear,
            });
            spine_pos.push(pos as u32);
        }
        if sections.is_empty() {
            return Err(EpubError::NoContent);
        }
        let mut by_href = HashMap::new();
        for s in &sections {
            by_href.entry(s.href.clone()).or_insert(s.index);
        }

        let mut toc = Vec::new();
        if let Some(nav) = package.nav_item() {
            match opf::read_xml(&archive, &nav.href) {
                Ok(tree) => toc = toc::tidy(toc::from_nav(&tree, &nav.href, &by_href)),
                Err(e) => tracing::warn!(error = ?e, "unreadable nav document"),
            }
        }
        if toc.is_empty()
            && let Some(ncx) = package.ncx_item()
        {
            match opf::read_xml(&archive, &ncx.href) {
                Ok(tree) => toc = toc::tidy(toc::from_ncx(&tree, &ncx.href, &by_href)),
                Err(e) => tracing::warn!(error = ?e, "unreadable NCX"),
            }
        }
        let toc_fallback = toc.is_empty();
        if toc_fallback {
            toc = toc::fallback(&sections, &mut |s| {
                if !is_text_doc(s) {
                    return None;
                }
                let prefix = archive.read_prefix(&s.href, PREFIX).ok()?;
                text::heading(&decode_document(&prefix))
            });
        }
        let labels = toc::section_labels(&toc, sections.len());

        Ok(Self {
            bytes,
            archive,
            package,
            sections,
            spine_pos,
            by_href,
            toc,
            toc_fallback,
            labels,
        })
    }

    pub fn meta(&self) -> &EpubMeta {
        &self.package.meta
    }

    /// Spine sections in reading order (linear and non-linear); `sections()[i].index == i`.
    pub fn sections(&self) -> &[Section] {
        &self.sections
    }

    pub fn toc(&self) -> &[TocItem] {
        &self.toc
    }

    /// True when the book has no usable nav/NCX and `toc()` is one item per linear section.
    pub fn toc_is_fallback(&self) -> bool {
        self.toc_fallback
    }

    /// The file bytes the book was opened from.
    pub fn file_bytes(&self) -> &Arc<Vec<u8>> {
        &self.bytes
    }

    /// Title of the deepest TOC item whose range covers `section`.
    pub fn section_label(&self, section: u32) -> Option<String> {
        self.labels.get(section as usize).cloned().flatten()
    }

    /// The section of a zip path (as in `Section::href`/`TocItem::href`; a `#fragment` is ignored,
    /// percent-encoding is decoded).
    pub fn section_of_href(&self, href: &str) -> Option<u32> {
        resolve("", href).and_then(|h| self.by_href.get(&h.path).copied())
    }

    /// The section addressed by a CFI in this book: the spine step of `section_of_cfi`, mapped
    /// through the itemrefs that have a manifest item. `None` if malformed or out of range.
    pub fn section_for_cfi(&self, cfi: &str) -> Option<u32> {
        let pos = crate::section_of_cfi(cfi)?;
        self.spine_pos
            .iter()
            .position(|&p| p == pos)
            .map(|i| i as u32)
    }

    /// The spine itemref position (CFI step N = 2 × (position + 1)) of a section.
    pub fn spine_position(&self, section: u32) -> Option<u32> {
        self.spine_pos.get(section as usize).copied()
    }

    /// Cover image: EPUB 3 `properties="cover-image"`, EPUB 2 `<meta name="cover">`, a manifest
    /// image whose id/href mentions "cover", the first image of the first section. Only PNG,
    /// JPEG, GIF and WebP up to 10 MiB; SVG covers are ignored.
    pub fn cover(&self) -> Option<CoverImage> {
        guard(|| Ok(self.find_cover())).ok().flatten()
    }

    fn find_cover(&self) -> Option<CoverImage> {
        let p = &self.package;
        let mut candidates: Vec<String> = Vec::new();
        let is_image = |m: &str| m.starts_with("image/") && m != "image/svg+xml";
        if let Some(item) = p
            .manifest
            .iter()
            .find(|m| m.properties.iter().any(|x| x == "cover-image"))
        {
            candidates.push(item.href.clone());
        }
        if let Some(meta) = &p.cover_meta {
            let item = p
                .item(meta)
                .or_else(|| resolve(&p.opf_path, meta).and_then(|h| p.item_by_href(&h.path)));
            if let Some(item) = item {
                candidates.push(item.href.clone());
            }
        }
        if let Some(item) = p.manifest.iter().find(|m| {
            is_image(&m.media_type)
                && (m.id.to_lowercase().contains("cover")
                    || m.href.to_lowercase().contains("cover"))
        }) {
            candidates.push(item.href.clone());
        }
        for path in candidates {
            if p.item_by_href(&path)
                .is_some_and(|m| m.media_type == "image/svg+xml")
            {
                continue;
            }
            if let Some(cover) = self.read_image(&path) {
                return Some(cover);
            }
        }
        // Last resort: the first image of the first section.
        let first = self.sections.first().filter(|s| is_text_doc(s))?;
        let prefix = self.archive.read_prefix(&first.href, PREFIX).ok()?;
        let src = text::first_image(&decode_document(&prefix))?;
        let target = resolve(&first.href, &src)?;
        self.read_image(&target.path)
    }

    fn read_image(&self, path: &str) -> Option<CoverImage> {
        let bytes = self.archive.read(path, MAX_COVER).ok()?;
        let media_type = sniff_image(&bytes)?;
        Some(CoverImage {
            media_type: media_type.to_owned(),
            bytes,
        })
    }

    /// Text of one section (`Ok` with empty text for non-text sections and unreadable entries).
    pub fn section_text(&self, section: u32) -> Result<SectionText, EpubError> {
        guard(|| {
            let s = self
                .sections
                .get(section as usize)
                .ok_or_else(|| EpubError::damaged(format!("section {section} out of range")))?;
            let (text, _, _) = self.read_text(s)?;
            Ok(SectionText {
                section,
                label: self.section_label(section),
                text,
            })
        })
    }

    /// `(text, decompressed bytes, read failed)`.
    fn read_text(&self, s: &Section) -> Result<(String, u64, bool), EpubError> {
        if !is_text_doc(s) {
            return Ok((String::new(), 0, false));
        }
        let bytes = match self.archive.read(&s.href, MAX_SECTION) {
            Ok(b) => b,
            Err(e @ (EpubError::TooLarge | EpubError::Drm)) => return Err(e),
            Err(e) => {
                tracing::warn!(section = s.index, error = ?e, "unreadable section");
                return Ok((String::new(), 0, true));
            }
        };
        let doc = decode_document(&bytes);
        let text = if s.media_type == "text/plain" {
            doc.lines()
                .map(crate::xml::collapse_ws)
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            text::extract(&doc)
        };
        Ok((text, bytes.len() as u64, false))
    }

    /// Text of every section in order. Checks `cancel` before each section and reports
    /// `progress(done, total)` after each. At most 512 MiB are decompressed (`TooLarge`).
    pub fn texts(
        &self,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u32, u32),
    ) -> Result<Vec<SectionText>, EpubError> {
        guard(|| {
            let total = self.sections.len() as u32;
            let mut out = Vec::with_capacity(self.sections.len());
            let mut decompressed = 0u64;
            let mut failed = 0usize;
            for s in &self.sections {
                if cancel.load(Ordering::Relaxed) {
                    return Err(EpubError::Cancelled);
                }
                let (text, len, broken) = self.read_text(s)?;
                decompressed += len;
                if decompressed > MAX_TOTAL_TEXT {
                    return Err(EpubError::TooLarge);
                }
                failed += usize::from(broken);
                out.push(SectionText {
                    section: s.index,
                    label: self.section_label(s.index),
                    text,
                });
                progress(s.index + 1, total);
            }
            if failed > 0 && failed == self.sections.len() {
                return Err(EpubError::damaged("no readable section"));
            }
            Ok(out)
        })
    }

    /// SHA-256 (hex) of the section count plus each section's extracted text: changes when the
    /// text changes, stable otherwise. If the text can't be read, a hash of the file bytes.
    pub fn text_fingerprint(&self) -> String {
        let never = AtomicBool::new(false);
        match self.texts(&never, &mut |_, _| {}) {
            Ok(texts) => fingerprint_of(&texts),
            Err(_) => {
                let mut h = Sha256::new();
                h.update(b"core-epub/raw\n");
                h.update(self.bytes.as_slice());
                hex::encode(h.finalize())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_is_send_and_sync() {
        fn check<T: Send + Sync>() {}
        check::<EpubBook>();
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<svg/>"), None);
    }
}
