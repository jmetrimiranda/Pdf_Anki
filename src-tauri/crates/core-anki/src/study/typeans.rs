//! Type-in-the-answer filters, ported verbatim from `qt/aqt/reviewer.py:698-805` (quirks included).
use std::sync::LazyLock;

use anki::prelude::*;
use anki::services::CardRenderingService;
use anki_proto::card_rendering::{CompareAnswerRequest, ExtractClozeForTypingRequest};
use regex::{Captures, NoExpand, Regex};

/// `typeAnsPat`.
static TYPE_ANS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[type:(.+?)\]\]").expect("valid regex"));

/// Per-card state set by the question filter and read by the answer filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeState {
    /// `typeCorrect`: `None` = unknown field / empty cloze; `Some("")` = empty field.
    pub type_correct: Option<String>,
    pub combining: bool,
    pub font: String,
    pub size: u32,
}

impl Default for TypeState {
    fn default() -> Self {
        Self {
            type_correct: None,
            combining: true,
            font: "Arial".into(),
            size: 20,
        }
    }
}

impl TypeState {
    /// The question shows an `<input id=typeans>` (the host must ask for the typed text).
    pub fn wants_input(&self) -> bool {
        self.type_correct.as_deref().is_some_and(|s| !s.is_empty())
    }
}

/// What the filter needs from the card: its ordinal, its notetype's fields (name, font, size) and the note's values.
pub struct TypeContext<'a> {
    pub ord: u32,
    pub fields: Vec<(String, String, u32)>,
    pub values: &'a [String],
}

/// `typeAnsQuestionFilter`. `state` is reset first, like the Python instance attributes.
pub fn question_filter(
    col: &mut Collection,
    buf: &str,
    ctx: &TypeContext<'_>,
    state: &mut TypeState,
) -> Result<String> {
    state.combining = true;
    state.type_correct = None;
    let Some(m) = TYPE_ANS.captures(buf) else {
        return Ok(buf.to_string());
    };
    let mut fld = m[1].to_string();
    let mut cloze_idx = None;
    if fld.starts_with("cloze:") {
        cloze_idx = Some(ctx.ord + 1);
        fld = second_segment(&fld);
    }
    if fld.starts_with("nc:") {
        state.combining = false;
        fld = second_segment(&fld);
    }
    for (i, (name, font, size)) in ctx.fields.iter().enumerate() {
        if *name == fld {
            let value = ctx.values.get(i).cloned().unwrap_or_default();
            state.type_correct = match cloze_idx {
                Some(ordinal) => {
                    let text = CardRenderingService::extract_cloze_for_typing(
                        col,
                        ExtractClozeForTypingRequest {
                            text: value,
                            ordinal,
                        },
                    )?
                    .val;
                    // `… or None`
                    (!text.is_empty()).then_some(text)
                }
                None => Some(value),
            };
            state.font = font.clone();
            state.size = *size;
            break;
        }
    }
    match state.type_correct.as_deref() {
        None => {
            let warn = if cloze_idx.is_some() {
                col.tr().studying_please_run_toolsempty_cards().into_owned()
            } else {
                col.tr()
                    .studying_type_answer_unknown_field(fld.as_str())
                    .into_owned()
            };
            Ok(TYPE_ANS.replace_all(buf, NoExpand(&warn)).into_owned())
        }
        Some("") => Ok(TYPE_ANS.replace_all(buf, "").into_owned()),
        Some(_) => {
            let input = format!(
                "\n<center>\n<input type=text id=typeans onkeypress=\"_typeAnsPress();\"\n   style=\"font-family: '{}'; font-size: {}px;\">\n</center>\n",
                state.font, state.size
            );
            Ok(TYPE_ANS.replace_all(buf, NoExpand(&input)).into_owned())
        }
    }
}

/// `typeAnsAnswerFilter`. `typed` is the text of `#typeans` (`None` → "", `_onTypedAnswer`).
pub fn answer_filter(
    col: &mut Collection,
    buf: &str,
    state: &TypeState,
    typed: Option<&str>,
) -> Result<String> {
    let expected = match state.type_correct.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Ok(TYPE_ANS.replace_all(buf, "").into_owned()),
    };
    let orig = buf;
    let stripped = buf.replace("<hr id=answer>", "");
    let had_hr = stripped.len() != orig.len();
    let output = CardRenderingService::compare_answer(
        col,
        CompareAnswerRequest {
            expected,
            provided: typed.unwrap_or("").to_string(),
            combining: state.combining,
        },
    )?
    .val;
    if had_hr && !TYPE_ANS.is_match(&stripped) {
        return Ok(orig.to_string());
    }
    let replaced = TYPE_ANS.replace_all(&stripped, |_: &Captures| {
        let s = format!(
            "\n<div style=\"font-family: '{}'; font-size: {}px\">{}</div>",
            state.font, state.size, output
        );
        if had_hr {
            format!("<hr id=answer>{s}")
        } else {
            s
        }
    });
    Ok(replaced.into_owned())
}

/// `fld.split(":")[1]`.
fn second_segment(s: &str) -> String {
    s.split(':').nth(1).unwrap_or("").to_string()
}
