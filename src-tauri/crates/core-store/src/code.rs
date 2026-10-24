//! Code cards (docs/PROJETO.md 11.1, 14): which Anki notetypes play a code role
//! (`notetype_mapping` rows with role `code_command`/`code_program`) and the extra accepted answers and
//! required prefixes of notes whose type has no `Aceitas`/`Exige` fields (`code_note_extra`).
//!
//! Both tables sync between devices (library-sync, phase 9): keys are Anki ids (stable across synced
//! devices), every write bumps `updated_at` (strictly increasing per row, even within the same
//! millisecond) and removals are tombstones (`deleted = 1`) that a later write resurrects.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Result, Store, StoreError, now_ms};

/// Most entries in each list of [`CodeNoteExtra`].
pub const CODE_EXTRA_MAX_ENTRIES: usize = 50;
/// Longest entry (in characters) of [`CodeNoteExtra`].
pub const CODE_EXTRA_MAX_CHARS: usize = 2000;

/// Role of a mapped notetype. Stored as `code_command` / `code_program` in `notetype_mapping.role`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CodeRole {
    #[serde(rename = "code_command")]
    Command,
    #[serde(rename = "code_program")]
    Program,
}

impl CodeRole {
    /// The value of the `role` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "code_command",
            Self::Program => "code_program",
        }
    }

    fn from_column(text: &str) -> Option<Self> {
        match text {
            "code_command" => Some(Self::Command),
            "code_program" => Some(Self::Program),
            _ => None,
        }
    }
}

/// Which fields of the mapped notetype hold the question, the answer and (optionally) the notes.
/// Stored as JSON `{"question","answer","notes"}` in `notetype_mapping.fields`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeMappingFields {
    pub question: String,
    pub answer: String,
    #[serde(default)]
    pub notes: Option<String>,
}

/// A live code mapping.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeMappingRow {
    pub notetype_id: i64,
    pub role: CodeRole,
    pub fields: CodeMappingFields,
    pub updated_at: i64,
}

/// Extra accepted answers and required prefixes/flags of one note (spec 11.1, 11.2 "Contestar").
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeNoteExtra {
    pub note_id: i64,
    pub accepted: Vec<String>,
    pub requires: Vec<String>,
    pub updated_at: i64,
}

/// The next `updated_at` of a row: now, but always after the previous value.
pub(crate) fn next_updated_at(previous: Option<i64>) -> i64 {
    let now = now_ms();
    match previous {
        Some(prev) if prev >= now => prev.saturating_add(1),
        _ => now,
    }
}

fn check_field_name(what: &str, name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StoreError::InvalidInput(format!(
            "o campo da {what} não pode ser vazio."
        )));
    }
    Ok(name.to_owned())
}

fn normalize_fields(fields: CodeMappingFields) -> Result<CodeMappingFields> {
    let question = check_field_name("Pergunta", &fields.question)?;
    let answer = check_field_name("Resposta", &fields.answer)?;
    let notes = match fields.notes.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(n) => Some(n.to_owned()),
    };
    if question == answer
        || notes
            .as_ref()
            .is_some_and(|n| *n == question || *n == answer)
    {
        return Err(StoreError::InvalidInput(
            "a Pergunta, a Resposta e a Observação precisam ser campos diferentes.".into(),
        ));
    }
    Ok(CodeMappingFields {
        question,
        answer,
        notes,
    })
}

/// Trims, drops empty entries and duplicates (first one wins), then checks the limits.
fn normalize_list(what: &str, items: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim();
        if item.is_empty() || out.iter().any(|seen| seen == item) {
            continue;
        }
        if item.chars().count() > CODE_EXTRA_MAX_CHARS {
            return Err(StoreError::InvalidInput(format!(
                "cada item de {what} pode ter no máximo {CODE_EXTRA_MAX_CHARS} caracteres."
            )));
        }
        out.push(item.to_owned());
    }
    if out.len() > CODE_EXTRA_MAX_ENTRIES {
        return Err(StoreError::InvalidInput(format!(
            "{what} pode ter no máximo {CODE_EXTRA_MAX_ENTRIES} itens."
        )));
    }
    Ok(out)
}

fn parse_list(note_id: i64, column: &str, text: &str) -> Result<Vec<String>> {
    serde_json::from_str(text).map_err(|e| {
        StoreError::Corrupt(format!(
            "code_note_extra.{column} da nota {note_id} não é uma lista de textos: {e}"
        ))
    })
}

impl Store {
    /// Live code mappings (`code_command`/`code_program`), ordered by notetype id. Rows whose
    /// fields JSON no longer parses are skipped (written by a newer version).
    pub fn code_mappings(&self) -> Result<Vec<CodeMappingRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT anki_notetype_id, role, fields, updated_at FROM notetype_mapping
             WHERE deleted = 0 AND role IN ('code_command', 'code_program')
             ORDER BY anki_notetype_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (notetype_id, role, fields, updated_at) = row?;
            let (Some(role), Ok(fields)) = (
                CodeRole::from_column(&role),
                serde_json::from_str::<CodeMappingFields>(&fields),
            ) else {
                continue;
            };
            out.push(CodeMappingRow {
                notetype_id,
                role,
                fields,
                updated_at,
            });
        }
        Ok(out)
    }

    /// Assigns (`Some`) or removes (`None`, a tombstone) the code role of a notetype. Field names are
    /// trimmed and must be non-empty and distinct; the notes field is optional. Removing a mapping
    /// that doesn't exist (or isn't a code mapping) does nothing.
    pub fn set_code_mapping(
        &self,
        notetype_id: i64,
        mapping: Option<(CodeRole, CodeMappingFields)>,
    ) -> Result<()> {
        let previous: Option<(String, i64, i64)> = self
            .conn
            .query_row(
                "SELECT role, updated_at, deleted FROM notetype_mapping WHERE anki_notetype_id = ?1",
                params![notetype_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let updated_at = next_updated_at(previous.as_ref().map(|p| p.1));
        match mapping {
            Some((role, fields)) => {
                // The key is shared with the vocabulary role: never replace an active vocab mapping.
                if let Some((existing, _, 0)) = &previous
                    && existing == "vocab"
                {
                    return Err(StoreError::MappingConflict {
                        role: crate::vocab::role_label(existing).to_owned(),
                    });
                }
                let fields = normalize_fields(fields)?;
                let json = serde_json::to_string(&fields)
                    .map_err(|e| StoreError::InvalidInput(e.to_string()))?;
                self.conn.execute(
                    "INSERT INTO notetype_mapping (anki_notetype_id, role, fields, updated_at, deleted)
                     VALUES (?1, ?2, ?3, ?4, 0)
                     ON CONFLICT (anki_notetype_id) DO UPDATE SET role = excluded.role,
                         fields = excluded.fields, updated_at = max(excluded.updated_at, updated_at + 1), deleted = 0",
                    params![notetype_id, role.as_str(), json, updated_at],
                )?;
            }
            None => {
                // Only a code mapping is removed here; a vocab mapping belongs to another feature.
                self.conn.execute(
                    "UPDATE notetype_mapping SET deleted = 1, updated_at = max(?2, updated_at + 1)
                     WHERE anki_notetype_id = ?1 AND deleted = 0
                       AND role IN ('code_command', 'code_program')",
                    params![notetype_id, updated_at],
                )?;
            }
        }
        Ok(())
    }

    /// The extra accepted answers/required prefixes of a note, or `None` (never set or removed).
    pub fn code_note_extra(&self, note_id: i64) -> Result<Option<CodeNoteExtra>> {
        let row: Option<(String, String, i64)> = self
            .conn
            .query_row(
                "SELECT accepted, requires, updated_at FROM code_note_extra
                 WHERE note_id = ?1 AND deleted = 0",
                params![note_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        row.map(|(accepted, requires, updated_at)| {
            Ok(CodeNoteExtra {
                note_id,
                accepted: parse_list(note_id, "accepted", &accepted)?,
                requires: parse_list(note_id, "requires", &requires)?,
                updated_at,
            })
        })
        .transpose()
    }

    /// Replaces both lists of a note. Entries are trimmed, empty ones and duplicates dropped (the
    /// first occurrence keeps its place); at most [`CODE_EXTRA_MAX_ENTRIES`] entries of
    /// [`CODE_EXTRA_MAX_CHARS`] characters each, else `InvalidInput`. Both lists empty → tombstone.
    /// Returns what is stored (empty lists after a tombstone).
    pub fn set_code_note_extra(
        &self,
        note_id: i64,
        accepted: &[String],
        requires: &[String],
    ) -> Result<CodeNoteExtra> {
        let accepted = normalize_list("Aceitas", accepted)?;
        let requires = normalize_list("Exige", requires)?;
        let previous: Option<i64> = self
            .conn
            .query_row(
                "SELECT updated_at FROM code_note_extra WHERE note_id = ?1",
                params![note_id],
                |r| r.get(0),
            )
            .optional()?;
        let updated_at = next_updated_at(previous);
        if accepted.is_empty() && requires.is_empty() {
            if previous.is_some() {
                self.conn.execute(
                    "UPDATE code_note_extra SET accepted = '[]', requires = '[]', deleted = 1,
                         updated_at = max(?2, updated_at + 1)
                     WHERE note_id = ?1",
                    params![note_id, updated_at],
                )?;
            }
        } else {
            let to_json = |list: &Vec<String>| {
                serde_json::to_string(list).map_err(|e| StoreError::InvalidInput(e.to_string()))
            };
            self.conn.execute(
                "INSERT INTO code_note_extra (note_id, accepted, requires, updated_at, deleted)
                 VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT (note_id) DO UPDATE SET accepted = excluded.accepted,
                     requires = excluded.requires, updated_at = max(excluded.updated_at, updated_at + 1), deleted = 0",
                params![
                    note_id,
                    to_json(&accepted)?,
                    to_json(&requires)?,
                    updated_at
                ],
            )?;
        }
        Ok(CodeNoteExtra {
            note_id,
            accepted,
            requires,
            updated_at,
        })
    }
}
