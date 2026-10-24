//! Library sync server of the Leitor de Estudos (spec 16, docs/planos/fase-9a.md): the records every device changes
//! (last write wins per key, a server sequence as the cursor) and the book files, sent and fetched in parts so no
//! request passes Cloudflare's 100 MB limit.
//!
//! Auth: `POST /v1/login` with the library user and password (from the server's environment) gives a device a
//! token; only its SHA-256 is kept, and `library-sync device revoke <name>` ends it. Every other route but
//! `/v1/health` needs `Authorization: Bearer <token>`.

pub mod db;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path as UrlPath, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use db::{FileRow, Record, UploadRow};

/// Size of an upload part and the most a part may carry (well under Cloudflare's 100 MB per request).
pub const PART_SIZE: u64 = 32 * 1024 * 1024;
/// Largest book file accepted.
pub const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024 * 1024;
/// Most records per `GET /v1/changes` page and per push.
pub const MAX_PAGE: u32 = 1000;
/// Failed logins in [`LOCK_WINDOW`] before the login locks for that long.
const MAX_FAILURES: usize = 10;
const LOCK_WINDOW: Duration = Duration::from_secs(600);
/// How long a failed login waits before answering.
pub const FAIL_DELAY: Duration = Duration::from_secs(1);
const DAY_MS: i64 = 86_400_000;
/// File next to the database with the highest sequence number given out.
const SEQ_MARK: &str = "seq-mark";

/// Server settings (from the environment in `main`).
#[derive(Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub user: String,
    pub password: String,
    /// Delay of a failed login (tests use zero).
    pub fail_delay: Duration,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("data_dir", &self.data_dir)
            .field("user", &self.user)
            .field("password", &"***")
            .finish()
    }
}

struct Inner {
    db: Mutex<rusqlite::Connection>,
    config: Config,
    failures: Mutex<VecDeque<Instant>>,
    /// Finishing uploads one at a time: the check of the base and the switch to the new file are one step.
    finish: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl AppState {
    pub fn open(config: Config) -> std::io::Result<Self> {
        std::fs::create_dir_all(config.data_dir.join("files"))?;
        std::fs::create_dir_all(config.data_dir.join("uploads"))?;
        let db =
            db::open(&config.data_dir.join("library.sqlite")).map_err(std::io::Error::other)?;
        // The highest sequence ever given out lives next to the database: a restored database must not hand out
        // the same numbers again (devices that already passed them would skip them).
        let mark = std::fs::read_to_string(config.data_dir.join(SEQ_MARK))
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let mut db = db;
        if db::recover_sequence(&mut db, mark).map_err(std::io::Error::other)? {
            eprintln!(
                "library-sync: database behind its sequence mark (restored?): new identity, devices start over"
            );
        }
        let cursor = db::cursor(&db).map_err(std::io::Error::other)?;
        write_mark_file(&config.data_dir, cursor.max(mark))?;
        Ok(Self(Arc::new(Inner {
            db: Mutex::new(db),
            config,
            failures: Mutex::new(VecDeque::new()),
            finish: tokio::sync::Mutex::new(()),
        })))
    }

    pub fn db(&self) -> MutexGuard<'_, rusqlite::Connection> {
        lock(&self.0.db)
    }

    fn files_dir(&self) -> PathBuf {
        self.0.config.data_dir.join("files")
    }

    fn file_path(&self, book_uid: &str, hash: &str) -> PathBuf {
        self.files_dir().join(book_uid).join(hash)
    }

    fn upload_dir(&self, id: &str) -> PathBuf {
        self.0.config.data_dir.join("uploads").join(id)
    }

    /// Daily cleanup: tombstones after 90 days, files of books deleted 30 days ago, uploads abandoned for a day.
    /// Under the finish lock: a finish can't install a file of a book whose directory is being removed.
    pub async fn cleanup(&self, now: i64) -> std::io::Result<()> {
        let _finishing = self.0.finish.lock().await;
        let (books, uploads) = {
            let db = self.db();
            let books = db::deleted_books(&db, now - 30 * DAY_MS).map_err(std::io::Error::other)?;
            for b in &books {
                db::remove_file(&db, b).map_err(std::io::Error::other)?;
            }
            db::purge_tombstones(&db, now - 90 * DAY_MS).map_err(std::io::Error::other)?;
            let uploads = db::stale_uploads(&db, now - DAY_MS).map_err(std::io::Error::other)?;
            for u in &uploads {
                db::remove_upload(&db, u).map_err(std::io::Error::other)?;
            }
            (books, uploads)
        };
        for b in books {
            remove_dir(&self.files_dir().join(&b));
        }
        for u in uploads {
            remove_dir(&self.upload_dir(&u));
        }
        Ok(())
    }
}

/// Writes the sequence mark (tmp + fsync + rename + directory fsync). Called under the database lock, so writes
/// never interleave and the mark only grows.
fn write_mark_file(dir: &Path, cursor: i64) -> std::io::Result<()> {
    let tmp = dir.join(format!("{SEQ_MARK}.tmp"));
    {
        let mut f = std::fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut f, cursor.to_string().as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, dir.join(SEQ_MARK))?;
    std::fs::File::open(dir)?.sync_all()
}

fn remove_dir(p: &Path) {
    if let Err(e) = std::fs::remove_dir_all(p)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("library-sync: could not remove {}: {e}", p.display());
    }
}

// ---------------------------------------------------------------- errors

/// `{code, message}` with a pt-BR message, like the app's errors.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    extra: Option<serde_json::Value>,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            extra: None,
        }
    }

    fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    fn internal(e: impl std::fmt::Display) -> Self {
        eprintln!("library-sync: internal error: {e}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Erro interno do servidor da biblioteca.",
        )
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        Self::internal(e)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "code": self.code, "message": self.message });
        if let (Some(extra), Some(obj)) = (self.extra, body.as_object_mut()) {
            obj.insert("current".into(), extra);
        }
        (self.status, Json(body)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ---------------------------------------------------------------- auth

/// The device behind a request's token.
pub struct Device {
    pub id: i64,
    pub name: String,
}

impl FromRequestParts<AppState> for Device {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let unauthorized = || {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Aparelho não conectado ou desconectado.",
            )
        };
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(unauthorized)?;
        let found = db::device_by_token(&state.db(), &sha256_hex(token.as_bytes()), now_ms())?;
        let (id, name) = found.ok_or_else(unauthorized)?;
        Ok(Device { id, name })
    }
}

#[derive(Deserialize)]
struct LoginBody {
    user: String,
    password: String,
    device: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginReply {
    token: String,
    device_id: i64,
}

/// Constant-time comparison of two secrets (through their hashes, so lengths don't leak).
fn same_secret(a: &str, b: &str) -> bool {
    let (x, y) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    x.iter()
        .zip(y.iter())
        .fold(0u8, |acc, (p, q)| acc | (p ^ q))
        == 0
}

async fn login(
    State(s): State<AppState>,
    Json(body): Json<LoginBody>,
) -> ApiResult<Json<LoginReply>> {
    let device = body.device.trim();
    if device.is_empty() || device.chars().count() > 80 {
        return Err(ApiError::bad(
            "Dê um nome de até 80 caracteres a este aparelho.",
        ));
    }
    {
        let mut failures = lock(&s.0.failures);
        let now = Instant::now();
        while failures
            .front()
            .is_some_and(|t| now.duration_since(*t) > LOCK_WINDOW)
        {
            failures.pop_front();
        }
        if failures.len() >= MAX_FAILURES {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "login_locked",
                "Muitas tentativas de login erradas. Espere 10 minutos.",
            ));
        }
    }
    let config = &s.0.config;
    let ok = !config.password.is_empty()
        && same_secret(&body.user, &config.user)
        && same_secret(&body.password, &config.password);
    if !ok {
        lock(&s.0.failures).push_back(Instant::now());
        tokio::time::sleep(config.fail_delay).await;
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "bad_login",
            "Usuário ou senha da biblioteca incorretos.",
        ));
    }
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let device_id = db::add_device(&s.db(), device, &sha256_hex(token.as_bytes()), now_ms())?;
    println!("library-sync: device {device_id} ({device}) logged in");
    Ok(Json(LoginReply { token, device_id }))
}

async fn logout(State(s): State<AppState>, device: Device) -> ApiResult<StatusCode> {
    db::revoke_device(&s.db(), device.id)?;
    println!(
        "library-sync: device {} ({}) logged out",
        device.id, device.name
    );
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- records

#[derive(Deserialize)]
struct ChangesQuery {
    #[serde(default)]
    since: i64,
    limit: Option<u32>,
}

#[derive(Serialize)]
struct ChangesReply {
    records: Vec<Record>,
    cursor: i64,
    more: bool,
    /// The database's identity: a client that knew another one starts over from 0.
    epoch: i64,
}

async fn get_changes(
    State(s): State<AppState>,
    _device: Device,
    Query(q): Query<ChangesQuery>,
) -> ApiResult<Json<ChangesReply>> {
    let limit = q.limit.unwrap_or(MAX_PAGE).clamp(1, MAX_PAGE);
    let mut db = s.db();
    let current = db::cursor(&db)?;
    if q.since > current {
        // The client is ahead of this database (restored together with its mark, or recreated): the sequence jumps
        // past that cursor and the identity changes, so EVERY device starts over, whatever order they sync in.
        db::jump_sequence(&mut db, q.since)?;
        if let Err(e) = write_mark_file(&s.0.config.data_dir, q.since) {
            eprintln!("library-sync: could not write the sequence mark: {e}");
        }
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "cursor_ahead",
            "O servidor da biblioteca voltou a um estado anterior; este aparelho vai sincronizar tudo de novo.",
        ));
    }
    let records = db::changes(&db, q.since, limit + 1)?;
    let more = records.len() > limit as usize;
    let records: Vec<Record> = records.into_iter().take(limit as usize).collect();
    let cursor = match records.last() {
        Some(r) if more => r.seq,
        _ => current,
    };
    Ok(Json(ChangesReply {
        records,
        cursor,
        more,
        epoch: db::epoch(&db)?,
    }))
}

#[derive(Deserialize)]
struct PushBody {
    records: Vec<Record>,
}

#[derive(Serialize)]
struct PushReply {
    results: Vec<db::PushResult>,
}

fn check_record(r: &Record) -> ApiResult<()> {
    if !db::KINDS.contains(&r.kind.as_str()) {
        return Err(ApiError::bad(format!(
            "Tipo de registro desconhecido: {}.",
            r.kind
        )));
    }
    if r.key.is_empty() || r.key.len() > db::MAX_KEY_LEN {
        return Err(ApiError::bad("Chave de registro inválida."));
    }
    if r.data.get().len() > db::MAX_DATA_LEN {
        return Err(ApiError::bad("Registro grande demais."));
    }
    Ok(())
}

async fn post_changes(
    State(s): State<AppState>,
    device: Device,
    Json(body): Json<PushBody>,
) -> ApiResult<Json<PushReply>> {
    if body.records.len() > MAX_PAGE as usize {
        return Err(ApiError::bad(format!(
            "Envie no máximo {MAX_PAGE} registros por vez."
        )));
    }
    for r in &body.records {
        check_record(r)?;
    }
    let results = {
        let mut db = s.db();
        let results = db::push(&mut db, body.records, &device.name, now_ms())?;
        // Under the same lock: the mark only grows. The push is committed: a failed mark write is logged, not an
        // error (the next push or start writes it again).
        if let Err(e) = write_mark_file(&s.0.config.data_dir, db::cursor(&db)?) {
            eprintln!("library-sync: could not write the sequence mark: {e}");
        }
        results
    };
    Ok(Json(PushReply { results }))
}

// ---------------------------------------------------------------- files

fn file_headers(f: &FileRow) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        "x-file-hash",
        HeaderValue::from_str(&f.hash).unwrap_or(HeaderValue::from_static("")),
    );
    h.insert("x-file-version", HeaderValue::from(f.version));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h
}

fn current_file(s: &AppState, book_uid: &str) -> ApiResult<FileRow> {
    if !is_hash(book_uid) {
        return Err(ApiError::bad("Identificador de livro inválido."));
    }
    db::file(&s.db(), book_uid)?
        .ok_or_else(|| ApiError::not_found("O servidor não tem o arquivo deste livro."))
}

/// The current file of every book (`[{bookUid, hash, version, size}]`): which version each book is at.
async fn list_files(State(s): State<AppState>, _device: Device) -> ApiResult<Json<Vec<FileRow>>> {
    Ok(Json(db::files(&s.db())?))
}

async fn head_file(
    State(s): State<AppState>,
    _device: Device,
    UrlPath(uid): UrlPath<String>,
) -> ApiResult<Response> {
    let f = current_file(&s, &uid)?;
    let mut h = file_headers(&f);
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(f.size));
    Ok((StatusCode::OK, h).into_response())
}

/// `bytes=a-b` / `bytes=a-` → (start, end inclusive), clamped to the file.
fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: u64 = a.trim().parse().ok()?;
    let end: u64 = if b.trim().is_empty() {
        size.checked_sub(1)?
    } else {
        b.trim().parse().ok()?
    };
    let end = end.min(size.checked_sub(1)?);
    (start <= end).then_some((start, end))
}

async fn get_file(
    State(s): State<AppState>,
    _device: Device,
    UrlPath(uid): UrlPath<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let f = current_file(&s, &uid)?;
    let size = f.size as u64;
    let mut file = tokio::fs::File::open(s.file_path(&uid, &f.hash)).await?;
    let mut h = file_headers(&f);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (status, start, len) = match range {
        None => (StatusCode::OK, 0, size),
        Some(r) => match parse_range(r, size) {
            Some((a, b)) => {
                h.insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes {a}-{b}/{size}"))
                        .map_err(ApiError::internal)?,
                );
                (StatusCode::PARTIAL_CONTENT, a, b - a + 1)
            }
            None => {
                h.insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}"))
                        .map_err(ApiError::internal)?,
                );
                return Ok((StatusCode::RANGE_NOT_SATISFIABLE, h).into_response());
            }
        },
    };
    file.seek(std::io::SeekFrom::Start(start)).await?;
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file.take(len)));
    Ok((status, h, body).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadStart {
    book_uid: String,
    /// The hash this version was made from (`""`: the device never had a server version).
    #[serde(default)]
    base: String,
    hash: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadStarted {
    upload_id: String,
    part_size: u64,
    parts: u64,
}

async fn start_upload(
    State(s): State<AppState>,
    device: Device,
    Json(u): Json<UploadStart>,
) -> ApiResult<Json<UploadStarted>> {
    if !is_hash(&u.book_uid) || !is_hash(&u.hash) || !(u.base.is_empty() || is_hash(&u.base)) {
        return Err(ApiError::bad("Identificadores do envio inválidos."));
    }
    if u.size == 0 || u.size > MAX_FILE_SIZE {
        return Err(ApiError::bad("Tamanho de arquivo inválido (até 4 GB)."));
    }
    let parts = u.size.div_ceil(PART_SIZE);
    let mut raw = [0u8; 16];
    rand::rng().fill_bytes(&mut raw);
    let id = hex::encode(raw);
    tokio::fs::create_dir_all(s.upload_dir(&id)).await?;
    db::add_upload(
        &s.db(),
        &UploadRow {
            id: id.clone(),
            book_uid: u.book_uid,
            base: u.base,
            hash: u.hash,
            size: u.size as i64,
            parts: parts as i64,
            created_at: now_ms(),
        },
        &device.name,
    )?;
    Ok(Json(UploadStarted {
        upload_id: id,
        part_size: PART_SIZE,
        parts,
    }))
}

fn the_upload(s: &AppState, id: &str) -> ApiResult<UploadRow> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad("Envio inválido."));
    }
    db::upload(&s.db(), id)?
        .ok_or_else(|| ApiError::not_found("Este envio não existe mais; comece de novo."))
}

/// Expected length of part `n`.
fn part_len(u: &UploadRow, n: u64) -> u64 {
    let size = u.size as u64;
    if n + 1 == u.parts as u64 {
        size - n * PART_SIZE
    } else {
        PART_SIZE
    }
}

async fn put_part(
    State(s): State<AppState>,
    _device: Device,
    UrlPath((id, n)): UrlPath<(String, u64)>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let u = the_upload(&s, &id)?;
    if n >= u.parts as u64 {
        return Err(ApiError::bad("Parte fora do envio."));
    }
    if body.len() as u64 != part_len(&u, n) {
        return Err(ApiError::bad(format!(
            "A parte {n} veio com o tamanho errado."
        )));
    }
    let tmp = s.upload_dir(&id).join(format!("{n}.tmp"));
    let mut f = tokio::fs::File::create(&tmp).await?;
    f.write_all(&body).await?;
    f.sync_all().await?;
    tokio::fs::rename(&tmp, s.upload_dir(&id).join(n.to_string())).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Assembles the parts (checking the hash), then makes it the current file unless another device changed it.
async fn finish_upload(
    State(s): State<AppState>,
    _device: Device,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<FileRow>> {
    // One finish at a time: two devices can't both pass the base check of the same book.
    let _finishing = s.0.finish.lock().await;
    let u = the_upload(&s, &id)?;
    let dir = s.upload_dir(&id);
    let assembled = dir.join("assembled");
    let mut out = tokio::fs::File::create(&assembled).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    for n in 0..u.parts as u64 {
        let mut part = match tokio::fs::File::open(dir.join(n.to_string())).await {
            Ok(f) => f,
            Err(_) => return Err(ApiError::bad(format!("Falta a parte {n} do envio."))),
        };
        loop {
            let k = part.read(&mut buf).await?;
            if k == 0 {
                break;
            }
            hasher.update(&buf[..k]);
            out.write_all(&buf[..k]).await?;
        }
    }
    out.sync_all().await?;
    drop(out);
    if hex::encode(hasher.finalize()) != u.hash {
        remove_dir(&dir);
        db::remove_upload(&s.db(), &id)?;
        return Err(ApiError::bad(
            "O arquivo chegou diferente do enviado (hash não confere); envie de novo.",
        ));
    }
    let current = db::file(&s.db(), &u.book_uid)?;
    if let Some(cur) = &current {
        if cur.hash == u.hash {
            remove_dir(&dir);
            db::remove_upload(&s.db(), &id)?;
            return Ok(Json(cur.clone()));
        }
        if cur.hash != u.base {
            remove_dir(&dir);
            db::remove_upload(&s.db(), &id)?;
            let mut e = ApiError::new(
                StatusCode::CONFLICT,
                "file_conflict",
                "Este livro mudou em outro aparelho desde a versão de onde esta partiu.",
            );
            e.extra = serde_json::to_value(cur).ok();
            return Err(e);
        }
    }
    let target = s.file_path(&u.book_uid, &u.hash);
    tokio::fs::create_dir_all(target.parent().unwrap_or(&s.files_dir())).await?;
    tokio::fs::rename(&assembled, &target).await?;
    let row = FileRow {
        book_uid: u.book_uid.clone(),
        hash: u.hash.clone(),
        version: current.as_ref().map_or(1, |c| c.version + 1),
        size: u.size,
    };
    {
        let db = s.db();
        db::set_file(&db, &row, now_ms())?;
        db::remove_upload(&db, &id)?;
    }
    remove_dir(&dir);
    if let Some(old) = current {
        let _ = tokio::fs::remove_file(s.file_path(&u.book_uid, &old.hash)).await;
    }
    Ok(Json(row))
}

async fn health() -> &'static str {
    "ok"
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/login", post(login))
        .route("/v1/logout", post(logout))
        .route("/v1/changes", get(get_changes).post(post_changes))
        .route("/v1/files", get(list_files))
        .route("/v1/files/{book_uid}", get(get_file).head(head_file))
        .route("/v1/uploads", post(start_upload))
        .route("/v1/uploads/{id}/finish", post(finish_upload))
        .route(
            "/v1/uploads/{id}/{n}",
            put(put_part).layer(DefaultBodyLimit::max(PART_SIZE as usize + 1024)),
        )
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }

    #[test]
    fn secrets_compare_by_value() {
        assert!(same_secret("a", "a"));
        assert!(!same_secret("a", "ab"));
        assert!(is_hash(&"a".repeat(64)));
        assert!(!is_hash(&"A".repeat(64)));
    }
}
