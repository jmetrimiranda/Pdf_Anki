//! Code cards through `AppState` with the fixture collection (spec 11, 21 Phase 5): the "Comando"
//! role of a user notetype (interactive review without a schema change), mapping validation,
//! `code_note_extra` and "Contestar", the Markdown import of the spec's example, C++ on the local
//! compiler (and on the remote runner when `LEITOR_RUNNER_TEST_URL`/`_TOKEN` are set) and the code
//! settings with the runner token kept off the disk.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use core_anki::AnkiService;
use core_anki::fixture::{self, FixtureInfo, FixtureOptions};
use core_anki::study::{CodeCardRole, StudyNext};
use core_code::html_to_code;
use core_store::CodeMappingFields;
use leitor_app::AppState;
use leitor_app::code::{AcceptTarget, CodeSettingsPatch, CppBackendChoice, CppBackendEffective};
use leitor_app::secrets::MemoryStore;

const ROS: &str = "ROS 2 — Revisão";
const EXAMPLE: &str = include_str!("../../crates/core-code/tests/fixtures/import_example.md");

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

struct Env {
    _dir: tempfile::TempDir,
    data: PathBuf,
    state: AppState,
    info: FixtureInfo,
    secrets: Arc<MemoryStore>,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let info = fixture::build(&data.join("anki"), FixtureOptions::default()).unwrap();
        let secrets = Arc::new(MemoryStore::default());
        let state = AppState::with_secret_store(
            data.clone(),
            Arc::new(core_store::SystemClock),
            secrets.clone(),
        );
        Self {
            _dir: dir,
            data,
            state,
            info,
            secrets,
        }
    }

    fn svc(&self) -> AnkiService {
        self.state.anki_handles().unwrap().svc
    }

    fn user_type(&self) -> i64 {
        self.info.notetypes["usuarioComando"]
    }

    fn notetype_id(&self, name: &'static str) -> i64 {
        block_on(self.state.anki_notetypes())
            .unwrap()
            .into_iter()
            .find(|nt| nt.name == name)
            .unwrap_or_else(|| panic!("no notetype {name}"))
            .id
    }

    fn map_user_type(&self) {
        block_on(
            self.state
                .code_mapping_set(self.user_type(), Some(user_fields())),
        )
        .unwrap();
    }

    fn i64(&self, sql: String) -> i64 {
        block_on(self.svc().call(move |col| {
            Ok(col
                .storage
                .db()
                .query_row(&sql, [], |r| r.get::<_, i64>(0))
                .map_err(core_anki::anki::prelude::AnkiError::from)?)
        }))
        .unwrap()
    }

    /// The notetype's fields, templates and mtime, and the collection's schema mtime: what a
    /// schema change (and thus a full sync) would touch.
    fn schema_snapshot(&self, notetype_id: i64) -> (String, i64, i64) {
        let nt = block_on(self.state.anki_notetypes())
            .unwrap()
            .into_iter()
            .find(|nt| nt.id == notetype_id)
            .unwrap();
        let shape = serde_json::to_string(&(&nt.fields, &nt.templates)).unwrap();
        let mtime = self.i64(format!(
            "select mtime_secs from notetypes where id = {notetype_id}"
        ));
        let scm = self.i64("select scm from col".into());
        (shape, mtime, scm)
    }

    fn note_field(&self, note_id: i64, field: &str) -> String {
        block_on(self.state.anki_note_get(note_id)).unwrap().fields
            [field_index(self, note_id, field)]
        .clone()
    }
}

fn field_index(env: &Env, note_id: i64, field: &str) -> usize {
    let note = block_on(env.state.anki_note_get(note_id)).unwrap();
    let nt = block_on(env.state.anki_notetypes())
        .unwrap()
        .into_iter()
        .find(|nt| nt.id == note.notetype_id)
        .unwrap();
    nt.fields.iter().position(|f| f.name == field).unwrap()
}

impl Drop for Env {
    fn drop(&mut self) {
        self.state.shutdown();
    }
}

fn user_fields() -> CodeMappingFields {
    CodeMappingFields {
        question: "Frente".into(),
        answer: "Comando".into(),
        notes: Some("Explicação".into()),
    }
}

fn fields(q: &str, a: &str, n: Option<&str>) -> CodeMappingFields {
    CodeMappingFields {
        question: q.into(),
        answer: a.into(),
        notes: n.map(Into::into),
    }
}

/// Studies `deck` answering "Bom" until a card of `notetype_id` shows up.
fn study_until(env: &Env, deck: i64, notetype_id: i64) -> core_anki::study::StudyCard {
    let mut next = block_on(env.state.anki_study_next(deck, None)).unwrap();
    for _ in 0..20 {
        let StudyNext::Card { card, .. } = &next else {
            panic!("the deck ran out before a card of notetype {notetype_id}");
        };
        let note = block_on(env.state.anki_note_get(card.note_id)).unwrap();
        if note.notetype_id == notetype_id {
            return (**card).clone();
        }
        next = block_on(env.state.anki_answer(card.card_id, 3, 1000)).unwrap();
    }
    panic!("no card of notetype {notetype_id} in 20 cards");
}

#[test]
fn assigned_user_type_reviews_interactively() {
    let env = Env::new();
    let user = env.user_type();
    let before = env.schema_snapshot(user);

    // Before the mapping, the user's cards are plain cards (their own textarea front).
    let deck = env.info.decks[ROS];
    let card = study_until(&env, deck, user);
    assert!(card.code.is_none());
    assert!(card.question_html.contains("<textarea"));
    env.state.anki_study_close(None).unwrap();

    let list = block_on(env.state.code_mapping_set(user, Some(user_fields()))).unwrap();
    assert_eq!(list.len(), 1);
    let m = &list[0];
    assert_eq!(m.notetype_id, user);
    assert_eq!(m.notetype_name, fixture::USER_COMMAND_NOTETYPE);
    assert_eq!(m.note_count, 3);
    assert!(m.missing_fields.is_empty());
    let json = serde_json::to_value(m).unwrap();
    assert_eq!(json["role"], "code_command");
    assert_eq!(json["fields"]["notes"], "Explicação");

    let card = study_until(&env, deck, user);
    let code = card
        .code
        .as_ref()
        .expect("the mapped type is a code card now");
    assert_eq!(code.role, CodeCardRole::Command);
    assert_eq!(code.notetype_id, user);
    assert!(!code.app_type);
    assert!(!code.accepted_field);
    assert!(
        card.question_html
            .contains(fixture::USER_COMMAND_NOTES[0].0),
        "{}",
        card.question_html
    );
    assert!(!card.question_html.contains("<textarea"));
    assert_eq!(
        html_to_code(&code.fields.answer),
        fixture::USER_COMMAND_NOTES[0].1
    );
    assert_eq!(
        html_to_code(&code.fields.notes),
        fixture::USER_COMMAND_NOTES[0].2
    );

    let revlog = |cid: i64| env.i64(format!("select count() from revlog where cid = {cid}"));
    let reviews = revlog(card.card_id);
    block_on(env.state.anki_answer(card.card_id, 3, 4000)).unwrap();
    assert_eq!(revlog(card.card_id), reviews + 1);

    // No schema change: same fields/templates, same notetype mtime, same collection schema
    // mtime (so no full sync is required).
    assert_eq!(env.schema_snapshot(user), before);
    let list = block_on(env.state.code_mapping_list()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].note_count, 3);
}

#[test]
fn the_role_survives_a_restart() {
    let env = Env::new();
    env.map_user_type();
    env.state.shutdown();
    // A fresh state on the same data dir pushes the stored mapping when the collection opens.
    let state = AppState::with_secret_store(
        env.data.clone(),
        Arc::new(core_store::SystemClock),
        Arc::new(MemoryStore::default()),
    );
    let deck = env.info.decks[ROS];
    let mut next = block_on(state.anki_study_next(deck, None)).unwrap();
    let mut found = false;
    for _ in 0..20 {
        let StudyNext::Card { card, .. } = &next else {
            break;
        };
        if card
            .code
            .as_ref()
            .is_some_and(|c| c.notetype_id == env.user_type())
        {
            found = true;
            break;
        }
        next = block_on(state.anki_answer(card.card_id, 3, 1000)).unwrap();
    }
    state.shutdown();
    assert!(
        found,
        "the user type was not studied as a code card after a restart"
    );
}

#[test]
fn mapping_validation_and_tombstone() {
    let env = Env::new();
    let user = env.user_type();
    let err = |nt: i64, f: CodeMappingFields| {
        block_on(env.state.code_mapping_set(nt, Some(f))).unwrap_err()
    };

    let app_type = env.notetype_id(core_anki::notetypes::CODE_COMMAND);
    let e = err(app_type, fields("Pergunta", "Resposta", None));
    assert_eq!(e.code, "code_mapping_app_type");
    let cloze = env.notetype_id(core_anki::notetypes::CLOZE_LEITOR);
    // An app type is refused first; a user cloze type for the cloze rule.
    assert_eq!(
        err(cloze, fields("Texto", "Extra", None)).code,
        "code_mapping_app_type"
    );
    let user_cloze = block_on(env.state.anki_notetypes())
        .unwrap()
        .into_iter()
        .find(|nt| nt.kind == core_anki::notes::NotetypeKindName::Cloze && nt.app_type.is_none())
        .expect("the fixture has a stock cloze type");
    let f = &user_cloze.fields;
    let e = err(user_cloze.id, fields(&f[0].name, &f[1].name, None));
    assert_eq!(e.code, "code_mapping_cloze");

    let e = err(user, fields("Frente", "Inexistente", None));
    assert_eq!(e.code, "invalid_input");
    assert!(e.message.contains("Inexistente"), "{}", e.message);
    let e = err(user, fields("Frente", "Frente", None));
    assert_eq!(e.code, "invalid_input");
    let e = err(user, fields("Frente", "Comando", Some("Comando")));
    assert_eq!(e.code, "invalid_input");
    let e = err(9_999_999, fields("Frente", "Comando", None));
    assert_eq!(e.code, "not_found");
    assert!(block_on(env.state.code_mapping_list()).unwrap().is_empty());

    // Assign, then remove: a tombstone, the list is empty and the cards are plain again.
    env.map_user_type();
    let list = block_on(env.state.code_mapping_set(user, None)).unwrap();
    assert!(list.is_empty());
    let deleted = env
        .state
        .with_store(|s| {
            Ok(s.connection().query_row(
                "select deleted from notetype_mapping where anki_notetype_id = ?1",
                [user],
                |r| r.get::<_, i64>(0),
            )?)
        })
        .unwrap();
    assert_eq!(deleted, 1);
    let card = study_until(&env, env.info.decks[ROS], user);
    assert!(card.code.is_none());
    block_on(env.state.anki_answer(card.card_id, 3, 1000)).unwrap();
}

#[test]
fn note_extra_and_accept_answer() {
    let env = Env::new();
    let user_note = env.info.notes["comandoUsuario"];
    let app_note = env.info.notes["comando"];

    // code_note_extra get/set round trip.
    let empty = env.state.code_note_extra_get(user_note).unwrap();
    assert!(empty.accepted.is_empty() && empty.requires.is_empty());
    assert_eq!(empty.note_id, user_note);
    let set = env
        .state
        .code_note_extra_set(
            user_note,
            vec![" a ".into(), "a".into(), "b".into()],
            vec!["sudo".into()],
        )
        .unwrap();
    assert_eq!(set.accepted, ["a", "b"]);
    let got = env.state.code_note_extra_get(user_note).unwrap();
    assert_eq!(got, set);
    let json = serde_json::to_value(&got).unwrap();
    assert_eq!(json["noteId"], user_note);
    env.state
        .code_note_extra_set(user_note, vec![], vec![])
        .unwrap();
    assert!(
        env.state
            .code_note_extra_get(user_note)
            .unwrap()
            .accepted
            .is_empty()
    );

    // "Código · Comando": the Aceitas field gets the line (undoable).
    let deck = env.info.decks[ROS];
    block_on(env.state.anki_study_next(deck, None)).unwrap();
    let aceitas_before = env.note_field(app_note, "Aceitas");
    let answer = "ros2  topic list   --include-hidden-topics";
    let r = block_on(env.state.code_accept_answer(app_note, answer.into())).unwrap();
    assert_eq!(r.target, AcceptTarget::Field);
    assert!(r.accepted.contains(&answer.to_string()), "{r:?}");
    assert!(
        r.accepted.contains(&"ros2 topic list -t".to_string()),
        "{r:?}"
    );
    let aceitas = html_to_code(&env.note_field(app_note, "Aceitas"));
    assert_eq!(aceitas.lines().last(), Some(answer));
    let previous = html_to_code(&aceitas_before);
    if !previous.trim().is_empty() {
        assert!(aceitas.starts_with(previous.trim_end()), "{aceitas:?}");
    }
    // The same answer with other spacing, or the Resposta itself: already accepted.
    let again = block_on(
        env.state
            .code_accept_answer(app_note, "ros2 topic list --include-hidden-topics".into()),
    )
    .unwrap();
    assert_eq!(again.target, AcceptTarget::Already);
    let resposta = html_to_code(&env.note_field(app_note, "Resposta"));
    let same = block_on(
        env.state
            .code_accept_answer(app_note, format!(" {resposta} ")),
    )
    .unwrap();
    assert_eq!(same.target, AcceptTarget::Already);
    // The field update is a normal undoable Anki operation ("Update Note"): undoing it restores
    // the field. (The study screen's undo only takes back answers.)
    let undone = block_on(env.svc().call(|col| {
        let label = col.undo_status().undo.map(|op| op.describe(col.tr()));
        col.undo()?;
        Ok(label)
    }))
    .unwrap();
    assert!(undone.is_some());
    assert_eq!(env.note_field(app_note, "Aceitas"), aceitas_before);

    // A mapped user type has no Aceitas field: code_note_extra.
    env.map_user_type();
    let r = block_on(env.state.code_accept_answer(
        user_note,
        "ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco".into(),
    ))
    .unwrap();
    assert_eq!(r.target, AcceptTarget::Extra);
    assert_eq!(r.accepted.len(), 1);
    assert_eq!(
        env.state.code_note_extra_get(user_note).unwrap().accepted,
        r.accepted
    );
    let dup = block_on(
        env.state
            .code_accept_answer(user_note, r.accepted[0].clone()),
    )
    .unwrap();
    assert_eq!(dup.target, AcceptTarget::Already);
    assert_eq!(dup.accepted, r.accepted);

    // Not a code note / empty answer.
    let basic = env.info.notes["digitarResposta"];
    let e = block_on(env.state.code_accept_answer(basic, "x".into())).unwrap_err();
    assert_eq!(e.code, "code_not_code_note");
    let e = block_on(env.state.code_accept_answer(app_note, "   ".into())).unwrap_err();
    assert_eq!(e.code, "invalid_input");
}

#[test]
fn import_commit_of_the_spec_example() {
    let env = Env::new();
    let preview = block_on(env.state.code_import_markdown(EXAMPLE.into())).unwrap();
    assert_eq!(preview.items.len(), 2);
    assert!(
        preview.items.iter().all(|i| i.errors.is_empty()),
        "{preview:?}"
    );

    let deck = env.info.decks[ROS];
    let r = block_on(
        env.state
            .code_import_commit(EXAMPLE.into(), deck, vec![0, 1]),
    )
    .unwrap();
    assert_eq!((r.added, r.skipped), (2, 0));
    assert_eq!(r.note_ids.len(), 2);

    let cmd = block_on(env.state.anki_note_get(r.note_ids[0])).unwrap();
    assert_eq!(
        cmd.notetype_id,
        env.notetype_id(core_anki::notetypes::CODE_COMMAND)
    );
    assert_eq!(
        cmd.fields,
        [
            "Ver a transformação entre os frames world e turtle1",
            "ros2 run tf2_ros tf2_echo world turtle1",
            "ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco",
            "",
            "Imprime Translation e Rotation (quaternion) a cada atualização.",
            "",
        ]
    );
    assert_eq!(cmd.tags, ["ros2", "tf2"]);

    let prog = block_on(env.state.anki_note_get(r.note_ids[1])).unwrap();
    assert_eq!(
        prog.notetype_id,
        env.notetype_id(core_anki::notetypes::CODE_PROGRAM)
    );
    assert_eq!(
        prog.fields,
        [
            "Função que soma os pares de uma lista",
            "python",
            "testes",
            "def soma_pares(xs):<br>    return sum(x for x in xs if x % 2 == 0)",
            "",
            "",
            "assert soma_pares([1, 2, 3, 4]) == 6<br>assert soma_pares([]) == 0",
            "",
            "",
            "",
            "",
        ]
    );
    assert_eq!(prog.tags, ["python"]);

    // A subset, duplicates and unknown indices; items with errors are skipped.
    let text = format!("{EXAMPLE}\n### Sem bloco\naceitas: x\n");
    let preview = block_on(env.state.code_import_markdown(text.clone())).unwrap();
    assert_eq!(preview.items.len(), 3);
    assert!(!preview.items[2].errors.is_empty());
    let r = block_on(env.state.code_import_commit(text, deck, vec![1, 1, 2, 7])).unwrap();
    assert_eq!((r.added, r.skipped), (1, 2));
    let r = block_on(env.state.code_import_commit(EXAMPLE.into(), deck, vec![])).unwrap();
    assert_eq!(r.added, 0);
    let e = block_on(
        env.state
            .code_import_commit(EXAMPLE.into(), 9_999_999, vec![0]),
    )
    .unwrap_err();
    assert!(!e.message.is_empty());
}

#[test]
fn import_without_the_app_notetypes() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::with_secret_store(
        dir.path().join("data"),
        Arc::new(core_store::SystemClock),
        Arc::new(MemoryStore::default()),
    );
    let preview = block_on(state.code_import_markdown(EXAMPLE.into())).unwrap();
    for item in &preview.items {
        assert!(
            item.errors.iter().any(|e| e.contains("Prepare a coleção")),
            "{item:?}"
        );
    }
    let deck = block_on(state.anki_deck_names()).unwrap()[0].id;
    let e = block_on(state.code_import_commit(EXAMPLE.into(), deck, vec![0, 1])).unwrap_err();
    assert_eq!(e.code, "code_notetypes_missing");
    state.shutdown();
}

fn program(env: &Env, role: &str) -> (String, String) {
    let p = fixture::PROGRAMS.iter().find(|p| p.role == role).unwrap();
    let note = block_on(env.state.anki_note_get(env.info.notes[role])).unwrap();
    // The code comes from the note, decoded like the UI does.
    let answer = html_to_code(&note.fields[3]);
    assert_eq!(answer, p.answer);
    (answer, html_to_code(&note.fields[6]))
}

#[test]
fn cpp_local_testes_saida_and_errors() {
    let env = Env::new();
    let status = env.state.code_status().unwrap();
    let local = status.cpp.local.as_ref().expect("desktop build");
    if local.compiler.is_none() {
        eprintln!("skipped: no g++/clang++ on the PATH");
        return;
    }
    if core_cpp::local_run_refusal().is_some() {
        // As root (CI's container) the local compiler is refused: no backend, and the error says why.
        assert_eq!(status.cpp_backend, CppBackendEffective::None);
        let files = BTreeMap::from([("main.cpp".to_string(), "int main(){}".to_string())]);
        let e = block_on(env.state.code_run_cpp(files, String::new())).unwrap_err();
        assert_eq!(e.code, "code_cpp_unavailable");
        assert!(e.message.contains("root"), "{}", e.message);
        return;
    }
    assert_eq!(status.cpp_backend, CppBackendEffective::Local);

    // testes: the solution plus the Testes main() with CHECK.
    let (answer, tests) = program(&env, "programaCpp");
    let files = BTreeMap::from([(
        "solucao.cpp".to_string(),
        format!("#include \"check.hpp\"\n{answer}\n{tests}\n"),
    )]);
    let r = block_on(env.state.code_run_cpp(files, String::new())).unwrap();
    assert!(r.compile.ok, "{}", r.compile.stderr);
    let run = r.run.unwrap();
    let pass = run.stdout.lines().filter(|l| l.starts_with("PASS")).count();
    assert_eq!(pass, 2, "{}", run.stdout);
    assert!(!run.stdout.contains("FAIL"));

    // saida.
    let (answer, _) = program(&env, "programaCppSaida");
    let files = BTreeMap::from([("main.cpp".to_string(), answer)]);
    let r = block_on(env.state.code_run_cpp(files, String::new())).unwrap();
    let run = r.run.unwrap();
    assert_eq!(run.stdout, "Olá, mundo!\n");
    assert_eq!(run.exit_code, Some(0));

    // A compile error.
    let files = BTreeMap::from([(
        "main.cpp".to_string(),
        "int main() { return x; }".to_string(),
    )]);
    let r = block_on(env.state.code_run_cpp(files, String::new())).unwrap();
    assert!(!r.compile.ok);
    assert!(r.run.is_none());
    assert!(!r.compile.stderr.is_empty());

    // Invalid file names are refused.
    let files = BTreeMap::from([("../x.cpp".to_string(), "int main(){}".to_string())]);
    let e = block_on(env.state.code_run_cpp(files, String::new())).unwrap_err();
    assert_eq!(e.code, "code_invalid_input");

    // Forced remote without a runner: unavailable.
    let patch = CodeSettingsPatch {
        cpp_backend: Some(CppBackendChoice::Remote),
        ..Default::default()
    };
    env.state.code_settings_set(patch).unwrap();
    assert_eq!(
        env.state.code_status().unwrap().cpp_backend,
        CppBackendEffective::None
    );
    let files = BTreeMap::from([("main.cpp".to_string(), "int main(){}".to_string())]);
    let e = block_on(env.state.code_run_cpp(files, String::new())).unwrap_err();
    assert_eq!(e.code, "code_cpp_unavailable");
    assert!(e.message.contains("Nenhum compilador"), "{}", e.message);
}

#[test]
fn cpp_remote_runner() {
    let (Ok(url), Ok(token)) = (
        std::env::var("LEITOR_RUNNER_TEST_URL"),
        std::env::var("LEITOR_RUNNER_TEST_TOKEN"),
    ) else {
        eprintln!("skipped: LEITOR_RUNNER_TEST_URL/LEITOR_RUNNER_TEST_TOKEN not set");
        return;
    };
    let env = Env::new();
    let patch = CodeSettingsPatch {
        cpp_backend: Some(CppBackendChoice::Remote),
        runner_url: Some(Some(url)),
        runner_token: Some(Some(token)),
        ..Default::default()
    };
    let settings = env.state.code_settings_set(patch).unwrap();
    assert!(settings.runner_token_set);
    assert_eq!(
        env.state.code_status().unwrap().cpp_backend,
        CppBackendEffective::Remote
    );
    let test = block_on(env.state.code_runner_test()).unwrap();
    assert!(test.ok, "{}", test.message);

    let (answer, tests) = program(&env, "programaCpp");
    let files = BTreeMap::from([(
        "solucao.cpp".to_string(),
        format!("#include \"check.hpp\"\n{answer}\n{tests}\n"),
    )]);
    let r = block_on(env.state.code_run_cpp(files, String::new())).unwrap();
    assert_eq!(r.backend, core_cpp::Backend::Remote);
    assert!(r.compile.ok, "{}", r.compile.stderr);
    let run = r.run.unwrap();
    assert_eq!(
        run.stdout.lines().filter(|l| l.starts_with("PASS")).count(),
        2,
        "{}",
        run.stdout
    );

    let (answer, _) = program(&env, "programaCppSaida");
    let files = BTreeMap::from([("main.cpp".to_string(), answer)]);
    let r = block_on(env.state.code_run_cpp(files, String::new())).unwrap();
    assert_eq!(r.run.unwrap().stdout, "Olá, mundo!\n");

    // A wrong token is reported as such.
    let patch = CodeSettingsPatch {
        runner_token: Some(Some("errado".into())),
        ..Default::default()
    };
    env.state.code_settings_set(patch).unwrap();
    let files = BTreeMap::from([("main.cpp".to_string(), "int main(){}".to_string())]);
    let e = block_on(env.state.code_run_cpp(files, String::new())).unwrap_err();
    assert_eq!(e.code, "code_runner_auth");
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn settings_and_the_token_never_on_disk() {
    let env = Env::new();
    let s = env.state.code_settings_get().unwrap();
    assert!(!s.suggest_easy && !s.output_exact);
    assert_eq!(s.suggest_easy_secs, 10);
    assert_eq!(s.cpp_backend, CppBackendChoice::Auto);
    assert_eq!(s.runner_url, None);
    assert!(!s.runner_token_set);
    let json = serde_json::to_value(&s).unwrap();
    assert_eq!(json["cppBackend"], "auto");
    assert!(json.get("runnerToken").is_none());

    // http only for local hosts.
    let insecure = CodeSettingsPatch {
        runner_url: Some(Some("http://runner.example.com".into())),
        ..Default::default()
    };
    let e = env.state.code_settings_set(insecure).unwrap_err();
    assert_eq!(e.code, "code_runner_insecure_url");
    // A token without a URL is refused.
    let e = env
        .state
        .code_settings_set(CodeSettingsPatch {
            runner_token: Some(Some("t".into())),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(e.code, "invalid_input");

    const TOKEN: &str = "token-secreto-do-runner-0123456789";
    let s = env
        .state
        .code_settings_set(CodeSettingsPatch {
            suggest_easy: Some(true),
            suggest_easy_secs: Some(7),
            output_exact: Some(true),
            cpp_backend: Some(CppBackendChoice::Local),
            runner_url: Some(Some("https://runner.example.com".into())),
            runner_token: Some(Some(TOKEN.into())),
        })
        .unwrap();
    assert!(s.suggest_easy && s.output_exact && s.runner_token_set);
    assert_eq!(s.suggest_easy_secs, 7);
    assert_eq!(s.cpp_backend, CppBackendChoice::Local);
    assert_eq!(s.runner_url.as_deref(), Some("https://runner.example.com/"));
    assert_eq!(
        env.secrets.accounts(),
        ["runner-token:https://runner.example.com/"]
    );
    let status = env.state.code_status().unwrap();
    assert!(status.cpp.remote.token_set);
    assert_eq!(
        status.cpp.remote.url.as_deref(),
        Some("https://runner.example.com/")
    );
    let e = env
        .state
        .code_settings_set(CodeSettingsPatch {
            suggest_easy_secs: Some(0),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(e.code, "invalid_input");

    // The token is in no file of the data dir (the store, the collection, WAL files…).
    env.state.shutdown();
    for path in files_under(&env.data) {
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            !bytes.windows(TOKEN.len()).any(|w| w == TOKEN.as_bytes()),
            "the runner token leaked into {}",
            path.display()
        );
    }

    // Changing the URL forgets the old token; null clears both.
    let state = AppState::with_secret_store(
        env.data.clone(),
        Arc::new(core_store::SystemClock),
        env.secrets.clone(),
    );
    let s = state
        .code_settings_set(CodeSettingsPatch {
            runner_url: Some(Some("http://runner-proxy:8080".into())),
            ..Default::default()
        })
        .unwrap();
    assert!(!s.runner_token_set);
    assert!(env.secrets.accounts().is_empty());
    let s = state
        .code_settings_set(CodeSettingsPatch {
            runner_token: Some(Some("t2".into())),
            ..Default::default()
        })
        .unwrap();
    assert!(s.runner_token_set);
    let s = state
        .code_settings_set(CodeSettingsPatch {
            runner_url: Some(None),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s.runner_url, None);
    assert!(!s.runner_token_set);
    assert!(env.secrets.accounts().is_empty());
    state.shutdown();
}

#[test]
fn format_cpp_on_desktop() {
    let r = block_on(leitor_app::code::format_cpp(
        "int  main( ){return 0;}".into(),
    ))
    .unwrap();
    match r.formatter {
        Some(f) => {
            assert_eq!(f, "clang-format");
            assert_ne!(r.formatted, "int  main( ){return 0;}");
        }
        None => assert_eq!(r.formatted, "int  main( ){return 0;}"),
    }
}
