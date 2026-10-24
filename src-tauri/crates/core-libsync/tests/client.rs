//! The client against the real server (`server/library-sync`) running in this process on 127.0.0.1: login, records,
//! a file over 100 MB sent in parts and fetched in ranges (Cloudflare's per-request limit), the 409 of a conflict.

use std::time::Duration;

use core_libsync::{LibError, LibraryClient, PushResult, Uploaded, WireRecord, file_sha256};
use leitor_library_sync::{AppState, Config, router};
use serde_json::json;

const PASSWORD: &str = "senha-de-teste-longa";

async fn server(dir: &std::path::Path) -> String {
    let state = AppState::open(Config {
        data_dir: dir.to_path_buf(),
        user: "leitor".into(),
        password: PASSWORD.into(),
        fail_delay: Duration::ZERO,
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    format!("http://{addr}")
}

async fn device(base: &str, name: &str) -> LibraryClient {
    let c = LibraryClient::new(base).unwrap();
    let token = c.login("leitor", PASSWORD, name).await.unwrap();
    c.with_token(token)
}

#[tokio::test(flavor = "multi_thread")]
async fn login_records_and_logout() {
    let dir = tempfile::tempdir().unwrap();
    let base = server(dir.path()).await;
    let anon = LibraryClient::new(&base).unwrap();
    assert_eq!(
        anon.login("leitor", "errada", "x").await.unwrap_err(),
        LibError::BadLogin
    );
    assert_eq!(anon.changes(0).await.unwrap_err(), LibError::Unauthorized);

    let a = device(&base, "PC A").await;
    let b = device(&base, "PC B").await;
    let rec = WireRecord {
        kind: "vocab_override".into(),
        key: "windmill".into(),
        updated_at: 10,
        deleted: false,
        data: json!({"status": "known"}),
        seq: 0,
    };
    let r = a.push(std::slice::from_ref(&rec)).await.unwrap();
    assert!(matches!(r[0], PushResult::Accepted { seq: 1, .. }));
    let page = b.changes(0).await.unwrap();
    assert_eq!(
        (page.cursor, page.more, page.records[0].key.as_str()),
        (1, false, "windmill")
    );
    let old = WireRecord {
        updated_at: 5,
        ..rec
    };
    let r = b.push(&[old]).await.unwrap();
    assert!(matches!(&r[0], PushResult::Stale { current } if current.updated_at == 10));

    b.logout().await.unwrap();
    assert_eq!(b.changes(0).await.unwrap_err(), LibError::Unauthorized);
    // Nothing listens there: offline, not a crash.
    let gone = LibraryClient::new("http://127.0.0.1:9")
        .unwrap()
        .with_token("x");
    assert_eq!(gone.changes(0).await.unwrap_err(), LibError::Offline);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_over_100_mb_goes_in_parts_and_comes_back_in_ranges() {
    let dir = tempfile::tempdir().unwrap();
    let base = server(&dir.path().join("server")).await;
    let a = device(&base, "PC A").await;
    let b = device(&base, "PC B").await;

    // 101 MB: four parts of at most 32 MB, so no request passes Cloudflare's 100 MB.
    let big = dir.path().join("big.pdf");
    let mut bytes = vec![0u8; 101 * 1024 * 1024];
    for (i, b) in bytes.iter_mut().enumerate().step_by(4096) {
        *b = (i / 4096 % 251) as u8;
    }
    std::fs::write(&big, &bytes).unwrap();
    let hash = file_sha256(&big).await.unwrap();
    let uid = hash.clone();
    let mut steps = Vec::new();
    let up = a
        .upload(&uid, "", &big, |done, total| steps.push((done, total)))
        .await
        .unwrap();
    let Uploaded::Done(f) = up else {
        panic!("{up:?}")
    };
    assert_eq!(
        (f.hash.as_str(), f.version, f.size),
        (hash.as_str(), 1, bytes.len() as u64)
    );
    assert_eq!(steps.len(), 4, "{steps:?}");

    let got = dir.path().join("got.pdf");
    let mut ranges = 0;
    let f = b.download(&uid, &got, |_, _| ranges += 1).await.unwrap();
    assert_eq!(f.hash, hash);
    assert_eq!(ranges, 4);
    assert_eq!(file_sha256(&got).await.unwrap(), hash);

    // B saves a new version from v1; A, still on v1, conflicts.
    let v2 = dir.path().join("v2.pdf");
    std::fs::write(&v2, b"version two").unwrap();
    let Uploaded::Done(f2) = b.upload(&uid, &hash, &v2, |_, _| {}).await.unwrap() else {
        panic!()
    };
    assert_eq!(f2.version, 2);
    let mine = dir.path().join("mine.pdf");
    std::fs::write(&mine, b"version from A").unwrap();
    let up = a.upload(&uid, &hash, &mine, |_, _| {}).await.unwrap();
    assert_eq!(up, Uploaded::Conflict(f2.clone()));
    assert_eq!(a.file_info(&uid).await.unwrap(), Some(f2.clone()));
    let all = a.files().await.unwrap();
    assert_eq!(
        (all.len(), all[0].book_uid.as_str(), all[0].version),
        (1, uid.as_str(), 2)
    );
    assert_eq!(a.changes(1_000).await.unwrap_err(), LibError::CursorAhead);
    assert_eq!(a.file_info(&"0".repeat(64)).await.unwrap(), None);
}
