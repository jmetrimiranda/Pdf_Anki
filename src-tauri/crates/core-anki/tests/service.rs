use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use anki::decks::tree::DeckCollapseScope;
use anki::import_export::package::{ExportAnkiPackageOptions, ImportAnkiPackageOptions};
use anki::prelude::TimestampMillis;
use anki::scheduler::answering::{CardAnswer, Rating};
use core_anki::demo::{ROS_DECK, VOCAB_DECK};
use core_anki::{AnkiService, Collection, Error, Result};

fn answer_first_card(col: &mut Collection, deck: &str, millis: u32) -> Result<()> {
    let did = col
        .get_deck_id(deck)?
        .ok_or_else(|| Error::NotFound(deck.into()))?;
    col.set_current_deck(did)?;
    let queued = col.get_queued_cards(1, false)?;
    let top = queued
        .cards
        .first()
        .ok_or_else(|| Error::NotFound("card na fila".into()))?;
    col.answer_card(&mut CardAnswer {
        card_id: top.card.id(),
        current_state: top.states.current,
        new_state: top.states.good,
        rating: Rating::Good,
        answered_at: TimestampMillis::now(),
        milliseconds_taken: millis,
        custom_data: None,
        from_queue: true,
    })?;
    Ok(())
}

#[test]
fn open_creates_collection_and_media_paths() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("dados");
    let svc = AnkiService::open(&root)?;
    assert!(svc.paths().collection.is_file());
    assert!(svc.paths().media_folder.is_dir());
    // Media paths must be wired up (spike lesson): media() fails without them.
    svc.call_blocking(|col| {
        col.media()?;
        Ok(())
    })?;
    svc.shutdown()?;
    assert!(matches!(svc.call_blocking(|_| Ok(())), Err(Error::Closed)));
    svc.shutdown()?;

    // Reopen the same folder after closing.
    let svc = AnkiService::open(&root)?;
    let tree = svc.call_blocking(core_anki::decks::deck_tree)?;
    assert_eq!(tree.decks.len(), 1, "only the Default deck: {tree:?}");
    Ok(())
}

#[test]
fn open_rejects_a_corrupt_collection_without_panicking() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    std::fs::write(dir.path().join("collection.anki2"), b"not a sqlite file")?;
    let err = AnkiService::open(dir.path()).err().expect("must fail");
    assert_eq!(err.code(), "anki.open");
    assert!(!err.to_string().is_empty());
    Ok(())
}

#[tokio::test]
async fn seed_demo_is_idempotent_and_builds_the_tree() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let svc = AnkiService::open(dir.path())?;
    assert_eq!(svc.seed_demo().await?, 2);
    assert_eq!(svc.seed_demo().await?, 0);
    let notes = svc
        .call(|col| Ok(col.search_notes_unordered("")?.len()))
        .await?;
    assert_eq!(notes, 2);

    let tree = svc.deck_tree().await?;
    let top: Vec<_> = tree.decks.iter().map(|d| d.full_name.as_str()).collect();
    assert_eq!(
        top,
        [ROS_DECK, "Vocabulário"],
        "empty Default deck is hidden"
    );

    let vocab = &tree.decks[1];
    assert_eq!((vocab.level, vocab.new_count), (1, 1));
    let livros = &vocab.children[0];
    assert_eq!(
        (livros.name.as_str(), livros.full_name.as_str()),
        ("Livros", "Vocabulário::Livros")
    );
    let teste = tree.find(VOCAB_DECK).expect("Teste deck");
    assert_eq!(teste.name, "Teste");
    assert_eq!(teste.level, 3);
    assert_eq!(
        (teste.new_count, teste.learn_count, teste.review_count),
        (1, 0, 0)
    );
    assert!(!vocab.collapsed && !livros.collapsed && !teste.collapsed);
    assert_eq!(tree.find(ROS_DECK).map(|d| d.new_count), Some(1));
    assert_eq!(
        (tree.studied_today.cards, tree.studied_today.seconds),
        (0, 0)
    );

    let vocab_id = vocab.id;
    svc.call(move |col| {
        col.set_deck_collapsed(
            anki::prelude::DeckId(vocab_id),
            true,
            DeckCollapseScope::Reviewer,
        )?;
        Ok(())
    })
    .await?;
    assert!(svc.deck_tree().await?.decks[1].collapsed);

    let json = serde_json::to_value(&tree)?;
    assert!(json["studiedToday"]["cards"].is_number());
    assert!(json["decks"][1]["children"][0]["fullName"].is_string());
    assert!(json["decks"][0]["newCount"].is_number());
    Ok(())
}

#[tokio::test]
async fn studied_today_counts_an_answer() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let svc = AnkiService::open(dir.path())?;
    svc.seed_demo().await?;
    svc.call(|col| answer_first_card(col, VOCAB_DECK, 4200))
        .await?;

    let tree = svc.deck_tree().await?;
    assert_eq!(tree.studied_today.cards, 1);
    assert_eq!(tree.studied_today.seconds, 4);
    let teste = tree.find(VOCAB_DECK).expect("Teste deck");
    assert_eq!((teste.new_count, teste.learn_count), (0, 1));
    Ok(())
}

#[test]
fn concurrent_calls_are_serialized() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let svc = AnkiService::open(dir.path())?;
    let busy = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicUsize::new(0));

    std::thread::scope(|s| {
        for _ in 0..8 {
            let (svc, busy, done) = (svc.clone(), busy.clone(), done.clone());
            s.spawn(move || {
                for _ in 0..5 {
                    let (busy, done) = (busy.clone(), done.clone());
                    svc.call_blocking(move |col| {
                        assert!(!busy.swap(true, Ordering::SeqCst), "overlapping jobs");
                        col.get_or_create_normal_deck("Concorrência")?;
                        std::thread::sleep(Duration::from_millis(2));
                        busy.store(false, Ordering::SeqCst);
                        done.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .expect("call");
                }
            });
        }
    });
    assert_eq!(done.load(Ordering::SeqCst), 40);
    Ok(())
}

#[test]
fn panicking_job_returns_error_and_actor_survives() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let svc = AnkiService::open(dir.path())?;
    let res: Result<()> = svc.call_blocking(|_| panic!("boom"));
    assert!(matches!(res, Err(Error::Panicked)));
    assert_eq!(svc.call_blocking(|_| Ok(7))?, 7);
    Ok(())
}

#[test]
fn reentrant_blocking_call_is_rejected() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let svc = AnkiService::open(dir.path())?;
    let nested: Result<()> = {
        let inner = svc.clone();
        svc.call_blocking(move |_| inner.call_blocking(|_| Ok(())))
    };
    assert!(matches!(nested, Err(Error::Reentrant)));
    Ok(())
}

#[test]
fn anki_errors_are_localized_and_typed() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let svc = AnkiService::open(dir.path())?;
    let err = svc
        .call_blocking(|col| answer_first_card(col, "Não existe", 1000))
        .expect_err("missing deck");
    assert_eq!(err.code(), "anki.notFound");
    let json = serde_json::to_value(&err)?;
    assert_eq!(json["code"], "anki.notFound");
    assert!(
        json["message"]
            .as_str()
            .is_some_and(|m| m.contains("Não existe"))
    );

    // An error raised by rslib itself (unbalanced parenthesis in a search).
    let err = svc
        .call_blocking(|col| Ok(col.search_notes_unordered("(")?.len()))
        .expect_err("bad search");
    assert_eq!(err.code(), "anki.backend");
    assert!(!err.to_string().is_empty());
    Ok(())
}

#[tokio::test]
async fn apkg_round_trip() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let a = AnkiService::open(&dir.path().join("a"))?;
    a.seed_demo().await?;
    let apkg = dir.path().join("vocab.apkg");
    let out = apkg.clone();
    let exported = a
        .call(move |col| {
            Ok(col.export_apkg(
                &out,
                ExportAnkiPackageOptions {
                    with_scheduling: true,
                    with_deck_configs: true,
                    with_media: true,
                    legacy: false,
                },
                "deck:Vocabulário",
                None,
            )?)
        })
        .await?;
    assert_eq!(exported, 1);

    let b = AnkiService::open(&dir.path().join("b"))?;
    let src = apkg.clone();
    let imported = b
        .call(move |col| {
            let log = col.import_apkg(
                &src,
                ImportAnkiPackageOptions {
                    merge_notetypes: true,
                    with_scheduling: true,
                    with_deck_configs: true,
                    ..Default::default()
                },
            )?;
            Ok(log.output.new.len())
        })
        .await?;
    assert_eq!(imported, 1);

    let tree = b.deck_tree().await?;
    assert_eq!(tree.find(VOCAB_DECK).map(|d| d.new_count), Some(1));
    assert!(tree.find(ROS_DECK).is_none());

    let (front, revlog_ms) = b
        .call(|col| {
            let did = col.get_deck_id(VOCAB_DECK)?.expect("deck");
            col.set_current_deck(did)?;
            let cid = col.get_queued_cards(1, false)?.cards[0].card.id();
            let front = col
                .render_existing_card(cid, false, false)?
                .question()
                .into_owned();
            answer_first_card(col, VOCAB_DECK, 4200)?;
            let ms: i64 = col
                .storage
                .db()
                .query_row("select sum(time) from revlog", [], |r| r.get(0))
                .map_err(anki::prelude::AnkiError::from)?;
            Ok((front, ms))
        })
        .await?;
    assert!(front.contains("windmill"), "{front}");
    assert_eq!(revlog_ms, 4200);
    Ok(())
}
