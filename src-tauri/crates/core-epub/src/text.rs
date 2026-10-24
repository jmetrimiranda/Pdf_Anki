//! Plain text of a content document for search and the vocabulary scan (spec 7.1, 12.3 B).
//!
//! Block elements and `<br>` end a line; `head`, `script`, `style`, `svg`, `math`, `rt`, `rp`,
//! `template` and `noscript` are skipped; whitespace is collapsed within lines and lines are
//! trimmed (empty lines dropped). quick-xml parses with end-name checks off; on a hard syntax
//! error the section falls back to a tolerant tag stripper — a section never fails the book.

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::xml::{collapse_ws, decode_entities, is_invisible, is_space, resolve_entity};

const SKIP: [&str; 9] = [
    "head", "script", "style", "svg", "math", "rt", "rp", "template", "noscript",
];
const BLOCK: [&str; 26] = [
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "pre",
    "tr",
    "section",
    "article",
    "aside",
    "header",
    "footer",
    "figcaption",
    "dt",
    "dd",
    "hr",
    "br",
    "ul",
    "ol",
    "table",
    "body",
];

fn lower_local(qname: &str) -> String {
    qname
        .rsplit(':')
        .next()
        .unwrap_or(qname)
        .to_ascii_lowercase()
}

fn is_skip(name: &str) -> bool {
    SKIP.contains(&name)
}

fn is_block(name: &str) -> bool {
    BLOCK.contains(&name)
}

/// Table cells: separated by a space so neighbouring cells don't glue words together.
fn is_cell(name: &str) -> bool {
    matches!(name, "td" | "th")
}

/// Accumulates lines with collapsed whitespace.
#[derive(Default)]
struct Out {
    text: String,
    line: String,
    pending_space: bool,
}

impl Out {
    fn push(&mut self, s: &str) {
        for c in s.chars() {
            if is_space(c) {
                self.pending_space = !self.line.is_empty();
            } else if !is_invisible(c) {
                if self.pending_space {
                    self.line.push(' ');
                    self.pending_space = false;
                }
                self.line.push(c);
            }
        }
    }

    fn newline(&mut self) {
        if !self.line.is_empty() {
            if !self.text.is_empty() {
                self.text.push('\n');
            }
            self.text.push_str(&self.line);
            self.line.clear();
        }
        self.pending_space = false;
    }

    fn finish(mut self) -> String {
        self.newline();
        self.text
    }
}

/// Text of an (X)HTML document (already decoded to a string).
pub(crate) fn extract(doc: &str) -> String {
    match extract_xml(doc) {
        Ok(text) => text,
        Err(e) => {
            tracing::debug!(error = %e, "malformed XHTML, using the tag stripper");
            strip_tags(doc)
        }
    }
}

fn reader(doc: &str) -> Reader<&[u8]> {
    let mut reader = Reader::from_str(doc);
    let cfg = reader.config_mut();
    cfg.check_end_names = false;
    cfg.allow_unmatched_ends = true;
    cfg.allow_dangling_amp = true;
    reader
}

fn extract_xml(doc: &str) -> Result<String, quick_xml::Error> {
    let mut lower: Option<Vec<u8>> = None;
    // Offset of the current reader's input in `doc` (the reader restarts after raw-text elements).
    let mut base = 0usize;
    let mut reader = reader(doc);
    let mut out = Out::default();
    let mut stack: Vec<String> = Vec::new();
    let mut skipping = 0usize;
    loop {
        match reader.read_event()? {
            Event::Start(s) => {
                let name = lower_local(s.name().0);
                if matches!(name.as_str(), "script" | "style") {
                    // Raw text (a `<` in a script must not open a tag): jump past `</name…>`.
                    let lower = lower.get_or_insert_with(|| doc.as_bytes().to_ascii_lowercase());
                    let here = (base + reader.buffer_position() as usize).min(doc.len());
                    let needle = format!("</{name}");
                    let end = crate::xml::find(&lower[here..], needle.as_bytes())
                        .and_then(|i| {
                            crate::xml::find(&lower[here + i..], b">").map(|j| here + i + j + 1)
                        })
                        .unwrap_or(doc.len());
                    base = end;
                    reader = self::reader(&doc[end..]);
                    continue;
                }
                if is_skip(&name) {
                    skipping += 1;
                }
                if skipping == 0 && is_block(&name) {
                    out.newline();
                } else if skipping == 0 && is_cell(&name) {
                    out.push(" ");
                }
                stack.push(name);
            }
            Event::Empty(s) => {
                let name = lower_local(s.name().0);
                if skipping == 0 && is_block(&name) {
                    out.newline();
                }
            }
            Event::End(e) => {
                let name = lower_local(e.name().0);
                if let Some(pos) = stack.iter().rposition(|n| *n == name) {
                    for closed in stack.drain(pos..) {
                        if is_skip(&closed) {
                            skipping = skipping.saturating_sub(1);
                        }
                    }
                }
                if skipping == 0 && is_block(&name) {
                    out.newline();
                } else if skipping == 0 && is_cell(&name) {
                    out.push(" ");
                }
            }
            Event::Text(t) if skipping == 0 => out.push(&decode_entities(&t.xml10_content())),
            Event::CData(t) if skipping == 0 => out.push(&t.xml10_content()),
            Event::GeneralRef(r) if skipping == 0 => {
                let name = r.into_inner();
                match resolve_entity(&name) {
                    Some(v) => out.push(&v),
                    None => out.push(&format!("&{name};")),
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out.finish())
}

// ---------------------------------------------------------------------------------------------
// Tolerant tokenizer (fallback stripper, headings, first image)
// ---------------------------------------------------------------------------------------------

enum Token<'a> {
    Text(&'a str),
    Open {
        name: String,
        attrs: &'a str,
        self_closing: bool,
    },
    Close {
        name: String,
    },
}

/// A forgiving HTML tokenizer: comments, CDATA, doctypes and PIs are handled, raw-text content
/// of skipped elements is jumped over by the callers, a stray `<` is text.
struct Tokens<'a> {
    src: &'a str,
    lower: Vec<u8>,
    pos: usize,
}

impl<'a> Tokens<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            src,
            lower: src.as_bytes().to_ascii_lowercase(),
            pos: 0,
        }
    }

    fn find_from(&self, from: usize, needle: &[u8]) -> Option<usize> {
        crate::xml::find(&self.lower[from.min(self.lower.len())..], needle).map(|i| i + from)
    }

    /// Jumps past `</name …>` (raw text elements); to the end when missing.
    fn skip_to_close(&mut self, name: &str) {
        let needle = format!("</{name}");
        match self.find_from(self.pos, needle.as_bytes()) {
            Some(i) => {
                self.pos = self.find_from(i, b">").map_or(self.src.len(), |j| j + 1);
            }
            None => self.pos = self.src.len(),
        }
    }

    fn next(&mut self) -> Option<Token<'a>> {
        let bytes = self.src.as_bytes();
        loop {
            if self.pos >= bytes.len() {
                return None;
            }
            let start = self.pos;
            if bytes[start] != b'<' {
                let end = self.find_from(start, b"<").unwrap_or(bytes.len());
                self.pos = end;
                return Some(Token::Text(&self.src[start..end]));
            }
            let rest = &self.lower[start..];
            if rest.starts_with(b"<!--") {
                self.pos = self
                    .find_from(start + 4, b"-->")
                    .map_or(bytes.len(), |i| i + 3);
                continue;
            }
            if rest.starts_with(b"<![cdata[") {
                let end = self.find_from(start + 9, b"]]>").unwrap_or(bytes.len());
                self.pos = (end + 3).min(bytes.len());
                return Some(Token::Text(&self.src[start + 9..end]));
            }
            if rest.starts_with(b"<!") || rest.starts_with(b"<?") {
                self.pos = self.find_from(start, b">").map_or(bytes.len(), |i| i + 1);
                continue;
            }
            let closing = rest.get(1) == Some(&b'/');
            let name_start = start + 1 + usize::from(closing);
            let mut i = name_start;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric()
                    || matches!(bytes[i], b':' | b'-' | b'_' | b'.'))
            {
                i += 1;
            }
            if i == name_start {
                // A stray `<`: text.
                self.pos = start + 1;
                return Some(Token::Text("<"));
            }
            let name = lower_local(&self.src[name_start..i]);
            // End of the tag, respecting quoted attribute values.
            let mut j = i;
            let mut quote: Option<u8> = None;
            while j < bytes.len() {
                match (quote, bytes[j]) {
                    (None, b'"' | b'\'') => quote = Some(bytes[j]),
                    (Some(q), c) if c == q => quote = None,
                    (None, b'>') => break,
                    _ => {}
                }
                j += 1;
            }
            let tag_end = j.min(bytes.len());
            self.pos = (tag_end + 1).min(bytes.len());
            let inner = &self.src[i..tag_end];
            if closing {
                return Some(Token::Close { name });
            }
            let self_closing = inner.trim_end().ends_with('/');
            return Some(Token::Open {
                name,
                attrs: inner,
                self_closing,
            });
        }
    }
}

/// Value of attribute `name` in a raw attribute string (`src="a.png" alt=x`), entities decoded.
fn attr_value(attrs: &str, name: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let bytes = attrs.as_bytes();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(name) {
        let at = from + pos;
        from = at + name.len();
        let before_ok =
            at == 0 || matches!(bytes[at - 1], b' ' | b'\t' | b'\n' | b'\r' | b':' | b'/');
        let mut i = from;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if !before_ok || bytes.get(i) != Some(&b'=') {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let value = match bytes.get(i) {
            Some(&q @ (b'"' | b'\'')) => {
                let end = attrs[i + 1..]
                    .find(q as char)
                    .map_or(attrs.len(), |e| e + i + 1);
                &attrs[i + 1..end]
            }
            Some(_) => {
                let end = attrs[i..]
                    .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
                    .map_or(attrs.len(), |e| e + i);
                &attrs[i..end]
            }
            None => return None,
        };
        return Some(decode_entities(value).into_owned());
    }
    None
}

/// The tolerant fallback for documents quick-xml can't read.
pub(crate) fn strip_tags(doc: &str) -> String {
    let mut out = Out::default();
    let mut tokens = Tokens::new(doc);
    while let Some(tok) = tokens.next() {
        match tok {
            Token::Text(t) => out.push(&decode_entities(t)),
            Token::Open {
                name, self_closing, ..
            } => {
                if is_block(&name) {
                    out.newline();
                } else if is_cell(&name) {
                    out.push(" ");
                }
                if is_skip(&name) && !self_closing {
                    tokens.skip_to_close(&name);
                }
            }
            Token::Close { name } => {
                if is_block(&name) {
                    out.newline();
                } else if is_cell(&name) {
                    out.push(" ");
                }
            }
        }
    }
    out.finish()
}

/// The first `<h1>`–`<h3>` text, else the `<title>`: the fallback TOC label of a section.
pub(crate) fn heading(doc: &str) -> Option<String> {
    let mut tokens = Tokens::new(doc);
    let mut title: Option<String> = None;
    let mut capture: Option<(String, String)> = None; // (element, raw text)
    while let Some(tok) = tokens.next() {
        match tok {
            Token::Text(t) => {
                if let Some((_, buf)) = capture.as_mut() {
                    buf.push_str(t);
                }
            }
            Token::Open {
                name, self_closing, ..
            } => {
                if capture.is_none()
                    && !self_closing
                    && matches!(name.as_str(), "h1" | "h2" | "h3" | "title")
                {
                    capture = Some((name, String::new()));
                } else if matches!(name.as_str(), "script" | "style") && !self_closing {
                    tokens.skip_to_close(&name);
                }
            }
            Token::Close { name } => {
                if capture.as_ref().is_some_and(|(n, _)| *n == name) {
                    let (n, raw) = capture.take().unwrap_or_default();
                    let text = collapse_ws(&decode_entities(&raw));
                    if !text.is_empty() {
                        if n == "title" {
                            title.get_or_insert(text);
                        } else {
                            return Some(text);
                        }
                    }
                }
            }
        }
    }
    title
}

/// `src` of the first `<img>` (or SVG `<image>` href) of a document.
pub(crate) fn first_image(doc: &str) -> Option<String> {
    let mut tokens = Tokens::new(doc);
    while let Some(tok) = tokens.next() {
        if let Token::Open { name, attrs, .. } = tok {
            let src = match name.as_str() {
                "img" => attr_value(attrs, "src"),
                "image" => attr_value(attrs, "href"),
                _ => None,
            };
            if let Some(src) = src.filter(|s| !s.trim().is_empty()) {
                return Some(src);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_and_inline() {
        let doc = "<?xml version='1.0'?><html><head><title>T</title><style>p{}</style></head>\
            <body><h1>Chapter&#160;One</h1><p>Hello <em>big</em>\n   world&nbsp;&mdash; yes.<br/>Next</p>\
            <script>var x = 1;</script><div><p>A</p><p>B</p></div><ruby>漢<rt>kan</rt></ruby></body></html>";
        assert_eq!(
            extract(doc),
            "Chapter One\nHello big world — yes.\nNext\nA\nB\n漢"
        );
    }

    #[test]
    fn malformed_falls_back() {
        let doc = "<html><body><p>one <b>two</p><p>three & four <i x=1>five</body>";
        let text = extract(doc);
        assert!(text.contains("one two"), "{text}");
        assert!(text.contains("three & four five"), "{text}");
        let broken = "<p>a < b and <<<>>> c</p><script>if (a<b) {}</script><p>d</p>";
        let text = extract(broken);
        assert!(text.contains('d') && !text.contains("if ("), "{text}");
    }

    #[test]
    fn stripper() {
        assert_eq!(
            strip_tags(
                "<!DOCTYPE html><!-- c --><p>x &amp; y</p><style>a{}</style><br>z<![CDATA[<k>]]>"
            ),
            "x & y\nz<k>"
        );
    }

    #[test]
    fn headings_and_images() {
        assert_eq!(
            heading(
                "<html><head><title>Doc</title></head><body><h2>Real &amp; <i>one</i></h2></body>"
            )
            .as_deref(),
            Some("Real & one")
        );
        assert_eq!(
            heading("<html><head><title> Only </title></head><body><p>x</p></body>").as_deref(),
            Some("Only")
        );
        assert_eq!(heading("<p>none</p>"), None);
        assert_eq!(
            first_image("<p><img alt='x' src=\"../img/a%20b.png\"/></p>").as_deref(),
            Some("../img/a%20b.png")
        );
        assert_eq!(
            first_image("<svg><image xlink:href='c.jpg'/></svg>").as_deref(),
            Some("c.jpg")
        );
        assert_eq!(
            attr_value("data-src='x' src=y", "src").as_deref(),
            Some("y")
        );
    }
}
