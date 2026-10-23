//! Reading sessions (spec 6.4), recorded in Rust by `core_store::ReadingTracker`. The UI reports
//! what PdfCraft says (`start` when a book comes to the front, `heartbeat` on `pdfcraft:activity`
//! and `pdfcraft:page`, `stop` on tab/doc switch, background, close or mini review); a ticker
//! thread notices inactivity and writes the 30 s heartbeat.

use std::sync::{Arc, Weak};
use std::time::Duration;

use core_store::{ClosedSession, StopReason};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

/// How often the ticker checks for inactivity and due heartbeats.
pub const TICK: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStarted {
    pub session_uid: String,
}

/// The `reason` of `reading_session_stop`. `background` is accepted as a synonym of `hidden`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StopReasonArg {
    Tab,
    Doc,
    #[serde(alias = "background")]
    Hidden,
    Close,
    Idle,
    Review,
}

impl From<StopReasonArg> for StopReason {
    fn from(r: StopReasonArg) -> Self {
        match r {
            StopReasonArg::Tab => Self::Tab,
            StopReasonArg::Doc => Self::Doc,
            StopReasonArg::Hidden => Self::Hidden,
            StopReasonArg::Close => Self::Close,
            StopReasonArg::Idle => Self::Idle,
            StopReasonArg::Review => Self::Review,
        }
    }
}

impl AppState {
    pub fn reading_session_start(&self, uid: &str, page: u32) -> Result<SessionStarted, AppError> {
        let mut tracker = self.tracker();
        let session_uid = self.with_store(|s| tracker.start(s, uid, page))?;
        Ok(SessionStarted { session_uid })
    }

    pub fn reading_session_heartbeat(&self, uid: &str, page: u32) -> Result<(), AppError> {
        let mut tracker = self.tracker();
        self.with_store(|s| tracker.activity(s, uid, page))
    }

    /// Ends the open session. With `uid`, only if the open session is that book's (a stop that
    /// arrives late for a book already left is ignored); without it, whatever is open.
    pub fn reading_session_stop(
        &self,
        uid: Option<&str>,
        reason: StopReason,
    ) -> Result<Option<ClosedSession>, AppError> {
        let mut tracker = self.tracker();
        if tracker.current().is_none() {
            return Ok(None);
        }
        let closed = self.with_store(|s| match uid {
            Some(uid) => tracker.stop_book(s, uid, reason),
            None => tracker.stop(s, reason),
        })?;
        if let Some(c) = &closed {
            tracing::debug!(
                book_uid = %c.book_uid,
                reason = ?c.reason,
                discarded = c.discarded,
                minutes = (c.ended_at - c.started_at) / 60_000,
                "reading session closed"
            );
        }
        Ok(closed)
    }

    /// Closes an idle session and writes a due heartbeat. Cheap when nothing is open.
    pub fn reading_tick(&self) -> Result<(), AppError> {
        let mut tracker = self.tracker();
        if tracker.current().is_none() {
            return Ok(());
        }
        self.with_store(|s| tracker.tick(s))
    }

    /// `RunEvent::Exit`: the window is gone, so the session ends now.
    pub fn reading_stop_on_exit(&self) {
        if let Err(e) = self.reading_session_stop(None, StopReason::Close) {
            tracing::warn!(code = %e.code, "could not close the reading session on exit");
        }
    }
}

/// Starts the ticker thread. It holds a weak reference and ends with the app.
pub fn spawn_ticker(state: &Arc<AppState>) {
    let weak: Weak<AppState> = Arc::downgrade(state);
    let spawned = std::thread::Builder::new()
        .name("reading-ticker".into())
        .spawn(move || {
            loop {
                std::thread::sleep(TICK);
                let Some(state) = weak.upgrade() else { break };
                if state.is_shutting_down() {
                    break;
                }
                if let Err(e) = state.reading_tick() {
                    tracing::warn!(code = %e.code, "reading tick failed: {e}");
                }
            }
        });
    if let Err(e) = spawned {
        tracing::warn!(%e, "could not start the reading ticker");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_reasons_parse_from_the_ui() {
        for (text, reason) in [
            ("tab", StopReason::Tab),
            ("doc", StopReason::Doc),
            ("hidden", StopReason::Hidden),
            ("background", StopReason::Hidden),
            ("close", StopReason::Close),
            ("idle", StopReason::Idle),
            ("review", StopReason::Review),
        ] {
            let arg: StopReasonArg = serde_json::from_value(serde_json::json!(text)).unwrap();
            assert_eq!(StopReason::from(arg), reason);
        }
        assert!(serde_json::from_value::<StopReasonArg>(serde_json::json!("x")).is_err());
    }
}
