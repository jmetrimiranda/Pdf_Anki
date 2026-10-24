//! A local server replaying recorded provider responses, and an in-memory ledger: shared by the adapter tests.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::Value;

use core_ai::limits::Spent;
use core_ai::{Ledger, UsageRecord};

/// Status, body and an optional `retry-after` header.
pub type Reply = (u16, &'static str, Option<&'static str>);

#[derive(Clone, Default)]
pub struct Fake {
    replies: Arc<Mutex<VecDeque<Reply>>>,
    /// Path (with query), headers and JSON body of each request, in order.
    pub seen: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>,
}

pub fn recorded(provider: &str, name: &str) -> &'static str {
    let path = format!(
        "{}/tests/recorded/{provider}/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    Box::leak(std::fs::read_to_string(path).unwrap().into_boxed_str())
}

async fn handle(State(f): State<Fake>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let path = uri
        .path_and_query()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_default();
    f.seen.lock().unwrap().push((path, headers, json));
    let (status, body, retry) = f
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("a scripted reply");
    let mut resp = (StatusCode::from_u16(status).unwrap(), body).into_response();
    resp.headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    if let Some(r) = retry {
        resp.headers_mut().insert("retry-after", r.parse().unwrap());
    }
    resp
}

pub async fn serve(replies: Vec<Reply>) -> (String, Fake) {
    let fake = Fake {
        replies: Arc::new(Mutex::new(replies.into())),
        ..Fake::default()
    };
    let app = Router::new().fallback(handle).with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), fake)
}

#[derive(Default)]
pub struct MemLedger {
    pub records: Mutex<Vec<UsageRecord>>,
}

impl Ledger for MemLedger {
    fn spent(&self) -> core_ai::Result<Spent> {
        let total: f64 = self
            .records
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.cost_usd)
            .sum();
        Ok(Spent {
            day_usd: total,
            month_usd: total,
        })
    }
    fn record(&self, rec: &UsageRecord) -> core_ai::Result<()> {
        self.records.lock().unwrap().push(rec.clone());
        Ok(())
    }
}
