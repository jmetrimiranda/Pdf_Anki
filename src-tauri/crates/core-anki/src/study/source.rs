//! The note's `Fonte` field → "Abrir no livro" (spec 8.2, 10.2, 7.1): `leitor://livro/<book_uid>?pagina=N&q=…` for a
//! PDF page, `leitor://livro/<book_uid>?cap=N&cfi=…&q=…` for an EPUB chapter (section N in reading order) and the
//! CFI position inside it.
use std::sync::LazyLock;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use regex::Regex;

use super::types::{SourceLink, SourceUnit};

/// Name of the field that holds the link (compared case-insensitively).
pub const SOURCE_FIELD: &str = "Fonte";
/// Longest search text kept from `q`, in chars.
pub const MAX_QUERY_CHARS: usize = 500;
/// Longest `cfi` kept from a link, in bytes.
pub const MAX_CFI_BYTES: usize = 2048;
/// Longest `q` the app writes into a new Fonte ([`source_query`]), in chars.
pub const SOURCE_QUERY_CHARS: usize = 80;
/// Longest chapter label [`source_html_section`] writes, in chars.
pub const SECTION_LABEL_CHARS: usize = 60;

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
    cut_at_word(&collapsed, SOURCE_QUERY_CHARS)
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

/// The Fonte field of a card created from an EPUB selection (spec 7.1, 10.2), `section` 1-based:
/// `<a href="leitor://livro/{uid}?cap={section}&amp;cfi={cfi}&amp;q={query}">{title}, {label}</a>`. `cfi` and the query
/// are percent-encoded like `encodeURIComponent` and omitted when absent or empty; the label is the section's
/// table-of-contents label cut at [`SECTION_LABEL_CHARS`] chars at a word boundary ([`section_label`]), or
/// `cap. {section}` without one; title and label are HTML-escaped. The web app builds the same string.
pub fn source_html_section(
    book_uid: &str,
    title: &str,
    section: u32,
    label: &str,
    cfi: Option<&str>,
    query: &str,
) -> String {
    let mut href = format!("leitor://livro/{book_uid}?cap={section}");
    if let Some(cfi) = cfi.filter(|c| !c.is_empty()) {
        href.push_str("&amp;cfi=");
        href.push_str(&utf8_percent_encode(cfi, URI_COMPONENT).to_string());
    }
    if !query.is_empty() {
        href.push_str("&amp;q=");
        href.push_str(&utf8_percent_encode(query, URI_COMPONENT).to_string());
    }
    format!(
        "<a href=\"{href}\">{}, {}</a>",
        escape_html(title),
        escape_html(&section_label(label, section))
    )
}

/// The label of a chapter in a Fonte: the table-of-contents label with whitespace collapsed, cut at
/// [`SECTION_LABEL_CHARS`] chars at a word boundary (a first word longer than that is cut inside it), or
/// `cap. {section}` when it is empty.
pub fn section_label(label: &str, section: u32) -> String {
    let collapsed = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return format!("cap. {section}");
    }
    cut_at_word(&collapsed, SECTION_LABEL_CHARS)
}

/// `text` (whitespace already collapsed) cut to at most `max` chars at a word boundary; never splits a char.
fn cut_at_word(collapsed: &str, max: usize) -> String {
    if collapsed.chars().count() <= max {
        return collapsed.to_string();
    }
    let limit = collapsed
        .char_indices()
        .nth(max)
        .map_or(collapsed.len(), |(i, _)| i);
    let head = &collapsed[..limit];
    if collapsed[limit..].starts_with(' ') {
        return head.trim_end().to_string();
    }
    match head.rfind(' ') {
        Some(space) if space > 0 => head[..space].trim_end().to_string(),
        _ => head.to_string(),
    }
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

/// Parses one `leitor://livro/…` URL. `label_html` is the link text (tags stripped; empty → "p. N" or "cap. N").
/// The number is `pagina=N` (a PDF page) or `cap=N` (an EPUB section); with both, `pagina` wins. `cfi` is kept only
/// when it is a valid EPUB CFI; `q` is the text to find.
pub fn parse_link(url: &str, label_html: &str) -> Option<SourceLink> {
    let c = LINK.captures(url)?;
    let book_uid = c[1].to_string();
    let mut page = None;
    let mut chapter = None;
    let mut cfi = None;
    let mut query = None;
    for pair in c.get(2).map_or("", |m| m.as_str()).split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "pagina" if page.is_none() => {
                page = Some(v.parse::<u32>().ok().filter(|p| *p > 0)?);
            }
            "cap" if chapter.is_none() => {
                chapter = Some(v.parse::<u32>().ok().filter(|p| *p > 0)?);
            }
            "cfi" if cfi.is_none() => {
                let decoded = percent_decode_str(v).decode_utf8_lossy();
                let decoded = decoded.trim();
                if decoded.len() <= MAX_CFI_BYTES && core_epub::is_valid_cfi(decoded) {
                    cfi = Some(decoded.to_string());
                }
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
    let (page, unit) = match (page, chapter) {
        (Some(p), _) => (p, SourceUnit::Page),
        (None, Some(c)) => (c, SourceUnit::Chapter),
        (None, None) => return None,
    };
    // A position inside an EPUB chapter means nothing for a PDF page.
    let cfi = cfi.filter(|_| unit == SourceUnit::Chapter);
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
        unit,
        cfi,
        query,
        label: match (label.is_empty(), unit) {
            (false, _) => label,
            (true, SourceUnit::Page) => format!("p. {page}"),
            (true, SourceUnit::Chapter) => format!("cap. {page}"),
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

    #[test]
    fn source_html_section_literal() {
        // W2 mirrors these strings in web/src/features/anki/study/links.ts (fonte for EPUB).
        assert_eq!(
            source_html_section(
                UID,
                "Animal Farm",
                3,
                "Chapter III",
                Some("epubcfi(/6/8!/4/2/1:0)"),
                "the windmill"
            ),
            format!(
                r#"<a href="leitor://livro/{UID}?cap=3&amp;cfi=epubcfi(%2F6%2F8!%2F4%2F2%2F1%3A0)&amp;q=the%20windmill">Animal Farm, Chapter III</a>"#
            )
        );
        assert_eq!(
            source_html_section(UID, "Animal Farm", 1, "", None, ""),
            format!(r#"<a href="leitor://livro/{UID}?cap=1">Animal Farm, cap. 1</a>"#)
        );
        assert_eq!(
            source_html_section(UID, "Animal Farm", 2, "  \n ", Some(""), "pigs"),
            format!(r#"<a href="leitor://livro/{UID}?cap=2&amp;q=pigs">Animal Farm, cap. 2</a>"#)
        );
        assert_eq!(
            source_html_section(
                UID,
                r#"Tom & "Jerry""#,
                12,
                "Part One: The Rebellion & the Windmill of Animal Farm, in which everything changes",
                Some("epubcfi(/6/4!/4/2,/1:0,/1:12)"),
                ""
            ),
            format!(
                r#"<a href="leitor://livro/{UID}?cap=12&amp;cfi=epubcfi(%2F6%2F4!%2F4%2F2%2C%2F1%3A0%2C%2F1%3A12)">Tom &amp; &quot;Jerry&quot;, Part One: The Rebellion &amp; the Windmill of Animal Farm, in</a>"#
            )
        );
        assert_eq!(section_label("<b>Intro</b>", 4), "<b>Intro</b>");
        assert_eq!(section_label("", 4), "cap. 4");
        assert_eq!(section_label(&"x".repeat(70), 4), "x".repeat(60));
    }

    #[test]
    fn chapter_links_parse() {
        let html = source_html_section(
            UID,
            "Animal Farm",
            3,
            "Chapter III",
            Some("epubcfi(/6/8!/4/2/1:0)"),
            "the windmill",
        );
        let s = parse_source(&html).unwrap();
        assert_eq!(s.page, 3);
        assert_eq!(s.unit, SourceUnit::Chapter);
        assert_eq!(s.cfi.as_deref(), Some("epubcfi(/6/8!/4/2/1:0)"));
        assert_eq!(s.query.as_deref(), Some("the windmill"));
        assert_eq!(s.label, "Animal Farm, Chapter III");

        // Bare link, default label.
        let s = parse_link(&format!("leitor://livro/{UID}?cap=7"), "").unwrap();
        assert_eq!((s.page, s.unit, s.cfi), (7, SourceUnit::Chapter, None));
        assert_eq!(s.label, "cap. 7");

        // pagina wins over cap; a cfi means nothing for a page.
        let s = parse_link(
            &format!("leitor://livro/{UID}?cap=7&pagina=2&cfi=epubcfi(%2F6%2F4!%2F4%2F2%2F1%3A0)"),
            "",
        )
        .unwrap();
        assert_eq!((s.page, s.unit, s.cfi), (2, SourceUnit::Page, None));
        assert_eq!(s.label, "p. 2");

        // An invalid cfi is dropped, the link stays.
        for bad in [
            "garbage",
            "epubcfi(",
            "%ZZ",
            "epubcfi(/6/4!/4/2/1:0)%3Cscript%3E",
        ] {
            let s = parse_link(&format!("leitor://livro/{UID}?cap=2&cfi={bad}"), "").unwrap();
            assert_eq!((s.page, s.cfi), (2, None), "{bad}");
        }
        assert!(parse_link(&format!("leitor://livro/{UID}?cap=0"), "").is_none());
        assert!(parse_link(&format!("leitor://livro/{UID}?cap=x"), "").is_none());
        assert!(parse_link(&format!("leitor://livro/{UID}?cfi=epubcfi(%2F6%2F4)"), "").is_none());
        // PDF links are unchanged.
        let s = parse_link(&format!("leitor://livro/{UID}?pagina=4"), "").unwrap();
        assert_eq!(
            (s.unit, s.cfi, s.label.as_str()),
            (SourceUnit::Page, None, "p. 4")
        );
    }
}
