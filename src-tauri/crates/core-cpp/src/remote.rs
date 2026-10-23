//! Client of the remote runner (`server/runner`, spec 11.5): `POST /run` with a Bearer token, `GET /health`.

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::validate::validate_request;
use crate::{
    Backend, CompileResult, CppRequest, CppRunResult, RunError, RunResult, effective_run_timeout_ms,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A configured remote runner.
#[derive(Clone)]
pub struct RemoteRunner {
    url: Url,
    token: String,
    client: reqwest::Client,
}

impl std::fmt::Debug for RemoteRunner {
    // Never print the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteRunner")
            .field("url", &self.url.as_str())
            .finish_non_exhaustive()
    }
}

/// `POST /run` body (spec 11.5).
#[derive(Debug, Serialize)]
struct WireRequest<'a> {
    language: &'static str,
    files: &'a BTreeMap<String, String>,
    stdin: &'a str,
    timeout_ms: u64,
}

/// `POST /run` response (spec 11.5, plus `time_ms` in compile, `signal`/`truncated` in run and `compiler`).
#[derive(Debug, Deserialize)]
struct WireResponse {
    compile: WireCompile,
    run: Option<WireRun>,
    #[serde(default)]
    compiler: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireCompile {
    ok: bool,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    time_ms: u64,
}

#[derive(Debug, Deserialize)]
struct WireRun {
    exit_code: Option<i32>,
    #[serde(default)]
    signal: Option<String>,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    time_ms: u64,
    #[serde(default)]
    timed_out: bool,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct WireError {
    #[serde(default)]
    message: String,
}

impl RemoteRunner {
    /// `url` is the runner's base address (`https://runner.<domínio>/`); http(s) only, token required.
    pub fn new(url: &str, token: &str) -> Result<Self, RunError> {
        let mut url = Url::parse(url.trim())
            .map_err(|err| RunError::InvalidRequest(format!("runner URL: {err}")))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(RunError::InvalidRequest(
                "runner URL must be http(s)://host/".into(),
            ));
        }
        if url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(RunError::InvalidRequest(
                "runner URL must not have credentials, a query or a fragment".into(),
            ));
        }
        if !url.path().ends_with('/') {
            let path = format!("{}/", url.path());
            url.set_path(&path);
        }
        let token = token.trim();
        if token.is_empty() {
            return Err(RunError::RemoteAuth);
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|err| RunError::Io(err.to_string()))?;
        Ok(Self {
            url,
            token: token.to_owned(),
            client,
        })
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    /// Compiles and runs `req` on the runner.
    pub async fn run(&self, req: &CppRequest) -> Result<CppRunResult, RunError> {
        validate_request(&req.files, &req.stdin)?;
        let body = WireRequest {
            language: "cpp",
            files: &req.files,
            stdin: &req.stdin,
            timeout_ms: effective_run_timeout_ms(req),
        };
        let response = self
            .client
            .post(self.endpoint("run")?)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?;
        let status = response.status();
        if !status.is_success() {
            let message = response
                .json::<WireError>()
                .await
                .map(|e| e.message)
                .unwrap_or_default();
            return Err(status_error(status, message));
        }
        let wire: WireResponse = response
            .json()
            .await
            .map_err(|err| RunError::RemoteProtocol(err.to_string()))?;
        Ok(from_wire(wire))
    }

    /// `GET /health` (no token needed; 200 when the runner is up).
    pub async fn health(&self) -> Result<(), RunError> {
        let response = self
            .client
            .get(self.endpoint("health")?)
            .send()
            .await
            .map_err(transport_error)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response.status(), String::new()))
        }
    }

    fn endpoint(&self, path: &str) -> Result<Url, RunError> {
        self.url
            .join(path)
            .map_err(|err| RunError::InvalidRequest(err.to_string()))
    }
}

fn transport_error(err: reqwest::Error) -> RunError {
    if err.is_decode() {
        RunError::RemoteProtocol(err.to_string())
    } else {
        // Connect errors, DNS, TLS and timeouts: the runner can't be reached right now.
        RunError::RemoteUnreachable(err.to_string())
    }
}

fn status_error(status: StatusCode, message: String) -> RunError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => RunError::RemoteAuth,
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => RunError::RemoteBusy,
        StatusCode::PAYLOAD_TOO_LARGE => RunError::TooLarge,
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
            RunError::InvalidRequest(if message.is_empty() {
                status.to_string()
            } else {
                message
            })
        }
        StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT => {
            RunError::RemoteUnreachable(status.to_string())
        }
        _ => RunError::RemoteProtocol(format!("HTTP {status}")),
    }
}

fn from_wire(wire: WireResponse) -> CppRunResult {
    CppRunResult {
        backend: Backend::Remote,
        compiler: wire.compiler.filter(|c| !c.is_empty()),
        compile: CompileResult {
            ok: wire.compile.ok,
            stderr: wire.compile.stderr,
            time_ms: wire.compile.time_ms,
        },
        run: wire.run.map(|run| RunResult {
            exit_code: run.exit_code,
            signal: run.signal,
            stdout: run.stdout,
            stderr: run.stderr,
            time_ms: run.time_ms,
            timed_out: run.timed_out,
            truncated: run.truncated,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let r = RemoteRunner::new("https://runner.example.org", "t").unwrap();
        assert_eq!(
            r.endpoint("run").unwrap().as_str(),
            "https://runner.example.org/run"
        );
        let r = RemoteRunner::new("http://proxy:8080/base", "t").unwrap();
        assert_eq!(
            r.endpoint("health").unwrap().as_str(),
            "http://proxy:8080/base/health"
        );
        assert!(RemoteRunner::new("ftp://x/", "t").is_err());
        assert!(RemoteRunner::new("http://u:p@x/", "t").is_err());
        assert!(RemoteRunner::new("not a url", "t").is_err());
        assert_eq!(
            RemoteRunner::new("http://x/", " ").unwrap_err(),
            RunError::RemoteAuth
        );
    }

    #[test]
    fn debug_hides_token() {
        let r = RemoteRunner::new("http://x/", "s3cr3t-token").unwrap();
        assert!(!format!("{r:?}").contains("s3cr3t"));
    }

    #[test]
    fn statuses() {
        assert_eq!(
            status_error(StatusCode::UNAUTHORIZED, String::new()),
            RunError::RemoteAuth
        );
        assert_eq!(
            status_error(StatusCode::FORBIDDEN, String::new()),
            RunError::RemoteAuth
        );
        assert_eq!(
            status_error(StatusCode::SERVICE_UNAVAILABLE, String::new()),
            RunError::RemoteBusy
        );
        assert_eq!(
            status_error(StatusCode::TOO_MANY_REQUESTS, String::new()),
            RunError::RemoteBusy
        );
        assert_eq!(
            status_error(StatusCode::PAYLOAD_TOO_LARGE, String::new()),
            RunError::TooLarge
        );
        assert_eq!(
            status_error(StatusCode::BAD_REQUEST, "bad name".into()),
            RunError::InvalidRequest("bad name".into())
        );
        assert!(matches!(
            status_error(StatusCode::IM_A_TEAPOT, String::new()),
            RunError::RemoteProtocol(_)
        ));
    }

    #[test]
    fn wire_response() {
        let wire: WireResponse = serde_json::from_str(
            r#"{"compile":{"ok":true,"stderr":""},"run":{"exit_code":0,"stdout":"oi","stderr":"","time_ms":3,"timed_out":false}}"#,
        )
        .unwrap();
        let result = from_wire(wire);
        assert_eq!(result.backend, Backend::Remote);
        let run = result.run.unwrap();
        assert_eq!(run.stdout, "oi");
        assert_eq!(run.exit_code, Some(0));
        assert!(!run.truncated);
        let wire: WireResponse =
            serde_json::from_str(r#"{"compile":{"ok":false,"stderr":"e"},"run":null}"#).unwrap();
        assert!(from_wire(wire).run.is_none());
    }
}
