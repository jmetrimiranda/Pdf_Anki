//! Vocabulary scanning on the collection side (spec 12.1, 12.3 A, 12.6): the vocabulary folder of the fixture
//! (opt-in), field samples, the known vocabulary with card statuses, the book's vocabulary notes, batch creation in
//! reading order and the "Família" field of "Vocabulário · Livro".
mod common;

use std::collections::HashMap;
use std::time::Instant;

use core_anki::anki::notes::AddNoteRequest;
use core_anki::anki::prelude::{CardId, DeckId, NotetypeId};
use core_anki::anki::search::SortMode;
use core_anki::fixture::{
    BOOK_UID, DECK_VOCAB, DECK_VOCAB_BASIC, DECK_VOCAB_EMPTY, DECK_VOCAB_OXFORD, FixtureOptions,
    VOCAB_FRONT_NOTETYPE, VOCAB_NOTES, VOCAB_WORD_NOTETYPE,
};
use core_anki::notetypes::{self, FAMILY_FIELD, FAMILY_LINE, VOCAB_BOOK};
use core_anki::study::source::source_html;
use core_anki::vocab::{
    NoteStatusRaw, VocabBookFields, VocabNoteSpec, VocabNotesPlan, known_notes,
};
use core_anki::{AnkiService, Collection, Error};

use common::{fixture_with, sql_i64};

fn vocab_fixture() -> anyhow::Result<common::Fixture> {
    fixture_with(FixtureOptions {
        vocab: true,
        ..Default::default()
    })
}

fn fields(word: &str, familia: &str, card2: &str) -> VocabBookFields {
    VocabBookFields {
        palavra: word.into(),
        lema: word.into(),
        classe: "noun".into(),
        definicao: format!("definition of {word}"),
        traducao: format!("tradução de {word}"),
        exemplo: format!("The <b>{word}</b> was there."),
        fonte: source_html(BOOK_UID, "Animal Farm", 21, word),
        frequencia: "3.1".into(),
        familia: familia.into(),
        card2: card2.into(),
    }
}

fn spec(deck: &str, word: &str) -> VocabNoteSpec {
    VocabNoteSpec {
        deck_name: deck.into(),
        fields: fields(word, "", ""),
        tags: vec!["livro::animal-farm".into(), "trecho::cap-3".into()],
    }
}

#[tokio::test]
async fn default_fixture_has_no_vocabulary_folder() -> anyhow::Result<()> {
    let fx = common::fixture()?;
    assert!(!fx.info.decks.contains_key(DECK_VOCAB));
    assert!(!fx.info.notetypes.contains_key("vocabWord"));
    Ok(())
}

#[tokio::test]
async fn folder_recurses_and_counts() -> anyhow::Result<()> {
    let fx = vocab_fixture()?;
    let root = fx.info.decks[DECK_VOCAB];
    let info = fx.svc.vocab_folder(root).await?;
    assert_eq!(info.root.deck_id, root);
    assert_eq!(info.root.name, DECK_VOCAB);
    let decks: Vec<(&str, u32, u32, u32)> = info
        .decks
        .iter()
        .map(|d| (d.name.as_str(), d.depth, d.card_count, d.note_count))
        .collect();
    assert_eq!(
        decks,
        [
            (DECK_VOCAB, 0, 0, 0),
            (DECK_VOCAB_BASIC, 1, 6, 6),
            (DECK_VOCAB_OXFORD, 1, 5, 5),
            (DECK_VOCAB_EMPTY, 1, 0, 0),
        ]
    );
    let types: Vec<(&str, Vec<&str>, u32)> = info
        .notetypes
        .iter()
        .map(|n| {
            (
                n.name.as_str(),
                n.fields.iter().map(String::as_str).collect(),
                n.note_count,
            )
        })
        .collect();
    assert_eq!(
        types,
        [
            (VOCAB_FRONT_NOTETYPE, vec!["Front", "Back"], 5),
            (VOCAB_WORD_NOTETYPE, vec!["Word", "Meaning", "Audio"], 6),
        ]
    );
    assert_eq!(
        info.notetypes[0].notetype_id,
        fx.info.notetypes["vocabFront"]
    );

    // A subfolder: only it and its descendants; a grandchild is depth 2.
    let oxford = fx.info.decks[DECK_VOCAB_OXFORD];
    let child = fx
        .svc
        .call(|col| core_anki::decks::create(col, "Vocabulário::Oxford::B2"))
        .await?;
    let sub = fx.svc.vocab_folder(oxford).await?;
    let names: Vec<(&str, u32)> = sub
        .decks
        .iter()
        .map(|d| (d.name.as_str(), d.depth))
        .collect();
    assert_eq!(
        names,
        [(DECK_VOCAB_OXFORD, 0), ("Vocabulário::Oxford::B2", 1)]
    );
    let whole = fx.svc.vocab_folder(root).await?;
    assert!(
        whole
            .decks
            .iter()
            .any(|d| d.deck_id == child && d.depth == 2)
    );

    let err = fx.svc.vocab_folder(9_999_999).await.unwrap_err();
    assert!(matches!(err, Error::DeckNotFound(9_999_999)), "{err}");
    assert_eq!(err.code(), "deck_not_found");
    Ok(())
}

#[tokio::test]
async fn samples_come_in_note_order() -> anyhow::Result<()> {
    let fx = vocab_fixture()?;
    let basic = fx.info.decks[DECK_VOCAB_BASIC];
    let oxford = fx.info.decks[DECK_VOCAB_OXFORD];
    let word = fx.info.notetypes["vocabWord"];
    let front = fx.info.notetypes["vocabFront"];
    let samples = fx
        .svc
        .vocab_field_samples(vec![basic, oxford], word, 0, 3)
        .await?;
    assert_eq!(
        samples,
        [
            "<b>learn</b> [sound:learn.mp3]",
            "happy / glad",
            "{{c1::quick}}"
        ]
    );
    let all = fx
        .svc
        .vocab_field_samples(vec![oxford], front, 1, 50)
        .await?;
    assert_eq!(all.len(), 5);
    assert_eq!(all[0], "interesse");
    // Wrong deck, out-of-range field, n = 0.
    assert!(
        fx.svc
            .vocab_field_samples(vec![basic], front, 0, 5)
            .await?
            .is_empty()
    );
    assert!(
        fx.svc
            .vocab_field_samples(vec![basic], word, 7, 5)
            .await?
            .is_empty()
    );
    assert!(
        fx.svc
            .vocab_field_samples(vec![basic], word, 0, 0)
            .await?
            .is_empty()
    );
    Ok(())
}

fn status_by_word(rows: &[(i64, String, NoteStatusRaw)]) -> HashMap<String, NoteStatusRaw> {
    rows.iter().map(|(_, f, s)| (f.clone(), *s)).collect()
}

#[tokio::test]
async fn known_notes_statuses_threshold_and_suspension() -> anyhow::Result<()> {
    let fx = vocab_fixture()?;
    let decks: Vec<i64> = [
        DECK_VOCAB,
        DECK_VOCAB_BASIC,
        DECK_VOCAB_OXFORD,
        DECK_VOCAB_EMPTY,
    ]
    .iter()
    .map(|d| fx.info.decks[*d])
    .collect();
    let mapping: HashMap<i64, usize> = [
        (fx.info.notetypes["vocabWord"], 0),
        (fx.info.notetypes["vocabFront"], 0),
    ]
    .into();
    let rows = fx
        .svc
        .vocab_known_notes(decks.clone(), mapping.clone(), 21)
        .await?;
    assert_eq!(rows.len(), VOCAB_NOTES.len());
    assert!(rows.windows(2).all(|w| w[0].0 < w[1].0), "note id order");
    let by = status_by_word(&rows);
    use NoteStatusRaw::*;
    for (word, status) in [
        ("<b>learn</b> [sound:learn.mp3]", Mature),
        ("happy / glad", Mature),
        ("{{c1::quick}}", Learning),
        ("feel (v.)", Mature),
        ("mean; meaning", Learning),
        ("build", New),
        ("interest", Mature),
        ("farm", Mature),
        ("animal", New),
        ("windmill", Suspended),
        ("look up", Learning),
    ] {
        assert_eq!(by[word], status, "{word}");
    }
    // Interval 21 is mature at 21 days, learning at 22.
    let stricter = status_by_word(
        &fx.svc
            .vocab_known_notes(decks.clone(), mapping.clone(), 22)
            .await?,
    );
    assert_eq!(stricter["interest"], Learning);
    assert_eq!(stricter["farm"], Mature);
    // Only mapped types, only the given decks.
    let only_front: HashMap<i64, usize> = [(fx.info.notetypes["vocabFront"], 1)].into();
    let rows = fx
        .svc
        .vocab_known_notes(vec![fx.info.decks[DECK_VOCAB_OXFORD]], only_front, 21)
        .await?;
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[0].1, "interesse");
    assert!(
        fx.svc
            .vocab_known_notes(vec![], mapping.clone(), 21)
            .await?
            .is_empty()
    );

    // A note with two cards: suspended only when both are.
    let oxford = fx.info.decks[DECK_VOCAB_OXFORD];
    let (vocab_type, cards) = fx
        .svc
        .call(move |col| {
            notetypes::prepare_collection(col)?;
            let nt = col.get_notetype_by_name(VOCAB_BOOK)?.expect("vocab type");
            let mut note = nt.new_note();
            note.set_field(0, "pig")?;
            note.set_field(4, "porco")?;
            note.set_field(9, "1")?;
            col.add_note(&mut note, DeckId(oxford))?;
            let mut cards =
                col.search_cards(format!("nid:{}", note.id.0).as_str(), SortMode::NoOrder)?;
            cards.sort();
            Ok((nt.id.0, cards))
        })
        .await?;
    assert_eq!(cards.len(), 2, "Card 2 filled → two cards");
    let map: HashMap<i64, usize> = [(vocab_type, 0)].into();
    fx.svc
        .call({
            let first = cards[0];
            move |col| {
                col.storage
                    .db()
                    .execute(
                        &format!("UPDATE cards SET queue = -1 WHERE id = {}", first.0),
                        [],
                    )
                    .map_err(core_anki::anki::prelude::AnkiError::from)?;
                Ok(())
            }
        })
        .await?;
    let rows = fx
        .svc
        .vocab_known_notes(vec![oxford], map.clone(), 21)
        .await?;
    assert_eq!(rows, [(rows[0].0, "pig".to_string(), New)]);
    fx.svc
        .call(move |col| {
            col.storage
                .db()
                .execute(
                    "UPDATE cards SET queue = -1 WHERE nid = (SELECT nid FROM cards WHERE id = ?1)",
                    [cards[1].0],
                )
                .map_err(core_anki::anki::prelude::AnkiError::from)?;
            Ok(())
        })
        .await?;
    let rows = fx.svc.vocab_known_notes(vec![oxford], map, 21).await?;
    assert_eq!(rows[0].2, Suspended);
    Ok(())
}

/// 20 000 notes are read quickly (spec 12.8).
#[tokio::test]
async fn known_notes_of_twenty_thousand_notes_are_fast() -> anyhow::Result<()> {
    let fx = vocab_fixture()?;
    let oxford = fx.info.decks[DECK_VOCAB_OXFORD];
    let front = fx.info.notetypes["vocabFront"];
    fx.svc
        .call(move |col| {
            let nt = col.get_notetype(NotetypeId(front))?.expect("type");
            let mut requests: Vec<AddNoteRequest> = (0..20_000)
                .map(|i| {
                    let mut note = nt.new_note();
                    note.set_field(0, format!("word{i}"))?;
                    note.set_field(1, "x")?;
                    Ok(AddNoteRequest {
                        note,
                        deck_id: DeckId(oxford),
                    })
                })
                .collect::<core_anki::Result<_>>()?;
            col.add_notes(&mut requests)?;
            Ok(())
        })
        .await?;
    let mapping: HashMap<i64, usize> = [(front, 0)].into();
    let (rows, took) = fx
        .svc
        .call(move |col| {
            let t = Instant::now();
            let rows = known_notes(col, &[oxford], &mapping, 21)?;
            Ok((rows, t.elapsed()))
        })
        .await?;
    println!("known_notes of {} notes: {took:?}", rows.len());
    assert_eq!(rows.len(), 20_005);
    let limit = if cfg!(debug_assertions) { 0.6 } else { 0.15 };
    assert!(took.as_secs_f64() < limit, "{took:?}");
    Ok(())
}

#[tokio::test]
async fn add_vocab_notes_in_reading_order_with_decks_and_tags() -> anyhow::Result<()> {
    let fx = vocab_fixture()?;
    let chapter = "Vocabulário::Livros::Animal Farm::Cap 3";
    let other = "Vocabulário::Livros::Animal Farm::Cap 4";
    let mut plan = VocabNotesPlan {
        notes: vec![
            spec(chapter, "windmill"),
            spec(chapter, "comrade"),
            spec(other, "harvest"),
            spec(chapter, "pig"),
        ],
    };
    plan.notes[1].fields.familia = "learn".into();
    plan.notes[3].fields.card2 = "1".into();
    plan.notes[0].tags.push("  dois  nomes ".into());
    plan.notes[0].tags.push("   ".into());
    let nids = fx.svc.vocab_add_notes(plan.clone()).await?;
    assert_eq!(nids.len(), 4);

    let (deck_names, chapter_id, positions, tags, card_counts) = fx
        .svc
        .call(move |col| {
            let names = common::deck_names(col)?;
            let chapter_id = core_anki::book::deck_by_name(col, chapter)?.expect("chapter deck");
            let mut positions = Vec::new();
            let mut tags = Vec::new();
            let mut counts = Vec::new();
            for nid in &nids {
                positions.push(sql_i64(
                    col,
                    &format!("SELECT min(due) FROM cards WHERE nid = {nid} AND type = 0"),
                )?);
                counts.push(sql_i64(
                    col,
                    &format!("SELECT count(*) FROM cards WHERE nid = {nid}"),
                )?);
                let note = col
                    .storage
                    .get_note(core_anki::anki::notes::NoteId(*nid))?
                    .expect("note");
                tags.push(note.tags.clone());
            }
            Ok((names, chapter_id, positions, tags, counts))
        })
        .await?;
    assert!(deck_names.iter().any(|n| n == chapter), "{deck_names:?}");
    assert!(deck_names.iter().any(|n| n == other));
    assert!(
        deck_names
            .iter()
            .any(|n| n == "Vocabulário::Livros::Animal Farm")
    );
    assert!(chapter_id > 0);
    assert!(
        positions.windows(2).all(|w| w[0] < w[1]),
        "due positions follow the plan: {positions:?}"
    );
    assert_eq!(
        tags[0],
        ["dois_nomes", "livro::animal-farm", "trecho::cap-3"]
    );
    assert_eq!(tags[1], ["livro::animal-farm", "trecho::cap-3"]);
    assert_eq!(
        card_counts,
        [1, 1, 1, 2],
        "Card 2 only when its field is filled"
    );

    // The new cards come after every existing new card.
    let max_other = fx
        .svc
        .call(move |col| {
            sql_i64(
                col,
                "SELECT max(due) FROM cards WHERE type = 0 AND nid NOT IN \
                 (SELECT id FROM notes WHERE flds LIKE '%leitor://livro/%' AND mid = \
                 (SELECT id FROM notetypes WHERE name = 'Vocabulário · Livro'))",
            )
        })
        .await?;
    assert!(positions[0] > max_other, "{positions:?} after {max_other}");

    // An empty plan does nothing; an invalid deck name is refused before anything is written.
    assert!(
        fx.svc
            .vocab_add_notes(VocabNotesPlan::default())
            .await?
            .is_empty()
    );
    let before = fx
        .svc
        .call(|col| sql_i64(col, "SELECT count(*) FROM notes"))
        .await?;
    let bad = VocabNotesPlan {
        notes: vec![spec("Vocabulário::Novo", "a"), spec("Vocabulário::", "b")],
    };
    let err = fx.svc.vocab_add_notes(bad).await.unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err}");
    let after = fx
        .svc
        .call(|col| sql_i64(col, "SELECT count(*) FROM notes"))
        .await?;
    assert_eq!(before, after);
    let names = fx.svc.call(common::deck_names).await?;
    assert!(!names.iter().any(|n| n == "Vocabulário::Novo"));
    Ok(())
}

#[tokio::test]
async fn book_vocab_notes_follow_moved_notes() -> anyhow::Result<()> {
    let fx = vocab_fixture()?;
    let deck = "Vocabulário::Livros::Animal Farm";
    let mut plan = VocabNotesPlan {
        notes: vec![
            spec(deck, "windmill"),
            spec(deck, "comrade"),
            spec(deck, "harvest"),
        ],
    };
    plan.notes[1].fields.lema = "<b>Comrade</b>".into();
    plan.notes[2].fields.lema = String::new();
    plan.notes[2].fields.palavra = "Harvests".into();
    // Another book's note is not listed.
    let other_uid = "f".repeat(64);
    let mut foreign = spec(deck, "tractor");
    foreign.fields.fonte = source_html(&other_uid, "Outro", 3, "tractor");
    plan.notes.push(foreign);
    let nids = fx.svc.vocab_add_notes(plan).await?;
    let farm = fx
        .svc
        .call(move |col| Ok(core_anki::book::deck_by_name(col, deck)?.expect("deck")))
        .await?;
    // Move "comrade" out of the folder.
    let elsewhere = fx.info.decks[core_anki::fixture::DECK_WORDS];
    let moved = nids[1];
    fx.svc
        .call(move |col| {
            let cids: Vec<CardId> =
                col.search_cards(format!("nid:{moved}").as_str(), SortMode::NoOrder)?;
            col.set_deck(&cids, DeckId(elsewhere))?;
            Ok(())
        })
        .await?;
    let found = fx.svc.vocab_book_notes(BOOK_UID.to_string()).await?;
    assert_eq!(
        found,
        [
            (nids[0], "windmill".to_string(), farm),
            (nids[1], "comrade".to_string(), elsewhere),
            (nids[2], "harvests".to_string(), farm),
        ]
    );
    assert!(fx.svc.vocab_book_notes("f".repeat(63)).await.is_err());
    assert_eq!(fx.svc.vocab_book_notes(other_uid).await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn add_vocab_notes_needs_the_prepared_type() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;
    let err = svc
        .vocab_add_notes(VocabNotesPlan {
            notes: vec![spec("Vocabulário", "pig")],
        })
        .await
        .unwrap_err();
    assert!(matches!(err, Error::VocabPrepareNeeded), "{err}");
    assert_eq!(err.code(), "vocab_prepare_needed");
    assert_eq!(
        err.to_string(),
        "Prepare a coleção para criar os cards de vocabulário."
    );
    // Nothing was created, not even the deck; reading without the type is empty, not an error.
    let names = svc.call(common::deck_names).await?;
    assert!(names.is_empty(), "{names:?}");
    assert!(svc.vocab_book_notes(BOOK_UID.to_string()).await?.is_empty());
    Ok(())
}

#[test]
fn familia_field_and_back_line_in_the_definition() {
    let nt = notetypes::definition(VOCAB_BOOK).expect("definition");
    let names: Vec<&str> = nt.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Palavra",
            "Lema",
            "Classe",
            "Definição",
            "Tradução",
            "Exemplo",
            "Fonte",
            "Frequência",
            "Família",
            "Card 2"
        ]
    );
    assert_eq!(FAMILY_FIELD, "Família");
    assert_eq!(
        FAMILY_LINE,
        "{{#Família}}Da família de: {{Família}}{{/Família}}"
    );
    let back = &nt.templates[0].config.a_format;
    assert!(
        back.contains("{{#Família}}Da família de: {{Família}}{{/Família}}"),
        "{back}"
    );
    assert!(back.contains("Da família de: {{Família}}"));
    assert_eq!(
        nt.templates[1].config.q_format,
        "{{#Card 2}}{{Tradução}}{{/Card 2}}"
    );
    assert!(nt.config.css.contains(".familia{"));
}

fn render_answer(
    col: &mut Collection,
    nid: i64,
    media: &std::path::Path,
) -> core_anki::Result<String> {
    let cid = sql_i64(
        col,
        &format!("SELECT id FROM cards WHERE nid = {nid} AND ord = 0"),
    )?;
    Ok(core_anki::study::render::render_card(col, CardId(cid), media)?.answer)
}

#[tokio::test]
async fn familia_line_renders_only_when_filled() -> anyhow::Result<()> {
    let fx = vocab_fixture()?;
    let deck = "Vocabulário::Livros::Animal Farm";
    let mut plan = VocabNotesPlan {
        notes: vec![spec(deck, "learner"), spec(deck, "pig")],
    };
    plan.notes[0].fields.familia = "learn".into();
    let nids = fx.svc.vocab_add_notes(plan).await?;
    let media = fx.dir().join("collection.media");
    let (with, without) = fx
        .svc
        .call(move |col| {
            Ok((
                render_answer(col, nids[0], &media)?,
                render_answer(col, nids[1], &media)?,
            ))
        })
        .await?;
    assert!(with.contains("Da família de: learn"), "{with}");
    assert!(!without.contains("Da família de"), "{without}");
    assert!(without.contains("definition of pig"));
    Ok(())
}

async fn vocab_type_state(svc: &AnkiService) -> core_anki::Result<(Vec<String>, i64, String)> {
    svc.call(|col| {
        let nt = col.get_notetype_by_name(VOCAB_BOOK)?.expect("type");
        Ok((
            nt.fields.iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
            nt.mtime_secs.0,
            nt.templates[0].config.a_format.clone(),
        ))
    })
    .await
}

/// A collection prepared before 2026-10-23 has the 9-field type: "Preparar coleção" leaves it alone and the vocab
/// notes still go in (without the family).
#[tokio::test]
async fn prepare_keeps_the_old_type_and_notes_still_work() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;
    svc.call(|col| {
        let mut nt = notetypes::definition(VOCAB_BOOK)?;
        nt.fields.retain(|f| f.name != FAMILY_FIELD);
        for t in &mut nt.templates {
            t.config.a_format = t.config.a_format.replace(FAMILY_LINE, "");
        }
        nt.id = NotetypeId(0);
        col.add_notetype(&mut nt, false)?;
        Ok(())
    })
    .await?;
    let before = vocab_type_state(&svc).await?;
    assert_eq!(before.0.len(), 9);
    let report = svc.call(notetypes::prepare_collection).await?;
    assert_eq!(report.existing, [VOCAB_BOOK]);
    assert_eq!(report.created.len(), 4);
    assert_eq!(
        vocab_type_state(&svc).await?,
        before,
        "the existing type is untouched"
    );

    let mut plan = VocabNotesPlan {
        notes: vec![spec("Vocabulário::Livros::Animal Farm", "learner")],
    };
    plan.notes[0].fields.familia = "learn".into();
    plan.notes[0].fields.card2 = "1".into();
    let nids = svc.vocab_add_notes(plan).await?;
    let (flds, cards) = svc
        .call(move |col| {
            let flds: String = col
                .storage
                .db()
                .query_row("SELECT flds FROM notes WHERE id = ?1", [nids[0]], |r| {
                    r.get(0)
                })
                .map_err(core_anki::anki::prelude::AnkiError::from)?;
            Ok((
                flds,
                sql_i64(
                    col,
                    &format!("SELECT count(*) FROM cards WHERE nid = {}", nids[0]),
                )?,
            ))
        })
        .await?;
    let values: Vec<&str> = flds.split('\x1f').collect();
    assert_eq!(values.len(), 9);
    assert_eq!(values[0], "learner");
    assert_eq!(values[8], "1", "Card 2 matched by name");
    assert_eq!(cards, 2);
    Ok(())
}
