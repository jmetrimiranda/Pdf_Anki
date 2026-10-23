//! HTTP API: routing, auth, request validation and the one-at-a-time queue.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::validate::validate_request;

/// Largest request body.
pub const BODY_LIMIT: usize = 1024 * 1024;
/// Bodies over [`BODY_LIMIT`] are still read (and dropped) up to this size before the 413, so a reverse proxy that is
/// still sending them gets the 413 instead of a broken pipe (which Caddy would turn into a 502). Larger ones are cut
/// off at once.
pub const DRAIN_LIMIT: usize = 8 * 1024 * 1024;
/// Requests allowed to wait while one runs; more get 503.
pub const MAX_WAITING: usize = 8;
/// Run time limit (wall clock); `timeout_ms` can lower it.
pub const MAX_RUN_TIMEOUT_MS: u64 = 10_000;
const MIN_RUN_TIMEOUT_MS: u64 = 100;

/// `POST /run` body (spec 11.5).
#[derive(Debug, Deserialize)]
struct RunRequest {
    language: String,
    files: BTreeMap<String, String>,
    #[serde(default)]
    stdin: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// A validated job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub files: BTreeMap<String, String>,
    /// Translation units, in name order.
    pub sources: Vec<String>,
    pub stdin: String,
    pub timeout_ms: u64,
}

/// `POST /run` response: spec 11.5 shape plus `compile.time_ms`, `run.signal`, `run.truncated` and `compiler`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunResponse {
    pub compile: CompileOut,
    pub run: Option<RunOut>,
    pub compiler: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompileOut {
    pub ok: bool,
    pub stderr: String,
    pub time_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunOut {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub time_ms: u64,
    pub timed_out: bool,
    pub truncated: bool,
}

pub type JobFuture = Pin<Box<dyn Future<Output = Result<RunResponse, String>> + Send>>;
/// Runs a job (the real one is [`crate::exec::Executor::run`]; tests plug in fakes).
pub type Executor = Arc<dyn Fn(Job) -> JobFuture + Send + Sync>;

pub struct AppState {
    token: Vec<u8>,
    exec: Executor,
    slot: Arc<Semaphore>,
    pending: Arc<AtomicUsize>,
}

impl AppState {
    /// `token` must not be empty (checked by the caller at startup).
    pub fn new(token: &str, exec: Executor) -> Arc<Self> {
        Arc::new(Self {
            token: token.as_bytes().to_vec(),
            exec,
            slot: Arc::new(Semaphore::new(1)),
            pending: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Requests running or waiting.
    pub fn pending(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/run", post(run))
        .with_state(state)
}

fn error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    let body = serde_json::json!({ "error": code, "message": message.into() });
    (status, axum::Json(body)).into_response()
}

/// Compares in time independent of where the inputs differ.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    std::hint::black_box(diff) == 0
}

fn authorized(headers: &HeaderMap, token: &[u8]) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some((scheme, presented)) = value.trim().split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("bearer") && constant_time_eq(presented.trim().as_bytes(), token)
}

/// Decrements the pending counter when the request (or its detached job) is done.
struct Ticket(Arc<AtomicUsize>);

impl Drop for Ticket {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

enum BodyError {
    TooLarge,
    Read,
}

/// Reads at most [`BODY_LIMIT`] bytes, draining (not keeping) the rest up to [`DRAIN_LIMIT`].
async fn read_body(headers: &HeaderMap, mut body: Body) -> Result<Bytes, BodyError> {
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > DRAIN_LIMIT) {
        return Err(BodyError::TooLarge);
    }
    let mut kept = Vec::new();
    let mut seen = 0usize;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| BodyError::Read)?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        seen = seen.saturating_add(data.len());
        if seen > DRAIN_LIMIT {
            return Err(BodyError::TooLarge);
        }
        if seen <= BODY_LIMIT {
            kept.extend_from_slice(&data);
        }
    }
    if seen > BODY_LIMIT {
        Err(BodyError::TooLarge)
    } else {
        Ok(kept.into())
    }
}

async fn run(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Body) -> Response {
    if !authorized(&headers, &state.token) {
        return error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or wrong bearer token",
        );
    }
    let body = match read_body(&headers, body).await {
        Ok(body) => body,
        Err(BodyError::TooLarge) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                format!("body over {BODY_LIMIT} bytes"),
            );
        }
        Err(BodyError::Read) => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_body",
                "could not read the body",
            );
        }
    };
    let request: RunRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(err) => return error(StatusCode::BAD_REQUEST, "invalid_json", err.to_string()),
    };
    if request.language != "cpp" {
        return error(
            StatusCode::BAD_REQUEST,
            "unsupported_language",
            "only \"cpp\" is supported",
        );
    }
    let sources = match validate_request(&request.files, &request.stdin) {
        Ok(sources) => sources.into_iter().map(str::to_owned).collect(),
        Err(err) if err.is_too_large() => {
            return error(StatusCode::PAYLOAD_TOO_LARGE, err.code(), err.to_string());
        }
        Err(err) => return error(StatusCode::BAD_REQUEST, err.code(), err.to_string()),
    };
    let job = Job {
        sources,
        files: request.files,
        stdin: request.stdin,
        timeout_ms: request
            .timeout_ms
            .unwrap_or(MAX_RUN_TIMEOUT_MS)
            .clamp(MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS),
    };

    // One running + MAX_WAITING waiting.
    if state.pending.fetch_add(1, Ordering::SeqCst) > MAX_WAITING {
        state.pending.fetch_sub(1, Ordering::SeqCst);
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "too many runs waiting",
        );
    }
    let ticket = Ticket(Arc::clone(&state.pending));
    let slot = Arc::clone(&state.slot);
    let exec = Arc::clone(&state.exec);
    // Detached: a client that disconnects can't cut a run short (its processes are always cleaned up) nor let the
    // next one start early.
    let handle = tokio::spawn(async move {
        let _ticket = ticket;
        let Ok(_permit) = slot.acquire_owned().await else {
            return Err("queue closed".to_owned());
        };
        let files = job.files.len();
        let result = exec(job).await;
        match &result {
            Ok(r) => eprintln!(
                "run: files={files} compile_ok={} exit={:?} signal={:?} time_ms={} timed_out={}",
                r.compile.ok,
                r.run.as_ref().and_then(|x| x.exit_code),
                r.run.as_ref().and_then(|x| x.signal.as_deref()),
                r.run.as_ref().map_or(0, |x| x.time_ms),
                r.run.as_ref().is_some_and(|x| x.timed_out),
            ),
            Err(err) => eprintln!("run: files={files} internal error: {err}"),
        }
        result
    });
    match handle.await {
        Ok(Ok(response)) => (StatusCode::OK, axum::Json(response)).into_response(),
        Ok(Err(err)) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal", err),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "job failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::time::Duration;
    use tower::ServiceExt;

    const TOKEN: &str = "test-token";

    fn fake(delay: Duration, active: Arc<AtomicUsize>, max: Arc<AtomicUsize>) -> Executor {
        Arc::new(move |job: Job| {
            let active = Arc::clone(&active);
            let max = Arc::clone(&max);
            Box::pin(async move {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(delay).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(RunResponse {
                    compile: CompileOut {
                        ok: true,
                        stderr: String::new(),
                        time_ms: 1,
                    },
                    run: Some(RunOut {
                        stdout: job.sources.join(","),
                        exit_code: Some(0),
                        ..RunOut::default()
                    }),
                    compiler: None,
                })
            })
        })
    }

    fn app(delay: Duration) -> (Arc<AppState>, Arc<AtomicUsize>) {
        let max = Arc::new(AtomicUsize::new(0));
        let state = AppState::new(
            TOKEN,
            fake(delay, Arc::new(AtomicUsize::new(0)), Arc::clone(&max)),
        );
        (state, max)
    }

    fn post(auth: Option<&str>, body: impl Into<Body>) -> Request<Body> {
        let mut builder = Request::post("/run").header(header::CONTENT_TYPE, "application/json");
        if let Some(auth) = auth {
            builder = builder.header(header::AUTHORIZATION, auth);
        }
        builder.body(body.into()).unwrap()
    }

    fn ok_body() -> String {
        serde_json::json!({"language": "cpp", "files": {"main.cpp": "int main(){}"}, "stdin": "", "timeout_ms": 1000})
            .to_string()
    }

    async fn send(state: &Arc<AppState>, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let response = router(Arc::clone(state)).oneshot(req).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::String(
            String::from_utf8_lossy(&bytes).into_owned(),
        ));
        (status, json)
    }

    #[tokio::test]
    async fn health_needs_no_token() {
        let (state, _) = app(Duration::ZERO);
        let response = router(state)
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            &response.into_body().collect().await.unwrap().to_bytes()[..],
            b"ok"
        );
    }

    #[tokio::test]
    async fn auth() {
        let (state, _) = app(Duration::ZERO);
        for auth in [
            None,
            Some("Bearer wrong"),
            Some("Basic test-token"),
            Some("test-token"),
            Some("Bearer "),
            Some("Bearer test-token-x"),
            Some("Bearer test-toke"),
        ] {
            let (status, json) = send(&state, post(auth, ok_body())).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{auth:?}");
            assert_eq!(json["error"], "unauthorized");
        }
        for auth in ["Bearer test-token", "bearer test-token"] {
            let (status, _) = send(&state, post(Some(auth), ok_body())).await;
            assert_eq!(status, StatusCode::OK, "{auth}");
        }
        // Auth comes before parsing: garbage without a token is 401, not 400.
        let (status, _) = send(&state, post(None, "{")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
    }

    #[tokio::test]
    async fn validation() {
        let (state, _) = app(Duration::ZERO);
        let bearer = Some("Bearer test-token");
        let cases = [
            ("{", StatusCode::BAD_REQUEST, "invalid_json"),
            (
                r#"{"files":{"main.cpp":""}}"#,
                StatusCode::BAD_REQUEST,
                "invalid_json",
            ),
            (
                r#"{"language":"python","files":{"main.py":""}}"#,
                StatusCode::BAD_REQUEST,
                "unsupported_language",
            ),
            (
                r#"{"language":"cpp","files":{"../x.cpp":""}}"#,
                StatusCode::BAD_REQUEST,
                "invalid_name",
            ),
            (
                r#"{"language":"cpp","files":{"main.cpp":"","check.hpp":""}}"#,
                StatusCode::BAD_REQUEST,
                "reserved_name",
            ),
            (
                r#"{"language":"cpp","files":{"a.hpp":""}}"#,
                StatusCode::BAD_REQUEST,
                "no_source",
            ),
        ];
        for (body, status, code) in cases {
            let (got, json) = send(&state, post(bearer, body)).await;
            assert_eq!(got, status, "{body}");
            assert_eq!(json["error"], code, "{body}");
        }
        let big =
            serde_json::json!({"language": "cpp", "files": {"main.cpp": "x".repeat(600 * 1024)}})
                .to_string();
        let (status, json) = send(&state, post(bearer, big)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(json["error"], "source_too_large");
        let huge = serde_json::json!({"language": "cpp", "files": {"main.cpp": "x"}, "stdin": "y".repeat(BODY_LIMIT)})
            .to_string();
        let (status, json) = send(&state, post(bearer, huge)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(json["error"], "body_too_large");
        // Way over: refused from the Content-Length alone.
        let mut req = post(bearer, "{}");
        req.headers_mut()
            .insert(header::CONTENT_LENGTH, (DRAIN_LIMIT + 1).into());
        let (status, _) = send(&state, req).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn timeout_is_clamped() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        let exec: Executor = Arc::new(move |job: Job| {
            record.lock().unwrap().push(job.timeout_ms);
            Box::pin(async { Ok(RunResponse::default()) })
        });
        let state = AppState::new(TOKEN, exec);
        for t in [
            "",
            r#","timeout_ms":60000"#,
            r#","timeout_ms":2500"#,
            r#","timeout_ms":0"#,
        ] {
            let body = format!(r#"{{"language":"cpp","files":{{"main.cpp":""}}{t}}}"#);
            let (status, _) = send(&state, post(Some("Bearer test-token"), body)).await;
            assert_eq!(status, StatusCode::OK);
        }
        assert_eq!(*seen.lock().unwrap(), vec![10_000, 10_000, 2_500, 100]);
    }

    #[tokio::test]
    async fn one_run_at_a_time() {
        let (state, max) = app(Duration::from_millis(100));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let state = Arc::clone(&state);
            handles.push(tokio::spawn(async move {
                send(&state, post(Some("Bearer test-token"), ok_body())).await
            }));
        }
        for handle in handles {
            let (status, json) = handle.await.unwrap();
            assert_eq!(status, StatusCode::OK);
            assert_eq!(json["run"]["stdout"], "main.cpp");
        }
        assert_eq!(max.load(Ordering::SeqCst), 1);
        assert_eq!(state.pending(), 0);
    }

    #[tokio::test]
    async fn full_queue_is_busy() {
        let (state, _) = app(Duration::from_millis(1500));
        let mut handles = Vec::new();
        for _ in 0..=MAX_WAITING {
            let state = Arc::clone(&state);
            handles.push(tokio::spawn(async move {
                send(&state, post(Some("Bearer test-token"), ok_body())).await
            }));
        }
        for _ in 0..200 {
            if state.pending() == MAX_WAITING + 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(state.pending(), MAX_WAITING + 1);
        let (status, json) = send(&state, post(Some("Bearer test-token"), ok_body())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json["error"], "busy");
        assert_eq!(state.pending(), MAX_WAITING + 1);
        // Health stays up while the queue is full.
        let response = router(Arc::clone(&state))
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        for handle in handles {
            handle.abort();
        }
    }

    #[test]
    fn response_shape() {
        let response = RunResponse {
            compile: CompileOut {
                ok: true,
                stderr: String::new(),
                time_ms: 5,
            },
            run: Some(RunOut {
                exit_code: Some(0),
                signal: None,
                stdout: "oi\n".into(),
                stderr: String::new(),
                time_ms: 2,
                timed_out: false,
                truncated: false,
            }),
            compiler: Some("g++ 12".into()),
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "compile": {"ok": true, "stderr": "", "time_ms": 5},
                "run": {"exit_code": 0, "signal": null, "stdout": "oi\n", "stderr": "", "time_ms": 2,
                        "timed_out": false, "truncated": false},
                "compiler": "g++ 12"
            })
        );
        let failed = RunResponse {
            compile: CompileOut {
                ok: false,
                ..CompileOut::default()
            },
            ..RunResponse::default()
        };
        assert_eq!(
            serde_json::to_value(&failed).unwrap()["run"],
            serde_json::Value::Null
        );
    }
}
