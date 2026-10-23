//! "Revisar aqui" (spec 10.1): one place studies at a time, remember → switch → restore the current deck, Ctrl+Z only
//! for answers.
mod common;

use core_anki::fixture::{DECK_ANIMAL_FARM, DECK_OXFORD_3000, DECK_WORDS};
use core_anki::study::{MiniReviewClosed, Study, StudyNext, StudyOwner};
use core_anki::{AnkiService, Error};

use common::{Fixture, fixture};

fn deck(fx: &Fixture, name: &str) -> i64 {
    fx.info.decks[name]
}

async fn current_deck(svc: &AnkiService) -> i64 {
    svc.call(|col| Ok(col.get_current_deck()?.id.0))
        .await
        .unwrap()
}

async fn set_current(svc: &AnkiService, deck_id: i64) {
    svc.call(move |col| core_anki::decks::set_current(col, deck_id))
        .await
        .unwrap();
}

async fn last_op_is_answer(svc: &AnkiService) -> bool {
    svc.call(|col| {
        Ok(matches!(
            col.can_undo(),
            Some(core_anki::anki::undo::Op::AnswerCard)
        ))
    })
    .await
    .unwrap()
}

/// The last undoable operation and the collection's modification time: both change when a step is pushed.
async fn undo_marker(svc: &AnkiService) -> (Option<String>, i64) {
    svc.call(|col| {
        let op = col.can_undo().map(|op| format!("{op:?}"));
        let mtime = common::sql_i64(col, "SELECT mod FROM col")?;
        Ok((op, mtime))
    })
    .await
    .unwrap()
}

fn card_id(next: &StudyNext) -> i64 {
    next.card().expect("a card").card_id
}

fn can_undo(next: &StudyNext) -> bool {
    match next {
        StudyNext::Card { card } => card.can_undo,
        StudyNext::Done { can_undo, .. } => *can_undo,
    }
}

#[tokio::test]
async fn open_switches_and_close_restores_the_previous_deck() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let oxford = deck(&fx, DECK_OXFORD_3000);
    let words = deck(&fx, DECK_WORDS);
    set_current(&fx.svc, oxford).await;

    let opened = study.mini_review_open(words).await?;
    assert_eq!(opened.previous_deck_id, oxford);
    assert_eq!(opened.preempted, None);
    assert_eq!(
        current_deck(&fx.svc).await,
        words,
        "the chosen deck is current"
    );
    assert_eq!(study.owner(), Some(StudyOwner::Panel));

    // The deck switch is an operation, not an answer: no Ctrl+Z.
    assert!(!can_undo(&opened.next));
    assert!(matches!(study.undo().await, Err(Error::UndoUnavailable)));

    // Answer → Ctrl+Z works once → not again.
    let first = card_id(&opened.next);
    let after = study.answer(first, 3, 2_000).await?;
    assert!(can_undo(&after));
    let back = study.undo().await?;
    assert_eq!(card_id(&back), first);
    assert!(!can_undo(&back));
    assert!(matches!(study.undo().await, Err(Error::UndoUnavailable)));

    // Answer again, then close: the restore is an undoable SetCurrentDeck, so the answer can't be undone anymore.
    study.answer(first, 3, 2_000).await?;
    assert!(last_op_is_answer(&fx.svc).await);
    let closed = study.mini_review_close().await?;
    assert_eq!(
        closed,
        MiniReviewClosed {
            restored_deck_id: Some(oxford)
        }
    );
    assert_eq!(current_deck(&fx.svc).await, oxford);
    assert!(!last_op_is_answer(&fx.svc).await);
    assert_eq!(study.owner(), None);
    assert!(matches!(study.undo().await, Err(Error::NoStudySession)));

    // Closing again: nothing to restore.
    assert_eq!(study.mini_review_close().await?.restored_deck_id, None);
    Ok(())
}

#[tokio::test]
async fn the_tab_preempting_the_panel_wins() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let oxford = deck(&fx, DECK_OXFORD_3000);
    let words = deck(&fx, DECK_WORDS);
    let farm = deck(&fx, DECK_ANIMAL_FARM);
    set_current(&fx.svc, oxford).await;

    study.mini_review_open(farm).await?;
    let started = study.start(words, StudyOwner::Tab).await?;
    assert_eq!(started.preempted, Some(StudyOwner::Panel));
    assert_eq!(study.owner(), Some(StudyOwner::Tab));
    assert!(started.next.card().is_some());

    // The panel closing neither ends the tab's session nor touches its deck.
    assert!(!study.close_owner(StudyOwner::Panel));
    assert_eq!(study.mini_review_close().await?.restored_deck_id, None);
    assert_eq!(current_deck(&fx.svc).await, words);
    assert_eq!(study.owner(), Some(StudyOwner::Tab));

    // Opening the mini-review now preempts the tab and remembers the tab's deck.
    let opened = study.mini_review_open(farm).await?;
    assert_eq!(opened.preempted, Some(StudyOwner::Tab));
    assert_eq!(opened.previous_deck_id, words);
    assert_eq!(
        study.mini_review_close().await?.restored_deck_id,
        Some(words)
    );

    // Same owner continues (no preemption); `next` is the tab's start.
    study.next(words).await?;
    let again = study.start(oxford, StudyOwner::Tab).await?;
    assert_eq!(again.preempted, None);
    Ok(())
}

#[tokio::test]
async fn switching_book_decks_keeps_the_original_previous_deck() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let oxford = deck(&fx, DECK_OXFORD_3000);
    let words = deck(&fx, DECK_WORDS);
    let farm = deck(&fx, DECK_ANIMAL_FARM);
    set_current(&fx.svc, oxford).await;

    assert_eq!(study.mini_review_open(farm).await?.previous_deck_id, oxford);
    let second = study.mini_review_open(words).await?;
    assert_eq!(second.previous_deck_id, oxford);
    assert_eq!(second.preempted, None);
    assert_eq!(current_deck(&fx.svc).await, words);
    assert_eq!(
        study.mini_review_close().await?.restored_deck_id,
        Some(oxford)
    );
    assert_eq!(current_deck(&fx.svc).await, oxford);
    Ok(())
}

#[tokio::test]
async fn close_owner_only_closes_its_own_session() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    study.mini_review_open(deck(&fx, DECK_WORDS)).await?;
    assert!(!study.close_owner(StudyOwner::Tab));
    assert_eq!(study.owner(), Some(StudyOwner::Panel));
    assert!(study.session_key().is_some());
    assert!(study.close_owner(StudyOwner::Panel));
    assert_eq!(study.owner(), None);

    study.next(deck(&fx, DECK_WORDS)).await?;
    assert!(study.close_owner(StudyOwner::Tab));
    assert_eq!(study.owner(), None);
    Ok(())
}

#[tokio::test]
async fn reset_forgets_session_owner_and_previous_deck() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let oxford = deck(&fx, DECK_OXFORD_3000);
    let words = deck(&fx, DECK_WORDS);
    set_current(&fx.svc, oxford).await;
    study.mini_review_open(words).await?;
    study.reset();
    assert_eq!(study.owner(), None);
    assert_eq!(study.mini_review_close().await?.restored_deck_id, None);
    assert_eq!(current_deck(&fx.svc).await, words);

    // A new mini-review after the reset remembers the deck current now.
    let opened = study.mini_review_open(oxford).await?;
    assert_eq!(opened.previous_deck_id, words);
    Ok(())
}

#[tokio::test]
async fn previous_deck_deleted_meanwhile_is_not_restored() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let words = deck(&fx, DECK_WORDS);
    let temp = fx
        .svc
        .call(|col| core_anki::decks::create(col, "Temporário"))
        .await?;
    set_current(&fx.svc, temp).await;
    assert_eq!(study.mini_review_open(words).await?.previous_deck_id, temp);
    fx.svc
        .call(move |col| core_anki::decks::delete(col, temp))
        .await?;
    assert_eq!(study.mini_review_close().await?.restored_deck_id, None);
    assert_eq!(current_deck(&fx.svc).await, words);
    Ok(())
}

#[tokio::test]
async fn no_undo_step_when_the_deck_does_not_change() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let words = deck(&fx, DECK_WORDS);

    // The tab answers a card of the deck the mini-review will open.
    let first = study.next(words).await?;
    let after = study.answer(card_id(&first), 3, 1_000).await?;
    assert!(can_undo(&after));
    let before = undo_marker(&fx.svc).await;
    assert_eq!(before.0.as_deref(), Some("AnswerCard"));

    let opened = study.mini_review_open(words).await?;
    assert_eq!(opened.previous_deck_id, words);
    assert_eq!(opened.preempted, Some(StudyOwner::Tab));
    assert!(
        can_undo(&opened.next),
        "the last operation is still the answer"
    );
    assert_eq!(undo_marker(&fx.svc).await, before, "nothing was pushed");

    assert_eq!(study.mini_review_close().await?.restored_deck_id, None);
    assert_eq!(undo_marker(&fx.svc).await, before, "nothing was pushed");
    assert!(last_op_is_answer(&fx.svc).await);
    Ok(())
}

#[tokio::test]
async fn unknown_deck_is_an_error_and_keeps_no_previous() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let oxford = deck(&fx, DECK_OXFORD_3000);
    set_current(&fx.svc, oxford).await;
    assert!(matches!(
        study.mini_review_open(9_999_999).await,
        Err(Error::NotFound(_))
    ));
    assert_eq!(study.owner(), None, "no session left behind");
    assert_eq!(study.mini_review_close().await?.restored_deck_id, None);
    assert_eq!(current_deck(&fx.svc).await, oxford);
    Ok(())
}

#[test]
fn owner_and_results_serialize_in_camel_case() {
    assert_eq!(
        serde_json::to_value(StudyOwner::Panel).unwrap(),
        serde_json::json!("panel")
    );
    assert_eq!(
        serde_json::to_value(MiniReviewClosed {
            restored_deck_id: Some(3)
        })
        .unwrap(),
        serde_json::json!({"restoredDeckId": 3})
    );
}
