//! Sync against the LOCAL official Anki sync server (compose.dev.yml), docs/PROJETO.md 9 and 21.
//!
//! Run with `scripts/sync-test.sh core-anki` (it recreates the server empty and sets the env vars
//! below inside the dev container on the `leitor-dev` network). Without `LEITOR_SYNC_TEST_URL`
//! every test is skipped, so `cargo test --workspace` stays offline.
//!
//! - `LEITOR_SYNC_TEST_URL` — plain HTTP server (`http://ankisync-dev:8080/`)
//! - `LEITOR_SYNC_TEST_TLS_URL` — same server behind TLS with the dev CA (`https://ankisync-dev-tls:8443/`)
//! - `LEITOR_SYNC_TEST_CA` / `LEITOR_SYNC_TEST_UNTRUSTED_CA` — PEM files of the dev CA and of an
//!   unrelated CA.
//!
//! Hard rule: only the local test server. Any other host makes the tests panic before a request.
//! Each test uses its own account (password `test`) and starts by checking it is empty. Accounts
//! used here: t1 (login + TLS, the server collection stays empty until the TLS test uploads),
//! t2, t3, t5, t6, t7, t8, t13 and t12 (left with a review for the official-client crosscheck).
//! t4, t9, t10, t14 are free for the app suite; t11 belongs to the Python crosscheck.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anki::notetype::NoteField;
use anki::sync::collection::meta::MetaRequest;
use anki::sync::collection::protocol::SyncProtocol;
use anki::sync::http_client::HttpSyncClient;
use anki::sync::login::SyncAuth;
use core_anki::backup;
use core_anki::fixture::{self, DECK_WORDS};
use core_anki::notes::{self, NewNote};
use core_anki::notetypes::{self, APP_NOTETYPES};
use core_anki::study::{Study, StudyNext};
use core_anki::sync::{self as csync, DEFAULT_IO_TIMEOUT_SECS};
use core_anki::{
    AnkiService, BackupKind, Error, FullSyncChoice, FullSyncDirection, SyncConfig, SyncCredentials,
    SyncEndpoint, SyncFailure, SyncOutcome, SyncReport, anki,
};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::task::JoinSet;

use common::sql_i64;

const PASSWORD: &str = "test";
const ALLOWED_HOSTS: [&str; 4] = ["ankisync-dev", "ankisync-dev-tls", "localhost", "127.0.0.1"];

// ---------------------------------------------------------------------------------------------
// Environment and safety guard

struct Env {
    url: String,
    tls_url: Option<String>,
    ca: Option<PathBuf>,
    untrusted_ca: Option<PathBuf>,
}

fn env() -> Option<Env> {
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let Some(url) = var("LEITOR_SYNC_TEST_URL") else {
        println!("skipped: LEITOR_SYNC_TEST_URL not set (run scripts/sync-test.sh)");
        return None;
    };
    let env = Env {
        url,
        tls_url: var("LEITOR_SYNC_TEST_TLS_URL"),
        ca: var("LEITOR_SYNC_TEST_CA").map(PathBuf::from),
        untrusted_ca: var("LEITOR_SYNC_TEST_UNTRUSTED_CA").map(PathBuf::from),
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
        "refusing to run sync tests against {url}: only the local test server ({ALLOWED_HOSTS:?}) \
         may be used"
    );
    ep
}

fn config(url: &str, ca: Option<&Path>) -> SyncConfig {
    let mut cfg = SyncConfig::new(local_only(url));
    cfg.ca_cert_pem = ca
        .map(|p| std::fs::read_to_string(p).unwrap_or_else(|e| panic!("CA {}: {e}", p.display())));
    cfg
}

async fn login(cfg: &SyncConfig, user: &str) -> anyhow::Result<SyncCredentials> {
    let hkey = csync::login(cfg, user, PASSWORD).await?;
    Ok(SyncCredentials {
        config: cfg.clone(),
        hkey,
    })
}

/// The server's own `meta` for the account (`empty` = no cards on the server).
async fn server_is_empty(creds: &SyncCredentials) -> anyhow::Result<bool> {
    let mut builder = reqwest::Client::builder().use_rustls_tls().http1_only();
    if let Some(pem) = &creds.config.ca_cert_pem {
        builder = builder.add_root_certificate(reqwest::Certificate::from_pem(pem.as_bytes())?);
    }
    let auth = SyncAuth::try_from(anki_proto::sync::SyncAuth {
        hkey: creds.hkey.clone(),
        endpoint: Some(creds.config.endpoint.as_str().to_owned()),
        io_timeout_secs: Some(DEFAULT_IO_TIMEOUT_SECS),
    })?;
    assert!(auth.endpoint.is_some());
    let client = HttpSyncClient::new(auth, builder.build()?);
    let meta = client
        .meta(MetaRequest::request())
        .await
        .map_err(|e| anyhow::anyhow!("meta: {e:?}"))?
        .json()?;
    Ok(meta.empty)
}

async fn assert_clean(creds: &SyncCredentials) -> anyhow::Result<()> {
    assert!(
        server_is_empty(creds).await?,
        "servidor de teste não está limpo: rode scripts/sync-test.sh"
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Local collections

struct Side {
    _tmp: TempDir,
    svc: AnkiService,
}

impl Side {
    fn dir(&self) -> PathBuf {
        self.svc.paths().dir().to_path_buf()
    }

    fn pre_sync_backups(&self) -> anyhow::Result<usize> {
        Ok(backup::list(&backup::backups_dir(self.svc.paths()))?
            .iter()
            .filter(|b| b.kind == BackupKind::PreSync)
            .count())
    }

    async fn i64(&self, sql: &'static str) -> anyhow::Result<i64> {
        Ok(self.svc.call(move |col| sql_i64(col, sql)).await?)
    }

    async fn deck_names(&self) -> anyhow::Result<Vec<String>> {
        Ok(self.svc.call(common::deck_names).await?)
    }
}

/// The fixture collection (decks, notes, media) in a fresh temp dir.
fn fixture_side() -> anyhow::Result<Side> {
    let tmp = tempfile::tempdir()?;
    let dir = tmp.path().join("anki");
    fixture::build(&dir, Default::default())?;
    let svc = AnkiService::open(&dir)?;
    Ok(Side { _tmp: tmp, svc })
}

fn empty_side() -> anyhow::Result<Side> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(&tmp.path().join("anki"))?;
    Ok(Side { _tmp: tmp, svc })
}

/// Adds a stock Basic note to the Default deck; returns its id.
async fn add_basic(side: &Side, front: &str) -> anyhow::Result<i64> {
    let front = front.to_owned();
    Ok(side
        .svc
        .call(move |col| {
            let nt = notetypes::stock_basic(col)?;
            let added = notes::add(
                col,
                NewNote {
                    notetype_id: nt.id.0,
                    deck_id: 1,
                    fields: vec![front, "verso".into()],
                    tags: vec![],
                },
            )?;
            Ok(added.note_id)
        })
        .await?)
}

async fn count_notes(side: &Side, search: &str) -> anyhow::Result<usize> {
    let search = search.to_owned();
    Ok(side
        .svc
        .call(move |col| Ok(col.search_notes_unordered(search.as_str())?.len()))
        .await?)
}

/// Answers the first card of the words deck with Good; returns the card id.
async fn answer_one(side: &Side) -> anyhow::Result<i64> {
    let deck = side
        .svc
        .deck_tree()
        .await?
        .find(DECK_WORDS)
        .expect("words deck")
        .id;
    let study = Study::new(side.svc.clone());
    let StudyNext::Card { card } = study.next(deck).await? else {
        panic!("no card to study");
    };
    let cid = card.card_id;
    study.answer(cid, 3, 4_000).await?;
    study.close();
    Ok(cid)
}

async fn card_state(side: &Side, cid: i64) -> anyhow::Result<(i64, i64, i64, i64)> {
    Ok(side
        .svc
        .call(move |col| {
            Ok(col
                .storage
                .db()
                .query_row(
                    "select due, ivl, queue, type from cards where id = ?",
                    [cid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .map_err(anki::prelude::AnkiError::from)?)
        })
        .await?)
}

fn sync_kind(res: &core_anki::Result<SyncReport>) -> Option<SyncFailure> {
    match res {
        Err(Error::Sync { kind, .. }) => Some(*kind),
        _ => None,
    }
}

fn expect_choice(report: &SyncReport, upload_ok: bool, download_ok: bool) {
    match report.outcome {
        SyncOutcome::FullSyncRequired(choice) => assert_eq!(
            choice,
            FullSyncChoice {
                upload_ok,
                download_ok
            }
        ),
        ref other => panic!("expected FullSyncRequired, got {other:?}"),
    }
    assert!(!report.collection_changed);
}

/// Puts `side`'s collection on an empty server account: the first sync must ask (server empty,
/// never an automatic upload), then the explicit upload.
async fn seed_server(side: &Side, creds: &SyncCredentials) -> anyhow::Result<()> {
    let first = side.svc.sync(creds, true).await?;
    expect_choice(&first, true, false);
    let up = side.svc.sync_full(creds, FullSyncDirection::Upload).await?;
    assert!(
        matches!(up.outcome, SyncOutcome::FullUploaded { .. }),
        "{up:?}"
    );
    assert!(up.media_error.is_none(), "{:?}", up.media_error);
    Ok(())
}

async fn download_into(side: &Side, creds: &SyncCredentials) -> anyhow::Result<()> {
    let report = side.svc.sync(creds, true).await?;
    assert!(
        matches!(report.outcome, SyncOutcome::FullDownloaded { .. }),
        "{report:?}"
    );
    assert!(report.media_error.is_none(), "{:?}", report.media_error);
    Ok(())
}

async fn expect_normal(side: &Side, creds: &SyncCredentials) -> anyhow::Result<SyncReport> {
    let report = side.svc.sync(creds, false).await?;
    assert!(matches!(report.outcome, SyncOutcome::Normal), "{report:?}");
    assert!(report.collection_changed);
    assert!(report.media_error.is_none(), "{:?}", report.media_error);
    Ok(report)
}

// ---------------------------------------------------------------------------------------------
// Tests

#[tokio::test]
async fn login_ok_and_wrong_password_is_auth_failed() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let cfg = config(&env.url, None);
    let hkey = csync::login(&cfg, "t1", PASSWORD).await?;
    assert!(!hkey.is_empty());
    assert_ne!(hkey, PASSWORD);

    let wrong = "senha-errada-xyz";
    let err = csync::login(&cfg, "t1", wrong)
        .await
        .expect_err("wrong password");
    assert_eq!(err.code(), "anki.sync.authFailed", "{err}");
    let shown = format!("{err} {err:?} {}", serde_json::to_string(&err)?);
    assert!(!shown.contains(wrong), "password leaked: {shown}");

    let err = csync::login(&cfg, "", PASSWORD)
        .await
        .expect_err("empty user");
    assert_eq!(err.code(), "anki.invalidInput");
    let err = csync::login(&cfg, "t1", "")
        .await
        .expect_err("empty password");
    assert_eq!(err.code(), "anki.invalidInput");
    Ok(())
}

#[tokio::test]
async fn first_sync_always_downloads() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let creds = login(&config(&env.url, None), "t2").await?;
    assert_clean(&creds).await?;
    let a = fixture_side()?;
    seed_server(&a, &creds).await?;
    assert_eq!(a.pre_sync_backups()?, 1, "backup before the upload");

    // B is a disposable local collection (like an imported .colpkg) with a note of its own.
    let b = fixture_side()?;
    add_basic(&b, "somente-local-B").await?;
    assert_eq!(count_notes(&b, "somente-local-B").await?, 1);
    let report = b.svc.sync(&creds, true).await?;
    let SyncOutcome::FullDownloaded { backup } = &report.outcome else {
        panic!("first sync must download: {report:?}");
    };
    assert_eq!(backup.kind, BackupKind::PreSync);
    assert!(Path::new(&backup.path).is_file());
    assert!(
        backup
            .path
            .starts_with(&b.dir().to_string_lossy().into_owned())
    );
    assert!(report.collection_changed);

    const CARDS: &str = "select count() from cards";
    assert_eq!(b.i64(CARDS).await?, a.i64(CARDS).await?);
    assert_eq!(b.deck_names().await?, a.deck_names().await?);
    assert_eq!(
        count_notes(&b, "somente-local-B").await?,
        0,
        "local note replaced"
    );
    // Both sides agree now.
    let report = b.svc.sync(&creds, false).await?;
    assert!(
        matches!(report.outcome, SyncOutcome::NoChanges),
        "{report:?}"
    );
    // Reopening after the upload (rslib closes it as schema 18 and the reopen upgrades it) may
    // leave A with a harmless no-op normal sync; after that everything is settled.
    let report = a.svc.sync(&creds, false).await?;
    assert!(
        matches!(report.outcome, SyncOutcome::NoChanges | SyncOutcome::Normal),
        "{report:?}"
    );
    for side in [&a, &b, &a] {
        let report = side.svc.sync(&creds, false).await?;
        assert!(
            matches!(report.outcome, SyncOutcome::NoChanges | SyncOutcome::Normal),
            "{report:?}"
        );
    }
    let report = a.svc.sync(&creds, false).await?;
    assert!(
        matches!(report.outcome, SyncOutcome::NoChanges),
        "{report:?}"
    );
    assert_eq!(b.i64(CARDS).await?, a.i64(CARDS).await?);
    Ok(())
}

#[tokio::test]
async fn server_empty_first_sync_never_uploads() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let creds = login(&config(&env.url, None), "t3").await?;
    assert_clean(&creds).await?;
    let a = fixture_side()?;
    for first_sync in [true, false, true] {
        let report = a.svc.sync(&creds, first_sync).await?;
        expect_choice(&report, true, false);
        assert!(server_is_empty(&creds).await?, "nothing was uploaded");
    }
    assert_eq!(a.pre_sync_backups()?, 0, "nothing happened locally either");
    Ok(())
}

#[tokio::test]
async fn review_on_a_appears_on_b() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    // t12: the review stays on the server for the official-client crosscheck.
    let creds = login(&config(&env.url, None), "t12").await?;
    assert_clean(&creds).await?;
    let a = fixture_side()?;
    seed_server(&a, &creds).await?;
    let b = empty_side()?;
    download_into(&b, &creds).await?;

    let cid = answer_one(&a).await?;
    let before_b = card_state(&b, cid).await?;
    expect_normal(&a, &creds).await?;
    expect_normal(&b, &creds).await?;
    let state = card_state(&b, cid).await?;
    assert_eq!(state, card_state(&a, cid).await?);
    assert_ne!(state, before_b, "B got the new scheduling");
    const LAST_REVIEW: &str = "select coalesce(max(id), 0) from revlog";
    let revlog = a.i64(LAST_REVIEW).await?;
    assert!(revlog > 0);
    assert_eq!(b.i64(LAST_REVIEW).await?, revlog, "same revlog entry");
    Ok(())
}

#[tokio::test]
async fn note_with_media_a_to_b() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let creds = login(&config(&env.url, None), "t5").await?;
    assert_clean(&creds).await?;
    let a = empty_side()?;
    let bytes: Vec<u8> = (0..4096u32).map(|i| (i * 7 % 251) as u8).collect();
    let data = bytes.clone();
    let name = a
        .svc
        .call(move |col| core_anki::media::add(col, "sincronizada.png", &data))
        .await?;
    add_basic(&a, &format!("nota com imagem <img src=\"{name}\">")).await?;
    seed_server(&a, &creds).await?;

    let b = empty_side()?;
    download_into(&b, &creds).await?;
    let copied = std::fs::read(b.svc.paths().media_folder.join(&name))?;
    assert_eq!(copied, bytes, "byte-identical media");
    assert_eq!(count_notes(&b, "nota com imagem").await?, 1);

    // A second file added later travels with a normal sync.
    let more = b"segundo arquivo".repeat(100);
    let data = more.clone();
    let second = a
        .svc
        .call(move |col| core_anki::media::add(col, "depois.png", &data))
        .await?;
    add_basic(&a, &format!("outra <img src=\"{second}\">")).await?;
    expect_normal(&a, &creds).await?;
    expect_normal(&b, &creds).await?;
    assert_eq!(
        std::fs::read(b.svc.paths().media_folder.join(&second))?,
        more
    );
    Ok(())
}

#[tokio::test]
async fn conflicting_schema_requires_full_sync() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let creds = login(&config(&env.url, None), "t6").await?;
    assert_clean(&creds).await?;
    let a = fixture_side()?;
    seed_server(&a, &creds).await?;
    let b = empty_side()?;
    download_into(&b, &creds).await?;

    // Schema change on A: a new field on the stock Basic notetype.
    a.svc
        .call(|col| {
            let mut nt = (*notetypes::stock_basic(col)?).clone();
            nt.fields.push(NoteField::new("Campo novo"));
            col.update_notetype(&mut nt, false)?;
            Ok(())
        })
        .await?;
    let report = a.svc.sync(&creds, false).await?;
    expect_choice(&report, true, true);
    // Nothing was sent: B sees no change.
    assert!(matches!(
        b.svc.sync(&creds, false).await?.outcome,
        SyncOutcome::NoChanges
    ));

    let backups_a = a.pre_sync_backups()?;
    let up = a.svc.sync_full(&creds, FullSyncDirection::Upload).await?;
    let SyncOutcome::FullUploaded { backup } = &up.outcome else {
        panic!("{up:?}");
    };
    assert!(Path::new(&backup.path).is_file());
    assert_eq!(a.pre_sync_backups()?, backups_a + 1);

    // B now has to choose; nothing changes until it does.
    let report = b.svc.sync(&creds, false).await?;
    expect_choice(&report, true, true);
    let backups_b = b.pre_sync_backups()?;
    let down = b.svc.sync_full(&creds, FullSyncDirection::Download).await?;
    assert!(
        matches!(down.outcome, SyncOutcome::FullDownloaded { .. }),
        "{down:?}"
    );
    assert_eq!(b.pre_sync_backups()?, backups_b + 1);
    let has_field = b
        .svc
        .call(|col| {
            let nt = notetypes::stock_basic(col)?;
            Ok(nt.fields.iter().any(|f| f.name == "Campo novo"))
        })
        .await?;
    assert!(has_field);
    assert!(matches!(
        b.svc.sync(&creds, false).await?.outcome,
        SyncOutcome::NoChanges
    ));
    Ok(())
}

#[tokio::test]
async fn prepare_collection_does_not_force_full_sync() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let creds = login(&config(&env.url, None), "t7").await?;
    assert_clean(&creds).await?;
    let a = empty_side()?;
    add_basic(&a, "antes de preparar").await?;
    seed_server(&a, &creds).await?;
    let b = empty_side()?;
    download_into(&b, &creds).await?;

    let report = a.svc.call(notetypes::prepare_collection).await?;
    assert_eq!(report.created.len(), APP_NOTETYPES.len());
    expect_normal(&a, &creds).await?;
    expect_normal(&b, &creds).await?;
    let on_b = b.svc.call(notetypes::prepare_collection).await?;
    assert!(
        on_b.created.is_empty(),
        "B received the notetypes: {on_b:?}"
    );
    assert_eq!(on_b.existing.len(), APP_NOTETYPES.len());
    // Running it again on B changes nothing and still needs no full sync.
    assert!(matches!(
        b.svc.sync(&creds, false).await?.outcome,
        SyncOutcome::NoChanges
    ));
    Ok(())
}

#[tokio::test]
async fn offline_then_reconnect() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let direct = config(&env.url, None);
    let creds = login(&direct, "t8").await?;
    assert_clean(&creds).await?;
    let target = {
        let ep = SyncEndpoint::parse(&env.url)?;
        let url = url::Url::parse(ep.as_str())?;
        format!(
            "{}:{}",
            ep.host(),
            url.port_or_known_default().unwrap_or(80)
        )
    };

    let mut proxy = Proxy::start(0, target.clone(), Mode::Forward).await?;
    let mut via_proxy = creds.clone();
    via_proxy.config = config(&format!("http://127.0.0.1:{}/", proxy.port), None);
    via_proxy.config.io_timeout_secs = 5;

    let a = fixture_side()?;
    seed_server(&a, &via_proxy).await?;
    let b = empty_side()?;
    download_into(&b, &creds).await?;

    // Network down: a review is made offline and the sync fails fast with Offline.
    let port = proxy.port;
    proxy.stop().await;
    let cid = answer_one(&a).await?;
    let started = Instant::now();
    let res = a.svc.sync(&via_proxy, false).await;
    assert_eq!(sync_kind(&res), Some(SyncFailure::Offline), "{res:?}");
    assert!(SyncFailure::Offline.is_transient());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );

    // A server that accepts but never answers: the sync waits on the network, the collection
    // stays usable, and abort_sync stops it.
    let hang = Proxy::start(port, target.clone(), Mode::Blackhole).await?;
    let svc = a.svc.clone();
    let creds_hang = via_proxy.clone();
    let pending = tokio::spawn(async move { svc.sync(&creds_hang, false).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(a.svc.sync_running());
    let started = Instant::now();
    let tree = a.svc.deck_tree().await?;
    assert!(tree.find(DECK_WORDS).is_some());
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "actor blocked during the network check: {:?}",
        started.elapsed()
    );
    let busy = a.svc.sync(&via_proxy, false).await;
    assert_eq!(sync_kind(&busy), Some(SyncFailure::Busy));
    a.svc.abort_sync();
    let res = tokio::time::timeout(Duration::from_secs(5), pending).await??;
    assert_eq!(sync_kind(&res), Some(SyncFailure::Aborted), "{res:?}");
    assert!(!a.svc.sync_running());
    hang.stop_owned().await;

    // Network back on the same address: the pending review goes up and reaches B.
    let _proxy = Proxy::start(port, target.clone(), Mode::Forward).await?;
    expect_normal(&a, &via_proxy).await?;
    expect_normal(&b, &creds).await?;
    assert_eq!(card_state(&b, cid).await?, card_state(&a, cid).await?);

    // abort_sync while the normal sync waits in the actor queue (behind a slow job, e.g. a
    // backup): it must not run later with the old hkey (logout/quit). A slow network check
    // lets the slow job take the actor first.
    let cid = answer_one(&a).await?;
    let slow = Proxy::start(0, target, Mode::Delay(Duration::from_millis(600))).await?;
    let mut via_slow = via_proxy.clone();
    via_slow.config = config(&format!("http://127.0.0.1:{}/", slow.port), None);
    let svc = a.svc.clone();
    let pending = tokio::spawn(async move { svc.sync(&via_slow, false).await });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let blocker = a.svc.call(|_| {
        std::thread::sleep(Duration::from_millis(1800));
        Ok(())
    });
    let abort_later = async {
        tokio::time::sleep(Duration::from_millis(1100)).await;
        a.svc.abort_sync();
    };
    let ((), blocked) = tokio::join!(abort_later, blocker);
    blocked?;
    let res = tokio::time::timeout(Duration::from_secs(10), pending).await??;
    assert_eq!(sync_kind(&res), Some(SyncFailure::Aborted), "{res:?}");
    slow.stop_owned().await;
    // Nothing was exchanged: B still has the old state, and A's next sync uploads the review.
    let before = card_state(&b, cid).await?;
    b.svc.sync(&creds, false).await?;
    assert_eq!(card_state(&b, cid).await?, before);
    expect_normal(&a, &via_proxy).await?;
    expect_normal(&b, &creds).await?;
    assert_eq!(card_state(&b, cid).await?, card_state(&a, cid).await?);
    Ok(())
}

/// A connection dropped in the middle of the first full download (CI run 40085887656 through
/// the TLS proxy): a transient Offline failure, the local collection intact and usable (rslib
/// only replaces it after the whole download was written to a temp file and checked), the
/// `PreSync` backup restorable, nothing uploaded, and the next attempt downloads.
#[tokio::test]
async fn dropped_download_keeps_the_collection_and_retries() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let creds = login(&config(&env.url, None), "t13").await?;
    assert_clean(&creds).await?;
    let a = fixture_side()?;
    seed_server(&a, &creds).await?;

    let cutter = Cutter::new(CUT_AFTER_BYTES, 1);
    let proxy = Proxy::start(0, target_of(&env.url)?, Mode::Cut(Arc::clone(&cutter))).await?;
    let mut via_proxy = creds.clone();
    via_proxy.config = config(&format!("http://127.0.0.1:{}/", proxy.port), None);
    via_proxy.config.io_timeout_secs = 5;

    // B: a local collection with a note of its own; the first sync downloads over it.
    const CARDS: &str = "select count() from cards";
    let b = fixture_side()?;
    add_basic(&b, "somente-local-B").await?;
    let cards_before = b.i64(CARDS).await?;
    let res = b.svc.sync(&via_proxy, true).await;
    assert_eq!(cutter.done(), 1, "the proxy cut the download: {res:?}");
    assert_eq!(sync_kind(&res), Some(SyncFailure::Offline), "{res:?}");
    assert!(SyncFailure::Offline.is_transient());
    let Err(err) = &res else { unreachable!() };
    assert_eq!(
        err.to_string(),
        "Sem conexão com o servidor de sincronização."
    );
    assert!(!b.svc.sync_running());

    // The local collection is untouched, open and consistent; no temp file left behind.
    assert_eq!(count_notes(&b, "somente-local-B").await?, 1);
    assert_eq!(b.i64(CARDS).await?, cards_before);
    let integrity: String = b
        .svc
        .call(|col| {
            Ok(col
                .storage
                .db()
                .query_row("pragma integrity_check", [], |r| r.get(0))
                .map_err(anki::prelude::AnkiError::from)?)
        })
        .await?;
    assert_eq!(integrity, "ok");
    assert!(b.svc.deck_tree().await?.find(DECK_WORDS).is_some());
    let leftovers: Vec<_> = std::fs::read_dir(b.dir())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // The backup taken before the download is a restorable copy of the local collection.
    let backups: Vec<_> = backup::list(&backup::backups_dir(b.svc.paths()))?
        .into_iter()
        .filter(|x| x.kind == BackupKind::PreSync)
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    let restored = empty_side()?;
    restored
        .svc
        .import_colpkg(Path::new(&backups[0].path))
        .await?;
    assert_eq!(count_notes(&restored, "somente-local-B").await?, 1);

    // Nothing was uploaded: the server still has A's collection.
    let c = empty_side()?;
    download_into(&c, &creds).await?;
    assert_eq!(count_notes(&c, "somente-local-B").await?, 0);
    assert_eq!(c.i64(CARDS).await?, a.i64(CARDS).await?);

    // The retry (still a first sync) downloads through the same proxy.
    let report = b.svc.sync(&via_proxy, true).await?;
    assert!(
        matches!(report.outcome, SyncOutcome::FullDownloaded { .. }),
        "{report:?}"
    );
    assert_eq!(cutter.done(), 1);
    assert_eq!(count_notes(&b, "somente-local-B").await?, 0);
    assert_eq!(b.i64(CARDS).await?, a.i64(CARDS).await?);
    assert_eq!(b.deck_names().await?, a.deck_names().await?);
    assert_eq!(b.pre_sync_backups()?, 2, "one backup per download attempt");
    proxy.stop_owned().await;
    Ok(())
}

/// `host:port` of the server behind `url`, for the proxies.
fn target_of(url: &str) -> anyhow::Result<String> {
    let ep = SyncEndpoint::parse(url)?;
    let parsed = url::Url::parse(ep.as_str())?;
    Ok(format!(
        "{}:{}",
        ep.host(),
        parsed.port_or_known_default().unwrap_or(80)
    ))
}

#[tokio::test]
async fn tls_with_dev_ca_logs_in_and_syncs() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let (Some(tls_url), Some(ca)) = (env.tls_url.as_deref(), env.ca.as_deref()) else {
        println!("skipped: LEITOR_SYNC_TEST_TLS_URL / LEITOR_SYNC_TEST_CA not set");
        return Ok(());
    };
    let cfg = config(tls_url, Some(ca));
    assert!(cfg.endpoint.is_https());
    let info = csync::validate_certificate(cfg.ca_cert_pem.as_deref().expect("pem"))?;
    assert_eq!(info.fingerprint_sha256.len(), 32 * 3 - 1);
    let creds = login(&cfg, "t1").await?;
    assert_clean(&creds).await?;
    let a = fixture_side()?;
    seed_server(&a, &creds).await?;
    let b = empty_side()?;
    download_into(&b, &creds).await?;
    const CARDS: &str = "select count() from cards";
    assert_eq!(b.i64(CARDS).await?, a.i64(CARDS).await?);
    let media = std::fs::read_dir(&b.svc.paths().media_folder)?.count();
    assert!(media > 0, "media came over TLS too");
    Ok(())
}

#[tokio::test]
async fn tls_without_ca_or_with_untrusted_ca_is_rejected() -> anyhow::Result<()> {
    let Some(env) = env() else { return Ok(()) };
    let Some(tls_url) = env.tls_url.as_deref() else {
        println!("skipped: LEITOR_SYNC_TEST_TLS_URL not set");
        return Ok(());
    };
    let mut cases = vec![("no CA", config(tls_url, None))];
    if let Some(untrusted) = env.untrusted_ca.as_deref() {
        cases.push(("untrusted CA", config(tls_url, Some(untrusted))));
    }
    for (label, cfg) in cases {
        let err = csync::login(&cfg, "t1", PASSWORD).await.expect_err(label);
        assert_eq!(err.code(), "anki.sync.tlsUntrusted", "{label}: {err}");
        assert!(err.to_string().contains("Anki e sincronização"), "{err}");
        // A sync with a (made-up) hkey fails the same way, without touching the collection.
        let side = empty_side()?;
        let creds = SyncCredentials {
            config: cfg,
            hkey: "x".repeat(40),
        };
        let res = side.svc.sync(&creds, true).await;
        assert_eq!(
            sync_kind(&res),
            Some(SyncFailure::TlsUntrusted),
            "{label}: {res:?}"
        );
        assert!(!SyncFailure::TlsUntrusted.is_transient());
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// A TCP proxy that can be stopped and restarted on the same port (offline simulation).

#[derive(Clone)]
enum Mode {
    Forward,
    /// Accepts connections and never answers.
    Blackhole,
    /// Forwards, after waiting this long on each new connection.
    Delay(Duration),
    /// Forwards, but closes a connection once the server sent it more than the cutter's limit
    /// (only the full download is that big), as long as the cutter has cuts left.
    Cut(Arc<Cutter>),
}

/// Response bytes after which [`Mode::Cut`] drops a connection: more than any small sync
/// request (meta, login, the diagnosis), less than the fixture collection.
const CUT_AFTER_BYTES: usize = 2048;

/// How many connections [`Mode::Cut`] still drops, and how many it dropped.
struct Cutter {
    after: usize,
    left: AtomicUsize,
    done: AtomicUsize,
}

impl Cutter {
    fn new(after: usize, cuts: usize) -> Arc<Self> {
        Arc::new(Self {
            after,
            left: AtomicUsize::new(cuts),
            done: AtomicUsize::new(0),
        })
    }

    fn done(&self) -> usize {
        self.done.load(Ordering::SeqCst)
    }

    /// Takes one cut, if any is left.
    fn take(&self) -> bool {
        self.left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
    }

    /// Relays both ways; the server → client side stops after `after` bytes when a cut is
    /// taken, and then both sockets are closed in the middle of the response.
    async fn relay(&self, inbound: TcpStream, outbound: TcpStream) {
        let (mut in_read, mut in_write) = inbound.into_split();
        let (mut out_read, mut out_write) = outbound.into_split();
        let upstream = async {
            let _ = tokio::io::copy(&mut in_read, &mut out_write).await;
            let _ = out_write.shutdown().await;
        };
        let downstream = async {
            let mut buf = vec![0u8; 8192];
            let mut sent = 0usize;
            loop {
                let n = match out_read.read(&mut buf).await {
                    Ok(0) | Err(_) => return false,
                    Ok(n) => n,
                };
                if sent + n > self.after && self.take() {
                    let keep = self.after.saturating_sub(sent);
                    let _ = in_write.write_all(&buf[..keep]).await;
                    let _ = in_write.flush().await;
                    self.done.fetch_add(1, Ordering::SeqCst);
                    return true;
                }
                if in_write.write_all(&buf[..n]).await.is_err() {
                    return false;
                }
                sent += n;
            }
        };
        tokio::pin!(upstream);
        tokio::pin!(downstream);
        tokio::select! {
            // Cut (or the server closed): returning drops every half, closing both sockets.
            _ = &mut downstream => {}
            // The client finished sending: keep relaying the answer.
            () = &mut upstream => {
                let _ = (&mut downstream).await;
            }
        }
    }
}

struct Proxy {
    port: u16,
    tasks: Option<Arc<tokio::sync::Mutex<JoinSet<()>>>>,
    accept: Option<tokio::task::JoinHandle<()>>,
}

impl Proxy {
    async fn start(port: u16, target: String, mode: Mode) -> anyhow::Result<Self> {
        let socket = TcpSocket::new_v4()?;
        socket.set_reuseaddr(true)?;
        socket.bind(([127, 0, 0, 1], port).into())?;
        let listener: TcpListener = socket.listen(64)?;
        let port = listener.local_addr()?.port();
        let tasks = Arc::new(tokio::sync::Mutex::new(JoinSet::new()));
        let conns = Arc::clone(&tasks);
        let accept = tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let target = target.clone();
                let mode = mode.clone();
                conns.lock().await.spawn(async move {
                    if let Mode::Delay(wait) = mode {
                        tokio::time::sleep(wait).await;
                    }
                    match mode {
                        Mode::Cut(cutter) => {
                            if let Ok(outbound) = TcpStream::connect(&target).await {
                                cutter.relay(inbound, outbound).await;
                            }
                        }
                        Mode::Forward | Mode::Delay(_) => {
                            if let Ok(mut outbound) = TcpStream::connect(&target).await {
                                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound)
                                    .await;
                            }
                        }
                        Mode::Blackhole => {
                            tokio::time::sleep(Duration::from_secs(120)).await;
                            drop(inbound);
                        }
                    }
                });
            }
        });
        Ok(Self {
            port,
            tasks: Some(tasks),
            accept: Some(accept),
        })
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

    async fn stop_owned(mut self) {
        self.stop().await;
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        if let Some(accept) = self.accept.take() {
            accept.abort();
        }
    }
}
