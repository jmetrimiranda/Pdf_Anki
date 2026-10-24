//! Client of the library sync server (`server/library-sync`, spec 16, docs/planos/fase-9a.md): login, records
//! (`GET/POST /v1/changes`) and book files, sent in parts of the size the server asks for and fetched in ranges, so
//! no request passes Cloudflare's 100 MB limit. Pure Rust, no desktop APIs (keeps the iOS door open).

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Size of a download range.
pub const RANGE_SIZE: u64 = 32 * 1024 * 1024;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum LibError {
    #[error("Sem conexão com o servidor da biblioteca.")]
    Offline,
    #[error("Este aparelho não está conectado à biblioteca (ou foi desconectado). Entre de novo.")]
    Unauthorized,
    #[error("Usuário ou senha da biblioteca incorretos.")]
    BadLogin,
    #[error("Muitas tentativas de login erradas. Espere 10 minutos.")]
    LoginLocked,
    #[error("O servidor não tem o arquivo deste livro.")]
    NotFound,
    #[error("O servidor da biblioteca respondeu com erro ({0}): {1}")]
    Server(u16, String),
    #[error("Endereço do servidor inválido: {0}")]
    BadUrl(String),
    #[error("O arquivo baixado não confere (hash diferente); tente de novo.")]
    HashMismatch,
    #[error("Erro ao ler ou gravar o arquivo: {0}")]
    Io(String),
    /// The server's sequence is behind this device's cursor (a restored or new database): pull again from 0.
    #[error("O servidor da biblioteca voltou a um estado anterior; sincronizando tudo de novo.")]
    CursorAhead,
}

impl LibError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Offline => "library_offline",
            Self::Unauthorized => "library_unauthorized",
            Self::BadLogin => "library_bad_login",
            Self::LoginLocked => "library_login_locked",
            Self::NotFound => "library_not_found",
            Self::Server(..) => "library_server",
            Self::BadUrl(_) => "library_bad_url",
            Self::HashMismatch => "library_hash_mismatch",
            Self::Io(_) => "library_io",
            Self::CursorAhead => "library_cursor_ahead",
        }
    }
}

impl From<std::io::Error> for LibError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

pub type Result<T, E = LibError> = std::result::Result<T, E>;

/// One record as it travels (same shape as the server's).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireRecord {
    pub kind: String,
    pub key: String,
    pub updated_at: i64,
    pub deleted: bool,
    pub data: Value,
    #[serde(default, skip_serializing)]
    pub seq: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChangesPage {
    pub records: Vec<WireRecord>,
    pub cursor: i64,
    pub more: bool,
    /// The server database's identity: another one than the cursor came from means pulling again from 0.
    #[serde(default)]
    pub epoch: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum PushResult {
    Accepted { kind: String, key: String, seq: i64 },
    Stale { current: WireRecord },
}

/// The current file of a book on the server (`book_uid` only in the list of `GET /v1/files`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    #[serde(default)]
    pub book_uid: String,
    pub hash: String,
    pub version: u32,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Uploaded {
    /// It is the current version now.
    Done(RemoteFile),
    /// Another device changed the book since `base`: here is the current version (spec 16: conflict copy).
    Conflict(RemoteFile),
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    current: Option<RemoteFile>,
}

/// SHA-256 of a file, streamed.
pub async fn file_sha256(path: &Path) -> Result<String> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

#[derive(Clone)]
pub struct LibraryClient {
    base: String,
    http: reqwest::Client,
    token: Option<String>,
}

impl std::fmt::Debug for LibraryClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LibraryClient")
            .field("base", &self.base)
            .field("token", &"***")
            .finish()
    }
}

/// `https://host/` (or `http://` for a local server) without a trailing slash.
pub fn normalize_url(raw: &str) -> Result<String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| LibError::BadUrl("use https://…".into()))?;
    if rest.is_empty() || rest.contains(char::is_whitespace) || rest.contains(['?', '#', '@']) {
        return Err(LibError::BadUrl(raw.trim().to_owned()));
    }
    Ok(url.to_owned())
}

fn transport(e: reqwest::Error) -> LibError {
    tracing::debug!(%e, "library sync transport error");
    LibError::Offline
}

async fn error_of(resp: reqwest::Response) -> LibError {
    let status = resp.status().as_u16();
    let body: Option<ErrorBody> = resp.json().await.ok();
    match (status, body.as_ref().map(|b| b.code.as_str())) {
        (401, Some("bad_login")) => LibError::BadLogin,
        (401, _) => LibError::Unauthorized,
        (429, _) => LibError::LoginLocked,
        (409, Some("cursor_ahead")) => LibError::CursorAhead,
        (404, _) => LibError::NotFound,
        _ => LibError::Server(status, body.map(|b| b.message).unwrap_or_default()),
    }
}

impl LibraryClient {
    pub fn new(base_url: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // Per request: a 32 MB part over a slow link still fits.
            .timeout(Duration::from_secs(600))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| LibError::Io(e.to_string()))?;
        Ok(Self {
            base: normalize_url(base_url)?,
            http,
            token: None,
        })
    }

    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let r = self.http.request(method, format!("{}{path}", self.base));
        match &self.token {
            Some(t) => r.bearer_auth(t),
            None => r,
        }
    }

    async fn send(&self, r: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let resp = r.send().await.map_err(transport)?;
        if resp.status().is_success() {
            Ok(resp)
        } else {
            Err(error_of(resp).await)
        }
    }

    /// A new device token from the library user and password.
    pub async fn login(&self, user: &str, password: &str, device: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Reply {
            token: String,
        }
        let resp = self
            .send(
                self.req(reqwest::Method::POST, "/v1/login")
                    .json(&serde_json::json!({
                        "user": user, "password": password, "device": device
                    })),
            )
            .await?;
        Ok(resp.json::<Reply>().await.map_err(transport)?.token)
    }

    /// Revokes this device's token on the server.
    pub async fn logout(&self) -> Result<()> {
        self.send(self.req(reqwest::Method::POST, "/v1/logout"))
            .await?;
        Ok(())
    }

    pub async fn changes(&self, since: i64) -> Result<ChangesPage> {
        let resp = self
            .send(self.req(reqwest::Method::GET, &format!("/v1/changes?since={since}")))
            .await?;
        resp.json().await.map_err(transport)
    }

    pub async fn push(&self, records: &[WireRecord]) -> Result<Vec<PushResult>> {
        #[derive(Deserialize)]
        struct Reply {
            results: Vec<PushResult>,
        }
        let resp = self
            .send(
                self.req(reqwest::Method::POST, "/v1/changes")
                    .json(&serde_json::json!({ "records": records })),
            )
            .await?;
        Ok(resp.json::<Reply>().await.map_err(transport)?.results)
    }

    /// The current file of every book on the server.
    pub async fn files(&self) -> Result<Vec<RemoteFile>> {
        let resp = self
            .send(self.req(reqwest::Method::GET, "/v1/files"))
            .await?;
        resp.json().await.map_err(transport)
    }

    /// The server's current file of a book (`None`: it has none).
    pub async fn file_info(&self, book_uid: &str) -> Result<Option<RemoteFile>> {
        match self
            .send(self.req(reqwest::Method::HEAD, &format!("/v1/files/{book_uid}")))
            .await
        {
            Ok(resp) => {
                let h = resp.headers();
                let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
                Ok(Some(RemoteFile {
                    book_uid: book_uid.to_owned(),
                    hash: get("x-file-hash").unwrap_or_default(),
                    version: get("x-file-version")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(1),
                    size: get("content-length")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0),
                }))
            }
            Err(LibError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Downloads the current file of a book to `dest` in ranges, checking its hash; `on_progress(done, total)`.
    pub async fn download(
        &self,
        book_uid: &str,
        dest: &Path,
        mut on_progress: impl FnMut(u64, u64),
    ) -> Result<RemoteFile> {
        let info = self.file_info(book_uid).await?.ok_or(LibError::NotFound)?;
        let mut out = tokio::fs::File::create(dest).await?;
        let mut hasher = Sha256::new();
        let mut done = 0u64;
        while done < info.size {
            let end = (done + RANGE_SIZE).min(info.size) - 1;
            let resp = self
                .send(
                    self.req(reqwest::Method::GET, &format!("/v1/files/{book_uid}"))
                        .header(reqwest::header::RANGE, format!("bytes={done}-{end}")),
                )
                .await?;
            // The server answered for another version (changed meanwhile): start over from the caller.
            if resp
                .headers()
                .get("x-file-hash")
                .and_then(|v| v.to_str().ok())
                != Some(info.hash.as_str())
            {
                return Err(LibError::HashMismatch);
            }
            let bytes = resp.bytes().await.map_err(transport)?;
            if bytes.len() as u64 != end - done + 1 {
                return Err(LibError::Offline);
            }
            hasher.update(&bytes);
            out.write_all(&bytes).await?;
            done = end + 1;
            on_progress(done, info.size);
        }
        out.sync_all().await?;
        if hex::encode(hasher.finalize()) != info.hash {
            return Err(LibError::HashMismatch);
        }
        Ok(info)
    }

    /// Sends `path` as a new version of a book made from `base` (`""`: from nothing the server knew).
    pub async fn upload(
        &self,
        book_uid: &str,
        base: &str,
        path: &Path,
        mut on_progress: impl FnMut(u64, u64),
    ) -> Result<Uploaded> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Started {
            upload_id: String,
            part_size: u64,
            parts: u64,
        }
        let size = tokio::fs::metadata(path).await?.len();
        let hash = file_sha256(path).await?;
        let started: Started = self
            .send(
                self.req(reqwest::Method::POST, "/v1/uploads")
                    .json(&serde_json::json!({
                        "bookUid": book_uid, "base": base, "hash": hash, "size": size
                    })),
            )
            .await?
            .json()
            .await
            .map_err(transport)?;
        let mut f = tokio::fs::File::open(path).await?;
        for n in 0..started.parts {
            let len = (size - n * started.part_size).min(started.part_size);
            let mut buf = vec![0u8; len as usize];
            f.seek(std::io::SeekFrom::Start(n * started.part_size))
                .await?;
            f.read_exact(&mut buf).await?;
            self.send(
                self.req(
                    reqwest::Method::PUT,
                    &format!("/v1/uploads/{}/{n}", started.upload_id),
                )
                .body(buf),
            )
            .await?;
            on_progress((n * started.part_size + len).min(size), size);
        }
        let resp = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/uploads/{}/finish", started.upload_id),
            )
            .send()
            .await
            .map_err(transport)?;
        if resp.status().as_u16() == 409 {
            let body: ErrorBody = resp.json().await.map_err(transport)?;
            return match body.current {
                Some(current) => Ok(Uploaded::Conflict(current)),
                None => Err(LibError::Server(409, body.message)),
            };
        }
        if !resp.status().is_success() {
            return Err(error_of(resp).await);
        }
        Ok(Uploaded::Done(resp.json().await.map_err(transport)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(
            normalize_url(" https://leitor-sync.x.com/ ").unwrap(),
            "https://leitor-sync.x.com"
        );
        assert_eq!(
            normalize_url("http://127.0.0.1:8090").unwrap(),
            "http://127.0.0.1:8090"
        );
        assert!(normalize_url("leitor.x.com").is_err());
        assert!(normalize_url("https://a b").is_err());
        assert!(normalize_url("https://user@x.com").is_err());
    }

    #[test]
    fn the_token_never_shows() {
        let c = LibraryClient::new("https://x.com")
            .unwrap()
            .with_token("segredo-123");
        assert!(!format!("{c:?}").contains("segredo"));
    }
}
