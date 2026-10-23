//! The "Navegar" screen (docs/PROJETO.md 8.2): Anki search, browser rows and bulk operations.
//! Functions take `&mut Collection` so they run inside an [`crate::AnkiService`] job. The browser
//! works on cards (Anki's cards mode); note operations take note ids.

use std::collections::HashMap;

use anki::browser_table::Column;
use anki::collection::Collection;
use anki::config::BoolKey;
use anki::prelude::{AnkiError, CardId, DeckId, NoteId};
use anki::search::SortMode;
use anki::services::SearchService;
use anki_proto::scheduler::bury_or_suspend_cards_request::Mode as BuryOrSuspendMode;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Most ids [`rows`] accepts per call (the UI pages by 100).
pub const MAX_ROWS: usize = 500;

/// Columns shown by the browser, in this order (Anki's column keys).
const ACTIVE_COLUMNS: [&str; 4] = ["noteFld", "template", "cardDue", "deck"];

/// Columns the browser can sort by (Anki's `browser_table::Column`, camelCase keys).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowseColumn {
    SortField,
    Template,
    Deck,
    CardDue,
    CardIvl,
    CardEase,
    NoteCrt,
    NoteMod,
}

impl From<BrowseColumn> for Column {
    fn from(c: BrowseColumn) -> Self {
        match c {
            BrowseColumn::SortField => Column::SortField,
            BrowseColumn::Template => Column::Cards,
            BrowseColumn::Deck => Column::Deck,
            BrowseColumn::CardDue => Column::Due,
            BrowseColumn::CardIvl => Column::Interval,
            BrowseColumn::CardEase => Column::Ease,
            BrowseColumn::NoteCrt => Column::NoteCreation,
            BrowseColumn::NoteMod => Column::NoteMod,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseOrder {
    pub column: BrowseColumn,
    pub reverse: bool,
}

/// One row of the card table. Cells are plain text (Anki strips the HTML).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRow {
    pub card_id: i64,
    pub note_id: i64,
    pub sort_field: String,
    pub template: String,
    pub deck: String,
    pub due: String,
    /// 0 = no flag, 1..=7 = Anki's flag colors.
    pub flag: u8,
    pub marked: bool,
    pub suspended: bool,
    pub buried: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetOptions {
    pub restore_position: bool,
    pub reset_counts: bool,
}

/// Card ids matching an Anki search (`""` = whole collection). Invalid syntax is an
/// [`Error::Anki`] with Anki's (localized) explanation.
pub fn search(col: &mut Collection, query: &str, order: Option<BrowseOrder>) -> Result<Vec<i64>> {
    let query = query.trim();
    let mode = match order {
        Some(o) => SortMode::Builtin {
            column: o.column.into(),
            reverse: o.reverse,
        },
        None => SortMode::NoOrder,
    };
    Ok(col
        .search_cards(query, mode)?
        .into_iter()
        .map(|c| c.0)
        .collect())
}

/// Table rows for up to [`MAX_ROWS`] card ids, in the given order. Unknown ids are skipped.
pub fn rows(col: &mut Collection, card_ids: &[i64]) -> Result<Vec<BrowseRow>> {
    if card_ids.len() > MAX_ROWS {
        return Err(Error::InvalidInput(format!(
            "no máximo {MAX_ROWS} cards por vez."
        )));
    }
    if card_ids.is_empty() {
        return Ok(Vec::new());
    }
    // Cards mode + our columns, once per call (both are cheap and keep other users of the
    // browser state, like the Anki pages, from affecting us).
    if col.get_config_bool(BoolKey::BrowserTableShowNotesMode) {
        col.set_config_bool(BoolKey::BrowserTableShowNotesMode, false, false)?;
    }
    SearchService::set_active_browser_columns(
        col,
        anki_proto::generic::StringList {
            vals: ACTIVE_COLUMNS.iter().map(|s| s.to_string()).collect(),
        },
    )?;
    let states = card_states(col, card_ids)?;
    let mut out = Vec::with_capacity(card_ids.len());
    for &cid in card_ids {
        let Some(state) = states.get(&cid) else {
            continue;
        };
        let row = col.browser_row_for_id(cid)?;
        let mut cells = row.cells.into_iter().map(|c| c.text);
        let mut next = || cells.next().unwrap_or_default();
        out.push(BrowseRow {
            card_id: cid,
            note_id: state.note_id,
            sort_field: next(),
            template: next(),
            due: next(),
            deck: next(),
            flag: state.flag,
            marked: state.marked,
            suspended: state.suspended,
            buried: state.buried,
        });
    }
    Ok(out)
}

struct CardState {
    note_id: i64,
    flag: u8,
    marked: bool,
    suspended: bool,
    buried: bool,
}

/// Flags, queue and the "marked" tag of the given cards, in one query.
fn card_states(col: &mut Collection, card_ids: &[i64]) -> Result<HashMap<i64, CardState>> {
    const QUEUE_SUSPENDED: i64 = -1;
    const QUEUE_SCHED_BURIED: i64 = -2;
    const QUEUE_USER_BURIED: i64 = -3;
    let ids = card_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT c.id, c.nid, c.flags, c.queue, n.tags FROM cards c \
         JOIN notes n ON n.id = c.nid WHERE c.id IN ({ids})"
    );
    let db = col.storage.db();
    let mut stmt = db.prepare(&sql).map_err(AnkiError::from)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(AnkiError::from)?;
    let mut out = HashMap::with_capacity(card_ids.len());
    for row in rows {
        let (cid, nid, flags, queue, tags) = row.map_err(AnkiError::from)?;
        out.insert(
            cid,
            CardState {
                note_id: nid,
                flag: (flags & 0b111) as u8,
                marked: tags
                    .split_whitespace()
                    .any(|t| t.eq_ignore_ascii_case("marked")),
                suspended: queue == QUEUE_SUSPENDED,
                buried: queue == QUEUE_SCHED_BURIED || queue == QUEUE_USER_BURIED,
            },
        );
    }
    Ok(out)
}

fn card_ids(ids: &[i64]) -> Vec<CardId> {
    ids.iter().copied().map(CardId).collect()
}

fn note_ids(ids: &[i64]) -> Vec<NoteId> {
    ids.iter().copied().map(NoteId).collect()
}

/// Moves cards to a normal deck; returns how many changed.
pub fn set_deck(col: &mut Collection, card_ids_: &[i64], deck_id: i64) -> Result<u32> {
    let out = col.set_deck(&card_ids(card_ids_), DeckId(deck_id))?;
    Ok(u32::try_from(out.output).unwrap_or(u32::MAX))
}

/// Adds and removes whitespace-separated tags on notes (either may be empty).
pub fn tags(col: &mut Collection, note_ids_: &[i64], add: &str, remove: &str) -> Result<()> {
    let nids = note_ids(note_ids_);
    if !add.trim().is_empty() {
        col.add_tags_to_notes(&nids, add.trim())?;
    }
    if !remove.trim().is_empty() {
        col.remove_tags_from_notes(&nids, remove.trim())?;
    }
    Ok(())
}

/// Suspends, or reactivates (unsuspends and unburies) cards.
pub fn suspend(col: &mut Collection, card_ids_: &[i64], suspended: bool) -> Result<()> {
    let cids = card_ids(card_ids_);
    if suspended {
        col.bury_or_suspend_cards(&cids, BuryOrSuspendMode::Suspend)?;
    } else {
        col.unbury_or_unsuspend_cards(&cids)?;
    }
    Ok(())
}

/// "Esquecer": resets cards to new (logged in the revlog like Anki's browser does).
pub fn forget(col: &mut Collection, card_ids_: &[i64], opts: ForgetOptions) -> Result<()> {
    col.reschedule_cards_as_new(
        &card_ids(card_ids_),
        true,
        opts.restore_position,
        opts.reset_counts,
        None,
    )?;
    Ok(())
}

/// Deletes notes with all their cards; returns the number of notes deleted.
pub fn delete_notes(col: &mut Collection, note_ids_: &[i64]) -> Result<u32> {
    let out = col.remove_notes(&note_ids(note_ids_))?;
    Ok(u32::try_from(out.output).unwrap_or(u32::MAX))
}

/// The notetype shared by all the notes (needed by Anki's "Change notetype" page).
pub fn common_notetype(col: &mut Collection, note_ids_: &[i64]) -> Result<i64> {
    if note_ids_.is_empty() {
        return Err(Error::InvalidInput("nenhuma nota selecionada.".into()));
    }
    let mut found: Option<i64> = None;
    for &nid in note_ids_ {
        let note = col
            .storage
            .get_note(NoteId(nid))?
            .ok_or_else(|| Error::NotFound(format!("nota {nid}")))?;
        match found {
            None => found = Some(note.notetype_id.0),
            Some(ntid) if ntid != note.notetype_id.0 => {
                return Err(Error::InvalidInput(
                    "as notas selecionadas têm tipos de nota diferentes.".into(),
                ));
            }
            Some(_) => {}
        }
    }
    found.ok_or_else(|| Error::InvalidInput("nenhuma nota selecionada.".into()))
}
