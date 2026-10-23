//! Code cards in the collection (docs/PROJETO.md 11.1, 11.2): the app's code notetypes, code cards in the study
//! engine (app types and a mapped user type), the "Contestar" accessors, and the fixture's code content.
mod common;

use anki::prelude::{CardId, DeckId, NoteId, Op};
use anki::search::SortMode;
use core_anki::anki;
use core_anki::fixture::{self, PROGRAMS, USER_COMMAND_NOTES, USER_COMMAND_NOTETYPE};
use core_anki::notetypes::{self, CODE_COMMAND, CODE_PROGRAM};
use core_anki::study::{CodeCardRole, Study, StudyCard, StudyNext};
use core_anki::{AnkiService, CodeRole, Error};

use common::{Fixture, fixture, sql_i64};

fn note(fx: &Fixture, role: &str) -> i64 {
    *fx.info
        .notes
        .get(role)
        .unwrap_or_else(|| panic!("no note {role}"))
}

fn user_ntid(fx: &Fixture) -> i64 {
    fx.info.notetypes["usuarioComando"]
}

fn card(next: &StudyNext) -> &StudyCard {
    next.card().expect("a card")
}

/// Moves the note's cards into a new deck of their own and returns that deck (so the card is the top of its queue).
async fn isolate(svc: &AnkiService, nid: i64, deck: &str) -> anyhow::Result<i64> {
    let deck = deck.to_string();
    Ok(svc
        .call(move |col| {
            let did = core_anki::decks::create(col, &deck)?;
            let cards = col.search_cards(format!("nid:{nid}").as_str(), SortMode::NoOrder)?;
            col.set_deck(&cards, DeckId(did))?;
            Ok(did)
        })
        .await?)
}

fn mapping(fx: &Fixture, answer: &str) -> CodeRole {
    CodeRole {
        notetype_id: user_ntid(fx),
        question_field: "Frente".into(),
        answer_field: answer.into(),
        notes_field: Some("Explicação".into()),
    }
}

#[tokio::test]
async fn app_code_notetypes_match_the_spec() -> anyhow::Result<()> {
    let fx = fixture()?;
    let (command, program) = fx
        .svc
        .call(|col| {
            let get = |col: &mut core_anki::Collection, name: &str| {
                col.get_notetype_by_name(name)
                    .map(|nt| nt.expect("app notetype"))
            };
            Ok((get(col, CODE_COMMAND)?, get(col, CODE_PROGRAM)?))
        })
        .await?;
    let names = |nt: &anki::prelude::Notetype| -> Vec<String> {
        nt.fields.iter().map(|f| f.name.clone()).collect()
    };
    assert_eq!(
        names(&command),
        [
            "Pergunta",
            "Resposta",
            "Aceitas",
            "Exige",
            "Observação",
            "Fonte"
        ]
    );
    assert_eq!(
        names(&program),
        [
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
            "Fonte"
        ]
    );
    let fonte = "{{#Fonte}}<div class=\"leitor-fonte\">{{Fonte}}</div>{{/Fonte}}";
    let obs = "{{#Observação}}<blockquote>{{Observação}}</blockquote>{{/Observação}}";
    assert_eq!(command.templates.len(), 1);
    let t = &command.templates[0].config;
    assert_eq!(t.q_format, "{{Pergunta}}\n\n{{type:Resposta}}");
    assert_eq!(
        t.a_format,
        format!("{{{{FrontSide}}}}<hr id=answer>{obs}{fonte}")
    );
    assert_eq!(program.templates.len(), 1);
    let t = &program.templates[0].config;
    assert_eq!(t.q_format, "{{Pergunta}}");
    assert_eq!(
        t.a_format,
        format!(
            "{{{{FrontSide}}}}<hr id=answer><pre><code class=\"language-{{{{Linguagem}}}}\">{{{{Resposta}}}}</code></pre>{obs}{fonte}"
        )
    );
    Ok(())
}

#[tokio::test]
async fn app_command_card_is_a_code_card_without_type_box() -> anyhow::Result<()> {
    let fx = fixture()?;
    let did = isolate(&fx.svc, note(&fx, "comando"), "Teste código").await?;
    let study = Study::new(fx.svc.clone());
    let next = study.next(did).await?;
    let c = card(&next);
    let code = c.code.as_ref().expect("code card");
    assert_eq!(code.role, CodeCardRole::Command);
    assert!(code.app_type);
    assert!(code.accepted_field);
    assert!(code.answer_shows_notes);
    // `{{type:Resposta}}` is stripped: the answer side doesn't print the command, the review UI does.
    assert!(!code.answer_shows_answer);
    assert_eq!(code.fields.answer, "ros2 topic list");
    assert_eq!(code.fields.accepted, "ros2 topic list -t");
    assert_eq!(code.fields.requires, "");
    assert_eq!(
        code.fields.notes,
        "Mostra todos os tópicos publicados no momento."
    );
    assert_eq!(code.fields.language, "");
    assert!(!c.type_answer);
    assert!(c.question_html.contains("Listar os tópicos ativos"));
    assert!(!c.question_html.contains("typeans"), "{}", c.question_html);
    assert!(!c.question_html.contains("[[type:"));
    assert!(c.question_html.starts_with("<style>"), "notetype CSS kept");
    assert_eq!(c.body_class, "card card1");

    let answer = study.show_answer(c.card_id, None).await?;
    assert!(answer.html.contains("Listar os tópicos ativos"));
    assert!(answer.html.contains("<hr id=answer>"));
    assert!(
        answer
            .html
            .contains("<blockquote>Mostra todos os tópicos publicados no momento.</blockquote>")
    );
    assert!(!answer.html.contains("typeans"), "{}", answer.html);

    // The JSON shape of the contract.
    let json = serde_json::to_value(c)?;
    let code = &json["code"];
    assert_eq!(code["role"], "command");
    assert_eq!(code["appType"], true);
    assert_eq!(code["acceptedField"], true);
    assert_eq!(code["answerShowsNotes"], true);
    assert_eq!(code["answerShowsAnswer"], false);
    for key in [
        "answer",
        "accepted",
        "requires",
        "notes",
        "language",
        "mode",
        "initial",
        "setup",
        "tests",
        "input",
        "expectedOutput",
    ] {
        assert!(code["fields"][key].is_string(), "{key}");
    }
    Ok(())
}

#[tokio::test]
async fn program_cards_carry_language_mode_and_tests() -> anyhow::Result<()> {
    let fx = fixture()?;
    let study = Study::new(fx.svc.clone());
    let next = study.next(fx.info.decks[fixture::DECK_PROGRAMMING]).await?;
    let c = card(&next);
    assert_eq!(c.note_id, note(&fx, "programaPython"), "first card is (a)");
    let code = c.code.as_ref().expect("code card");
    assert_eq!(code.role, CodeCardRole::Program);
    assert!(code.app_type);
    assert!(!code.accepted_field);
    // The back prints `{{Resposta}}` in a <pre><code>: the review UI doesn't repeat it.
    assert!(code.answer_shows_answer);
    assert_eq!(code.fields.language, "python");
    assert_eq!(code.fields.mode, "testes");
    assert_eq!(
        code.fields.answer,
        "def soma_pares(xs):<br>    return sum(x for x in xs if x % 2 == 0)"
    );
    assert_eq!(
        code.fields.tests,
        "assert soma_pares([1, 2, 3, 4]) == 6<br>assert soma_pares([]) == 0"
    );
    assert!(!c.type_answer);
    assert!(
        c.question_html
            .contains("Função que soma os pares de uma lista")
    );

    // A C++ output card.
    let did = isolate(&fx.svc, note(&fx, "programaCppSaida"), "Teste C++").await?;
    let next = study.next(did).await?;
    let code = card(&next).code.clone().expect("code card");
    assert_eq!(code.fields.language, "cpp");
    assert_eq!(code.fields.mode, "saida");
    assert_eq!(
        code.fields.answer,
        "#include &lt;iostream&gt;<br>int main() { std::cout &lt;&lt; \"Olá, mundo!\\n\"; }"
    );
    assert_eq!(code.fields.expected_output, "Olá, mundo!<br>");
    let answer = study.show_answer(card(&next).card_id, None).await?;
    assert!(
        answer
            .html
            .contains("<pre><code class=\"language-cpp\">#include &lt;iostream&gt;"),
        "{}",
        answer.html
    );
    Ok(())
}

#[tokio::test]
async fn user_type_is_normal_until_mapped_then_a_command_card() -> anyhow::Result<()> {
    let fx = fixture()?;
    let nid = note(&fx, "comandoUsuario");
    let did = isolate(&fx.svc, nid, "Teste usuário").await?;
    let study = Study::new(fx.svc.clone());

    // Without roles: studied normally, with the user's own front.
    let next = study.next(did).await?;
    let c = card(&next);
    assert!(c.code.is_none());
    assert!(c.question_html.contains("<textarea"));
    assert!(c.question_html.contains("DIGITE O COMANDO"));
    assert!(!c.type_answer);
    assert_eq!(serde_json::to_value(c)?["code"], serde_json::Value::Null);

    // Mapped: Pergunta-only question, the answer side from the user's back template.
    fx.svc.set_code_roles(vec![mapping(&fx, "Comando")]).await?;
    let next = study.next(did).await?;
    let c = card(&next).clone();
    let code = c.code.as_ref().expect("mapped code card");
    assert_eq!(code.role, CodeCardRole::Command);
    assert!(!code.app_type);
    assert!(!code.accepted_field);
    assert!(code.answer_shows_notes);
    // The user's back prints `{{Comando}}`.
    assert!(code.answer_shows_answer);
    assert_eq!(code.notetype_id, user_ntid(&fx));
    assert_eq!(
        code.fields.answer,
        "ros2 run tf2_ros tf2_echo world turtle1"
    );
    assert_eq!(
        code.fields.notes,
        "Imprime Translation e Rotation (quaternion) a cada atualização."
    );
    assert_eq!(code.fields.accepted, "");
    assert!(
        c.question_html
            .contains("Ver a transformação entre os frames world e turtle1")
    );
    assert!(
        !c.question_html.contains("<textarea"),
        "{}",
        c.question_html
    );
    assert!(!c.question_html.contains("DIGITE O COMANDO"));
    assert!(!c.question_html.contains("pycmd"));
    assert!(c.question_html.contains(".rotulo"), "notetype CSS kept");
    assert_eq!(c.body_class, "card card1");
    assert!(!c.type_answer);
    let answer = study.show_answer(c.card_id, None).await?;
    assert!(
        answer.html.contains(
            "<pre class=\"cmd\"><code>ros2 run tf2_ros tf2_echo world turtle1</code></pre>"
        )
    );
    assert!(!answer.html.contains("<textarea"));

    // Answering is a normal review: one revlog row, no notetype or schema change.
    let ntid = user_ntid(&fx);
    let cid = c.card_id;
    let snapshot =
        move |col: &mut core_anki::Collection| -> core_anki::Result<(i64, i64, i64, i64)> {
            Ok((
                sql_i64(
                    col,
                    &format!("select count() from revlog where cid = {cid}"),
                )?,
                sql_i64(
                    col,
                    &format!("select mtime_secs from notetypes where id = {ntid}"),
                )?,
                sql_i64(col, &format!("select usn from notetypes where id = {ntid}"))?,
                sql_i64(col, "select scm from col")?,
            ))
        };
    let before = fx.svc.call(snapshot).await?;
    assert_eq!(before.0, 0);
    study.answer(cid, 3, 4_000).await?;
    let after = fx.svc.call(snapshot).await?;
    assert_eq!(after.0, 1, "one revlog row");
    assert_eq!(
        (after.1, after.2, after.3),
        (before.1, before.2, before.3),
        "notetype mtime/usn and scm unchanged"
    );

    // Removing the roles makes the type normal again.
    fx.svc.set_code_roles(vec![]).await?;
    let next = study.next(did).await?;
    assert!(card(&next).code.is_none());
    Ok(())
}

#[tokio::test]
async fn mapping_with_a_missing_field_degrades_to_a_normal_card() -> anyhow::Result<()> {
    let fx = fixture()?;
    let did = isolate(&fx.svc, note(&fx, "comandoUsuario"), "Teste usuário").await?;
    let study = Study::new(fx.svc.clone());
    fx.svc
        .set_code_roles(vec![mapping(&fx, "Campo que sumiu")])
        .await?;
    let next = study.next(did).await?;
    let c = card(&next);
    assert!(c.code.is_none());
    assert!(c.question_html.contains("<textarea"));
    let mut missing_notes = mapping(&fx, "Comando");
    missing_notes.notes_field = Some("Nada".into());
    fx.svc.set_code_roles(vec![missing_notes]).await?;
    assert!(card(&study.next(did).await?).code.is_none());
    Ok(())
}

#[tokio::test]
async fn note_field_set_is_undoable_and_refuses_unknown_fields() -> anyhow::Result<()> {
    let fx = fixture()?;
    let nid = note(&fx, "comandoUsuario");
    let original = fx.svc.code_note(nid).await?.fields["Explicação"].clone();
    fx.svc
        .note_field_set(nid, "Explicação", "Nova explicação".into())
        .await?;
    let fields = fx.svc.code_note(nid).await?.fields;
    assert_eq!(fields["Explicação"], "Nova explicação");
    assert_eq!(
        fields["Comando"], USER_COMMAND_NOTES[0].1,
        "other fields kept"
    );
    let op = fx.svc.call(|col| Ok(col.can_undo().cloned())).await?;
    assert_eq!(op, Some(Op::UpdateNote));
    fx.svc
        .call(|col| {
            col.undo()?;
            Ok(())
        })
        .await?;
    assert_eq!(fx.svc.code_note(nid).await?.fields["Explicação"], original);

    let err = fx
        .svc
        .note_field_set(nid, "Aceitas", "x".into())
        .await
        .unwrap_err();
    assert!(matches!(err, Error::NotFound(_)), "{err:?}");
    let msg = err.to_string();
    assert!(msg.starts_with("Não encontrado"), "{msg}");
    assert!(msg.contains("campo \"Aceitas\""), "{msg}");
    assert!(
        fx.svc
            .note_field_set(1, "Frente", "x".into())
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn code_note_reports_role_and_accepted_field() -> anyhow::Result<()> {
    let fx = fixture()?;
    let app = fx.svc.code_note(note(&fx, "comando")).await?;
    assert_eq!(app.notetype_name, CODE_COMMAND);
    assert_eq!(app.role, Some(CodeCardRole::Command));
    assert_eq!(app.accepted_field.as_deref(), Some("Aceitas"));
    assert_eq!(app.fields["Resposta"], "ros2 topic list");
    assert_eq!(app.fields.len(), 6);

    let program = fx.svc.code_note(note(&fx, "programaCpp")).await?;
    assert_eq!(program.role, Some(CodeCardRole::Program));
    assert_eq!(program.accepted_field, None);

    let nid = note(&fx, "comandoUsuario");
    let user = fx.svc.code_note(nid).await?;
    assert_eq!(user.role, None);
    assert_eq!(user.notetype_name, USER_COMMAND_NOTETYPE);
    assert_eq!(user.accepted_field, None);
    fx.svc.set_code_roles(vec![mapping(&fx, "Comando")]).await?;
    let user = fx.svc.code_note(nid).await?;
    assert_eq!(user.role, Some(CodeCardRole::Command));
    let json = serde_json::to_value(&user)?;
    assert_eq!(json["role"], "command");
    assert!(json["notetypeId"].is_i64() && json["acceptedField"].is_null());

    let plain = fx.svc.code_note(note(&fx, "imagem")).await?;
    assert_eq!(plain.role, None);
    assert!(fx.svc.code_note(1).await.is_err());
    Ok(())
}

#[tokio::test]
async fn fixture_has_the_user_type_and_the_programs() -> anyhow::Result<()> {
    let fx = fixture()?;
    let ntid = user_ntid(&fx);
    assert!(!notetypes::is_app_notetype(USER_COMMAND_NOTETYPE));
    let nt = fx
        .svc
        .call(move |col| {
            Ok(col
                .get_notetype(anki::prelude::NotetypeId(ntid))?
                .expect("user notetype"))
        })
        .await?;
    assert_eq!(nt.name, "ROS 2 · Digite o comando");
    let names: Vec<&str> = nt.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["Frente", "Comando", "Explicação"]);
    assert_eq!(nt.templates.len(), 1);
    assert_eq!(nt.templates[0].name, "Cartão 1");
    let front = &nt.templates[0].config.q_format;
    assert!(front.starts_with(
        "<div class=\"rotulo\">DIGITE O COMANDO · CTRL+ENTER RESPONDE</div><div class=\"pergunta\">{{Frente}}</div><textarea id=\"cmd\" rows=\"3\"></textarea>"
    ));
    assert!(front.contains("pycmd(\"ans\")"));
    assert_eq!(
        nt.templates[0].config.a_format,
        "<div class=\"pergunta\">{{Frente}}</div><hr id=answer><pre class=\"cmd\"><code>{{Comando}}</code></pre>{{#Explicação}}<blockquote>{{Explicação}}</blockquote>{{/Explicação}}"
    );
    assert!(nt.config.css.contains("blockquote"));

    // The three user notes in "ROS 2 — Revisão", with the captures' text.
    let ros = fx.info.decks[fixture::DECK_ROS];
    let (user_notes, ros_cards) = fx
        .svc
        .call(move |col| {
            let nids = col.search_notes_unordered(format!("mid:{ntid}").as_str())?;
            let mut notes = Vec::new();
            for nid in nids {
                let n = col.storage.get_note(nid)?.expect("note");
                notes.push((n.id.0, n.fields().clone(), n.tags.clone()));
            }
            notes.sort();
            Ok((
                notes,
                sql_i64(col, &format!("select count() from cards where did = {ros}"))?,
            ))
        })
        .await?;
    assert_eq!(ros_cards, 6, "2 app commands + 1 type-in + 3 user commands");
    assert_eq!(user_notes.len(), 3);
    assert_eq!(user_notes[0].0, note(&fx, "comandoUsuario"));
    for ((_, fields, tags), (front, cmd, explanation)) in user_notes.iter().zip(USER_COMMAND_NOTES)
    {
        assert_eq!(fields, &[front, cmd, explanation]);
        assert_eq!(tags, &["ros2"]);
    }

    // "Programação": five new program cards, (a) first.
    let programming = fx.info.decks[fixture::DECK_PROGRAMMING];
    assert_eq!(fixture::DECK_PROGRAMMING, "Programação");
    let first = fx.info.first_card[fixture::DECK_PROGRAMMING];
    let roles: Vec<&str> = PROGRAMS.iter().map(|p| p.role).collect();
    assert_eq!(
        roles,
        [
            "programaPython",
            "programaPythonSaida",
            "programaEstrutura",
            "programaCpp",
            "programaCppSaida"
        ]
    );
    let nids: Vec<i64> = roles.iter().map(|r| note(&fx, r)).collect();
    let (count, new_count, first_note, notes) = fx
        .svc
        .call(move |col| {
            let first_note = col
                .storage
                .get_card(CardId(first))?
                .expect("card")
                .note_id()
                .0;
            let mut notes = Vec::new();
            for nid in nids {
                notes.push(
                    col.storage
                        .get_note(NoteId(nid))?
                        .expect("note")
                        .fields()
                        .clone(),
                );
            }
            Ok((
                sql_i64(
                    col,
                    &format!("select count() from cards where did = {programming}"),
                )?,
                sql_i64(
                    col,
                    &format!("select count() from cards where did = {programming} and queue = 0"),
                )?,
                first_note,
                notes,
            ))
        })
        .await?;
    assert_eq!((count, new_count), (5, 5));
    assert_eq!(first_note, note(&fx, "programaPython"));
    let expect = |i: usize, field: usize| notes[i][field].clone();
    // Pergunta, Linguagem, Modo, Resposta, Inicial, Setup, Testes, Entrada, SaidaEsperada, Observação, Fonte.
    assert_eq!(expect(0, 0), "Função que soma os pares de uma lista");
    assert_eq!(
        (expect(0, 1), expect(0, 2)),
        ("python".into(), "testes".into())
    );
    assert_eq!(
        expect(0, 6),
        "assert soma_pares([1, 2, 3, 4]) == 6<br>assert soma_pares([]) == 0"
    );
    assert_eq!(expect(1, 0), "Ler dois inteiros e imprimir a soma");
    assert_eq!(expect(1, 2), "saida");
    assert_eq!(
        expect(1, 3),
        "a, b = map(int, input().split())<br>print(a + b)"
    );
    assert_eq!(
        (expect(1, 7), expect(1, 8)),
        ("2 3<br>".into(), "5<br>".into())
    );
    assert_eq!(expect(2, 0), "Criar um nó rclpy mínimo");
    assert_eq!(expect(2, 2), "estrutura");
    assert!(expect(2, 3).starts_with("import rclpy<br>"));
    assert_eq!(expect(3, 0), "Função int quadrado(int x)");
    assert_eq!(
        (expect(3, 1), expect(3, 2)),
        ("cpp".into(), "testes".into())
    );
    assert_eq!(expect(3, 3), "int quadrado(int x) { return x * x; }");
    assert_eq!(
        expect(3, 6),
        "int main() {<br>    CHECK(quadrado(3) == 9);<br>    CHECK(quadrado(-2) == 4);<br>}"
    );
    assert_eq!(expect(4, 0), "Imprimir Olá, mundo!");
    assert_eq!(expect(4, 2), "saida");
    assert_eq!(expect(4, 8), "Olá, mundo!<br>");
    for fields in &notes {
        assert_eq!(fields.len(), 11);
        assert_eq!(fields[4], "", "no Inicial");
    }
    Ok(())
}
