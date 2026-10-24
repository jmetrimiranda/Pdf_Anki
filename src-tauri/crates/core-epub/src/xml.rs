//! Byte decoding, entity decoding and a small tolerant element tree for the package files
//! (container.xml, OPF, nav, NCX, encryption.xml). Content documents are streamed by `text.rs`.

use std::borrow::Cow;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

/// Maximum element nesting in a package file; deeper documents are rejected.
const MAX_DEPTH: usize = 256;

// ---------------------------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------------------------

/// Decodes an (X)HTML/XML file: UTF-8 (BOM ok), UTF-16 LE/BE (BOM, or a `<` followed by a NUL),
/// an encoding declared in the XML declaration or a `<meta charset>` (through `encoding_rs`);
/// anything else is lossy UTF-8. Never fails.
pub(crate) fn decode_document(bytes: &[u8]) -> String {
    use encoding_rs::{UTF_16BE, UTF_16LE};
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return UTF_16LE.decode_without_bom_handling(rest).0.into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return UTF_16BE.decode_without_bom_handling(rest).0.into_owned();
    }
    if bytes.len() >= 2 && bytes[0] == b'<' && bytes[1] == 0 {
        return UTF_16LE.decode_without_bom_handling(bytes).0.into_owned();
    }
    if bytes.len() >= 2 && bytes[0] == 0 && bytes[1] == b'<' {
        return UTF_16BE.decode_without_bom_handling(bytes).0.into_owned();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    if let Some(enc) = declared_encoding(&bytes[..bytes.len().min(2048)])
        && enc != encoding_rs::UTF_8
        && enc != UTF_16LE
        && enc != UTF_16BE
    {
        return enc.decode_without_bom_handling(bytes).0.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// The encoding named by `encoding="…"` (XML declaration) or `charset=…` (HTML meta) in the head
/// of a document.
fn declared_encoding(head: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let lower = head.to_ascii_lowercase();
    for key in [&b"encoding"[..], &b"charset"[..]] {
        let mut from = 0;
        while let Some(pos) = find(&lower[from..], key) {
            let mut i = from + pos + key.len();
            from = i;
            while i < lower.len() && lower[i].is_ascii_whitespace() {
                i += 1;
            }
            if lower.get(i) != Some(&b'=') {
                continue;
            }
            i += 1;
            while i < lower.len() && lower[i].is_ascii_whitespace() {
                i += 1;
            }
            if matches!(lower.get(i), Some(b'"' | b'\'')) {
                i += 1;
            }
            let start = i;
            while i < lower.len()
                && (lower[i].is_ascii_alphanumeric()
                    || matches!(lower[i], b'-' | b'_' | b'.' | b':'))
            {
                i += 1;
            }
            if i > start
                && let Some(enc) = encoding_rs::Encoding::for_label(&lower[start..i])
            {
                return Some(enc);
            }
        }
    }
    None
}

pub(crate) fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

/// Resolves an entity name without `&`/`;`: XML's five, numeric references and the common HTML
/// named entities. Unknown names give `None`.
pub(crate) fn resolve_entity(name: &str) -> Option<Cow<'static, str>> {
    if let Some(num) = name.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            num.parse::<u32>().ok()
        };
        let ch = match code {
            Some(0) | None => '\u{FFFD}',
            Some(c) => char::from_u32(c).unwrap_or('\u{FFFD}'),
        };
        return Some(Cow::Owned(ch.to_string()));
    }
    named_entity(name).map(Cow::Borrowed)
}

#[rustfmt::skip]
fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\"", "apos" => "'",
        "nbsp" => "\u{A0}", "shy" => "\u{AD}", "ensp" => "\u{2002}", "emsp" => "\u{2003}",
        "thinsp" => "\u{2009}", "zwnj" => "\u{200C}", "zwj" => "\u{200D}", "lrm" => "\u{200E}",
        "rlm" => "\u{200F}",
        "ndash" => "–", "mdash" => "—", "lsquo" => "‘", "rsquo" => "’", "sbquo" => "‚",
        "ldquo" => "“", "rdquo" => "”", "bdquo" => "„", "hellip" => "…", "prime" => "′",
        "Prime" => "″", "lsaquo" => "‹", "rsaquo" => "›", "laquo" => "«", "raquo" => "»",
        "bull" => "•", "middot" => "·", "dagger" => "†", "Dagger" => "‡", "permil" => "‰",
        "copy" => "©", "reg" => "®", "trade" => "™", "sect" => "§", "para" => "¶",
        "deg" => "°", "plusmn" => "±", "times" => "×", "divide" => "÷", "micro" => "µ",
        "frac14" => "¼", "frac12" => "½", "frac34" => "¾", "sup1" => "¹", "sup2" => "²",
        "sup3" => "³", "ordf" => "ª", "ordm" => "º", "not" => "¬", "macr" => "¯",
        "acute" => "´", "cedil" => "¸", "uml" => "¨", "iexcl" => "¡", "iquest" => "¿",
        "cent" => "¢", "pound" => "£", "curren" => "¤", "yen" => "¥", "euro" => "€",
        "brvbar" => "¦", "larr" => "←", "rarr" => "→", "uarr" => "↑", "darr" => "↓",
        "harr" => "↔", "minus" => "−", "le" => "≤", "ge" => "≥", "ne" => "≠", "infin" => "∞",
        "oline" => "‾", "frasl" => "⁄", "loz" => "◊", "spades" => "♠", "clubs" => "♣",
        "hearts" => "♥", "diams" => "♦",
        "Agrave" => "À", "Aacute" => "Á", "Acirc" => "Â", "Atilde" => "Ã", "Auml" => "Ä",
        "Aring" => "Å", "AElig" => "Æ", "Ccedil" => "Ç", "Egrave" => "È", "Eacute" => "É",
        "Ecirc" => "Ê", "Euml" => "Ë", "Igrave" => "Ì", "Iacute" => "Í", "Icirc" => "Î",
        "Iuml" => "Ï", "ETH" => "Ð", "Ntilde" => "Ñ", "Ograve" => "Ò", "Oacute" => "Ó",
        "Ocirc" => "Ô", "Otilde" => "Õ", "Ouml" => "Ö", "Oslash" => "Ø", "Ugrave" => "Ù",
        "Uacute" => "Ú", "Ucirc" => "Û", "Uuml" => "Ü", "Yacute" => "Ý", "THORN" => "Þ",
        "szlig" => "ß", "agrave" => "à", "aacute" => "á", "acirc" => "â", "atilde" => "ã",
        "auml" => "ä", "aring" => "å", "aelig" => "æ", "ccedil" => "ç", "egrave" => "è",
        "eacute" => "é", "ecirc" => "ê", "euml" => "ë", "igrave" => "ì", "iacute" => "í",
        "icirc" => "î", "iuml" => "ï", "eth" => "ð", "ntilde" => "ñ", "ograve" => "ò",
        "oacute" => "ó", "ocirc" => "ô", "otilde" => "õ", "ouml" => "ö", "oslash" => "ø",
        "ugrave" => "ù", "uacute" => "ú", "ucirc" => "û", "uuml" => "ü", "yacute" => "ý",
        "thorn" => "þ", "yuml" => "ÿ", "Yuml" => "Ÿ", "OElig" => "Œ", "oelig" => "œ",
        "Scaron" => "Š", "scaron" => "š", "fnof" => "ƒ", "circ" => "ˆ", "tilde" => "˜",
        "Alpha" => "Α", "Beta" => "Β", "Gamma" => "Γ", "Delta" => "Δ", "Omega" => "Ω",
        "alpha" => "α", "beta" => "β", "gamma" => "γ", "delta" => "δ", "epsilon" => "ε",
        "lambda" => "λ", "mu" => "μ", "pi" => "π", "sigma" => "σ", "omega" => "ω",
        _ => return None,
    })
}

/// Decodes `&…;` references in raw text or attribute values; unknown or unterminated references
/// stay literal.
pub(crate) fn decode_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let end = after
            .char_indices()
            .take(33)
            .find(|&(_, c)| c == ';' || c == '&' || c == '<' || c.is_whitespace())
            .filter(|&(_, c)| c == ';')
            .map(|(i, _)| i);
        match end.and_then(|e| resolve_entity(&after[..e]).map(|v| (e, v))) {
            Some((e, value)) => {
                out.push_str(&value);
                rest = &after[e + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// Collapses runs of whitespace (incl. no-break spaces) into one space and trims.
pub(crate) fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending = false;
    for c in s.chars() {
        if is_space(c) {
            pending = !out.is_empty();
        } else if !is_invisible(c) {
            if pending {
                out.push(' ');
                pending = false;
            }
            out.push(c);
        }
    }
    out
}

pub(crate) fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{A0}' || c == '\u{FEFF}'
}

/// Characters dropped from extracted text: soft hyphen, zero-width space and BOM.
pub(crate) fn is_invisible(c: char) -> bool {
    matches!(c, '\u{AD}' | '\u{200B}' | '\u{2060}')
}

// ---------------------------------------------------------------------------------------------
// Element tree
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub(crate) struct Element {
    /// Qualified name as written (`dc:title`).
    pub name: String,
    /// `(qualified name, decoded value)`.
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

#[derive(Debug, Clone)]
pub(crate) enum Node {
    Element(Element),
    Text(String),
}

fn local(qname: &str) -> &str {
    qname.rsplit(':').next().unwrap_or(qname)
}

impl Element {
    pub fn local(&self) -> &str {
        local(&self.name)
    }

    pub fn is(&self, local_name: &str) -> bool {
        self.local().eq_ignore_ascii_case(local_name)
    }

    /// Attribute by qualified name, falling back to the local name (`epub:type` → `type`).
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .or_else(|| {
                let wanted = local(name);
                self.attrs
                    .iter()
                    .find(|(k, _)| local(k).eq_ignore_ascii_case(wanted))
            })
            .map(|(_, v)| v.as_str())
    }

    pub fn elements(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(|n| match n {
            Node::Element(e) => Some(e),
            Node::Text(_) => None,
        })
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.elements().filter(move |e| e.is(name))
    }

    pub fn child(&self, name: &str) -> Option<&Element> {
        self.elements().find(|e| e.is(name))
    }

    /// First descendant (pre-order, excluding `self`) satisfying `pred`.
    pub fn find(&self, pred: &dyn Fn(&Element) -> bool) -> Option<&Element> {
        for e in self.elements() {
            if pred(e) {
                return Some(e);
            }
            if let Some(found) = e.find(pred) {
                return Some(found);
            }
        }
        None
    }

    pub fn find_named(&self, name: &str) -> Option<&Element> {
        self.find(&|e| e.is(name))
    }

    /// All descendants named `name`, in document order.
    pub fn all_named<'a>(&'a self, name: &str, out: &mut Vec<&'a Element>) {
        for e in self.elements() {
            if e.is(name) {
                out.push(e);
            }
            e.all_named(name, out);
        }
    }

    /// Concatenated descendant text, whitespace collapsed.
    pub fn text(&self) -> String {
        let mut raw = String::new();
        self.raw_text(&mut raw);
        collapse_ws(&raw)
    }

    fn raw_text(&self, out: &mut String) {
        for n in &self.children {
            match n {
                Node::Text(t) => out.push_str(t),
                Node::Element(e) => e.raw_text(out),
            }
        }
    }
}

fn element_of(start: &BytesStart<'_>) -> Element {
    let mut attrs = Vec::new();
    let mut it = start.attributes();
    it.with_checks(false);
    for a in it.flatten() {
        attrs.push((a.key.0.to_owned(), decode_entities(&a.value).into_owned()));
    }
    Element {
        name: start.name().0.to_owned(),
        attrs,
        children: Vec::new(),
    }
}

fn push_text(parent: &mut Element, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Node::Text(t)) = parent.children.last_mut() {
        t.push_str(text);
    } else {
        parent.children.push(Node::Text(text.to_owned()));
    }
}

/// Parses a document into a tree under a synthetic root. Tolerant: end tags may mismatch (they
/// close up to the matching open element or are ignored), unknown entities stay literal, the
/// document is closed at EOF. Hard syntax errors and depth > 256 are `Err` (English detail).
pub(crate) fn parse_tree(text: &str) -> Result<Element, String> {
    let mut reader = Reader::from_str(text);
    {
        let cfg = reader.config_mut();
        cfg.check_end_names = false;
        cfg.allow_unmatched_ends = true;
        cfg.allow_dangling_amp = true;
    }
    let mut stack: Vec<Element> = vec![Element {
        name: "#document".into(),
        ..Default::default()
    }];
    loop {
        let event = reader.read_event().map_err(|e| format!("xml: {e}"))?;
        match event {
            Event::Start(s) => {
                if stack.len() > MAX_DEPTH {
                    return Err("xml: too deep".into());
                }
                stack.push(element_of(&s));
            }
            Event::Empty(s) => {
                let el = element_of(&s);
                if let Some(top) = stack.last_mut() {
                    top.children.push(Node::Element(el));
                }
            }
            Event::End(e) => {
                let name = e.name().0;
                if let Some(pos) = stack
                    .iter()
                    .skip(1)
                    .rposition(|el| el.name.eq_ignore_ascii_case(name))
                {
                    let pos = pos + 1;
                    while stack.len() > pos {
                        close_top(&mut stack);
                    }
                }
            }
            Event::Text(t) => {
                if let Some(top) = stack.last_mut() {
                    push_text(top, &decode_entities(&t.xml10_content()));
                }
            }
            Event::CData(t) => {
                if let Some(top) = stack.last_mut() {
                    push_text(top, &t.xml10_content());
                }
            }
            Event::GeneralRef(r) => {
                let name = r.into_inner();
                let value = resolve_entity(&name)
                    .map(Cow::into_owned)
                    .unwrap_or_else(|| format!("&{name};"));
                if let Some(top) = stack.last_mut() {
                    push_text(top, &value);
                }
            }
            Event::Eof => break,
            Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => {}
        }
    }
    while stack.len() > 1 {
        close_top(&mut stack);
    }
    stack.pop().ok_or_else(|| "xml: empty stack".to_owned())
}

fn close_top(stack: &mut Vec<Element>) {
    if let Some(el) = stack.pop()
        && let Some(parent) = stack.last_mut()
    {
        parent.children.push(Node::Element(el));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities() {
        assert_eq!(
            decode_entities("a &amp; b &lt;c&gt; &#233;&#xE9;&eacute; &bogus; & x"),
            "a & b <c> ééé &bogus; & x"
        );
        assert_eq!(decode_entities("&#0;&#xFFFFFFF;"), "\u{FFFD}\u{FFFD}");
        assert_eq!(decode_entities("&mdash;&hellip;&nbsp;"), "—…\u{A0}");
    }

    #[test]
    fn encodings() {
        assert_eq!(decode_document(b"\xEF\xBB\xBFol\xC3\xA1"), "olá");
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("<p>é</p>".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode_document(&utf16), "<p>é</p>");
        let be: Vec<u8> = "<p>é</p>"
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect();
        assert_eq!(decode_document(&be), "<p>é</p>");
        let cp1252 = b"<?xml version=\"1.0\" encoding=\"windows-1252\"?><p>caf\xE9 \x93q\x94</p>";
        assert_eq!(
            decode_document(cp1252),
            "<?xml version=\"1.0\" encoding=\"windows-1252\"?><p>café “q”</p>"
        );
        let meta = b"<html><head><meta charset=iso-8859-1></head><p>\xE7</p>";
        assert!(decode_document(meta).contains("<p>ç</p>"));
        assert_eq!(decode_document(b"a\xFFb"), "a\u{FFFD}b");
    }

    #[test]
    fn tolerant_tree() {
        let t = parse_tree("<a x='1&amp;2'><b>one<c>two</b>three</a><d/>").unwrap();
        let a = t.child("a").unwrap();
        assert_eq!(a.attr("x"), Some("1&2"));
        assert_eq!(a.text(), "onetwothree");
        assert!(t.child("d").is_some());
        let t = parse_tree("<p>&nbsp;x&unknown;</p>").unwrap();
        assert_eq!(t.child("p").unwrap().text(), "x&unknown;");
        assert!(parse_tree("<a <<<").is_err() || parse_tree("<a <<<").is_ok());
    }

    #[test]
    fn collapse() {
        assert_eq!(collapse_ws("  a \u{A0}\n b\u{AD}c  "), "a bc");
    }
}
