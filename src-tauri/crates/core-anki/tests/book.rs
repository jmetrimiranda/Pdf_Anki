//! The book panel's Anki side (spec 10.1, 10.2, 12.7): book decks and counts, cards of the book from their Fonte, the
//! vocabulary note of a word and the Fonte builder.
mod common;

use std::time::Instant;

use core_anki::anki::notes::AddNoteRequest;
use core_anki::anki::prelude::{DeckId, Note, Notetype};
use core_anki::book::{BookCard, PREVIEW_CHARS};
use core_anki::fixture::{
    BOOK_UID, DECK_ANIMAL_FARM, DECK_BOOKS, DECK_OXFORD, DECK_OXFORD_3000, DECK_WORDS,
};
use core_anki::notetypes::{BASIC_LEITOR, CLOZE_LEITOR, VOCAB_BOOK, stock_basic};
use core_anki::study::source::{parse_source, source_html, source_query};
use core_anki::{Collection, Error};

use common::fixture;

const OTHER_UID: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

fn notetype(col: &mut Collection, name: &str) -> core_anki::Result<std::sync::Arc<Notetype>> {
    col.get_notetype_by_name(name)?
        .ok_or_else(|| Error::NotFound(name.into()))
}

fn add(col: &mut Collection, nt: &Notetype, deck: i64, fields: &[&str]) -> core_anki::Result<i64> {
    let mut note: Note = nt.new_note();
    for (i, value) in fields.iter().enumerate() {
        note.set_field(i, *value)?;
    }
    col.add_note(&mut note, DeckId(deck))?;
    Ok(note.id.0)
}

#[tokio::test]
async fn book_cards_filter_parse_and_sort() -> anyhow::Result<()> {
    let fx = fixture()?;
    let farm = fx.info.decks[DECK_ANIMAL_FARM];
    let fonte_note = fx.info.notes["fonte"];
    let ids = fx
        .svc
        .call(move |col| {
            let basic = notetype(col, BASIC_LEITOR)?;
            let cloze = notetype(col, CLOZE_LEITOR)?;
            let p5b = add(
                col,
                &basic,
                farm,
                &[
                    "<b>Second</b> on page five",
                    "x",
                    &source_html(BOOK_UID, "Animal Farm", 5, "four legs good"),
                ],
            )?;
            let p5a_cloze = add(
                col,
                &cloze,
                farm,
                &[
                    "{{c1::Napoleon}} and {{c2::Snowball}}",
                    "",
                    &source_html(BOOK_UID, "Animal Farm", 5, ""),
                ],
            )?;
            // Another book, a link outside Fonte and a malformed link: not this book's cards.
            add(
                col,
                &basic,
                farm,
                &["other book", "x", &source_html(OTHER_UID, "Outro", 5, "")],
            )?;
            add(
                col,
                &basic,
                farm,
                &[
                    "link in the back",
                    &format!("leitor://livro/{BOOK_UID}?pagina=3"),
                    "",
                ],
            )?;
            add(
                col,
                &basic,
                farm,
                &[
                    "no page",
                    "x",
                    &format!("<a href=\"leitor://livro/{BOOK_UID}\">p</a>"),
                ],
            )?;
            let p120 = add(
                col,
                &basic,
                farm,
                &[
                    &format!("long {}", "word ".repeat(60)),
                    "x",
                    &source_html(BOOK_UID, "Animal Farm", 120, "the end"),
                ],
            )?;
            Ok((p5b, p5a_cloze, p120))
        })
        .await?;
    let (p5b, p5_cloze, p120) = ids;

    let cards = fx.svc.book_cards(BOOK_UID.to_string()).await?;
    let order: Vec<(u32, i64)> = cards.iter().map(|c| (c.page, c.note_id)).collect();
    // Same page → note id order (the cloze was added after p5b).
    assert_eq!(
        order,
        [(5, p5b), (5, p5_cloze), (37, fonte_note), (120, p120)]
    );
    let first: &BookCard = &cards[0];
    assert_eq!(first.query.as_deref(), Some("four legs good"));
    assert_eq!(first.preview, "Second on page five");
    assert_eq!(first.notetype, BASIC_LEITOR);
    assert_eq!(first.deck_id, farm);
    assert_eq!(first.card_ids.len(), 1);
    let cloze = &cards[1];
    assert_eq!(cloze.query, None);
    assert_eq!(cloze.card_ids.len(), 2, "c1 and c2");
    assert!(cloze.card_ids.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(cloze.notetype, CLOZE_LEITOR);
    assert_eq!(cards[2].query.as_deref(), Some("windmill"));
    let long = &cards[3].preview;
    assert_eq!(long.chars().count(), PREVIEW_CHARS, "{long}");
    assert!(long.ends_with('…'));

    assert_eq!(fx.svc.book_cards(OTHER_UID.to_string()).await?.len(), 1);
    assert!(fx.svc.book_cards("0".repeat(64)).await?.is_empty());
    for bad in [
        BOOK_UID.to_uppercase(),
        BOOK_UID[..63].to_string(),
        format!("{}*", &BOOK_UID[..63]),
        "\"".repeat(64),
        String::new(),
    ] {
        assert!(
            matches!(
                fx.svc.book_cards(bad.clone()).await,
                Err(Error::InvalidInput(_))
            ),
            "{bad}"
        );
    }
    Ok(())
}

/// Spec: "Cards desta página" stays fast with 10 000 notes linked to books (target < 50 ms).
#[tokio::test]
async fn book_cards_scale_to_ten_thousand_notes() -> anyhow::Result<()> {
    let fx = fixture()?;
    let farm = fx.info.decks[DECK_ANIMAL_FARM];
    fx.svc
        .call(move |col| {
            let nt = notetype(col, BASIC_LEITOR)?;
            let mut requests: Vec<AddNoteRequest> = (0..10_000u32)
                .map(|i| {
                    let mut note = nt.new_note();
                    note.set_field(0, format!("pergunta {i:05}"))?;
                    note.set_field(1, "resposta")?;
                    // Half for this book, half for another one.
                    let uid = if i % 2 == 0 { BOOK_UID } else { OTHER_UID };
                    note.set_field(2, source_html(uid, "Livro", i % 300 + 1, "trecho"))?;
                    Ok(AddNoteRequest {
                        note,
                        deck_id: DeckId(farm),
                    })
                })
                .collect::<core_anki::Result<_>>()?;
            col.add_notes(&mut requests)?;
            Ok(())
        })
        .await?;

    let mut best = u128::MAX;
    for _ in 0..5 {
        let t = Instant::now();
        let cards = fx.svc.book_cards(BOOK_UID.to_string()).await?;
        best = best.min(t.elapsed().as_millis());
        assert_eq!(cards.len(), 5_001, "5 000 + the fixture's note");
        assert!(
            cards
                .windows(2)
                .all(|w| (w[0].page, w[0].note_id) < (w[1].page, w[1].note_id))
        );
    }
    println!("book_cards over 10k linked notes: {best} ms");
    assert!(best < 50, "book_cards took {best} ms");
    Ok(())
}

#[tokio::test]
async fn deck_by_name_is_case_insensitive_and_normal_only() -> anyhow::Result<()> {
    let fx = fixture()?;
    let farm = fx.info.decks[DECK_ANIMAL_FARM];
    for name in [
        "Livros::Animal Farm",
        "livros::animal farm",
        "LIVROS :: Animal Farm ",
    ] {
        assert_eq!(
            fx.svc.book_deck_by_name(name.into()).await?,
            Some(farm),
            "{name}"
        );
    }
    for name in ["Livros::Animal", "Animal Farm", "", "::", "Livros::"] {
        assert_eq!(fx.svc.book_deck_by_name(name.into()).await?, None, "{name}");
    }
    let filtered = fx
        .svc
        .call(|col| {
            let mut deck = col.get_or_create_filtered_deck(DeckId(0))?;
            deck.human_name = "Filtrado do livro".into();
            deck.allow_empty = true;
            if let Some(term) = deck.config.search_terms.first_mut() {
                term.search = "deck:Oxford*".into();
            }
            Ok(col.add_or_update_filtered_deck(deck)?.output.0)
        })
        .await?;
    assert!(filtered > 0);
    assert_eq!(
        fx.svc.book_deck_by_name("Filtrado do livro".into()).await?,
        None
    );
    Ok(())
}

#[tokio::test]
async fn deck_counts_equal_the_deck_list() -> anyhow::Result<()> {
    let fx = fixture()?;
    let tree = fx.svc.deck_tree().await?;
    fn find(nodes: &[core_anki::DeckNode], id: i64) -> Option<&core_anki::DeckNode> {
        nodes
            .iter()
            .find_map(|n| (n.id == id).then_some(n).or_else(|| find(&n.children, id)))
    }
    for name in [
        DECK_WORDS,
        DECK_OXFORD,
        DECK_OXFORD_3000,
        DECK_BOOKS,
        DECK_ANIMAL_FARM,
    ] {
        let id = fx.info.decks[name];
        let node = find(&tree.decks, id).expect("deck in the tree");
        let counts = fx.svc.book_deck_counts(id).await?.expect("counts");
        assert_eq!(
            (counts.new, counts.learn, counts.review),
            (node.new_count, node.learn_count, node.review_count),
            "{name}"
        );
    }
    // Parents include their subdecks.
    let oxford = fx
        .svc
        .book_deck_counts(fx.info.decks[DECK_OXFORD])
        .await?
        .unwrap();
    assert!(oxford.new > 0);
    let words = fx
        .svc
        .book_deck_counts(fx.info.decks[DECK_WORDS])
        .await?
        .unwrap();
    assert!(words.review > 0 && words.learn > 0, "{words:?}");
    assert_eq!(fx.svc.book_deck_counts(9_999_999).await?, None);
    Ok(())
}

#[tokio::test]
async fn vocab_lookup_by_lemma_word_and_sort_field() -> anyhow::Result<()> {
    let fx = fixture()?;
    let (root, vocab_farm, comrade) = fx
        .svc
        .call(|col| {
            let root = core_anki::decks::create(col, "Vocabulário")?;
            let farm = core_anki::decks::create(col, "Vocabulário::Livros::Animal Farm")?;
            let vocab = notetype(col, VOCAB_BOOK)?;
            // Palavra, Lema, Classe, Definição, Tradução, Exemplo, Fonte, Frequência, Card 2
            add(
                col,
                &vocab,
                farm,
                &[
                    "Windmills",
                    "<b>windmill</b>",
                    "noun",
                    "a <i>mill</i> powered&nbsp;by   wind",
                    "moinho",
                    "",
                    "",
                    "",
                    "",
                ],
            )?;
            add(
                col,
                &vocab,
                farm,
                &["Boxer", "", "noun", "", "", "", "", "", ""],
            )?;
            let basic = stock_basic(col)?;
            let comrade = add(col, &basic, root, &["Comrade", "camarada"])?;
            Ok((root, farm, comrade))
        })
        .await?;

    let by_lemma = fx
        .svc
        .vocab_lookup(root, "windmills".into(), "windmill".into())
        .await?
        .expect("found by Lema");
    assert_eq!(by_lemma.deck_name, "Vocabulário::Livros::Animal Farm");
    assert_eq!(by_lemma.notetype, VOCAB_BOOK);
    assert_eq!(
        by_lemma.definition.as_deref(),
        Some("a mill powered by wind")
    );
    assert_eq!(by_lemma.preview, "Windmills");

    let by_word = fx
        .svc
        .vocab_lookup(root, "BOXER".into(), "boxer".into())
        .await?
        .expect("found by Palavra");
    assert_eq!(by_word.definition, None, "empty Definição");

    let user_type = fx
        .svc
        .vocab_lookup(root, "comrades".into(), "comrade".into())
        .await?
        .expect("found by the sort field");
    assert_eq!(user_type.note_id, comrade);
    assert_eq!(user_type.deck_name, "Vocabulário");
    assert_eq!(user_type.definition, None);

    // A subdeck root only sees its own notes.
    assert!(
        fx.svc
            .vocab_lookup(vocab_farm, "comrade".into(), "comrade".into())
            .await?
            .is_none()
    );
    // The fixture's "windmill" note lives in "5000 palavras", outside the root: with another root it is found,
    // with this one only the note under the root is.
    let words = fx.info.decks[DECK_WORDS];
    let outside = fx
        .svc
        .vocab_lookup(words, "windmill".into(), "windmill".into())
        .await?
        .expect("fixture note");
    assert_eq!(outside.note_id, fx.info.notes["tts"]);
    assert_ne!(by_lemma.note_id, outside.note_id);
    assert!(
        fx.svc
            .vocab_lookup(root, "house".into(), "house".into())
            .await?
            .is_none(),
        "outside the root"
    );
    assert!(
        fx.svc
            .vocab_lookup(9_999_999, "windmill".into(), "windmill".into())
            .await?
            .is_none(),
        "missing root"
    );
    assert!(
        fx.svc
            .vocab_lookup(root, " ".into(), "".into())
            .await?
            .is_none()
    );
    Ok(())
}

#[test]
fn source_builder_matches_the_ts_literal_and_round_trips() {
    assert_eq!(
        source_html(BOOK_UID, "Animal Farm", 37, "the windmill"),
        format!(
            "<a href=\"leitor://livro/{BOOK_UID}?pagina=37&amp;q=the%20windmill\">Animal Farm, p. 37</a>"
        )
    );
    let q = source_query("  “Four legs   good,\n two legs bad” — é ç 🐷 ");
    assert_eq!(q, "“Four legs good, two legs bad” — é ç 🐷");
    let html = source_html(BOOK_UID, "A & B <\"C\">", 12, &q);
    let link = parse_source(&html).expect("round trip");
    assert_eq!(link.book_uid, BOOK_UID);
    assert_eq!(link.page, 12);
    assert_eq!(link.query.as_deref(), Some(q.as_str()));
    assert_eq!(link.label, "A & B <\"C\">, p. 12");
}
