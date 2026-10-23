//! The study session on the actor thread: the top of the queue, its render and its (possibly mutated) states.
//! Port of the desktop reviewer flow (`qt/aqt/reviewer.py`, `pylib/anki/scheduler/v3.py`).
use std::path::Path;

use anki::config::StringKey;
use anki::prelude::*;
use anki::scheduler::states::SchedulingStates as RsStates;
use anki::services::SchedulerService;
use anki_proto::scheduler::bury_or_suspend_cards_request::Mode as BuryOrSuspendMode;
use anki_proto::scheduler::card_answer::Rating as ProtoRating;
use anki_proto::scheduler::queued_cards::Queue;
use anki_proto::scheduler::{QueuedCards, SchedulingContext, SchedulingStates};

use super::render::{answer_for_review, render_for_review};
use super::source::{SOURCE_FIELD, parse_source};
use super::typeans::TypeState;
use super::types::*;
use crate::error::{Error, Result};

/// Tag the desktop uses for "Marcar" (`reviewer.py:1106`).
pub const MARKED_TAG: &str = "marked";

pub(crate) struct Session {
    pub deck_id: i64,
    /// Key of `setSchedulingStates` (`reviewer.py:162`): a random u64 in decimal. Unlike the desktop it is renewed
    /// for every card shown, so a late `setSchedulingStates` from the previous card's custom JS can never replace the
    /// states of the card now on screen.
    pub key: String,
    pub current: Option<Current>,
}

impl Session {
    pub fn new(deck_id: i64) -> Self {
        Self {
            deck_id,
            key: new_key(),
            current: None,
        }
    }
}

fn new_key() -> String {
    let (hi, lo) = uuid::Uuid::new_v4().as_u64_pair();
    (hi ^ lo.rotate_left(17)).to_string()
}

/// `describe_next_states` (`reviewer.py:916`) for the four answer buttons.
fn button_labels(col: &mut Collection, states: &SchedulingStates) -> Result<[String; 4]> {
    let labels = col.describe_next_states(&RsStates::from(states.clone()))?;
    let mut buttons: [String; 4] = Default::default();
    for (slot, label) in buttons.iter_mut().zip(labels) {
        *slot = label;
    }
    Ok(buttons)
}

pub(crate) struct Current {
    pub card_id: i64,
    pub note_id: i64,
    pub states: SchedulingStates,
    pub context: SchedulingContext,
    pub type_state: TypeState,
    /// `c.answer()`: the rendered answer before `prepare_card_text_for_display`.
    pub answer_raw: String,
    pub answer_av: Vec<AvTag>,
}

fn not_found(what: &str) -> Error {
    Error::NotFound(what.to_string())
}

fn can_undo_answer(col: &Collection) -> bool {
    matches!(col.can_undo(), Some(Op::AnswerCard))
}

fn counts_of(q: &QueuedCards) -> QueueCounts {
    QueueCounts {
        new: q.new_count,
        learn: q.learning_count,
        review: q.review_count,
    }
}

fn note_has_marked(note: &Note) -> bool {
    note.tags.iter().any(|t| t.eq_ignore_ascii_case(MARKED_TAG))
}

/// Shows the top of `session.deck_id`'s queue (making it the current deck first, like the desktop).
pub(crate) fn next(col: &mut Collection, session: &mut Session, media: &Path) -> Result<StudyNext> {
    session.current = None;
    session.key = new_key();
    let did = DeckId(session.deck_id);
    let deck = col.get_deck(did)?.ok_or_else(|| not_found("deck"))?;
    if col.get_current_deck()?.id != did {
        col.set_current_deck(did)?;
    }
    let queued: QueuedCards = col.get_queued_cards(1, false)?.into();
    let counts = counts_of(&queued);
    let Some(top) = queued.cards.into_iter().next() else {
        return Ok(StudyNext::Done {
            deck_id: session.deck_id,
            deck_name: deck.human_name(),
            counts,
            can_undo: can_undo_answer(col),
        });
    };
    let card = top.card.unwrap_or_default();
    let mut states = top.states.unwrap_or_default();
    // V3CardInfo.from_queue (reviewer.py:97-103): the backend leaves current.custom_data empty.
    if let Some(current) = states.current.as_mut() {
        current.custom_data = Some(card.custom_data.clone());
    }
    let context = top.context.unwrap_or_default();
    let queue = match Queue::try_from(top.queue).unwrap_or(Queue::New) {
        Queue::New => QueueKind::New,
        Queue::Learning => QueueKind::Learn,
        Queue::Review => QueueKind::Review,
    };

    let cid = CardId(card.id);
    let review = render_for_review(col, cid, media)?;
    let note = col
        .storage
        .get_note(NoteId(card.note_id))?
        .ok_or_else(|| not_found("note"))?;
    let notetype = col
        .get_notetype(note.notetype_id)?
        .ok_or_else(|| not_found("notetype"))?;
    let source = notetype
        .fields
        .iter()
        .position(|f| f.name.eq_ignore_ascii_case(SOURCE_FIELD))
        .and_then(|i| note.fields().get(i))
        .and_then(|html| parse_source(html));

    let buttons = button_labels(col, &states)?;

    let home_deck = if card.original_deck_id != 0 {
        DeckId(card.original_deck_id)
    } else {
        DeckId(card.deck_id)
    };
    let card_deck = col.get_deck(home_deck)?;
    let conf_id = card_deck
        .as_ref()
        .and_then(|d| d.config_id())
        .unwrap_or(DeckConfigId(1));
    let conf = col
        .get_deck_config(conf_id, true)?
        .unwrap_or_default()
        .inner;
    let js = col.get_config_string(StringKey::CardStateCustomizer);
    let state_mutation = (!js.trim().is_empty()).then(|| StateMutation {
        key: session.key.clone(),
        js,
    });

    let study_card = StudyCard {
        card_id: card.id,
        note_id: card.note_id,
        deck_id: home_deck.0,
        deck_name: card_deck.map(|d| d.human_name()).unwrap_or_default(),
        question_html: review.question_html,
        answer_preload_html: review.answer_preload_html,
        body_class: format!("card card{}", card.template_idx + 1),
        question_av: review.question_av,
        answer_av: review.answer_av.clone(),
        autoplay: !conf.disable_autoplay,
        replay_question_on_answer: !conf.skip_question_when_replaying_answer,
        queue,
        counts,
        show_counts: col.get_config_bool(BoolKey::ShowRemainingDueCountsInStudy),
        buttons,
        show_intervals: col.get_config_bool(BoolKey::ShowIntervalsAboveAnswerButtons),
        flag: (card.flags & 0b111) as u8,
        marked: note_has_marked(&note),
        type_answer: review.type_state.wants_input(),
        state_mutation,
        source,
        can_undo: can_undo_answer(col),
        show_timer: conf.show_timer,
        timer_max_secs: conf.cap_answer_time_to_secs,
    };
    session.current = Some(Current {
        card_id: card.id,
        note_id: card.note_id,
        states,
        context,
        type_state: review.type_state,
        answer_raw: review.answer_raw,
        answer_av: review.answer_av,
    });
    Ok(StudyNext::Card {
        card: Box::new(study_card),
    })
}

fn current_mut(session: &mut Session, card_id: i64) -> Result<&mut Current> {
    match session.current.as_mut() {
        Some(c) if c.card_id == card_id => Ok(c),
        _ => Err(Error::NotCurrentCard),
    }
}

/// `_showAnswer`: the munged answer (`typeAnsAnswerFilter` with the typed text) and its AV tags, plus the button
/// labels of the states the answer will use: like `_showEaseButtons` they are described from the states as they are
/// now, after any `setSchedulingStates` from the custom scheduling JS.
pub(crate) fn show_answer(
    col: &mut Collection,
    session: &mut Session,
    card_id: i64,
    typed: Option<&str>,
) -> Result<AnswerSide> {
    let current = current_mut(session, card_id)?;
    let html = answer_for_review(col, &current.answer_raw, &current.type_state, typed)?;
    let av = current.answer_av.clone();
    let states = current.states.clone();
    let buttons = button_labels(col, &states)?;
    Ok(AnswerSide { html, av, buttons })
}

/// `build_answer` + `answer_card` (`pylib/anki/scheduler/v3.py:66-98`), then the next card. `ms` is passed
/// uncapped; rslib caps it to the preset's maximum answer time.
pub(crate) fn answer(
    col: &mut Collection,
    session: &mut Session,
    media: &Path,
    card_id: i64,
    rating: u8,
    ms: u32,
) -> Result<StudyNext> {
    let rating = match rating {
        1 => ProtoRating::Again,
        2 => ProtoRating::Hard,
        3 => ProtoRating::Good,
        4 => ProtoRating::Easy,
        other => return Err(Error::InvalidInput(format!("resposta {other} (use 1 a 4)"))),
    };
    let current = current_mut(session, card_id)?;
    let states = &current.states;
    let new_state = match rating {
        ProtoRating::Again => states.again.clone(),
        ProtoRating::Hard => states.hard.clone(),
        ProtoRating::Good => states.good.clone(),
        ProtoRating::Easy => states.easy.clone(),
    };
    let input = anki_proto::scheduler::CardAnswer {
        card_id,
        current_state: states.current.clone(),
        new_state,
        rating: rating as i32,
        answered_at_millis: TimestampMillis::now().0,
        milliseconds_taken: ms,
    };
    let _changes = SchedulerService::answer_card(col, input)?;
    next(col, session, media)
}

/// Ctrl+Z: only when the last operation is an answer (spec 10.1).
pub(crate) fn undo(col: &mut Collection, session: &mut Session, media: &Path) -> Result<StudyNext> {
    if !can_undo_answer(col) {
        return Err(Error::UndoUnavailable);
    }
    col.undo()?;
    next(col, session, media)
}

pub(crate) fn card_action(
    col: &mut Collection,
    session: &mut Session,
    media: &Path,
    card_id: i64,
    action: CardAction,
    flag: Option<u8>,
) -> Result<CardActionResult> {
    let note_id = current_mut(session, card_id)?.note_id;
    let cid = CardId(card_id);
    let nid = NoteId(note_id);
    let note_cards = |col: &mut Collection| -> Result<Vec<CardId>> {
        Ok(col
            .storage
            .all_cards_of_note(nid)?
            .into_iter()
            .map(|c| c.id())
            .collect())
    };
    match action {
        CardAction::Bury | CardAction::BuryNote | CardAction::Suspend | CardAction::SuspendNote => {
            let cids = match action {
                CardAction::BuryNote | CardAction::SuspendNote => note_cards(col)?,
                _ => vec![cid],
            };
            let mode = match action {
                CardAction::Bury | CardAction::BuryNote => BuryOrSuspendMode::BuryUser,
                _ => BuryOrSuspendMode::Suspend,
            };
            col.bury_or_suspend_cards(&cids, mode)?;
            let next = next(col, session, media)?;
            Ok(CardActionResult {
                flag: 0,
                marked: false,
                next: Some(next),
            })
        }
        CardAction::Flag => {
            let wanted = flag.ok_or_else(|| Error::InvalidInput("bandeira ausente".into()))?;
            if wanted > 7 {
                return Err(Error::InvalidInput(format!(
                    "bandeira {wanted} (use 0 a 7)"
                )));
            }
            let current = card_flag(col, cid)?;
            // reviewer.py setFlag: choosing the card's flag again removes it.
            let new_flag = if wanted == current { 0 } else { wanted };
            col.set_card_flag(&[cid], u32::from(new_flag))?;
            let marked = note_marked(col, nid)?;
            Ok(CardActionResult {
                flag: new_flag,
                marked,
                next: None,
            })
        }
        CardAction::Mark => {
            if note_marked(col, nid)? {
                col.remove_tags_from_notes(&[nid], MARKED_TAG)?;
            } else {
                col.add_tags_to_notes(&[nid], MARKED_TAG)?;
            }
            Ok(CardActionResult {
                flag: card_flag(col, cid)?,
                marked: note_marked(col, nid)?,
                next: None,
            })
        }
    }
}

fn card_flag(col: &Collection, cid: CardId) -> Result<u8> {
    let card = col
        .storage
        .get_card(cid)?
        .ok_or_else(|| not_found("card"))?;
    Ok((anki_proto::cards::Card::from(card).flags & 0b111) as u8)
}

fn note_marked(col: &Collection, nid: NoteId) -> Result<bool> {
    let note = col
        .storage
        .get_note(nid)?
        .ok_or_else(|| not_found("note"))?;
    Ok(note_has_marked(&note))
}
