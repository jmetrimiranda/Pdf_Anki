//! Reading sessions (spec 6.4) driven by a manual clock.

use std::sync::Arc;

use core_store::{
    BookFormat, ManualClock, NewBook, ReadingSessionRow, ReadingTracker, StopReason, Store,
    StoreError, book_uid_of,
};

const SEC: i64 = 1_000;
const MIN: i64 = 60 * SEC;
const HOUR: i64 = 60 * MIN;
const T0: i64 = 1_800_000_000_000;

type Tracker = ReadingTracker<Arc<ManualClock>>;

struct Fixture {
    store: Store,
    clock: Arc<ManualClock>,
    tracker: Tracker,
    a: String,
    b: String,
}

fn add(store: &mut Store, bytes: &[u8]) -> String {
    let uid = book_uid_of(bytes);
    store
        .add_book(&NewBook {
            book_uid: uid.clone(),
            title: "Livro".into(),
            author: None,
            language: None,
            format: BookFormat::Pdf,
            file_name: "livro.pdf".into(),
            pages: 100,
            has_text: true,
            file_hash: uid.clone(),
            local_path: None,
        })
        .unwrap();
    uid
}

fn fixture() -> Fixture {
    let mut store = Store::open_in_memory().unwrap();
    let a = add(&mut store, b"a");
    let b = add(&mut store, b"b");
    let clock = Arc::new(ManualClock::new(T0));
    let tracker = ReadingTracker::new(clock.clone());
    Fixture {
        store,
        clock,
        tracker,
        a,
        b,
    }
}

impl Fixture {
    fn at(&self, offset: i64) {
        self.clock.set(T0 + offset);
    }

    fn activity(&mut self, offset: i64, book: &str, page: u32) {
        self.at(offset);
        self.tracker.activity(&mut self.store, book, page).unwrap();
    }

    fn tick(&mut self, offset: i64) {
        self.at(offset);
        self.tracker.tick(&mut self.store).unwrap();
    }

    fn rows(&self) -> Vec<ReadingSessionRow> {
        self.store.list_reading_sessions(None).unwrap()
    }

    fn only_row(&self) -> ReadingSessionRow {
        let rows = self.rows();
        assert_eq!(rows.len(), 1, "{rows:?}");
        rows.into_iter().next().unwrap()
    }
}

#[test]
fn constants_follow_the_spec() {
    assert_eq!(Tracker::HEARTBEAT_MS, 30 * SEC);
    assert_eq!(Tracker::IDLE_MS, 2 * MIN);
    assert_eq!(Tracker::MIN_MS, MIN);
    assert_eq!(Tracker::MAX_MS, 12 * HOUR);
}

#[test]
fn start_inserts_and_heartbeats_are_written_every_30_seconds() {
    let mut f = fixture();
    let a = f.a.clone();
    let uid = f.tracker.start(&mut f.store, &a, 3).unwrap();
    let row = f.only_row();
    assert_eq!(row.uid, uid);
    assert_eq!((row.started_at, row.last_heartbeat_at), (T0, T0));
    assert_eq!(row.ended_at, None);
    assert_eq!(row.pages, [3]);
    assert_eq!(row.sent_to_painel_at, None);

    // Activity before 30 s is kept in memory only.
    f.activity(10 * SEC, &a, 4);
    f.activity(25 * SEC, &a, 4);
    f.tick(29 * SEC);
    let row = f.only_row();
    assert_eq!((row.last_heartbeat_at, row.pages.clone()), (T0, vec![3]));
    let current = f.tracker.current().unwrap();
    assert_eq!(current.pages, [3, 4]);
    assert_eq!(current.last_activity_at, T0 + 25 * SEC);

    // At 30 s the heartbeat is the last activity, not the time of the write.
    f.tick(30 * SEC);
    let row = f.only_row();
    assert_eq!(row.last_heartbeat_at, T0 + 25 * SEC);
    assert_eq!(row.pages, [3, 4]);

    // No activity since the write: nothing more is written, however many ticks.
    f.tick(70 * SEC);
    f.tick(100 * SEC);
    assert_eq!(f.only_row().last_heartbeat_at, T0 + 25 * SEC);

    // Activity at 105 s; the next write may happen 30 s after the previous one (at 30 s).
    f.activity(105 * SEC, &a, 5);
    let row = f.only_row();
    assert_eq!(
        row.last_heartbeat_at,
        T0 + 105 * SEC,
        "due: written on activity"
    );
    assert_eq!(row.pages, [3, 4, 5]);
    f.activity(110 * SEC, &a, 6);
    assert_eq!(
        f.only_row().last_heartbeat_at,
        T0 + 105 * SEC,
        "not due yet"
    );
}

#[test]
fn two_minutes_without_activity_close_at_the_last_activity() {
    let mut f = fixture();
    let a = f.a.clone();
    f.activity(0, &a, 0);
    f.activity(90 * SEC, &a, 1);
    f.tick(90 * SEC + 2 * MIN - 1);
    assert!(f.tracker.current().is_some(), "not idle yet");
    f.tick(90 * SEC + 2 * MIN);
    assert!(f.tracker.current().is_none());
    let row = f.only_row();
    assert_eq!(row.ended_at, Some(T0 + 90 * SEC));
    assert_eq!(row.last_heartbeat_at, T0 + 90 * SEC);
    assert_eq!(row.pages, [0, 1]);
}

#[test]
fn explicit_stops_end_now() {
    for reason in [
        StopReason::Tab,
        StopReason::Doc,
        StopReason::Hidden,
        StopReason::Close,
        StopReason::Review,
    ] {
        let mut f = fixture();
        let a = f.a.clone();
        f.activity(0, &a, 0);
        f.activity(90 * SEC, &a, 0);
        f.activity(3 * MIN, &a, 1);
        f.at(4 * MIN);
        let closed = f
            .tracker
            .stop(&mut f.store, reason)
            .unwrap()
            .expect("a session was open");
        assert_eq!(closed.reason, reason);
        assert_eq!((closed.started_at, closed.ended_at), (T0, T0 + 4 * MIN));
        assert!(!closed.discarded);
        assert_eq!(closed.sessions.len(), 1);
        let row = f.only_row();
        assert_eq!(row.ended_at, Some(T0 + 4 * MIN), "{reason:?}");
        assert!(f.tracker.current().is_none());
        // Stopping again does nothing.
        assert!(f.tracker.stop(&mut f.store, reason).unwrap().is_none());
    }
    // serde names
    assert_eq!(
        serde_json::to_value(StopReason::Hidden).unwrap(),
        serde_json::json!("hidden")
    );
}

#[test]
fn stop_idle_and_late_stops_end_at_the_last_activity() {
    let mut f = fixture();
    let a = f.a.clone();
    f.activity(0, &a, 0);
    f.activity(MIN, &a, 0);
    f.activity(2 * MIN, &a, 1);
    f.at(2 * MIN + 10 * SEC);
    let closed = f
        .tracker
        .stop(&mut f.store, StopReason::Idle)
        .unwrap()
        .unwrap();
    assert_eq!(closed.ended_at, T0 + 2 * MIN);

    // A tab switch noticed only after the idle limit (no tick ran) still ends at the activity.
    f.activity(10 * MIN, &a, 0);
    f.activity(11 * MIN, &a, 0);
    f.activity(12 * MIN, &a, 1);
    f.at(20 * MIN);
    let closed = f
        .tracker
        .stop(&mut f.store, StopReason::Tab)
        .unwrap()
        .unwrap();
    assert_eq!(closed.reason, StopReason::Idle);
    assert_eq!(closed.ended_at, T0 + 12 * MIN);
}

#[test]
fn sessions_under_a_minute_are_discarded() {
    let mut f = fixture();
    let a = f.a.clone();
    f.activity(0, &a, 0);
    f.activity(40 * SEC, &a, 1);
    f.at(59 * SEC);
    let closed = f
        .tracker
        .stop(&mut f.store, StopReason::Tab)
        .unwrap()
        .unwrap();
    assert!(closed.discarded);
    assert!(closed.sessions.is_empty());
    assert!(f.rows().is_empty());

    // Exactly one minute is kept.
    f.activity(10 * MIN, &a, 0);
    f.at(11 * MIN);
    let closed = f
        .tracker
        .stop(&mut f.store, StopReason::Tab)
        .unwrap()
        .unwrap();
    assert!(!closed.discarded);
    assert_eq!(f.rows().len(), 1);
}

#[test]
fn sessions_over_twelve_hours_are_split_with_their_pages() {
    let mut f = fixture();
    let a = f.a.clone();
    let uid = f.tracker.start(&mut f.store, &a, 0).unwrap();
    // 25 h of continuous reading, one activity a minute; page p is first seen at p hours.
    let mut t = 0;
    while t <= 25 * HOUR {
        f.activity(t, &a, (t / HOUR) as u32);
        t += MIN;
    }
    f.at(25 * HOUR);
    let closed = f
        .tracker
        .stop(&mut f.store, StopReason::Close)
        .unwrap()
        .unwrap();
    assert_eq!(closed.sessions.len(), 3);
    let rows = f.rows();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].uid, uid, "the first chunk keeps the uid");
    assert_ne!(rows[1].uid, rows[2].uid);
    assert_eq!(rows[0].started_at, T0);
    assert_eq!(rows[2].ended_at, Some(T0 + 25 * HOUR));
    for w in rows.windows(2) {
        assert_eq!(w[0].ended_at, Some(w[1].started_at), "consecutive");
    }
    for r in &rows {
        let d = r.ended_at.unwrap() - r.started_at;
        assert!((MIN..=12 * HOUR).contains(&d), "{d}");
    }
    // Chunks are 8h20m: pages 0..=8 in the first, 9..=16 in the second, 17..=25 in the third.
    assert_eq!(rows[0].pages, (0..=8).collect::<Vec<u32>>());
    assert_eq!(rows[1].pages, (9..=16).collect::<Vec<u32>>());
    assert_eq!(rows[2].pages, (17..=25).collect::<Vec<u32>>());
}

#[test]
fn a_crash_is_closed_at_the_last_heartbeat_on_recovery() {
    let mut f = fixture();
    let a = f.a.clone();
    let uid = f.tracker.start(&mut f.store, &a, 0).unwrap();
    for (s, page) in [(30, 1), (60, 2), (95, 3), (130, 4), (150, 5)] {
        f.activity(s * SEC, &a, page);
    }
    // Written: at 30 s, 60 s, 95 s and 130 s (each ≥ 30 s after the previous write); 150 s is not.
    assert_eq!(f.only_row().last_heartbeat_at, T0 + 130 * SEC);
    // The app dies: the tracker is dropped without stop.
    drop(std::mem::replace(
        &mut f.tracker,
        ReadingTracker::new(f.clock.clone()),
    ));
    f.at(3 * HOUR);
    let report = f.tracker.recover(&mut f.store).unwrap();
    assert_eq!(report.discarded, 0);
    assert_eq!(report.closed.len(), 1);
    let row = f.only_row();
    assert_eq!(row.uid, uid);
    assert_eq!(row.ended_at, Some(T0 + 130 * SEC));
    assert_eq!(row.pages, [0, 1, 2, 3, 4]);
    // Nothing left to recover.
    assert_eq!(f.tracker.recover(&mut f.store).unwrap(), Default::default());
}

#[test]
fn recovery_discards_short_and_splits_long_crashed_sessions() {
    let mut f = fixture();
    let (a, b) = (f.a.clone(), f.b.clone());
    let conn = f.store.connection();
    conn.execute(
        "INSERT INTO reading_session (uid, book_uid, started_at, last_heartbeat_at, pages)
         VALUES ('short', ?1, 0, 30000, '[1]'), ('long', ?2, 0, ?3, '[7,2]')",
        rusqlite::params![a, b, 13 * HOUR],
    )
    .unwrap();
    let report = f.tracker.recover(&mut f.store).unwrap();
    assert_eq!(report.discarded, 1);
    assert_eq!(report.closed.len(), 2);
    let rows = f.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].uid, "long");
    assert_eq!(rows[0].pages, [2, 7], "all pages go to the first chunk");
    assert!(rows[1].pages.is_empty());
    assert_eq!(rows[1].ended_at, Some(13 * HOUR));
}

#[test]
fn recover_keeps_the_trackers_own_session() {
    let mut f = fixture();
    let a = f.a.clone();
    let uid = f.tracker.start(&mut f.store, &a, 0).unwrap();
    f.at(5 * MIN);
    let report = f.tracker.recover(&mut f.store).unwrap();
    assert!(report.closed.is_empty() && report.discarded == 0);
    assert_eq!(f.tracker.current().unwrap().uid, uid);
    assert_eq!(f.only_row().ended_at, None);
}

#[test]
fn activity_for_another_book_switches_sessions() {
    let mut f = fixture();
    let (a, b) = (f.a.clone(), f.b.clone());
    f.activity(0, &a, 0);
    f.activity(90 * SEC, &a, 1);
    f.activity(3 * MIN, &b, 9);
    let current = f.tracker.current().unwrap();
    assert_eq!(current.book_uid, b);
    assert_eq!(current.started_at, T0 + 3 * MIN);
    let rows = f.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].book_uid, a);
    assert_eq!(
        rows[0].ended_at,
        Some(T0 + 3 * MIN),
        "stopped as Doc: ends now"
    );
    assert_eq!(rows[1].book_uid, b);
    assert_eq!(rows[1].ended_at, None);
    assert_eq!(f.store.list_reading_sessions(Some(&b)).unwrap().len(), 1);

    // start() of the open, active book is just activity.
    f.at(4 * MIN);
    let uid = f.tracker.start(&mut f.store, &b, 10).unwrap();
    assert_eq!(uid, rows[1].uid);
    assert_eq!(f.tracker.current().unwrap().pages, [9, 10]);
}

#[test]
fn an_idle_gap_splits_reading_into_two_sessions() {
    let mut f = fixture();
    let a = f.a.clone();
    for m in 0..5 {
        f.activity(m * MIN, &a, 0);
    }
    f.activity(5 * MIN, &a, 1);
    // No tick ran during the pause (e.g. the machine slept); the next activity notices it.
    for m in 20..25 {
        f.activity(m * MIN, &a, 2);
    }
    f.activity(25 * MIN, &a, 3);
    f.at(26 * MIN);
    f.tracker.stop(&mut f.store, StopReason::Close).unwrap();
    let rows = f.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        (rows[0].started_at, rows[0].ended_at),
        (T0, Some(T0 + 5 * MIN))
    );
    assert_eq!(rows[0].pages, [0, 1]);
    assert_eq!(
        (rows[1].started_at, rows[1].ended_at),
        (T0 + 20 * MIN, Some(T0 + 26 * MIN))
    );
    assert_eq!(rows[1].pages, [2, 3]);
}

#[test]
fn unknown_or_removed_books_are_refused() {
    let mut f = fixture();
    let unknown = book_uid_of(b"unknown");
    assert!(matches!(
        f.tracker.start(&mut f.store, &unknown, 0),
        Err(StoreError::BookNotFound(_))
    ));
    assert!(matches!(
        f.tracker.activity(&mut f.store, "../x", 0),
        Err(StoreError::InvalidBookUid(_))
    ));
    assert!(f.tracker.current().is_none());
    // The tracker is shareable between threads (the app keeps it in a Mutex).
    fn send<T: Send>() {}
    send::<Tracker>();
}

#[test]
fn a_late_stop_for_another_book_keeps_the_open_session() {
    let mut f = fixture();
    let (a, b) = (f.a.clone(), f.b.clone());
    f.activity(0, &a, 1);
    // B comes to the front (this stops A with `Doc`), then A's stop arrives late.
    f.at(2 * MIN);
    f.tracker.start(&mut f.store, &b, 0).unwrap();
    f.at(2 * MIN + 10 * SEC);
    let late = f
        .tracker
        .stop_book(&mut f.store, &a, StopReason::Tab)
        .unwrap();
    assert!(late.is_none());
    assert_eq!(
        f.tracker.current().map(|o| o.book_uid.as_str()),
        Some(b.as_str())
    );
    // B's own stop closes it.
    f.at(4 * MIN);
    let closed = f
        .tracker
        .stop_book(&mut f.store, &b, StopReason::Tab)
        .unwrap()
        .unwrap();
    assert_eq!(closed.book_uid, b);
    assert!(f.tracker.current().is_none());
}
