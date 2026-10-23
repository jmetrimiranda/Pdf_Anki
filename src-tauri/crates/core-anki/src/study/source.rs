//! The note's `Fonte` field → "Abrir no livro" (spec 8.2, 10.2): `leitor://livro/<book_uid>?pagina=N&q=…`.
use std::sync::LazyLock;

use percent_encoding::percent_decode_str;
use regex::Regex;

use super::types::SourceLink;

/// Name of the field that holds the link (compared case-insensitively).
pub const SOURCE_FIELD: &str = "Fonte";
/// Longest search text kept from `q`, in chars.
pub const MAX_QUERY_CHARS: usize = 500;

static ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>(.*?)</a\s*>"#)
        .expect("valid regex")
});
static BARE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)leitor://[^\s"'<>]+"#).expect("valid regex"));
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^leitor://livro/([0-9a-f]{64})(?:\?([^#]*))?(?:#.*)?$").expect("valid regex")
});

/// The first valid link of the field's HTML (anchors first, then bare URLs); malformed links are skipped.
pub fn parse_source(field_html: &str) -> Option<SourceLink> {
    for c in ANCHOR.captures_iter(field_html) {
        let href = c
            .get(1)
            .or(c.get(2))
            .or(c.get(3))
            .map_or("", |m| m.as_str());
        let label = c.get(4).map_or("", |m| m.as_str());
        if let Some(link) = parse_link(&anki::text::decode_entities(href.trim()), label) {
            return Some(link);
        }
    }
    let without_anchors = ANCHOR.replace_all(field_html, " ");
    BARE.find_iter(&without_anchors)
        .find_map(|m| parse_link(&anki::text::decode_entities(m.as_str()), ""))
}

/// Parses one `leitor://livro/…` URL. `label_html` is the link text (tags stripped; empty → "p. N").
pub fn parse_link(url: &str, label_html: &str) -> Option<SourceLink> {
    let c = LINK.captures(url)?;
    let book_uid = c[1].to_string();
    let mut page = None;
    let mut query = None;
    for pair in c.get(2).map_or("", |m| m.as_str()).split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "pagina" if page.is_none() => {
                page = Some(v.parse::<u32>().ok().filter(|p| *p > 0)?);
            }
            "q" if query.is_none() => {
                let plus = v.replace('+', " ");
                let decoded = percent_decode_str(&plus).decode_utf8_lossy();
                let text: String = decoded.trim().chars().take(MAX_QUERY_CHARS).collect();
                if !text.is_empty() {
                    query = Some(text);
                }
            }
            _ => {}
        }
    }
    let page = page?;
    let label = anki::text::strip_html(label_html)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Some(SourceLink {
        book_uid,
        page,
        query,
        label: if label.is_empty() {
            format!("p. {page}")
        } else {
            label
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn anchor_with_page_and_query() {
        let html = format!(
            r#"<a href="leitor://livro/{UID}?pagina=37&amp;q=the%20windmill">Animal Farm, <b>p. 37</b></a>"#
        );
        let s = parse_source(&html).unwrap();
        assert_eq!(s.book_uid, UID);
        assert_eq!(s.page, 37);
        assert_eq!(s.query.as_deref(), Some("the windmill"));
        assert_eq!(s.label, "Animal Farm, p. 37");
    }

    #[test]
    fn malformed_links_are_skipped() {
        assert!(
            parse_source(&format!(
                "<a href='leitor://livro/{}?pagina=3'>x</a>",
                &UID[1..]
            ))
            .is_none()
        );
        assert!(
            parse_source(&format!(
                "<a href='leitor://livro/{}?pagina=3'>x</a>",
                UID.to_uppercase()
            ))
            .is_none()
        );
        assert!(parse_source(&format!("<a href='leitor://livro/{UID}?q=a'>x</a>")).is_none());
        assert!(parse_source(&format!("<a href='leitor://livro/{UID}?pagina=0'>x</a>")).is_none());
        assert!(parse_source(&format!("<a href='leitor://livro/{UID}?pagina=-2'>x</a>")).is_none());
        // A bad link first, a good one after: the good one wins.
        let html = format!(
            "<a href='leitor://livro/xyz?pagina=3'>a</a> <a href=leitor://livro/{UID}?pagina=9>b</a>"
        );
        assert_eq!(parse_source(&html).unwrap().page, 9);
    }

    #[test]
    fn bare_url_and_default_label() {
        let s = parse_source(&format!("veja leitor://livro/{UID}?pagina=5&q=a+b%C3%A7")).unwrap();
        assert_eq!(s.page, 5);
        assert_eq!(s.query.as_deref(), Some("a bç"));
        assert_eq!(s.label, "p. 5");
    }

    #[test]
    fn long_query_is_truncated() {
        let q = "a".repeat(800);
        let s = parse_link(&format!("leitor://livro/{UID}?pagina=1&q={q}"), "").unwrap();
        assert_eq!(s.query.unwrap().chars().count(), MAX_QUERY_CHARS);
    }
}
