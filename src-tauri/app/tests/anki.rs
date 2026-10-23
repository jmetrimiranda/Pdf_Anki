//! The Anki commands through `AppState` with the fixture collection (spec 8, 15, 20): decks,
//! studying, grant-checked import/export, `.colpkg` replacement with a backup, the backup ticker,
//! "Abrir com" of packages and media.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{Local, TimeZone};
use core_anki::fixture::{self, FixtureInfo, FixtureOptions};
use core_anki::study::{CardAction, StudyNext, StudyOwner};
use core_anki::{BackupKind, ExportOptions};
use leitor_app::{AppState, ChangeReason, StudyOwnerChange, UiEvent, open_paths_from_args};

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

/// An app data dir whose collection is the fixture, plus the events the core sent to the UI.
struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
    state: AppState,
    info: FixtureInfo,
    events: Arc<Mutex<Vec<UiEvent>>>,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let data = root.join("data");
        let info = fixture::build(&data.join("anki"), FixtureOptions::default()).unwrap();
        let state = AppState::new(data);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        state.set_ui_sink(Arc::new(move |e| sink.lock().unwrap().push(e)));
        Self {
            _dir: dir,
            root,
            state,
            info,
            events,
        }
    }

    fn deck(&self, name: &str) -> i64 {
        self.info.decks[name]
    }

    fn events(&self) -> Vec<UiEvent> {
        self.events.lock().unwrap().clone()
    }

    fn deck_names(&self) -> Vec<String> {
        block_on(self.state.anki_deck_names())
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect()
    }

    /// Exports a deck to `<root>/<name>` (granting the path like the save dialog would).
    fn export(&self, deck: &str, name: &str) -> PathBuf {
        let path = self.root.join(name);
        self.state.export_grants().grant(path.clone());
        let res = block_on(self.state.anki_export(
            self.deck(deck),
            path.to_str().unwrap(),
            ExportOptions {
                with_scheduling: true,
                with_media: true,
            },
        ))
        .unwrap();
        assert!(res.notes > 0);
        path
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.state.shutdown();
    }
}

#[test]
fn deck_commands() {
    let env = Env::new();
    let tree = block_on(env.state.anki_deck_tree()).unwrap();
    assert!(tree.find(fixture::DECK_WORDS).is_some());
    assert!(
        env.deck_names()
            .contains(&fixture::DECK_OXFORD_3000.to_string())
    );

    let id = block_on(env.state.anki_deck_create("Novo deck".into())).unwrap();
    block_on(env.state.anki_deck_rename(id, "Renomeado".into())).unwrap();
    block_on(
        env.state
            .anki_deck_move(vec![id], Some(env.deck(fixture::DECK_OXFORD))),
    )
    .unwrap();
    assert!(env.deck_names().contains(&"Oxford::Renomeado".to_string()));
    block_on(
        env.state
            .anki_deck_set_collapsed(env.deck(fixture::DECK_OXFORD), true),
    )
    .unwrap();
    let tree = block_on(env.state.anki_deck_tree()).unwrap();
    assert!(tree.find(fixture::DECK_OXFORD).unwrap().collapsed);
    block_on(
        env.state
            .anki_set_current_deck(env.deck(fixture::DECK_MATH)),
    )
    .unwrap();
    assert_eq!(
        block_on(env.state.anki_deck_tree())
            .unwrap()
            .current_deck_id,
        env.deck(fixture::DECK_MATH)
    );
    let deleted = block_on(env.state.anki_deck_delete(id)).unwrap();
    assert_eq!(deleted.cards_deleted, 0);
    assert!(!env.deck_names().iter().any(|n| n.ends_with("Renomeado")));

    let report = block_on(env.state.anki_prepare_collection()).unwrap();
    assert!(report.created.is_empty(), "the fixture already has them");
    assert_eq!(
        report.existing.len(),
        core_anki::notetypes::APP_NOTETYPES.len()
    );

    let err = block_on(env.state.anki_deck_rename(id, "x".into())).unwrap_err();
    assert!(err.code.starts_with("anki_"), "{err:?}");
}

#[test]
fn study_next_answer_undo() {
    let env = Env::new();
    let deck = env.deck(fixture::DECK_WORDS);
    let first = block_on(env.state.anki_study_next(deck, None)).unwrap();
    let card = first.card().expect("the fixture has cards due").clone();
    assert_eq!(card.deck_id, deck);
    assert!(card.buttons.iter().all(|b| !b.is_empty()));
    let answer = block_on(env.state.anki_show_answer(card.card_id, None)).unwrap();
    assert!(!answer.html.is_empty());
    let next = block_on(env.state.anki_answer(card.card_id, 3, 4_000)).unwrap();
    let can_undo = match &next {
        StudyNext::Card { card } => card.can_undo,
        StudyNext::Done { can_undo, .. } => *can_undo,
    };
    assert!(can_undo);
    let back = block_on(env.state.anki_undo()).unwrap();
    assert_eq!(back.card().map(|c| c.card_id), Some(card.card_id));
    let bad = block_on(env.state.anki_answer(card.card_id, 5, 1)).unwrap_err();
    assert_eq!(bad.code, "invalid_request");
    let flagged = block_on(
        env.state
            .anki_card_action(card.card_id, CardAction::Flag, Some(2)),
    )
    .unwrap();
    assert_eq!(flagged.flag, 2);
    env.state.anki_study_close(None).unwrap();
    let err = block_on(env.state.anki_undo()).unwrap_err();
    assert!(err.code.starts_with("anki_"), "{err:?}");
}

fn owner_events(env: &Env) -> Vec<StudyOwnerChange> {
    env.events()
        .into_iter()
        .filter_map(|e| match e {
            UiEvent::StudyOwner(c) => Some(c),
            _ => None,
        })
        .collect()
}

fn current_deck(env: &Env) -> i64 {
    block_on(env.state.anki_deck_tree())
        .unwrap()
        .current_deck_id
}

fn can_undo(next: &StudyNext) -> bool {
    match next {
        StudyNext::Card { card } => card.can_undo,
        StudyNext::Done { can_undo, .. } => *can_undo,
    }
}

const TAB: Option<StudyOwner> = Some(StudyOwner::Tab);
const PANEL: Option<StudyOwner> = Some(StudyOwner::Panel);

#[test]
fn mini_review_preempts_the_tab_and_restores_the_deck() {
    let env = Env::new();
    let words = env.deck(fixture::DECK_WORDS);
    let farm = env.deck(fixture::DECK_ANIMAL_FARM);
    let first = block_on(env.state.anki_study_next(words, None)).unwrap();
    let card = first.card().unwrap().card_id;
    let next = block_on(env.state.anki_answer(card, 3, 2_000)).unwrap();
    assert!(can_undo(&next));
    assert_eq!(
        owner_events(&env),
        vec![StudyOwnerChange {
            owner: TAB,
            preempted: None
        }]
    );
    assert_eq!(current_deck(&env), words);

    // "Revisar aqui" takes the session from the tab and switches the current deck.
    let opened = block_on(env.state.anki_mini_review_open(farm)).unwrap();
    assert_eq!(opened.previous_deck_id, words);
    assert_eq!(opened.preempted, Some(StudyOwner::Tab));
    assert_eq!(opened.next.card().map(|c| c.deck_id), Some(farm));
    assert_eq!(current_deck(&env), farm);
    assert_eq!(
        owner_events(&env).last(),
        Some(&StudyOwnerChange {
            owner: PANEL,
            preempted: TAB
        })
    );
    // Switching decks is not an answer: Ctrl+Z has nothing to undo (spec 10.1).
    assert!(!can_undo(&opened.next));
    assert!(block_on(env.state.anki_undo()).is_err());

    // The tab leaving (its screen unmounts) does not end the panel's session.
    env.state.anki_study_close(TAB).unwrap();
    let panel_card = opened.next.card().unwrap().card_id;
    block_on(env.state.anki_show_answer(panel_card, None)).unwrap();
    let after = block_on(env.state.anki_answer(panel_card, 3, 1_000)).unwrap();
    assert!(
        can_undo(&after),
        "an answer in the mini-review can be undone"
    );

    // Closing restores the deck from before the mini-review.
    let closed = block_on(env.state.anki_mini_review_close()).unwrap();
    assert_eq!(closed.restored_deck_id, Some(words));
    assert_eq!(current_deck(&env), words);
    assert_eq!(
        owner_events(&env).last(),
        Some(&StudyOwnerChange {
            owner: None,
            preempted: None
        })
    );
    assert_eq!(owner_events(&env).len(), 3);
    // Nothing to close any more: no event, no error.
    let again = block_on(env.state.anki_mini_review_close()).unwrap();
    assert_eq!(again.restored_deck_id, None);
    env.state.anki_study_close(PANEL).unwrap();
    assert_eq!(owner_events(&env).len(), 3);
}

#[test]
fn tab_preempting_the_mini_review_keeps_its_deck() {
    let env = Env::new();
    let words = env.deck(fixture::DECK_WORDS);
    let math = env.deck(fixture::DECK_MATH);
    let farm = env.deck(fixture::DECK_ANIMAL_FARM);
    block_on(env.state.anki_set_current_deck(words)).unwrap();
    let opened = block_on(env.state.anki_mini_review_open(farm)).unwrap();
    assert_eq!(opened.preempted, None);
    assert_eq!(
        owner_events(&env),
        vec![StudyOwnerChange {
            owner: PANEL,
            preempted: None
        }]
    );
    // The Anki tab starts studying another deck: the panel is preempted.
    block_on(env.state.anki_study_next(math, TAB)).unwrap();
    assert_eq!(
        owner_events(&env).last(),
        Some(&StudyOwnerChange {
            owner: TAB,
            preempted: PANEL
        })
    );
    // The panel's close does not end the tab's session nor bring the old deck back.
    env.state.anki_study_close(PANEL).unwrap();
    let closed = block_on(env.state.anki_mini_review_close()).unwrap();
    assert_eq!(closed.restored_deck_id, None);
    assert_eq!(current_deck(&env), math);
    assert_eq!(owner_events(&env).len(), 2);
    let next = block_on(env.state.anki_study_next(math, None)).unwrap();
    assert!(next.card().is_some(), "the tab still studies");
    assert_eq!(owner_events(&env).len(), 2, "same owner: no event");
}

#[test]
fn colpkg_replacement_tells_the_ui_nobody_studies() {
    let env = Env::new();
    block_on(
        env.state
            .anki_mini_review_open(env.deck(fixture::DECK_MATH)),
    )
    .unwrap();
    let backup = block_on(env.state.anki_backup_now()).unwrap();
    env.state.read_grants().grant(PathBuf::from(&backup.path));
    block_on(env.state.anki_import_colpkg(&backup.path)).unwrap();
    assert_eq!(
        owner_events(&env).last(),
        Some(&StudyOwnerChange {
            owner: None,
            preempted: None
        })
    );
    // The remembered deck is gone with the session: closing restores nothing.
    let closed = block_on(env.state.anki_mini_review_close()).unwrap();
    assert_eq!(closed.restored_deck_id, None);
}

#[test]
fn apkg_import_needs_a_read_grant_and_the_right_extension() {
    let env = Env::new();
    let apkg = env.export(fixture::DECK_MATH, "matematica.apkg");
    let path = apkg.to_str().unwrap();

    let err = block_on(env.state.anki_import(path)).unwrap_err();
    assert_eq!(err.code, "anki_path_not_allowed");

    // A grant for the wrong kind of package does not help.
    let renamed = env.root.join("matematica.colpkg");
    std::fs::copy(&apkg, &renamed).unwrap();
    env.state.read_grants().grant(renamed.clone());
    let err = block_on(env.state.anki_import(renamed.to_str().unwrap())).unwrap_err();
    assert_eq!(err.code, "anki_path_not_allowed");

    env.state.read_grants().grant(apkg.clone());
    let summary = block_on(env.state.anki_import(path)).unwrap();
    assert!(
        summary.added + summary.updated + summary.duplicates > 0,
        "{summary:?}"
    );
    assert!(
        env.events()
            .contains(&UiEvent::AnkiChanged(ChangeReason::Import))
    );
    // One-shot.
    let err = block_on(env.state.anki_import(path)).unwrap_err();
    assert_eq!(err.code, "anki_path_not_allowed");

    // An untrusted, broken package is an error, not a crash.
    let broken = env.root.join("quebrado.apkg");
    std::fs::write(&broken, b"PK\x03\x04 not really a zip").unwrap();
    env.state.read_grants().grant(broken.clone());
    let err = block_on(env.state.anki_import(broken.to_str().unwrap())).unwrap_err();
    assert!(err.code.starts_with("anki_"), "{err:?}");
}

#[test]
fn export_needs_an_export_grant() {
    let env = Env::new();
    let path = env.root.join("sem-permissao.apkg");
    let opts = ExportOptions {
        with_scheduling: false,
        with_media: false,
    };
    let err = block_on(env.state.anki_export(
        env.deck(fixture::DECK_MATH),
        path.to_str().unwrap(),
        opts,
    ))
    .unwrap_err();
    assert_eq!(err.code, "export_not_granted");
    assert!(!path.exists());
    // A read grant is not a write grant, and the extension must be .apkg.
    env.state.read_grants().grant(path.clone());
    assert!(
        block_on(
            env.state
                .anki_export(env.deck(fixture::DECK_MATH), path.to_str().unwrap(), opts)
        )
        .is_err()
    );
    let pdf = env.root.join("x.pdf");
    env.state.export_grants().grant(pdf.clone());
    assert!(
        block_on(
            env.state
                .anki_export(env.deck(fixture::DECK_MATH), pdf.to_str().unwrap(), opts)
        )
        .is_err()
    );
    let ok = env.export(fixture::DECK_MATH, "ok.apkg");
    assert!(ok.is_file());
}

#[test]
fn colpkg_import_replaces_the_collection_after_a_backup() {
    let env = Env::new();
    // Another profile with a different collection, saved as a .colpkg.
    let other = AppState::new(env.root.join("other"));
    block_on(other.anki_deck_create("Só no colpkg".into())).unwrap();
    let colpkg = PathBuf::from(block_on(other.anki_backup_now()).unwrap().path);
    other.shutdown();
    assert!(colpkg.is_file());

    let path = colpkg.to_str().unwrap();
    assert_eq!(
        block_on(env.state.anki_import_colpkg(path))
            .unwrap_err()
            .code,
        "anki_path_not_allowed"
    );
    assert!(env.deck_names().contains(&fixture::DECK_WORDS.to_string()));

    // Study something first: the session must not survive the replacement.
    block_on(
        env.state
            .anki_study_next(env.deck(fixture::DECK_WORDS), None),
    )
    .unwrap();

    env.state.read_grants().grant(colpkg.clone());
    let backup = block_on(env.state.anki_import_colpkg(path)).unwrap();
    assert_eq!(backup.kind, BackupKind::PreImport);
    assert!(Path::new(&backup.path).is_file());
    let names = env.deck_names();
    assert!(names.contains(&"Só no colpkg".to_string()), "{names:?}");
    assert!(
        !names.contains(&fixture::DECK_WORDS.to_string()),
        "{names:?}"
    );
    let backups = env.state.anki_backups().unwrap();
    assert!(backups.iter().any(|b| b.kind == BackupKind::PreImport));
    assert!(
        env.events()
            .contains(&UiEvent::AnkiChanged(ChangeReason::Colpkg))
    );
    let err = block_on(env.state.anki_undo()).unwrap_err();
    assert!(err.code.starts_with("anki_"), "{err:?}");

    // The pre-import backup brings the fixture back.
    env.state.read_grants().grant(PathBuf::from(&backup.path));
    block_on(env.state.anki_import_colpkg(&backup.path)).unwrap();
    assert!(env.deck_names().contains(&fixture::DECK_WORDS.to_string()));
}

#[test]
fn open_with_grants_packages() {
    let env = Env::new();
    let apkg = env.export(fixture::DECK_GRAMMAR, "gramatica.apkg");
    let colpkg = env.root.join("Colecao.COLPKG");
    std::fs::write(&colpkg, b"x").unwrap();
    let paths = open_paths_from_args(
        [
            "--x".to_string(),
            apkg.display().to_string(),
            colpkg.display().to_string(),
            "nada.apkg".into(),
        ],
        &env.root,
    );
    assert_eq!(
        paths,
        vec![apkg.display().to_string(), colpkg.display().to_string()]
    );
    env.state.push_open_paths(paths.clone());
    assert!(env.state.read_grants().is_granted(&apkg));
    assert!(env.state.read_grants().is_granted(&colpkg));
    assert_eq!(env.state.take_open_paths(), paths);
    block_on(env.state.anki_import(apkg.to_str().unwrap())).unwrap();
}

#[test]
fn daily_backup_ticker() {
    let env = Env::new();
    let day1 = Local.with_ymd_and_hms(2026, 10, 20, 9, 0, 0).unwrap();
    let made = block_on(env.state.anki_backup_tick(day1)).unwrap();
    assert_eq!(made.map(|b| b.kind), Some(BackupKind::Daily));
    assert!(
        block_on(
            env.state
                .anki_backup_tick(day1 + chrono::Duration::hours(10))
        )
        .unwrap()
        .is_none()
    );
    let day2 = day1 + chrono::Duration::days(1);
    assert!(
        block_on(env.state.anki_backup_tick(day2))
            .unwrap()
            .is_some()
    );
    let daily = env
        .state
        .anki_backups()
        .unwrap()
        .into_iter()
        .filter(|b| b.kind == BackupKind::Daily)
        .count();
    assert_eq!(daily, 2);
    assert!(
        env.events()
            .contains(&UiEvent::AnkiChanged(ChangeReason::Backup))
    );
    // The collection still works after the backups closed and reopened it.
    assert!(block_on(env.state.anki_deck_tree()).is_ok());
    env.state.shutdown();
    assert!(
        block_on(env.state.anki_backup_tick(day2 + chrono::Duration::days(1)))
            .unwrap()
            .is_none()
    );
}

#[test]
fn media_add_and_serve() {
    let env = Env::new();
    let png = b"\x89PNG\r\n\x1a\n fake".to_vec();
    let name = block_on(env.state.anki_media_add("colada.png".into(), png.clone())).unwrap();
    let media = core_anki::CollectionPaths::in_dir(&env.state.anki_dir()).media_folder;
    assert_eq!(std::fs::read(media.join(&name)).unwrap(), png);
    let too_big = vec![0u8; core_anki::media::MAX_MEDIA_BYTES + 1];
    let err = block_on(env.state.anki_media_add("x.png".into(), too_big)).unwrap_err();
    assert_eq!(err.code, "anki_too_large");

    let frames = leitor_app::protocol_card::CardFrames::new(
        leitor_app::anki_web::AnkiWeb::missing(),
        media,
        &["tauri://localhost".into()],
    );
    let req = tauri::http::Request::builder()
        .uri(format!("card://localhost/{name}"))
        .body(Vec::new())
        .unwrap();
    match frames.route(&req) {
        leitor_app::protocol_card::Routed::Reply(res) => {
            assert_eq!(res.status(), 200);
            assert_eq!(res.body(), &png);
        }
        leitor_app::protocol_card::Routed::Post(_) => panic!("GET routed as POST"),
    }
}

#[test]
fn notes_and_browse_through_the_state() {
    let env = Env::new();
    let ids = block_on(
        env.state
            .anki_search(format!("\"deck:{}\"", fixture::DECK_MATH), None),
    )
    .unwrap();
    assert!(!ids.is_empty());
    let rows = block_on(env.state.anki_browse_rows(ids.clone())).unwrap();
    assert_eq!(rows.len(), ids.len());
    let note_id = rows[0].note_id;
    let note = block_on(env.state.anki_note_get(note_id)).unwrap();
    let prepared = block_on(env.state.anki_change_notetype_prepare(vec![note_id])).unwrap();
    assert_eq!(prepared.notetype_id, note.notetype_id);
    let tags = vec!["leitor".to_string()];
    block_on(
        env.state
            .anki_note_update(note_id, note.fields.clone(), tags),
    )
    .unwrap();
    assert!(
        block_on(env.state.anki_tags_all())
            .unwrap()
            .contains(&"leitor".to_string())
    );
    let types = block_on(env.state.anki_notetypes()).unwrap();
    assert!(!types.is_empty());
}
