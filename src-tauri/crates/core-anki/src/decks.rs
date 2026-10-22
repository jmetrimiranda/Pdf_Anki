//! Deck list (docs/PROJETO.md 8.2 and 10.1). Functions take `&mut Collection` so they run inside
//! an [`crate::AnkiService`] job.

use anki::collection::Collection;
use anki::prelude::{AnkiError, TimestampSecs};
use anki_proto::decks::DeckTreeNode;

use crate::error::Result;
use crate::types::{DeckNode, DeckTree, StudiedToday};

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
        children,
    }
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
