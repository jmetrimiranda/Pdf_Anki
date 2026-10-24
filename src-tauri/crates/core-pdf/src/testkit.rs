//! Synthetic scanned PDFs for the OCR tests, examples and bridge fixtures (feature `testkit`; never in the app).
//!
//! [`scanned_pdf`] writes known English text as a normal PDF (Helvetica, Letter), renders each page with
//! PdfCraft's renderer at a scanner-like resolution, turns it into 8-bit grey (optionally with deterministic
//! salt-and-pepper noise) and embeds it as an image-only page: a DeviceGray, FlateDecode image drawn by one `cm`
//! (slightly rotated when asked). The pages carry no text operators, so they "look scanned" (spec 6.6).
//!
//! Test scaffolding: it panics on failure, like the tests that use it.

use std::sync::Arc;

use pdfcraft_render::{PageRenderer, RenderConfig, RenderRequest};
use pdfcraft_testkit::{Pdf, stream_obj};

/// Two pages of plain English prose without accents, with distinctive words ([`SAMPLE_WORDS`]).
pub const SAMPLE_PAGES: &[&str] = &[
    "The farm lay quiet under a pale autumn sky. Every morning the animals gathered near the old barn to hear \
     the plans for the coming week. Napoleon, the largest of the pigs, stood on a wooden crate and spoke about \
     the windmill that would one day bring light and warmth to every stall.\n\n\
     The work was hard and the days were short. The horses pulled heavy stones from the quarry while the hens \
     counted the eggs and the sheep watched the gate. Nobody complained in public, although many wondered \
     whether the harvest would be large enough to last through the long winter.",
    "When the first snow arrived, the windmill was only half built. The pigs explained that the delay was the \
     fault of the weather and of a few lazy workers, and they promised extra rations once the walls were \
     finished.\n\n\
     In spring the fields turned green again and the harvest was gathered in record time. Napoleon announced a \
     great celebration with music and flags, and the animals sang until the stars came out above the orchard \
     and the river.",
];

/// Distinctive words of [`SAMPLE_PAGES`] (each appears on both pages).
pub const SAMPLE_WORDS: &[&str] = &["windmill", "harvest", "Napoleon", "pigs"];

/// How the scan is made.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanOpts {
    /// Scan resolution (pixels per inch).
    pub dpi: u32,
    /// The scan is drawn turned by this many degrees (counter-clockwise) around the page centre.
    pub rotate_deg: f32,
    /// Share of pixels turned black or white at random (salt and pepper), 0..=0.05 is realistic.
    pub noise: f32,
    /// Seed of the noise (the output is deterministic).
    pub seed: u64,
}

impl Default for ScanOpts {
    fn default() -> Self {
        Self {
            dpi: 200,
            rotate_deg: 0.0,
            noise: 0.0,
            seed: 1,
        }
    }
}

const PAGE_W: f32 = 612.0;
const PAGE_H: f32 = 792.0;
const MARGIN: f64 = 72.0;
const FONT_SIZE: f64 = 13.0;
const LEADING: f64 = 19.0;

/// `pages` as a text PDF: Letter pages of Helvetica 13 pt, wrapped inside 1-inch margins (blank lines between
/// paragraphs, which are separated by `\n\n` in the input).
pub fn text_pdf(pages: &[&str]) -> Vec<u8> {
    let n = pages.len().max(1);
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 4 + 2 * i)).collect();
    let mut pdf = Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R >>")
        .obj(format!(
            "<< /Type /Pages /Kids [{}] /Count {n} >>",
            kids.join(" ")
        ))
        .obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    for i in 0..n {
        let text = pages.get(i).copied().unwrap_or("");
        let mut content = format!(
            "BT /F1 {FONT_SIZE} Tf {LEADING} TL {MARGIN} {} Td",
            f64::from(PAGE_H) - MARGIN
        );
        for line in wrap(text, f64::from(PAGE_W) - 2.0 * MARGIN) {
            content.push_str(&format!(" ({}) Tj T*", escape(&line)));
        }
        content.push_str(" ET");
        pdf = pdf
            .obj(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] /Contents {} 0 R \
                 /Resources << /Font << /F1 3 0 R >> >> >>",
                5 + 2 * i
            ))
            .obj(stream_obj("", content.as_bytes()));
    }
    pdf.build()
}

/// `pages` as a scanned (image-only) PDF; see the module docs.
pub fn scanned_pdf(pages: &[&str], opts: &ScanOpts) -> Vec<u8> {
    let text = Arc::new(text_pdf(pages));
    let mut renderer = PageRenderer::new(text, RenderConfig::default());
    let n = pages.len().max(1);
    let scale = opts.dpi.clamp(36, 600) as f32 / 72.0;
    let mut rng = XorShift(opts.seed.max(1));
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 3 + 3 * i)).collect();
    let mut pdf = Pdf::new()
        .obj("<< /Type /Catalog /Pages 2 0 R >>")
        .obj(format!(
            "<< /Type /Pages /Kids [{}] /Count {n} >>",
            kids.join(" ")
        ));
    for i in 0..n {
        let shot = renderer.render(RenderRequest {
            page: i,
            scale,
            ..Default::default()
        });
        assert!(shot.error.is_none(), "render of page {i}: {:?}", shot.error);
        let noise = f64::from(opts.noise.clamp(0.0, 1.0));
        let grey: Vec<u8> = shot
            .rgba
            .chunks_exact(4)
            .map(|p| {
                let y =
                    (u32::from(p[0]) * 299 + u32::from(p[1]) * 587 + u32::from(p[2]) * 114) / 1000;
                if noise > 0.0 && rng.unit() < noise {
                    if rng.next() & 1 == 0 { 0 } else { 255 }
                } else {
                    y as u8
                }
            })
            .collect();
        let image = pdfcraft_cos::Stream::flate(pdfcraft_cos::Dict::new(), &grey);
        let m = placement(opts.rotate_deg);
        let content = format!(
            "q {} {} {} {} {} {} cm /Im0 Do Q",
            m[0], m[1], m[2], m[3], m[4], m[5]
        );
        pdf = pdf
            .obj(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] /Contents {} 0 R \
                 /Resources << /XObject << /Im0 {} 0 R >> >> >>",
                4 + 3 * i,
                5 + 3 * i
            ))
            .obj(stream_obj("", content.as_bytes()))
            .stream(
                &format!(
                    "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceGray \
                     /BitsPerComponent 8 /Filter /FlateDecode",
                    shot.width, shot.height
                ),
                &image.raw[..],
            );
    }
    pdf.build()
}

/// The image's unit square → the page, turned by `deg` around the page centre.
fn placement(deg: f32) -> [f64; 6] {
    let (w, h) = (f64::from(PAGE_W), f64::from(PAGE_H));
    let (sin, cos) = f64::from(deg).to_radians().sin_cos();
    let (cx, cy) = (w / 2.0, h / 2.0);
    [
        w * cos,
        w * sin,
        -h * sin,
        h * cos,
        cx - (cos * cx - sin * cy),
        cy - (sin * cx + cos * cy),
    ]
}

/// Lowercase words (runs of ASCII letters and digits) of `text`, in order.
pub fn words_of(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

/// Share of the words of `expected` found in `got`, as multisets, ignoring case and punctuation (0..=1).
pub fn word_recall(expected: &str, got: &str) -> f32 {
    let want = words_of(expected);
    if want.is_empty() {
        return 1.0;
    }
    let mut have: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for w in words_of(got) {
        *have.entry(w).or_default() += 1;
    }
    let mut hits = 0usize;
    for w in &want {
        if let Some(n) = have.get_mut(w)
            && *n > 0
        {
            *n -= 1;
            hits += 1;
        }
    }
    hits as f32 / want.len() as f32
}

fn wrap(text: &str, width: f64) -> Vec<String> {
    let mut lines = Vec::new();
    for (i, para) in text.split("\n\n").enumerate() {
        if i > 0 {
            lines.push(String::new());
        }
        let mut line = String::new();
        for word in para.split_whitespace() {
            let candidate = if line.is_empty() {
                word.to_owned()
            } else {
                format!("{line} {word}")
            };
            if !line.is_empty() && pdfcraft_ocr::helvetica_width(&candidate, FONT_SIZE) > width {
                lines.push(std::mem::replace(&mut line, word.to_owned()));
            } else {
                line = candidate;
            }
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

/// xorshift64: deterministic noise without a dependency.
struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_counts_words_as_a_multiset() {
        assert_eq!(
            word_recall("the pigs, the windmill", "THE windmill pigs"),
            0.75
        );
        assert_eq!(word_recall("", "x"), 1.0);
        assert_eq!(word_recall("a b", ""), 0.0);
    }

    #[test]
    fn the_placement_turns_around_the_centre() {
        let m = placement(0.0);
        assert_eq!(m, [612.0, 0.0, 0.0, 792.0, 0.0, 0.0]);
        let m = placement(1.0);
        // The centre of the image lands on the centre of the page.
        let (x, y) = (
            m[0] * 0.5 + m[2] * 0.5 + m[4],
            m[1] * 0.5 + m[3] * 0.5 + m[5],
        );
        assert!(
            (x - 306.0).abs() < 1e-9 && (y - 396.0).abs() < 1e-9,
            "{x} {y}"
        );
    }

    #[test]
    fn text_wraps_inside_the_margins() {
        for page in SAMPLE_PAGES {
            let lines = wrap(page, 468.0);
            assert!(lines.len() > 6 && lines.len() < 36, "{}", lines.len());
            for l in &lines {
                assert!(pdfcraft_ocr::helvetica_width(l, FONT_SIZE) <= 468.0, "{l}");
            }
            assert_eq!(words_of(&lines.join(" ")), words_of(page));
        }
    }
}
