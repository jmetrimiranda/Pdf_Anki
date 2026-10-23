//! Code cards in the collection (docs/PROJETO.md 11.1, 11.2): which notetypes are code types, and the note
//! accessors "Contestar" needs.
//!
//! A notetype is a code type when its name is one of the app's ([`CODE_COMMAND`]/[`CODE_PROGRAM`], fixed field
//! names) or when the user assigned it the "Comando" role in Configurações → Código ([`CodeRole`], kept in the
//! app store and handed to the actor with [`crate::AnkiService::set_code_roles`]). A mapped type is never
//! changed (no schema change, no full sync); if one of its mapped fields no longer exists its cards are studied
//! normally and a warning is logged.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use anki::collection::Collection;
use anki::prelude::{Note, NoteId, Notetype};
use anki_proto::notetypes::notetype::config::Kind as NotetypeKind;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::notetypes::{CODE_COMMAND, CODE_PROGRAM};
use crate::study::{CodeCard, CodeCardFields, CodeCardRole};

/// Fields of the app's code types (spec 11.1).
pub mod fields {
    pub const QUESTION: &str = "Pergunta";
    pub const ANSWER: &str = "Resposta";
    pub const ACCEPTED: &str = "Aceitas";
    pub const REQUIRES: &str = "Exige";
    pub const NOTES: &str = "Observação";
    pub const LANGUAGE: &str = "Linguagem";
    pub const MODE: &str = "Modo";
    pub const INITIAL: &str = "Inicial";
    pub const SETUP: &str = "Setup";
    pub const TESTS: &str = "Testes";
    pub const INPUT: &str = "Entrada";
    pub const EXPECTED_OUTPUT: &str = "SaidaEsperada";
}

/// A user notetype with the "Comando" role: which of its fields are the question, the answer and the notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRole {
    pub notetype_id: i64,
    pub question_field: String,
    pub answer_field: String,
    pub notes_field: Option<String>,
}

/// A note as "Contestar" sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeNoteFields {
    pub notetype_id: i64,
    pub notetype_name: String,
    /// `None` when the note's type is not (or no longer) a code type.
    pub role: Option<CodeCardRole>,
    /// Raw field HTML by field name.
    pub fields: BTreeMap<String, String>,
    /// Name of the field extra accepted answers go to (`Aceitas`), when the type has one.
    pub accepted_field: Option<String>,
}

/// The roles map shared with the actor jobs (notetype id → role). Replaced as a whole.
pub(crate) type CodeRoleMap = HashMap<i64, CodeRole>;

#[derive(Default, Clone)]
pub(crate) struct CodeRoles(Arc<Mutex<Arc<CodeRoleMap>>>);

impl CodeRoles {
    pub fn snapshot(&self) -> Arc<CodeRoleMap> {
        Arc::clone(&self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }

    pub fn replace(&self, roles: Vec<CodeRole>) {
        let map: CodeRoleMap = roles.into_iter().map(|r| (r.notetype_id, r)).collect();
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Arc::new(map);
    }
}

/// How a notetype is studied as a code card: role and the names of its question/answer/notes fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodeType {
    pub role: CodeCardRole,
    pub app_type: bool,
    pub question: String,
    pub answer: String,
    pub notes: Option<String>,
}

fn has_field(nt: &Notetype, name: &str) -> bool {
    nt.fields.iter().any(|f| f.name == name)
}

/// The code type of `nt`, if any. App types are recognized by name; a mapped type must still have every mapped
/// field (else `None`, with a warning).
pub(crate) fn code_type(nt: &Notetype, roles: &CodeRoleMap) -> Option<CodeType> {
    let app_role = match nt.name.as_str() {
        CODE_COMMAND => Some(CodeCardRole::Command),
        CODE_PROGRAM => Some(CodeCardRole::Program),
        _ => None,
    };
    if let Some(role) = app_role {
        if !has_field(nt, fields::QUESTION) || !has_field(nt, fields::ANSWER) {
            tracing::warn!(notetype = %nt.name, "app code type without Pergunta/Resposta: studied normally");
            return None;
        }
        return Some(CodeType {
            role,
            app_type: true,
            question: fields::QUESTION.into(),
            answer: fields::ANSWER.into(),
            notes: has_field(nt, fields::NOTES).then(|| fields::NOTES.into()),
        });
    }
    let mapped = roles.get(&nt.id.0)?;
    let missing: Vec<&str> = [
        Some(mapped.question_field.as_str()),
        Some(mapped.answer_field.as_str()),
        mapped.notes_field.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|name| !has_field(nt, name))
    .collect();
    if !missing.is_empty() {
        tracing::warn!(
            notetype = %nt.name,
            ?missing,
            "mapped code type lost a field: studied as a normal card"
        );
        return None;
    }
    if nt.config.kind() == NotetypeKind::Cloze {
        tracing::warn!(notetype = %nt.name, "cloze type mapped as code: studied normally");
        return None;
    }
    Some(CodeType {
        role: CodeCardRole::Command,
        app_type: false,
        question: mapped.question_field.clone(),
        answer: mapped.answer_field.clone(),
        notes: mapped.notes_field.clone(),
    })
}

/// `{{Field}}`, `{{filter:Field}}`, `{{#Field}}`, `{{^Field}}` (the field name is the part after the last `:`).
fn references_field(template: &str, field: &str) -> bool {
    static TAG: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"\{\{([^{}]*)\}\}").expect("valid regex"));
    TAG.captures_iter(template).any(|c| {
        let inner = c[1].trim();
        let inner = inner
            .strip_prefix('#')
            .or_else(|| inner.strip_prefix('^'))
            .unwrap_or(inner);
        inner.rsplit(':').next().map(str::trim) == Some(field)
    })
}

/// The template prints the field's content: `{{Field}}` or `{{filter:Field}}`, not a `type:` box (stripped from code
/// cards) nor a section tag (`{{#Field}}` only tests it).
fn displays_field(template: &str, field: &str) -> bool {
    static TAG: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"\{\{([^{}]*)\}\}").expect("valid regex"));
    TAG.captures_iter(template).any(|c| {
        let inner = c[1].trim();
        if inner.starts_with(['#', '^', '/', '!', '=']) {
            return false;
        }
        let mut parts = inner.rsplit(':');
        parts.next().map(str::trim) == Some(field) && !parts.any(|f| f.trim() == "type")
    })
}

/// The [`CodeCard`] of a note whose type is `code`; `answer_template` is the card's answer format.
pub(crate) fn code_card(
    nt: &Notetype,
    note: &Note,
    code: &CodeType,
    answer_template: &str,
) -> CodeCard {
    let value = |name: &str| -> String {
        nt.fields
            .iter()
            .position(|f| f.name == name)
            .and_then(|i| note.fields().get(i))
            .cloned()
            .unwrap_or_default()
    };
    let program = code.role == CodeCardRole::Program;
    let program_field = |name: &str| if program { value(name) } else { String::new() };
    CodeCard {
        role: code.role,
        notetype_id: nt.id.0,
        app_type: code.app_type,
        accepted_field: has_field(nt, fields::ACCEPTED),
        answer_shows_notes: code
            .notes
            .as_deref()
            .is_some_and(|n| references_field(answer_template, n)),
        answer_shows_answer: displays_field(answer_template, &code.answer),
        fields: CodeCardFields {
            answer: value(&code.answer),
            accepted: value(fields::ACCEPTED),
            requires: value(fields::REQUIRES),
            notes: code.notes.as_deref().map(value).unwrap_or_default(),
            language: program_field(fields::LANGUAGE),
            mode: program_field(fields::MODE),
            initial: program_field(fields::INITIAL),
            setup: program_field(fields::SETUP),
            tests: program_field(fields::TESTS),
            input: program_field(fields::INPUT),
            expected_output: program_field(fields::EXPECTED_OUTPUT),
        },
    }
}

fn load_note(col: &mut Collection, note_id: i64) -> Result<(Note, Arc<Notetype>)> {
    let note = col
        .storage
        .get_note(NoteId(note_id))?
        .ok_or_else(|| Error::NotFound(format!("nota {note_id}")))?;
    let nt = col
        .get_notetype(note.notetype_id)?
        .ok_or_else(|| Error::NotFound(format!("tipo de nota da nota {note_id}")))?;
    Ok((note, nt))
}

/// [`crate::AnkiService::code_note`] on the actor.
pub(crate) fn code_note(
    col: &mut Collection,
    roles: &CodeRoleMap,
    note_id: i64,
) -> Result<CodeNoteFields> {
    let (note, nt) = load_note(col, note_id)?;
    let role = code_type(&nt, roles).map(|c| c.role);
    let fields = nt
        .fields
        .iter()
        .zip(note.fields())
        .map(|(f, v)| (f.name.clone(), v.clone()))
        .collect();
    Ok(CodeNoteFields {
        notetype_id: nt.id.0,
        notetype_name: nt.name.clone(),
        role,
        fields,
        accepted_field: has_field(&nt, fields::ACCEPTED).then(|| fields::ACCEPTED.into()),
    })
}

/// [`crate::AnkiService::note_field_set`] on the actor: an undoable update of one field.
pub(crate) fn note_field_set(
    col: &mut Collection,
    note_id: i64,
    field_name: &str,
    html: String,
) -> Result<()> {
    let (mut note, nt) = load_note(col, note_id)?;
    let index = nt
        .fields
        .iter()
        .position(|f| f.name == field_name)
        .ok_or_else(|| {
            Error::NotFound(format!(
                "campo \"{field_name}\" no tipo de nota \"{}\"",
                nt.name
            ))
        })?;
    note.set_field(index, html)?;
    col.update_note(&mut note)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_field_ignores_type_boxes_and_sections() {
        assert!(displays_field("<pre>{{Resposta}}</pre>", "Resposta"));
        assert!(displays_field("{{text:Resposta}}", "Resposta"));
        assert!(!displays_field("{{type:Resposta}}", "Resposta"));
        assert!(!displays_field("{{#Resposta}}x{{/Resposta}}", "Resposta"));
        assert!(!displays_field("{{Respostas}}", "Resposta"));
    }

    #[test]
    fn finds_field_references() {
        let t = "{{FrontSide}}<hr id=answer>{{#Explicação}}<blockquote>{{Explicação}}</blockquote>{{/Explicação}}";
        assert!(references_field(t, "Explicação"));
        assert!(!references_field(t, "Comando"));
        assert!(references_field("{{#Obs}}x{{/Obs}}", "Obs"));
        assert!(references_field("{{^Obs}}x{{/Obs}}", "Obs"));
        assert!(references_field("{{text:Obs}}", "Obs"));
        assert!(references_field("{{ Obs }}", "Obs"));
        assert!(!references_field("{{/Obs}}", "Obs"));
        assert!(!references_field("Obs", "Obs"));
        assert!(!references_field("{{Observação extra}}", "Observação"));
    }
}
