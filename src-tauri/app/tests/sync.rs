//! Anki sync in the app (spec 9, 15, 18): commands, keychain, status, scheduler.
//!
//! The first group runs offline with an in-memory secret store. The second group needs the LOCAL
//! official sync server (compose.dev.yml) and is skipped unless `LEITOR_SYNC_TEST_URL` is set:
//! `scripts/sync-test.sh app` (same env contract as `core-anki/tests/sync_server.rs`).
//!
//! Hard rule: only the local test server; any other host makes the tests panic before a request.
//! Accounts used here (password `test`): t4, t9, t10 — never used by the core suite.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_anki::anki::notetype::NoteField;
use core_anki::fixture::{self, DECK_WORDS};
use core_anki::study::StudyNext;
use core_anki::sync as csync;
use core_anki::{
    AnkiService, BackupKind, FullSyncChoice, FullSyncDirection, SyncConfig, SyncCredentials,
    SyncEndpoint, SyncOutcome, notetypes,
};
use core_store::{SystemClock, setting_keys as keys};
use leitor_app::secrets::{KeyringStore, MemoryStore, SecretStore, sync_account};
use leitor_app::sync::SyncTimings;
use leitor_app::{AnkiSyncStatus, AppState, ChangeReason, SyncNotice, SyncState, UiEvent};
use tempfile::TempDir;
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::task::JoinSet;

const PASSWORD: &str = "test";
const ALLOWED_HOSTS: [&str; 4] = ["ankisync-dev", "ankisync-dev-tls", "localhost", "127.0.0.1"];

/// A self-signed certificate (CN=leitor-app-test, EC P-256), public test data.
const TEST_CERT: &str = "-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIUSDJQawzjlA3QLMh0g925HhC4crUwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPbGVpdG9yLWFwcC10ZXN0MCAXDTI2MTAyMzA2MjAwNFoYDzIx
MjYwOTI5MDYyMDA0WjAaMRgwFgYDVQQDDA9sZWl0b3ItYXBwLXRlc3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAT3U+e8n2X9W7hcCQj4nywlA0y+c2wKV6L991VA
9rIlaRjrj7KXbR0uISJtqqMvRsgrvH8+7KDkFHucfrymejtVo1MwUTAdBgNVHQ4E
FgQUTLwVUp94X62BiMJHv0lZ/DHpuaMwHwYDVR0jBBgwFoAUTLwVUp94X62BiMJH
v0lZ/DHpuaMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAeRBzY
klbeEgcyFSqcyVYOipEz9GYhqy29hTQ25QgKswIhAJwiaACSCf+9GI9M8GY1YP62
08d/0xnq5WbQd86O4eVG
-----END CERTIFICATE-----
";

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

struct App {
    _tmp: TempDir,
    state: Arc<AppState>,
    secrets: Arc<MemoryStore>,
    events: Arc<Mutex<Vec<UiEvent>>>,
}

impl App {
    fn new(timings: SyncTimings) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemoryStore::default());
        let state = Arc::new(AppState::with_secret_store(
            tmp.path().join("data"),
            Arc::new(SystemClock),
            secrets.clone(),
        ));
        state.set_sync_timings(timings);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        state.set_ui_sink(Arc::new(move |e| sink.lock().unwrap().push(e)));
        Self {
            _tmp: tmp,
            state,
            secrets,
            events,
        }
    }

    fn data_dir(&self) -> PathBuf {
        self.state.data_dir().to_path_buf()
    }

    fn status(&self) -> AnkiSyncStatus {
        self.state.anki_sync_status().unwrap()
    }

    /// Polls the status until `pred` holds.
    fn wait(
        &self,
        what: &str,
        timeout: Duration,
        pred: impl Fn(&AnkiSyncStatus) -> bool,
    ) -> AnkiSyncStatus {
        let start = Instant::now();
        loop {
            let s = self.status();
            if pred(&s) {
                return s;
            }
            assert!(
                start.elapsed() < timeout,
                "timed out waiting for {what}: {s:?}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn wait_settled(&self) -> AnkiSyncStatus {
        self.wait("the sync to finish", Duration::from_secs(60), |s| {
            s.state != SyncState::Syncing
        })
    }

    fn changed(&self, reason: ChangeReason) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, UiEvent::AnkiChanged(r) if *r == reason))
            .count()
    }

    fn sync_events(&self) -> Vec<AnkiSyncStatus> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                UiEvent::AnkiSync(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }

    fn svc(&self) -> AnkiService {
        self.state.anki_handles().unwrap().svc
    }
}

impl Drop for App {
    fn drop(&mut self) {
        self.state.shutdown();
    }
}

fn set_account(app: &App, url: &str, user: &str) {
    app.state
        .with_store(|s| {
            s.set_setting(keys::ANKI_SYNC_URL, url.into())?;
            s.set_setting(keys::ANKI_SYNC_USER, user.into())
        })
        .unwrap();
}

// ---------------------------------------------------------------------------------------------
// Offline (no server)

#[test]
fn status_is_off_by_default_with_stable_keys() {
    let app = App::new(SyncTimings::fast());
    let status = app.status();
    assert_eq!(status.state, SyncState::Off);
    assert!(!status.logged_in && !status.first_sync_pending);
    let v = serde_json::to_value(&status).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "certificateFingerprint",
            "firstSyncPending",
            "fullSync",
            "lastError",
            "lastSyncAt",
            "loggedIn",
            "mediaError",
            "mediaSyncing",
            "nextRetryAt",
            "serverMessage",
            "state",
            "url",
            "user"
        ]
    );
    assert_eq!(v["state"], "off");
    // Logged out: manual and full syncs are refused, notifications are harmless.
    let err = block_on(app.state.anki_sync()).unwrap_err();
    assert_eq!(err.code, "anki_sync_not_logged_in");
    assert!(err.message.contains("Configurações → Anki e sincronização"));
    let err = block_on(app.state.anki_sync_full(FullSyncDirection::Download)).unwrap_err();
    assert_eq!(err.code, "anki_sync_not_logged_in");
    for n in [
        SyncNotice::TabEntered,
        SyncNotice::Visible,
        SyncNotice::Online,
        SyncNotice::Offline,
    ] {
        app.state.anki_sync_notify(n).unwrap();
    }
    assert_eq!(app.status().state, SyncState::Off);
    assert!(app.secrets.accounts().is_empty());
}

#[test]
fn ankiweb_is_refused_and_nothing_is_stored() {
    let app = App::new(SyncTimings::fast());
    for url in [
        "https://sync.ankiweb.net/",
        "https://ankiweb.net",
        "HTTPS://SYNC2.ANKIWEB.NET/sync/",
    ] {
        let err =
            block_on(
                app.state
                    .anki_sync_login(url.into(), "eu".into(), "segredo".into(), None),
            )
            .unwrap_err();
        assert_eq!(err.code, "anki_sync_anki_web_refused", "{url}");
        assert!(err.message.contains("AnkiWeb"));
    }
    for url in ["", "ftp://h/", "anki.example.com"] {
        let err = block_on(
            app.state
                .anki_sync_login(url.into(), "eu".into(), "x".into(), None),
        )
        .unwrap_err();
        assert_eq!(err.code, "anki_sync_invalid_url", "{url}");
    }
    assert!(app.secrets.accounts().is_empty());
    let status = app.status();
    assert_eq!((status.url, status.user), (None, None));
    assert_eq!(status.state, SyncState::Off);
}

#[test]
fn certificates_are_validated() {
    let app = App::new(SyncTimings::fast());
    for bad in [
        "isto não é um certificado",
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
    ] {
        let err = block_on(app.state.anki_sync_login(
            "http://127.0.0.1:9/".into(),
            "eu".into(),
            "x".into(),
            Some(bad.into()),
        ))
        .unwrap_err();
        assert_eq!(err.code, "anki_sync_invalid_certificate");
        let err = app
            .state
            .anki_sync_set_certificate(Some(bad.into()))
            .unwrap_err();
        assert_eq!(err.code, "anki_sync_invalid_certificate");
    }
    assert_eq!(app.status().certificate_fingerprint, None);
    let status = app
        .state
        .anki_sync_set_certificate(Some(TEST_CERT.into()))
        .unwrap();
    let fp = status.certificate_fingerprint.expect("fingerprint");
    assert_eq!(fp.len(), 32 * 3 - 1);
    assert!(fp.chars().all(|c| c.is_ascii_hexdigit() || c == ':'));
    // The certificate is public data in the settings; clearing it works.
    let stored = app
        .state
        .with_store(|s| s.setting(keys::ANKI_SYNC_CA_CERT))
        .unwrap();
    assert!(stored.as_str().unwrap().contains("BEGIN CERTIFICATE"));
    let status = app.state.anki_sync_set_certificate(None).unwrap();
    assert_eq!(status.certificate_fingerprint, None);
    assert!(
        app.sync_events()
            .iter()
            .any(|s| s.certificate_fingerprint.is_some())
    );
}

#[test]
fn logout_deletes_the_key_and_keeps_the_prefill() {
    let app = App::new(SyncTimings::fast());
    let url = "http://127.0.0.1:9/";
    set_account(&app, url, "eu");
    let account = sync_account("eu", url);
    app.secrets.set(&account, "hkey-de-teste").unwrap();
    let status = app.status();
    assert!(status.logged_in);
    assert!(status.first_sync_pending);
    assert_eq!(status.state, SyncState::Idle);

    let status = app.state.anki_sync_logout().unwrap();
    assert_eq!(status.state, SyncState::Off);
    assert!(!status.logged_in);
    assert_eq!(status.url.as_deref(), Some(url));
    assert_eq!(status.user.as_deref(), Some("eu"));
    assert_eq!(app.secrets.get(&account).unwrap(), None);
    assert!(app.secrets.accounts().is_empty());
    assert_eq!(
        app.sync_events().last().map(|s| s.state),
        Some(SyncState::Off)
    );
    let err = block_on(app.state.anki_sync()).unwrap_err();
    assert_eq!(err.code, "anki_sync_not_logged_in");
}

#[test]
fn full_sync_is_refused_when_not_required() {
    // Nothing is listening: an accepted full sync would fail with `anki_sync_offline` instead.
    let app = App::new(SyncTimings::fast());
    let url = "http://127.0.0.1:9/";
    set_account(&app, url, "eu");
    let account = sync_account("eu", url);
    app.secrets.set(&account, "hkey-de-teste").unwrap();
    assert!(app.status().first_sync_pending);
    // Never an upload that the last sync did not ask for (it would replace the server copy),
    // not even before the first sync (the local collection is disposable then).
    let err = block_on(app.state.anki_sync_full(FullSyncDirection::Upload)).unwrap_err();
    assert_eq!(err.code, "anki_sync_full_not_required");
    let backups = || {
        files_under(&app.data_dir())
            .into_iter()
            .filter(|p| p.to_string_lossy().contains("antes-da-sincronizacao"))
            .count()
    };
    assert_eq!(backups(), 0, "no backup for a refused full sync");

    // After the first sync, a download needs a pending full sync too.
    app.state
        .with_store(|s| s.set_setting(keys::ANKI_SYNC_FIRST_DONE, account.as_str().into()))
        .unwrap();
    assert!(!app.status().first_sync_pending);
    for direction in [FullSyncDirection::Download, FullSyncDirection::Upload] {
        let err = block_on(app.state.anki_sync_full(direction)).unwrap_err();
        assert_eq!(err.code, "anki_sync_full_not_required", "{direction:?}");
    }
    let status = app.status();
    assert_eq!(status.state, SyncState::Idle, "{status:?}");
    assert_eq!(status.last_error, None);
    assert_eq!(backups(), 0);
}

#[test]
fn a_colpkg_import_makes_the_next_sync_a_first_sync() {
    let app = App::new(SyncTimings::fast());
    let url = "http://127.0.0.1:9/";
    set_account(&app, url, "eu");
    let account = sync_account("eu", url);
    app.secrets.set(&account, "hkey-de-teste").unwrap();
    app.state
        .with_store(|s| s.set_setting(keys::ANKI_SYNC_FIRST_DONE, account.as_str().into()))
        .unwrap();
    assert!(!app.status().first_sync_pending);

    let backup = block_on(core_anki::backup::backup_now(
        &app.svc(),
        BackupKind::Manual,
    ))
    .unwrap();
    let src = app.data_dir().join("importar.colpkg");
    std::fs::copy(&backup.path, &src).unwrap();
    let src = src.to_string_lossy().into_owned();
    app.state.grant_packages(&[src.as_str()]);
    block_on(app.state.anki_import_colpkg(&src)).unwrap();
    // Disposable: the next sync downloads over it, never merges or uploads it.
    let status = app.status();
    assert!(status.first_sync_pending, "{status:?}");
    assert_eq!(status.full_sync, None);
}

#[test]
fn an_unreachable_server_is_reported_without_blocking() {
    // Port 9 (discard) on loopback: connection refused, i.e. offline.
    let app = App::new(SyncTimings::fast());
    let url = "http://127.0.0.1:9/";
    set_account(&app, url, "eu");
    app.secrets
        .set(&sync_account("eu", url), "hkey-de-teste")
        .unwrap();
    let status = block_on(app.state.anki_sync()).unwrap();
    assert_eq!(status.state, SyncState::Offline, "{status:?}");
    assert!(status.next_retry_at.is_some());
    assert_eq!(
        status.last_error.as_ref().map(|e| e.code.as_str()),
        Some("anki_sync_offline")
    );
    assert_eq!(status.last_sync_at, None);
    // The collection stays usable.
    assert!(block_on(app.state.anki_deck_tree()).is_ok());
}

/// The real system keychain (Secret Service under `scripts/with-keyring.sh`, which sets
/// `LEITOR_TEST_KEYRING=1`).
#[test]
fn keyring_roundtrip() {
    if std::env::var_os("LEITOR_TEST_KEYRING").is_none_or(|v| v != "1") {
        println!("skipped: set LEITOR_TEST_KEYRING=1 (scripts/with-keyring.sh)");
        return;
    }
    let store = KeyringStore;
    let account = sync_account(
        &format!("teste-{}-{}", std::process::id(), core_store::now_ms()),
        "http://keyring-test.invalid/",
    );
    assert_eq!(store.get(&account).unwrap(), None);
    store.set(&account, "segredo-1").unwrap();
    assert_eq!(store.get(&account).unwrap().as_deref(), Some("segredo-1"));
    store.set(&account, "segredo-2").unwrap();
    assert_eq!(store.get(&account).unwrap().as_deref(), Some("segredo-2"));
    store.delete(&account).unwrap();
    assert_eq!(store.get(&account).unwrap(), None);
    store.delete(&account).unwrap();

    // The app with the real keychain: logout deletes the entry.
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::with_secret_store(
        tmp.path().join("data"),
        Arc::new(SystemClock),
        Arc::new(KeyringStore),
    );
    let url = "http://127.0.0.1:9/";
    let user = format!("teste-app-{}", std::process::id());
    state
        .with_store(|s| {
            s.set_setting(keys::ANKI_SYNC_URL, url.into())?;
            s.set_setting(keys::ANKI_SYNC_USER, user.as_str().into())
        })
        .unwrap();
    let account = sync_account(&user, url);
    KeyringStore.set(&account, "hkey-keyring").unwrap();
    assert!(state.anki_sync_status().unwrap().logged_in);
    let status = state.anki_sync_logout().unwrap();
    assert!(!status.logged_in);
    assert_eq!(KeyringStore.get(&account).unwrap(), None);
    state.shutdown();
}

// ---------------------------------------------------------------------------------------------
// Against the local server

struct Env {
    url: String,
    tls_url: Option<String>,
    ca: Option<PathBuf>,
}

fn env() -> Option<Env> {
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let Some(url) = var("LEITOR_SYNC_TEST_URL") else {
        println!("skipped: LEITOR_SYNC_TEST_URL not set (run scripts/sync-test.sh app)");
        return None;
    };
    let env = Env {
        url,
        tls_url: var("LEITOR_SYNC_TEST_TLS_URL"),
        ca: var("LEITOR_SYNC_TEST_CA").map(PathBuf::from),
    };
    for url in std::iter::once(&env.url).chain(env.tls_url.as_ref()) {
        local_only(url);
    }
    Some(env)
}

/// Panics unless `url` points at the local test server (hard rule of the project).
fn local_only(url: &str) -> SyncEndpoint {
    let ep = SyncEndpoint::parse(url).unwrap_or_else(|e| panic!("bad test URL {url}: {e}"));
    assert!(
        ALLOWED_HOSTS.contains(&ep.host()),
        "refusing to run sync tests against {url}: only the local test server may be used"
    );
    ep
}

/// A core-only collection (the "other device").
struct Side {
    _tmp: TempDir,
    svc: AnkiService,
}

impl Side {
    fn fixture() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("anki");
        fixture::build(&dir, Default::default()).unwrap();
        let svc = AnkiService::open(&dir).unwrap();
        Self { _tmp: tmp, svc }
    }

    fn empty() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let svc = AnkiService::open(&tmp.path().join("anki")).unwrap();
        Self { _tmp: tmp, svc }
    }
}

fn creds(url: &str, user: &str) -> SyncCredentials {
    let config = SyncConfig::new(local_only(url));
    let hkey = block_on(csync::login(&config, user, PASSWORD)).unwrap();
    SyncCredentials { config, hkey }
}

/// Uploads the fixture to an EMPTY server account (the first sync asks; upload explicitly).
fn seed_server(side: &Side, creds: &SyncCredentials) {
    let first = block_on(side.svc.sync(creds, true)).unwrap();
    assert!(
        matches!(
            first.outcome,
            SyncOutcome::FullSyncRequired(FullSyncChoice {
                upload_ok: true,
                download_ok: false
            })
        ),
        "server account not empty (run scripts/sync-test.sh): {first:?}"
    );
    let up = block_on(side.svc.sync_full(creds, FullSyncDirection::Upload)).unwrap();
    assert!(matches!(up.outcome, SyncOutcome::FullUploaded { .. }));
}

fn sql_i64(svc: &AnkiService, sql: &'static str) -> i64 {
    block_on(svc.call(move |col| {
        Ok(col
            .storage
            .db()
            .query_row(sql, [], |r| r.get::<_, i64>(0))
            .map_err(core_anki::anki::prelude::AnkiError::from)?)
    }))
    .unwrap()
}

fn has_deck(svc: &AnkiService, name: &str) -> bool {
    block_on(svc.deck_tree()).unwrap().find(name).is_some()
}

/// Every file under `dir`, recursively.
fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Answers the first card of the words deck through the app commands (the after-answer hook).
fn answer_one(app: &App) -> i64 {
    let deck = block_on(app.state.anki_deck_tree())
        .unwrap()
        .find(DECK_WORDS)
        .expect("words deck")
        .id;
    let StudyNext::Card { card } = block_on(app.state.anki_study_next(deck, None)).unwrap() else {
        panic!("no card to study");
    };
    block_on(app.state.anki_answer(card.card_id, 3, 4_000)).unwrap();
    card.card_id
}

#[test]
fn login_first_download_and_after_answer_sync() {
    let Some(env) = env() else { return };
    let user = "t9";
    let seed = Side::fixture();
    let seed_creds = creds(&env.url, user);
    seed_server(&seed, &seed_creds);

    let app = App::new(SyncTimings::fast());
    // A local deck that the first sync must discard (the server always wins the first time).
    block_on(app.state.anki_deck_create("Local descartável".into())).unwrap();
    let status = block_on(app.state.anki_sync_login(
        env.url.clone(),
        format!(" {user} "),
        PASSWORD.into(),
        None,
    ))
    .unwrap();
    assert!(status.logged_in && status.first_sync_pending);
    assert_eq!(status.state, SyncState::Syncing);
    let endpoint = local_only(&env.url);
    assert_eq!(status.url.as_deref(), Some(endpoint.as_str()));
    assert_eq!(status.user.as_deref(), Some(user));

    // The key lives only in the secret store, under the account.
    let account = sync_account(user, endpoint.as_str());
    assert_eq!(app.secrets.accounts(), vec![account.clone()]);
    let hkey = app.secrets.get(&account).unwrap().expect("hkey stored");
    assert!(hkey.len() >= 8);

    let status = app.wait_settled();
    assert_eq!(status.state, SyncState::Idle, "{status:?}");
    assert!(!status.first_sync_pending);
    let first_at = status.last_sync_at.expect("lastSyncAt");
    assert!(status.last_error.is_none() && status.media_error.is_none());
    let svc = app.svc();
    assert!(
        has_deck(&svc, DECK_WORDS),
        "downloaded the server's collection"
    );
    assert!(
        !has_deck(&svc, "Local descartável"),
        "local copy was discarded"
    );
    assert_eq!(app.changed(ChangeReason::SyncFull), 1);
    let backups = app.state.anki_backups().unwrap();
    assert_eq!(
        backups
            .iter()
            .filter(|b| b.kind == BackupKind::PreSync)
            .count(),
        1,
        "a backup before the first download"
    );
    let events = app.sync_events();
    assert!(events.iter().any(|s| s.state == SyncState::Syncing));
    assert_eq!(events.last().map(|s| s.state), Some(SyncState::Idle));

    // Neither the key nor the password reaches any file of the data dir.
    let needles: [(&str, &[u8]); 3] = [
        ("hkey", hkey.as_bytes()),
        ("password setting", b"\"test\""),
        ("password field", b"password"),
    ];
    for file in files_under(&app.data_dir()) {
        let bytes = std::fs::read(&file).unwrap();
        for (what, needle) in needles {
            assert!(
                !contains(&bytes, needle),
                "{what} found in {}",
                file.display()
            );
        }
    }
    let settings = app.state.with_store(|s| s.all_settings()).unwrap();
    let text = serde_json::to_string(&settings).unwrap();
    assert!(!text.contains(&hkey));

    // Answering a card syncs automatically (after-answer timer, fast timings).
    let cid = answer_one(&app);
    let status = app.wait("the after-answer sync", Duration::from_secs(30), |s| {
        s.state == SyncState::Idle && s.last_sync_at.is_some_and(|t| t > first_at)
    });
    assert!(status.last_error.is_none(), "{status:?}");
    // ... and the review reaches another device.
    let other = Side::empty();
    let down = block_on(other.svc.sync(&seed_creds, true)).unwrap();
    assert!(matches!(down.outcome, SyncOutcome::FullDownloaded { .. }));
    let reps = block_on(other.svc.call(move |col| {
        Ok(col
            .storage
            .db()
            .query_row("select reps from cards where id = ?", [cid], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(core_anki::anki::prelude::AnkiError::from)?)
    }))
    .unwrap();
    assert_eq!(reps, 1, "the review made in the app is on the server");
    assert!(sql_i64(&other.svc, "select count() from revlog") >= 1);

    // TLS with the dev CA: login and first download over HTTPS; untrusted without the CA.
    if let (Some(tls_url), Some(ca)) = (env.tls_url.as_deref(), env.ca.as_deref()) {
        let pem = std::fs::read_to_string(ca).unwrap();
        let tls = App::new(SyncTimings::fast());
        let err =
            block_on(
                tls.state
                    .anki_sync_login(tls_url.into(), user.into(), PASSWORD.into(), None),
            )
            .unwrap_err();
        assert_eq!(err.code, "anki_sync_tls_untrusted", "{err:?}");
        assert!(tls.secrets.accounts().is_empty());
        let status = block_on(tls.state.anki_sync_login(
            tls_url.into(),
            user.into(),
            PASSWORD.into(),
            Some(pem),
        ))
        .unwrap();
        assert!(status.certificate_fingerprint.is_some());
        let status = tls.wait_settled();
        assert_eq!(status.state, SyncState::Idle, "{status:?}");
        assert!(has_deck(&tls.svc(), DECK_WORDS));
        tls.state.anki_sync_logout().unwrap();
        // Logging in again without sending the certificate keeps using the saved one.
        let status =
            block_on(
                tls.state
                    .anki_sync_login(tls_url.into(), user.into(), PASSWORD.into(), None),
            )
            .unwrap();
        assert!(status.certificate_fingerprint.is_some());
        tls.wait_settled();
        tls.state.anki_sync_logout().unwrap();
    } else {
        println!("TLS part skipped: LEITOR_SYNC_TEST_TLS_URL / LEITOR_SYNC_TEST_CA not set");
    }

    // A refused key logs out and is deleted (no retries).
    app.secrets.set(&account, "chave-invalida-0000").unwrap();
    let status = block_on(app.state.anki_sync()).unwrap();
    assert_eq!(status.state, SyncState::Off, "{status:?}");
    assert_eq!(
        status.last_error.as_ref().map(|e| e.code.as_str()),
        Some("anki_sync_auth_failed")
    );
    assert_eq!(status.next_retry_at, None);
    assert!(app.secrets.accounts().is_empty());
}

#[test]
fn offline_then_online_retries() {
    let Some(env) = env() else { return };
    let user = "t10";
    let seed = Side::fixture();
    seed_server(&seed, &creds(&env.url, user));

    let target = {
        let ep = local_only(&env.url);
        let url = url_port(ep.as_str());
        format!("{}:{url}", ep.host())
    };
    let mut proxy = block_on(Proxy::start(0, target.clone()));
    let port = proxy.port;
    let via_proxy = format!("http://127.0.0.1:{port}/");

    // Long backoff: only the 'online' notification can bring the retry forward.
    let timings = SyncTimings {
        backoff: vec![600_000],
        ..SyncTimings::fast()
    };
    let app = App::new(timings);
    block_on(
        app.state
            .anki_sync_login(via_proxy.clone(), user.into(), PASSWORD.into(), None),
    )
    .unwrap();
    let status = app.wait_settled();
    assert_eq!(status.state, SyncState::Idle, "{status:?}");
    let first_at = status.last_sync_at.unwrap();

    // Network down: the review stays local, the state is Offline with a retry time.
    block_on(proxy.stop());
    answer_one(&app);
    let status = block_on(app.state.anki_sync()).unwrap();
    assert_eq!(status.state, SyncState::Offline, "{status:?}");
    assert_eq!(
        status.last_error.as_ref().map(|e| e.code.as_str()),
        Some("anki_sync_offline")
    );
    let retry = status.next_retry_at.expect("nextRetryAt");
    assert!(retry > core_store::now_ms() + 60_000, "long backoff");
    // Studying keeps working offline.
    assert!(block_on(app.state.anki_deck_tree()).is_ok());

    // Network back + 'online': synced right away.
    let _proxy = block_on(Proxy::start(port, target));
    app.state.anki_sync_notify(SyncNotice::Online).unwrap();
    let status = app.wait("the retry after 'online'", Duration::from_secs(30), |s| {
        s.state == SyncState::Idle && s.last_sync_at.is_some_and(|t| t > first_at)
    });
    assert!(status.last_error.is_none() && status.next_retry_at.is_none());
}

fn url_port(url: &str) -> u16 {
    let rest = url.split("://").nth(1).unwrap_or_default();
    let host_port = rest.split('/').next().unwrap_or_default();
    host_port
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse().ok())
        .unwrap_or(if url.starts_with("https") { 443 } else { 80 })
}

#[test]
fn full_sync_required_waits_for_the_user_and_never_uploads() {
    let Some(env) = env() else { return };
    let user = "t4";
    let seed = Side::fixture();
    let seed_creds = creds(&env.url, user);
    seed_server(&seed, &seed_creds);
    let server_cards = sql_i64(&seed.svc, "select count() from cards");

    let app = App::new(SyncTimings::fast());
    block_on(
        app.state
            .anki_sync_login(env.url.clone(), user.into(), PASSWORD.into(), None),
    )
    .unwrap();
    assert_eq!(app.wait_settled().state, SyncState::Idle);
    // The other device catches up, so any later change on the server would show.
    let mut settled = false;
    for _ in 0..5 {
        let report = block_on(seed.svc.sync(&seed_creds, false)).unwrap();
        if matches!(report.outcome, SyncOutcome::NoChanges) {
            settled = true;
            break;
        }
    }
    assert!(settled, "the other device never reached NoChanges");

    // A schema change on the app's collection: the next sync needs a full sync.
    block_on(app.svc().call(|col| {
        let mut nt = (*notetypes::stock_basic(col)?).clone();
        nt.fields.push(NoteField::new("Campo novo"));
        col.update_notetype(&mut nt, false)?;
        Ok(())
    }))
    .unwrap();
    let status = block_on(app.state.anki_sync()).unwrap();
    assert_eq!(status.state, SyncState::FullSyncRequired, "{status:?}");
    assert_eq!(
        status.full_sync,
        Some(FullSyncChoice {
            upload_ok: true,
            download_ok: true
        })
    );
    assert!(
        app.sync_events()
            .iter()
            .any(|s| s.state == SyncState::FullSyncRequired)
    );

    // Answers, tab changes, 'online' and several periodic ticks: the scheduler never uploads.
    answer_one(&app);
    for n in [
        SyncNotice::TabEntered,
        SyncNotice::Visible,
        SyncNotice::Online,
    ] {
        app.state.anki_sync_notify(n).unwrap();
    }
    std::thread::sleep(Duration::from_millis(
        3 * SyncTimings::fast().periodic as u64 + 500,
    ));
    let status = app.status();
    assert_eq!(status.state, SyncState::FullSyncRequired);
    let no_changes = block_on(seed.svc.sync(&seed_creds, false)).unwrap();
    assert!(
        matches!(no_changes.outcome, SyncOutcome::NoChanges),
        "the server collection changed: {no_changes:?}"
    );
    assert_eq!(
        sql_i64(&seed.svc, "select count() from cards"),
        server_cards
    );
    let has_field = |svc: &AnkiService| {
        block_on(svc.call(|col| {
            let nt = notetypes::stock_basic(col)?;
            Ok(nt.fields.iter().any(|f| f.name == "Campo novo"))
        }))
        .unwrap()
    };
    assert!(
        has_field(&app.svc()),
        "nothing downloaded on its own either"
    );

    // The user chooses "Baixar do servidor": PreSync backup, collection replaced.
    let before = app.changed(ChangeReason::SyncFull);
    let result = block_on(app.state.anki_sync_full(FullSyncDirection::Download)).unwrap();
    assert_eq!(result.backup.kind, BackupKind::PreSync);
    assert!(Path::new(&result.backup.path).is_file());
    assert!(
        result
            .backup
            .file_name
            .starts_with("antes-da-sincronizacao-")
    );
    assert_eq!(result.status.state, SyncState::Idle, "{:?}", result.status);
    assert_eq!(result.status.full_sync, None);
    assert!(!has_field(&app.svc()));
    assert_eq!(app.changed(ChangeReason::SyncFull), before + 1);
    // Back to normal syncs.
    let status = block_on(app.state.anki_sync()).unwrap();
    assert_eq!(status.state, SyncState::Idle, "{status:?}");
}

// ---------------------------------------------------------------------------------------------
// A TCP proxy that can be stopped and restarted on the same port (offline simulation).

struct Proxy {
    port: u16,
    tasks: Option<Arc<tokio::sync::Mutex<JoinSet<()>>>>,
    accept: Option<tokio::task::JoinHandle<()>>,
}

impl Proxy {
    async fn start(port: u16, target: String) -> Self {
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_reuseaddr(true).unwrap();
        socket.bind(([127, 0, 0, 1], port).into()).unwrap();
        let listener: TcpListener = socket.listen(64).unwrap();
        let port = listener.local_addr().unwrap().port();
        let tasks = Arc::new(tokio::sync::Mutex::new(JoinSet::new()));
        let conns = Arc::clone(&tasks);
        let accept = tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let target = target.clone();
                conns.lock().await.spawn(async move {
                    if let Ok(mut outbound) = TcpStream::connect(&target).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                });
            }
        });
        Self {
            port,
            tasks: Some(tasks),
            accept: Some(accept),
        }
    }

    /// Closes the listener and every open connection.
    async fn stop(&mut self) {
        if let Some(accept) = self.accept.take() {
            accept.abort();
            let _ = accept.await;
        }
        if let Some(tasks) = self.tasks.take() {
            tasks.lock().await.shutdown().await;
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        if let Some(accept) = self.accept.take() {
            accept.abort();
        }
    }
}
