//! Demo content for the dev smoke command, so a fresh collection shows a deck tree.

use anki::collection::Collection;
use anki::decks::tree::DeckCollapseScope;
use anki::prelude::{DeckId, DeckKind, Note};
use anki::search::{SearchNode, SortMode};

use crate::error::{Error, Result};
use crate::notetypes::stock_basic;

pub const VOCAB_DECK: &str = "Vocabulário::Livros::Teste";
pub const ROS_DECK: &str = "ROS 2 — Revisão";

const DEMO_NOTES: [(&str, &str, &str); 2] = [
    (VOCAB_DECK, "windmill", "moinho de vento"),
    (
        ROS_DECK,
        "Qual comando lista os tópicos ativos no ROS 2?",
        "<code>ros2 topic list</code>",
    ),
];

/// Idempotent: creates each demo deck and adds its note only if the deck has no cards yet.
/// New decks are collapsed by default in Anki, so the demo path is expanded when first seeded.
/// Returns the number of notes added.
pub fn seed_demo(col: &mut Collection) -> Result<usize> {
    let basic = stock_basic(col)?;
    let mut added = 0;
    for (deck_name, front, back) in DEMO_NOTES {
        let deck_id = normal_deck(col, deck_name)?;
        let existing =
            col.search_cards(SearchNode::from_deck_id(deck_id, false), SortMode::NoOrder)?;
        if !existing.is_empty() {
            continue;
        }
        let mut note: Note = basic.new_note();
        note.set_field(0, front)?;
        note.set_field(1, back)?;
        col.add_note(&mut note, deck_id)?;
        expand_path(col, deck_name)?;
        added += 1;
    }
    Ok(added)
}

fn normal_deck(col: &mut Collection, name: &str) -> Result<DeckId> {
    let deck = col.get_or_create_normal_deck(name)?;
    if matches!(deck.kind, DeckKind::Filtered(_)) {
        return Err(Error::InvalidInput(format!(
            "o baralho \"{name}\" já existe como baralho filtrado"
        )));
    }
    Ok(deck.id)
}

fn expand_path(col: &mut Collection, full_name: &str) -> Result<()> {
    let mut prefix = String::new();
    for part in full_name.split("::") {
        if !prefix.is_empty() {
            prefix.push_str("::");
        }
        prefix.push_str(part);
        if let Some(did) = col.get_deck_id(&prefix)? {
            col.set_deck_collapsed(did, false, DeckCollapseScope::Reviewer)?;
        }
    }
    Ok(())
}
