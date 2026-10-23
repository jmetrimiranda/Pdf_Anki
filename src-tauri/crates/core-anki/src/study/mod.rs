//! Studying (spec 8.2 "Estudar", 8.4, 10.1): a port of the desktop reviewer on top of the [`AnkiService`] actor.
//!
//! [`Study`] keeps one session (the deck being studied and the card on screen). The card HTML is produced exactly
//! like `qt/aqt/reviewer.py` (partial render + `{{FrontSide}}` after AV extraction, LaTeX images, play buttons,
//! type-in-the-answer filters) and shown by `reviewer.js` inside the sandboxed card iframe; the interval labels come
//! from rslib's `describe_next_states`, the same function the desktop uses.
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use frontend::{SchedulingStatesWithContext, SetSchedulingStatesRequest};

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
use session::Session;
pub use types::*;

/// The study session. Cheap to clone; every clone shares the session.
#[derive(Clone)]
pub struct Study {
    service: AnkiService,
    session: Arc<Mutex<Option<Session>>>,
}

type Shared = Arc<Mutex<Option<Session>>>;

fn lock(s: &Shared) -> MutexGuard<'_, Option<Session>> {
    s.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Study {
    pub fn new(service: AnkiService) -> Self {
        Self {
            service,
            session: Arc::new(Mutex::new(None)),
        }
    }

    /// Runs `f` with the session on the actor thread.
    async fn with_session<R, F>(&self, create_for_deck: Option<i64>, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut anki::collection::Collection, &mut Session, &std::path::Path) -> Result<R>
            + Send
            + 'static,
    {
        let shared = Arc::clone(&self.session);
        let media = self.service.paths().media_folder.clone();
        self.service
            .call(move |col| {
                let mut guard = lock(&shared);
                if let Some(deck_id) = create_for_deck {
                    match guard.as_mut() {
                        Some(s) => s.deck_id = deck_id,
                        None => *guard = Some(Session::new(deck_id)),
                    }
                }
                let Some(session) = guard.as_mut() else {
                    return Err(crate::Error::NoStudySession);
                };
                let res = f(col, session, &media);
                // A failed collection operation makes rslib drop its queues (and the undo stack): the card on screen
                // is no longer valid. Refusals decided here (wrong card, nothing to undo…) keep it.
                if let Err(e) = &res
                    && !matches!(
                        e,
                        crate::Error::UndoUnavailable
                            | crate::Error::NotCurrentCard
                            | crate::Error::NoStudySession
                            | crate::Error::InvalidInput(_)
                    )
                {
                    session.current = None;
                }
                res
            })
            .await
    }

    /// Starts (or continues) studying `deck_id` and returns the top of its queue.
    pub async fn next(&self, deck_id: i64) -> Result<StudyNext> {
        self.with_session(Some(deck_id), session::next).await
    }

    /// The answer side of the card on screen. `typed` is the text of `#typeans` (`None` = "").
    pub async fn show_answer(&self, card_id: i64, typed: Option<String>) -> Result<AnswerSide> {
        self.with_session(None, move |col, s, _| {
            session::show_answer(col, s, card_id, typed.as_deref())
        })
        .await
    }

    /// Answers the card on screen (`rating` 1..=4: De novo, Difícil, Bom, Fácil) after `ms` milliseconds.
    pub async fn answer(&self, card_id: i64, rating: u8, ms: u32) -> Result<StudyNext> {
        self.with_session(None, move |col, s, media| {
            session::answer(col, s, media, card_id, rating, ms)
        })
        .await
    }

    /// Undoes the last answer (only when the last operation is an answer) and shows that card again.
    pub async fn undo(&self) -> Result<StudyNext> {
        self.with_session(None, session::undo).await
    }

    /// Bury/suspend (card or note) move on to the next card; flag (toggle) and mark keep the card on screen.
    pub async fn card_action(
        &self,
        card_id: i64,
        action: CardAction,
        flag: Option<u8>,
    ) -> Result<CardActionResult> {
        self.with_session(None, move |col, s, media| {
            session::card_action(col, s, media, card_id, action, flag)
        })
        .await
    }

    /// Leaves the study screen.
    pub fn close(&self) {
        lock(&self.session).take();
    }

    /// Forgets the session (collection replaced, imports…).
    pub fn reset(&self) {
        self.close();
    }

    /// `getSchedulingStatesWithContext` for the card on screen (custom scheduling JS, via the card protocol).
    pub fn states_with_context(&self) -> Option<SchedulingStatesWithContext> {
        let guard = lock(&self.session);
        let current = guard.as_ref()?.current.as_ref()?;
        Some(SchedulingStatesWithContext {
            states: Some(current.states.clone()),
            context: Some(current.context.clone()),
        })
    }

    /// `setSchedulingStates`: replaces the states the next answer uses. False when the key is wrong or no card is on
    /// screen (`reviewer.py` `set_scheduling_states` ignores a wrong key the same way). The key is renewed for every
    /// card, so a late request from a previous card's custom JS is ignored.
    pub fn set_states(&self, req: SetSchedulingStatesRequest) -> bool {
        let mut guard = lock(&self.session);
        let Some(session) = guard.as_mut() else {
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
        lock(&self.session).as_ref().map(|s| s.key.clone())
    }
}
