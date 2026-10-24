//! Book text cleanup (spec 12.3 B) and words/sentences (C).

use std::collections::{HashMap, HashSet};

use unicode_segmentation::UnicodeSegmentation;

/// The text of one unit of the book (a PDF page or an EPUB spine section). `unit` is 0-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageInput<'a> {
    pub unit: u32,
    pub text: &'a str,
}

/// A cleaned unit: hyphenated breaks joined, repeated headers/footers, page numbers, URLs and e-mails removed,
/// typographic apostrophes normalized, line breaks inside paragraphs turned into spaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanPage {
    pub unit: u32,
    pub text: String,
}

/// A line is a header/footer when (digits normalized) it is on more than this share of the pages.
const REPEATED_SHARE: f64 = 0.30;
/// …and only in books with at least this many pages.
const REPEATED_MIN_PAGES: usize = 5;
/// Longest line considered as a header/footer, in chars.
const REPEATED_MAX_CHARS: usize = 120;

fn normalize_apostrophes(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{2019}' | '\u{2018}' | '\u{02BC}' | '\u{FF07}' => '\'',
            '\r' => '\n',
            '\u{00AD}' => '\u{0}', // soft hyphen: removed below
            c => c,
        })
        .filter(|c| *c != '\u{0}')
        .collect()
}

fn line_key(line: &str) -> String {
    let mut key = String::with_capacity(line.len());
    let mut last_space = false;
    for c in line.trim().chars() {
        if c.is_ascii_digit() {
            if !key.ends_with('#') {
                key.push('#');
            }
            last_space = false;
        } else if c.is_whitespace() {
            if !last_space {
                key.push(' ');
            }
            last_space = true;
        } else {
            key.extend(c.to_lowercase());
            last_space = false;
        }
    }
    key
}

/// Page-number-only lines: "12", "- 12 -", "Page 12", "12 / 300", "xii".
fn is_page_number_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    let lower = t.to_lowercase();
    let body = lower
        .strip_prefix("page")
        .or_else(|| lower.strip_prefix("página"))
        .or_else(|| lower.strip_prefix("p."))
        .unwrap_or(&lower)
        .trim();
    if !body.is_empty()
        && body
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_whitespace() || "-–—/|.·•()[]".contains(c))
        && body.chars().any(|c| c.is_ascii_digit())
    {
        return true;
    }
    // Lowercase roman numerals alone (front matter numbering).
    t.len() <= 8 && t.chars().all(|c| "ivxlc".contains(c)) && is_roman(&t.to_uppercase())
}

/// A valid roman numeral (uppercase), e.g. "XIV"; "CIVIL" is not.
pub(crate) fn is_roman(s: &str) -> bool {
    if s.is_empty() || !s.chars().all(|c| "IVXLCDM".contains(c)) {
        return false;
    }
    let b = s.as_bytes();
    let mut i = 0;
    let mut take = |pats: &[&str]| {
        for p in pats {
            if b[i..].starts_with(p.as_bytes()) {
                i += p.len();
                return;
            }
        }
    };
    take(&["MMM", "MM", "M"]);
    take(&["CM", "CD", "DCCC", "DCC", "DC", "D", "CCC", "CC", "C"]);
    take(&["XC", "XL", "LXXX", "LXX", "LX", "L", "XXX", "XX", "X"]);
    take(&["IX", "IV", "VIII", "VII", "VI", "V", "III", "II", "I"]);
    i == b.len()
}

/// A whitespace-free piece of a line that is a URL or an e-mail address (removed by the cleanup).
fn is_url_or_email(piece: &str) -> bool {
    let lower = piece.to_ascii_lowercase();
    let trimmed = piece.trim_matches(|c: char| !c.is_alphanumeric());
    let url = lower.contains("://")
        || lower
            .trim_start_matches(['(', '<', '"', '\''])
            .starts_with("www.");
    let mut parts = trimmed.split('@');
    let email = matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(a), Some(d), None) if !a.is_empty() && d.contains('.') && !d.starts_with('.')
    );
    url || email
}

fn remove_urls_and_emails(line: &str) -> String {
    line.split(' ')
        .filter(|piece| !is_url_or_email(piece))
        .collect::<Vec<_>>()
        .join(" ")
}

fn word_count(s: &str) -> usize {
    s.unicode_words().count()
}

/// The keys (see `line_key`) of the header/footer lines repeated on more than [`REPEATED_SHARE`] of the units.
fn repeated_keys(normalized: &[String]) -> HashSet<String> {
    if normalized.len() < REPEATED_MIN_PAGES {
        return HashSet::new();
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for text in normalized {
        let mut seen: HashSet<String> = HashSet::new();
        for line in text.lines() {
            let t = line.trim();
            if t.is_empty() || t.chars().count() > REPEATED_MAX_CHARS {
                continue;
            }
            let key = line_key(t);
            if seen.insert(key.clone()) {
                *counts.entry(key).or_default() += 1;
            }
        }
    }
    let limit = REPEATED_SHARE * normalized.len() as f64;
    counts
        .into_iter()
        .filter(|(_, n)| (*n as f64) > limit)
        .map(|(k, _)| k)
        .collect()
}

/// The repeated header/footer lines of a book (as normalized keys, sorted) that [`clean_pages`] removes. Stored
/// with the lemma table so the highlight can skip them without re-reading the book ([`noise_spans`]).
pub fn repeated_lines(pages: &[PageInput]) -> Vec<String> {
    let normalized: Vec<String> = pages
        .iter()
        .map(|p| normalize_apostrophes(p.text))
        .collect();
    let mut keys: Vec<String> = repeated_keys(&normalized).into_iter().collect();
    keys.sort();
    keys
}

/// The parts of a page's raw text that [`clean_pages`] drops — page-number lines, the book's `repeated` lines
/// (from [`repeated_lines`]), URLs and e-mails — as UTF-16 ranges `[start, end)` of `text`, in order. Words
/// inside them aren't counted by the scan, so they get no highlight either.
pub fn noise_spans(text: &str, repeated: &HashSet<String>) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    for raw in text.split(['\n', '\r']) {
        let len = utf16_len(raw) as usize;
        let line = normalize_apostrophes(raw);
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty()
            && (is_page_number_line(&collapsed) || repeated.contains(&line_key(&collapsed)))
        {
            out.push((offset, offset + len));
        } else {
            // (byte, UTF-16 offset) where the current whitespace-free piece starts.
            let mut piece: Option<(usize, usize)> = None;
            let mut at = offset;
            for (b, c) in raw.char_indices().chain(std::iter::once((raw.len(), ' '))) {
                if c.is_whitespace() {
                    if let Some((pb, pu)) = piece.take()
                        && is_url_or_email(&normalize_apostrophes(&raw[pb..b]))
                    {
                        out.push((pu, at));
                    }
                } else if piece.is_none() {
                    piece = Some((b, at));
                }
                at += c.len_utf16();
            }
        }
        offset += len + 1;
    }
    out
}

/// Cleans the units of a book (spec 12.3 B). Never panics; works for any number of pages.
pub fn clean_pages(pages: &[PageInput]) -> Vec<CleanPage> {
    clean_pages_with(pages, true)
}

/// [`clean_pages`], optionally keeping repeated lines (`strip_repeated = false`: EPUB sections have no running
/// headers or footers, and a line repeated across short sections is real text).
pub(crate) fn clean_pages_with(pages: &[PageInput], strip_repeated: bool) -> Vec<CleanPage> {
    let normalized: Vec<String> = pages
        .iter()
        .map(|p| normalize_apostrophes(p.text))
        .collect();
    let repeated = if strip_repeated {
        repeated_keys(&normalized)
    } else {
        HashSet::new()
    };
    pages
        .iter()
        .zip(normalized)
        .map(|(p, text)| {
            let lines: Vec<String> = text
                .lines()
                .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|l| {
                    !l.is_empty() && !is_page_number_line(l) && !repeated.contains(&line_key(l))
                })
                .map(|l| remove_urls_and_emails(&l))
                .filter(|l| !l.trim().is_empty())
                .collect();
            CleanPage {
                unit: p.unit,
                text: join_lines(&lines),
            }
        })
        .collect()
}

/// Joins lines: "exam-" + "ple" → "example"; short lines without final punctuation followed by a capitalized line
/// (headings) keep a line break (a sentence boundary); other breaks become spaces.
fn join_lines(lines: &[String]) -> String {
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if i == 0 {
            out.push_str(line);
            continue;
        }
        let prev = &lines[i - 1];
        let next_first = line.chars().next().unwrap_or(' ');
        let mut prev_chars = prev.chars().rev();
        let last = prev_chars.next().unwrap_or(' ');
        let before = prev_chars.next().unwrap_or(' ');
        if last == '-' && before.is_alphabetic() && next_first.is_lowercase() {
            out.pop();
            out.push_str(line);
            continue;
        }
        let heading = word_count(prev) <= 8 && is_title_like(prev) && !",;-—–".contains(last);
        if heading && next_first.is_uppercase() {
            out.push('\n');
        } else {
            out.push(' ');
        }
        out.push_str(line);
    }
    out
}

/// "Chapter One", "PART II", "The Windmill": every word capitalized or a short function word.
fn is_title_like(line: &str) -> bool {
    line.unicode_words().all(|w| {
        w.chars()
            .next()
            .is_some_and(|c| c.is_uppercase() || c.is_ascii_digit())
            || matches!(
                w,
                "of" | "the" | "a" | "an" | "and" | "in" | "on" | "to" | "for"
            )
    })
}

/// A word of the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Token {
    /// The word in its original spelling, without contraction pieces or possessive ("Napoleon", "do").
    pub text: String,
    /// Byte range of `text` in the cleaned page.
    pub start: usize,
    pub end: usize,
    /// Index of the sentence in the page.
    pub sentence: usize,
    /// First word of its sentence.
    pub initial: bool,
}

/// A sentence of a cleaned page: byte range and number of words (UAX #29, numbers included).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Sentence {
    pub start: usize,
    pub end: usize,
    pub words: usize,
}

/// Normalizes one UAX #29 word into a token text: `None` for numbers, words without letters, roman numerals in
/// capitals and contraction pieces; strips `n't`, `'s`, `'ll`, `'re`, `'ve`, `'d`, `'m` and possessives.
/// Returns the kept text and its byte length from the start of the word.
pub(crate) fn token_text(word: &str) -> Option<(String, usize)> {
    if word.is_empty() || word.chars().any(|c| c.is_ascii_digit() || c.is_numeric()) {
        return None;
    }
    if !word.chars().any(char::is_alphabetic) {
        return None;
    }
    let w = word.trim_start_matches('\'');
    let offset = word.len() - w.len();
    let lw = w.to_lowercase();
    if lw == "n't"
        || (offset > 0 && matches!(lw.as_str(), "s" | "ll" | "re" | "ve" | "d" | "m" | "t"))
    {
        return None;
    }
    let mut base = w.trim_end_matches('\'');
    let lower = base.to_lowercase();
    if lower.ends_with("n't") && base.len() > 3 {
        base = &base[..base.len() - 3];
        let special = match base.to_lowercase().as_str() {
            "ca" => Some("can"),
            "wo" => Some("will"),
            "sha" => Some("shall"),
            "ai" => Some("be"),
            _ => None,
        };
        if let Some(s) = special {
            // Keep the case of the first letter ("Can't" → "Can").
            let s = if base.chars().next().is_some_and(char::is_uppercase) {
                let mut c = s.chars();
                c.next()
                    .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                    .unwrap_or_default()
            } else {
                s.to_string()
            };
            return Some((s, offset + base.len()));
        }
    } else if let Some(i) = base.find('\'') {
        let suffix = base[i + 1..].to_lowercase();
        if matches!(suffix.as_str(), "s" | "ll" | "re" | "ve" | "d" | "m") {
            base = &base[..i];
        }
    }
    if base.is_empty() || !base.chars().any(char::is_alphabetic) {
        return None;
    }
    if base.len() >= 2 && is_roman(base) {
        return None;
    }
    if base.chars().count() > crate::MAX_WORD_CHARS {
        return None;
    }
    Some((base.to_string(), offset + base.len()))
}

/// Sentences and tokens of a cleaned page.
pub(crate) fn tokenize(text: &str) -> (Vec<Sentence>, Vec<Token>) {
    let mut sentences = Vec::new();
    let mut tokens = Vec::new();
    for (s_start, sent) in text.split_sentence_bound_indices() {
        let idx = sentences.len();
        let mut words = 0;
        let mut first = true;
        for (w_start, word) in sent.unicode_word_indices() {
            words += 1;
            let has_letter = word.chars().any(char::is_alphabetic);
            let initial = first && has_letter;
            if has_letter {
                first = false;
            }
            if let Some((t, len)) = token_text(word) {
                let start = s_start + w_start + (word.len() - word.trim_start_matches('\'').len());
                tokens.push(Token {
                    text: t,
                    start,
                    end: (s_start + w_start + len).max(start),
                    sentence: idx,
                    initial,
                });
            }
        }
        sentences.push(Sentence {
            start: s_start,
            end: s_start + sent.len(),
            words,
        });
    }
    (sentences, tokens)
}

/// Whether the word starts with an uppercase letter and is not all capitals (headings, acronyms).
pub(crate) fn is_capitalized(word: &str) -> bool {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_uppercase() {
        return false;
    }
    let rest: Vec<char> = chars.filter(|c| c.is_alphabetic()).collect();
    !rest.is_empty() && rest.iter().any(|c| c.is_lowercase())
}

/// UTF-16 length of a string.
pub(crate) fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(texts: &[&str]) -> Vec<CleanPage> {
        let inputs: Vec<PageInput> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| PageInput {
                unit: i as u32,
                text: t,
            })
            .collect();
        clean_pages(&inputs)
    }

    #[test]
    fn joins_hyphens_and_lines() {
        let p = pages(&["An exam-\nple of a sentence that\nwraps. A well-\nKnown thing."]);
        assert_eq!(
            p[0].text,
            "An example of a sentence that wraps. A well- Known thing."
        );
    }

    #[test]
    fn headings_stay_apart() {
        let p = pages(&["Chapter One\nMr. Jones locked the hen-houses."]);
        assert_eq!(p[0].text, "Chapter One\nMr. Jones locked the hen-houses.");
        let (_, toks) = tokenize(&p[0].text);
        let mr = toks.iter().find(|t| t.text == "Mr").expect("Mr");
        assert!(mr.initial);
    }

    #[test]
    fn drops_headers_footers_numbers_urls() {
        let bodies = [
            "Pigs worked hard.",
            "Horses pulled carts.",
            "Sheep bleated loudly.",
            "Dogs barked.",
            "Hens laid eggs.",
            "Cows gave milk.",
            "Rats hid away.",
            "Boxer lifted stones.",
            "Clover watched.",
            "Mollie left.",
        ];
        let mut texts = Vec::new();
        for (i, b) in bodies.iter().enumerate() {
            let extra = if i == 0 {
                "\nSee https://example.com/x or write to a@b.org now."
            } else {
                ""
            };
            texts.push(format!(
                "ANIMAL FARM\n{b}{extra}\n{}\nChapter {} of the book",
                i + 1,
                i + 3
            ));
        }
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let p = pages(&refs);
        assert_eq!(p[0].text, "Pigs worked hard. See or write to now.");
        assert_eq!(p[3].text, "Dogs barked.");
        // Fewer than 5 pages: nothing is "repeated".
        let p = pages(&["ANIMAL FARM\nHello there.", "ANIMAL FARM\nHello again."]);
        assert!(p[0].text.starts_with("ANIMAL FARM"));
    }

    #[test]
    fn contractions_and_numbers() {
        let words: Vec<Option<String>> = [
            "don't",
            "Can't",
            "won't",
            "Napoleon's",
            "they'll",
            "I'm",
            "we've",
            "o'clock",
            "1984",
            "3rd",
            "XIV",
            "CIVIL",
            "I",
            "'em",
            "n't",
            "''",
        ]
        .iter()
        .map(|w| token_text(w).map(|(t, _)| t))
        .collect();
        let want: Vec<Option<&str>> = vec![
            Some("do"),
            Some("Can"),
            Some("will"),
            Some("Napoleon"),
            Some("they"),
            Some("I"),
            Some("we"),
            Some("o'clock"),
            None,
            None,
            None,
            Some("CIVIL"),
            Some("I"),
            Some("em"),
            None,
            None,
        ];
        let got: Vec<Option<&str>> = words.iter().map(|w| w.as_deref()).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn roman() {
        for r in ["II", "IV", "XIV", "MCMLXXXIV", "XL", "C"] {
            assert!(is_roman(r), "{r}");
        }
        for r in ["CIVIL", "MIM", "IIII", "", "ABC", "DID"] {
            assert!(!is_roman(r), "{r}");
        }
    }

    #[test]
    fn tokens_have_offsets() {
        let text = "“Comrades,” said Napoleon's dog. It isn't done.";
        let (sents, toks) = tokenize(text);
        assert_eq!(sents.len(), 2);
        for t in &toks {
            assert_eq!(&text[t.start..t.end], t.text, "{t:?}");
        }
        assert!(toks[0].initial);
        assert!(!toks[1].initial);
    }

    #[test]
    fn odd_pages_never_panic() {
        let long = "a".repeat(100_000);
        let odd = [
            "",
            "\n\n\n",
            "-\n-",
            "é-\nb",
            "\u{AD}",
            "’’’",
            "@@@ . . .",
            "http://",
            "x@y",
            long.as_str(),
            "🐷-\nok",
            "\u{301}\u{301}",
            "I\nII\nIII",
        ];
        let p = pages(&odd);
        for c in &p {
            let _ = tokenize(&c.text);
        }
    }

    #[test]
    fn noise_spans_cover_what_the_cleanup_drops() {
        let bodies = [
            "The pigs met.",
            "Boxer worked.",
            "Snowball ran.",
            "The sheep bleated.",
            "Night fell.",
            "Rain came.",
        ];
        let texts: Vec<String> = (1..=6)
            .map(|n| format!("ANIMAL FARM \u{2019}{n}\n{}\nPage {n}", bodies[n - 1]))
            .collect();
        let inputs: Vec<PageInput> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| PageInput {
                unit: i as u32,
                text: t,
            })
            .collect();
        let repeated: HashSet<String> = repeated_lines(&inputs).into_iter().collect();
        assert!(repeated.contains("animal farm '#"), "{repeated:?}");
        let text = "ANIMAL FARM \u{2019}2\nThe pigs see www.x.org and a@b.com now.\nPage 2";
        let spans = noise_spans(text, &repeated);
        let units: Vec<u16> = text.encode_utf16().collect();
        let pieces: Vec<String> = spans
            .iter()
            .map(|&(a, b)| String::from_utf16_lossy(&units[a..b.min(units.len())]))
            .collect();
        assert_eq!(
            pieces,
            vec!["ANIMAL FARM \u{2019}2", "www.x.org", "a@b.com", "Page 2"]
        );
        // The cleanup keeps exactly the rest.
        let clean = clean_pages(&inputs);
        assert_eq!(clean[1].text, "Boxer worked.");
        // No repeated lines in short books; odd text never panics.
        assert!(repeated_lines(&inputs[..2]).is_empty());
        for odd in ["", "\n\r\n", "\u{2019}", "é\u{1F600} x@y.z"] {
            let _ = noise_spans(odd, &repeated);
        }
    }
}
