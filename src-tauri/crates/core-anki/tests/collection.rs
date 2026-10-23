//! Decks, "Preparar coleção" and the fixture collection.

mod common;

use std::time::{Duration, Instant};

use core_anki::anki::prelude::{DeckId, NotetypeId};
use core_anki::fixture::{self, FixtureOptions};
use core_anki::notetypes::{self, APP_NOTETYPES, BASIC_LEITOR};
use core_anki::{AnkiService, Error, decks};

use common::{deck_names, fixture, sql_i64};

#[tokio::test]
async fn deck_create_rename_move_delete_and_collapse() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;

    let child = svc
        .call(|col| decks::create(col, " Idiomas :: Inglês "))
        .await?;
    let (parent, again) = svc
        .call(|col| {
            let parent = col.get_deck_id("Idiomas")?.map(|d| d.0);
            Ok((parent, decks::create(col, "Idiomas::Inglês")?))
        })
        .await?;
    let parent = parent.expect("parent created");
    assert_eq!(again, child, "existing deck is returned");

    for bad in ["", "   ", "A::", "::B", "A:: ::B"] {
        let err = svc
            .call(move |col| decks::create(col, bad))
            .await
            .expect_err(bad);
        assert_eq!(err.code(), "anki.invalidInput", "{bad:?}");
    }

    // Rename the child (full name).
    svc.call(move |col| decks::rename(col, child, "Idiomas::English"))
        .await?;
    assert_eq!(svc.call(deck_names).await?, ["Idiomas", "Idiomas::English"]);

    // Moving a deck into itself or its own descendant is rejected.
    let err = svc
        .call(move |col| decks::move_decks(col, &[parent], Some(child)))
        .await
        .expect_err("into descendant");
    assert_eq!(err.code(), "anki.invalidInput");
    let err = svc
        .call(move |col| decks::move_decks(col, &[parent], Some(parent)))
        .await
        .expect_err("into itself");
    assert_eq!(err.code(), "anki.invalidInput");

    // Move child to top level, then back under a new parent.
    svc.call(move |col| decks::move_decks(col, &[child], None))
        .await?;
    assert_eq!(svc.call(deck_names).await?, ["English", "Idiomas"]);
    svc.call(move |col| decks::move_decks(col, &[child], Some(parent)))
        .await?;
    assert_eq!(svc.call(deck_names).await?, ["Idiomas", "Idiomas::English"]);

    // Collapse persists across a reopen (study scope).
    svc.call(move |col| decks::set_collapsed(col, parent, true))
        .await?;
    svc.shutdown()?;
    let svc = AnkiService::open(tmp.path())?;
    let tree = svc.deck_tree().await?;
    assert!(tree.find("Idiomas").expect("deck").collapsed);
    svc.call(move |col| decks::set_collapsed(col, parent, false))
        .await?;
    assert!(
        !svc.deck_tree()
            .await?
            .find("Idiomas")
            .expect("deck")
            .collapsed
    );

    // Delete counts the cards of the deck and its subdecks.
    let deleted = svc
        .call(move |col| {
            let basic = notetypes::stock_basic(col)?;
            for (deck, front) in [(parent, "a"), (child, "b"), (child, "c")] {
                let mut note = basic.new_note();
                note.set_field(0, front)?;
                col.add_note(&mut note, DeckId(deck))?;
            }
            decks::delete(col, parent)
        })
        .await?;
    assert_eq!(deleted, 3);
    assert!(svc.call(deck_names).await?.is_empty());
    let err = svc
        .call(move |col| decks::delete(col, parent))
        .await
        .expect_err("gone");
    assert_eq!(err.code(), "anki.notFound");
    Ok(())
}

#[tokio::test]
async fn deck_tree_has_filtered_total_and_current_deck() -> anyhow::Result<()> {
    let f = fixture()?;
    let words = f.info.decks[fixture::DECK_WORDS];
    let filtered = f
        .svc
        .call(|col| {
            let mut deck = col.get_or_create_filtered_deck(DeckId(0))?;
            deck.human_name = "Filtrado".into();
            deck.allow_empty = true;
            Ok(col.add_or_update_filtered_deck(deck)?.output.0)
        })
        .await?;
    f.svc
        .call(move |col| decks::set_current(col, words))
        .await?;

    let tree = f.svc.deck_tree().await?;
    assert_eq!(tree.current_deck_id, words);
    let node = tree.find("Filtrado").expect("filtered deck");
    assert!(node.filtered);
    assert_eq!(node.id, filtered);
    let w = tree.find(fixture::DECK_WORDS).expect("words");
    assert!(!w.filtered);
    // 8 basic notes + 1 vocab note (one card each), minus what the filtered deck pulled in.
    let moved = f
        .svc
        .call(move |col| {
            sql_i64(
                col,
                &format!("select count() from cards where did = {filtered}"),
            )
        })
        .await?;
    assert_eq!(i64::from(w.total) + moved, 9);
    let oxford = tree.find(fixture::DECK_OXFORD).expect("oxford");
    assert_eq!(oxford.total, 5, "total includes children");
    assert_eq!(
        tree.find(fixture::DECK_OXFORD_5000).map(|d| d.total),
        Some(0)
    );

    let json = serde_json::to_value(&tree)?;
    assert_eq!(json["currentDeckId"], words);
    assert!(json["decks"][0]["filtered"].is_boolean());
    assert!(json["decks"][0]["total"].is_number());

    let names = f.svc.call(decks::names).await?;
    let filtered_names: Vec<_> = names.iter().filter(|d| d.filtered).collect();
    assert_eq!(filtered_names.len(), 1);
    assert_eq!(filtered_names[0].name, "Filtrado");
    let lower: Vec<String> = names.iter().map(|d| d.name.to_lowercase()).collect();
    let mut sorted = lower.clone();
    sorted.sort();
    assert_eq!(lower, sorted, "case-insensitive order");

    // A filtered deck name cannot be "created" as a normal deck.
    let err = f
        .svc
        .call(|col| decks::create(col, "Filtrado"))
        .await
        .expect_err("filtered");
    assert_eq!(err.code(), "anki.invalidInput");
    Ok(())
}

fn field_and_template_names(
    col: &mut core_anki::Collection,
    name: &str,
) -> core_anki::Result<(Vec<String>, Vec<String>, i64, i32)> {
    let nt = col
        .get_notetype_by_name(name)?
        .ok_or_else(|| Error::NotFound(name.into()))?;
    Ok((
        nt.fields.iter().map(|f| f.name.clone()).collect(),
        nt.templates.iter().map(|t| t.name.clone()).collect(),
        nt.mtime_secs.0,
        nt.usn.0,
    ))
}

#[tokio::test]
async fn prepare_collection_creates_the_five_types_once() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;
    let scm_before = svc.call(|col| sql_i64(col, "select scm from col")).await?;
    let count_before = svc.call(|col| Ok(col.get_all_notetypes()?.len())).await?;

    let report = svc.call(notetypes::prepare_collection).await?;
    assert_eq!(report.created, APP_NOTETYPES);
    assert!(report.existing.is_empty());
    assert_eq!(
        svc.call(|col| Ok(col.get_all_notetypes()?.len())).await?,
        count_before + 5
    );

    let expected: [(&str, &[&str], &[&str]); 5] = [
        (
            "Básico (Leitor)",
            &["Frente", "Verso", "Fonte"],
            &["Cartão 1"],
        ),
        (
            "Cloze (Leitor)",
            &["Texto", "Verso extra", "Fonte"],
            &["Cloze"],
        ),
        (
            "Código · Comando",
            &[
                "Pergunta",
                "Resposta",
                "Aceitas",
                "Exige",
                "Observação",
                "Fonte",
            ],
            &["Cartão 1"],
        ),
        (
            "Código · Programa",
            &[
                "Pergunta",
                "Linguagem",
                "Modo",
                "Resposta",
                "Inicial",
                "Setup",
                "Testes",
                "Entrada",
                "SaidaEsperada",
                "Observação",
                "Fonte",
            ],
            &["Cartão 1"],
        ),
        (
            "Vocabulário · Livro",
            &[
                "Palavra",
                "Lema",
                "Classe",
                "Definição",
                "Tradução",
                "Exemplo",
                "Fonte",
                "Frequência",
                "Card 2",
            ],
            &["Inglês → Português", "Português → Inglês"],
        ),
    ];
    let mut stamps = Vec::new();
    for (name, fields, templates) in expected {
        let (f, t, mtime, usn) = svc
            .call(move |col| field_and_template_names(col, name))
            .await?;
        assert_eq!(f, fields, "{name}");
        assert_eq!(t, templates, "{name}");
        stamps.push((mtime, usn));
    }

    // Templates and kinds.
    let (basic_q, basic_a, cloze_kind, cmd_q, vocab_q2, css) = svc
        .call(|col| {
            let b = col.get_notetype_by_name(BASIC_LEITOR)?.expect("basic");
            let c = col.get_notetype_by_name("Cloze (Leitor)")?.expect("cloze");
            let cmd = col.get_notetype_by_name("Código · Comando")?.expect("cmd");
            let v = col
                .get_notetype_by_name("Vocabulário · Livro")?
                .expect("vocab");
            Ok((
                b.templates[0].config.q_format.clone(),
                b.templates[0].config.a_format.clone(),
                c.config.kind,
                cmd.templates[0].config.q_format.clone(),
                v.templates[1].config.q_format.clone(),
                b.config.css.clone(),
            ))
        })
        .await?;
    assert_eq!(basic_q, "{{Frente}}");
    assert_eq!(
        basic_a,
        "{{FrontSide}}\n\n<hr id=answer>\n\n{{Verso}}{{#Fonte}}<div class=\"leitor-fonte\">{{Fonte}}</div>{{/Fonte}}"
    );
    assert_eq!(cloze_kind, 1, "cloze kind");
    assert_eq!(cmd_q, "{{Pergunta}}\n\n{{type:Resposta}}");
    assert_eq!(vocab_q2, "{{#Card 2}}{{Tradução}}{{/Card 2}}");
    assert!(css.contains(".leitor-fonte{"));

    // Second run: nothing created, nothing touched, schema not modified.
    let report = svc.call(notetypes::prepare_collection).await?;
    assert!(report.created.is_empty());
    assert_eq!(report.existing, APP_NOTETYPES);
    for ((name, _, _), stamp) in expected.iter().zip(&stamps) {
        let name = *name;
        let (_, _, mtime, usn) = svc
            .call(move |col| field_and_template_names(col, name))
            .await?;
        assert_eq!((mtime, usn), *stamp, "{name} unchanged");
    }
    assert_eq!(
        svc.call(|col| sql_i64(col, "select scm from col")).await?,
        scm_before,
        "schema not modified"
    );
    Ok(())
}

#[tokio::test]
async fn prepare_collection_leaves_a_user_type_with_the_same_name_alone() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;
    let user_id = svc
        .call(|col| {
            let mut nt = (*notetypes::stock_basic(col)?).clone();
            nt.id = NotetypeId(0);
            nt.name = BASIC_LEITOR.into();
            col.add_notetype(&mut nt, false)?;
            Ok(nt.id.0)
        })
        .await?;
    let before = svc
        .call(|col| field_and_template_names(col, BASIC_LEITOR))
        .await?;
    let report = svc.call(notetypes::prepare_collection).await?;
    assert_eq!(report.existing, [BASIC_LEITOR]);
    assert_eq!(report.created.len(), 4);
    let after = svc
        .call(|col| field_and_template_names(col, BASIC_LEITOR))
        .await?;
    assert_eq!(before, after);
    let id = svc
        .call(|col| Ok(col.get_notetype_by_name(BASIC_LEITOR)?.expect("type").id.0))
        .await?;
    assert_eq!(id, user_id);
    assert!(notetypes::is_app_notetype(BASIC_LEITOR));
    assert!(!notetypes::is_app_notetype("Basic"));
    Ok(())
}

#[tokio::test]
async fn prepare_collection_second_run_is_fast() -> anyhow::Result<()> {
    let f = fixture()?;
    // Warm up, then measure (the fixture already ran it once).
    f.svc.call(notetypes::prepare_collection).await?;
    let started = Instant::now();
    let report = f.svc.call(notetypes::prepare_collection).await?;
    let took = started.elapsed();
    assert!(report.created.is_empty());
    assert!(took < Duration::from_millis(10), "prepare took {took:?}");
    Ok(())
}

#[test]
fn fixture_builds_twice_with_every_deck_and_media() -> anyhow::Result<()> {
    for _ in 0..2 {
        let tmp = tempfile::tempdir()?;
        let dir = tmp.path().join("anki");
        let info = fixture::build(&dir, FixtureOptions::default())?;
        for deck in [
            fixture::DECK_WORDS,
            fixture::DECK_OXFORD,
            fixture::DECK_OXFORD_3000,
            fixture::DECK_OXFORD_5000,
            fixture::DECK_ROS,
            fixture::DECK_MATH,
            fixture::DECK_GRAMMAR,
            fixture::DECK_CLOZE,
            fixture::DECK_BOOKS,
            fixture::DECK_ANIMAL_FARM,
            fixture::DECK_PROGRAMMING,
        ] {
            assert!(info.decks.contains_key(deck), "{deck}: {info:?}");
        }
        assert!(!info.decks.contains_key(fixture::DECK_ISOLATION));
        assert_eq!(fixture::DECK_ROS, "ROS 2 — Revisão");
        assert!(info.first_card.contains_key(fixture::DECK_WORDS));
        assert!(!info.first_card.contains_key(fixture::DECK_OXFORD_5000));
        for role in [
            "imagem",
            "audio",
            "tts",
            "matematica",
            "cloze",
            "comando",
            "digitarResposta",
            "fonte",
            "comandoUsuario",
            "programaPython",
            "programaPythonSaida",
            "programaEstrutura",
            "programaCpp",
            "programaCppSaida",
        ] {
            assert!(info.notes.contains_key(role), "{role}");
        }
        assert!(info.notetypes.contains_key("usuarioComando"));
        assert!(info.first_card.contains_key(fixture::DECK_PROGRAMMING));
        assert_eq!(info.book_uid.len(), 64);
        let media = dir.join("collection.media");
        assert!(media.join(fixture::IMAGE_FILE).is_file());
        assert!(media.join(fixture::AUDIO_FILE).is_file());
        let wav = std::fs::read(media.join(fixture::AUDIO_FILE))?;
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(wav.len(), 44 + 3200);
        let png = std::fs::read(media.join(fixture::IMAGE_FILE))?;
        assert_eq!(&png[1..4], b"PNG");

        // Building again in the same folder is refused.
        assert!(fixture::build(&dir, FixtureOptions::default()).is_err());

        let svc = AnkiService::open(&dir)?;
        let json = serde_json::to_value(&info)?;
        assert!(json["firstCard"].is_object() && json["bookUid"].is_string());

        let tree = svc.call_blocking(decks::deck_tree)?;
        let words = tree.find(fixture::DECK_WORDS).expect("words");
        assert!(words.review_count >= 3, "{words:?}");
        assert!(words.learn_count >= 1, "{words:?}");
        assert!(words.new_count >= 1, "{words:?}");
        assert!(tree.studied_today.cards >= 2);
        assert!(tree.studied_today.seconds >= 20);
        assert_eq!(tree.current_deck_id, info.decks[fixture::DECK_WORDS]);
        assert!(
            tree.find(fixture::DECK_OXFORD_3000)
                .is_some_and(|d| d.new_count == 5)
        );
        assert!(!tree.find(fixture::DECK_OXFORD).expect("oxford").collapsed);

        let words_id = info.decks[fixture::DECK_WORDS];
        let distinct_ivls = svc.call_blocking(move |col| {
            sql_i64(
                col,
                &format!(
                    "select count(distinct ivl) from cards where did = {words_id} and queue = 2"
                ),
            )
        })?;
        assert!(distinct_ivls >= 3, "different intervals: {distinct_ivls}");

        // Fonte link and type-answer templates are in place.
        let fonte = info.notes["fonte"];
        let fields = svc.call_blocking(move |col| {
            Ok(col
                .storage
                .get_note(core_anki::anki::prelude::NoteId(fonte))?
                .expect("note")
                .fields()
                .clone())
        })?;
        assert!(fields[2].contains(&format!(
            "leitor://livro/{}?pagina=37&q=windmill",
            info.book_uid
        )));
    }
    Ok(())
}

#[test]
fn fixture_with_isolation_probe() -> anyhow::Result<()> {
    let f = common::fixture_with(FixtureOptions {
        isolation_probe: true,
    })?;
    assert!(f.info.decks.contains_key(fixture::DECK_ISOLATION));
    assert!(f.info.first_card.contains_key(fixture::DECK_ISOLATION));
    assert!(f.info.notes.contains_key("isolamento"));
    Ok(())
}

#[tokio::test]
async fn deck_tree_of_the_fixture_is_fast() -> anyhow::Result<()> {
    let f = fixture()?;
    f.svc.deck_tree().await?;
    let mut best = Duration::MAX;
    for _ in 0..5 {
        let started = Instant::now();
        f.svc.deck_tree().await?;
        best = best.min(started.elapsed());
    }
    assert!(best < Duration::from_millis(20), "deck_tree took {best:?}");
    Ok(())
}
