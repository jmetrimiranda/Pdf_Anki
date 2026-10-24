//! Library, book versions, export and reading sessions through `AppState` (no webview), on a
//! temporary data dir with PDFs built in memory (spec 20, Phase 1).

mod common;

use std::sync::Arc;

use common::*;
use core_store::{ManualClock, StopReason, book_uid_of};
use leitor_app::AppState;
use leitor_app::library::AddOutcome;

fn files_in(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[test]
fn adds_a_text_pdf() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let bytes = text_pdf(3, "Meu livro");
    let path = write(tmp.path(), "meu-livro.pdf", &bytes);

    let added = state.library_add(&path, false).unwrap();
    assert_eq!(added.outcome, AddOutcome::Created);
    let book = &added.book.book;
    assert_eq!(book.book_uid, book_uid_of(&bytes));
    assert_eq!(book.file_hash, book.book_uid);
    assert_eq!(book.file_version, 1);
    assert_eq!(book.title, "Meu livro");
    assert_eq!(book.author.as_deref(), Some("Autora"));
    assert_eq!(book.pages, 3);
    assert!(book.has_text);
    assert_eq!(book.file_name, "meu-livro.pdf");
    assert!(added.book.position.is_none());

    // Copied into the app folder under a relative path; the cover is cached.
    let local = book.local_path.clone().unwrap();
    assert!(
        local.starts_with(&format!("books/{}/v1-", book.book_uid)),
        "{local}"
    );
    assert_eq!(state.book_bytes(&book.book_uid).unwrap(), bytes);
    let cover = state.files().cover_path(&book.book_uid, 1);
    assert!(cover.is_file());
    let png = state.cover_png(&book.book_uid).unwrap().unwrap();
    assert!(png.starts_with(b"\x89PNG"));

    // The cover is regenerated after the cache is gone.
    std::fs::remove_file(&cover).unwrap();
    assert!(state.cover_png(&book.book_uid).unwrap().is_some());
    assert!(cover.is_file());

    // Adding the same file again changes nothing.
    let again = state.library_add(&path, false).unwrap();
    assert_eq!(again.outcome, AddOutcome::Existing);
    assert_eq!(again.book.book, added.book.book);
    assert_eq!(state.library_list().unwrap().len(), 1);

    // Words of a page come from the current version.
    let words = state.doc_words(&book.book_uid, 1).unwrap();
    assert!(words.text.contains("Page 2 line 1"));
    assert!(!words.words.is_empty());
    assert!(state.doc_words(&book.book_uid, 9).is_err());
}

#[test]
fn flags_scanned_pdfs() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let path = write(tmp.path(), "scan.pdf", &scanned_pdf(4));
    let added = state.library_add(&path, false).unwrap();
    assert!(!added.book.book.has_text);
    assert_eq!(added.book.book.title, "scan");
    assert_eq!(added.book.book.pages, 4);
}

#[test]
fn corrupted_pdfs_fail_without_copying() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let mut broken = text_pdf(2, "Quebrado");
    broken.truncate(40);
    for (name, bytes) in [
        ("quebrado.pdf", broken),
        ("lixo.pdf", b"isto nao e um pdf".to_vec()),
        ("vazio.pdf", Vec::new()),
    ] {
        let path = write(tmp.path(), name, &bytes);
        let err = state.library_add(&path, false).unwrap_err();
        assert_eq!(err.code, "pdf_invalid", "{name}: {err:?}");
        assert!(!err.message.is_empty());
    }
    let missing = state
        .library_add(&tmp.path().join("nao-existe.pdf"), false)
        .unwrap_err();
    assert_eq!(missing.code, "file_read");
    assert!(state.library_list().unwrap().is_empty());
    assert!(files_in(&state.data_dir().join("books")).is_empty());
}

#[test]
fn password_pdfs_are_imported_by_name() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let path = write(tmp.path(), "Relatório secreto.pdf", &protected_pdf());
    let added = state.library_add(&path, false).unwrap();
    let book = &added.book.book;
    assert_eq!(added.outcome, AddOutcome::Created);
    assert_eq!(book.title, "Relatório secreto");
    assert_eq!(book.pages, 0);
    assert!(book.has_text);
    assert!(state.cover_png(&book.book_uid).unwrap().is_none());
    assert!(state.book_bytes(&book.book_uid).is_ok());
}

#[test]
fn other_formats_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    // An `.epub` that is not an EPUB is refused as such (EPUB import: tests/epub.rs).
    let epub = write(tmp.path(), "livro.epub", b"PK\x03\x04");
    let err = state.library_add(&epub, false).unwrap_err();
    assert_eq!(err.code, "epub_invalid");
    assert!(state.library_list().unwrap().is_empty());
    let txt = write(tmp.path(), "notas.txt", b"x");
    assert_eq!(
        state.library_add(&txt, false).unwrap_err().code,
        "unsupported_format"
    );
}

#[test]
fn stamped_files_join_their_book() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let original = text_pdf(2, "Original");
    let uid = book_uid_of(&original);
    state
        .library_add(&write(tmp.path(), "original.pdf", &original), false)
        .unwrap();

    // An exported copy with annotations comes back: same book. It differs from the current
    // version, so nothing changes until the user confirms the replacement.
    let annotated = annotated_version(&original, &uid);
    let exported = write(tmp.path(), "exportado.pdf", &annotated);
    let asked = state.library_add(&exported, false).unwrap();
    assert_eq!(asked.outcome, AddOutcome::OtherVersion);
    assert_eq!(asked.book.book.book_uid, uid);
    assert_eq!(asked.book.book.file_version, 1);
    assert_eq!(state.book_bytes(&uid).unwrap(), original);
    // Confirmed: version 2.
    let added = state.library_add(&exported, true).unwrap();
    assert_eq!(added.outcome, AddOutcome::NewVersion);
    assert_eq!(added.book.book.book_uid, uid);
    assert_eq!(added.book.book.file_version, 2);
    assert_eq!(added.book.book.file_hash, book_uid_of(&annotated));
    assert_eq!(state.book_bytes(&uid).unwrap(), annotated);
    assert_eq!(state.library_list().unwrap().len(), 1);
    // Adding it once more is a no-op.
    let again = state
        .library_add(&write(tmp.path(), "exportado2.pdf", &annotated), false)
        .unwrap();
    assert_eq!(again.outcome, AddOutcome::Existing);
    assert_eq!(again.book.book.file_version, 2);

    // A removed book comes back with the stamped file as a new version.
    state.library_remove(&uid).unwrap();
    assert!(state.library_list().unwrap().is_empty());
    assert!(!state.files().book_dir(&uid).exists());
    let other = annotated_version(&text_pdf(2, "Original "), &uid);
    let back = state
        .library_add(&write(tmp.path(), "volta.pdf", &other), false)
        .unwrap();
    assert_eq!(back.outcome, AddOutcome::NewVersion);
    assert_eq!(back.book.book.book_uid, uid);
    assert_eq!(back.book.book.file_version, 3);
    assert_eq!(state.book_bytes(&uid).unwrap(), other);
}

/// Re-adding an older exported copy never deletes the newest annotations, even after several
/// replacements and autosaves (spec 6.5/16: nothing is lost).
#[test]
fn replacing_with_an_old_copy_keeps_the_replaced_version() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let original = text_pdf(2, "Original");
    let uid = book_uid_of(&original);
    state
        .library_add(&write(tmp.path(), "original.pdf", &original), false)
        .unwrap();
    // An old copy is exported, then the book is annotated further in the app (v2, v3).
    let old_copy = annotated_version(&original, &uid);
    let old_path = write(tmp.path(), "antigo.pdf", &old_copy);
    let v2 = annotated_version(&text_pdf(2, "Original v2"), &uid);
    let newest = annotated_version(&text_pdf(2, "Original v3 newest"), &uid);
    state.book_save_version(&uid, v2).unwrap();
    state.book_save_version(&uid, newest.clone()).unwrap();

    // Without confirmation nothing moves.
    let asked = state.library_add(&old_path, false).unwrap();
    assert_eq!(asked.outcome, AddOutcome::OtherVersion);
    assert_eq!(state.book_bytes(&uid).unwrap(), newest);

    // Confirmed, then autosaved twice and replaced again: the newest annotations survive.
    assert_eq!(
        state.library_add(&old_path, true).unwrap().outcome,
        AddOutcome::NewVersion
    );
    let edit1 = annotated_version(&text_pdf(2, "Old edited 1"), &uid);
    let edit2 = annotated_version(&text_pdf(2, "Old edited 2"), &uid);
    state.book_save_version(&uid, edit1).unwrap();
    state.book_save_version(&uid, edit2).unwrap();
    let other_old = annotated_version(&text_pdf(2, "Another old copy"), &uid);
    state
        .library_add(&write(tmp.path(), "outro.pdf", &other_old), true)
        .unwrap();
    state
        .book_save_version(&uid, annotated_version(&text_pdf(2, "Edit 3"), &uid))
        .unwrap();

    let dir = state.files().book_dir(&uid);
    let kept: Vec<String> = files_in(&dir)
        .into_iter()
        .filter(|n| n.starts_with("replaced-"))
        .collect();
    assert_eq!(kept.len(), 2, "{:?}", files_in(&dir));
    let newest_hash = book_uid_of(&newest);
    let newest_copy = kept
        .iter()
        .find(|n| n.starts_with(&format!("replaced-v3-{}", &newest_hash[..8])))
        .expect("the newest annotated version is kept");
    assert_eq!(std::fs::read(dir.join(newest_copy)).unwrap(), newest);

    // Removing the book deletes them with it.
    state.library_remove(&uid).unwrap();
    assert!(!dir.exists());
}

/// A stamped copy imported while the book is open in PdfCraft: the old tab keeps editing the old
/// content and autosaves on top of it. The imported version must survive those saves.
#[test]
fn a_save_from_a_stale_tab_keeps_the_imported_version() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let original = text_pdf(2, "Aberto");
    let uid = book_uid_of(&original);
    state
        .library_add(&write(tmp.path(), "aberto.pdf", &original), false)
        .unwrap();
    // The tab was opened from v1; then a stamped copy becomes v2.
    let imported = annotated_version(&text_pdf(2, "Importado"), &uid);
    let added = state
        .library_add(&write(tmp.path(), "importado.pdf", &imported), true)
        .unwrap();
    assert_eq!(added.outcome, AddOutcome::NewVersion);
    assert_eq!(added.book.book.file_version, 2);

    // Autosave from the stale tab (base v1), then two more saves from it.
    let stale1 = annotated_version(&text_pdf(2, "Velho 1"), &uid);
    let saved = state.book_save_version_from(&uid, stale1, Some(1)).unwrap();
    assert!(saved.kept_newer);
    assert_eq!(saved.file_version, 3);
    for (i, base) in [(2, 3), (3, 4)] {
        let next = annotated_version(&text_pdf(2, &format!("Velho {i}")), &uid);
        let saved = state
            .book_save_version_from(&uid, next, Some(base))
            .unwrap();
        assert!(!saved.kept_newer);
        assert_eq!(saved.file_version, base + 1);
    }

    let dir = state.files().book_dir(&uid);
    let imported_hash = book_uid_of(&imported);
    let copy = files_in(&dir)
        .into_iter()
        .find(|n| n.starts_with(&format!("replaced-v2-{}", &imported_hash[..8])))
        .unwrap_or_else(|| panic!("the imported version is kept: {:?}", files_in(&dir)));
    assert_eq!(std::fs::read(dir.join(copy)).unwrap(), imported);
}

#[test]
fn stamped_files_of_unknown_books_keep_the_stamp() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let original = text_pdf(1, "De outro aparelho");
    let uid = book_uid_of(&original);
    let annotated = annotated_version(&original, &uid);
    let added = state
        .library_add(&write(tmp.path(), "copia.pdf", &annotated), false)
        .unwrap();
    assert_eq!(added.outcome, AddOutcome::Created);
    assert_eq!(added.book.book.book_uid, uid);
    assert_eq!(added.book.book.file_hash, book_uid_of(&annotated));
    assert_eq!(added.book.book.file_version, 1);
}

#[test]
fn saved_versions_are_atomic_pruned_and_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let original = text_pdf(2, "Versões");
    let uid = book_uid_of(&original);
    state
        .library_add(&write(tmp.path(), "v.pdf", &original), false)
        .unwrap();
    let dir = state.files().book_dir(&uid);
    // Warm the words cache so the save has to invalidate it.
    state.doc_words(&uid, 0).unwrap();
    assert_eq!(state.open_doc_count(), 1);

    let v2 = annotated_version(&original, &uid);
    let saved = state.book_save_version(&uid, v2.clone()).unwrap();
    assert!(saved.changed);
    assert_eq!(saved.file_version, 2);
    assert_eq!(saved.file_hash, book_uid_of(&v2));
    assert_eq!(state.book_bytes(&uid).unwrap(), v2);
    assert_eq!(files_in(&dir).len(), 2, "current and previous are kept");
    assert_eq!(
        state.open_doc_count(),
        0,
        "the old version's document was closed"
    );

    // Same bytes: nothing new.
    let same = state.book_save_version(&uid, v2.clone()).unwrap();
    assert!(!same.changed);
    assert_eq!(same.file_version, 2);
    assert_eq!(files_in(&dir).len(), 2);

    // A third version prunes the first.
    let mut v3 = v2.clone();
    v3.extend_from_slice(b"\n% another revision\n");
    let saved3 = state.book_save_version(&uid, v3.clone()).unwrap();
    assert_eq!(saved3.file_version, 3);
    let names = files_in(&dir);
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.iter().any(|n| n.starts_with("v3-")));
    assert!(names.iter().any(|n| n.starts_with("v2-")));
    assert!(!names.iter().any(|n| n.starts_with("v1-")));
    assert!(!names.iter().any(|n| n.ends_with(".tmp")));
    let book = state.book_open(&uid).unwrap().book.book;
    assert_eq!(book.book_uid, uid);
    assert_eq!(book.file_version, 3);

    // Another book's file, non-PDFs and unknown books are refused; nothing changes.
    let foreign_original = text_pdf(1, "Outro");
    let foreign = annotated_version(&foreign_original, &book_uid_of(&foreign_original));
    let err = state.book_save_version(&uid, foreign).unwrap_err();
    assert_eq!(err.code, "pdf_foreign");
    let err = state
        .book_save_version(&uid, b"<html>".to_vec())
        .unwrap_err();
    assert_eq!(err.code, "pdf_invalid");
    let err = state
        .book_save_version(&"0".repeat(64), v3.clone())
        .unwrap_err();
    assert_eq!(err.code, "book_not_found");
    assert_eq!(state.book_bytes(&uid).unwrap(), v3);
    assert_eq!(files_in(&dir).len(), 2);
}

#[test]
fn export_stamps_the_original() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let original = text_pdf(1, "Exportar");
    let uid = book_uid_of(&original);
    state
        .library_add(&write(tmp.path(), "e.pdf", &original), false)
        .unwrap();
    let dest = tmp.path().join("saida").join("copia.pdf");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    state.book_export(&uid, &dest).unwrap();
    let exported = std::fs::read(&dest).unwrap();
    assert!(
        exported.starts_with(&original),
        "incremental: the original bytes stay"
    );
    assert_eq!(
        core_pdf::read_info(Arc::new(exported), core_pdf::LEITOR_BOOK_UID_KEY).unwrap(),
        Some(uid.clone())
    );

    // A saved version is already stamped and is exported as it is.
    let v2 = annotated_version(&original, &uid);
    state.book_save_version(&uid, v2.clone()).unwrap();
    state.book_export(&uid, &dest).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), v2);

    assert_eq!(
        state
            .book_export(&uid, std::path::Path::new("relativo.pdf"))
            .unwrap_err()
            .code,
        "invalid_path"
    );
    state
        .export_bytes(&tmp.path().join("aba.pdf"), b"%PDF-1.7 bytes")
        .unwrap();
    assert_eq!(
        std::fs::read(tmp.path().join("aba.pdf")).unwrap(),
        b"%PDF-1.7 bytes"
    );
    assert_eq!(
        state
            .export_bytes(&tmp.path().join("aba.txt"), b"x")
            .unwrap_err()
            .code,
        "invalid_path"
    );
}

#[test]
fn missing_files_are_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let original = text_pdf(1, "Sumiu");
    let uid = book_uid_of(&original);
    state
        .library_add(&write(tmp.path(), "s.pdf", &original), false)
        .unwrap();
    std::fs::remove_dir_all(state.files().book_dir(&uid)).unwrap();
    assert_eq!(state.book_bytes(&uid).unwrap_err().code, "file_missing");
    // Adding the file again brings it back.
    let again = state
        .library_add(&write(tmp.path(), "s.pdf", &original), false)
        .unwrap();
    assert_eq!(again.outcome, AddOutcome::Existing);
    assert_eq!(state.book_bytes(&uid).unwrap(), original);
}

#[test]
fn everything_survives_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let original = text_pdf(10, "Persistente");
    let uid = book_uid_of(&original);
    let annotated = annotated_version(&original, &uid);
    {
        let state = AppState::with_clock(data.clone(), clock.clone());
        state
            .library_add(&write(tmp.path(), "p.pdf", &original), false)
            .unwrap();
        state.book_save_version(&uid, annotated.clone()).unwrap();
        state.position_set(&uid, 7, 0.7, None).unwrap();
        // A session that is still open when the app dies.
        state.reading_session_start(&uid, 6).unwrap();
        clock.advance(45_000);
        state.reading_session_heartbeat(&uid, 7).unwrap();
        clock.advance(45_000);
        state.reading_session_heartbeat(&uid, 7).unwrap();
        // Dropped without stop or shutdown: a crash.
    }
    let state = AppState::new(data);
    assert_eq!(state.book_bytes(&uid).unwrap(), annotated);
    let opened = state.book_open(&uid).unwrap();
    assert_eq!(opened.page, 7);
    assert_eq!(opened.book.book.book_uid, uid);
    assert_eq!(opened.book.book.file_version, 2);
    assert_eq!(opened.book.position.as_ref().unwrap().page, 7);
    assert_eq!(state.position_get(&uid).unwrap().unwrap().page, 7);
    let sessions = state
        .with_store(|s| s.list_reading_sessions(Some(&uid)))
        .unwrap();
    assert_eq!(sessions.len(), 1, "{sessions:?}");
    let session = &sessions[0];
    assert!(session.ended_at.is_some(), "closed at the last heartbeat");
    assert_eq!(session.ended_at.unwrap() - session.started_at, 90_000);
    assert_eq!(session.pages, vec![6, 7]);
}

#[test]
fn reading_session_commands_drive_the_tracker() {
    let tmp = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::with_clock(tmp.path().join("data"), clock.clone());
    let a = text_pdf(3, "A");
    let b = text_pdf(3, "B");
    let (ua, ub) = (book_uid_of(&a), book_uid_of(&b));
    state
        .library_add(&write(tmp.path(), "a.pdf", &a), false)
        .unwrap();
    state
        .library_add(&write(tmp.path(), "b.pdf", &b), false)
        .unwrap();

    // Reading A for 3 min, then switching app tab.
    let started = state.reading_session_start(&ua, 0).unwrap();
    assert!(!started.session_uid.is_empty());
    for page in 1..=3 {
        clock.advance(60_000);
        state.reading_session_heartbeat(&ua, page.min(2)).unwrap();
    }
    let closed = state
        .reading_session_stop(None, StopReason::Tab)
        .unwrap()
        .unwrap();
    assert_eq!(closed.reason, StopReason::Tab);
    assert!(!closed.discarded);
    assert_eq!(closed.ended_at - closed.started_at, 180_000);
    assert!(
        state
            .reading_session_stop(None, StopReason::Tab)
            .unwrap()
            .is_none()
    );

    // B for 30 s: discarded.
    state.reading_session_start(&ub, 0).unwrap();
    clock.advance(30_000);
    // A late stop for A (sent before B came to the front) must not close B's session.
    assert!(
        state
            .reading_session_stop(Some(&ua), StopReason::Doc)
            .unwrap()
            .is_none()
    );
    let short = state
        .reading_session_stop(Some(&ub), StopReason::Doc)
        .unwrap()
        .unwrap();
    assert_eq!(short.book_uid, ub, "B's session stayed open");
    assert!(short.discarded);

    // A again, then 2 min of silence: the ticker ends it at the last activity.
    state.reading_session_start(&ua, 2).unwrap();
    clock.advance(90_000);
    state.reading_session_heartbeat(&ua, 2).unwrap();
    clock.advance(130_000);
    state.reading_tick().unwrap();
    assert!(
        state
            .reading_session_stop(None, StopReason::Tab)
            .unwrap()
            .is_none()
    );

    let sessions = state.with_store(|s| s.list_reading_sessions(None)).unwrap();
    assert_eq!(sessions.len(), 2, "{sessions:?}");
    assert!(
        sessions
            .iter()
            .all(|s| s.book_uid == ua && s.ended_at.is_some())
    );
    let idle = sessions
        .iter()
        .find(|s| s.ended_at.unwrap() - s.started_at == 90_000)
        .expect("the idle session ends at its last activity");
    assert_eq!(idle.pages, vec![2]);

    // Unknown books cannot start sessions; exit closes the open one.
    assert_eq!(
        state
            .reading_session_start(&"f".repeat(64), 0)
            .unwrap_err()
            .code,
        "book_not_found"
    );
    state.reading_session_start(&ub, 1).unwrap();
    clock.advance(70_000);
    state.reading_session_heartbeat(&ub, 1).unwrap();
    state.reading_stop_on_exit();
    let b_sessions = state
        .with_store(|s| s.list_reading_sessions(Some(&ub)))
        .unwrap();
    assert_eq!(b_sessions.len(), 1);
}

#[test]
fn library_update_and_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    let bytes = text_pdf(1, "Antes");
    let uid = book_uid_of(&bytes);
    state
        .library_add(&write(tmp.path(), "u.pdf", &bytes), false)
        .unwrap();
    let patch: leitor_app::library::LibraryPatch = serde_json::from_value(serde_json::json!({
        "title": "Depois",
        "author": null,
        "collectionFolder": "Estudos/Inglês"
    }))
    .unwrap();
    let entry = state.library_update(&uid, patch).unwrap();
    assert_eq!(entry.book.title, "Depois");
    assert_eq!(entry.book.author, None);
    assert_eq!(
        entry.book.collection_folder.as_deref(),
        Some("Estudos/Inglês")
    );
    assert!(
        serde_json::from_value::<leitor_app::library::LibraryPatch>(
            serde_json::json!({ "hasText": false })
        )
        .is_err(),
        "only the fields the UI may edit"
    );

    let json = serde_json::to_value(&entry).unwrap();
    assert_eq!(json["bookUid"], uid);
    assert_eq!(json["fileVersion"], 1);
    assert!(json.get("position").is_some());

    state.library_remove(&uid).unwrap();
    assert_eq!(state.book_open(&uid).unwrap_err().code, "book_not_found");
    assert!(state.cover_png(&uid).unwrap().is_none());
    assert!(!state.files().cover_path(&uid, 1).exists());
}

#[test]
fn open_with_paths_are_handed_over_once() {
    let tmp = tempfile::tempdir().unwrap();
    let state = state(tmp.path());
    state.push_open_paths(vec!["/a.pdf".into(), "/b.pdf".into()]);
    assert_eq!(state.take_open_paths(), vec!["/a.pdf", "/b.pdf"]);
    assert!(state.take_open_paths().is_empty());
}
