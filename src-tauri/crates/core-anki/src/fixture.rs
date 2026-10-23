//! Test fixture collection (docs/PROJETO.md 20): built in code so no binary is committed.
//!
//! Content is deterministic (ids vary): decks "5000 palavras" (image, audio, TTS, review/learning/
//! new cards), "Oxford::Oxford 3000" (new), "Oxford::Oxford 5000" (empty), "ROS 2 — Revisão"
//! (type-answer via "Código · Comando" and the stock "Basic (type in the answer)"), "Matemática"
//! (MathJax), "Gramática::Cloze" (c1/c2), "Livros::Animal Farm" (`Fonte` with a `leitor://`
//! link), "Programação" (five "Código · Programa" notes, in this order: Python `testes`, Python `saida`, Python
//! `estrutura`, C++ `testes`, C++ `saida`; code fields HTML-encoded like the UI's `codeToHtml`) and, optionally,
//! "Isolamento (teste)" with the card isolation probe.
//!
//! Opt-in ([`FixtureOptions::vocab`], off by default so the other tests and snapshots don't change): a vocabulary
//! folder shaped like common shared decks, for the vocabulary scan (spec 12): [`DECK_VOCAB`] (root) with
//! [`DECK_VOCAB_BASIC`] (notetype [`VOCAB_WORD_NOTETYPE`], fields `Word`, `Meaning`, `Audio`), [`DECK_VOCAB_OXFORD`]
//! (notetype [`VOCAB_FRONT_NOTETYPE`], fields `Front`, `Back`) and the empty [`DECK_VOCAB_EMPTY`]. The word fields
//! ([`VOCAB_NOTES`]) exercise the cleaning rules (HTML, `[sound:…]`, cloze, parentheses, `/` and `;` variants, a
//! phrase) and every status: mature (interval ≥ 21 days), learning (interval 3–5), new and suspended. Note roles
//! are `vocab:<key>` ("vocab:learn", "vocab:look up"); notetype roles `vocabWord`, `vocabFront`.
//!
//! "ROS 2 — Revisão" also has three notes of a user-shaped type, [`USER_COMMAND_NOTETYPE`] (fields `Frente`,
//! `Comando`, `Explicação`; a textarea + Ctrl+Enter front like the user's real deck, docs/referencia/capturas/06..09).
//! It is a normal user type (not an app type, not created by "Preparar coleção"), used to test assigning it the
//! "Comando" role. Order in that deck: the two "Código · Comando" notes, the stock type-in note, then the three
//! user-type notes.

use std::collections::BTreeMap;
use std::path::Path;

use anki::collection::{Collection, CollectionBuilder};
use anki::decks::tree::DeckCollapseScope;
use anki::notetype::{CardTemplate, NoteField, all_stock_notetypes};
use anki::prelude::{CardId, DeckId, I18n, Note, NoteId, Notetype, TimestampMillis};
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::search::SortMode;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::notetypes::{
    BASIC_LEITOR, CLOZE_LEITOR, CODE_COMMAND, CODE_PROGRAM, VOCAB_BOOK, card_1_name,
    prepare_collection, stock_basic,
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
pub const DECK_PROGRAMMING: &str = "Programação";
pub const DECK_VOCAB: &str = "Vocabulário";
pub const DECK_VOCAB_BASIC: &str = "Vocabulário::Inglês básico";
pub const DECK_VOCAB_OXFORD: &str = "Vocabulário::Oxford";
pub const DECK_VOCAB_EMPTY: &str = "Vocabulário::Revisar depois";

/// The vocabulary folder's "Word"-shaped notetype (fields `Word`, `Meaning`, `Audio`).
pub const VOCAB_WORD_NOTETYPE: &str = "Vocab (Word)";
/// The vocabulary folder's "Front"-shaped notetype (fields `Front`, `Back`).
pub const VOCAB_FRONT_NOTETYPE: &str = "Oxford (Front)";

/// Status of a fixture vocabulary note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureVocabStatus {
    /// Review card with this interval in days.
    Review(u32),
    New,
    Suspended,
}

/// One note of the fixture's vocabulary folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixtureVocabNote {
    /// Role in [`FixtureInfo::notes`] is `vocab:<key>`.
    pub key: &'static str,
    pub deck: &'static str,
    /// The word field (`Word` / `Front`), raw HTML.
    pub word: &'static str,
    /// The second field (`Meaning` / `Back`).
    pub meaning: &'static str,
    pub status: FixtureVocabStatus,
}

/// The vocabulary folder's notes, in creation order.
pub const VOCAB_NOTES: [FixtureVocabNote; 11] = [
    FixtureVocabNote {
        key: "learn",
        deck: DECK_VOCAB_BASIC,
        word: "<b>learn</b> [sound:learn.mp3]",
        meaning: "aprender",
        status: FixtureVocabStatus::Review(30),
    },
    FixtureVocabNote {
        key: "happy",
        deck: DECK_VOCAB_BASIC,
        word: "happy / glad",
        meaning: "feliz",
        status: FixtureVocabStatus::Review(25),
    },
    FixtureVocabNote {
        key: "quick",
        deck: DECK_VOCAB_BASIC,
        word: "{{c1::quick}}",
        meaning: "rápido",
        status: FixtureVocabStatus::Review(3),
    },
    FixtureVocabNote {
        key: "feel",
        deck: DECK_VOCAB_BASIC,
        word: "feel (v.)",
        meaning: "sentir",
        status: FixtureVocabStatus::Review(40),
    },
    FixtureVocabNote {
        key: "mean",
        deck: DECK_VOCAB_BASIC,
        word: "mean; meaning",
        meaning: "significar; significado",
        status: FixtureVocabStatus::Review(5),
    },
    FixtureVocabNote {
        key: "build",
        deck: DECK_VOCAB_BASIC,
        word: "build",
        meaning: "construir",
        status: FixtureVocabStatus::New,
    },
    FixtureVocabNote {
        key: "interest",
        deck: DECK_VOCAB_OXFORD,
        word: "interest",
        meaning: "interesse",
        status: FixtureVocabStatus::Review(21),
    },
    FixtureVocabNote {
        key: "farm",
        deck: DECK_VOCAB_OXFORD,
        word: "farm",
        meaning: "fazenda",
        status: FixtureVocabStatus::Review(60),
    },
    FixtureVocabNote {
        key: "animal",
        deck: DECK_VOCAB_OXFORD,
        word: "animal",
        meaning: "animal",
        status: FixtureVocabStatus::New,
    },
    FixtureVocabNote {
        key: "windmill",
        deck: DECK_VOCAB_OXFORD,
        word: "windmill",
        meaning: "moinho de vento",
        status: FixtureVocabStatus::Suspended,
    },
    FixtureVocabNote {
        key: "look up",
        deck: DECK_VOCAB_OXFORD,
        word: "look up",
        meaning: "procurar (no dicionário)",
        status: FixtureVocabStatus::Review(3),
    },
];

/// Name of the fixture's user-shaped command notetype (like the user's "DIGITE O COMANDO · CTRL+ENTER RESPONDE").
pub const USER_COMMAND_NOTETYPE: &str = "ROS 2 · Digite o comando";

const USER_COMMAND_FRONT: &str = r#"<div class="rotulo">DIGITE O COMANDO · CTRL+ENTER RESPONDE</div><div class="pergunta">{{Frente}}</div><textarea id="cmd" rows="3"></textarea>
<script>
(function () {
  var cmd = document.getElementById("cmd");
  if (!cmd) return;
  cmd.focus();
  cmd.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      pycmd("ans");
    }
  });
})();
</script>"#;

const USER_COMMAND_BACK: &str = r#"<div class="pergunta">{{Frente}}</div><hr id=answer><pre class="cmd"><code>{{Comando}}</code></pre>{{#Explicação}}<blockquote>{{Explicação}}</blockquote>{{/Explicação}}"#;

const USER_COMMAND_CSS: &str = ".card {
  font-family: system-ui, sans-serif;
  font-size: 18px;
  text-align: left;
  color: #1f1f1f;
  background-color: #fafafa;
}
.rotulo {
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #8a8a8a;
  margin-bottom: 12px;
}
.pergunta { font-size: 20px; margin-bottom: 12px; }
#cmd {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, monospace;
  font-size: 15px;
  padding: 8px;
}
hr#answer { border: none; border-top: 2px solid #333; }
pre.cmd {
  background: #f0f0f0;
  border: 1px solid #e2e2e2;
  border-radius: 3px;
  padding: 12px 16px;
  font-size: 15px;
  white-space: pre-wrap;
}
blockquote {
  margin: 12px 0;
  padding-left: 12px;
  border-left: 3px solid #c8c8c8;
  color: #555;
  font-size: 16px;
}
";

/// The fixture's user-type command notes (Frente, Comando, Explicação), from the captures.
pub const USER_COMMAND_NOTES: [(&str, &str, &str); 3] = [
    (
        "Ver a transformação entre os frames world e turtle1",
        "ros2 run tf2_ros tf2_echo world turtle1",
        "Imprime Translation e Rotation (quaternion) a cada atualização.",
    ),
    (
        "Listar os executáveis disponíveis dentro do pacote turtlesim",
        "ros2 pkg executables turtlesim",
        "Retorna turtlesim draw_square, turtlesim mimic, turtlesim turtle_teleop_key, turtlesim turtlesim_node.",
    ),
    (
        "Instalar o pacote turtlesim (Humble)",
        "sudo apt install ros-humble-turtlesim",
        "",
    ),
];

/// One "Código · Programa" note of the fixture, as plain text (encoded with [`code_to_html`] when added).
pub struct FixtureProgram {
    /// Role in [`FixtureInfo::notes`].
    pub role: &'static str,
    pub question: &'static str,
    pub language: &'static str,
    pub mode: &'static str,
    pub answer: &'static str,
    pub tests: &'static str,
    pub input: &'static str,
    pub expected_output: &'static str,
    pub notes: &'static str,
}

/// The "Programação" deck's notes, in creation order (so the deck's first card is the first one).
pub const PROGRAMS: [FixtureProgram; 5] = [
    FixtureProgram {
        role: "programaPython",
        question: "Função que soma os pares de uma lista",
        language: "python",
        mode: "testes",
        answer: "def soma_pares(xs):\n    return sum(x for x in xs if x % 2 == 0)",
        tests: "assert soma_pares([1, 2, 3, 4]) == 6\nassert soma_pares([]) == 0",
        input: "",
        expected_output: "",
        notes: "Uma expressão geradora dentro de sum() evita a lista intermediária.",
    },
    FixtureProgram {
        role: "programaPythonSaida",
        question: "Ler dois inteiros e imprimir a soma",
        language: "python",
        mode: "saida",
        answer: "a, b = map(int, input().split())\nprint(a + b)",
        tests: "",
        input: "2 3\n",
        expected_output: "5\n",
        notes: "",
    },
    FixtureProgram {
        role: "programaEstrutura",
        question: "Criar um nó rclpy mínimo",
        language: "python",
        mode: "estrutura",
        answer: "import rclpy\nfrom rclpy.node import Node\n\n\nclass Minimo(Node):\n    def __init__(self):\n        super().__init__(\"minimo\")\n\n\ndef main():\n    rclpy.init()\n    rclpy.spin(Minimo())\n    rclpy.shutdown()",
        tests: "",
        input: "",
        expected_output: "",
        notes: "rclpy.init() antes de criar o nó; spin() mantém o nó vivo.",
    },
    FixtureProgram {
        role: "programaCpp",
        question: "Função int quadrado(int x)",
        language: "cpp",
        mode: "testes",
        answer: "int quadrado(int x) { return x * x; }",
        tests: "int main() {\n    CHECK(quadrado(3) == 9);\n    CHECK(quadrado(-2) == 4);\n}",
        input: "",
        expected_output: "",
        notes: "",
    },
    FixtureProgram {
        role: "programaCppSaida",
        question: "Imprimir Olá, mundo!",
        language: "cpp",
        mode: "saida",
        answer: "#include <iostream>\nint main() { std::cout << \"Olá, mundo!\\n\"; }",
        tests: "",
        input: "",
        expected_output: "Olá, mundo!\n",
        notes: "",
    },
];

/// Plain text → field HTML exactly like the UI's `codeToHtml` (spec 11.1): CRLF/CR → LF, `&`, `<`, `>` escaped,
/// newlines → `<br>`.
fn code_to_html(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\n', "<br>")
}

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
    /// Adds the vocabulary folder ([`DECK_VOCAB`] and its subdecks, [`VOCAB_NOTES`]).
    #[serde(default)]
    pub vocab: bool,
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
    /// Also "comandoUsuario" (first user-type command note), "programaPython", "programaPythonSaida",
    /// "programaEstrutura", "programaCpp", "programaCppSaida".
    pub notes: BTreeMap<String, i64>,
    /// Role → notetype id: "usuarioComando" ([`USER_COMMAND_NOTETYPE`]).
    pub notetypes: BTreeMap<String, i64>,
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
    let program = notetype(col, CODE_PROGRAM)?;
    let user_command = user_command_notetype(col)?;
    info.notetypes
        .insert("usuarioComando".into(), user_command.id.0);
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
        DECK_PROGRAMMING,
    ] {
        decks.push((name, crate::decks::create(col, name)?));
    }
    if opts.isolation_probe {
        decks.push((DECK_ISOLATION, crate::decks::create(col, DECK_ISOLATION)?));
    }
    if opts.vocab {
        for name in [DECK_VOCAB_BASIC, DECK_VOCAB_OXFORD, DECK_VOCAB_EMPTY] {
            decks.push((name, crate::decks::create(col, name)?));
        }
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
    // The user's own command type (not an app type), as in the user's real deck.
    for (i, (front, cmd, explanation)) in USER_COMMAND_NOTES.iter().enumerate() {
        let (nid, _) = add(
            col,
            &user_command,
            ros,
            &[front, cmd, explanation],
            &["ros2"],
        )?;
        if i == 0 {
            info.notes.insert("comandoUsuario".into(), nid);
        }
    }

    // --- Programação: "Código · Programa" notes (Python and C++, every mode).
    let programming = deck_id(col, DECK_PROGRAMMING)?;
    for p in &PROGRAMS {
        let fields = [
            p.question.to_string(),
            p.language.to_string(),
            p.mode.to_string(),
            code_to_html(p.answer),
            String::new(),
            String::new(),
            code_to_html(p.tests),
            code_to_html(p.input),
            code_to_html(p.expected_output),
            p.notes.to_string(),
            String::new(),
        ];
        let fields: Vec<&str> = fields.iter().map(String::as_str).collect();
        let (nid, _) = add(col, &program, programming, &fields, &["programacao"])?;
        info.notes.insert(p.role.into(), nid);
    }

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

    if opts.vocab {
        add_vocab_folder(col, &mut info)?;
    }

    // Every deck expanded on the Decks screen; current deck = "5000 palavras".
    for (_, did) in &decks {
        col.set_deck_collapsed(DeckId(*did), false, DeckCollapseScope::Reviewer)?;
    }
    let vocab_parent: &[&str] = if opts.vocab { &[DECK_VOCAB] } else { &[] };
    for parent in [DECK_OXFORD, DECK_GRAMMAR, DECK_BOOKS]
        .iter()
        .chain(vocab_parent)
    {
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

/// The opt-in vocabulary folder: two user-shaped notetypes and [`VOCAB_NOTES`] with their statuses.
fn add_vocab_folder(col: &mut Collection, info: &mut FixtureInfo) -> Result<()> {
    let word = plain_notetype(
        col,
        VOCAB_WORD_NOTETYPE,
        &["Word", "Meaning", "Audio"],
        "{{Word}}",
        "{{FrontSide}}<hr id=answer>{{Meaning}}{{Audio}}",
    )?;
    let front = plain_notetype(
        col,
        VOCAB_FRONT_NOTETYPE,
        &["Front", "Back"],
        "{{Front}}",
        "{{FrontSide}}<hr id=answer>{{Back}}",
    )?;
    info.notetypes.insert("vocabWord".into(), word.id.0);
    info.notetypes.insert("vocabFront".into(), front.id.0);
    for v in VOCAB_NOTES {
        let did = deck_id(col, v.deck)?;
        let nt = if v.deck == DECK_VOCAB_BASIC {
            &word
        } else {
            &front
        };
        let (nid, cards) = add(col, nt, did, &[v.word, v.meaning], &["vocabulario"])?;
        match v.status {
            FixtureVocabStatus::Review(ivl) => {
                col.set_due_date(&cards, &format!("{ivl}!"), None)?;
            }
            FixtureVocabStatus::New => {}
            FixtureVocabStatus::Suspended => {
                col.bury_or_suspend_cards(
                    &cards,
                    anki_proto::scheduler::bury_or_suspend_cards_request::Mode::Suspend,
                )?;
            }
        }
        info.notes.insert(format!("vocab:{}", v.key), nid);
    }
    Ok(())
}

/// A plain user notetype with one "Cartão 1" template, or the existing one with that name.
fn plain_notetype(
    col: &mut Collection,
    name: &str,
    fields: &[&str],
    front: &str,
    back: &str,
) -> Result<std::sync::Arc<Notetype>> {
    if let Some(existing) = col.get_notetype_by_name(name)? {
        return Ok(existing);
    }
    let mut nt = Notetype {
        name: name.to_string(),
        fields: fields.iter().map(|f| NoteField::new(*f)).collect(),
        templates: vec![CardTemplate::new(card_1_name(), front, back)],
        ..Default::default()
    };
    nt.config.sort_field_idx = 0;
    col.add_notetype(&mut nt, false)?;
    notetype(col, name)
}

/// [`USER_COMMAND_NOTETYPE`]: added as a plain user type (fields, one "Cartão 1" template, CSS), or the existing one.
fn user_command_notetype(col: &mut Collection) -> Result<std::sync::Arc<Notetype>> {
    if let Some(existing) = col.get_notetype_by_name(USER_COMMAND_NOTETYPE)? {
        return Ok(existing);
    }
    let mut nt = Notetype {
        name: USER_COMMAND_NOTETYPE.to_string(),
        fields: ["Frente", "Comando", "Explicação"]
            .into_iter()
            .map(NoteField::new)
            .collect(),
        templates: vec![CardTemplate::new(
            card_1_name(),
            USER_COMMAND_FRONT,
            USER_COMMAND_BACK,
        )],
        ..Default::default()
    };
    nt.config.sort_field_idx = 0;
    nt.config.css = USER_COMMAND_CSS.to_string();
    col.add_notetype(&mut nt, false)?;
    notetype(col, USER_COMMAND_NOTETYPE)
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

#[cfg(test)]
mod tests {
    use super::code_to_html;

    /// The shared vectors of the UI's `codeToHtml` (core-code), plus the literal cases of `codeField.test.ts`.
    #[test]
    fn code_to_html_matches_the_ui() {
        assert_eq!(
            code_to_html("a < b & c > d\nnext"),
            "a &lt; b &amp; c &gt; d<br>next"
        );
        assert_eq!(code_to_html("x\r\ny"), "x<br>y");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../core-code/tests/fixtures/code_html_vectors.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        let vectors: Vec<serde_json::Value> = serde_json::from_str(&text).expect("vectors JSON");
        assert!(!vectors.is_empty());
        for v in vectors {
            let (Some(input), Some(html)) = (v["text"].as_str(), v["html"].as_str()) else {
                continue;
            };
            assert_eq!(code_to_html(input), html, "{}", v["name"]);
        }
    }
}
