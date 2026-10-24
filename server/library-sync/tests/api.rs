//! The routes end to end, in process (no network): login and lockout, records with last write wins, files in parts
//! with ranges, the 409 of a file changed elsewhere, logout.

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use leitor_library_sync::{AppState, Config, PART_SIZE, router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const PASSWORD: &str = "senha-de-teste-longa";

fn app(dir: &std::path::Path) -> Router {
    router(
        AppState::open(Config {
            data_dir: dir.to_path_buf(),
            user: "leitor".into(),
            password: PASSWORD.into(),
            fail_delay: Duration::ZERO,
        })
        .unwrap(),
    )
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Body,
) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    req = req.header(header::CONTENT_TYPE, "application/json");
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, bytes, headers)
}

async fn json_call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let (s, b, _) = call(app, method, uri, token, Body::from(body.to_string())).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

async fn login(app: &Router, device: &str) -> String {
    let (s, v) = json_call(
        app,
        "POST",
        "/v1/login",
        None,
        json!({"user": "leitor", "password": PASSWORD, "device": device}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v["token"].as_str().unwrap().to_owned()
}

fn hex_sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

#[tokio::test]
async fn login_tokens_lockout_and_logout() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let (s, b, _) = call(&app, "GET", "/v1/health", None, Body::empty()).await;
    assert_eq!((s, b.as_slice()), (StatusCode::OK, b"ok".as_slice()));
    let (s, v) = json_call(&app, "GET", "/v1/changes", None, Value::Null).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("unauthorized"))
    );

    let token = login(&app, "PC A").await;
    let (s, _) = json_call(
        &app,
        "GET",
        "/v1/changes?since=0",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    // The token is not stored: only its hash.
    let db = std::fs::read(dir.path().join("library.sqlite")).unwrap_or_default();
    assert!(!String::from_utf8_lossy(&db).contains(&token));

    for _ in 0..10 {
        let (s, v) = json_call(
            &app,
            "POST",
            "/v1/login",
            None,
            json!({"user": "leitor", "password": "errada", "device": "x"}),
        )
        .await;
        assert_eq!(
            (s, v["code"].as_str()),
            (StatusCode::UNAUTHORIZED, Some("bad_login"))
        );
    }
    let (s, v) = json_call(
        &app,
        "POST",
        "/v1/login",
        None,
        json!({"user": "leitor", "password": PASSWORD, "device": "x"}),
    )
    .await;
    assert_eq!(
        (s, v["code"].as_str()),
        (StatusCode::TOO_MANY_REQUESTS, Some("login_locked"))
    );

    let (s, _) = json_call(&app, "POST", "/v1/logout", Some(&token), Value::Null).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = json_call(&app, "GET", "/v1/changes", Some(&token), Value::Null).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn records_sync_with_a_server_cursor_and_last_write_wins() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let a = login(&app, "PC A").await;
    let b = login(&app, "PC B").await;
    let rec = |key: &str, at: i64, data: Value| json!({"kind": "reading_position", "key": key, "updatedAt": at, "deleted": false, "data": data});

    let (s, v) = json_call(&app, "POST", "/v1/changes", Some(&a), json!({"records": [rec("k1", 100, json!({"page": 3})), rec("k2", 100, json!({"page": 1}))]})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["results"][1]["result"], "accepted");
    assert_eq!(v["results"][1]["seq"], 2);

    let (_, v) = json_call(
        &app,
        "GET",
        "/v1/changes?since=0&limit=1",
        Some(&b),
        Value::Null,
    )
    .await;
    assert_eq!(
        (
            v["records"].as_array().unwrap().len(),
            v["cursor"].as_i64(),
            v["more"].as_bool()
        ),
        (1, Some(1), Some(true))
    );
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=1", Some(&b), Value::Null).await;
    assert_eq!(
        (v["cursor"].as_i64(), v["more"].as_bool()),
        (Some(2), Some(false))
    );
    assert_eq!(v["records"][0]["data"]["page"], 1);

    // B's older change is refused with the current version; a newer one wins.
    let (_, v) = json_call(
        &app,
        "POST",
        "/v1/changes",
        Some(&b),
        json!({"records": [rec("k1", 50, json!({"page": 9}))]}),
    )
    .await;
    assert_eq!(v["results"][0]["result"], "stale");
    assert_eq!(v["results"][0]["current"]["data"]["page"], 3);
    let (_, v) = json_call(
        &app,
        "POST",
        "/v1/changes",
        Some(&b),
        json!({"records": [rec("k1", 200, json!({"page": 7}))]}),
    )
    .await;
    assert_eq!(v["results"][0]["seq"], 3);
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=2", Some(&a), Value::Null).await;
    assert_eq!(v["records"][0]["data"]["page"], 7);

    let (s, v) = json_call(&app, "POST", "/v1/changes", Some(&a), json!({"records": [{"kind": "x", "key": "k", "updatedAt": 1, "deleted": false, "data": {}}]})).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("bad_request"))
    );
}

/// Uploads `bytes` as a new version made from `base`; returns the finish status and body.
async fn upload(
    app: &Router,
    token: &str,
    uid: &str,
    base: &str,
    bytes: &[u8],
) -> (StatusCode, Value) {
    let (s, v) = json_call(
        app,
        "POST",
        "/v1/uploads",
        Some(token),
        json!({"bookUid": uid, "base": base, "hash": hex_sha(bytes), "size": bytes.len()}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let id = v["uploadId"].as_str().unwrap().to_owned();
    let parts = v["parts"].as_u64().unwrap();
    for (n, chunk) in bytes.chunks(PART_SIZE as usize).enumerate() {
        let (s, b, _) = call(
            app,
            "PUT",
            &format!("/v1/uploads/{id}/{n}"),
            Some(token),
            Body::from(chunk.to_vec()),
        )
        .await;
        assert_eq!(s, StatusCode::NO_CONTENT, "{}", String::from_utf8_lossy(&b));
    }
    assert_eq!(parts as usize, bytes.len().div_ceil(PART_SIZE as usize));
    json_call(
        app,
        "POST",
        &format!("/v1/uploads/{id}/finish"),
        Some(token),
        Value::Null,
    )
    .await
}

#[tokio::test]
async fn files_go_up_in_parts_come_down_in_ranges_and_conflict_with_409() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let a = login(&app, "PC A").await;
    let b = login(&app, "PC B").await;
    // Two parts: past one part size.
    let mut v1 = vec![7u8; PART_SIZE as usize + 10];
    v1[PART_SIZE as usize] = 1;
    let uid = hex_sha(&v1);
    let (s, row) = upload(&app, &a, &uid, "", &v1).await;
    assert_eq!(s, StatusCode::OK, "{row}");
    assert_eq!(
        (row["version"].as_i64(), row["size"].as_u64()),
        (Some(1), Some(v1.len() as u64))
    );

    let (s, _, h) = call(
        &app,
        "HEAD",
        &format!("/v1/files/{uid}"),
        Some(&b),
        Body::empty(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h["x-file-hash"], hex_sha(&v1).as_str());
    let (s, body, h) = {
        let req = Request::get(format!("/v1/files/{uid}"))
            .header(header::AUTHORIZATION, format!("Bearer {b}"))
            .header(header::RANGE, format!("bytes={}-", PART_SIZE))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let (s, h) = (resp.status(), resp.headers().clone());
        (
            s,
            resp.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
            h,
        )
    };
    assert_eq!(s, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, v1[PART_SIZE as usize..].to_vec());
    assert_eq!(
        h[header::CONTENT_RANGE],
        format!("bytes {}-{}/{}", PART_SIZE, v1.len() - 1, v1.len()).as_str()
    );

    // B saves a version from v1: accepted as version 2.
    let v2 = b"version two".to_vec();
    let (s, row) = upload(&app, &b, &uid, &hex_sha(&v1), &v2).await;
    assert_eq!((s, row["version"].as_i64()), (StatusCode::OK, Some(2)));
    // A, still on v1, saves its own version: 409 with the current one.
    let (s, v) = upload(&app, &a, &uid, &hex_sha(&v1), b"version from A").await;
    assert_eq!(
        (s, v["code"].as_str()),
        (StatusCode::CONFLICT, Some("file_conflict"))
    );
    assert_eq!(v["current"]["hash"], hex_sha(&v2).as_str());
    let (_, body, _) = call(
        &app,
        "GET",
        &format!("/v1/files/{uid}"),
        Some(&a),
        Body::empty(),
    )
    .await;
    assert_eq!(body, v2);
    // The old version's bytes are gone from the disk.
    assert!(
        !dir.path()
            .join("files")
            .join(&uid)
            .join(hex_sha(&v1))
            .exists()
    );

    // A part of the wrong size and a wrong hash are refused.
    let (_, v) = json_call(
        &app,
        "POST",
        "/v1/uploads",
        Some(&a),
        json!({"bookUid": uid, "base": hex_sha(&v2), "hash": hex_sha(b"abc"), "size": 3}),
    )
    .await;
    let id = v["uploadId"].as_str().unwrap().to_owned();
    let (s, _, _) = call(
        &app,
        "PUT",
        &format!("/v1/uploads/{id}/0"),
        Some(&a),
        Body::from("ab"),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _, _) = call(
        &app,
        "PUT",
        &format!("/v1/uploads/{id}/0"),
        Some(&a),
        Body::from("xyz"),
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, v) = json_call(
        &app,
        "POST",
        &format!("/v1/uploads/{id}/finish"),
        Some(&a),
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let (s, _) = json_call(
        &app,
        "GET",
        &format!("/v1/files/{}", "0".repeat(64)),
        Some(&a),
        Value::Null,
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_cursor_ahead_of_the_database_and_the_list_of_files() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let a = login(&app, "PC A").await;
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=0", Some(&a), Value::Null).await;
    let epoch = v["epoch"].as_i64().unwrap();
    assert_ne!(epoch, 0);
    // A device whose cursor came from a newer state of the server (restored backup): start over.
    let (s, v) = json_call(&app, "GET", "/v1/changes?since=99", Some(&a), Value::Null).await;
    assert_eq!(
        (s, v["code"].as_str()),
        (StatusCode::CONFLICT, Some("cursor_ahead"))
    );

    let (_, list) = json_call(&app, "GET", "/v1/files", Some(&a), Value::Null).await;
    assert_eq!(list, json!([]));
    let bytes = b"a small book".to_vec();
    let uid = hex_sha(&bytes);
    upload(&app, &a, &uid, "", &bytes).await;
    let (_, list) = json_call(&app, "GET", "/v1/files", Some(&a), Value::Null).await;
    assert_eq!(
        list,
        json!([{"bookUid": uid, "hash": uid, "version": 1, "size": bytes.len()}])
    );
    // The 409 gave the database a new identity (every device starts over); it is then kept across restarts.
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=0", Some(&a), Value::Null).await;
    let new_epoch = v["epoch"].as_i64().unwrap();
    assert_ne!(new_epoch, epoch);
    let again = self::app(dir.path());
    let (_, v) = json_call(&again, "GET", "/v1/changes?since=0", Some(&a), Value::Null).await;
    assert_eq!(v["epoch"].as_i64(), Some(new_epoch));
}

#[tokio::test]
async fn two_devices_finishing_from_the_same_base_at_once_one_gets_409() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let a = login(&app, "PC A").await;
    let b = login(&app, "PC B").await;
    let v1 = b"version one".to_vec();
    let uid = hex_sha(&v1);
    upload(&app, &a, &uid, "", &v1).await;
    // Both upload their parts, then finish together.
    let mut ids = Vec::new();
    for (token, bytes) in [(&a, b"from A".to_vec()), (&b, b"from B".to_vec())] {
        let (_, v) = json_call(&app, "POST", "/v1/uploads", Some(token), json!({"bookUid": uid, "base": hex_sha(&v1), "hash": hex_sha(&bytes), "size": bytes.len()})).await;
        let id = v["uploadId"].as_str().unwrap().to_owned();
        let (s, _, _) = call(
            &app,
            "PUT",
            &format!("/v1/uploads/{id}/0"),
            Some(token),
            Body::from(bytes),
        )
        .await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        ids.push((token.clone(), id));
    }
    let (url_a, url_b) = (
        format!("/v1/uploads/{}/finish", ids[0].1),
        format!("/v1/uploads/{}/finish", ids[1].1),
    );
    let (ra, rb) = tokio::join!(
        json_call(&app, "POST", &url_a, Some(&ids[0].0), Value::Null),
        json_call(&app, "POST", &url_b, Some(&ids[1].0), Value::Null),
    );
    let mut statuses = [ra.0, rb.0];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CONFLICT],
        "{ra:?} {rb:?}"
    );
    let (_, list) = json_call(&app, "GET", "/v1/files", Some(&a), Value::Null).await;
    assert_eq!(list[0]["version"], 2);
}

#[tokio::test]
async fn a_restored_database_never_reuses_sequence_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let a = login(&app, "PC A").await;
    let rec = |key: &str| json!({"kind": "vocab_override", "key": key, "updatedAt": 1, "deleted": false, "data": {"status": "known"}});
    json_call(
        &app,
        "POST",
        "/v1/changes",
        Some(&a),
        json!({"records": [rec("a")]}),
    )
    .await;
    // A backup of the database taken here (seq 1).
    let backup_dir = tempfile::tempdir().unwrap();
    {
        let db = rusqlite::Connection::open(dir.path().join("library.sqlite")).unwrap();
        db.execute(
            "VACUUM INTO ?1",
            [backup_dir.path().join("b.sqlite").to_str().unwrap()],
        )
        .unwrap();
    }
    json_call(
        &app,
        "POST",
        "/v1/changes",
        Some(&a),
        json!({"records": [rec("b"), rec("c")]}),
    )
    .await;
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=0", Some(&a), Value::Null).await;
    let (epoch, cursor) = (v["epoch"].as_i64().unwrap(), v["cursor"].as_i64().unwrap());
    assert_eq!(cursor, 3);
    drop(app);
    // Restore: the database goes back to seq 1.
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.path().join(format!("library.sqlite{ext}")));
    }
    std::fs::copy(
        backup_dir.path().join("b.sqlite"),
        dir.path().join("library.sqlite"),
    )
    .unwrap();
    let app = self::app(dir.path());
    let a = login(&app, "PC A again").await;
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=0", Some(&a), Value::Null).await;
    assert_ne!(
        v["epoch"].as_i64().unwrap(),
        epoch,
        "a new identity: devices start over"
    );
    assert_eq!(
        v["cursor"].as_i64().unwrap(),
        3,
        "numbers already handed out are not given again"
    );
    let (_, v) = json_call(
        &app,
        "POST",
        "/v1/changes",
        Some(&a),
        json!({"records": [rec("d")]}),
    )
    .await;
    assert_eq!(v["results"][0]["seq"], 4);
}

#[tokio::test]
async fn a_device_ahead_of_the_server_makes_every_device_start_over() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    let a = login(&app, "PC A").await;
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=0", Some(&a), Value::Null).await;
    let epoch = v["epoch"].as_i64().unwrap();
    // A device with cursor 150 (the volume was restored to an older state, mark included).
    let (s, _) = json_call(&app, "GET", "/v1/changes?since=150", Some(&a), Value::Null).await;
    assert_eq!(s, StatusCode::CONFLICT);
    // Any other device now sees a new identity and starts over too; new numbers come after 150.
    let (_, v) = json_call(&app, "GET", "/v1/changes?since=0", Some(&a), Value::Null).await;
    assert_ne!(v["epoch"].as_i64().unwrap(), epoch);
    assert_eq!(v["cursor"].as_i64().unwrap(), 150);
    let rec = json!({"kind": "vocab_override", "key": "x", "updatedAt": 1, "deleted": false, "data": {"status": "known"}});
    let (_, v) = json_call(
        &app,
        "POST",
        "/v1/changes",
        Some(&a),
        json!({"records": [rec]}),
    )
    .await;
    assert_eq!(v["results"][0]["seq"], 151);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("seq-mark")).unwrap(),
        "151"
    );
}
