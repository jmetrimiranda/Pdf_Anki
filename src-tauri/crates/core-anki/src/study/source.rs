//! The note's `Fonte` field → "Abrir no livro" (spec 8.2, 10.2): `leitor://livro/<book_uid>?pagina=N&q=…`.
use std::sync::LazyLock;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use regex::Regex;

use super::types::SourceLink;

/// Name of the field that holds the link (compared case-insensitively).
pub const SOURCE_FIELD: &str = "Fonte";
/// Longest search text kept from `q`, in chars.
pub const MAX_QUERY_CHARS: usize = 500;
/// Longest `q` the app writes into a new Fonte ([`source_query`]), in chars.
pub const SOURCE_QUERY_CHARS: usize = 80;

/// JavaScript's `encodeURIComponent` set: everything except `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is escaped.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// The `q` of a new Fonte (spec 10.2): whitespace collapsed to single spaces, trimmed and cut at a word boundary to
/// at most [`SOURCE_QUERY_CHARS`] chars (a first word longer than that is cut inside it). Never splits a char.
pub fn source_query(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SOURCE_QUERY_CHARS {
        return collapsed;
    }
    // Byte offset just past the SOURCE_QUERY_CHARS-th char.
    let limit = collapsed
        .char_indices()
        .nth(SOURCE_QUERY_CHARS)
        .map_or(collapsed.len(), |(i, _)| i);
    let head = &collapsed[..limit];
    // The char right after the cut is a space: the cut is already at a word boundary.
    if collapsed[limit..].starts_with(' ') {
        return head.trim_end().to_string();
    }
    match head.rfind(' ') {
        Some(space) if space > 0 => head[..space].trim_end().to_string(),
        _ => head.to_string(),
    }
}

/// The Fonte field of a card created from a selection (spec 10.2), `page` 1-based:
/// `<a href="leitor://livro/{uid}?pagina={page}&amp;q={query}">{title}, p. {page}</a>`, the query percent-encoded
/// like `encodeURIComponent` and omitted when empty, the title HTML-escaped. The web app builds the same string.
pub fn source_html(book_uid: &str, title: &str, page: u32, query: &str) -> String {
    let mut href = format!("leitor://livro/{book_uid}?pagina={page}");
    if !query.is_empty() {
        href.push_str("&amp;q=");
        href.push_str(&utf8_percent_encode(query, URI_COMPONENT).to_string());
    }
    format!("<a href=\"{href}\">{}, p. {page}</a>", escape_html(title))
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

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
    let label = if label_html.contains(['<', '&']) {
        anki::text::strip_html(label_html)
    } else {
        label_html.into()
    }
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
    fn source_html_literal() {
        assert_eq!(
            source_html(UID, "Animal Farm", 37, "the windmill"),
            format!(
                r#"<a href="leitor://livro/{UID}?pagina=37&amp;q=the%20windmill">Animal Farm, p. 37</a>"#
            )
        );
        assert_eq!(
            source_html(UID, "Animal Farm", 1, ""),
            format!(r#"<a href="leitor://livro/{UID}?pagina=1">Animal Farm, p. 1</a>"#)
        );
        assert_eq!(
            source_html(UID, r#"Tom & "Jerry" <1>"#, 2, "a&b=c?d#e+f/g"),
            format!(
                r#"<a href="leitor://livro/{UID}?pagina=2&amp;q=a%26b%3Dc%3Fd%23e%2Bf%2Fg">Tom &amp; &quot;Jerry&quot; &lt;1&gt;, p. 2</a>"#
            )
        );
        // encodeURIComponent keeps these as they are.
        assert!(
            source_html(UID, "x", 3, "it's (fine)! ~*_.-")
                .ends_with("q=it's%20(fine)!%20~*_.-\">x, p. 3</a>")
        );
        assert!(source_html(UID, "x", 3, "é ç").contains("q=%C3%A9%20%C3%A7\""));
    }

    #[test]
    fn source_html_round_trips() {
        for (title, page, query) in [
            ("Animal Farm", 37, "the windmill"),
            ("Tom & \"Jerry\" <1>", 2, "café, ação e 🐷"),
            (
                "O’Brien's \"quotes\"",
                120,
                "\"Four legs good\" — it's 'odd' & <b>",
            ),
            ("Sem consulta", 9, ""),
            ("Plus", 4, "a + b = c%"),
        ] {
            let html = source_html(UID, title, page, query);
            let link = parse_source(&html).unwrap_or_else(|| panic!("{html}"));
            assert_eq!(link.book_uid, UID);
            assert_eq!(link.page, page);
            assert_eq!(link.query.as_deref(), (!query.is_empty()).then_some(query));
            assert_eq!(link.label, format!("{title}, p. {page}"));
        }
    }

    #[test]
    fn source_query_collapses_and_cuts_at_words() {
        assert_eq!(
            source_query("  the\n\twindmill   was  "),
            "the windmill was"
        );
        assert_eq!(source_query(""), "");
        assert_eq!(source_query(" \n "), "");
        let words = "word ".repeat(30);
        let q = source_query(&words);
        assert!(q.chars().count() <= SOURCE_QUERY_CHARS, "{q}");
        assert_eq!(q, "word ".repeat(16).trim_end());
        // Exactly 80 chars followed by a space: kept whole.
        let exact = format!("{} tail", "a".repeat(80));
        assert_eq!(source_query(&exact), "a".repeat(80));
        // 79 chars + space + long word: cut before the word.
        let before = format!("{} {}", "b".repeat(79), "c".repeat(10));
        assert_eq!(source_query(&before), "b".repeat(79));
        // A first word longer than 80 chars is cut inside it, on a char boundary.
        let long = "é".repeat(100);
        assert_eq!(source_query(&long), "é".repeat(80));
        let emoji = format!("{} fim", "🐷".repeat(90));
        assert_eq!(source_query(&emoji), "🐷".repeat(80));
        // Multi-byte chars count as one char each.
        let accents = format!("{} {}", "ç".repeat(70), "ãããããããããããã");
        assert_eq!(source_query(&accents), "ç".repeat(70));
    }

    #[test]
    fn long_query_is_truncated() {
        let q = "a".repeat(800);
        let s = parse_link(&format!("leitor://livro/{UID}?pagina=1&q={q}"), "").unwrap();
        assert_eq!(s.query.unwrap().chars().count(), MAX_QUERY_CHARS);
    }
}
