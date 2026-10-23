//! Browser search, rows, bulk operations and editor media on the fixture collection
//! (docs/PROJETO.md 8.2 Navegar, 20).

mod common;

use std::time::Instant;

use common::{fixture, sql_i64};
use core_anki::anki::notes::AddNoteRequest;
use core_anki::anki::prelude::{CardId, DeckId};
use core_anki::browse::{self, BrowseColumn, BrowseOrder, ForgetOptions, MAX_ROWS};
use core_anki::fixture::{DECK_OXFORD_3000, DECK_OXFORD_5000, DECK_WORDS};
use core_anki::notetypes::stock_basic;
use core_anki::{AnkiService, Error, media};

async fn search(svc: &AnkiService, q: &str) -> core_anki::Result<Vec<i64>> {
    let q = q.to_string();
    svc.call(move |col| browse::search(col, &q, None)).await
}

async fn count(svc: &AnkiService, q: &str) -> usize {
    search(svc, q).await.unwrap().len()
}

const ALL_COLUMNS: [BrowseColumn; 8] = [
    BrowseColumn::SortField,
    BrowseColumn::Template,
    BrowseColumn::Deck,
    BrowseColumn::CardDue,
    BrowseColumn::CardIvl,
    BrowseColumn::CardEase,
    BrowseColumn::NoteCrt,
    BrowseColumn::NoteMod,
];

#[tokio::test]
async fn searches_with_anki_syntax() -> anyhow::Result<()> {
    let fx = fixture()?;
    let svc = &fx.svc;
    let words = fx.info.decks[DECK_WORDS];
    let in_deck = svc
        .call(move |col| {
            sql_i64(
                col,
                &format!("SELECT COUNT() FROM cards WHERE did = {words}"),
            )
        })
        .await?;
    assert_eq!(count(svc, "deck:\"5000 palavras\"").await as i64, in_deck);
    assert_eq!(in_deck, 9, "8 basic notes + the TTS vocabulary note");

    // Subdecks are included; the whole collection is the empty query.
    assert_eq!(count(svc, "deck:Oxford").await, 5);
    let all = svc
        .call(|col| sql_i64(col, "SELECT COUNT() FROM cards"))
        .await?;
    assert_eq!(count(svc, "").await as i64, all);
    assert_eq!(count(svc, "   ").await as i64, all);
    assert_eq!(count(svc, "deck:current").await as i64, in_deck);

    // Three reviews due today and one learning card (the fixture's study state).
    let due = search(svc, "deck:\"5000 palavras\" is:due").await?;
    assert!(due.len() >= 3, "{due:?}");
    assert_eq!(count(svc, "is:new deck:Oxford*").await, 5);
    // 2 app commands + the type-in note + 3 user-type commands.
    assert_eq!(count(svc, "tag:ros2").await, 6);
    assert_eq!(count(svc, "house").await, 1);
    assert_eq!(count(svc, "-deck:\"5000 palavras\" house").await, 0);
    Ok(())
}

#[tokio::test]
async fn invalid_search_is_a_localized_error() -> anyhow::Result<()> {
    let fx = fixture()?;
    for q in ["deck:\"sem fim", "(casa", "is:nada", "prop:ivl>x"] {
        let err = search(&fx.svc, q).await.unwrap_err();
        assert!(matches!(err, Error::Anki { .. }), "{q}: {err:?}");
        assert_eq!(err.code(), "anki.backend");
        let msg = err.to_string();
        assert!(!msg.is_empty());
        // pt-BR translations of rslib's search errors.
        assert!(!msg.contains("Invalid search"), "{q}: not localized: {msg}");
    }
    Ok(())
}

#[tokio::test]
async fn sorts_by_every_column() -> anyhow::Result<()> {
    let fx = fixture()?;
    let svc = &fx.svc;
    let mut unordered = search(svc, "").await?;
    unordered.sort_unstable();
    for column in ALL_COLUMNS {
        for reverse in [false, true] {
            let order = BrowseOrder { column, reverse };
            let mut ids = svc
                .call(move |col| browse::search(col, "", Some(order)))
                .await?;
            ids.sort_unstable();
            assert_eq!(
                ids, unordered,
                "{column:?} reverse={reverse} returns the same cards"
            );
        }
    }
    // Sort field: Oxford 3000 fronts in order, and reversed.
    let order = |reverse| BrowseOrder {
        column: BrowseColumn::SortField,
        reverse,
    };
    let asc = svc
        .call(move |col| {
            let ids = browse::search(col, "deck:\"Oxford::Oxford 3000\"", Some(order(false)))?;
            browse::rows(col, &ids)
        })
        .await?;
    let fronts: Vec<&str> = asc.iter().map(|r| r.sort_field.as_str()).collect();
    assert_eq!(fronts, ["abandon", "ability", "able", "about", "above"]);
    let desc = svc
        .call(move |col| browse::search(col, "deck:\"Oxford::Oxford 3000\"", Some(order(true))))
        .await?;
    let asc_ids: Vec<i64> = asc.iter().rev().map(|r| r.card_id).collect();
    assert_eq!(desc, asc_ids);

    // Deck column: grouped by deck name.
    let by_deck = svc
        .call(|col| {
            let ids = browse::search(
                col,
                "deck:Oxford* OR deck:Matemática",
                Some(BrowseOrder {
                    column: BrowseColumn::Deck,
                    reverse: false,
                }),
            )?;
            browse::rows(col, &ids)
        })
        .await?;
    let decks: Vec<&str> = by_deck.iter().map(|r| r.deck.as_str()).collect();
    let mut sorted = decks.clone();
    sorted.sort_by_key(|d| d.to_lowercase());
    assert_eq!(decks, sorted);
    Ok(())
}

#[tokio::test]
async fn rows_are_text_with_flags_marks_and_states() -> anyhow::Result<()> {
    let fx = fixture()?;
    let image_note = fx.info.notes["imagem"];
    let ids = fx
        .svc
        .call(move |col| browse::search(col, &format!("nid:{image_note}"), None))
        .await?;
    let cid = ids[0];
    let rows = fx
        .svc
        .call(move |col| {
            col.set_card_flag(&[CardId(cid)], 3)?;
            browse::rows(col, &[cid])
        })
        .await?;
    let row = &rows[0];
    assert_eq!(row.card_id, cid);
    assert_eq!(row.note_id, image_note);
    assert_eq!(row.sort_field, "house");
    assert_eq!(row.deck, DECK_WORDS);
    assert!(!row.template.is_empty());
    assert!(!row.due.is_empty());
    assert_eq!(row.flag, 3);
    assert!(!row.marked && !row.suspended && !row.buried);

    // The answer side with HTML/media is never in a cell as markup.
    let cloze = fx.info.notes["cloze"];
    let html_rows = fx
        .svc
        .call(move |col| {
            let ids = browse::search(col, &format!("nid:{cloze} OR deck:Matemática"), None)?;
            browse::rows(col, &ids)
        })
        .await?;
    for r in &html_rows {
        assert!(!r.sort_field.contains('<'), "{r:?}");
    }

    // Marked note, suspended and buried cards.
    let rows = fx
        .svc
        .call(move |col| {
            browse::tags(col, &[image_note], "marked", "")?;
            browse::suspend(col, &[cid], true)?;
            browse::rows(col, &[cid])
        })
        .await?;
    assert!(rows[0].marked && rows[0].suspended && !rows[0].buried);
    let other = fx.info.first_card[DECK_OXFORD_3000];
    let rows = fx
        .svc
        .call(move |col| {
            col.bury_or_suspend_cards(
                &[CardId(other)],
                anki_proto::scheduler::bury_or_suspend_cards_request::Mode::BuryUser,
            )?;
            browse::rows(col, &[other, 999_999])
        })
        .await?;
    assert_eq!(rows.len(), 1, "unknown ids are skipped");
    assert!(rows[0].buried && !rows[0].suspended);

    // Too many ids at once.
    let err = fx
        .svc
        .call(|col| browse::rows(col, &vec![1; MAX_ROWS + 1]))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    Ok(())
}

#[tokio::test]
async fn bulk_operations_show_up_in_searches() -> anyhow::Result<()> {
    let fx = fixture()?;
    let svc = &fx.svc;
    let oxford = search(svc, "deck:\"Oxford::Oxford 3000\"").await?;
    assert_eq!(oxford.len(), 5);

    // Move.
    let target = fx.info.decks[DECK_OXFORD_5000];
    let ids = oxford.clone();
    let moved = svc
        .call(move |col| browse::set_deck(col, &ids, target))
        .await?;
    assert_eq!(moved, 5);
    assert_eq!(count(svc, "deck:\"Oxford::Oxford 5000\"").await, 5);
    assert_eq!(count(svc, "deck:\"Oxford::Oxford 3000\"").await, 0);

    // Tags on notes.
    let ids = oxford.clone();
    let nids = svc
        .call(move |col| {
            Ok(browse::rows(col, &ids)?
                .into_iter()
                .map(|r| r.note_id)
                .collect::<Vec<_>>())
        })
        .await?;
    let n2 = nids.clone();
    svc.call(move |col| browse::tags(col, &n2, "lote::um lote2", ""))
        .await?;
    assert_eq!(count(svc, "tag:lote").await, 5, "child tags match");
    assert_eq!(count(svc, "tag:lote2").await, 5);
    let n2 = nids.clone();
    svc.call(move |col| browse::tags(col, &n2, "", "lote2 oxford"))
        .await?;
    assert_eq!(count(svc, "tag:lote2").await, 0);
    assert_eq!(count(svc, "tag:oxford").await, 0);

    // Suspend / reactivate.
    let ids = oxford[..2].to_vec();
    svc.call(move |col| browse::suspend(col, &ids, true))
        .await?;
    assert_eq!(count(svc, "is:suspended").await, 2);
    let ids = oxford[..2].to_vec();
    svc.call(move |col| browse::suspend(col, &ids, false))
        .await?;
    assert_eq!(count(svc, "is:suspended").await, 0);

    // Forget: the reviews of "5000 palavras" become new.
    let reviews = search(svc, "deck:\"5000 palavras\" -is:new").await?;
    assert!(!reviews.is_empty());
    let ids = reviews.clone();
    svc.call(move |col| {
        browse::forget(
            col,
            &ids,
            ForgetOptions {
                restore_position: true,
                reset_counts: true,
            },
        )
    })
    .await?;
    assert_eq!(count(svc, "deck:\"5000 palavras\" -is:new").await, 0);

    // Delete notes.
    let n2 = nids[..3].to_vec();
    let deleted = svc.call(move |col| browse::delete_notes(col, &n2)).await?;
    assert_eq!(deleted, 3);
    assert_eq!(count(svc, "deck:Oxford*").await, 2);
    Ok(())
}

#[tokio::test]
async fn common_notetype_requires_a_single_type() -> anyhow::Result<()> {
    let fx = fixture()?;
    let (image, audio, cloze) = (
        fx.info.notes["imagem"],
        fx.info.notes["audio"],
        fx.info.notes["cloze"],
    );
    let same = fx
        .svc
        .call(move |col| browse::common_notetype(col, &[image, audio]))
        .await?;
    let basic = fx.svc.call(|col| Ok(stock_basic(col)?.id.0)).await?;
    assert_eq!(same, basic);
    let err = fx
        .svc
        .call(move |col| browse::common_notetype(col, &[image, cloze]))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    assert!(
        err.to_string().contains("tipos de nota diferentes"),
        "{err}"
    );
    let err = fx
        .svc
        .call(|col| browse::common_notetype(col, &[]))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)));
    Ok(())
}

#[tokio::test]
async fn media_add_renames_sanitizes_and_limits() -> anyhow::Result<()> {
    let fx = fixture()?;
    let media_dir = fx.svc.paths().media_folder.clone();
    let png_a = b"\x89PNG\r\n\x1a\n-a".to_vec();
    let png_b = b"\x89PNG\r\n\x1a\n-b".to_vec();

    let (a, b, a_again) = fx
        .svc
        .call(move |col| {
            Ok((
                media::add(col, "colado.png", &png_a)?,
                media::add(col, "colado.png", &png_b)?,
                media::add(col, "colado.png", &png_a)?,
            ))
        })
        .await?;
    assert_eq!(a, "colado.png");
    assert_ne!(b, a, "different bytes under the same name get a new name");
    assert!(b.starts_with("colado") && b.ends_with(".png"), "{b}");
    assert_eq!(a_again, a, "same bytes keep the name");
    assert!(media_dir.join(&a).is_file() && media_dir.join(&b).is_file());

    // Path traversal: only the basename is used.
    let name = fx
        .svc
        .call(|col| media::add(col, "../../fora.png", b"x"))
        .await?;
    assert_eq!(name, "fora.png");
    assert!(media_dir.join("fora.png").is_file());
    assert!(!media_dir.parent().unwrap().join("fora.png").exists());
    let name = fx
        .svc
        .call(|col| media::add(col, "C:\\Users\\x\\Desktop\\foto.JPG", b"y"))
        .await?;
    // Anki normalizes the extension's case.
    assert!(name.eq_ignore_ascii_case("foto.jpg"), "{name}");

    // Not an image.
    let err = fx
        .svc
        .call(|col| media::add(col, "programa.exe", b"MZ"))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "{err:?}");
    let err = fx
        .svc
        .call(|col| media::add(col, "", b"x"))
        .await
        .map(|n| n == "imagem.png");
    assert!(err?, "an empty name becomes imagem.png");

    // Too large.
    let big = vec![0u8; media::MAX_MEDIA_BYTES + 1];
    let err = fx
        .svc
        .call(move |col| media::add(col, "grande.png", &big))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::TooLarge), "{err:?}");
    Ok(())
}

/// 10k notes: search < 300 ms and rows(100) < 50 ms in release (loose bounds here, the
/// test profile is not optimized for this crate).
#[tokio::test]
async fn search_and_rows_scale_to_ten_thousand_cards() -> anyhow::Result<()> {
    let fx = fixture()?;
    let deck = fx.info.decks[DECK_OXFORD_5000];
    let started = Instant::now();
    fx.svc
        .call(move |col| {
            let nt = stock_basic(col)?;
            let mut requests: Vec<AddNoteRequest> = (0..10_000)
                .map(|i| {
                    let mut note = nt.new_note();
                    note.set_field(0, format!("palavra {i:05}"))?;
                    note.set_field(1, format!("tradução <b>{i}</b>"))?;
                    note.tags = vec![format!("lote{}", i % 10)];
                    Ok(AddNoteRequest {
                        note,
                        deck_id: DeckId(deck),
                    })
                })
                .collect::<core_anki::Result<_>>()?;
            col.add_notes(&mut requests)?;
            Ok(())
        })
        .await?;
    let build = started.elapsed();

    let t = Instant::now();
    let ids = fx
        .svc
        .call(|col| {
            browse::search(
                col,
                "deck:\"Oxford::Oxford 5000\"",
                Some(BrowseOrder {
                    column: BrowseColumn::SortField,
                    reverse: false,
                }),
            )
        })
        .await?;
    let search_ms = t.elapsed().as_millis();
    assert_eq!(ids.len(), 10_000);

    let page: Vec<i64> = ids[5_000..5_100].to_vec();
    let t = Instant::now();
    let rows = fx.svc.call(move |col| browse::rows(col, &page)).await?;
    let rows_ms = t.elapsed().as_millis();
    assert_eq!(rows.len(), 100);
    assert_eq!(rows[0].sort_field, "palavra 05000");

    println!("10k notes: build {build:?}, search {search_ms} ms, rows(100) {rows_ms} ms");
    // Spec targets are 300 ms / 50 ms; generous bounds keep slow CI machines green.
    assert!(search_ms < 3_000, "search took {search_ms} ms");
    assert!(rows_ms < 500, "rows(100) took {rows_ms} ms");
    Ok(())
}
