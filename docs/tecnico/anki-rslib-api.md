# Anki `rslib` (crate `anki`) — API reference for `core-anki` / `AnkiService`

Source: `ankitects/anki` tag **26.09.3**, read at `/tmp/anki-ref`. Every path below is relative to
`/tmp/anki-ref/rslib/src/` unless it starts with `proto/`, `qt/`, `pylib/` (repo root) or `rslib/`.
Signatures are copied from source. "Unnameable" = `pub` item inside a private / `pub(crate)` module:
you can call it and read its `pub` fields, but you cannot write its type name in your code.

Covers spec sections 8.1, 8.2, 8.5, 9, 10.1, 11.1, 12.3, 12.6.

---

## 0. TL;DR (read this first)

| Need | Use | Visibility / gotcha |
|---|---|---|
| Open collection | `CollectionBuilder::new(path).set_media_paths(..).set_tr(..).build()` | `with_desktop_media_paths()` gives `collection.media/` + `collection.mdb` |
| Deck list + counts | `col.deck_tree(Some(TimestampSecs::now()))` → `anki_proto::decks::DeckTreeNode` | `None` = no counts and **browser** collapse state |
| Study queue | `col.get_queued_cards(1, false)` | `QueuedCards`/`QueuedCard` are **unnameable** (module `scheduler::queue` is `pub(crate)`) |
| Button labels "<1m 10m 1d" | `col.describe_next_states(&states)` | same function the desktop uses (`reviewer.py:916`) |
| Answer | `col.answer_card(&mut CardAnswer{..})` | card must be **top of queue** if `from_queue: true` |
| Undo only answers | `col.can_undo() == Some(&Op::AnswerCard)` then `col.undo()` | |
| Render | `col.render_existing_card(cid, false, false)` → `.question()/.answer()/.css` | `RenderCardOutput` unnameable; then run `extract_av_tags` |
| compare_answer / extract_av_tags | `CardRenderingService` trait (proto types) or `anki::card_rendering::extract_av_tags` | `typeanswer` module is private → use the trait for `compare_answer` |
| /_anki/ bridge | `col.run_service_method(service, method, &bytes)` | **exists**; indices = `anki_proto_gen::get_services()` collection services |
| Sync | `anki::sync::login::sync_login`, `col.normal_sync`, `col.full_upload/full_download` (consume `self`), `col.media()?.sync_media(..)` | needs a tokio runtime + `reqwest 0.12` dep; `sync_login` returns `endpoint: None` |
| Backup | `col.maybe_backup(dir, force)` (no media, no close) or `col.export_colpkg(..)` (consumes `self`) | |

Every generated proto service trait (`anki::services::DecksService`, `SchedulerService`, ...) is
`pub` and implemented for `Collection`, so **any** RPC is callable from Rust with proto types, e.g.
`anki::services::CardRenderingService::compare_answer(&mut col, req)`. When the trait method name
equals an inherent method (`get_deck`, `get_queued_cards`, `get_note`...) use UFCS — method-call
syntax picks the inherent one.

---

## 1. Opening / closing the collection

`collection/mod.rs`

```rust
#[derive(Default)] pub struct CollectionBuilder { /* private */ }               // :36
impl CollectionBuilder {
    pub fn new(col_path: impl Into<PathBuf>) -> Self                              // :49
    pub fn build(&mut self) -> Result<Collection>                                 // :55
    pub fn set_collection_path<P: Into<PathBuf>>(&mut self, collection: P) -> &mut Self      // :81
    pub fn set_media_paths<P: Into<PathBuf>>(&mut self, media_folder: P, media_db: P) -> &mut Self // :86
    /// For a `foo.anki2` file, use `foo.media` and `foo.mdb`.
    pub fn with_desktop_media_paths(&mut self) -> &mut Self                       // :95
    pub fn set_server(&mut self, server: bool) -> &mut Self                      // :103
    pub fn set_tr(&mut self, tr: I18n) -> &mut Self                               // :108
    pub fn set_check_integrity(&mut self, check_integrity: bool) -> &mut Self    // :113
    pub fn set_shared_progress_state(&mut self, state: Arc<Mutex<ProgressState>>) -> &mut Self // :120
}
pub struct Collection { pub storage: SqliteStorage, /* rest pub(crate) */ }      // :143
impl Collection {
    pub fn as_builder(&self) -> CollectionBuilder                                 // :162  (same paths/tr/progress)
    pub fn changes_since_open(&self) -> Result<u64>                               // :174
    pub fn close(self, desired_version: Option<SchemaVersion>) -> Result<()>      // :181
    pub fn tr(&self) -> &I18n                                                     // :215
}
```

- `anki::storage::SchemaVersion { V11, V18 }` (`storage/mod.rs:26`). Use `close(None)`.
- `I18n` = `anki_i18n::I18n` (re-exported in `anki::prelude`). `I18n::new(&["pt-BR"])`
  (`rslib/i18n/src/lib.rs:255`), `I18n::template_only()` (:251, English; the default when `set_tr`
  is not called). **`tr` localizes button labels, `studied_today`, stock notetype names and field
  names**. Translations come from the `ftl/core-repo` git submodule (cargo fetches submodules for git
  deps; it is empty in `/tmp/anki-ref`, so translations could not be checked here).
- `with_desktop_media_paths` `unwrap()`s the collection path and `expect()`s creating the folder
  (panics, not `Err`).
- **No media paths ⇒ every media op fails** with "attempted media operation without media folder
  set" (`media/mod.rs:50`), including `import_apkg`, `export_apkg` with media, `media()`.
- `ProgressState` (`progress.rs:121`, `pub want_abort: bool, pub last_progress: Option<Progress>`)
  is unnameable (`mod progress` is private). Construct it by inference and erase it in a closure:

```rust
use std::sync::{Arc, Mutex};
let progress = Arc::new(Mutex::new(Default::default()));   // type inferred from the call below
let mut b = anki::collection::CollectionBuilder::new(dir.join("collection.anki2"));
b.with_desktop_media_paths()
 .set_tr(anki::prelude::I18n::new(&["pt-BR"]))
 .set_shared_progress_state(progress.clone());
let col = b.build()?;
let p2 = progress.clone();
let abort: Box<dyn Fn() + Send + Sync> = Box::new(move || p2.lock().unwrap().want_abort = true);
```

`Collection` is `Send` (the upstream `Backend` keeps it in `Mutex<Option<Collection>>` inside an `Arc`'d `BackendInner`, `backend/mod.rs:53`), not
`Sync`: fits the dedicated actor thread. SQLite is opened in exclusive locking mode, so only one
handle per file.

Escape hatch: `col.storage.db() -> &rusqlite::Connection` (`storage/sqlite.rs:96`, "exercise
caution"). `rusqlite` must be the same version as Anki's (0.36.0). The field `storage.db` itself is
`pub(crate)`.

---

## 2. Decks

```rust
// decks/tree.rs
pub use anki_proto::decks::set_deck_collapsed_request::Scope as DeckCollapseScope; // :9
pub fn deck_tree(&mut self, timestamp: Option<TimestampSecs>) -> Result<DeckTreeNode>   // :252
pub fn current_deck_tree(&mut self) -> Result<Option<DeckTreeNode>>                       // :292
pub fn set_deck_collapsed(&mut self, did: DeckId, collapsed: bool, scope: DeckCollapseScope)
    -> Result<OpOutput<()>>                                                               // :298 (Op::SkipUndo)
// decks/mod.rs
pub fn get_or_create_normal_deck(&mut self, human_name: &str) -> Result<Deck>            // :160
pub fn get_deck(&mut self, did: DeckId) -> Result<Option<Arc<Deck>>>                     // :174
pub fn get_deck_id(&self, human_name: &str) -> Result<Option<DeckId>>                    // :193
impl Deck { pub fn new_normal() -> Deck }                                                 // :64
// decks/name.rs
pub fn get_all_normal_deck_names(&mut self, skip_default: bool) -> Result<Vec<(DeckId, String)>> // :105
pub fn rename_deck(&mut self, did: DeckId, new_human_name: &str) -> Result<OpOutput<()>>  // :127
pub fn get_all_deck_names(&self, skip_default: bool) -> Result<Vec<(DeckId, String)>>     // :167
impl Deck { pub fn human_name(&self) -> String }                                          // :99
// decks/reparent.rs
pub fn reparent_decks(&mut self, deck_ids: &[DeckId], new_parent: Option<DeckId>)
    -> Result<OpOutput<usize>>                                                            // :7  (None = top level)
// decks/remove.rs
pub fn remove_decks_and_child_decks(&mut self, dids: &[DeckId]) -> Result<OpOutput<usize>> // :6 (returns cards deleted)
// decks/current.rs
pub fn set_current_deck(&mut self, deck: DeckId) -> Result<OpOutput<()>>                 // :10 (Op::SetCurrentDeck)
pub fn get_current_deck(&mut self) -> Result<Arc<Deck>>                                  // :16 (falls back to Default deck 1)
// decks/addupdate.rs
pub fn add_deck(&mut self, deck: &mut Deck) -> Result<OpOutput<()>>        // :12 id must be 0
pub fn update_deck(&mut self, deck: &mut Deck) -> Result<OpOutput<()>>     // :16
pub fn add_or_update_deck(&mut self, deck: &mut Deck) -> Result<OpOutput<()>> // :27
```

`DeckTreeNode` = `anki_proto::decks::DeckTreeNode` (`proto/anki/decks.proto:157`): `deck_id, name
(last component), level, collapsed, review_count, learn_count, new_count` (with children + limits =
what the Anki deck list shows), `intraday_learning, interday_learning_uncapped, new_uncapped,
review_uncapped, total_in_deck, total_including_children, filtered, children`.
The returned root is a dummy node (deck_id 0); real decks are `root.children`.

Gotchas:
- `deck_tree(None)` → **no counts**, `collapsed` = `browser_collapsed`. `deck_tree(Some(now))` →
  counts + `study_collapsed` (`tree.rs:68-84`), and it unburies if the day rolled over.
  For the Decks screen: `Some(TimestampSecs::now())` + `set_deck_collapsed(.., DeckCollapseScope::Reviewer)`.
- The empty "Default" deck (id 1) is hidden from the tree (`hide_default_deck`, :182).
- `get_or_create_normal_deck` accepts `"A::B::C"` and creates parents; it is an undoable `Op::AddDeck`.
  Despite the name it does **not** check the kind of an existing deck: if a *filtered* deck already
  has that name, it is returned as-is (`decks/mod.rs:160-170`). Check `deck.is_filtered()`.
- `remove_decks_and_child_decks` never deletes the Default deck (id 1): its cards are deleted and it
  is renamed back to the localized default name (`decks/remove.rs:36-43`).
- The Default deck is hidden only if it is empty **and** has no children **and** is not the only deck
  (`tree.rs:182-195`).
- Renaming/creating with an existing name silently appends `+` (`ensure_deck_name_unique`).
- No public "counts for one deck" helper: take the node from `deck_tree`, or call
  `SchedulerService::counts_for_deck_today` (proto) via UFCS.
- `set_current_deck` only records an undo step if the value actually changed; it drops the study
  queues (`current.rs:33`).

---

## 3. Study queue, scheduling states, answering

### 3.1 Queue — `scheduler/queue/mod.rs` (module is `pub(crate)` ⇒ types unnameable)

```rust
pub struct Counts { pub new: usize, pub learning: usize, pub review: usize }        // :47
pub struct QueuedCard { pub card: Card, pub kind: QueueEntryKind,
                        pub states: SchedulingStates, pub context: SchedulingContext } // :60
pub struct QueuedCards { pub cards: Vec<QueuedCard>, pub new_count: usize,
                         pub learning_count: usize, pub review_count: usize }          // :68
pub fn get_next_card(&mut self) -> Result<Option<QueuedCard>>                          // :85
pub fn get_queued_cards(&mut self, fetch_limit: usize, intraday_learning_only: bool)
    -> Result<QueuedCards>                                                             // :90
```

- The queue is built for **`get_current_deck()`** (`get_queues`, :245). Call `set_current_deck` first.
- `QueueEntryKind { New, Learning, Review }` (`queue/entry.rs:44`) cannot be named outside the crate,
  so you cannot `match` it. Either convert:
  `let p: anki_proto::scheduler::queued_cards::QueuedCard = qc.into();` (`p.queue` i32, impl at
  `scheduler/service/answering.rs:40`), or use `qc.card.queue_number()` (`card/mod.rs:178`,
  `anki::card::CardQueueNumber`). Store the whole thing as proto if you need to keep it in a struct.
- `Card` fields are `pub(crate)`; accessors: `id() note_id() deck_id() template_idx() queue_number()`
  (`card/mod.rs:162-178`). For flags/custom_data: `anki_proto::cards::Card::from(card)` (`card/service.rs:116`).
- Footer counts "40 + 23 + 26" = `new_count + learning_count + review_count`.

### 3.2 Scheduling states and button labels

```rust
// scheduler/states/mod.rs (pub mod)
pub enum CardState { Normal(NormalState), Filtered(FilteredState) }                   // :34
pub struct SchedulingStates { pub current: CardState, pub again: CardState,
    pub hard: CardState, pub good: CardState, pub easy: CardState }                   // :158
// scheduler/answering/mod.rs (pub mod)
pub fn get_scheduling_states(&mut self, cid: CardId) -> Result<SchedulingStates>      // :230
/// Describe the next intervals, to display on the answer buttons.
pub fn describe_next_states(&mut self, choices: &SchedulingStates) -> Result<Vec<String>> // :269
// scheduler/timespan.rs (pub mod)
pub fn answer_button_time_collapsible(seconds: u32, collapse_secs: u32, tr: &I18n) -> String // :23
```

`describe_next_states` is exactly what desktop uses: `qt/aqt/reviewer.py:916`
`labels = self.mw.col.sched.describe_next_states(self._v3.states)` →
`pylib/anki/scheduler/v3.py:59` → backend `DescribeNextStates`. Returns 4 strings
`[again, hard, good, easy]`; within learn-ahead time they get a `<` prefix ("<10m"); 0 s →
`tr.scheduling_end()`. Desktop only shows them if `col.conf["estTimes"]` is true (`reviewer.py:947`).
Proto conversions both ways exist (`scheduler/service/states/mod.rs:18,30,42,58`).

### 3.3 Answering — `scheduler/answering/mod.rs`

```rust
#[derive(Copy, Clone)] pub enum Rating { Again, Hard, Good, Easy }                   // :41
pub struct CardAnswer {                                                               // :48
    pub card_id: CardId, pub current_state: CardState, pub new_state: CardState,
    pub rating: Rating, pub answered_at: TimestampMillis, pub milliseconds_taken: u32,
    pub custom_data: Option<String>, pub from_queue: bool,
}
/// Provided [CardAnswer] has its answer time capped to deck preset.
pub fn answer_card(&mut self, answer: &mut CardAnswer) -> Result<OpOutput<()>>       // :317 (Op::AnswerCard)
```

```rust
use anki::scheduler::answering::{CardAnswer, Rating};
let q = col.get_queued_cards(1, false)?;
let Some(top) = q.cards.first() else { /* congrats */ };
let labels = col.describe_next_states(&top.states)?;          // ["<1m","<10m","1d","4d"]
let r = Rating::Good;
let new_state = match r { Rating::Again => top.states.again, Rating::Hard => top.states.hard,
                          Rating::Good => top.states.good, Rating::Easy => top.states.easy };
col.answer_card(&mut CardAnswer {
    card_id: top.card.id(), current_state: top.states.current, new_state, rating: r,
    answered_at: TimestampMillis::now(), milliseconds_taken: elapsed_ms,
    custom_data: None, from_queue: true,
})?;
```

Gotchas:
- Mirrors `pylib/anki/scheduler/v3.py:66-92` (`build_answer`). Desktop passes the **uncapped**
  time; rslib caps it to the preset's `cap_answer_time_to_secs` (spec 8.2 "respeitando o máximo").
- `from_queue: true` ⇒ card must be the queue head or in the intraday learning queue, else
  `invalid_input!("not at top of queue")` (`queue/mod.rs:164-176`). Use `false` for answering
  outside the queue (e.g. a card-browser "grade now").
- **Stale queue after `from_queue: false`**: the queue is only updated when `from_queue` is true
  (`answering/mod.rs:378-391`), and `Op::AnswerCard` is explicitly exempt from the automatic queue
  reset (`maybe_clear_study_queues_after_op`, `queue/mod.rs:210-214`). There is no public
  `clear_study_queues` (it is `pub(crate)`, :206). If you answer outside the queue while a study
  session is open, force a rebuild with an op that resets queues (e.g. `set_current_deck` to a
  different deck and back) or only answer out-of-queue when no study session is active.
- `current_state` must equal the card's state now (elapsed secs are reconciled; otherwise
  "card was modified"). Re-fetch the queue after editing a card.
- `custom_data`: the desktop takes it from `new_state.custom_data` (proto) — only relevant if you
  support deck-option custom scheduling JS.

### 3.4 Bury / suspend / flag / mark

```rust
// scheduler/bury_and_suspend.rs  (Mode is a private `use`, name it from anki_proto)
pub fn bury_or_suspend_cards(&mut self, cids: &[CardId], mode: BuryOrSuspendMode)
    -> Result<OpOutput<usize>>                                                       // :117
//   mode = anki_proto::scheduler::bury_or_suspend_cards_request::Mode::{Suspend, BurySched, BuryUser}
pub fn unbury_or_unsuspend_cards(&mut self, cids: &[CardId]) -> Result<OpOutput<()>> // :64
// card/mod.rs
pub fn set_card_flag(&mut self, cards: &[CardId], flag: u32) -> Result<OpOutput<usize>> // :426 (0..=7; does not rebuild queue)
pub fn set_deck(&mut self, cards: &[CardId], deck_id: DeckId) -> Result<OpOutput<usize>> // :370
// tags
pub fn add_tags_to_notes(&mut self, nids: &[NoteId], tags: &str) -> Result<OpOutput<usize>> // tags/bulkadd.rs:16
pub fn remove_tags_from_notes(&mut self, nids: &[NoteId], tags: &str) -> Result<OpOutput<usize>> // tags/remove.rs:17
// scheduler/new.rs ("forget", reposition)
pub fn reschedule_cards_as_new(&mut self, cids: &[CardId], log: bool, restore_position: bool,
    reset_counts: bool, context: Option<ScheduleAsNewContext>) -> Result<OpOutput<()>>   // :153
pub fn sort_cards(&mut self, cids: &[CardId], starting_from: u32, step: u32,
    order: NewCardDueOrder, shift: bool) -> Result<OpOutput<usize>>                      // :209
```

- Desktop `-` (bury) uses `BuryUser` (`pylib/anki/scheduler/base.py:163`); `@` → `Suspend`.
- **Mark** = tag `marked` (`qt/aqt/reviewer.py:1106`): `note.tags` contains "marked" ? `remove_tags_from_notes` : `add_tags_to_notes`.
- `sort_cards` (reposition new cards) is what spec 12.6 "ordem dos cards novos" needs.

---

## 4. Undo

```rust
// undo/mod.rs
pub struct UndoStatus { pub undo: Option<Op>, pub redo: Option<Op>, pub last_step: usize }  // :40
pub struct UndoOutput { pub undone_op: Op, pub reverted_to: TimestampSecs,
                        pub new_undo_status: UndoStatus, pub counter: usize }               // :46
pub fn can_undo(&self) -> Option<&Op>                       // :172
pub fn can_redo(&self) -> Option<&Op>                       // :176
pub fn undo(&mut self) -> Result<OpOutput<UndoOutput>>      // :180  Err(AnkiError::UndoEmpty) if empty
pub fn redo(&mut self) -> Result<OpOutput<UndoOutput>>      // :187
pub fn undo_status(&self) -> UndoStatus                     // :195
pub fn merge_undoable_ops(&mut self, starting_from: usize) -> Result<OpChanges> // :205
pub fn add_custom_undo_step(&mut self, name: String) -> usize                   // :211
// ops.rs
#[derive(Debug, Clone, PartialEq, Eq)] pub enum Op { Custom(String), AddDeck, AddNote, AnswerCard,
    Bury, ..., SetCurrentDeck, SkipUndo }                                           // :7
pub struct StateChanges { pub card, note, deck, tag, notetype, config, deck_config, mtime: bool } // :107
pub struct OpChanges { pub op: Op, pub changes: StateChanges }                      // :119
pub struct OpOutput<T> { pub output: T, pub changes: OpChanges }                     // :125
impl OpChanges { pub fn requires_study_queue_rebuild(&self) -> bool /* :168 */ ... }
impl Op { pub fn describe(&self, tr: &I18n) -> String }
```

"Only undo if the last op is an answer" (spec 10.1):

```rust
let ctrl_z_enabled = matches!(col.can_undo(), Some(anki::prelude::Op::AnswerCard));
if ctrl_z_enabled { col.undo()?; /* then get_queued_cards again: undo restores the queue entry */ }
```

Undo-stack facts (`undo/mod.rs:71-100`, `collection/transact.rs`):
- A step is only pushed if it changed something (setting the same current deck is not recorded).
- `Op::SkipUndo` (e.g. `set_deck_collapsed`) does not record and does **not** clear the stack.
- Non-undoable ops (`transact_no_undo`, e.g. `add_or_update_notetype_with_existing_id`) **clear the
  whole undo/redo stack**; normal sync does too (`discard_undo_and_study_queues`).
- **Any op that returns `Err`** (e.g. `answer_card` failing with "card was modified") also calls
  `discard_undo_and_study_queues()` (`collection/transact.rs:46-47`) ⇒ undo stack wiped and queues
  dropped. After any error, re-query `can_undo()` and the queue.
- `UndoStatus`/`UndoOutput` do not derive `Debug`/`Clone`.
- `UNDO_LIMIT = 30` (`undo/mod.rs:15`) caps the stack length.
- The mini-review switch (spec 10.1) records two `SetCurrentDeck` steps; afterwards the main study
  Ctrl+Z is correctly disabled until the next answer.

---

## 5. Rendering, typed answers, AV tags

```rust
// notetype/render.rs   (RenderCardOutput is `pub(crate) use` ⇒ unnameable)
pub struct RenderCardOutput { pub qnodes: Vec<RenderedNode>, pub anodes: Vec<RenderedNode>,
    pub css: String, pub latex_svg: bool, pub is_empty: bool }                    // :18
impl RenderCardOutput {
    /// only valid when partial_render=false
    pub fn question(&self) -> Cow<'_, str>                                         // :28
    pub fn answer(&self) -> Cow<'_, str>                                           // :36
}
pub fn render_existing_card(&mut self, cid: CardId, browser: bool, partial_render: bool)
    -> Result<RenderCardOutput>                                                    // :46
// template.rs
pub enum RenderedNode { Text { text: String },
    Replacement { field_name: String, current_text: String, filters: Vec<String> } } // :367
// card_rendering/mod.rs (pub mod)
pub fn extract_av_tags<S: Into<String> + AsRef<str>>(txt: S, question_side: bool, tr: &I18n)
    -> (String, Vec<anki_proto::card_rendering::AvTag>)                           // :19
pub fn strip_av_tags<S: Into<String> + AsRef<str>>(txt: S) -> String              // :13
// typeanswer.rs — module is PRIVATE (`mod typeanswer;`), so not callable directly:
pub fn compare_answer(expected: &str, typed: &str, combining: bool) -> String      // :38
// reachable via the service trait (card_rendering/service.rs:166):
fn compare_answer(&mut self, input: anki_proto::card_rendering::CompareAnswerRequest)
    -> Result<anki_proto::generic::String>
fn extract_cloze_for_typing(&mut self, input: ExtractClozeForTypingRequest) -> Result<generic::String>
```

Python flow to port (`pylib/anki/template.py:224-256`): partial render → apply custom filters
(add-on hooks + inject `FrontSide`) → `extract_av_tags(text, question_side)` per side. We have no
Python filters, so:

```rust
let out = col.render_existing_card(cid, false, /*partial_render*/ false)?;
let (q_html, q_av) = anki::card_rendering::extract_av_tags(out.question().into_owned(), true, col.tr());
let (a_html, a_av) = anki::card_rendering::extract_av_tags(out.answer().into_owned(), false, col.tr());
let css = out.css;   // desktop wraps it as <style>{css}</style> (template.py:289)
```

- With `partial_render=true`, `{{FrontSide}}` and unknown filters come back as `Replacement`
  nodes the caller must complete (`template.rs:425-447`); `question()` then returns the literal
  `"not fully rendered"`. **Use `false`.**
- `{{type:Field}}` renders to the literal `[[type:Field]]` / `[[type:cloze:Field]]` /
  `[[type:nc:Field]]` (`template_filters.rs:166-176`); `typeAnsQuestionFilter`/`typeAnsAnswerFilter`
  in `qt/aqt/reviewer.py` replace it (port to Rust/TS) and call `compare_answer`.
- After `extract_av_tags`, sounds/TTS are replaced by `[anki:play:q:N]` / `[anki:play:a:N]`
  (`card_rendering/writer.rs:138`); `av_tags[N]` is `AvTag { value: Option<av_tag::Value> }` with
  `Value::SoundOrVideo(String)` or `Value::Tts(TtsTag { field_text, lang, voices, speed, other_args })`
  (`proto/anki/card_rendering.proto:53-66`). `av_refs_to_play_icons` (desktop) turns the markers into buttons.
- `compare_answer` output is HTML (`<code id=typeans>...`).
- **Empty cards**: when `out.is_empty` is true, rslib *pushes* an extra `Text` node with the
  "empty front"/"missing cloze" message onto `qnodes` (`template.rs:625-641`), so `qnodes` usually has
  2 nodes and `question()` returns the literal `"not fully rendered"`; `answer()` holds the message.
  Check `is_empty` first.
- Previews of unsaved notes/templates: `pub fn render_uncommitted_card(&mut self, note: &mut Note,
  template: &CardTemplate, card_ord: u16, fill_empty: bool, partial_render: bool) -> Result<RenderCardOutput>`
  (`notetype/render.rs:71`).

```rust
use anki::services::CardRenderingService;
let html = CardRenderingService::compare_answer(&mut col,
    anki_proto::card_rendering::CompareAnswerRequest { expected, provided, combining: true })?.val;
```

---

## 6. Notetypes (Basic/Cloze clones with `Fonte`, code and vocab types)

```rust
// notetype/mod.rs
pub struct Notetype { pub id: NotetypeId, pub name: String, pub mtime_secs: TimestampSecs,
    pub usn: Usn, pub fields: Vec<NoteField>, pub templates: Vec<CardTemplate>,
    pub config: NotetypeConfig }                                                    // :85
impl Default for Notetype  // config = new_config(): DEFAULT_CSS + latex header/footer   :99
pub fn new_note(&self) -> Note                                                      // :128
pub fn get_template(&self, card_ord: u16) -> Result<&CardTemplate>                  // :134
pub fn add_notetype(&mut self, notetype: &mut Notetype, skip_checks: bool) -> Result<OpOutput<()>> // :147
/// This will force a full sync if templates or fields have been added/removed/reordered.
pub fn update_notetype(&mut self, notetype: &mut Notetype, skip_checks: bool) -> Result<OpOutput<()>> // :164
pub fn add_or_update_notetype_with_existing_id(&mut self, notetype: &mut Notetype, skip_checks: bool)
    -> Result<()>                                                                   // :187 (no undo; clears undo stack)
pub fn get_notetype_by_name(&mut self, name: &str) -> Result<Option<Arc<Notetype>>> // :199
pub fn get_notetype(&mut self, ntid: NotetypeId) -> Result<Option<Arc<Notetype>>>   // :207
pub fn get_all_notetypes(&mut self) -> Result<Vec<Arc<Notetype>>>                   // :220
pub fn remove_notetype(&mut self, ntid: NotetypeId) -> Result<OpOutput<()>>         // :243
pub(crate) fn add_field / add_template                                              // :465 / :470 — NOT usable
// notetype/stock.rs (module pub(crate), fn re-exported)
pub fn all_stock_notetypes(tr: &I18n) -> Vec<Notetype>                              // :41
//   order: [Basic, Basic+Reversed, Basic optional reversed, Basic type-in, Cloze, Image Occlusion]
// notetype/fields.rs, templates.rs
pub struct NoteField { pub ord: Option<u32>, pub name: String, pub config: NoteFieldConfig }
impl NoteField { pub fn new(name: impl Into<String>) -> Self }                      // fields.rs:36
pub struct CardTemplate { pub ord: Option<u32>, pub mtime_secs, pub usn, pub name: String,
    pub config: CardTemplateConfig /* .q_format, .a_format, ... */ }
impl CardTemplate { pub fn new<S1,S2,S3>(name: S1, qfmt: S2, afmt: S3) -> Self }   // templates.rs:84
// re-exports in anki::notetype: NotetypeKind, NotetypeConfig (.css, .kind, .sort_field_idx,
// .original_stock_kind ...), NoteFieldConfig, CardTemplateConfig, all_stock_notetypes, CardTemplate, NoteField
```

Clone stock Basic/Cloze + `Fonte` (idempotent "Preparar coleção"):

```rust
use anki::notetype::{all_stock_notetypes, NoteField, CardTemplate, Notetype};
fn ensure_type(col: &mut Collection, name: &str, mut nt: Notetype) -> Result<NotetypeId> {
    if let Some(existing) = col.get_notetype_by_name(name)? { return Ok(existing.id); } // never modify
    nt.id = NotetypeId(0);            // REQUIRED: storage `assert_eq!`s id == 0 => PANIC, not Err (storage/notetype/mod.rs:248)
    nt.name = name.into();
    col.add_notetype(&mut nt, false)?;  // assigns nt.id
    Ok(nt.id)
}
let stock = all_stock_notetypes(&I18n::template_only()); // English field names "Front"/"Back"/"Text"/"Back Extra"
let mut basic = stock[0].clone();                    // or localized: all_stock_notetypes(col.tr())
basic.fields.push(NoteField::new("Fonte"));
basic.templates[0].config.a_format.push_str("\n{{#Fonte}}<div class=fonte>{{Fonte}}</div>{{/Fonte}}");
ensure_type(&mut col, "Básico (Leitor)", basic)?;
let mut cloze = stock[4].clone();                    // keeps NotetypeKind::Cloze + cloze CSS + field tags
cloze.fields.push(NoteField::new("Fonte"));
ensure_type(&mut col, "Cloze (Leitor)", cloze)?;
// Code/vocab types: start from Notetype::default() (normal kind + default CSS), push fields/templates:
let mut cmd = Notetype::default();
for f in ["Pergunta","Resposta","Aceitas","Exige","Observação","Fonte"] { cmd.fields.push(NoteField::new(f)); }
cmd.templates.push(CardTemplate::new("Card 1", "{{Pergunta}}\n\n{{type:Resposta}}",
  "{{FrontSide}}<hr id=answer>{{#Observação}}<blockquote>{{Observação}}</blockquote>{{/Observação}}{{Fonte}}"));
cmd.config.css.push_str(".fonte{font-size:.8em}");
```

Gotchas:
- `add_notetype` with a duplicate name silently appends `+` (`ensure_notetype_name_unique`,
  mod.rs:721) ⇒ always look up by name first.
- Name may not contain `"` (stripped); needs ≥1 field and ≥1 template (`prepare_for_update`, :479).
- Adding a **new** notetype does not touch the schema. `update_notetype` that adds/removes/reorders
  fields or templates, or changes the sort field, calls `set_schema_modified()` **without asking**
  (`notetype/schemachange.rs:79,102,136`) ⇒ next sync = full sync. So does `remove_notetype` (:800).
  Editing only `q_format`/`a_format`/`css`/names is safe. The desktop asks first (`mod_schema`); we must too.
- Stock notetype names/field names depend on the `I18n` passed (English values from
  `ftl/core/notetypes.ftl`: Basic, Cloze, Front, Back, Text, Back Extra).
- `add_notetype` also sets the collection's *current notetype* to the new one (`add_notetype_inner`,
  mod.rs:742-753).
- Cloning a stock type keeps `config.original_stock_kind` (Basic/Cloze); cloze field `config.tag`
  and `prevent_deletion` on "Text" are kept too (`stock.rs` `cloze()`).
- Cloze notetypes: `get_template` always returns template 0.

---

## 7. Notes

```rust
// notes/mod.rs
pub struct Note { pub id: NoteId, pub guid: String, pub notetype_id: NotetypeId,
    pub mtime: TimestampSecs, pub usn: Usn, pub tags: Vec<String>, /* fields private */ } // :42
impl Note {
    pub fn new(notetype: &Notetype) -> Self                                          // :143
    pub fn fields(&self) -> &Vec<String>                                             // :55
    pub fn into_fields(self) -> Vec<String>                                          // :59
    pub fn set_field(&mut self, idx: usize, text: impl Into<String>) -> Result<()>  // :63
    pub fn fields_mut(&mut self) -> &mut Vec<String>                                 // :182
}
pub struct AddNoteRequest { pub note: Note, pub deck_id: DeckId }                    // :74
pub fn add_note(&mut self, note: &mut Note, did: DeckId) -> Result<OpOutput<usize>>  // :91 output = cards generated
pub fn add_notes(&mut self, requests: &mut [AddNoteRequest]) -> Result<OpOutput<()>> // :95 one undo step
pub fn remove_notes(&mut self, nids: &[NoteId]) -> Result<OpOutput<usize>>           // :106
pub fn update_note(&mut self, note: &mut Note) -> Result<OpOutput<()>>               // :395 no-op if unchanged
pub fn note_fields_check(&mut self, note: &Note) -> Result<NoteFieldsState>          // :606 (empty/dupe/cloze checks)
// Collection has NO inherent get_note; use storage (pub method on pub-in-private type):
col.storage.get_note(nid)?          // storage/note/mod.rs:27 -> Result<Option<Note>>
col.storage.get_card(cid)?          // storage/card/mod.rs:123 -> Result<Option<Card>>
// or the trait: anki::services::NotesService::get_note(&mut col, anki_proto::notes::NoteId{nid})
```

- Fields are HTML. `add_note` canonifies tags, normalizes text (config `NormalizeNoteText`), sets
  last deck/notetype. Tags with `::` are hierarchical (`livro::slug`, `cap::3`).
- Vocab deck generation (12.6): build `Vec<AddNoteRequest>` and call `add_notes` once (one undo
  step, one transaction), then `sort_cards` for ordering.
- Pasted images: `col.media()?.add_file(desired_name, &bytes)? -> Cow<str>` (`media/mod.rs:66`)
  returns the final (possibly renamed) filename to embed in `<img src=...>`.

---

## 8. Search and browser table

```rust
// search/mod.rs
pub enum SortMode { NoOrder, Builtin { column: Column, reverse: bool }, Custom(String) } // :41
pub trait TryIntoSearch  // impl for &str, &String, and anything Into<Node> (SearchNode, NoteId...) :106
pub fn search_cards<N: TryIntoSearch>(&mut self, search: N, mode: SortMode) -> Result<Vec<CardId>> // :158
pub fn search_notes<N: TryIntoSearch>(&mut self, search: N, mode: SortMode) -> Result<Vec<NoteId>> // :165
pub fn search_notes_unordered<N: TryIntoSearch>(&mut self, search: N) -> Result<Vec<NoteId>>       // :172
pub use parser::{parse as parse_search, Node, SearchNode, StateKind, ...}; pub use builder::{SearchBuilder, JoinSearches, Negated};
// search/parser.rs:70 SearchNode::{SingleField{field,text,mode}, Deck(String), DeckIdWithChildren(DeckId),
//   Tag{tag,mode}, State(StateKind), Flag(u8), NoteIds(String), CardIds(String), WholeCollection, ...}
// search/builder.rs helpers: SearchNode::from_deck_id(did, with_children), from_deck_name, from_tag_name,
//   from_notetype_name, from_note_ids, from_card_ids
// browser_table.rs
pub enum Column { Custom, Answer, CardMod, Cards="template", Deck, Due="cardDue", Ease="cardEase",
  Lapses="cardLapses", Interval="cardIvl", NoteCreation="noteCrt", NoteMod, Notetype="note",
  OriginalPosition, Question, Reps="cardReps", SortField="noteFld", Tags="noteTags",
  Stability, Difficulty, Retrievability }    // :27, strum camelCase names in quotes
pub fn all_browser_columns(&self) -> anki_proto::search::BrowserColumns            // :267
pub fn browser_row_for_id(&mut self, id: i64) -> Result<anki_proto::search::BrowserRow> // :276
```

```rust
let cids = col.search_cards("deck:\"ROS 2::Livro ROS 2 Basics\" is:due", SortMode::NoOrder)?;
// browser rows: active columns must be set first, only possible via the trait:
use anki::services::SearchService;
SearchService::set_active_browser_columns(&mut col,
    anki_proto::generic::StringList { vals: vec!["noteFld".into(), "template".into(), "cardDue".into(), "deck".into()] })?;
let row = col.browser_row_for_id(cid.0)?;   // cells[i].text, color (marked/suspended/flag/buried)
```

- `browser_row_for_id` errors "Active browser columns not set." otherwise. Cards vs notes mode is
  the config bool `BrowserTableShowNotesMode` (ids must match the mode).
- Search text uses Anki syntax; `*` and `_` are wildcards, escape with `\`. The escape helpers
  (`text.rs:512 escape_anki_wildcards`) are `pub(crate)` — reimplement (`[\\*_]` → `\$0`).
  For "cards of this page" (10.1) prefer a `SearchNode::SingleField { field: "Fonte".into(),
  text: format!("*{escaped_link}*"), mode: FieldSearchMode::Normal }` over string building.

---

## 9. Import / export / backup / media

```rust
// import_export/package/apkg/import/mod.rs
pub fn import_apkg(&mut self, path: impl AsRef<Path>, options: ImportAnkiPackageOptions)
    -> Result<OpOutput<NoteLog>>                                                     // :52 (Op::Import, undoable)
// import_export/package/apkg/export.rs
/// Returns number of exported notes.
pub fn export_apkg(&mut self, out_path: impl AsRef<Path>, options: ExportAnkiPackageOptions,
    search: impl TryIntoSearch, media_fn: Option<Box<dyn FnOnce(HashSet<String>) -> MediaIter>>)
    -> Result<usize>                                                                 // :25
// import_export/package/colpkg/export.rs
pub fn export_colpkg(self, out_path: impl AsRef<Path>, include_media: bool, legacy: bool) -> Result<()> // :46 CONSUMES self
// import_export/package/colpkg/import.rs (free fn; collection must be CLOSED)
pub fn import_colpkg(colpkg_path: &str, target_col_path: &str, target_media_folder: &Path,
    media_db: &Path, progress: ThrottlingProgressHandler<ImportProgress>) -> Result<()> // :31
// collection/backup.rs
pub fn maybe_backup(&mut self, backup_folder: impl AsRef<Path> + Send + 'static, force: bool)
    -> Result<Option<JoinHandle<Result<()>>>>                                         // :28
```

Paths: `anki::import_export::package::{import_colpkg, ImportAnkiPackageOptions,
ExportAnkiPackageOptions, UpdateCondition, MediaIter}`, `anki::import_export::NoteLog`
(= `anki_proto::import_export::import_response::Log`).
Options (`proto/anki/import_export.proto:56,96`): `ImportAnkiPackageOptions { merge_notetypes,
update_notes, update_notetypes, with_scheduling, with_deck_configs }`,
`ExportAnkiPackageOptions { with_scheduling, with_deck_configs, with_media, legacy }`.

```rust
// export one deck (+children) as .apkg
col.export_apkg(&out, ExportAnkiPackageOptions { with_scheduling: true, with_deck_configs: true,
    with_media: true, legacy: false }, SearchNode::from_deck_id(did, true), None)?;

// full .colpkg backup with media: consumes the collection, reopen afterwards
let mut builder = col.as_builder();
let res = col.export_colpkg(&backup_path, true, false);   // col is closed even on Err
let col = builder.build()?;                               // reopen first...
res?;                                                     // ...then propagate

// restore/import .colpkg (spec 8.5): close, import, reopen
let mut builder = col.as_builder(); col.close(None)?;
anki::import_export::package::import_colpkg(src, col_path, media_dir, media_db, Default::default())?;
let col = builder.build()?;
```

Gotchas:
- `ThrottlingProgressHandler` is unnameable (private `mod progress`) and its constructor is
  `pub(crate)`, but it `#[derive(Default)]` (`progress.rs:34`), so `Default::default()` works by
  inference (no progress reporting). With an open collection, `col.new_progress_handler()`
  (`progress.rs:339`, pub) also works and reports into the shared `ProgressState`.
- `import_colpkg` marks the imported schema as modified (`check_collection_and_mod_schema`) ⇒ next
  sync is a full sync (consistent with spec 9 "first sync = download").
- `export_colpkg` closes the collection **before** writing (`close(Some(V18))`, or V11 if
  `legacy`), so on `Err` the collection is already gone: never use `?` between `as_builder()` and
  `build()`; capture the result, rebuild, then propagate.
- `maybe_backup`: the backup folder must already exist (`read_dir` in thinning / recent check errors
  otherwise, `backup.rs:66,102`).
- `maybe_backup` = desktop periodic backups: **collection only, no media**
  (`export_colpkg_from_data` uses `MediaIter::empty()`), does not close the collection, writes
  `backup-%Y-%m-%d-%H.%M.%S.colpkg`, thins using the collection's `BackupLimits`, runs on a thread;
  returns `None` if nothing changed since the last backup **of this session** (even with
  `force=true`). Good for "before full sync / before .colpkg import". Spec's "daily .colpkg with
  media, keep 7" needs `export_colpkg(.., include_media=true, ..)` + our own rotation.
- `import_apkg` sets several import-option config keys as side effect.

---

## 10. "Studied today" (spec 8.2 footer)

```rust
// stats/today.rs (module private; method is on Collection so it's callable)
pub fn studied_today(&mut self) -> Result<String>        // :24 localized sentence only
// scheduler/mod.rs
pub fn timing_today(&mut self) -> Result<SchedTimingToday> // :50 { now, days_elapsed, next_day_at }
```

The numeric version (`storage.studied_today`, `storage/revlog/mod.rs:182`) is `pub(crate)`. Reproduce
it with the escape hatch:

```rust
let t = col.timing_today()?;
let start_ms = (t.next_day_at.0 - 86_400) * 1000;
let (cards, secs): (u32, f64) = col.storage.db().query_row(
    "SELECT COUNT(), coalesce(sum(time)/1000.0, 0.0) FROM revlog WHERE id > ? AND type != 4 AND type != 5",
    [start_ms], |r| Ok((r.get(0)?, r.get(1)?)))?;   // 4 = Manual, 5 = Rescheduled (revlog/mod.rs:65)
```

Alternatively `SchedulerService::studied_today_message(StudiedTodayMessageRequest{cards, seconds})`
for the localized sentence from your numbers.

---

## 11. Sync (spec 9)

```rust
// sync/login.rs
#[derive(Clone, Default)]
pub struct SyncAuth { pub hkey: String, pub endpoint: Option<Url>, pub io_timeout_secs: Option<u32> } // :15
pub async fn sync_login<S: Into<String>>(username: S, password: S, endpoint: Option<String>,
    client: Client) -> Result<SyncAuth>                                              // :34
// sync/collection/normal.rs
pub enum SyncActionRequired { NoChanges, FullSyncRequired { upload_ok: bool, download_ok: bool },
    NormalSyncRequired }                                                             // :38
pub struct SyncOutput { pub required: SyncActionRequired, pub server_message: String,
    pub host_number: u32, pub new_endpoint: Option<String>,
    pub(crate) server_media_usn: Usn }                                              // :147
pub async fn normal_sync(&mut self, auth: SyncAuth, client: Client) -> error::Result<SyncOutput> // :169
// sync/collection/upload.rs, download.rs — CONSUME self; "Caller must re-open afterwards."
pub async fn full_upload(self, auth: SyncAuth, client: Client) -> Result<()>      // upload.rs:36
pub async fn full_download(self, auth: SyncAuth, client: Client) -> Result<()>    // download.rs:21
// sync/collection/status.rs
pub fn sync_status_offline(&mut self) -> Result<sync_status_response::Required>   // :16 (NoChanges/NormalSync/FullSync)
pub async fn online_sync_status_check(local: SyncMeta, server: &mut HttpSyncClient)
    -> Result<ClientSyncState, AnkiError>                                            // :42
// media/mod.rs
pub fn media(&self) -> Result<MediaManager>                                         // :33 (on Collection)
pub async fn sync_media(self, progress: ThrottlingProgressHandler<MediaSyncProgress>,
    auth: SyncAuth, client: Client, server_usn: Option<Usn>) -> Result<()>            // :145 (on MediaManager)
// sync/http_client/mod.rs
pub fn new(auth: SyncAuth, client: Client) -> HttpSyncClient                        // :37 default https://sync.ankiweb.net/
```

`Client`/`Url` are `reqwest::{Client, Url}` (reqwest **0.12**, not re-exported by `anki`) ⇒ add
`reqwest = { version = "0.12", default-features = false }` to `core-anki` so it unifies. TLS comes
from the `anki` feature `rustls` (already enabled in our workspace). Upstream builds the client with
`Client::builder().http1_only().build()` (`backend/mod.rs:177-183`, "nginx doesn't support http2 proxies").
A custom root certificate (self-hosted server with private CA) is done upstream with
`Client::builder().use_rustls_tls().add_root_certificate(cert).http1_only()` (`backend/mod.rs:162-167`).

**Custom endpoint (self-hosted server):** `SyncAuth.endpoint`. Requests go to
`endpoint.join("sync/")…` and `endpoint.join("msync/")…` (`sync/collection/protocol.rs:56`,
`sync/media/protocol.rs:39`), so the URL **must end with `/`** (`https://anki.example.com/`). The
backend normalizes with `Url::try_from(s).and_then(|x| x.join("./"))` in
`TryFrom<anki_proto::sync::SyncAuth> for SyncAuth` (`backend/sync.rs:76`) — that impl is usable
from outside, so you can avoid touching `Url`. **Careful:** `join("./")` does *not* add a trailing
slash, it drops the last path segment: `https://h/anki` → `https://h/`, while `https://h/anki/` is
kept. So the user-entered URL must end with `/` if it has a path; append it yourself before converting.

```rust
let auth = SyncAuth::try_from(anki_proto::sync::SyncAuth {
    hkey, endpoint: Some("https://anki.example.com/".into()), io_timeout_secs: None })?;
```

- `sync_login` returns `SyncAuth { hkey, endpoint: None, .. }` (`login.rs:56`) — **you must set
  the endpoint again** before using it (the backend copies `input.endpoint` back, `backend/sync.rs:303`).
- Persist `out.new_endpoint` when present (desktop: `pm.set_current_sync_url`, `qt/aqt/sync.py:56,117`;
  effective endpoint = current (redirect) URL, else custom URL).
- Show `out.server_message` if non-empty.
- Mapping to the proto `ChangesRequired` the desktop dialog uses (`backend/sync.rs:43-73`):
  `FullSyncRequired{upload_ok:false,..}` ⇒ FULL_DOWNLOAD only (local empty);
  `{download_ok:false}` ⇒ FULL_UPLOAD only (remote empty); both true ⇒ FULL_SYNC (ask the user,
  spec 9: never auto-upload). `NormalSyncRequired` never comes back from `normal_sync` (it performs it).
- `server_media_usn` is `pub(crate)` on `SyncOutput`, but the public
  `impl From<SyncOutput> for anki_proto::sync::SyncCollectionResponse` (`backend/sync.rs:42-73`)
  exposes it: `let resp: SyncCollectionResponse = out.into(); let usn = Some(Usn(resp.server_media_usn));`
  (that is what upstream passes, `backend/sync.rs:386-389`; `resp.required` is then the proto
  `ChangesRequired` i32). Passing `None` also works (one extra request). Upstream skips media sync when
  the result is `FullSyncRequired`.
- `MediaManager::new(media_folder, media_db) -> Result<MediaManager>` (`media/mod.rs:44`) is `pub`,
  so media sync does not even need the `Collection` once you know the paths.
- Media sync uses its own DB handle (`MediaManager`) and does not borrow the collection: build it
  with `col.media()?` + `col.new_progress_handler()` on the actor thread, then run it on another
  thread/runtime. Upstream aborts media sync before full sync / colpkg export
  (`abort_media_sync_and_wait`) — do the same.
- Full sync flow (copy of `backend/sync.rs:399-447`): `let mut b = col.as_builder();`
  `rt.block_on(col.full_download(auth, client))` → always `b.build()` again, even on error; then
  media sync. Desktop backs up before download (`qt/aqt/sync.py:249 create_backup_now`).
- Normal sync failure with `SyncErrorKind::SanityCheckFailed` ⇒ rslib itself marks the schema
  modified (next sync full). Errors: `AnkiError::SyncError { source: SyncError { kind, .. } }`,
  `SyncErrorKind::{AuthFailed, ServerMessage, ClockIncorrect, UploadTooLarge, ResyncRequired, ...}`
  (`error/network.rs:35`).
- All of these are `async`; on the actor thread use a current-thread tokio runtime + `block_on`
  (the collection is blocked for the duration of a normal sync, same as upstream). Abort via the
  shared `ProgressState.want_abort` (section 1) or by dropping the future (upstream wraps in
  `Abortable` and calls `storage.rollback_trx()` on abort, `backend/sync.rs:373`).

---

## 12. `Collection::run_service_method` and the name → (service, method) table

**Exists at 26.09.3.** Generated into `OUT_DIR/backend.rs` by `rslib/rust_interface.rs`
(included from `services.rs:9`). Signature (`rust_interface.rs:134-160`):

```rust
impl crate::collection::Collection {
    pub fn run_service_method(&mut self, service: u32, method: u32, input: &[u8])
        -> Result<Vec<u8>, Vec<u8>>
}
```

- `Ok` = encoded output message (empty `Vec` when the output is `generic.Empty`).
- `Err` = encoded `anki_proto::backend::BackendError` (`err.into_protobuf(&self.tr)`; fields include
  the localized `message` and `kind`). Unknown index ⇒ `AnkiError::InvalidServiceIndex` /
  `InvalidMethodIndex`. Upstream HTTP behaviour: 500 with the message as text body; the TS code
  treats `"500: Interrupted"` specially (`ts/lib/generated/post.ts`).
- `Backend::run_service_method(&self, ...)` also exists with **different** (backend) indices — don't
  mix them.

How indices are produced (`rslib/proto_gen/src/lib.rs:45-133`, `anki_proto_gen::get_services`):
- Pool services are split: names starting with `Backend` → `BackendService`, others →
  `CollectionService`. `CollectionService.index = service.index()` (index in the
  `DescriptorPool`), `Method.index = method.index()` (index within its service),
  `Method.name = method.name().to_snake_case()`.
- `Collection::run_service_method` matches on **collection** service indices and **collection**
  method indices; `FrontendService` is excluded (`rust_interface.rs:24`) — calling its index gives
  `InvalidServiceIndex`.
- Methods declared only in `Backend*Service` are **not reachable through `Collection`**. Of
  desktop's `exposed_backend_list` (`qt/aqt/mediasrv.py:1167`) only **`add_media_from_url`** is
  backend-only (checked by script against `proto/anki/*.proto`); everything else, including
  `latestProgress`, `setWantsAbort`, `i18nResources`, is in a collection service. No method name is
  duplicated across collection services (**205** RPCs in the 18 collection services excluding
  `FrontendService`; 269 `rpc` lines in total incl. `Backend*` and Frontend — re-counted from
  `proto/anki/*.proto`).
- The web pages call `POST /_anki/<camelCase>` where camelCase = `method.name.to_camel_case()`
  (`rslib/proto/typescript.rs:117`; desktop: `stringcase.camelcase(snake)`, `mediasrv.py:1274`).
  They also send header `Anki-Op-Changes: 0..3`; desktop decodes the response as
  `OpChanges`/`OpChangesOnly`/`NestedOpChanges` to refresh its UI (`mediasrv.py:1249-1265`) — we
  can use it to emit a "collection changed" event.
- `getSchedulingStatesWithContext` / `setSchedulingStates` (card protocol whitelist) are declared in
  `FrontendService` (`proto/anki/frontend.proto`), which rslib does not implement, i.e. **not**
  backend methods: they are Python `post_handlers` returning the reviewer's held
  `SchedulingStatesWithContext` (`mediasrv.py:714-725`). Implement them in `core-anki` from the
  current `QueuedCard` (`states` + `context`).

### build.rs recipe

```toml
# crates/core-anki/Cargo.toml
[build-dependencies]
anki_proto = { git = "https://github.com/ankitects/anki", tag = "26.09.3" } # forces descriptors to be written first
anki_proto_gen = { git = "https://github.com/ankitects/anki", tag = "26.09.3" }
prost-reflect = "0.14"
inflections = "1.1"
anyhow = "1"
```

```rust
// crates/core-anki/build.rs
use inflections::Inflect;
fn main() -> anyhow::Result<()> {
    let path = anki_proto_gen::descriptors_path(); // $DESCRIPTORS_BIN or $OUT_DIR/../../anki_descriptors.bin
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-env-changed=DESCRIPTORS_BIN");
    let pool = prost_reflect::DescriptorPool::decode(std::fs::read(&path)?.as_ref())?;
    let (col_services, _backend) = anki_proto_gen::get_services(&pool);
    let mut out = String::from("pub static ANKI_METHODS: &[(&str, u32, u32)] = &[\n");
    for s in col_services.iter().filter(|s| s.name != "FrontendService") {
        for m in &s.trait_methods {
            out += &format!("  ({:?}, {}, {}),\n", m.name.to_camel_case(), s.index, m.index);
        }
    }
    out += "];\n";
    std::fs::write(std::path::Path::new(&std::env::var("OUT_DIR")?).join("anki_methods.rs"), out)?;
    Ok(())
}
```

`descriptors_path()` (`proto_gen/src/lib.rs:278`): `DESCRIPTORS_BIN` env, else
`OUT_DIR/../../anki_descriptors.bin` — i.e. `target/<profile>/build/anki_descriptors.bin`, written
by `anki_proto`'s build script (`rslib/proto/rust.rs:61`). Anki's own repo sets `DESCRIPTORS_BIN`
in its `.cargo/config.toml`, which is **not** applied to git dependencies. Recommended: set
`DESCRIPTORS_BIN` (absolute, `relative = true`) in `src-tauri/.cargo/config.toml` so `anki_proto`
(host and target copies), rslib's build script and ours all use one file — this also avoids the
host/target `OUT_DIR` mismatch when cross-compiling for iOS. Also `PROTOC` must point to protoc
(`rust.rs:97`, our workspace notes protoc 31.1).

Add a test: open an in-memory collection (`CollectionBuilder::default().build()`), call
`run_service_method` for `getDeckNames` and `i18nResources` via the table, decode the outputs.

---

## 13. Recommendations

1. **Actor owns `Collection`**; use typed Rust APIs for our own screens (decks, study, notes,
   search, import/export, sync) and `run_service_method` only for the SvelteKit pages.
2. **Study**: `set_current_deck` → `get_queued_cards(1,false)` → `render_existing_card(cid,false,false)`
   → `extract_av_tags` per side → `describe_next_states` → `answer_card(from_queue:true)`. Keep the
   current top card as `anki_proto::scheduler::queued_cards::QueuedCard` (nameable) if it must live
   in a struct; convert `states` back with `SchedulingStates::from(proto)`.
3. **Undo**: gate Ctrl+Z with `can_undo() == Some(&Op::AnswerCard)`.
4. **Preparar coleção**: lookup-by-name then `add_notetype` with `id = 0`; never `update_notetype`
   with field/template changes on existing types without an explicit full-sync warning.
5. **Backups**: `maybe_backup(dir, true)` before full sync / colpkg import (fast, no media);
   `export_colpkg` + reopen for the daily media backup.
6. **Sync**: store `{hkey, endpoint, new_endpoint}`; always rebuild `SyncAuth` via the proto
   `TryFrom` (validates URL; make sure it ends with `/` first); run media sync off the actor thread.
7. Prefer the generated service traits (UFCS) whenever an inherent API is `pub(crate)` or missing
   (`compare_answer`, `set_active_browser_columns`, `get_note`, `counts_for_deck_today`, `congrats_info`).

## 14. Risks / unverified

- Not compiled here: the generated `backend.rs` was read from its generator, not from `OUT_DIR`.
  `prost_reflect` `index()` semantics were not read locally — irrelevant as long as we use the same
  `anki_proto_gen::get_services` on the same descriptor file (identical to rslib).
- Translations (`ftl/core-repo` submodule) were not present in `/tmp/anki-ref`; pt-BR labels
  assumed to work via cargo's submodule fetch.
- Several result types are unnameable (`QueuedCards`, `RenderCardOutput`, `ProgressState`,
  `ThrottlingProgressHandler`, `SqliteStorage`); design wrappers around closures/proto conversions.
- `update_notetype`/`remove_notetype`/colpkg import/sanity-check failures mark the schema modified
  silently ⇒ unexpected full syncs if misused.
