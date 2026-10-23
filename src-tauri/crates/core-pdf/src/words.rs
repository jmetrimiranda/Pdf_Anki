//! Words with rects from PdfCraft's text layer (UAX #29 segmentation mapped back to glyphs).

use std::ops::Range;

use pdfcraft_render::PageText;
use unicode_segmentation::UnicodeSegmentation;

use crate::types::{PageWord, Rect};

/// The page text (identical to `PageText::plain_text`) with, per byte, the glyph that produced it
/// (`None` for the separators PdfCraft inserts).
struct OwnedText {
    text: String,
    owner: Vec<Option<usize>>,
}

impl OwnedText {
    fn new(pt: &PageText) -> Self {
        let mut text = String::new();
        let mut owner = Vec::new();
        let mut prev_line = None;
        for (i, g) in pt.glyphs.iter().enumerate() {
            let line = pt.line_of.get(i).copied();
            if i > 0 {
                let sep = if prev_line != line {
                    Some('\n')
                } else if pt.space_before.get(i).copied().unwrap_or(false) {
                    Some(' ')
                } else {
                    None
                };
                if let Some(c) = sep {
                    text.push(c);
                    owner.push(None);
                }
            }
            text.push_str(&g.text);
            owner.resize(text.len(), Some(i));
            prev_line = line;
        }
        Self { text, owner }
    }
}

fn to_xywh(r: [f32; 4]) -> Rect {
    [r[0], r[1], r[2] - r[0], r[3] - r[1]]
}

fn glyph_rects(pt: &PageText, glyphs: Range<usize>) -> Vec<Rect> {
    pt.line_rects(glyphs).into_iter().map(to_xywh).collect()
}

/// Segments the page text into UAX #29 words that hold a letter or digit, each with its UTF-16
/// offsets in the text (what JS `text.slice(start, end)` expects) and its rects.
pub(crate) fn page_words(pt: &PageText) -> (String, Vec<PageWord>) {
    let owned = OwnedText::new(pt);
    let mut words = Vec::new();
    // Byte → UTF-16 offset, advanced incrementally since words come in order.
    let (mut byte, mut units) = (0usize, 0usize);
    for (b, w) in owned.text.unicode_word_indices() {
        units += utf16_len(&owned.text[byte..b]);
        byte = b;
        let span = &owned.owner[b..b + w.len()];
        let (Some(first), Some(last)) = (
            span.iter().find_map(|o| *o),
            span.iter().rev().find_map(|o| *o),
        ) else {
            continue;
        };
        words.push(PageWord {
            index: words.len(),
            text: w.to_owned(),
            start: units,
            end: units + utf16_len(w),
            rects: glyph_rects(pt, first..last + 1),
        });
    }
    (owned.text, words)
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pdfcraft_render::TextGlyph;

    fn glyph(text: &str, x: f32, y: f32) -> TextGlyph {
        TextGlyph {
            text: text.into(),
            rect: [x, y, x + 5.0, y + 10.0],
            quad: [[x, y + 10.0], [x + 5.0, y + 10.0], [x + 5.0, y], [x, y]],
            direction: [1.0, 0.0],
        }
    }

    /// "Olá, mundo!" on line 0 and "ﬁm 2" (a ligature glyph) on line 1.
    fn sample() -> PageText {
        let mut glyphs = Vec::new();
        let (mut line_of, mut space_before) = (Vec::new(), Vec::new());
        let mut x = 0.0;
        for (t, line, space) in [
            ("O", 0, false),
            ("l", 0, false),
            ("á", 0, false),
            (",", 0, false),
            ("m", 0, true),
            ("u", 0, false),
            ("n", 0, false),
            ("d", 0, false),
            ("o", 0, false),
            ("!", 0, false),
            ("fi", 1, false),
            ("m", 1, false),
            ("2", 1, true),
        ] {
            if line == 1 && line_of.last() == Some(&0) {
                x = 0.0;
            }
            glyphs.push(glyph(t, x, line as f32 * 20.0));
            line_of.push(line);
            space_before.push(space);
            x += if space { 10.0 } else { 5.0 };
        }
        PageText {
            glyphs,
            line_of,
            space_before,
        }
    }

    #[test]
    fn text_matches_pdfcraft_plain_text() {
        let pt = sample();
        let (text, _) = page_words(&pt);
        assert_eq!(text, pt.plain_text());
        assert_eq!(text, "Olá, mundo!\nfim 2");
    }

    /// JS `text.slice(start, end)`, which counts UTF-16 code units.
    fn js_slice(text: &str, start: usize, end: usize) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16_lossy(&units[start..end])
    }

    #[test]
    fn offsets_are_utf16_after_astral_glyphs() {
        // Math italic x (U+1D465) is two UTF-16 units.
        let mut glyphs = Vec::new();
        let (mut line_of, mut space_before) = (Vec::new(), Vec::new());
        for (i, (t, space)) in [("𝑥", false), ("=", true), ("v", true), ("é", false)]
            .into_iter()
            .enumerate()
        {
            glyphs.push(glyph(t, i as f32 * 10.0, 0.0));
            line_of.push(0);
            space_before.push(space);
        }
        let pt = PageText {
            glyphs,
            line_of,
            space_before,
        };
        let (text, words) = page_words(&pt);
        assert_eq!(text, "𝑥 = vé");
        let got: Vec<_> = words
            .iter()
            .map(|w| (w.text.as_str(), w.start, w.end))
            .collect();
        assert_eq!(got, [("𝑥", 0, 2), ("vé", 5, 7)]);
        for w in &words {
            assert_eq!(js_slice(&text, w.start, w.end), w.text);
        }
    }

    #[test]
    fn words_have_char_offsets_and_rects() {
        let pt = sample();
        let (text, words) = page_words(&pt);
        let got: Vec<_> = words
            .iter()
            .map(|w| (w.index, w.text.as_str(), w.start, w.end))
            .collect();
        assert_eq!(
            got,
            [
                (0, "Olá", 0, 3),
                (1, "mundo", 5, 10),
                (2, "fim", 12, 15),
                (3, "2", 16, 17)
            ]
        );
        for w in &words {
            assert_eq!(js_slice(&text, w.start, w.end), w.text);
            assert_eq!(w.rects.len(), 1);
        }
        assert_eq!(words[0].rects[0], [0.0, 0.0, 15.0, 10.0]);
    }
}
