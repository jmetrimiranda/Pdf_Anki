//! Notes and notetypes for the Add/Edit screens (docs/PROJETO.md 8.2). Functions take
//! `&mut Collection` so they run inside an [`crate::AnkiService`] job.

use std::collections::HashMap;

use anki::collection::Collection;
use anki::prelude::{AnkiError, Deck, DeckId, DeckKind, Note, NoteId, NotetypeId};
use anki::search::SortMode;
use anki::services::NotesService;
use anki_proto::notes::note_fields_check_response::State as NoteFieldsState;
use anki_proto::notetypes::notetype::config::Kind as NotetypeKind;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::notetypes::APP_NOTETYPES;

/// One field of a notetype, with the editor settings Anki stores on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub name: String,
    pub font_name: String,
    pub font_size: u32,
    pub rtl: bool,
    /// "Use HTML editor by default" (the field is edited as plain text).
    pub plain_text: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotetypeKindName {
    Normal,
    Cloze,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotetypeInfo {
    pub id: i64,
    pub name: String,
    pub kind: NotetypeKindName,
    pub fields: Vec<FieldInfo>,
    /// Card template names, in order.
    pub templates: Vec<String>,
    /// The name of the app's own notetype this is (`notetypes::APP_NOTETYPES`), if any.
    pub app_type: Option<String>,
    pub note_count: u32,
}

/// Notetype and deck the Add screen starts with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddDefaults {
    pub notetype_id: i64,
    pub deck_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteData {
    pub id: i64,
    pub notetype_id: i64,
    /// Field HTML exactly as stored.
    pub fields: Vec<String>,
    pub tags: Vec<String>,
    pub card_ids: Vec<i64>,
    /// Deck of the note's first card (0 when the note has no cards).
    pub deck_id: i64,
    /// Modification time, epoch seconds.
    pub mtime: i64,
}

/// Anki's `NoteFieldsCheckResponse.State`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteCheck {
    Normal,
    Empty,
    Duplicate,
    MissingCloze,
    NotetypeNotCloze,
    FieldNotCloze,
}

impl From<NoteFieldsState> for NoteCheck {
    fn from(state: NoteFieldsState) -> Self {
        match state {
            NoteFieldsState::Normal => NoteCheck::Normal,
            NoteFieldsState::Empty => NoteCheck::Empty,
            NoteFieldsState::Duplicate => NoteCheck::Duplicate,
            NoteFieldsState::MissingCloze => NoteCheck::MissingCloze,
            NoteFieldsState::NotetypeNotCloze => NoteCheck::NotetypeNotCloze,
            NoteFieldsState::FieldNotCloze => NoteCheck::FieldNotCloze,
        }
    }
}

impl NoteCheck {
    /// pt-BR message for the states that block adding a note (`None` = may be added).
    pub fn blocking_message(self) -> Option<&'static str> {
        match self {
            NoteCheck::Normal | NoteCheck::Duplicate => None,
            NoteCheck::Empty => Some("o primeiro campo está vazio."),
            NoteCheck::MissingCloze => {
                Some("não há nenhuma lacuna ({{c1::…}}) num tipo de nota Cloze.")
            }
            NoteCheck::NotetypeNotCloze => {
                Some("lacunas ({{c1::…}}) só funcionam em tipos de nota Cloze.")
            }
            NoteCheck::FieldNotCloze => {
                Some("lacunas ({{c1::…}}) só funcionam no campo de texto do Cloze.")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNote {
    pub notetype_id: i64,
    pub deck_id: i64,
    pub fields: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAdded {
    pub note_id: i64,
    pub card_count: u32,
}

/// Every notetype with its fields, templates and note count, sorted by name (case-insensitive).
pub fn notetypes(col: &mut Collection) -> Result<Vec<NotetypeInfo>> {
    let counts = note_counts(col)?;
    let mut out: Vec<NotetypeInfo> = col
        .get_all_notetypes()?
        .into_iter()
        .map(|nt| NotetypeInfo {
            id: nt.id.0,
            name: nt.name.clone(),
            kind: if nt.config.kind() == NotetypeKind::Cloze {
                NotetypeKindName::Cloze
            } else {
                NotetypeKindName::Normal
            },
            fields: nt
                .fields
                .iter()
                .map(|f| FieldInfo {
                    name: f.name.clone(),
                    font_name: f.config.font_name.clone(),
                    font_size: f.config.font_size,
                    rtl: f.config.rtl,
                    plain_text: f.config.plain_text,
                })
                .collect(),
            templates: nt.templates.iter().map(|t| t.name.clone()).collect(),
            app_type: APP_NOTETYPES
                .contains(&nt.name.as_str())
                .then(|| nt.name.clone()),
            note_count: counts.get(&nt.id.0).copied().unwrap_or(0),
        })
        .collect();
    out.sort_by_key(|nt| nt.name.to_lowercase());
    Ok(out)
}

fn note_counts(col: &mut Collection) -> Result<HashMap<i64, u32>> {
    let db = col.storage.db();
    let mut stmt = db
        .prepare_cached("SELECT mid, COUNT() FROM notes GROUP BY mid")
        .map_err(AnkiError::from)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?)))
        .map_err(AnkiError::from)?;
    let mut out = HashMap::new();
    for row in rows {
        let (mid, n) = row.map_err(AnkiError::from)?;
        out.insert(mid, n);
    }
    Ok(out)
}

/// Notetype and deck for the Add screen, following Anki's rules (`defaults_for_adding`). When
/// `deck_id` names a normal deck, the screen opens on that deck ("Adicionar" from a deck row) and
/// on the notetype last used in it, like Anki does with "default to the current deck".
pub fn add_defaults(col: &mut Collection, deck_id: Option<i64>) -> Result<AddDefaults> {
    let defaults = NotesService::defaults_for_adding(
        col,
        anki_proto::notes::DefaultsForAddingRequest {
            home_deck_of_current_review_card: 0,
        },
    )?;
    let mut out = AddDefaults {
        notetype_id: defaults.notetype_id,
        deck_id: defaults.deck_id,
    };
    if let Some(did) = deck_id {
        let deck = col.get_deck(DeckId(did))?;
        if let Some(deck) = deck.filter(|d| !is_filtered(d)) {
            out.deck_id = deck.id.0;
            if let Some(ntid) = last_notetype_for_deck(col, deck.id)? {
                out.notetype_id = ntid;
            }
        }
    }
    Ok(out)
}

/// rslib's `get_last_notetype_for_deck` (pub(crate)): config key `_deck_<id>_lastNotetype`.
fn last_notetype_for_deck(col: &mut Collection, did: DeckId) -> Result<Option<i64>> {
    let key = format!("_deck_{}_lastNotetype", did.0);
    let val: Option<Vec<u8>> = {
        let db = col.storage.db();
        let mut stmt = db
            .prepare_cached("SELECT val FROM config WHERE KEY = ?")
            .map_err(AnkiError::from)?;
        let mut rows = stmt
            .query_map([&key], |r| r.get::<_, Vec<u8>>(0))
            .map_err(AnkiError::from)?;
        rows.next().transpose().map_err(AnkiError::from)?
    };
    let Some(ntid) = val.and_then(|v| serde_json::from_slice::<i64>(&v).ok()) else {
        return Ok(None);
    };
    Ok(col.get_notetype(NotetypeId(ntid))?.map(|nt| nt.id.0))
}

/// A note with its cards; `fields` are the stored HTML, untouched.
pub fn get(col: &mut Collection, note_id: i64) -> Result<NoteData> {
    let note = load_note(col, note_id)?;
    let card_ids = col.search_cards(NoteId(note_id), SortMode::NoOrder)?;
    let mut card_ids: Vec<i64> = card_ids.into_iter().map(|c| c.0).collect();
    card_ids.sort_unstable();
    let deck_id = match card_ids.first() {
        Some(&cid) => col
            .storage
            .get_card(anki::prelude::CardId(cid))?
            .map(|c| c.deck_id().0)
            .unwrap_or(0),
        None => 0,
    };
    Ok(NoteData {
        id: note.id.0,
        notetype_id: note.notetype_id.0,
        tags: note.tags.clone(),
        mtime: note.mtime.0,
        fields: note.into_fields(),
        card_ids,
        deck_id,
    })
}

fn load_note(col: &mut Collection, note_id: i64) -> Result<Note> {
    col.storage
        .get_note(NoteId(note_id))?
        .ok_or_else(|| Error::NotFound(format!("nota {note_id}")))
}

/// Anki's field check (empty first field, cloze problems, duplicate first field) for a note that
/// is not saved yet.
pub fn check(col: &mut Collection, notetype_id: i64, fields: Vec<String>) -> Result<NoteCheck> {
    let note = build_note(col, notetype_id, fields)?;
    Ok(col.note_fields_check(&note)?.into())
}

fn build_note(col: &mut Collection, notetype_id: i64, fields: Vec<String>) -> Result<Note> {
    let nt = col
        .get_notetype(NotetypeId(notetype_id))?
        .ok_or_else(|| Error::NotFound(format!("tipo de nota {notetype_id}")))?;
    let mut note = nt.new_note();
    set_fields(&mut note, fields, nt.fields.len())?;
    Ok(note)
}

fn set_fields(note: &mut Note, fields: Vec<String>, expected: usize) -> Result<()> {
    if fields.len() != expected {
        return Err(Error::NoteInvalid(format!(
            "o tipo de nota tem {expected} campos, mas vieram {}.",
            fields.len()
        )));
    }
    for (i, text) in fields.into_iter().enumerate() {
        note.set_field(i, text)?;
    }
    Ok(())
}

/// Splits tags on whitespace and drops duplicates (Anki canonicalizes case and order on save).
pub fn canonical_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags.iter().flat_map(|t| t.split_whitespace()) {
        if !out.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            out.push(tag.to_string());
        }
    }
    out
}

/// Adds a note. Empty first field and cloze problems are refused; a duplicate first field is
/// allowed (the UI warns before).
pub fn add(col: &mut Collection, new: NewNote) -> Result<NoteAdded> {
    let mut note = build_note(col, new.notetype_id, new.fields)?;
    note.tags = canonical_tags(&new.tags);
    let state: NoteCheck = col.note_fields_check(&note)?.into();
    if let Some(msg) = state.blocking_message() {
        return Err(Error::NoteInvalid(msg.into()));
    }
    let deck = col
        .get_deck(DeckId(new.deck_id))?
        .ok_or_else(|| Error::NotFound(format!("baralho {}", new.deck_id)))?;
    if is_filtered(&deck) {
        return Err(Error::InvalidInput(
            "não é possível adicionar notas a um baralho filtrado.".into(),
        ));
    }
    let out = col.add_note(&mut note, deck.id)?;
    Ok(NoteAdded {
        note_id: note.id.0,
        card_count: u32::try_from(out.output).unwrap_or(u32::MAX),
    })
}

/// Replaces a note's fields and tags. Nothing is written when they are unchanged.
pub fn update(
    col: &mut Collection,
    note_id: i64,
    fields: Vec<String>,
    tags: Vec<String>,
) -> Result<()> {
    let mut note = load_note(col, note_id)?;
    let expected = note.fields().len();
    set_fields(&mut note, fields, expected)?;
    note.tags = canonical_tags(&tags);
    col.update_note(&mut note)?;
    Ok(())
}

/// Every tag of the collection, sorted case-insensitively.
pub fn all_tags(col: &mut Collection) -> Result<Vec<String>> {
    let mut tags: Vec<String> = col
        .storage
        .all_tags()?
        .into_iter()
        .map(|t| t.name)
        .collect();
    tags.sort_by_key(|t| t.to_lowercase());
    Ok(tags)
}

fn is_filtered(deck: &Deck) -> bool {
    matches!(deck.kind, DeckKind::Filtered(_))
}
