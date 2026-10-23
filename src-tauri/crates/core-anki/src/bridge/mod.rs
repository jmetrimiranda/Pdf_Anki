//! The `POST /_anki/<method>` bridge of the Anki web pages and the cards (spec 8.3, 8.4).
//!
//! Transport-agnostic: the app crate turns HTTP requests of the `anki` and `card` protocols into
//! [`PostRequest`]s and sends back the [`PostReply`]. Decisions per method are documented in
//! `docs/anki-handlers.md` (a test keeps it in sync with [`POST_HANDLERS`] and
//! [`EXPOSED_METHODS`]).
//!
//! - Backend methods (`exposed_backend_list`) are dispatched by name to the generated service
//!   traits on the actor ([`dispatch`]); `latestProgress` and `setWantsAbort` are answered
//!   outside it, `addMediaFromUrl` (Backend-only) is 404.
//! - Python post handlers (`post_handler_list`) are forwarded, implemented here, or 404.
//! - Cards may call only [`CARD_METHODS`] (403 for anything else, even unknown names).

mod dispatch;
mod events;
mod handlers;
mod policy;

use std::sync::{Arc, Mutex, PoisonError};

use anki::error::AnkiError;
use anki::prelude::I18n;
use prost::Message;

pub use dispatch::{EXPOSED_METHODS, exposed_decision};
pub use events::{BridgeEvent, EventSink};
pub use handlers::POST_HANDLERS;
pub use policy::{ANKI_ORIGINS, CARD_METHODS, CONTENT_TYPE, MAX_BODY_BYTES};

use crate::AnkiService;
use crate::study::Study;

/// What the bridge does with a method name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Forwarded to rslib (generated service trait method on `Collection`).
    Forward,
    /// Implemented by the app (in this module).
    App,
    /// Not served: 404.
    NotFound,
}

impl Decision {
    /// The wording used in `docs/anki-handlers.md`.
    pub fn doc_label(self) -> &'static str {
        match self {
            Decision::Forward => "repassar ao backend",
            Decision::App => "implementar no app",
            Decision::NotFound => "404",
        }
    }
}

/// Decision for any name: backend entries win on a clash (as in `mediasrv.py`; there is none in
/// 26.09.3). `None` = unknown name.
pub fn decision(method: &str) -> Option<Decision> {
    exposed_decision(method).or_else(|| {
        POST_HANDLERS
            .iter()
            .find(|(name, _)| *name == method)
            .map(|(_, d)| *d)
    })
}

/// Who sent the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    /// An Anki SvelteKit page on the `anki` protocol: the whole whitelist.
    Page,
    /// A card on the `card` protocol: only [`CARD_METHODS`].
    Card,
}

/// A `POST /_anki/<method>` request.
#[derive(Debug, Clone, Default)]
pub struct PostRequest {
    /// camelCase method name (the URL path after `/_anki/`).
    pub method: String,
    /// `Content-Type` header.
    pub content_type: Option<String>,
    /// `Origin` header.
    pub origin: Option<String>,
    /// `Anki-Op-Changes` header (`1`, `2` or `3`).
    pub op_changes: Option<String>,
    /// Raw protobuf body.
    pub body: Vec<u8>,
}

impl PostRequest {
    /// A request with the right content type and no origin/op-changes headers.
    pub fn new(method: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            method: method.into(),
            content_type: Some(CONTENT_TYPE.to_owned()),
            body,
            ..Default::default()
        }
    }
}

/// The reply: status, content type and body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostReply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl PostReply {
    /// 200 with a protobuf body, or 204 when the output is empty (like Anki).
    pub(crate) fn binary(body: Vec<u8>) -> Self {
        if body.is_empty() {
            Self::no_content()
        } else {
            Self {
                status: 200,
                content_type: CONTENT_TYPE,
                body,
            }
        }
    }

    pub(crate) fn no_content() -> Self {
        Self::text(204, "")
    }

    pub(crate) fn text(status: u16, message: &str) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: message.as_bytes().to_vec(),
        }
    }

    pub(crate) fn forbidden() -> Self {
        Self::text(403, "Acesso negado.")
    }

    pub(crate) fn not_found() -> Self {
        Self::text(404, "Não encontrado.")
    }

    /// 500 with the message as the body (the TS client shows `await res.text()`).
    pub(crate) fn error(message: &str) -> Self {
        Self::text(500, message)
    }

    /// Body as text (for errors).
    pub fn text_body(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A failed rslib call, already turned into the reply text.
#[derive(Debug)]
pub(crate) struct Failure(String);

impl Failure {
    /// `Interrupted` stays untranslated: the TS client special-cases `500: Interrupted`.
    pub(crate) fn from_anki(err: &AnkiError, tr: &I18n) -> Self {
        if matches!(err, AnkiError::Interrupted) {
            Failure("Interrupted".into())
        } else {
            Failure(err.message(tr))
        }
    }

    pub(crate) fn reply(&self) -> PostReply {
        PostReply::error(&self.0)
    }
}

/// The bridge. Cheap to clone; share one per app.
#[derive(Clone)]
pub struct Bridge {
    inner: Arc<Inner>,
}

struct Inner {
    svc: AnkiService,
    study: Study,
    sink: EventSink,
    /// Note ids of the open "change notetype" page (the page never sends them).
    change_notetype_notes: Mutex<Option<Vec<i64>>>,
}

impl Bridge {
    pub fn new(svc: AnkiService, study: Study, sink: EventSink) -> Self {
        Self {
            inner: Arc::new(Inner {
                svc,
                study,
                sink,
                change_notetype_notes: Mutex::new(None),
            }),
        }
    }

    /// Answers one request. Never panics on untrusted input: bad bodies become 500 + message.
    pub async fn post(&self, caller: Caller, req: PostRequest) -> PostReply {
        if let Some(refusal) = policy::check(caller, &req) {
            return refusal;
        }
        match decision(&req.method) {
            None | Some(Decision::NotFound) => PostReply::not_found(),
            Some(Decision::Forward) => self.forward(req).await,
            Some(Decision::App) => self.app_handler(req).await,
        }
    }

    /// Registers the notes of the "change notetype" page about to be opened.
    pub fn set_change_notetype_notes(&self, note_ids: Vec<i64>) {
        *self
            .inner
            .change_notetype_notes
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(note_ids);
    }

    /// Forgets per-page state (after a `.colpkg` import replaced the collection).
    pub fn reset(&self) {
        self.inner
            .change_notetype_notes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    fn emit(&self, event: BridgeEvent) {
        (self.inner.sink)(event);
    }

    /// Runs a forwarded method on the actor, then reports op changes.
    async fn forward(&self, req: PostRequest) -> PostReply {
        let PostRequest {
            method,
            op_changes,
            body,
            ..
        } = req;
        let result = self
            .inner
            .svc
            .call(move |col| {
                Ok(dispatch::forward(col, &method, &body)
                    .map(|res| res.map_err(|e| Failure::from_anki(&e, col.tr()))))
            })
            .await;
        match result {
            Err(err) => PostReply::error(&err.to_string()),
            Ok(None) => PostReply::not_found(),
            Ok(Some(Err(failure))) => failure.reply(),
            Ok(Some(Ok(output))) => {
                if let Some(kind) = events::op_changes_kind(op_changes.as_deref())
                    && events::decode_op_changes(kind, &output)
                        .is_some_and(|c| events::has_changes(&c))
                {
                    self.emit(BridgeEvent::Changed);
                }
                PostReply::binary(output)
            }
        }
    }

    /// Runs `f` on the actor and maps rslib errors to reply text.
    async fn on_actor<R, F>(&self, f: F) -> Result<R, PostReply>
    where
        R: Send + 'static,
        F: FnOnce(&mut crate::Collection) -> Result<R, AnkiError> + Send + 'static,
    {
        match self
            .inner
            .svc
            .call(move |col| Ok(f(col).map_err(|e| Failure::from_anki(&e, col.tr()))))
            .await
        {
            Err(err) => Err(PostReply::error(&err.to_string())),
            Ok(Err(failure)) => Err(failure.reply()),
            Ok(Ok(value)) => Ok(value),
        }
    }
}

/// Decodes a request body; a bad body becomes a 500 with a pt-BR message.
pub(crate) fn decode<M: Message + Default>(body: &[u8]) -> Result<M, PostReply> {
    M::decode(body).map_err(|e| PostReply::error(&format!("Requisição inválida: {e}")))
}
