//! The fields of a "Vocabulário · Livro" note built from a report row (spec 12.6). The Fonte HTML is built by
//! `core-anki` (`study::source::source_html`) from `fonte_page`/`fonte_query`.

use serde::{Deserialize, Serialize};

use crate::{Pos, RowGroup, VocabRow, pos_label_pt};

/// Context of the note: the book and the definition (WordNet without AI; AI enrichment is Phase 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabNoteCtx {
    pub book_uid: String,
    pub title: String,
    /// The first-sense definition and its part of speech (`Lexicon::definition`).
    pub defn: Option<(Pos, String)>,
    /// Occurrences in the whole book (the "Frequência" field).
    pub book_occurrences: u32,
    /// Fill "Card 2" (the optional Português → Inglês card).
    pub card2: bool,
}

/// The note fields, already HTML-safe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabNoteFields {
    pub palavra: String,
    pub lema: String,
    pub classe: String,
    pub definicao: String,
    /// Empty: filled by the AI enrichment (Phase 8 hook).
    pub traducao: String,
    pub exemplo: String,
    /// 1-based page of the first occurrence (for the Fonte link).
    pub fonte_page: u32,
    /// The text to search on that page (the form).
    pub fonte_query: String,
    pub frequencia: String,
    pub familia: String,
    pub card2: String,
}

/// Escapes text for an Anki field.
pub(crate) fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// The example with the occurrence in `<b>` (UTF-16 span), escaped.
fn example_html(example: &str, span: Option<[u32; 2]>) -> String {
    let utf16: Vec<u16> = example.encode_utf16().collect();
    match span {
        Some([a, b]) if a < b && (b as usize) <= utf16.len() => {
            let part = |x: usize, y: usize| String::from_utf16_lossy(&utf16[x..y]);
            format!(
                "{}<b>{}</b>{}",
                escape_html(&part(0, a as usize)),
                escape_html(&part(a as usize, b as usize)),
                escape_html(&part(b as usize, utf16.len()))
            )
        }
        _ => escape_html(example),
    }
}

/// The fields of the note for a row. "Palavra" is the form for rows of the "forms" group, the lemma otherwise.
pub fn vocab_note_fields(row: &VocabRow, ctx: &VocabNoteCtx) -> VocabNoteFields {
    let palavra = if row.group == RowGroup::Forms {
        row.form.to_lowercase()
    } else {
        row.lemma.clone()
    };
    let pos = ctx.defn.as_ref().map(|d| d.0).or(row.pos);
    let page = row.example_page.unwrap_or(row.first_page);
    let query = match &row.example_span {
        Some([a, b]) => row
            .example
            .as_deref()
            .map(|e| {
                let u: Vec<u16> = e.encode_utf16().collect();
                let (a, b) = (*a as usize, (*b as usize).min(u.len()));
                if a < b {
                    String::from_utf16_lossy(&u[a..b])
                } else {
                    row.form.clone()
                }
            })
            .unwrap_or_else(|| row.form.clone()),
        None => row.form.clone(),
    };
    VocabNoteFields {
        palavra: escape_html(&palavra),
        lema: escape_html(&row.lemma),
        classe: pos.map(pos_label_pt).unwrap_or_default().to_string(),
        definicao: ctx
            .defn
            .as_ref()
            .map(|d| escape_html(&d.1))
            .unwrap_or_default(),
        traducao: String::new(),
        exemplo: row
            .example
            .as_deref()
            .map(|e| example_html(e, row.example_span))
            .unwrap_or_default(),
        fonte_page: page.saturating_add(1),
        fonte_query: query,
        frequencia: ctx.book_occurrences.to_string(),
        familia: row
            .family
            .as_ref()
            .map(|f| escape_html(&f.lemma))
            .unwrap_or_default(),
        card2: if ctx.card2 {
            "1".to_string()
        } else {
            String::new()
        },
    }
}
