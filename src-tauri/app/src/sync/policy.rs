//! When to sync (spec 9 "Política"): pure state, no I/O, every time an explicit `now` in epoch ms.
//!
//! - App opened: after [`SyncTimings::startup_delay`] if the last sync is older than 5 min.
//! - Anki tab entered: if the last sync is older than 2 min (window shown again: 5 min).
//! - 60 s after the last answer of a session (re-armed by every answer).
//! - Every 15 min since the last attempt while the app is open.
//! - Manual button (and login): always, right away.
//! - Transient failures (offline, timeout): retry with backoff, and right away when the network
//!   returns.
//!
//! Guards: nothing automatic while logged out or while a full sync waits for the user's choice
//! (the scheduler never uploads); non-manual triggers are deferred while the user is answering
//! (the after-answer timer covers them); while a sync runs, triggers coalesce into at most one
//! follow-up.

/// Durations in ms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncTimings {
    pub startup_delay: i64,
    pub on_open_after: i64,
    pub on_tab_after: i64,
    pub after_answer: i64,
    pub periodic: i64,
    /// Retry delays after consecutive transient failures; the last one repeats.
    pub backoff: Vec<i64>,
}

const SECOND: i64 = 1000;
const MINUTE: i64 = 60 * SECOND;

impl Default for SyncTimings {
    fn default() -> Self {
        Self {
            startup_delay: 2 * SECOND,
            on_open_after: 5 * MINUTE,
            on_tab_after: 2 * MINUTE,
            after_answer: 60 * SECOND,
            periodic: 15 * MINUTE,
            backoff: vec![
                15 * SECOND,
                30 * SECOND,
                60 * SECOND,
                120 * SECOND,
                300 * SECOND,
            ],
        }
    }
}

impl SyncTimings {
    /// Short timings for integration tests (same rules, milliseconds instead of minutes).
    pub fn fast() -> Self {
        Self {
            startup_delay: 50,
            on_open_after: 5_000,
            on_tab_after: 2_000,
            after_answer: 300,
            periodic: 1_500,
            backoff: vec![300, 600, 1_200],
        }
    }

    /// Delay before retry number `failures` (1-based).
    pub fn backoff_for(&self, failures: u32) -> i64 {
        let i = (failures.max(1) as usize - 1).min(self.backoff.len().saturating_sub(1));
        self.backoff.get(i).copied().unwrap_or(MINUTE)
    }
}

/// Something that may start a sync.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    AppOpened,
    TabEntered,
    /// The window became visible again.
    Visible,
    /// A card was answered (re-arms the after-answer timer).
    Answered,
    Manual,
    /// Right after a successful login (the first sync).
    Login,
    /// The network came back.
    Online,
    /// The UI lost the network: a hint only (attempts still run and fail as transient).
    Offline,
}

/// Why a sync starts (what [`Policy::poll`] returns).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    AppOpened,
    TabEntered,
    Visible,
    AfterAnswer,
    Periodic,
    Manual,
    Login,
    Online,
    Retry,
}

impl Reason {
    /// Manual and login syncs run even while a full sync waits for the user.
    pub fn is_user_initiated(self) -> bool {
        matches!(self, Reason::Manual | Reason::Login)
    }
}

/// How a sync ended, as far as the schedule is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finished {
    Success,
    /// The server needs a full sync: wait for the user's choice.
    FullSyncRequired,
    /// Offline, timeout, server busy: retry with backoff.
    Transient,
    /// The sync key was refused: logged out, no retry.
    AuthFailed,
    /// Anything else: no automatic retry until the next regular trigger.
    Failed,
}

#[derive(Clone, Debug)]
pub struct Policy {
    timings: SyncTimings,
    logged_in: bool,
    full_sync_required: bool,
    running: bool,
    /// A sync requested to start as soon as possible (one slot: coalescing).
    requested: Option<Reason>,
    opened_at: Option<i64>,
    open_due: Option<i64>,
    answer_due: Option<i64>,
    retry_due: Option<i64>,
    last_answer_at: Option<i64>,
    last_attempt_at: Option<i64>,
    last_success_at: Option<i64>,
    failures: u32,
}

impl Policy {
    pub fn new(timings: SyncTimings, logged_in: bool, last_success_at: Option<i64>) -> Self {
        Self {
            timings,
            logged_in,
            full_sync_required: false,
            running: false,
            requested: None,
            opened_at: None,
            open_due: None,
            answer_due: None,
            retry_due: None,
            last_answer_at: None,
            last_attempt_at: None,
            last_success_at,
            failures: 0,
        }
    }

    pub fn timings(&self) -> &SyncTimings {
        &self.timings
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn is_logged_in(&self) -> bool {
        self.logged_in
    }

    pub fn full_sync_required(&self) -> bool {
        self.full_sync_required
    }

    pub fn last_success_at(&self) -> Option<i64> {
        self.last_success_at
    }

    /// The sync waiting to start, if any.
    pub fn requested(&self) -> Option<Reason> {
        self.requested
    }

    /// When the next automatic retry is due (offline/backoff), if any.
    pub fn retry_due(&self) -> Option<i64> {
        self.retry_due
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Logged out (or the key was refused): forget every pending sync.
    pub fn set_logged_out(&mut self) {
        self.logged_in = false;
        self.full_sync_required = false;
        self.requested = None;
        self.open_due = None;
        self.answer_due = None;
        self.retry_due = None;
        self.failures = 0;
    }

    /// The local collection was replaced (`.colpkg`): a pending full sync no longer applies; the
    /// next sync is a first sync (a download).
    pub fn collection_replaced(&mut self) {
        self.full_sync_required = false;
    }

    /// The user's full sync (download/upload) succeeded: back to the normal schedule.
    pub fn full_sync_done(&mut self, now: i64) {
        self.running = false;
        self.full_sync_required = false;
        self.failures = 0;
        self.retry_due = None;
        self.last_success_at = Some(now);
        self.last_attempt_at = Some(now);
    }

    fn stale(&self, now: i64, after: i64) -> bool {
        self.last_success_at.is_none_or(|t| now - t > after)
    }

    /// The user answered less than [`SyncTimings::after_answer`] ago.
    fn answering(&self, now: i64) -> bool {
        self.last_answer_at
            .is_some_and(|t| now - t < self.timings.after_answer)
    }

    fn request(&mut self, reason: Reason) {
        // User-initiated requests win over automatic ones in the single slot.
        match self.requested {
            Some(r) if r.is_user_initiated() => {}
            _ => self.requested = Some(reason),
        }
    }

    pub fn notify(&mut self, trigger: Trigger, now: i64) {
        match trigger {
            Trigger::Login => {
                self.logged_in = true;
                self.full_sync_required = false;
                self.failures = 0;
                self.retry_due = None;
                self.request(Reason::Login);
            }
            Trigger::Manual => self.request(Reason::Manual),
            _ if !self.logged_in => {}
            Trigger::AppOpened => {
                self.opened_at = Some(now);
                if self.stale(now, self.timings.on_open_after) {
                    self.open_due = Some(now + self.timings.startup_delay);
                }
            }
            Trigger::TabEntered => {
                if !self.running && self.stale(now, self.timings.on_tab_after) {
                    self.request(Reason::TabEntered);
                }
            }
            Trigger::Visible => {
                if !self.running && self.stale(now, self.timings.on_open_after) {
                    self.request(Reason::Visible);
                }
            }
            Trigger::Answered => {
                self.last_answer_at = Some(now);
                self.answer_due = Some(now + self.timings.after_answer);
            }
            Trigger::Online => {
                if !self.running && (self.retry_due.is_some() || self.failures > 0) {
                    self.retry_due = None;
                    self.request(Reason::Online);
                }
            }
            Trigger::Offline => {}
        }
    }

    fn periodic_due(&self) -> Option<i64> {
        let base = self.last_attempt_at.or(self.opened_at)?;
        Some(base + self.timings.periodic)
    }

    /// No automatic sync may start (logged out, full sync waiting, already running).
    fn blocked(&self) -> bool {
        !self.logged_in || self.running || self.full_sync_required
    }

    /// The sync to start now, if any. The caller must then call [`Policy::started`].
    pub fn poll(&mut self, now: i64) -> Option<Reason> {
        if self.running {
            return None;
        }
        if let Some(r) = self.requested
            && r.is_user_initiated()
        {
            return Some(r);
        }
        if !self.logged_in {
            self.requested = None;
            return None;
        }
        if self.full_sync_required {
            // Waiting for the user's choice: drop what came due so it does not fire later.
            self.requested = None;
            self.open_due = None;
            self.answer_due = self.answer_due.filter(|&t| t > now);
            self.retry_due = None;
            return None;
        }
        if self.answering(now) {
            // The after-answer timer covers everything else.
            self.requested = None;
            return None;
        }
        if let Some(r) = self.requested {
            return Some(r);
        }
        let due = |t: Option<i64>| t.is_some_and(|t| t <= now);
        if due(self.answer_due) {
            return Some(Reason::AfterAnswer);
        }
        if due(self.retry_due) {
            return Some(Reason::Retry);
        }
        if due(self.open_due) {
            return Some(Reason::AppOpened);
        }
        if due(self.periodic_due()) {
            return Some(Reason::Periodic);
        }
        None
    }

    /// A sync started now: clears what it covers.
    pub fn started(&mut self, now: i64) {
        self.running = true;
        self.requested = None;
        self.open_due = None;
        self.retry_due = None;
        self.answer_due = self.answer_due.filter(|&t| t > now);
        self.last_attempt_at = Some(now);
    }

    pub fn finished(&mut self, outcome: Finished, now: i64) {
        self.running = false;
        match outcome {
            Finished::Success => {
                self.failures = 0;
                self.retry_due = None;
                self.full_sync_required = false;
                self.last_success_at = Some(now);
            }
            Finished::FullSyncRequired => {
                self.failures = 0;
                self.retry_due = None;
                self.full_sync_required = true;
            }
            Finished::Transient => {
                self.failures = self.failures.saturating_add(1);
                self.retry_due = Some(now + self.timings.backoff_for(self.failures));
            }
            Finished::AuthFailed => self.set_logged_out(),
            Finished::Failed => {
                self.failures = 0;
                self.retry_due = None;
            }
        }
    }

    /// When [`Policy::poll`] should be called again (`None`: only after a notification).
    pub fn next_wakeup(&self, now: i64) -> Option<i64> {
        if self.running {
            return None;
        }
        if self.requested.is_some_and(Reason::is_user_initiated) {
            return Some(now);
        }
        if self.blocked() {
            return None;
        }
        if let Some(t) = self.last_answer_at
            && now - t < self.timings.after_answer
        {
            return self.answer_due;
        }
        if self.requested.is_some() {
            return Some(now);
        }
        [
            self.answer_due,
            self.retry_due,
            self.open_due,
            self.periodic_due(),
        ]
        .into_iter()
        .flatten()
        .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_761_000_000_000;

    fn policy(last: Option<i64>) -> Policy {
        Policy::new(SyncTimings::default(), true, last)
    }

    /// Polls and, if something is due, starts and finishes it with `outcome`.
    fn run(p: &mut Policy, now: i64, outcome: Finished) -> Option<Reason> {
        let r = p.poll(now)?;
        p.started(now);
        p.finished(outcome, now);
        Some(r)
    }

    #[test]
    fn default_timings_match_the_spec() {
        let t = SyncTimings::default();
        assert_eq!(t.startup_delay, 2_000);
        assert_eq!(t.on_open_after, 300_000);
        assert_eq!(t.on_tab_after, 120_000);
        assert_eq!(t.after_answer, 60_000);
        assert_eq!(t.periodic, 900_000);
        assert_eq!(t.backoff, vec![15_000, 30_000, 60_000, 120_000, 300_000]);
    }

    #[test]
    fn app_opened_syncs_after_the_startup_delay_when_older_than_5_min() {
        // Never synced: due after the startup delay.
        let mut p = policy(None);
        p.notify(Trigger::AppOpened, T0);
        assert_eq!(p.next_wakeup(T0), Some(T0 + 2_000));
        assert_eq!(p.poll(T0 + 1_999), None);
        assert_eq!(p.poll(T0 + 2_000), Some(Reason::AppOpened));

        // Exactly 5 min ago: not stale.
        let mut p = policy(Some(T0 - 300_000));
        p.notify(Trigger::AppOpened, T0);
        assert_eq!(p.poll(T0 + 2_000), None);
        // The next wakeup is the periodic one.
        assert_eq!(p.next_wakeup(T0 + 2_000), Some(T0 + 900_000));

        // 5 min and 1 ms ago: stale.
        let mut p = policy(Some(T0 - 300_001));
        p.notify(Trigger::AppOpened, T0);
        assert_eq!(p.poll(T0 + 2_000), Some(Reason::AppOpened));
    }

    #[test]
    fn tab_entered_syncs_when_older_than_2_min() {
        let mut p = policy(Some(T0));
        p.notify(Trigger::TabEntered, T0 + 120_000);
        assert_eq!(p.poll(T0 + 120_000), None);
        p.notify(Trigger::TabEntered, T0 + 120_001);
        assert_eq!(p.next_wakeup(T0 + 120_001), Some(T0 + 120_001));
        assert_eq!(p.poll(T0 + 120_001), Some(Reason::TabEntered));
    }

    #[test]
    fn visible_uses_the_5_min_threshold() {
        let mut p = policy(Some(T0));
        p.notify(Trigger::Visible, T0 + 200_000);
        assert_eq!(p.poll(T0 + 200_000), None);
        p.notify(Trigger::Visible, T0 + 300_001);
        assert_eq!(p.poll(T0 + 300_001), Some(Reason::Visible));
    }

    #[test]
    fn answers_sync_60_s_after_the_last_one() {
        let mut p = policy(Some(T0));
        p.notify(Trigger::Answered, T0 + 1_000);
        assert_eq!(p.next_wakeup(T0 + 1_000), Some(T0 + 61_000));
        // Another answer re-arms the timer (debounce).
        p.notify(Trigger::Answered, T0 + 30_000);
        assert_eq!(p.next_wakeup(T0 + 30_000), Some(T0 + 90_000));
        assert_eq!(p.poll(T0 + 61_000), None);
        assert_eq!(p.poll(T0 + 89_999), None);
        assert_eq!(p.poll(T0 + 90_000), Some(Reason::AfterAnswer));
        p.started(T0 + 90_000);
        p.finished(Finished::Success, T0 + 91_000);
        assert_eq!(p.poll(T0 + 91_000), None);
        assert_eq!(p.last_success_at(), Some(T0 + 91_000));
    }

    #[test]
    fn non_manual_triggers_wait_while_answering() {
        let mut p = policy(None);
        p.notify(Trigger::Answered, T0);
        p.notify(Trigger::TabEntered, T0 + 10_000);
        p.notify(Trigger::Visible, T0 + 10_000);
        assert_eq!(p.poll(T0 + 10_000), None);
        assert_eq!(p.next_wakeup(T0 + 10_000), Some(T0 + 60_000));
        // Manual is never deferred.
        p.notify(Trigger::Manual, T0 + 20_000);
        assert_eq!(p.next_wakeup(T0 + 20_000), Some(T0 + 20_000));
        assert_eq!(
            run(&mut p, T0 + 20_000, Finished::Success),
            Some(Reason::Manual)
        );
        // The answer timer still fires afterwards.
        assert_eq!(p.poll(T0 + 60_000), Some(Reason::AfterAnswer));
    }

    #[test]
    fn periodic_every_15_min_since_the_last_attempt() {
        let mut p = policy(Some(T0));
        p.notify(Trigger::AppOpened, T0);
        assert_eq!(p.poll(T0 + 899_999), None);
        assert_eq!(p.next_wakeup(T0), Some(T0 + 900_000));
        assert_eq!(
            run(&mut p, T0 + 900_000, Finished::Success),
            Some(Reason::Periodic)
        );
        assert_eq!(p.next_wakeup(T0 + 900_000), Some(T0 + 1_800_000));
        // A manual sync in between moves the next periodic one.
        p.notify(Trigger::Manual, T0 + 1_000_000);
        assert_eq!(
            run(&mut p, T0 + 1_000_000, Finished::Success),
            Some(Reason::Manual)
        );
        assert_eq!(p.next_wakeup(T0 + 1_000_000), Some(T0 + 1_900_000));
        assert_eq!(p.poll(T0 + 1_800_000), None);
        assert_eq!(p.poll(T0 + 1_900_000), Some(Reason::Periodic));
    }

    #[test]
    fn manual_always_runs_right_away() {
        let mut p = policy(Some(T0));
        p.notify(Trigger::Manual, T0 + 1);
        assert_eq!(p.poll(T0 + 1), Some(Reason::Manual));
    }

    #[test]
    fn transient_failures_back_off_and_cap() {
        let mut p = policy(None);
        p.notify(Trigger::Manual, T0);
        let mut now = T0;
        let mut delays = Vec::new();
        assert_eq!(run(&mut p, now, Finished::Transient), Some(Reason::Manual));
        for _ in 0..6 {
            let due = p.retry_due().unwrap();
            delays.push(due - now);
            assert_eq!(p.poll(due - 1), None);
            now = due;
            assert_eq!(run(&mut p, now, Finished::Transient), Some(Reason::Retry));
        }
        assert_eq!(
            delays,
            vec![15_000, 30_000, 60_000, 120_000, 300_000, 300_000]
        );
        // Success resets the backoff.
        let due = p.retry_due().unwrap();
        assert_eq!(run(&mut p, due, Finished::Success), Some(Reason::Retry));
        assert_eq!(p.failures(), 0);
        assert_eq!(p.retry_due(), None);
        p.notify(Trigger::Manual, due + 1);
        assert_eq!(
            run(&mut p, due + 1, Finished::Transient),
            Some(Reason::Manual)
        );
        assert_eq!(p.retry_due(), Some(due + 1 + 15_000));
    }

    #[test]
    fn online_retries_right_away() {
        let mut p = policy(None);
        // Online without a pending retry does nothing.
        p.notify(Trigger::Online, T0);
        assert_eq!(p.poll(T0), None);
        p.notify(Trigger::Manual, T0);
        run(&mut p, T0, Finished::Transient);
        p.notify(Trigger::Offline, T0 + 1_000);
        assert_eq!(p.poll(T0 + 1_000), None);
        p.notify(Trigger::Online, T0 + 2_000);
        assert_eq!(p.retry_due(), None);
        assert_eq!(p.next_wakeup(T0 + 2_000), Some(T0 + 2_000));
        assert_eq!(
            run(&mut p, T0 + 2_000, Finished::Success),
            Some(Reason::Online)
        );
    }

    #[test]
    fn nothing_automatic_when_logged_out() {
        let mut p = Policy::new(SyncTimings::default(), false, None);
        for t in [
            Trigger::AppOpened,
            Trigger::TabEntered,
            Trigger::Visible,
            Trigger::Answered,
            Trigger::Online,
        ] {
            p.notify(t, T0);
        }
        for now in [T0, T0 + 61_000, T0 + 900_000, T0 + 10_000_000] {
            assert_eq!(p.poll(now), None);
            assert_eq!(p.next_wakeup(now), None);
        }
        // Login starts the first sync right away.
        p.notify(Trigger::Login, T0 + 1);
        assert_eq!(p.poll(T0 + 1), Some(Reason::Login));
    }

    #[test]
    fn full_sync_required_stops_automatic_syncs() {
        let mut p = policy(Some(T0));
        p.notify(Trigger::AppOpened, T0);
        p.notify(Trigger::Manual, T0);
        assert_eq!(
            run(&mut p, T0, Finished::FullSyncRequired),
            Some(Reason::Manual)
        );
        assert!(p.full_sync_required());
        p.notify(Trigger::Answered, T0 + 1_000);
        p.notify(Trigger::TabEntered, T0 + 400_000);
        p.notify(Trigger::Online, T0 + 400_000);
        for now in [T0 + 61_000, T0 + 400_000, T0 + 900_000, T0 + 5_000_000] {
            assert_eq!(p.poll(now), None, "no automatic sync at {now}");
            assert_eq!(p.next_wakeup(now), None);
        }
        // Manual re-checks.
        p.notify(Trigger::Manual, T0 + 5_000_001);
        assert_eq!(p.poll(T0 + 5_000_001), Some(Reason::Manual));
        p.started(T0 + 5_000_001);
        p.finished(Finished::FullSyncRequired, T0 + 5_000_002);
        // The user's full sync (it blocks the scheduler while it runs) resets the schedule.
        p.started(T0 + 5_050_000);
        assert_eq!(p.next_wakeup(T0 + 5_050_000), None);
        p.full_sync_done(T0 + 5_100_000);
        assert!(!p.full_sync_required() && !p.is_running());
        assert_eq!(p.next_wakeup(T0 + 5_100_000), Some(T0 + 6_000_000));
    }

    #[test]
    fn running_syncs_coalesce_into_one_follow_up() {
        let mut p = policy(None);
        p.notify(Trigger::Manual, T0);
        assert_eq!(p.poll(T0), Some(Reason::Manual));
        p.started(T0);
        // While running: nothing starts, automatic requests are dropped, manual ones coalesce.
        p.notify(Trigger::TabEntered, T0 + 1);
        p.notify(Trigger::Visible, T0 + 1);
        p.notify(Trigger::Manual, T0 + 2);
        p.notify(Trigger::Manual, T0 + 3);
        assert_eq!(p.poll(T0 + 3), None);
        assert_eq!(p.next_wakeup(T0 + 3), None);
        p.finished(Finished::Success, T0 + 10);
        assert_eq!(
            run(&mut p, T0 + 10, Finished::Success),
            Some(Reason::Manual)
        );
        assert_eq!(p.poll(T0 + 11), None);

        // An answer during a sync becomes the follow-up once its timer fires.
        p.notify(Trigger::Manual, T0 + 20);
        p.poll(T0 + 20);
        p.started(T0 + 20);
        p.notify(Trigger::Answered, T0 + 21);
        assert_eq!(p.poll(T0 + 60_021), None, "still running");
        p.finished(Finished::Success, T0 + 70_000);
        assert_eq!(p.poll(T0 + 70_000), Some(Reason::AfterAnswer));
    }

    #[test]
    fn auth_failure_logs_out_and_stops_retries() {
        let mut p = policy(None);
        p.notify(Trigger::Manual, T0);
        run(&mut p, T0, Finished::Transient);
        assert!(p.retry_due().is_some());
        p.notify(Trigger::Manual, T0 + 1);
        run(&mut p, T0 + 1, Finished::AuthFailed);
        assert!(!p.is_logged_in());
        assert_eq!(p.retry_due(), None);
        assert_eq!(p.next_wakeup(T0 + 1), None);
        p.notify(Trigger::Online, T0 + 2);
        assert_eq!(p.poll(T0 + 1_000_000), None);
    }

    #[test]
    fn other_failures_wait_for_the_next_regular_trigger() {
        let mut p = policy(None);
        p.notify(Trigger::AppOpened, T0);
        assert_eq!(
            run(&mut p, T0 + 2_000, Finished::Failed),
            Some(Reason::AppOpened)
        );
        assert_eq!(p.retry_due(), None);
        assert_eq!(p.poll(T0 + 3_000), None);
        assert_eq!(p.next_wakeup(T0 + 3_000), Some(T0 + 902_000));
        p.notify(Trigger::TabEntered, T0 + 4_000);
        assert_eq!(p.poll(T0 + 4_000), Some(Reason::TabEntered));
    }

    #[test]
    fn fast_timings_keep_the_order() {
        let t = SyncTimings::fast();
        assert!(t.on_tab_after < t.on_open_after);
        assert!(t.after_answer < t.periodic);
        assert_eq!(t.backoff_for(1), 300);
        assert_eq!(t.backoff_for(9), 1_200);
    }
}
