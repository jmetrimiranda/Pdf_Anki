//! Href resolution inside the zip. Hrefs are only lookup keys into the archive, never filesystem
//! paths: `..` can't climb above the root and nothing is ever extracted to disk.

use percent_encoding::percent_decode_str;

/// A resolved reference: zip path (percent-decoded, normalised) and the optional `#fragment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Href {
    pub path: String,
    pub fragment: Option<String>,
}

pub(crate) fn percent_decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// True for `scheme:` URLs (http:, mailto:, data:…), which never point into the book.
fn is_external(href: &str) -> bool {
    let mut chars = href.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return false;
        }
    }
    false
}

/// Resolves `href` relative to the file `base` (a zip path). An empty path part (`#frag`) refers
/// to `base` itself. External URLs and empty hrefs give `None`.
pub(crate) fn resolve(base: &str, href: &str) -> Option<Href> {
    let href = href.trim();
    if href.is_empty() || is_external(href) {
        return None;
    }
    let (path_part, fragment) = match href.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (href, None),
    };
    let path_part = path_part.split('?').next().unwrap_or_default();
    let fragment = fragment.map(percent_decode).filter(|f| !f.is_empty());
    if path_part.is_empty() {
        return Some(Href {
            path: base.to_owned(),
            fragment,
        });
    }
    let decoded = percent_decode(path_part);
    let mut segments: Vec<&str> = Vec::new();
    if !decoded.starts_with('/') {
        segments.extend(base.split('/'));
        segments.pop(); // the file name of `base`
    }
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    segments.retain(|s| !s.is_empty());
    if segments.is_empty() {
        return None;
    }
    Some(Href {
        path: segments.join("/"),
        fragment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(base: &str, href: &str) -> Option<(String, Option<String>)> {
        resolve(base, href).map(|h| (h.path, h.fragment))
    }

    #[test]
    fn resolves_relative_paths() {
        assert_eq!(
            r("OEBPS/content.opf", "text/ch1.xhtml"),
            Some(("OEBPS/text/ch1.xhtml".into(), None))
        );
        assert_eq!(
            r("OEBPS/nav/nav.xhtml", "../text/ch%201.xhtml#p%C3%A1g"),
            Some(("OEBPS/text/ch 1.xhtml".into(), Some("pág".into())))
        );
        assert_eq!(
            r("content.opf", "./a/./b.html?x=1#f"),
            Some(("a/b.html".into(), Some("f".into())))
        );
        assert_eq!(
            r("OEBPS/toc.ncx", "#top"),
            Some(("OEBPS/toc.ncx".into(), Some("top".into())))
        );
        assert_eq!(
            r("OEBPS/a.opf", "/root.xhtml"),
            Some(("root.xhtml".into(), None))
        );
        assert_eq!(
            r("a.opf", "../../../etc/passwd"),
            Some(("etc/passwd".into(), None))
        );
    }

    #[test]
    fn rejects_external_and_empty() {
        assert_eq!(r("a.opf", "http://example.com/x.html"), None);
        assert_eq!(r("a.opf", "mailto:a@b"), None);
        assert_eq!(r("a.opf", "  "), None);
        assert_eq!(r("a.opf", ".."), None);
        assert_eq!(r("a.opf", "c:d"), None);
        assert_eq!(r("a.opf", "1:d"), Some(("1:d".into(), None)));
    }
}
