//! Deck list (docs/PROJETO.md 8.2 and 10.1). Functions take `&mut Collection` so they run inside
//! an [`crate::AnkiService`] job.

use anki::collection::Collection;
use anki::decks::tree::DeckCollapseScope;
use anki::prelude::{AnkiError, DeckId, DeckKind, TimestampSecs};
use anki_proto::decks::DeckTreeNode;

use crate::error::{Error, Result};
use crate::types::{DeckName, DeckNode, DeckTree, StudiedToday};

/// Same as the Anki deck list: today's counts with limits applied, the study-screen collapse
/// state, and the empty Default deck hidden (rslib's rule).
pub fn deck_tree(col: &mut Collection) -> Result<DeckTree> {
    let root = col.deck_tree(Some(TimestampSecs::now()))?;
    let decks = root
        .children
        .into_iter()
        .map(|n| to_deck_node(n, None))
        .collect();
    Ok(DeckTree {
        decks,
        studied_today: studied_today(col)?,
        current_deck_id: col.get_current_deck()?.id.0,
    })
}

fn to_deck_node(node: DeckTreeNode, parent: Option<&str>) -> DeckNode {
    let full_name = match parent {
        Some(parent) => format!("{parent}::{}", node.name),
        None => node.name.clone(),
    };
    let children = node
        .children
        .into_iter()
        .map(|c| to_deck_node(c, Some(&full_name)))
        .collect();
    DeckNode {
        id: node.deck_id,
        name: node.name,
        full_name,
        level: node.level,
        new_count: node.new_count,
        learn_count: node.learn_count,
        review_count: node.review_count,
        collapsed: node.collapsed,
        filtered: node.filtered,
        total: node.total_including_children,
        children,
    }
}

/// Creates a normal deck (parents too, "A::B::C"); returns its id. An existing normal deck with
/// that name is returned as-is; an existing filtered deck is an error.
pub fn create(col: &mut Collection, name: &str) -> Result<i64> {
    let name = validate_name(name)?;
    let deck = col.get_or_create_normal_deck(&name)?;
    if matches!(deck.kind, DeckKind::Filtered(_)) {
        return Err(Error::InvalidInput(format!(
            "já existe um baralho filtrado chamado \"{name}\"."
        )));
    }
    Ok(deck.id.0)
}

/// Renames a deck to a new full name (may move it under another parent, like Anki).
pub fn rename(col: &mut Collection, deck_id: i64, name: &str) -> Result<()> {
    let name = validate_name(name)?;
    existing(col, deck_id)?;
    col.rename_deck(DeckId(deck_id), &name)?;
    Ok(())
}

/// Moves decks under `parent_id` (`None` = top level). Moving a deck into itself or one of its
/// descendants is rejected.
pub fn move_decks(col: &mut Collection, deck_ids: &[i64], parent_id: Option<i64>) -> Result<()> {
    if let Some(parent) = parent_id {
        let target = existing(col, parent)?;
        if matches!(target.kind, DeckKind::Filtered(_)) {
            return Err(Error::InvalidInput(
                "um baralho filtrado não pode ter subbaralhos.".into(),
            ));
        }
        let target_name = target.human_name();
        for &did in deck_ids {
            let deck = existing(col, did)?;
            let name = deck.human_name();
            if did == parent || target_name.starts_with(&format!("{name}::")) {
                return Err(Error::InvalidInput(format!(
                    "não é possível mover \"{name}\" para dentro dele mesmo."
                )));
            }
        }
    } else {
        for &did in deck_ids {
            existing(col, did)?;
        }
    }
    let ids: Vec<DeckId> = deck_ids.iter().copied().map(DeckId).collect();
    col.reparent_decks(&ids, parent_id.map(DeckId))?;
    Ok(())
}

/// Deletes a deck and its subdecks; returns the number of cards deleted.
pub fn delete(col: &mut Collection, deck_id: i64) -> Result<u32> {
    existing(col, deck_id)?;
    let removed = col.remove_decks_and_child_decks(&[DeckId(deck_id)])?.output;
    Ok(u32::try_from(removed).unwrap_or(u32::MAX))
}

/// Collapse state of the Decks screen (Anki's "study" scope, not the browser's).
pub fn set_collapsed(col: &mut Collection, deck_id: i64, collapsed: bool) -> Result<()> {
    existing(col, deck_id)?;
    col.set_deck_collapsed(DeckId(deck_id), collapsed, DeckCollapseScope::Reviewer)?;
    Ok(())
}

/// Every deck (normal and filtered) with its full name, sorted case-insensitively.
pub fn names(col: &mut Collection) -> Result<Vec<DeckName>> {
    let normal: std::collections::HashSet<DeckId> = col
        .get_all_normal_deck_names(false)?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let mut out: Vec<DeckName> = col
        .get_all_deck_names(false)?
        .into_iter()
        .map(|(id, name)| DeckName {
            id: id.0,
            filtered: !normal.contains(&id),
            name,
        })
        .collect();
    out.sort_by_cached_key(|d| (d.name.to_lowercase(), d.id));
    Ok(out)
}

pub fn set_current(col: &mut Collection, deck_id: i64) -> Result<()> {
    existing(col, deck_id)?;
    col.set_current_deck(DeckId(deck_id))?;
    Ok(())
}

fn existing(col: &mut Collection, deck_id: i64) -> Result<std::sync::Arc<anki::decks::Deck>> {
    col.get_deck(DeckId(deck_id))?
        .ok_or_else(|| Error::NotFound(format!("baralho {deck_id}")))
}

/// Trims each `::` component; rejects empty names and empty components ("A::", "::B").
fn validate_name(name: &str) -> Result<String> {
    let parts: Vec<&str> = name.split("::").map(str::trim).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err(Error::InvalidInput(if name.trim().is_empty() {
            "o nome do baralho não pode ficar vazio.".into()
        } else {
            "cada parte do nome do baralho (entre \"::\") precisa ter texto.".into()
        }));
    }
    Ok(parts.join("::"))
}

/// Port of rslib's `storage.studied_today` (pub(crate)): reviews since the start of the Anki day,
/// excluding manual and rescheduled entries.
pub fn studied_today(col: &mut Collection) -> Result<StudiedToday> {
    const REVLOG_MANUAL: i64 = 4;
    const REVLOG_RESCHEDULED: i64 = 5;
    let day_start_ms = (col.timing_today()?.next_day_at.0 - 86_400) * 1000;
    let (cards, seconds): (u32, f64) = col
        .storage
        .db()
        .query_row(
            "SELECT COUNT(), coalesce(sum(time) / 1000.0, 0.0) FROM revlog \
             WHERE id > ? AND type != ? AND type != ?",
            [day_start_ms, REVLOG_MANUAL, REVLOG_RESCHEDULED],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(AnkiError::from)?;
    Ok(StudiedToday {
        cards,
        seconds: seconds.max(0.0).round() as u32,
    })
}
