//! Test fixture collection (docs/PROJETO.md 20): built in code so no binary is committed.
//!
//! Content is deterministic (ids vary): decks "5000 palavras" (image, audio, TTS, review/learning/
//! new cards), "Oxford::Oxford 3000" (new), "Oxford::Oxford 5000" (empty), "ROS 2 — Revisão"
//! (type-answer via "Código · Comando" and the stock "Basic (type in the answer)"), "Matemática"
//! (MathJax), "Gramática::Cloze" (c1/c2), "Livros::Animal Farm" (`Fonte` with a `leitor://`
//! link) and, optionally, "Isolamento (teste)" with the card isolation probe.

use std::collections::BTreeMap;
use std::path::Path;

use anki::collection::{Collection, CollectionBuilder};
use anki::decks::tree::DeckCollapseScope;
use anki::notetype::all_stock_notetypes;
use anki::prelude::{CardId, DeckId, I18n, Note, NoteId, Notetype, TimestampMillis};
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::search::SortMode;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::notetypes::{
    BASIC_LEITOR, CLOZE_LEITOR, CODE_COMMAND, VOCAB_BOOK, prepare_collection, stock_basic,
};
use crate::service::CollectionPaths;

pub const DECK_WORDS: &str = "5000 palavras";
pub const DECK_OXFORD: &str = "Oxford";
pub const DECK_OXFORD_3000: &str = "Oxford::Oxford 3000";
pub const DECK_OXFORD_5000: &str = "Oxford::Oxford 5000";
pub const DECK_ROS: &str = "ROS 2 — Revisão";
pub const DECK_MATH: &str = "Matemática";
pub const DECK_GRAMMAR: &str = "Gramática";
pub const DECK_CLOZE: &str = "Gramática::Cloze";
pub const DECK_BOOKS: &str = "Livros";
pub const DECK_ANIMAL_FARM: &str = "Livros::Animal Farm";
pub const DECK_ISOLATION: &str = "Isolamento (teste)";

pub const IMAGE_FILE: &str = "fixture-image.png";
pub const AUDIO_FILE: &str = "fixture-audio.wav";

/// `book_uid` used in the fixture's `leitor://` link (64 hex chars, like a sha256).
pub const BOOK_UID: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

/// Front of the isolation probe card (spec 8.4, Phase 2 acceptance). Its script tries what a
/// hostile deck would from inside the sandboxed card iframe: reach the Tauri IPC (own window and
/// `parent.__TAURI_INTERNALS__.invoke`), POST `/_anki/addNote` (must be 403), POST to the `anki`
/// protocol and to `ipc://` directly (must be blocked by the CSP) and `/_anki/i18nResources`
/// (allowed); it also reports whether MathJax typeset `\(x^2\)` and the width of the fixture
/// image. The result is reported with `pycmd('probe:' + JSON)` (the study screen logs it through
/// `dev_log` as `card pycmd: probe:{…}` in debug builds), logged on the console with the prefix
/// `leitor-isolation-probe` and written into `#leitor-isolation-result` (`data-done="1"`).
/// `scripts/anki-real-app.sh isolation` checks it in the real app.
pub const ISOLATION_PROBE_FRONT: &str = r#"<div class="leitor-probe">sonda de isolamento \(x^2\)</div>
<div id="leitor-isolation-result" data-done="0"></div>
<img id="leitor-probe-img" src="fixture-image.png" alt="">
<script>
(async () => {
  if (window.__leitorProbeRan) return;
  window.__leitorProbeRan = true;
  const r = {};
  r.tauri = typeof window.__TAURI_INTERNALS__;
  try { await window.parent.__TAURI_INTERNALS__.invoke("anki_deck_tree"); r.parentInvoke = "reachable"; }
  catch (e) { r.parentInvoke = "blocked"; }
  const post = (url) => fetch(url, { method: "POST", headers: { "Content-Type": "application/binary" }, body: new Uint8Array() })
    .then((res) => res.status, () => "blocked");
  r.addNote = await post("/_anki/addNote");
  const anki = location.protocol === "card:" ? "anki://localhost" : "http://anki.localhost";
  r.ankiFetch = await post(anki + "/_anki/addNote");
  const ipc = location.protocol === "card:" ? "ipc://localhost/anki_deck_tree" : "http://ipc.localhost/anki_deck_tree";
  r.ipc = await fetch(ipc, { method: "POST", body: "{}" }).then((res) => res.status, () => "blocked");
  r.i18n = await post("/_anki/i18nResources");
  await new Promise((done) => setTimeout(done, 3000));
  r.mathjax = !!document.querySelector("mjx-container");
  const img = document.getElementById("leitor-probe-img");
  r.img = img ? img.naturalWidth : -1;
  const el = document.getElementById("leitor-isolation-result");
  if (el) { el.textContent = JSON.stringify(r); el.dataset.done = "1"; }
  console.log("leitor-isolation-probe " + JSON.stringify(r));
  try { pycmd("probe:" + JSON.stringify(r)); } catch (e) { console.log("leitor-isolation-probe no pycmd"); }
})();
</script>"#;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureOptions {
    /// Adds the "Isolamento (teste)" deck with [`ISOLATION_PROBE_FRONT`].
    pub isolation_probe: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureInfo {
    /// Full deck name → deck id (parents included).
    pub decks: BTreeMap<String, i64>,
    /// Full deck name → its first card (lowest card id, without subdecks).
    pub first_card: BTreeMap<String, i64>,
    /// Role → note id: "imagem", "audio", "tts", "matematica", "cloze", "comando",
    /// "digitarResposta", "fonte", "isolamento".
    pub notes: BTreeMap<String, i64>,
    pub book_uid: String,
}

/// Creates a new collection in `dir` (desktop layout) and fills it. Fails if `dir` already
/// holds a collection. The collection is closed when this returns.
pub fn build(dir: &Path, opts: FixtureOptions) -> Result<FixtureInfo> {
    let paths = CollectionPaths::in_dir(dir);
    if paths.collection.exists() {
        return Err(Error::InvalidInput(format!(
            "a pasta {} já tem uma coleção.",
            dir.display()
        )));
    }
    for folder in [dir, paths.media_folder.as_path()] {
        std::fs::create_dir_all(folder).map_err(|source| Error::CreateDir {
            path: folder.to_path_buf(),
            source,
        })?;
    }
    let tr = I18n::new(&["pt-BR"]);
    let mut col = CollectionBuilder::new(&paths.collection)
        .set_media_paths(paths.media_folder.clone(), paths.media_db.clone())
        .set_tr(tr.clone())
        .build()
        .map_err(|e| Error::from_anki(e, &tr))?;
    let info = populate(&mut col, opts);
    let closed = col.close(None).map_err(|e| Error::from_anki(e, &tr));
    let info = info?;
    closed?;
    Ok(info)
}

/// Fills an open collection (normally empty) with the fixture content.
pub fn populate(col: &mut Collection, opts: FixtureOptions) -> Result<FixtureInfo> {
    prepare_collection(col)?;
    let mut info = FixtureInfo {
        book_uid: BOOK_UID.to_string(),
        ..Default::default()
    };

    let media = col.media()?;
    let image = media.add_file(IMAGE_FILE, &fixture_png()?)?.into_owned();
    let audio = media.add_file(AUDIO_FILE, &fixture_wav())?.into_owned();
    drop(media);

    let basic = stock_basic(col)?;
    let basic_leitor = notetype(col, BASIC_LEITOR)?;
    let cloze_leitor = notetype(col, CLOZE_LEITOR)?;
    let command = notetype(col, CODE_COMMAND)?;
    let vocab = notetype(col, VOCAB_BOOK)?;
    let basic_typing = stock_basic_typing(col)?;

    let mut decks = Vec::new();
    for name in [
        DECK_WORDS,
        DECK_OXFORD_3000,
        DECK_OXFORD_5000,
        DECK_ROS,
        DECK_MATH,
        DECK_CLOZE,
        DECK_ANIMAL_FARM,
    ] {
        decks.push((name, crate::decks::create(col, name)?));
    }
    if opts.isolation_probe {
        decks.push((DECK_ISOLATION, crate::decks::create(col, DECK_ISOLATION)?));
    }

    // --- 5000 palavras: 8 basic notes (first with image, second with audio) + a TTS note.
    let words = deck_id(col, DECK_WORDS)?;
    let pairs = [
        ("house", "casa"),
        ("dog", "cachorro"),
        ("river", "rio"),
        ("bread", "pão"),
        ("window", "janela"),
        ("bridge", "ponte"),
        ("garden", "jardim"),
        ("cloud", "nuvem"),
    ];
    let mut word_cards = Vec::new();
    for (i, (front, back)) in pairs.iter().enumerate() {
        let back = match i {
            0 => format!("{back}<br><img src=\"{image}\">"),
            1 => format!("{back} [sound:{audio}]"),
            _ => (*back).to_string(),
        };
        let (nid, cards) = add(col, &basic, words, &[front, &back], &["fixture"])?;
        match i {
            0 => info.notes.insert("imagem".into(), nid),
            1 => info.notes.insert("audio".into(), nid),
            _ => None,
        };
        word_cards.push(cards[0]);
    }
    let (tts, _) = add(
        col,
        &vocab,
        words,
        &[
            "windmill",
            "windmill",
            "noun",
            "a building with sails that turn in the wind",
            "moinho de vento",
            "The animals built the <b>windmill</b>.",
            "",
            "3",
            "",
        ],
        &["fixture", "livro::animal-farm"],
    )?;
    info.notes.insert("tts".into(), tts);

    // Review state: five review cards with different intervals due today; two answered Good
    // (so "Estudados hoje" is not zero) leave three due. One card answered Again = learning.
    for (cid, ivl) in word_cards.iter().take(5).zip([3, 7, 15, 30, 60]) {
        col.set_due_date(&[*cid], &format!("{ivl}!"), None)?;
        col.set_due_date(&[*cid], "0", None)?;
    }
    answer(col, word_cards[3], Rating::Good, 8_000)?;
    answer(col, word_cards[4], Rating::Good, 12_000)?;
    answer(col, word_cards[5], Rating::Again, 6_000)?;
    // Deterministic first cards (Anki orders reviews by due date, then randomly): the image card is
    // the most overdue review and the audio card the next, so captures and e2e start with them.
    for (cid, days) in [(word_cards[0], 2), (word_cards[1], 1)] {
        col.storage
            .db()
            .execute(
                &format!("update cards set due = due - {days} where id = {}", cid.0),
                [],
            )
            .map_err(anki::prelude::AnkiError::from)?;
    }

    // --- Oxford 3000: new cards. Oxford 5000 stays empty.
    let oxford = deck_id(col, DECK_OXFORD_3000)?;
    for (front, back) in [
        ("abandon", "abandonar"),
        ("ability", "habilidade"),
        ("able", "capaz"),
        ("about", "sobre"),
        ("above", "acima"),
    ] {
        add(col, &basic, oxford, &[front, back], &["oxford"])?;
    }

    // --- ROS 2 — Revisão: type-answer through the app's command type and the stock type.
    let ros = deck_id(col, DECK_ROS)?;
    let (cmd, _) = add(
        col,
        &command,
        ros,
        &[
            "Listar os tópicos ativos",
            "ros2 topic list",
            "ros2 topic list -t",
            "",
            "Mostra todos os tópicos publicados no momento.",
            "",
        ],
        &["ros2"],
    )?;
    info.notes.insert("comando".into(), cmd);
    add(
        col,
        &command,
        ros,
        &[
            "Ver a transformação entre os frames world e turtle1",
            "ros2 run tf2_ros tf2_echo world turtle1",
            "",
            "",
            "Imprime Translation e Rotation (quaternion) a cada atualização.",
            "",
        ],
        &["ros2"],
    )?;
    let (typing, _) = add(
        col,
        &basic_typing,
        ros,
        &["Comando para compilar o workspace", "colcon build"],
        &["ros2"],
    )?;
    info.notes.insert("digitarResposta".into(), typing);

    // --- Matemática: MathJax inline and display.
    let math = deck_id(col, DECK_MATH)?;
    let (m, _) = add(
        col,
        &basic,
        math,
        &[
            r"Quanto é \(\frac{a}{b} \cdot \frac{b}{a}\)?",
            r"\(1\), e a área é \[x^2\]",
        ],
        &["matematica"],
    )?;
    info.notes.insert("matematica".into(), m);

    // --- Gramática::Cloze: c1/c2.
    let cloze = deck_id(col, DECK_CLOZE)?;
    let (c, _) = add(
        col,
        &cloze_leitor,
        cloze,
        &[
            "O {{c1::verbo}} concorda com o {{c2::sujeito}}.",
            "Concordância verbal",
            "",
        ],
        &["gramatica"],
    )?;
    info.notes.insert("cloze".into(), c);

    // --- Livros::Animal Farm: Fonte with a leitor:// link.
    let farm = deck_id(col, DECK_ANIMAL_FARM)?;
    let link = format!(
        "<a href=\"leitor://livro/{BOOK_UID}?pagina=37&q=windmill\">Animal Farm, p. 37</a>"
    );
    let (fonte, _) = add(
        col,
        &basic_leitor,
        farm,
        &["Who proposed building the windmill?", "Snowball", &link],
        &["livro::animal-farm"],
    )?;
    info.notes.insert("fonte".into(), fonte);

    if opts.isolation_probe {
        let iso = deck_id(col, DECK_ISOLATION)?;
        let (probe, _) = add(
            col,
            &basic,
            iso,
            &[ISOLATION_PROBE_FRONT, "fim da sonda"],
            &["isolamento"],
        )?;
        info.notes.insert("isolamento".into(), probe);
    }

    // Every deck expanded on the Decks screen; current deck = "5000 palavras".
    for (_, did) in &decks {
        col.set_deck_collapsed(DeckId(*did), false, DeckCollapseScope::Reviewer)?;
    }
    for parent in [DECK_OXFORD, DECK_GRAMMAR, DECK_BOOKS] {
        let did = deck_id(col, parent)?;
        col.set_deck_collapsed(DeckId(did), false, DeckCollapseScope::Reviewer)?;
    }
    col.set_current_deck(DeckId(words))?;

    for d in crate::decks::names(col)? {
        if d.id == 1 {
            continue;
        }
        let cards = col.search_cards(
            anki::search::SearchNode::from_deck_id(DeckId(d.id), false),
            SortMode::NoOrder,
        )?;
        if let Some(first) = cards.iter().map(|c| c.0).min() {
            info.first_card.insert(d.name.clone(), first);
        }
        info.decks.insert(d.name, d.id);
    }
    Ok(info)
}

fn notetype(col: &mut Collection, name: &str) -> Result<std::sync::Arc<Notetype>> {
    col.get_notetype_by_name(name)?
        .ok_or_else(|| Error::NotFound(format!("tipo de nota {name}")))
}

/// The stock "Basic (type in the answer)" type, added under its stock (localized) name if
/// missing.
fn stock_basic_typing(col: &mut Collection) -> Result<std::sync::Arc<Notetype>> {
    let mut nt = all_stock_notetypes(col.tr())
        .into_iter()
        .nth(3)
        .ok_or_else(|| Error::NotFound("tipo Básico (digitar a resposta)".into()))?;
    if let Some(existing) = col.get_notetype_by_name(&nt.name)? {
        return Ok(existing);
    }
    nt.id = anki::prelude::NotetypeId(0);
    col.add_notetype(&mut nt, false)?;
    col.get_notetype(nt.id)?
        .ok_or_else(|| Error::NotFound("tipo Básico (digitar a resposta)".into()))
}

fn deck_id(col: &mut Collection, name: &str) -> Result<i64> {
    col.get_deck_id(name)?
        .map(|d| d.0)
        .ok_or_else(|| Error::NotFound(format!("baralho {name}")))
}

/// Adds a note; returns its id and its card ids (ascending).
fn add(
    col: &mut Collection,
    nt: &Notetype,
    deck: i64,
    fields: &[&str],
    tags: &[&str],
) -> Result<(i64, Vec<CardId>)> {
    let mut note: Note = nt.new_note();
    for (i, value) in fields.iter().enumerate() {
        note.set_field(i, *value)?;
    }
    note.tags = tags.iter().map(|t| (*t).to_string()).collect();
    col.add_note(&mut note, DeckId(deck))?;
    let mut cards = col.search_cards(note_search(note.id).as_str(), SortMode::NoOrder)?;
    cards.sort();
    Ok((note.id.0, cards))
}

fn note_search(nid: NoteId) -> String {
    format!("nid:{}", nid.0)
}

fn answer(col: &mut Collection, cid: CardId, rating: Rating, ms: u32) -> Result<()> {
    let states = col.get_scheduling_states(cid)?;
    let new_state = match rating {
        Rating::Again => states.again,
        Rating::Hard => states.hard,
        Rating::Good => states.good,
        Rating::Easy => states.easy,
    };
    col.answer_card(&mut CardAnswer {
        card_id: cid,
        current_state: states.current,
        new_state,
        rating,
        answered_at: TimestampMillis::now(),
        milliseconds_taken: ms,
        custom_data: None,
        from_queue: false,
    })?;
    Ok(())
}

/// 16×16 RGBA image: blue with a white diagonal.
fn fixture_png() -> Result<Vec<u8>> {
    // A small drawing of a house (the card is "house"/"casa"), so captures show a real picture.
    const W: u32 = 160;
    const H: u32 = 112;
    let pixel = |x: i32, y: i32| -> [u8; 4] {
        let (dx, dy) = (x - 130, y - 22);
        let rgb = if (52..92).contains(&y) && (72..88).contains(&x) && y >= 66 {
            [120, 80, 50] // door
        } else if (60..72).contains(&y) && ((52..66).contains(&x) || (94..108).contains(&x)) {
            [150, 200, 235] // windows
        } else if (52..92).contains(&y) && (46..114).contains(&x) {
            [240, 228, 200] // walls
        } else if (22..52).contains(&y) && (x - 80).abs() * 30 <= (y - 22) * 42 {
            [196, 72, 56] // roof
        } else if y >= 92 {
            [120, 170, 90] // grass
        } else if dx * dx + dy * dy <= 100 {
            [250, 200, 60] // sun
        } else {
            [214, 232, 248] // sky
        };
        [rgb[0], rgb[1], rgb[2], 255]
    };
    let mut rgba = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H as i32 {
        for x in 0..W as i32 {
            rgba.extend_from_slice(&pixel(x, y));
        }
    }
    let err = |e: png::EncodingError| Error::InvalidInput(format!("png: {e}"));
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, W, H);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(err)?;
        writer.write_image_data(&rgba).map_err(err)?;
        writer.finish().map_err(err)?;
    }
    Ok(out)
}

/// 0.2 s of a 440 Hz square wave, 8 kHz mono 16-bit PCM WAV.
fn fixture_wav() -> Vec<u8> {
    const RATE: u32 = 8_000;
    const SAMPLES: u32 = RATE / 5;
    let data_len = SAMPLES * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    let half_period = RATE / 440 / 2;
    for i in 0..SAMPLES {
        let high = (i / half_period.max(1)).is_multiple_of(2);
        let sample: i16 = if high { 6_000 } else { -6_000 };
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}
