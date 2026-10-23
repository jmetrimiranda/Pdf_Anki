//! Code inside Anki fields (spec 11.1). Fields are HTML: writing escapes `&`, `<`, `>` and turns
//! line breaks into `<br>`; reading turns `<br>`/`<div>`/`<p>` back into line breaks, drops the other
//! tags and unescapes the entities.
//!
//! This is a byte-for-byte port of `web/src/features/anki/editor/codeField.ts` (the regexes are
//! hand-written scanners with the same semantics), so a field written by the web editor reads the
//! same here and vice versa. Both sides run `tests/fixtures/code_html_vectors.json`.
//!
//! One documented difference: a numeric entity naming a lone surrogate (`&#xD800;`) stays literal
//! here (a Rust `String` cannot hold it), while JavaScript would produce the lone surrogate.

/// Plain text → field HTML: CRLF/CR → LF, escape `&`, `<`, `>`, then `\n` → `<br>`.
///
/// `html_to_code(&code_to_html(s)) == s` for every `s` without CR.
pub fn code_to_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str("<br>");
            }
            '\n' => out.push_str("<br>"),
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

/// Prose (a Pergunta or an Observação from the Markdown importer) → field HTML: the blank lines
/// around it are dropped, the rest is escaped like [`code_to_html`].
pub fn prose_to_html(text: &str) -> String {
    let normalized = normalize_newlines(text);
    code_to_html(normalized.trim_matches('\n'))
}

/// Field HTML → plain text. Also reads fields written by Anki's editor, which wraps lines in
/// `<div>` and writes runs of spaces as `&nbsp;`.
pub fn html_to_code(html: &str) -> String {
    let s = normalize_newlines(html);
    let s = collapse_empty_div_lines(&s);
    let mut out = String::with_capacity(s.len());
    let mut seen = false;
    let mut last_was_br = false;
    let mut text_start = 0;
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let Some(tag) = match_tag(&s, i) else {
            i += 1;
            continue;
        };
        let text = &s[text_start..i];
        if !text.is_empty() {
            out.push_str(text);
            seen = true;
            last_was_br = false;
        }
        let name = tag.name.to_ascii_lowercase();
        if name == "br" && !tag.closing {
            out.push('\n');
            seen = true;
            last_was_br = true;
        } else if (name == "div" || name == "p") && !tag.closing {
            // A block starts a new line, unless a <br> just ended the previous one.
            if seen && !last_was_br {
                out.push('\n');
            }
            seen = true;
            last_was_br = false;
        }
        // Every other tag (and closing div/p) is dropped; its text stays.
        i = tag.end;
        text_start = i;
    }
    out.push_str(&s[text_start..]);
    unescape_html(&out)
}

fn normalize_newlines(s: &str) -> String {
    if !s.contains('\r') {
        return s.to_owned();
    }
    s.replace("\r\n", "\n").replace('\r', "\n")
}

struct Tag<'a> {
    closing: bool,
    name: &'a str,
    /// Byte index just past the `>`.
    end: usize,
}

/// `/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/i` anchored at `start` (which holds `<`).
fn match_tag(s: &str, start: usize) -> Option<Tag<'_>> {
    let bytes = s.as_bytes();
    let mut i = start + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    if !bytes.get(i)?.is_ascii_alphabetic() {
        return None;
    }
    let name_start = i;
    while bytes.get(i).is_some_and(u8::is_ascii_alphanumeric) {
        i += 1;
    }
    // `\b`: the name is followed by a non-word character (or the end). Backtracking into the name
    // never helps, since a shorter name is followed by an alphanumeric (a word character).
    if bytes.get(i) == Some(&b'_') {
        return None;
    }
    let name = &s[name_start..i];
    let close = s[i..].find('>')?;
    Some(Tag {
        closing,
        name,
        end: i + close + 1,
    })
}

/// `s.replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, '<div></div>')`: Anki's editor writes an empty
/// line as `<div><br></div>`.
fn collapse_empty_div_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('<') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        if let Some(len) = match_empty_div_line(tail) {
            out.push_str("<div></div>");
            rest = &tail[len..];
        } else {
            out.push('<');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

fn match_empty_div_line(s: &str) -> Option<usize> {
    let mut i = eat_ci(s, 0, "<div>")?;
    i = skip_js_space(s, i);
    i = eat_ci(s, i, "<br")?;
    i = skip_js_space(s, i);
    if s[i..].starts_with('/') {
        i += 1;
    }
    i = eat_ci(s, i, ">")?;
    i = skip_js_space(s, i);
    eat_ci(s, i, "</div>")
}

fn eat_ci(s: &str, at: usize, lit: &str) -> Option<usize> {
    let end = at + lit.len();
    let part = s.as_bytes().get(at..end)?;
    part.eq_ignore_ascii_case(lit.as_bytes()).then_some(end)
}

fn skip_js_space(s: &str, mut at: usize) -> usize {
    while let Some(c) = s[at..].chars().next() {
        if !is_js_space(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}

/// JavaScript's `\s`: WhiteSpace and LineTerminator of ECMAScript.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// One pass over `/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi`, so `&amp;lt;` becomes `&lt;` (not `<`).
/// Unknown names and out-of-range numbers stay as written.
fn unescape_html(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        match match_entity(tail) {
            Some((len, replacement)) => {
                match replacement {
                    Some(c) => out.push(c),
                    None => out.push_str(&tail[..len]),
                }
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Matches an entity at the start of `s` (which holds `&`): its length and the character it
/// stands for (`None`: a well-formed but unknown entity, kept as is).
fn match_entity(s: &str) -> Option<(usize, Option<char>)> {
    let b = s.as_bytes();
    if b.get(1) == Some(&b'#') {
        // `#x[0-9a-f]+;`
        if matches!(b.get(2), Some(b'x' | b'X')) {
            let digits = run(b, 3, u8::is_ascii_hexdigit);
            if digits > 0 && b.get(3 + digits) == Some(&b';') {
                let len = 3 + digits + 1;
                return Some((len, numeric_char(&s[3..3 + digits], 16)));
            }
        }
        // `#\d+;`
        let digits = run(b, 2, u8::is_ascii_digit);
        if digits > 0 && b.get(2 + digits) == Some(&b';') {
            let len = 2 + digits + 1;
            return Some((len, numeric_char(&s[2..2 + digits], 10)));
        }
        return None;
    }
    // `[a-z]+;`
    let letters = run(b, 1, u8::is_ascii_alphabetic);
    if letters == 0 || b.get(1 + letters) != Some(&b';') {
        return None;
    }
    let name = s[1..1 + letters].to_ascii_lowercase();
    let c = match name.as_str() {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        // The rich editor writes &nbsp; for runs of spaces; in code they are plain spaces.
        "nbsp" => ' ',
        _ => return Some((1 + letters + 1, None)),
    };
    Some((1 + letters + 1, Some(c)))
}

fn run(b: &[u8], from: usize, pred: fn(&u8) -> bool) -> usize {
    b.get(from..)
        .map_or(0, |rest| rest.iter().take_while(|c| pred(c)).count())
}

/// `parseInt` + `0 < code <= 0x10FFFF` + `String.fromCodePoint`.
fn numeric_char(digits: &str, radix: u32) -> Option<char> {
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() || digits.len() > 8 {
        return None;
    }
    let code = u32::from_str_radix(digits, radix).ok()?;
    if code == 0 || code > 0x10FFFF {
        return None;
    }
    char::from_u32(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_and_breaks_lines() {
        assert_eq!(
            code_to_html("a < b & c > d\nnext"),
            "a &lt; b &amp; c &gt; d<br>next"
        );
        assert_eq!(code_to_html("x\r\ny\rz"), "x<br>y<br>z");
    }

    #[test]
    fn reads_anki_editor_shapes() {
        assert_eq!(
            html_to_code("<div>ros2 run turtlesim</div><div>turtlesim_node</div>"),
            "ros2 run turtlesim\nturtlesim_node"
        );
        assert_eq!(
            html_to_code("<div>a</div><div><br></div><div>b</div>"),
            "a\n\nb"
        );
        assert_eq!(html_to_code("first<div>second</div>"), "first\nsecond");
        assert_eq!(html_to_code("a&nbsp;&nbsp;b<br/>c<br />d"), "a  b\nc\nd");
        assert_eq!(html_to_code("<b>bold</b> &#60;tag&#x3E;"), "bold <tag>");
    }

    #[test]
    fn entities_edge_cases() {
        assert_eq!(html_to_code("&amp;lt;"), "&lt;");
        assert_eq!(html_to_code("&AMP; &Lt;"), "& <");
        assert_eq!(
            html_to_code("&foo; & &; &#; &#x; &#0; &#x110000;"),
            "&foo; & &; &#; &#x; &#0; &#x110000;"
        );
        assert_eq!(html_to_code("&#0000065;&#x000041;"), "AA");
        assert_eq!(
            html_to_code("&#99999999999999999999;"),
            "&#99999999999999999999;"
        );
        assert_eq!(html_to_code("&#xD800;"), "&#xD800;");
        assert_eq!(html_to_code("&&amp;"), "&&");
        assert_eq!(html_to_code("&am<b>p;"), "&");
    }

    #[test]
    fn tags_edge_cases() {
        assert_eq!(html_to_code("a <not_a_tag> b"), "a <not_a_tag> b");
        assert_eq!(html_to_code("a < b"), "a < b");
        assert_eq!(html_to_code("x<1>"), "x<1>");
        assert_eq!(html_to_code("<span\nclass=x>t</span>"), "t");
        assert_eq!(html_to_code("<DIV>a</DIV><P>b</P>"), "a\nb");
        assert_eq!(html_to_code("<div> <BR /> </div>x"), "x");
        assert_eq!(html_to_code("a<br><div>b</div>"), "a\nb");
        assert_eq!(html_to_code("<brx>"), "");
        assert_eq!(html_to_code("<br"), "<br");
        assert_eq!(html_to_code("é<div>ç</div>"), "é\nç");
    }

    #[test]
    fn prose() {
        assert_eq!(
            prose_to_html("\n Olá <b>\nmundo\n\n"),
            " Olá &lt;b&gt;<br>mundo"
        );
    }
}
