//! "Painel Anki do livro" through `AppState` with the fixture collection (spec 10.1, 10.2, 12.7, 14): the book's
//! decks and counts, the content deck, the per-book preferences, the cards of the book and "Definir palavra".

use std::path::PathBuf;
use std::time::Instant;

use core_anki::fixture::{self, FixtureInfo, FixtureOptions};
use core_anki::study::QueueCounts;
use core_store::setting_keys as keys;
use leitor_app::{AppState, BookCardKind, BookDeckRole, BookPanelInfo, BookPanelPatch};

mod common;

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

struct Env {
    _dir: tempfile::TempDir,
    state: AppState,
    info: FixtureInfo,
    /// The library book titled like the fixture's "Livros::Animal Farm" deck.
    uid: String,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root: PathBuf = dir.path().to_path_buf();
        let data = root.join("data");
        let info = fixture::build(&data.join("anki"), FixtureOptions::default()).unwrap();
        let state = AppState::new(data);
        let pdf = common::write(&root, "farm.pdf", &common::text_pdf(4, "Animal Farm"));
        let uid = state
            .library_add(&pdf, false)
            .unwrap()
            .book
            .book
            .book_uid
            .clone();
        Self {
            _dir: dir,
            state,
            info,
            uid,
        }
    }

    fn deck(&self, name: &str) -> i64 {
        self.info.decks[name]
    }

    fn info(&self) -> BookPanelInfo {
        block_on(self.state.book_panel_info(&self.uid)).unwrap()
    }

    fn set(&self, patch: BookPanelPatch) -> Result<BookPanelInfo, leitor_app::AppError> {
        block_on(self.state.book_panel_set(&self.uid, patch))
    }

    fn set_root(&self, deck: Option<i64>) {
        let value = deck.map_or(serde_json::Value::Null, Into::into);
        self.state
            .with_store(|s| s.set_setting(keys::VOCAB_ROOT_DECK_ID, value))
            .unwrap();
    }

    fn tree_counts(&self, full_name: &str) -> QueueCounts {
        let tree = block_on(self.state.anki_deck_tree()).unwrap();
        let node = tree.find(full_name).unwrap();
        QueueCounts {
            new: node.new_count,
            learn: node.learn_count,
            review: node.review_count,
        }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.state.shutdown();
    }
}

#[test]
fn info_without_a_vocab_root_falls_back_to_livros() {
    let env = Env::new();
    // Warm up the collection, then time the panel (spec target: < 50 ms; generous in debug builds).
    env.info();
    let t = Instant::now();
    let info = env.info();
    let ms = t.elapsed().as_millis();
    assert!(ms < 500, "book_panel_info took {ms} ms");
    assert_eq!(info.book_uid, env.uid);
    assert_eq!(info.title, "Animal Farm");
    assert_eq!(info.vocab_root_deck_id, None);
    assert_eq!(info.vocab_root_name, None);
    let vocab = &info.vocab_deck;
    assert_eq!(vocab.role, BookDeckRole::Vocab);
    assert_eq!(vocab.name, fixture::DECK_ANIMAL_FARM);
    assert_eq!(vocab.deck_id, Some(env.deck(fixture::DECK_ANIMAL_FARM)));
    assert!(vocab.exists);
    assert_eq!(
        vocab.counts,
        Some(env.tree_counts(fixture::DECK_ANIMAL_FARM))
    );
    assert!(vocab.counts.unwrap().new > 0);
    assert_eq!(info.content_deck, None);
    assert_eq!(
        (info.last_deck_id, info.last_kind, info.review_deck_id),
        (None, None, None)
    );

    let err = block_on(env.state.book_panel_info(&"f".repeat(64))).unwrap_err();
    assert_eq!(err.code, "book_not_found");
}

#[test]
fn info_with_a_vocab_root() {
    let env = Env::new();
    let oxford = env.deck(fixture::DECK_OXFORD);
    env.set_root(Some(oxford));
    let info = env.info();
    assert_eq!(info.vocab_root_deck_id, Some(oxford));
    assert_eq!(info.vocab_root_name.as_deref(), Some(fixture::DECK_OXFORD));
    assert_eq!(info.vocab_deck.name, "Oxford::Livros::Animal Farm");
    assert!(!info.vocab_deck.exists);
    assert_eq!(info.vocab_deck.deck_id, None);
    assert_eq!(info.vocab_deck.counts, None);

    let id = block_on(
        env.state
            .anki_deck_create("Oxford::Livros::Animal Farm".into()),
    )
    .unwrap();
    let info = env.info();
    assert_eq!(info.vocab_deck.deck_id, Some(id));
    assert!(info.vocab_deck.exists);
    assert_eq!(
        info.vocab_deck.counts,
        Some(QueueCounts {
            new: 0,
            learn: 0,
            review: 0
        })
    );

    // A deleted root is ignored (back to the fallback).
    block_on(env.state.anki_deck_delete(oxford)).unwrap();
    let info = env.info();
    assert_eq!(info.vocab_root_deck_id, None);
    assert_eq!(info.vocab_deck.name, fixture::DECK_ANIMAL_FARM);
}

#[test]
fn content_deck_set_cleared_and_deleted() {
    let env = Env::new();
    let math = env.deck(fixture::DECK_MATH);
    let info = env
        .set(BookPanelPatch {
            content_deck_id: Some(Some(math)),
            ..BookPanelPatch::default()
        })
        .unwrap();
    let content = info.content_deck.unwrap();
    assert_eq!(content.role, BookDeckRole::Content);
    assert_eq!(content.deck_id, Some(math));
    assert_eq!(content.name, fixture::DECK_MATH);
    assert_eq!(content.counts, Some(env.tree_counts(fixture::DECK_MATH)));
    // Stored in the book row (spec 14 `book.content_deck_id`).
    let entry = env.state.library_entry(&env.uid).unwrap();
    assert_eq!(entry.book.content_deck_id, Some(math));

    let info = env
        .set(BookPanelPatch {
            content_deck_id: Some(None),
            ..BookPanelPatch::default()
        })
        .unwrap();
    assert_eq!(info.content_deck, None);

    let gone = block_on(env.state.anki_deck_create("Conteúdo".into())).unwrap();
    env.set(BookPanelPatch {
        content_deck_id: Some(Some(gone)),
        ..BookPanelPatch::default()
    })
    .unwrap();
    block_on(env.state.anki_deck_delete(gone)).unwrap();
    let content = env.info().content_deck.unwrap();
    assert_eq!(content.deck_id, Some(gone));
    assert!(!content.exists);
    assert_eq!(content.counts, None);
}

#[test]
fn prefs_round_trip_and_invalid_decks() {
    let env = Env::new();
    let farm = env.deck(fixture::DECK_ANIMAL_FARM);
    let math = env.deck(fixture::DECK_MATH);
    let info = env
        .set(BookPanelPatch {
            last_deck_id: Some(Some(farm)),
            last_kind: Some(Some(BookCardKind::Cloze)),
            review_deck_id: Some(Some(math)),
            ..BookPanelPatch::default()
        })
        .unwrap();
    assert_eq!(info.last_deck_id, Some(farm));
    assert_eq!(info.last_kind, Some(BookCardKind::Cloze));
    assert_eq!(info.review_deck_id, Some(math));
    // Missing fields are left alone; null clears.
    let info = env
        .set(BookPanelPatch {
            last_kind: Some(None),
            ..BookPanelPatch::default()
        })
        .unwrap();
    assert_eq!(
        (info.last_deck_id, info.last_kind, info.review_deck_id),
        (Some(farm), None, Some(math))
    );
    assert_eq!(env.info(), info, "persisted");

    let err = env
        .set(BookPanelPatch {
            review_deck_id: Some(Some(424_242)),
            ..BookPanelPatch::default()
        })
        .unwrap_err();
    assert_eq!(err.code, "deck_not_found");
    assert_eq!(env.info().review_deck_id, Some(math), "nothing written");
    let err = env
        .set(BookPanelPatch {
            content_deck_id: Some(Some(424_242)),
            ..BookPanelPatch::default()
        })
        .unwrap_err();
    assert_eq!(err.code, "deck_not_found");
    let err = block_on(
        env.state
            .book_panel_set(&"e".repeat(64), BookPanelPatch::default()),
    )
    .unwrap_err();
    assert_eq!(err.code, "book_not_found");

    // A deck deleted later reads as unset.
    block_on(env.state.anki_deck_delete(math)).unwrap();
    assert_eq!(env.info().review_deck_id, None);
}

#[test]
fn book_cards_of_the_fixture() {
    let env = Env::new();
    let cards = block_on(env.state.anki_book_cards(fixture::BOOK_UID.into())).unwrap();
    assert!(!cards.is_empty());
    let farm = env.deck(fixture::DECK_ANIMAL_FARM);
    for c in &cards {
        assert_eq!(c.deck_id, farm);
        assert_eq!(c.page, 37);
        assert_eq!(c.query.as_deref(), Some("windmill"));
        assert!(!c.card_ids.is_empty());
        assert!(!c.preview.is_empty());
    }
    assert!(
        cards
            .iter()
            .any(|c| c.preview.contains("windmill") || c.notetype.contains("Leitor"))
    );
    // Another book has none; a malformed uid is refused.
    assert!(
        block_on(env.state.anki_book_cards(env.uid.clone()))
            .unwrap()
            .is_empty()
    );
    let err = block_on(env.state.anki_book_cards("ABC".into())).unwrap_err();
    assert_eq!(err.code, "anki_invalid_input");
}

#[test]
fn vocab_define_word_lemma_and_note() {
    let env = Env::new();
    let uid = env.uid.clone();
    for bad in ["two words", "", "   ", "...", &"a".repeat(65)] {
        let err = block_on(env.state.vocab_define(bad, Some(&uid))).unwrap_err();
        assert_eq!(err.code, "invalid_input", "{bad:?}");
        assert_eq!(err.message, "Selecione uma só palavra.");
    }
    let def = block_on(env.state.vocab_define("  Animals, ", None)).unwrap();
    assert_eq!(def.word, "Animals");
    assert_eq!(def.lemma, "animal");
    assert_eq!(def.vocab_root_deck_id, None);
    assert_eq!(def.note, None, "no vocabulary folder yet");
    let def = block_on(env.state.vocab_define("windmills", Some(&uid))).unwrap();
    assert_eq!(
        def.note, None,
        "the book's deck has no vocabulary note for it; the unrelated '5000 palavras' is not searched"
    );

    let words = env.deck(fixture::DECK_WORDS);
    env.set_root(Some(words));
    let def = block_on(env.state.vocab_define("windmills", Some(&uid))).unwrap();
    assert_eq!(def.lemma, "windmill");
    assert_eq!(def.vocab_root_deck_id, Some(words));
    assert_eq!(def.vocab_root_name.as_deref(), Some(fixture::DECK_WORDS));
    let note = def.note.expect("the fixture's windmill note");
    assert_eq!(note.deck_name, fixture::DECK_WORDS);
    assert!(note.definition.is_some_and(|d| !d.is_empty()));
    assert_eq!(note.notetype, "Vocabulário · Livro");

    let def = block_on(env.state.vocab_define("ran", Some(&uid))).unwrap();
    assert_eq!(def.lemma, "run");
    assert_eq!(def.note, None);
}

/// Before the vocabulary folder exists (Phase 6), "Definir palavra" finds the note in the book's own vocabulary deck
/// (`Livros::<Título>`, the deck the panel and "Card da seleção" use).
#[test]
fn vocab_define_falls_back_to_the_book_deck() {
    let env = Env::new();
    let uid = env.uid.clone();
    let farm = env.deck(fixture::DECK_ANIMAL_FARM);
    let nts = block_on(env.state.anki_notetypes()).unwrap();
    let nt = nts
        .iter()
        .find(|n| n.name == "Vocabulário · Livro")
        .expect("the fixture's vocabulary notetype");
    let mut fields = vec![String::new(); nt.fields.len()];
    for (i, f) in nt.fields.iter().enumerate() {
        match f.name.as_str() {
            "Palavra" => fields[i] = "barns".into(),
            "Lema" => fields[i] = "barn".into(),
            "Definição" => fields[i] = "a farm building".into(),
            _ => {}
        }
    }
    let added = block_on(env.state.anki_note_add(core_anki::notes::NewNote {
        notetype_id: nt.id,
        deck_id: farm,
        fields,
        tags: vec![],
    }))
    .unwrap();

    let def = block_on(env.state.vocab_define("barn", Some(&uid))).unwrap();
    assert_eq!(def.vocab_root_deck_id, None);
    let note = def.note.expect("found in Livros::Animal Farm");
    assert_eq!(note.note_id, added.note_id);
    assert_eq!(note.deck_name, fixture::DECK_ANIMAL_FARM);
    assert_eq!(note.definition.as_deref(), Some("a farm building"));
    // Without a book, or with an unknown / malformed one, there is nothing to search.
    for book in [None, Some("f".repeat(64)), Some("ABC".to_string())] {
        let def = block_on(env.state.vocab_define("barn", book.as_deref())).unwrap();
        assert_eq!(def.note, None, "{book:?}");
    }
    // A chosen folder wins over the book's deck.
    env.set_root(Some(env.deck(fixture::DECK_WORDS)));
    let def = block_on(env.state.vocab_define("barn", Some(&uid))).unwrap();
    assert_eq!(def.note, None);
    // A deleted folder reads as unset: back to the book's deck.
    block_on(env.state.anki_deck_delete(env.deck(fixture::DECK_WORDS))).unwrap();
    let def = block_on(env.state.vocab_define("barn", Some(&uid))).unwrap();
    assert_eq!(def.vocab_root_deck_id, None);
    assert_eq!(def.note.map(|n| n.note_id), Some(added.note_id));
}
