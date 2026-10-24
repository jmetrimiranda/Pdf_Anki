//! META-INF/container.xml, the OPF package document and the DRM checks (encryption.xml, rights.xml).

use std::collections::HashMap;

use crate::archive::{Archive, MAX_PACKAGE_FILE};
use crate::path::resolve;
use crate::xml::{Element, decode_document, parse_tree};
use crate::{EpubError, EpubMeta, EpubVersion};

/// Font obfuscation algorithms (IDPF and Adobe): not DRM, the fonts are only scrambled.
const OBFUSCATION: [&str; 2] = [
    "http://www.idpf.org/2008/embedding",
    "http://ns.adobe.com/pdf/enc#RC",
];

#[derive(Debug, Clone)]
pub(crate) struct ManifestItem {
    pub id: String,
    /// Zip path (resolved against the OPF, percent-decoded).
    pub href: String,
    pub media_type: String,
    pub properties: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SpineRef {
    pub idref: String,
    pub linear: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct Package {
    pub opf_path: String,
    pub meta: EpubMeta,
    pub manifest: Vec<ManifestItem>,
    pub by_id: HashMap<String, usize>,
    pub spine: Vec<SpineRef>,
    /// `spine@toc` (EPUB 2 NCX id).
    pub toc_id: Option<String>,
    /// `<meta name="cover" content="…">` (EPUB 2).
    pub cover_meta: Option<String>,
}

impl Package {
    pub fn item(&self, id: &str) -> Option<&ManifestItem> {
        self.by_id.get(id).map(|&i| &self.manifest[i])
    }

    pub fn item_by_href(&self, href: &str) -> Option<&ManifestItem> {
        self.manifest.iter().find(|m| m.href == href)
    }

    pub fn nav_item(&self) -> Option<&ManifestItem> {
        self.manifest
            .iter()
            .find(|m| m.properties.iter().any(|p| p == "nav"))
    }

    pub fn ncx_item(&self) -> Option<&ManifestItem> {
        self.toc_id
            .as_deref()
            .and_then(|id| self.item(id))
            .or_else(|| {
                self.manifest
                    .iter()
                    .find(|m| m.media_type == "application/x-dtbncx+xml")
            })
    }
}

pub(crate) fn read_xml(archive: &Archive, path: &str) -> Result<Element, EpubError> {
    let bytes = archive.read(path, MAX_PACKAGE_FILE)?;
    parse_tree(&decode_document(&bytes)).map_err(|e| EpubError::damaged(format!("{path}: {e}")))
}

/// The package document path: the first `rootfile` with a `full-path` (an OPF media type
/// preferred), else the first `*.opf` in the zip.
pub(crate) fn package_path(archive: &Archive) -> Result<String, EpubError> {
    if archive.contains("META-INF/container.xml") {
        match read_xml(archive, "META-INF/container.xml") {
            Ok(tree) => {
                let mut roots = Vec::new();
                tree.all_named("rootfile", &mut roots);
                let paths: Vec<(&str, bool)> = roots
                    .iter()
                    .filter_map(|r| {
                        let p = r.attr("full-path")?.trim();
                        let is_opf = r
                            .attr("media-type")
                            .is_none_or(|m| m.trim() == "application/oebps-package+xml");
                        (!p.is_empty()).then_some((p, is_opf))
                    })
                    .collect();
                if let Some((p, _)) = paths.iter().find(|(_, opf)| *opf).or(paths.first()) {
                    return Ok(resolve("", p)
                        .map(|h| h.path)
                        .unwrap_or_else(|| (*p).to_owned()));
                }
            }
            Err(EpubError::TooLarge) => return Err(EpubError::TooLarge),
            Err(e) => tracing::warn!(error = ?e, "unreadable container.xml"),
        }
    }
    archive
        .names()
        .find(|n| n.to_ascii_lowercase().ends_with(".opf"))
        .map(str::to_owned)
        .ok_or(EpubError::NotEpub)
}

pub(crate) fn parse_package(archive: &Archive, opf_path: &str) -> Result<Package, EpubError> {
    if !archive.contains(opf_path) {
        return Err(EpubError::damaged(format!(
            "package document {opf_path} missing"
        )));
    }
    let tree = read_xml(archive, opf_path)?;
    let package = tree
        .child("package")
        .ok_or_else(|| EpubError::damaged("OPF without <package>"))?;
    let manifest_el = package
        .child("manifest")
        .ok_or_else(|| EpubError::damaged("OPF without <manifest>"))?;
    let spine_el = package
        .child("spine")
        .ok_or_else(|| EpubError::damaged("OPF without <spine>"))?;

    let version = match package.attr("version").map(str::trim) {
        Some(v) if v.starts_with('3') => EpubVersion::V3,
        _ => EpubVersion::V2,
    };

    let mut manifest = Vec::new();
    let mut by_id = HashMap::new();
    for item in manifest_el.children_named("item") {
        let (Some(id), Some(href)) = (item.attr("id"), item.attr("href")) else {
            continue;
        };
        let Some(resolved) = resolve(opf_path, href) else {
            continue;
        };
        let id = id.trim().to_owned();
        by_id.entry(id.clone()).or_insert(manifest.len());
        manifest.push(ManifestItem {
            id,
            href: resolved.path,
            media_type: item
                .attr("media-type")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase(),
            properties: item
                .attr("properties")
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_owned)
                .collect(),
        });
    }

    let spine = spine_el
        .children_named("itemref")
        .map(|r| SpineRef {
            idref: r.attr("idref").unwrap_or_default().trim().to_owned(),
            linear: !r
                .attr("linear")
                .is_some_and(|l| l.trim().eq_ignore_ascii_case("no")),
        })
        .collect();

    let meta_el = package.child("metadata");
    let meta = meta_el
        .map(|m| metadata(m, package, version))
        .unwrap_or(EpubMeta {
            title: None,
            authors: Vec::new(),
            language: None,
            identifier: None,
            version,
        });
    let cover_meta = meta_el.and_then(|m| {
        let mut metas = Vec::new();
        m.all_named("meta", &mut metas);
        metas
            .into_iter()
            .find(|e| e.attr("name").is_some_and(|n| n.trim() == "cover"))
            .and_then(|e| e.attr("content"))
            .map(|c| c.trim().to_owned())
    });

    Ok(Package {
        opf_path: opf_path.to_owned(),
        meta,
        manifest,
        by_id,
        spine,
        toc_id: spine_el.attr("toc").map(|t| t.trim().to_owned()),
        cover_meta,
    })
}

fn metadata(m: &Element, package: &Element, version: EpubVersion) -> EpubMeta {
    let texts = |name: &str| -> Vec<(String, Option<String>)> {
        let mut els = Vec::new();
        m.all_named(name, &mut els);
        els.into_iter()
            .map(|e| (e.text(), e.attr("id").map(str::to_owned)))
            .filter(|(t, _)| !t.is_empty())
            .collect()
    };
    let mut authors: Vec<String> = Vec::new();
    for (a, _) in texts("creator") {
        if !authors.contains(&a) {
            authors.push(a);
        }
    }
    let identifiers = texts("identifier");
    let unique = package.attr("unique-identifier").map(str::trim);
    let identifier = identifiers
        .iter()
        .find(|(_, id)| unique.is_some() && id.as_deref() == unique)
        .or(identifiers.first())
        .map(|(t, _)| t.clone());
    EpubMeta {
        title: texts("title").into_iter().next().map(|(t, _)| t),
        authors,
        language: texts("language").into_iter().next().map(|(t, _)| t),
        identifier,
        version,
    }
}

/// DRM: `META-INF/rights.xml`, or `META-INF/encryption.xml` encrypting anything with an algorithm
/// other than font obfuscation, or obfuscating a content document.
pub(crate) fn check_drm(archive: &Archive, package: &Package) -> Result<(), EpubError> {
    if archive.contains("META-INF/rights.xml") {
        return Err(EpubError::Drm);
    }
    if !archive.contains("META-INF/encryption.xml") {
        return Ok(());
    }
    let tree = match read_xml(archive, "META-INF/encryption.xml") {
        Ok(t) => t,
        Err(EpubError::TooLarge) => return Err(EpubError::TooLarge),
        // An unreadable encryption.xml can't be checked: treat it as protected.
        Err(_) => return Err(EpubError::Drm),
    };
    let mut entries = Vec::new();
    tree.all_named("EncryptedData", &mut entries);
    for data in entries {
        let algorithm = data
            .find_named("EncryptionMethod")
            .and_then(|m| m.attr("Algorithm"))
            .map(str::trim)
            .unwrap_or_default();
        if !OBFUSCATION.contains(&algorithm) {
            return Err(EpubError::Drm);
        }
        let target = data
            .find_named("CipherReference")
            .and_then(|c| c.attr("URI"))
            .and_then(|uri| resolve("", uri));
        if let Some(target) = target {
            let content = package
                .item_by_href(&target.path)
                .is_some_and(|m| is_content_type(&m.media_type))
                || target.path == package.opf_path;
            if content {
                return Err(EpubError::Drm);
            }
        }
    }
    Ok(())
}

pub(crate) fn is_content_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "application/xhtml+xml"
            | "text/html"
            | "application/xml"
            | "text/xml"
            | "application/x-dtbncx+xml"
            | "image/svg+xml"
    )
}
