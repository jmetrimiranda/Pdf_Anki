//! A scripted provider for tests (plan 7.2): no network, no key; it replays answers in order and counts calls.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::error::{AiError, Result};
use crate::prices::ModelPrice;
use crate::provider::{BoxFuture, Provider};
use crate::types::{ApiKey, Completion, CompletionRequest, ProviderKind};

pub struct SimulatedProvider {
    kind: ProviderKind,
    script: Mutex<VecDeque<Result<Completion>>>,
    calls: AtomicUsize,
    last: Mutex<Option<CompletionRequest>>,
}

impl SimulatedProvider {
    pub fn new(kind: ProviderKind, script: Vec<Result<Completion>>) -> Self {
        Self {
            kind,
            script: Mutex::new(script.into()),
            calls: AtomicUsize::new(0),
            last: Mutex::new(None),
        }
    }

    pub fn push(&self, answer: Result<Completion>) {
        self.script
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push_back(answer);
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub fn last_request(&self) -> Option<CompletionRequest> {
        self.last.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl Provider for SimulatedProvider {
    fn kind(&self) -> ProviderKind {
        self.kind
    }

    fn complete<'a>(
        &'a self,
        _key: &'a ApiKey,
        req: &'a CompletionRequest,
        _price: &'a ModelPrice,
    ) -> BoxFuture<'a, Completion> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Some(req.clone());
            self.script
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .pop_front()
                .unwrap_or_else(|| {
                    Err(AiError::Internal(
                        "simulated provider: no scripted answer left".into(),
                    ))
                })
        })
    }

    fn test_key<'a>(&'a self, _key: &'a ApiKey, _model: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}
