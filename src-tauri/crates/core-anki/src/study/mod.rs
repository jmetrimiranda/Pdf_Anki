//! Studying (spec 8.2 "Estudar", 8.4, 10.1): a port of the desktop reviewer on top of the [`AnkiService`] actor.
//!
//! [`Study`] keeps one session (the deck being studied, the card on screen and its owner: the Anki tab or the book
//! panel's mini-review — only one place studies at a time). The card HTML is produced exactly
//! like `qt/aqt/reviewer.py` (partial render + `{{FrontSide}}` after AV extraction, LaTeX images, play buttons,
//! type-in-the-answer filters) and shown by `reviewer.js` inside the sandboxed card iframe; the interval labels come
//! from rslib's `describe_next_states`, the same function the desktop uses.
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use frontend::{SchedulingStatesWithContext, SetSchedulingStatesRequest};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::service::AnkiService;

pub mod av;
pub mod frontend;
pub mod render;
mod session;
pub mod source;
pub mod typeans;
pub mod types;

pub use session::MARKED_TAG;
use session::{Session, StudyEnv};
pub use types::*;

/// Where a study session is shown (spec 10.1: only one place studies at a time).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum StudyOwner {
    /// The Anki tab's study screen.
    Tab,
    /// The "Revisar aqui" mini-review of the book panel.
    Panel,
}

/// Result of [`Study::start`]: the top of the queue and the place that lost the session, if any.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyStart {
    pub next: StudyNext,
    /// The other owner whose session was replaced (the UI shows a notice there).
    pub preempted: Option<StudyOwner>,
}

/// Result of [`Study::mini_review_open`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniReviewOpened {
    /// The deck that was current before the mini-review (restored on close).
    pub previous_deck_id: i64,
    pub preempted: Option<StudyOwner>,
    pub next: StudyNext,
}

/// Result of [`Study::mini_review_close`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniReviewClosed {
    /// The deck made current again, or `None` when nothing was restored.
    pub restored_deck_id: Option<i64>,
}

/// State shared by every clone of [`Study`].
#[derive(Default)]
struct State {
    session: Option<Session>,
    /// Current deck before the mini-review opened (spec 10.1 "remember → switch → restore").
    mini_previous: Option<i64>,
}

/// The study session. Cheap to clone; every clone shares the session.
#[derive(Clone)]
pub struct Study {
    service: AnkiService,
    state: Shared,
}

type Shared = Arc<Mutex<State>>;

fn lock(s: &Shared) -> MutexGuard<'_, State> {
    s.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Errors decided here (wrong card, nothing to undo…) keep the card on screen; any other failed collection
/// operation makes rslib drop its queues (and the undo stack), so the card on screen is no longer valid.
fn invalidates_card(e: &crate::Error) -> bool {
    !matches!(
        e,
        crate::Error::UndoUnavailable
            | crate::Error::NotCurrentCard
            | crate::Error::NoStudySession
            | crate::Error::InvalidInput(_)
    )
}

/// Starts (or continues) a session for `owner` on the actor: another owner's session is replaced.
fn start_on_actor(
    col: &mut anki::collection::Collection,
    state: &mut State,
    env: &StudyEnv,
    deck_id: i64,
    owner: StudyOwner,
) -> Result<StudyStart> {
    // An unknown deck leaves the current session (and its owner) alone.
    if col.get_deck(anki::prelude::DeckId(deck_id))?.is_none() {
        return Err(crate::Error::NotFound(format!("baralho {deck_id}")));
    }
    let preempted = match state.session.as_mut() {
        Some(s) if s.owner == owner => {
            s.deck_id = deck_id;
            None
        }
        Some(s) => {
            let old = s.owner;
            state.session = Some(Session::new(deck_id, owner));
            Some(old)
        }
        None => {
            state.session = Some(Session::new(deck_id, owner));
            None
        }
    };
    let Some(session) = state.session.as_mut() else {
        return Err(crate::Error::NoStudySession);
    };
    match session::next(col, session, env) {
        Ok(next) => Ok(StudyStart { next, preempted }),
        Err(e) => {
            if invalidates_card(&e) {
                session.current = None;
            }
            Err(e)
        }
    }
}

impl Study {
    pub fn new(service: AnkiService) -> Self {
        Self {
            service,
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    /// Runs `f` with the shared state on the actor thread.
    async fn with_state<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut anki::collection::Collection, &mut State, &StudyEnv) -> Result<R>
            + Send
            + 'static,
    {
        let shared = Arc::clone(&self.state);
        let media = self.service.paths().media_folder.clone();
        let roles = self.service.code_roles_cell();
        self.service
            .call(move |col| {
                let env = StudyEnv {
                    media,
                    code_roles: roles.snapshot(),
                };
                let mut guard = lock(&shared);
                f(col, &mut guard, &env)
            })
            .await
    }

    /// Runs `f` with the existing session on the actor thread.
    async fn with_session<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut anki::collection::Collection, &mut Session, &StudyEnv) -> Result<R>
            + Send
            + 'static,
    {
        self.with_state(move |col, state, env| {
            let Some(session) = state.session.as_mut() else {
                return Err(crate::Error::NoStudySession);
            };
            let res = f(col, session, env);
            if let Err(e) = &res
                && invalidates_card(e)
            {
                session.current = None;
            }
            res
        })
        .await
    }

    /// Starts (or continues) studying `deck_id` in `owner` and returns the top of its queue. A session held by the
    /// other owner is replaced (`preempted`); the same owner just switches deck.
    pub async fn start(&self, deck_id: i64, owner: StudyOwner) -> Result<StudyStart> {
        self.with_state(move |col, state, env| start_on_actor(col, state, env, deck_id, owner))
            .await
    }

    /// Starts (or continues) studying `deck_id` in the Anki tab and returns the top of its queue.
    pub async fn next(&self, deck_id: i64) -> Result<StudyNext> {
        Ok(self.start(deck_id, StudyOwner::Tab).await?.next)
    }

    /// Who holds the session, if any.
    pub fn owner(&self) -> Option<StudyOwner> {
        lock(&self.state).session.as_ref().map(|s| s.owner)
    }

    /// Closes the session only if `owner` holds it (a preempted place leaving must not end the other's session).
    pub fn close_owner(&self, owner: StudyOwner) -> bool {
        let mut state = lock(&self.state);
        if state.session.as_ref().is_some_and(|s| s.owner == owner) {
            state.session = None;
            true
        } else {
            false
        }
    }

    /// "Revisar aqui" (spec 10.1): remembers the current deck (only when no mini-review is open yet, so switching
    /// between the book's decks keeps the original one), then studies `deck_id` in the panel.
    pub async fn mini_review_open(&self, deck_id: i64) -> Result<MiniReviewOpened> {
        self.with_state(move |col, state, env| {
            let panel_owns = state
                .session
                .as_ref()
                .is_some_and(|s| s.owner == StudyOwner::Panel);
            let previous = match state.mini_previous {
                Some(previous) if panel_owns => previous,
                _ => col.get_current_deck()?.id.0,
            };
            let started = start_on_actor(col, state, env, deck_id, StudyOwner::Panel)?;
            state.mini_previous = Some(previous);
            Ok(MiniReviewOpened {
                previous_deck_id: previous,
                preempted: started.preempted,
                next: started.next,
            })
        })
        .await
    }

    /// Closes the mini-review. While the panel still holds the session it is closed and the remembered deck is made
    /// current again (when it still exists and differs from the current one). When the Anki tab took the session
    /// over, nothing is restored: the tab's deck choice wins. The remembered deck is always forgotten.
    pub async fn mini_review_close(&self) -> Result<MiniReviewClosed> {
        self.with_state(|col, state, _| {
            let previous = state.mini_previous.take();
            if !state
                .session
                .as_ref()
                .is_some_and(|s| s.owner == StudyOwner::Panel)
            {
                return Ok(MiniReviewClosed {
                    restored_deck_id: None,
                });
            }
            state.session = None;
            let Some(previous) = previous else {
                return Ok(MiniReviewClosed {
                    restored_deck_id: None,
                });
            };
            let did = anki::prelude::DeckId(previous);
            if col.get_deck(did)?.is_none() || col.get_current_deck()?.id == did {
                return Ok(MiniReviewClosed {
                    restored_deck_id: None,
                });
            }
            col.set_current_deck(did)?;
            Ok(MiniReviewClosed {
                restored_deck_id: Some(previous),
            })
        })
        .await
    }

    /// The answer side of the card on screen. `typed` is the text of `#typeans` (`None` = "").
    pub async fn show_answer(&self, card_id: i64, typed: Option<String>) -> Result<AnswerSide> {
        self.with_session(move |col, s, _| session::show_answer(col, s, card_id, typed.as_deref()))
            .await
    }

    /// Answers the card on screen (`rating` 1..=4: De novo, Difícil, Bom, Fácil) after `ms` milliseconds.
    pub async fn answer(&self, card_id: i64, rating: u8, ms: u32) -> Result<StudyNext> {
        self.with_session(move |col, s, env| session::answer(col, s, env, card_id, rating, ms))
            .await
    }

    /// Undoes the last answer (only when the last operation is an answer) and shows that card again.
    pub async fn undo(&self) -> Result<StudyNext> {
        self.with_session(session::undo).await
    }

    /// Bury/suspend (card or note) move on to the next card; flag (toggle) and mark keep the card on screen.
    pub async fn card_action(
        &self,
        card_id: i64,
        action: CardAction,
        flag: Option<u8>,
    ) -> Result<CardActionResult> {
        self.with_session(move |col, s, env| {
            session::card_action(col, s, env, card_id, action, flag)
        })
        .await
    }

    /// Closes whatever session exists (both owners).
    pub fn close(&self) {
        lock(&self.state).session = None;
    }

    /// Forgets the session, its owner and the mini-review's remembered deck (collection replaced, imports…).
    pub fn reset(&self) {
        let mut state = lock(&self.state);
        state.session = None;
        state.mini_previous = None;
    }

    /// `getSchedulingStatesWithContext` for the card on screen (custom scheduling JS, via the card protocol).
    pub fn states_with_context(&self) -> Option<SchedulingStatesWithContext> {
        let guard = lock(&self.state);
        let current = guard.session.as_ref()?.current.as_ref()?;
        Some(SchedulingStatesWithContext {
            states: Some(current.states.clone()),
            context: Some(current.context.clone()),
        })
    }

    /// `setSchedulingStates`: replaces the states the next answer uses. False when the key is wrong or no card is on
    /// screen (`reviewer.py` `set_scheduling_states` ignores a wrong key the same way). The key is renewed for every
    /// card, so a late request from a previous card's custom JS is ignored.
    pub fn set_states(&self, req: SetSchedulingStatesRequest) -> bool {
        let mut guard = lock(&self.state);
        let Some(session) = guard.session.as_mut() else {
            return false;
        };
        if req.key != session.key {
            return false;
        }
        match (session.current.as_mut(), req.states) {
            (Some(current), Some(states)) => {
                current.states = states;
                true
            }
            _ => false,
        }
    }

    /// The `setSchedulingStates` key of the card on screen (tests and the bridge's recordings).
    pub fn session_key(&self) -> Option<String> {
        lock(&self.state).session.as_ref().map(|s| s.key.clone())
    }
}
