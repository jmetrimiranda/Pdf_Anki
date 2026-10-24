//! Serde types of the study screen (camelCase; mirrored in `web/src/lib/core/types.ts`).
use serde::{Deserialize, Serialize};

/// Footer counters "new + learn + review" (spec 8.2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueCounts {
    pub new: u32,
    pub learn: u32,
    pub review: u32,
}

/// One `[sound:…]` or `[anki:tts…]` tag of a card side, in the order of the `[anki:play:q|a:N]` markers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AvTag {
    /// Media file name (basename only; empty when the name was unsafe — the host skips it).
    Sound { file: String },
    Tts {
        text: String,
        lang: String,
        voices: Vec<String>,
        speed: f32,
    },
}

/// What the number of a `leitor://` link counts: a PDF page (`pagina=N`) or an EPUB chapter, i.e. a section of the
/// book in reading order (`cap=N`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceUnit {
    #[default]
    Page,
    Chapter,
}

/// "Abrir no livro": the first valid `leitor://livro/<uid>?pagina=N[&q=…]` (PDF) or
/// `leitor://livro/<uid>?cap=N[&cfi=…][&q=…]` (EPUB) link of the note's Fonte field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLink {
    pub book_uid: String,
    /// 1-based, as written in the link: the PDF page or the EPUB section ([`SourceLink::unit`]).
    pub page: u32,
    #[serde(default)]
    pub unit: SourceUnit,
    /// The EPUB position (`epubcfi(...)`), only when the link has a valid one.
    #[serde(default)]
    pub cfi: Option<String>,
    pub query: Option<String>,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueueKind {
    New,
    Learn,
    Review,
}

/// Custom scheduling JS (`cardStateCustomizer`), run in the card iframe like `RUN_STATE_MUTATION`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateMutation {
    pub key: String,
    pub js: String,
}

/// The card on screen: question side ready to show, answer preload, buttons and counters.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyCard {
    pub card_id: i64,
    pub note_id: i64,
    pub deck_id: i64,
    pub deck_name: String,
    /// `<style>css</style>` + question, after `prepare_card_text_for_display` and the type-answer filter.
    pub question_html: String,
    /// Raw answer with media paths encoded (only used by `_showQuestion` to preload images/MathJax).
    pub answer_preload_html: String,
    /// `card cardN`; the host appends the platform/theme classes.
    pub body_class: String,
    pub question_av: Vec<AvTag>,
    pub answer_av: Vec<AvTag>,
    pub autoplay: bool,
    pub replay_question_on_answer: bool,
    pub queue: QueueKind,
    pub counts: QueueCounts,
    pub show_counts: bool,
    /// Interval labels [again, hard, good, easy] from `describe_next_states`.
    pub buttons: [String; 4],
    pub show_intervals: bool,
    pub flag: u8,
    pub marked: bool,
    pub type_answer: bool,
    pub state_mutation: Option<StateMutation>,
    pub source: Option<SourceLink>,
    pub can_undo: bool,
    pub show_timer: bool,
    pub timer_max_secs: u32,
    /// Code card (spec 11.2): the app studies it with its own editor and checker. `None` (`code: null`) for
    /// every other card.
    pub code: Option<CodeCard>,
}

/// Kind of code card (spec 11.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeCardRole {
    Command,
    Program,
}

/// What the code review needs from a code card (spec 11.2). For code cards `question_html` is only the question
/// field (no type box, never the user's own front template) and `type_answer` is false.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeCard {
    pub role: CodeCardRole,
    pub notetype_id: i64,
    /// One of the app's types ("Código · Comando"/"Código · Programa") rather than a mapped user type.
    pub app_type: bool,
    /// The notetype has an `Aceitas` field ("Contestar" adds to it; otherwise to `code_note_extra`).
    pub accepted_field: bool,
    /// The card's answer template shows the notes field (the UI then doesn't repeat it).
    pub answer_shows_notes: bool,
    /// The card's answer template prints the answer field (the UI then doesn't repeat the reference answer).
    pub answer_shows_answer: bool,
    pub fields: CodeCardFields,
}

/// Raw field HTML of a code card (`""` when the type lacks the field); the UI decodes it with `htmlToCode`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeCardFields {
    pub answer: String,
    pub accepted: String,
    pub requires: String,
    pub notes: String,
    pub language: String,
    pub mode: String,
    pub initial: String,
    pub setup: String,
    pub tests: String,
    pub input: String,
    pub expected_output: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StudyNext {
    Card {
        card: Box<StudyCard>,
    },
    Done {
        deck_id: i64,
        deck_name: String,
        counts: QueueCounts,
        can_undo: bool,
    },
}

impl StudyNext {
    pub fn card(&self) -> Option<&StudyCard> {
        match self {
            StudyNext::Card { card } => Some(card),
            StudyNext::Done { .. } => None,
        }
    }
}

/// The answer side: munged answer HTML (type-answer comparison included), its AV tags and the answer buttons'
/// interval labels described from the card's current (possibly mutated) scheduling states.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerSide {
    pub html: String,
    pub av: Vec<AvTag>,
    pub buttons: [String; 4],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CardAction {
    Bury,
    BuryNote,
    Suspend,
    SuspendNote,
    Flag,
    Mark,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardActionResult {
    pub flag: u8,
    pub marked: bool,
    /// Bury/suspend move on to the next card; flag/mark keep the current one (`None`).
    pub next: Option<StudyNext>,
}
