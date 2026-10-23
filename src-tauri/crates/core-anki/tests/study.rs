//! Study session and reviewer port on the fixture collection (docs/PROJETO.md 8.2, 8.4, 10.1, 20, 21).
mod common;

use std::time::Instant;

use anki::collection::CollectionBuilder;
use anki::prelude::{CardId, DeckConfigId, DeckId, I18n};
use anki::search::SortMode;
use core_anki::anki;
use core_anki::fixture::{self, BOOK_UID, FixtureOptions};
use core_anki::study::frontend::SetSchedulingStatesRequest;
use core_anki::study::render::{answer_for_review, render_for_review};
use core_anki::study::source::parse_source;
use core_anki::study::typeans::{TypeContext, TypeState, question_filter};
use core_anki::study::{
    AvTag, CardAction, QueueKind, SourceLink, Study, StudyCard, StudyNext,
    av::av_refs_to_play_icons,
};
use core_anki::{AnkiService, Collection, Error};

use common::{Fixture, fixture, sql_i64};

const PLAY_A0: &str = "\n<a class=\"replay-button soundLink\" href=# onclick=\"pycmd('play:a:0'); return false;\" draggable=\"false\">\n    <svg class=\"playImage\" viewBox=\"0 0 64 64\" version=\"1.1\">\n        <circle cx=\"32\" cy=\"32\" r=\"29\" />\n        <path d=\"M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z\" />\n    </svg>\n</a>";

fn deck(fx: &Fixture, name: &str) -> i64 {
    *fx.info
        .decks
        .get(name)
        .unwrap_or_else(|| panic!("no deck {name}"))
}

fn note(fx: &Fixture, role: &str) -> i64 {
    *fx.info
        .notes
        .get(role)
        .unwrap_or_else(|| panic!("no note {role}"))
}

fn card_of(next: &StudyNext) -> &StudyCard {
    next.card().expect("a card")
}

/// The note's card 1 (first template / cloze c1).
async fn card_of_note(svc: &AnkiService, nid: i64) -> anyhow::Result<CardId> {
    Ok(svc
        .call(move |col| {
            let cards =
                col.search_cards(format!("nid:{nid} card:1").as_str(), SortMode::NoOrder)?;
            Ok(cards[0])
        })
        .await?)
}

/// Both sides of a card through the reviewer pipeline.
async fn sides(
    svc: &AnkiService,
    cid: CardId,
    typed: Option<&str>,
) -> anyhow::Result<(String, String, Vec<AvTag>, Vec<AvTag>)> {
    let media = svc.paths().media_folder.clone();
    let typed = typed.map(str::to_string);
    Ok(svc
        .call(move |col| {
            let r = render_for_review(col, cid, &media)?;
            let a = answer_for_review(col, &r.answer_raw, &r.type_state, typed.as_deref())?;
            Ok((r.question_html, a, r.question_av, r.answer_av))
        })
        .await?)
}

/// `describe_next_states(get_scheduling_states(cid))`, computed independently of the session.
async fn labels(svc: &AnkiService, cid: i64) -> anyhow::Result<Vec<String>> {
    Ok(svc
        .call(move |col| {
            let states = col.get_scheduling_states(CardId(cid))?;
            Ok(col.describe_next_states(&states)?)
        })
        .await?)
}

#[tokio::test]
async fn buttons_equal_describe_next_states_for_new_learning_and_review() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let mut next = study.next(deck(&fx, fixture::DECK_WORDS)).await?;
    let mut seen = Vec::new();
    while let StudyNext::Card { card } = &next {
        assert_eq!(
            card.buttons.to_vec(),
            labels(&fx.svc, card.card_id).await?,
            "{:?} card {}",
            card.queue,
            card.card_id
        );
        assert!(card.show_intervals && card.show_counts);
        seen.push(card.queue);
        // Bury to move on without changing any other card's state.
        let res = study
            .card_action(card.card_id, CardAction::Bury, None)
            .await?;
        next = res.next.expect("bury moves on");
        assert!(seen.len() < 50, "the queue never ends");
    }
    for kind in [QueueKind::New, QueueKind::Learn, QueueKind::Review] {
        assert!(seen.contains(&kind), "no {kind:?} card in {seen:?}");
    }
    Ok(())
}

#[test]
fn new_card_labels_are_anki_defaults_in_english() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let dir = tmp.path().join("anki");
    let info = fixture::build(&dir, FixtureOptions::default())?;
    let paths = core_anki::CollectionPaths::in_dir(&dir);
    let mut col: Collection = CollectionBuilder::new(&paths.collection)
        .set_media_paths(paths.media_folder.clone(), paths.media_db.clone())
        .set_tr(I18n::template_only())
        .build()?;
    let cid = CardId(info.first_card[fixture::DECK_OXFORD_3000]);
    let states = col.get_scheduling_states(cid)?;
    // Again/Hard/Good are learning steps (1m 10m: exact). Easy is 4 days with rslib's interval fuzz (seeded by the
    // card id, which the fixture does not fix), so 3d..5d; the desktop shows the same fuzzed value.
    let labels = col.describe_next_states(&states)?;
    assert_eq!(labels[..3], ["<1m", "<6m", "<10m"]);
    assert!(
        ["3d", "4d", "5d"].contains(&labels[3].as_str()),
        "{labels:?}"
    );
    col.close(None)?;
    Ok(())
}

#[tokio::test]
async fn answer_time_is_capped_by_the_preset() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let card = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    assert_eq!(card.queue, QueueKind::New);
    assert_eq!(card.buttons.len(), 4);
    study.answer(card.card_id, 3, 10_000_000).await?;
    let cid = card.card_id;
    let (time, cap) = fx
        .svc
        .call(move |col| {
            let time = sql_i64(
                col,
                &format!("select time from revlog where cid = {cid} order by id desc limit 1"),
            )?;
            let cap = col
                .get_deck_config(DeckConfigId(1), true)?
                .unwrap_or_default()
                .inner
                .cap_answer_time_to_secs;
            Ok((time, cap))
        })
        .await?;
    assert_eq!(time, i64::from(cap) * 1000);
    assert_eq!(card.timer_max_secs, cap);
    Ok(())
}

#[tokio::test]
async fn undo_restores_the_answered_card_and_only_undoes_answers() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let first = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    assert!(!first.can_undo, "nothing answered yet");
    assert!(matches!(study.undo().await, Err(Error::UndoUnavailable)));

    let second = card_of(&study.answer(first.card_id, 3, 4_000).await?).clone();
    assert_ne!(second.card_id, first.card_id);
    assert!(second.can_undo);
    assert_ne!(second.counts, first.counts);

    let back = card_of(&study.undo().await?).clone();
    assert_eq!(back.card_id, first.card_id);
    assert_eq!(back.counts, first.counts);
    assert_eq!(back.question_html, first.question_html);

    // An operation that is not an answer makes Ctrl+Z unavailable.
    let again = card_of(&study.answer(back.card_id, 3, 4_000).await?).clone();
    assert!(again.can_undo);
    fx.svc
        .call(|col| core_anki::decks::create(col, "Outro deck"))
        .await?;
    assert!(matches!(study.undo().await, Err(Error::UndoUnavailable)));
    Ok(())
}

#[tokio::test]
async fn only_the_current_card_can_be_answered() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    assert!(matches!(
        study.answer(1, 3, 1000).await,
        Err(Error::NoStudySession)
    ));
    let card = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    assert!(matches!(
        study.answer(card.card_id + 1, 3, 1000).await,
        Err(Error::NotCurrentCard)
    ));
    assert!(matches!(
        study.show_answer(card.card_id + 1, None).await,
        Err(Error::NotCurrentCard)
    ));
    // After an error the card on screen is gone; the next call re-fetches it.
    let card = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    for bad in [0, 5] {
        assert!(matches!(
            study.answer(card.card_id, bad, 1000).await,
            Err(Error::InvalidInput(_))
        ));
    }
    study.close();
    assert!(matches!(
        study.show_answer(card.card_id, None).await,
        Err(Error::NoStudySession)
    ));
    Ok(())
}

#[tokio::test]
async fn image_and_audio_render_like_the_desktop() -> anyhow::Result<()> {
    let fx = fixture()?;
    let image = card_of_note(&fx.svc, note(&fx, "imagem")).await?;
    let (_, answer, _, _) = sides(&fx.svc, image, None).await?;
    assert!(
        answer.contains("<img src=\"fixture-image.png\">"),
        "{answer}"
    );
    assert!(answer.starts_with("<style>"));

    let audio = card_of_note(&fx.svc, note(&fx, "audio")).await?;
    let (question, answer, q_av, a_av) = sides(&fx.svc, audio, None).await?;
    assert!(q_av.is_empty());
    assert_eq!(
        a_av,
        [AvTag::Sound {
            file: fixture::AUDIO_FILE.into()
        }]
    );
    assert!(answer.contains(PLAY_A0), "{answer}");
    assert_eq!(av_refs_to_play_icons("[anki:play:a:0]"), PLAY_A0);
    assert!(!question.contains("[sound:"));
    Ok(())
}

#[tokio::test]
async fn front_side_keeps_question_audio_on_the_question_side() -> anyhow::Result<()> {
    let fx = fixture()?;
    let tts = card_of_note(&fx.svc, note(&fx, "tts")).await?;
    let (question, answer, q_av, a_av) = sides(&fx.svc, tts, None).await?;
    match q_av.as_slice() {
        [AvTag::Tts { text, lang, .. }] => {
            assert_eq!(lang, "en_US");
            assert_eq!(text, "windmill");
        }
        other => panic!("tts tag expected, got {other:?}"),
    }
    assert!(question.contains("pycmd('play:q:0')"));
    // {{FrontSide}} is injected after the AV extraction: its button still plays the question tag.
    assert!(answer.contains("pycmd('play:q:0')"), "{answer}");
    assert!(!answer.contains("play:a:"), "{answer}");
    assert!(a_av.is_empty());
    Ok(())
}

#[tokio::test]
async fn cloze_and_mathjax() -> anyhow::Result<()> {
    let fx = fixture()?;
    let c1 = card_of_note(&fx.svc, note(&fx, "cloze")).await?;
    let (question, answer, _, _) = sides(&fx.svc, c1, None).await?;
    assert!(question.contains("[...]"), "{question}");
    assert!(
        !question.contains(">verbo<"),
        "c1 must be hidden: {question}"
    );
    assert!(question.contains("data-cloze=\"verbo\""), "{question}");
    assert!(
        question.contains("sujeito"),
        "c2 is shown on c1's card: {question}"
    );
    assert!(answer.contains("verbo"));

    let math = card_of_note(&fx.svc, note(&fx, "matematica")).await?;
    let (question, answer, _, _) = sides(&fx.svc, math, None).await?;
    assert!(question.contains(r"\(\frac{a}{b}"), "{question}");
    assert!(answer.contains(r"\[x^2\]"), "{answer}");
    Ok(())
}

#[tokio::test]
async fn type_in_the_answer() -> anyhow::Result<()> {
    let fx = fixture()?;
    let cmd = card_of_note(&fx.svc, note(&fx, "comando")).await?;
    let (question, right, _, _) = sides(&fx.svc, cmd, Some("ros2 topic list")).await?;
    assert!(
        question.contains("<input type=text id=typeans"),
        "{question}"
    );
    assert!(right.contains("<code id=typeans>"), "{right}");
    assert!(right.contains("typeGood"));
    assert!(!right.contains("typeBad"));
    // The comparison goes after the <hr id=answer> of {{FrontSide}}.
    assert!(right.find("<hr id=answer>") < right.find("<code id=typeans>"));

    let (_, wrong, _, _) = sides(&fx.svc, cmd, Some("ros2 topik")).await?;
    assert!(
        wrong.contains("typeBad") || wrong.contains("typeMissed"),
        "{wrong}"
    );

    let (_, empty, _, _) = sides(&fx.svc, cmd, None).await?;
    assert!(
        empty.contains("<code id=typeans>ros2 topic list</code>"),
        "{empty}"
    );

    let stock = card_of_note(&fx.svc, note(&fx, "digitarResposta")).await?;
    let (question, answer, _, _) = sides(&fx.svc, stock, Some("colcon build")).await?;
    assert!(question.contains("id=typeans"));
    assert!(answer.contains("typeGood"));

    // Unknown field: the desktop's warning instead of the input.
    let html = fx
        .svc
        .call(|col| {
            let values = vec!["x".to_string()];
            let ctx = TypeContext {
                ord: 0,
                fields: vec![("Frente".into(), "Arial".into(), 20)],
                values: &values,
            };
            let mut state = TypeState::default();
            let out = question_filter(col, "a[[type:Nada]]b", &ctx, &mut state)?;
            assert!(state.type_correct.is_none());
            let expected = col
                .tr()
                .studying_type_answer_unknown_field("Nada")
                .into_owned();
            Ok((out, expected))
        })
        .await?;
    assert_eq!(html.0, format!("a{}b", html.1));
    assert!(html.0.contains("Nada"));
    Ok(())
}

#[tokio::test]
async fn missing_latex_images_get_the_desktop_message() -> anyhow::Result<()> {
    let fx = fixture()?;
    let media = fx.svc.paths().media_folder.clone();
    let (question, expected) = fx
        .svc
        .call(move |col| {
            let nt = core_anki::notetypes::stock_basic(col)?;
            let mut n = nt.new_note();
            n.set_field(0, "[$]x^2[/$]")?;
            n.set_field(1, "y")?;
            col.add_note(&mut n, DeckId(1))?;
            let cid = col.search_cards(format!("nid:{}", n.id.0).as_str(), SortMode::NoOrder)?[0];
            let r = render_for_review(col, cid, &media)?;
            Ok((
                r.question_html,
                col.tr()
                    .preferences_latex_generation_disabled()
                    .into_owned(),
            ))
        })
        .await?;
    assert!(question.contains("<img class=latex alt="), "{question}");
    assert!(question.contains(" src=\"latex-"), "{question}");
    assert!(question.ends_with(&expected), "{question}");
    Ok(())
}

#[tokio::test]
async fn fonte_link_becomes_open_in_book() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let card = card_of(&study.next(deck(&fx, fixture::DECK_ANIMAL_FARM)).await?).clone();
    assert_eq!(
        card.source,
        Some(SourceLink {
            book_uid: BOOK_UID.into(),
            page: 37,
            query: Some("windmill".into()),
            label: "Animal Farm, p. 37".into(),
        })
    );
    let other = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    assert_eq!(other.source, None);

    let uid = BOOK_UID;
    assert!(
        parse_source(&format!(
            "<a href=\"leitor://livro/{}?pagina=2\">x</a>",
            &uid[..63]
        ))
        .is_none()
    );
    assert!(parse_source(&format!("<a href=\"leitor://livro/{uid}?q=a\">x</a>")).is_none());
    let encoded = parse_source(&format!(
        "<a href=\"leitor://livro/{uid}?pagina=2&amp;q=old%20major%E2%80%99s\">p</a>"
    ))
    .unwrap();
    assert_eq!(encoded.query.as_deref(), Some("old major’s"));
    assert_eq!(encoded.page, 2);
    Ok(())
}

#[tokio::test]
async fn flag_mark_bury_and_suspend() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let a = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    assert_eq!((a.flag, a.marked), (0, false));

    let r = study
        .card_action(a.card_id, CardAction::Flag, Some(3))
        .await?;
    assert_eq!((r.flag, r.next.is_none()), (3, true));
    let r = study
        .card_action(a.card_id, CardAction::Flag, Some(3))
        .await?;
    assert_eq!(r.flag, 0, "the same flag again removes it");
    assert!(matches!(
        study
            .card_action(a.card_id, CardAction::Flag, Some(8))
            .await,
        Err(Error::InvalidInput(_))
    ));
    let a = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    let r = study
        .card_action(a.card_id, CardAction::Flag, Some(2))
        .await?;
    assert_eq!(r.flag, 2);

    let r = study.card_action(a.card_id, CardAction::Mark, None).await?;
    assert!(r.marked);
    let again = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    assert_eq!(again.card_id, a.card_id);
    assert!(again.marked && again.flag == 2);
    let r = study.card_action(a.card_id, CardAction::Mark, None).await?;
    assert!(!r.marked);

    let r = study.card_action(a.card_id, CardAction::Bury, None).await?;
    let b = card_of(r.next.as_ref().expect("next card")).clone();
    assert_ne!(b.card_id, a.card_id);
    let r = study
        .card_action(b.card_id, CardAction::Suspend, None)
        .await?;
    let c = card_of(r.next.as_ref().expect("next card")).clone();
    assert_ne!(c.card_id, b.card_id);

    let (buried, suspended, marked) = fx
        .svc
        .call(|col| {
            let buried = col.search_cards("is:buried", SortMode::NoOrder)?;
            let suspended = col.search_cards("is:suspended", SortMode::NoOrder)?;
            let marked = col.search_cards("tag:marked", SortMode::NoOrder)?;
            Ok((buried, suspended, marked))
        })
        .await?;
    assert_eq!(buried, [CardId(a.card_id)]);
    assert_eq!(suspended, [CardId(b.card_id)]);
    assert!(marked.is_empty());
    Ok(())
}

#[tokio::test]
async fn scheduling_states_for_custom_js() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    assert!(study.states_with_context().is_none());
    let card = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    assert!(card.state_mutation.is_none());

    let with_ctx = study.states_with_context().expect("a card is on screen");
    let states = with_ctx.states.clone().expect("states");
    assert_eq!(
        with_ctx.context.as_ref().map(|c| c.deck_name.as_str()),
        Some(fixture::DECK_OXFORD_3000)
    );
    assert!(
        states
            .current
            .as_ref()
            .and_then(|c| c.custom_data.as_ref())
            .is_some()
    );

    let key = study.session_key().expect("session");
    assert!(!study.set_states(SetSchedulingStatesRequest {
        key: format!("{key}0"),
        states: Some(states.clone()),
    }));
    // The right key replaces the states the answer will use (here: "Bom" gets "Fácil"'s state).
    let mut mutated = states.clone();
    mutated.good = states.easy.clone();
    assert!(study.set_states(SetSchedulingStatesRequest {
        key: key.clone(),
        states: Some(mutated.clone()),
    }));
    assert_eq!(
        study.states_with_context().and_then(|s| s.states),
        Some(mutated.clone())
    );
    // The answer buttons describe the mutated states (reviewer.py `_answerButtons` after `set_scheduling_states`).
    let side = study.show_answer(card.card_id, None).await?;
    let want = fx
        .svc
        .call(move |col| {
            Ok(col
                .describe_next_states(&anki::scheduler::states::SchedulingStates::from(mutated))?)
        })
        .await?;
    assert_eq!(side.buttons.to_vec(), want);
    assert_eq!(
        side.buttons[2], side.buttons[3],
        "Bom shows Fácil's interval"
    );
    assert_ne!(side.buttons[2], card.buttons[2]);
    let answered = study.answer(card.card_id, 3, 2_000).await?;
    // The key is renewed per card: a late request from the previous card's JS cannot touch the next card.
    let next_card = card_of(&answered).clone();
    let next_key = study.session_key().expect("session");
    assert_ne!(next_key, key);
    let before = study.states_with_context().and_then(|s| s.states);
    assert!(!study.set_states(SetSchedulingStatesRequest {
        key: key.clone(),
        states: Some(states.clone()),
    }));
    assert_eq!(study.states_with_context().and_then(|s| s.states), before);
    let side = study.show_answer(next_card.card_id, None).await?;
    assert_eq!(side.buttons, next_card.buttons);
    let cid = card.card_id;
    let queue = fx
        .svc
        .call(move |col| sql_i64(col, &format!("select queue from cards where id = {cid}")))
        .await?;
    assert_eq!(queue, 2, "answered with the easy state: review queue");

    // With a cardStateCustomizer the card carries the JS and the session key.
    fx.svc
        .call(|col| {
            col.set_config_string(
                anki::config::StringKey::CardStateCustomizer,
                "states.good.normal.review.scheduledDays = 1;",
                false,
            )?;
            Ok(())
        })
        .await?;
    let next = card_of(&study.next(deck(&fx, fixture::DECK_OXFORD_3000)).await?).clone();
    let m = next.state_mutation.expect("state mutation");
    assert_eq!(Some(m.key.clone()), study.session_key());
    assert_ne!(m.key, key);
    assert!(m.js.contains("scheduledDays"));
    study.reset();
    assert!(study.states_with_context().is_none());
    Ok(())
}

#[tokio::test]
async fn done_when_the_deck_is_empty() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    match study.next(deck(&fx, fixture::DECK_OXFORD_5000)).await? {
        StudyNext::Done {
            deck_name, counts, ..
        } => {
            assert_eq!(deck_name, fixture::DECK_OXFORD_5000);
            assert_eq!((counts.new, counts.learn, counts.review), (0, 0, 0));
        }
        other => panic!("expected done, got {other:?}"),
    }
    assert!(matches!(study.next(987_654).await, Err(Error::NotFound(_))));
    Ok(())
}

#[tokio::test]
async fn serializes_like_the_ts_contract() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let next = study.next(deck(&fx, fixture::DECK_WORDS)).await?;
    let json = serde_json::to_value(&next)?;
    assert_eq!(json["kind"], "card");
    let card = &json["card"];
    for key in [
        "cardId",
        "noteId",
        "deckId",
        "deckName",
        "questionHtml",
        "answerPreloadHtml",
        "bodyClass",
        "questionAv",
        "answerAv",
        "autoplay",
        "replayQuestionOnAnswer",
        "queue",
        "counts",
        "showCounts",
        "buttons",
        "showIntervals",
        "flag",
        "marked",
        "typeAnswer",
        "stateMutation",
        "source",
        "canUndo",
        "showTimer",
        "timerMaxSecs",
        "code",
    ] {
        assert!(card.get(key).is_some(), "missing {key}");
    }
    assert!(card["bodyClass"].as_str().unwrap().starts_with("card card"));
    assert!(card["code"].is_null(), "not a code card");
    let done = serde_json::to_value(StudyNext::Done {
        deck_id: 1,
        deck_name: "x".into(),
        counts: Default::default(),
        can_undo: false,
    })?;
    assert_eq!(
        done,
        serde_json::json!({"kind":"done","deckId":1,"deckName":"x","counts":{"new":0,"learn":0,"review":0},"canUndo":false})
    );
    let tts = serde_json::to_value(AvTag::Tts {
        text: "a".into(),
        lang: "en_US".into(),
        voices: vec![],
        speed: 1.0,
    })?;
    assert_eq!(
        tts,
        serde_json::json!({"kind":"tts","text":"a","lang":"en_US","voices":[],"speed":1.0})
    );
    assert_eq!(serde_json::to_value(CardAction::BuryNote)?, "buryNote");
    Ok(())
}

#[tokio::test]
async fn next_and_answer_are_fast() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let did = deck(&fx, fixture::DECK_WORDS);
    study.next(did).await?;
    let t = Instant::now();
    let card = card_of(&study.next(did).await?).clone();
    let next_ms = t.elapsed().as_millis();
    let t = Instant::now();
    study.answer(card.card_id, 3, 3_000).await?;
    let answer_ms = t.elapsed().as_millis();
    eprintln!("study next {next_ms} ms, answer {answer_ms} ms");
    assert!(
        next_ms < 200 && answer_ms < 200,
        "next {next_ms} ms, answer {answer_ms} ms"
    );
    Ok(())
}
