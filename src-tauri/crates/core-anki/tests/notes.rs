//! Notes and notetypes on the fixture collection (docs/PROJETO.md 8.2 Adicionar/Editar, 11.1, 20).

mod common;

use common::fixture;
use core_anki::fixture::{DECK_ANIMAL_FARM, DECK_ROS, DECK_WORDS};
use core_anki::notes::{self, NewNote, NoteCheck, NotetypeInfo, NotetypeKindName};
use core_anki::notetypes::{
    BASIC_LEITOR, CLOZE_LEITOR, CODE_COMMAND, CODE_PROGRAM, VOCAB_BOOK, stock_basic,
};
use core_anki::{Collection, Error};

fn by_name<'a>(all: &'a [NotetypeInfo], name: &str) -> &'a NotetypeInfo {
    all.iter()
        .find(|nt| nt.name == name)
        .unwrap_or_else(|| panic!("notetype {name} missing"))
}

fn field_names(nt: &NotetypeInfo) -> Vec<&str> {
    nt.fields.iter().map(|f| f.name.as_str()).collect()
}

fn ntid(col: &mut Collection, name: &str) -> i64 {
    col.get_notetype_by_name(name).unwrap().unwrap().id.0
}

#[tokio::test]
async fn lists_the_app_notetypes_with_their_exact_fields() -> anyhow::Result<()> {
    let fx = fixture()?;
    let all = fx.svc.call(notes::notetypes).await?;

    let expect: [(&str, &[&str], NotetypeKindName); 5] = [
        (
            BASIC_LEITOR,
            &["Frente", "Verso", "Fonte"],
            NotetypeKindName::Normal,
        ),
        (
            CLOZE_LEITOR,
            &["Texto", "Verso extra", "Fonte"],
            NotetypeKindName::Cloze,
        ),
        (
            CODE_COMMAND,
            &[
                "Pergunta",
                "Resposta",
                "Aceitas",
                "Exige",
                "Observação",
                "Fonte",
            ],
            NotetypeKindName::Normal,
        ),
        (
            CODE_PROGRAM,
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
            NotetypeKindName::Normal,
        ),
        (
            VOCAB_BOOK,
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
            NotetypeKindName::Normal,
        ),
    ];
    for (name, fields, kind) in expect {
        let nt = by_name(&all, name);
        assert_eq!(field_names(nt), fields, "{name}");
        assert_eq!(nt.kind, kind, "{name}");
        assert_eq!(nt.app_type.as_deref(), Some(name));
        assert!(!nt.templates.is_empty());
        assert!(
            nt.fields
                .iter()
                .all(|f| f.font_size > 0 && !f.font_name.is_empty())
        );
    }
    // Note counts and the user's own types.
    assert_eq!(by_name(&all, CODE_COMMAND).note_count, 2);
    assert_eq!(by_name(&all, CLOZE_LEITOR).note_count, 1);
    assert_eq!(by_name(&all, CODE_PROGRAM).note_count, 0);
    let own: Vec<_> = all.iter().filter(|nt| nt.app_type.is_none()).collect();
    assert!(
        own.iter().any(|nt| nt.note_count >= 13),
        "stock Basic holds the fixture's notes"
    );
    // Sorted by name.
    let names: Vec<String> = all.iter().map(|nt| nt.name.to_lowercase()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
    // Serialized for the UI (camelCase, appType = name or null).
    let json = serde_json::to_value(by_name(&all, CLOZE_LEITOR))?;
    assert_eq!(json["kind"], "cloze");
    assert_eq!(json["appType"], CLOZE_LEITOR);
    assert!(json["fields"][0]["fontName"].is_string());
    assert!(json["fields"][0]["plainText"].is_boolean());
    Ok(())
}

#[tokio::test]
async fn add_get_update_round_trip_with_tags() -> anyhow::Result<()> {
    let fx = fixture()?;
    let farm = fx.info.decks[DECK_ANIMAL_FARM];
    let out = fx
        .svc
        .call(move |col| {
            let nt = ntid(col, BASIC_LEITOR);
            let fields = vec![
                "What did <b>Boxer</b> say?".to_string(),
                "I will work harder.".to_string(),
                r#"<a href="leitor://livro/abc?pagina=12">Animal Farm, p. 12</a>"#.to_string(),
            ];
            let added = notes::add(
                col,
                NewNote {
                    notetype_id: nt,
                    deck_id: farm,
                    fields: fields.clone(),
                    tags: vec!["livro::animal-farm  boxer".into(), "Boxer".into()],
                },
            )?;
            assert_eq!(added.card_count, 1);
            let got = notes::get(col, added.note_id)?;
            assert_eq!(got.fields, fields);
            assert_eq!(got.notetype_id, nt);
            assert_eq!(got.deck_id, farm);
            assert_eq!(got.card_ids.len(), 1);
            let mut tags = got.tags.clone();
            tags.sort();
            assert_eq!(tags, ["boxer", "livro::animal-farm"]);

            // Unchanged update: nothing is written.
            notes::update(col, added.note_id, got.fields.clone(), got.tags.clone())?;
            let same = notes::get(col, added.note_id)?;
            assert_eq!(same.mtime, got.mtime);

            let mut edited = fields.clone();
            edited[1] = "I will work <i>harder</i>!".into();
            notes::update(col, added.note_id, edited.clone(), vec!["revisado".into()])?;
            let after = notes::get(col, added.note_id)?;
            assert_eq!(after.fields, edited);
            assert_eq!(after.tags, ["revisado"]);
            core_anki::Result::Ok(())
        })
        .await;
    out?;
    Ok(())
}

#[tokio::test]
async fn code_fields_round_trip_verbatim() -> anyhow::Result<()> {
    // Spec 11.1: the UI escapes code and turns newlines into <br>; the core stores it as is.
    let fx = fixture()?;
    let ros = fx.info.decks[DECK_ROS];
    let answer = "for i in 1 2; do echo &quot;$i&quot; &lt; a &amp;&amp; b &gt;&gt; c;\tdone  <br><br>  ros2 topic echo /x";
    fx.svc
        .call(move |col| {
            let nt = ntid(col, CODE_COMMAND);
            let fields = vec![
                "Laço no shell".to_string(),
                answer.to_string(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ];
            let added = notes::add(
                col,
                NewNote {
                    notetype_id: nt,
                    deck_id: ros,
                    fields,
                    tags: vec![],
                },
            )?;
            assert_eq!(notes::get(col, added.note_id)?.fields[1], answer);
            core_anki::Result::Ok(())
        })
        .await?;
    Ok(())
}

#[tokio::test]
async fn invalid_notes_are_refused_in_portuguese() -> anyhow::Result<()> {
    let fx = fixture()?;
    let words = fx.info.decks[DECK_WORDS];
    let cloze_deck = fx.info.decks[core_anki::fixture::DECK_CLOZE];

    let add = |nt: &'static str, deck: i64, fields: Vec<&'static str>| {
        let svc = fx.svc.clone();
        async move {
            svc.call(move |col| {
                let notetype_id = if nt == "basic" {
                    stock_basic(col)?.id.0
                } else {
                    ntid(col, nt)
                };
                notes::add(
                    col,
                    NewNote {
                        notetype_id,
                        deck_id: deck,
                        fields: fields.into_iter().map(String::from).collect(),
                        tags: vec![],
                    },
                )
            })
            .await
        }
    };

    // Empty first field.
    let err = add("basic", words, vec!["  <br> ", "verso"])
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NoteInvalid(_)), "{err:?}");
    assert_eq!(err.code(), "anki.noteInvalid");
    assert!(err.to_string().contains("primeiro campo"), "{err}");

    // Cloze type without a cloze.
    let err = add(CLOZE_LEITOR, cloze_deck, vec!["sem lacuna", "", ""])
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NoteInvalid(_)), "{err:?}");
    assert!(err.to_string().contains("lacuna"), "{err}");

    // A cloze in a normal type.
    let err = add("basic", words, vec!["{{c1::casa}}", "house"])
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NoteInvalid(_)), "{err:?}");

    // Wrong field count.
    let err = add("basic", words, vec!["só um campo"]).await.unwrap_err();
    assert!(matches!(err, Error::NoteInvalid(_)), "{err:?}");
    assert!(err.to_string().contains("2 campos"), "{err}");

    // A cloze note with c1/c2 makes two cards.
    let ok = add(
        CLOZE_LEITOR,
        cloze_deck,
        vec!["{{c1::a}} e {{c2::b}}", "", ""],
    )
    .await?;
    assert_eq!(ok.card_count, 2);
    Ok(())
}

#[tokio::test]
async fn duplicates_are_reported_but_allowed() -> anyhow::Result<()> {
    let fx = fixture()?;
    let words = fx.info.decks[DECK_WORDS];
    fx.svc
        .call(move |col| {
            let basic = stock_basic(col)?.id.0;
            let fields = vec!["house".to_string(), "outra casa".to_string()];
            assert_eq!(
                notes::check(col, basic, fields.clone())?,
                NoteCheck::Duplicate
            );
            assert_eq!(
                notes::check(col, basic, vec!["casa nova".into(), String::new()])?,
                NoteCheck::Normal
            );
            assert_eq!(
                notes::check(col, basic, vec![String::new(), "x".into()])?,
                NoteCheck::Empty
            );
            let cloze = ntid(col, CLOZE_LEITOR);
            assert_eq!(
                notes::check(
                    col,
                    cloze,
                    vec!["texto".into(), String::new(), String::new()]
                )?,
                NoteCheck::MissingCloze
            );
            assert_eq!(
                notes::check(col, basic, vec!["{{c1::x}}".into(), String::new()])?,
                NoteCheck::NotetypeNotCloze
            );
            let added = notes::add(
                col,
                NewNote {
                    notetype_id: basic,
                    deck_id: words,
                    fields,
                    tags: vec![],
                },
            )?;
            assert_eq!(added.card_count, 1);
            core_anki::Result::Ok(())
        })
        .await?;
    let json = serde_json::to_value(NoteCheck::MissingCloze)?;
    assert_eq!(json, "missingCloze");
    Ok(())
}

#[tokio::test]
async fn add_defaults_follow_the_current_deck_or_the_given_one() -> anyhow::Result<()> {
    let fx = fixture()?;
    let words = fx.info.decks[DECK_WORDS];
    let ros = fx.info.decks[DECK_ROS];
    let (current, given, missing) = fx
        .svc
        .call(move |col| {
            Ok((
                notes::add_defaults(col, None)?,
                notes::add_defaults(col, Some(ros))?,
                notes::add_defaults(col, Some(987_654_321))?,
            ))
        })
        .await?;
    assert_eq!(current.deck_id, words, "fixture's current deck");
    assert_eq!(given.deck_id, ros);
    // The notetype last used in "ROS 2 — Revisão": the fixture adds the stock type-in note last.
    let typing = fx.info.notes["digitarResposta"];
    let typing_ntid = fx
        .svc
        .call(move |col| Ok(notes::get(col, typing)?.notetype_id))
        .await?;
    assert_eq!(given.notetype_id, typing_ntid);
    assert_eq!(missing.deck_id, current.deck_id, "unknown deck falls back");
    Ok(())
}

#[tokio::test]
async fn get_unknown_note_is_not_found_and_tags_are_listed() -> anyhow::Result<()> {
    let fx = fixture()?;
    let err = fx.svc.call(|col| notes::get(col, 42)).await.unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    let tags = fx.svc.call(notes::all_tags).await?;
    for t in ["fixture", "livro::animal-farm", "ros2", "oxford"] {
        assert!(tags.iter().any(|x| x == t), "{t} in {tags:?}");
    }
    let lower: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();
    let mut sorted = lower.clone();
    sorted.sort();
    assert_eq!(lower, sorted);
    Ok(())
}

#[test]
fn canonical_tags_split_and_dedupe() {
    assert_eq!(
        notes::canonical_tags(&["a  b".into(), "B".into(), "".into(), "c::d".into()]),
        ["a", "b", "c::d"]
    );
}
