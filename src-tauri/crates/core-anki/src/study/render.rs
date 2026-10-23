//! Card text pipeline of the desktop reviewer (`pylib/anki/template.py:224-256`, `pylib/anki/latex.py`,
//! `qt/aqt/main.py:633-643`): partial render, `{{FrontSide}}` injection after AV extraction, custom filters,
//! LaTeX images, then `prepare_card_text_for_display`.
use std::path::Path;

use anki::card_rendering::extract_av_tags;
use anki::config::BoolKey;
use anki::prelude::*;
use anki::services::CardRenderingService;
use anki::template::RenderedNode;
use anki_proto::notetypes::notetype::config::Kind as NotetypeKind;

use super::av::{av_refs_to_play_icons, convert_tags, strip_av_refs};
use super::typeans::{self, TypeContext, TypeState};
use super::types::AvTag;
use crate::error::Error;

/// What `Card.question()`/`Card.answer()` and the AV tag accessors return on the desktop.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RenderedCard {
    /// `<style>{css}</style>{question}`.
    pub question: String,
    /// `<style>{css}</style>{answer}`.
    pub answer: String,
    pub question_av: Vec<anki_proto::card_rendering::AvTag>,
    pub answer_av: Vec<anki_proto::card_rendering::AvTag>,
}

/// `apply_custom_filters` (`template.py:308-343`) without Python hooks: `{{FrontSide}}` gets `front_side`, the
/// `tts-voices` filter (a desktop voice list) renders empty, unknown filters leave the text unchanged.
pub fn apply_custom_filters(nodes: &[RenderedNode], front_side: Option<&str>) -> String {
    if let [RenderedNode::Text { text }] = nodes {
        return text.clone();
    }
    let mut out = String::new();
    for node in nodes {
        match node {
            RenderedNode::Text { text } => out.push_str(text),
            RenderedNode::Replacement {
                field_name,
                current_text,
                filters,
            } => {
                let mut text = match front_side {
                    Some(front) if field_name == "FrontSide" => front.to_string(),
                    _ => current_text.clone(),
                };
                for filter in filters {
                    if filter == "tts-voices" {
                        text.clear();
                    }
                }
                out.push_str(&text);
            }
        }
    }
    out
}

/// Renders an existing card like `TemplateRenderContext.render()` + the LaTeX `card_did_render` hook. A template
/// error becomes the text of both sides (no AV tags), as on the desktop.
pub fn render_card(col: &mut Collection, cid: CardId, media_folder: &Path) -> Result<RenderedCard> {
    render_card_with(col, cid, media_folder, None)
}

/// [`render_card`], optionally as a code card (spec 11.2): the question is only `question_field` (rendered from
/// the synthesized template `{{<question_field>}}`), `{{FrontSide}}` of the real answer template is that question,
/// and every `[[type:…]]` marker is removed from both sides (no Anki type box: the app shows its own editor).
pub fn render_card_with(
    col: &mut Collection,
    cid: CardId,
    media_folder: &Path,
    question_field: Option<&str>,
) -> Result<RenderedCard> {
    let rendered = match question_field {
        None => col.render_existing_card(cid, false, true),
        // `render_existing_card` with the card's template whose question format is replaced by `{{<field>}}`
        // (`Collection::render_card` renders a note with any template; the notetype itself is untouched).
        Some(field) => (|| {
            let card = col.storage.get_card(cid)?.or_invalid("no such card")?;
            let note = col
                .storage
                .get_note(card.note_id())?
                .or_invalid("no such note")?;
            let nt = col
                .get_notetype(note.notetype_id)?
                .or_invalid("no such notetype")?;
            let index = if nt.config.kind() == NotetypeKind::Cloze {
                0
            } else {
                usize::from(card.template_idx())
            };
            let mut template = nt
                .templates
                .get(index)
                .or_invalid("missing template")?
                .clone();
            template.config.q_format = format!("{{{{{field}}}}}");
            col.render_card(&note, &card, &nt, &template, false, true)
        })(),
    };
    let out = match rendered {
        Ok(out) => out,
        Err(e @ AnkiError::TemplateError { .. }) => {
            let msg = e.message(col.tr());
            let text = format!("<style></style>{msg}");
            return Ok(RenderedCard {
                question: text.clone(),
                answer: text,
                ..Default::default()
            });
        }
        Err(e) => return Err(e),
    };
    let strip = |text: String| {
        if question_field.is_some() {
            typeans::strip_type_markers(&text)
        } else {
            text
        }
    };
    let q_text = strip(apply_custom_filters(&out.qnodes, None));
    let (q_text, question_av) = extract_av_tags(q_text, true, col.tr());
    let a_text = strip(apply_custom_filters(&out.anodes, Some(&q_text)));
    let (a_text, answer_av) = extract_av_tags(a_text, false, col.tr());
    let q_text = render_latex(col, &q_text, out.latex_svg, media_folder);
    let a_text = render_latex(col, &a_text, out.latex_svg, media_folder);
    Ok(RenderedCard {
        question: format!("<style>{}</style>{}", out.css, q_text),
        answer: format!("<style>{}</style>{}", out.css, a_text),
        question_av,
        answer_av,
    })
}

/// `render_latex` (`pylib/anki/latex.py:73-108`): `[latex]…[/latex]`/`[$]…[/$]` → `<img src=latex-….png|svg>`.
/// The app never runs TeX: a missing image gets the "generation disabled" message appended once.
pub fn render_latex(col: &Collection, html: &str, svg: bool, media_folder: &Path) -> String {
    let (text, extracted) = anki::latex::extract_latex(html, svg);
    let mut text = text.into_owned();
    if extracted
        .iter()
        .any(|l| !media_folder.join(&l.fname).is_file())
    {
        text.push_str(&col.tr().preferences_latex_generation_disabled());
    }
    text
}

/// `prepare_card_text_for_display`: media names IRI-encoded, then play buttons (or none, if hidden).
pub fn prepare_card_text_for_display(col: &mut Collection, text: &str) -> Result<String> {
    let text = encode_iri_paths(col, text)?;
    Ok(if col.get_config_bool(BoolKey::HideAudioPlayButtons) {
        strip_av_refs(&text)
    } else {
        av_refs_to_play_icons(&text)
    })
}

/// `col.media.escape_media_filenames` (the backend's `encode_iri_paths`).
pub fn encode_iri_paths(col: &mut Collection, text: &str) -> Result<String> {
    Ok(CardRenderingService::encode_iri_paths(
        col,
        anki_proto::generic::String {
            val: text.to_string(),
        },
    )?
    .val)
}

/// A card ready for the reviewer: both sides through the whole desktop pipeline.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewRender {
    /// `_showQuestion`'s `q`: prepared for display + `typeAnsQuestionFilter`.
    pub question_html: String,
    /// `_showQuestion`'s `a`: the raw answer with media paths encoded (preload only).
    pub answer_preload_html: String,
    /// `c.answer()`, kept for [`answer_for_review`].
    pub answer_raw: String,
    pub question_av: Vec<AvTag>,
    pub answer_av: Vec<AvTag>,
    pub type_state: TypeState,
    /// Template ordinal (`card.ord`).
    pub ord: u32,
}

/// `_showQuestion` for card `cid` (`reviewer.py:367-405`).
pub fn render_for_review(
    col: &mut Collection,
    cid: CardId,
    media_folder: &Path,
) -> crate::error::Result<ReviewRender> {
    render_for_review_with(col, cid, media_folder, None)
}

/// [`render_for_review`]; with `question_field` the card is rendered as a code card ([`render_card_with`]).
pub fn render_for_review_with(
    col: &mut Collection,
    cid: CardId,
    media_folder: &Path,
    question_field: Option<&str>,
) -> crate::error::Result<ReviewRender> {
    let card = col
        .storage
        .get_card(cid)?
        .ok_or_else(|| Error::NotFound("card".into()))?;
    let ord = u32::from(card.template_idx());
    let note = col
        .storage
        .get_note(card.note_id())?
        .ok_or_else(|| Error::NotFound("note".into()))?;
    let notetype = col
        .get_notetype(note.notetype_id)?
        .ok_or_else(|| Error::NotFound("notetype".into()))?;
    let rendered = render_card_with(col, cid, media_folder, question_field)?;
    let question = prepare_card_text_for_display(col, &rendered.question)?;
    let mut type_state = TypeState::default();
    let question_html = typeans::question_filter(
        col,
        &question,
        &TypeContext {
            ord,
            fields: notetype
                .fields
                .iter()
                .map(|f| {
                    (
                        f.name.clone(),
                        f.config.font_name.clone(),
                        f.config.font_size,
                    )
                })
                .collect(),
            values: note.fields(),
        },
        &mut type_state,
    )?;
    Ok(ReviewRender {
        question_html,
        answer_preload_html: encode_iri_paths(col, &rendered.answer)?,
        answer_raw: rendered.answer,
        question_av: convert_tags(rendered.question_av),
        answer_av: convert_tags(rendered.answer_av),
        type_state,
        ord,
    })
}

/// `_showAnswer` (`reviewer.py:460-484`): the answer prepared for display + `typeAnsAnswerFilter`. `typed` = `None` is
/// treated as "" (`_onTypedAnswer`).
pub fn answer_for_review(
    col: &mut Collection,
    answer_raw: &str,
    type_state: &TypeState,
    typed: Option<&str>,
) -> crate::error::Result<String> {
    let answer = prepare_card_text_for_display(col, answer_raw)?;
    Ok(typeans::answer_filter(
        col,
        &answer,
        type_state,
        Some(typed.unwrap_or("")),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> RenderedNode {
        RenderedNode::Text { text: s.into() }
    }

    fn repl(field: &str, current: &str, filters: &[&str]) -> RenderedNode {
        RenderedNode::Replacement {
            field_name: field.into(),
            current_text: current.into(),
            filters: filters.iter().map(|f| f.to_string()).collect(),
        }
    }

    #[test]
    fn custom_filters() {
        assert_eq!(apply_custom_filters(&[text("only")], Some("x")), "only");
        let nodes = [text("<"), repl("FrontSide", "raw", &[]), text(">")];
        assert_eq!(
            apply_custom_filters(&nodes, Some("Q[anki:play:q:0]")),
            "<Q[anki:play:q:0]>"
        );
        assert_eq!(apply_custom_filters(&nodes, None), "<raw>");
        let nodes = [
            repl("Front", "voices", &["tts-voices"]),
            repl("Back", "kept", &["myfilter"]),
        ];
        assert_eq!(apply_custom_filters(&nodes, None), "kept");
    }
}
