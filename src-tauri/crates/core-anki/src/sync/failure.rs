//! Sync failure kinds, their pt-BR messages and the classification of rslib errors.

use std::sync::OnceLock;

use anki::error::{AnkiError, NetworkErrorKind, SyncErrorKind};
use anki::prelude::I18n;
use serde::Serialize;

use crate::error::Error;

/// Why a sync (or login) failed. Serialized camelCase; [`SyncFailure::code`] is the stable code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncFailure {
    Offline,
    Timeout,
    TlsUntrusted,
    AuthFailed,
    InvalidUrl,
    AnkiWebRefused,
    InvalidCertificate,
    ClockIncorrect,
    ServerError,
    ServerMessage,
    UploadTooLarge,
    ResyncRequired,
    ClientTooOld,
    Busy,
    Aborted,
    Other,
}

impl SyncFailure {
    /// Worth retrying automatically later (network back, server restarted).
    pub fn is_transient(self) -> bool {
        matches!(
            self,
            SyncFailure::Offline | SyncFailure::Timeout | SyncFailure::ServerError
        )
    }

    pub fn code(self) -> &'static str {
        match self {
            SyncFailure::Offline => "anki.sync.offline",
            SyncFailure::Timeout => "anki.sync.timeout",
            SyncFailure::TlsUntrusted => "anki.sync.tlsUntrusted",
            SyncFailure::AuthFailed => "anki.sync.authFailed",
            SyncFailure::InvalidUrl => "anki.sync.invalidUrl",
            SyncFailure::AnkiWebRefused => "anki.sync.ankiWebRefused",
            SyncFailure::InvalidCertificate => "anki.sync.invalidCertificate",
            SyncFailure::ClockIncorrect => "anki.sync.clockIncorrect",
            SyncFailure::ServerError => "anki.sync.serverError",
            SyncFailure::ServerMessage => "anki.sync.serverMessage",
            SyncFailure::UploadTooLarge => "anki.sync.uploadTooLarge",
            SyncFailure::ResyncRequired => "anki.sync.resyncRequired",
            SyncFailure::ClientTooOld => "anki.sync.clientTooOld",
            SyncFailure::Busy => "anki.sync.busy",
            SyncFailure::Aborted => "anki.sync.aborted",
            SyncFailure::Other => "anki.sync.other",
        }
    }

    /// pt-BR message. `detail` is used by the kinds that carry text (server message, failures).
    pub fn message(self, detail: Option<&str>) -> String {
        let detail = detail.map(str::trim).filter(|d| !d.is_empty());
        match self {
            SyncFailure::Offline => "Sem conexão com o servidor de sincronização.".into(),
            SyncFailure::Timeout => "O servidor de sincronização não respondeu a tempo.".into(),
            SyncFailure::TlsUntrusted => "O certificado do servidor não é confiável. Configure o \
                certificado em Configurações → Anki e sincronização."
                .into(),
            SyncFailure::AuthFailed => {
                "Usuário ou senha incorretos, ou a sessão expirou. Entre de novo.".into()
            }
            SyncFailure::InvalidUrl => {
                "Endereço do servidor inválido. Use algo como https://anki.seu-dominio/.".into()
            }
            SyncFailure::AnkiWebRefused => {
                "Este app não sincroniza com o AnkiWeb. Use o seu servidor próprio.".into()
            }
            SyncFailure::InvalidCertificate => {
                "O arquivo não contém exatamente um certificado PEM válido.".into()
            }
            SyncFailure::ClockIncorrect => "O relógio deste computador está errado. Acerte a data \
                e a hora e tente de novo."
                .into(),
            SyncFailure::ServerMessage => detail
                .unwrap_or("O servidor de sincronização recusou o pedido.")
                .into(),
            SyncFailure::UploadTooLarge => "A coleção é grande demais para o servidor.".into(),
            SyncFailure::ResyncRequired => "A coleção precisa de uma sincronização completa. \
                Sincronize de novo para escolher a direção."
                .into(),
            SyncFailure::ClientTooOld => {
                "O servidor de sincronização exige uma versão mais nova do app.".into()
            }
            SyncFailure::Busy => "Já existe uma sincronização em andamento.".into(),
            SyncFailure::Aborted => "Sincronização cancelada.".into(),
            SyncFailure::ServerError | SyncFailure::Other => format!(
                "Falha na sincronização: {}",
                detail.unwrap_or("erro desconhecido.")
            ),
        }
    }
}

/// Builds [`Error::Sync`] with the pt-BR message of `kind`.
pub(crate) fn sync_error(kind: SyncFailure, detail: Option<String>) -> Error {
    Error::Sync {
        kind,
        message: kind.message(detail.as_deref()),
    }
}

fn pt_br() -> &'static I18n {
    static TR: OnceLock<I18n> = OnceLock::new();
    TR.get_or_init(|| I18n::new(&["pt-BR"]))
}

/// Texts that mean the TLS peer certificate was not trusted (rustls / webpki wording).
fn looks_like_untrusted_cert(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "invalid peer certificate",
        "unknownissuer",
        "certificate",
        "badsignature",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// reqwest's texts (its `Display`, which rslib keeps as the info of `NetworkErrorKind::Other`)
/// for a request that never got through or a body cut short: the network, not the server.
/// HTTP status errors ("HTTP status …"), builder and redirect errors are not in the list.
fn looks_like_transport_failure(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "error sending request",
        "request or response body error",
        "connection closed",
        "connection reset",
        "connection aborted",
        "broken pipe",
        "unexpected eof",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// A transfer cut midway, as rslib 26.09.3 reports it: the body stream of a sync request failed
/// (`IoMonitor::wrap_stream` → "stream failure", read back through a `StreamReader` as an
/// `io::Error` of kind `ConnectionAborted` → "reading stream"), and `From<HttpError> for
/// AnkiError` keeps only `format!("{err:?}")` of that `HttpError` as a `SyncErrorKind::Other`.
/// The io kind survives only in that `Debug` text, e.g.
/// `HttpError { code: 303, context: "reading stream", source: Some(Custom { kind:
/// ConnectionAborted, error: "stream failure (code=303)" }) }`.
fn dropped_transfer(info: &str) -> Option<SyncFailure> {
    let info = info.trim_start();
    if !info.starts_with("HttpError {") {
        return None;
    }
    // `Custom { kind: X, .. }`, `Kind(X)` and `Os { kind: X, .. }` are io::Error's Debug shapes.
    let has_kind = |kind: &str| {
        info.contains(&format!("kind: {kind}")) || info.contains(&format!("Kind({kind})"))
    };
    if has_kind("TimedOut") {
        return Some(SyncFailure::Timeout);
    }
    let dropped = [
        "ConnectionAborted",
        "ConnectionReset",
        "BrokenPipe",
        "UnexpectedEof",
    ]
    .iter()
    .any(|kind| has_kind(kind));
    (dropped || info.contains("stream failure")).then_some(SyncFailure::Offline)
}

/// Maps an rslib error to a failure kind and its detail text (already free of URLs, see
/// rslib's `From<&reqwest::Error>`).
///
/// A connection that failed or dropped midway (also in the middle of a full download) is
/// [`SyncFailure::Offline`]: transient, retried with backoff and when the network returns.
/// `flow::refine` then asks the server directly, which tells an untrusted
/// certificate or a timeout apart.
pub(crate) fn classify(err: &AnkiError) -> (SyncFailure, Option<String>) {
    let detail = || Some(err.message(pt_br()));
    if let AnkiError::SyncError { source } = err
        && matches!(source.kind, SyncErrorKind::Other)
        && let Some(kind) = dropped_transfer(&source.info)
    {
        return (kind, None);
    }
    match err {
        AnkiError::NetworkError { source } => match source.kind {
            NetworkErrorKind::Offline => (SyncFailure::Offline, None),
            NetworkErrorKind::Timeout => (SyncFailure::Timeout, None),
            NetworkErrorKind::Other if looks_like_untrusted_cert(&source.info) => {
                (SyncFailure::TlsUntrusted, None)
            }
            NetworkErrorKind::Other if looks_like_transport_failure(&source.info) => {
                (SyncFailure::Offline, None)
            }
            NetworkErrorKind::ProxyAuth | NetworkErrorKind::Other => (SyncFailure::Other, detail()),
        },

        AnkiError::SyncError { source } => match &source.kind {
            SyncErrorKind::AuthFailed => (SyncFailure::AuthFailed, None),
            SyncErrorKind::ServerMessage => (SyncFailure::ServerMessage, Some(source.info.clone())),
            SyncErrorKind::ClockIncorrect => (SyncFailure::ClockIncorrect, None),
            SyncErrorKind::UploadTooLarge => (SyncFailure::UploadTooLarge, None),
            SyncErrorKind::ResyncRequired
            | SyncErrorKind::DatabaseCheckRequired
            | SyncErrorKind::SanityCheckFailed { .. } => (SyncFailure::ResyncRequired, None),
            SyncErrorKind::ClientTooOld => (SyncFailure::ClientTooOld, None),
            SyncErrorKind::ServerError => (SyncFailure::ServerError, detail()),
            SyncErrorKind::Conflict => (
                SyncFailure::ServerError,
                Some("o servidor está ocupado com outra sincronização desta conta.".into()),
            ),
            SyncErrorKind::SyncNotStarted | SyncErrorKind::Other => (SyncFailure::Other, detail()),
        },
        AnkiError::Interrupted => (SyncFailure::Aborted, None),
        _ => (SyncFailure::Other, detail()),
    }
}

/// [`classify`] as an [`Error::Sync`], with every occurrence of the given secrets removed from
/// the message.
pub(crate) fn from_anki(err: &AnkiError, secrets: &[&str]) -> Error {
    let (kind, detail) = classify(err);
    let mut message = kind.message(detail.as_deref());
    for secret in secrets.iter().filter(|s| s.len() >= 3) {
        message = message.replace(secret, "•••");
    }
    Error::Sync { kind, message }
}

/// Refines a failure using the `reqwest` error of a direct request to the server: rslib only
/// keeps reqwest's top-level text ("error sending request"), which hides refused connections and
/// TLS failures.
pub(crate) fn classify_reqwest(err: &reqwest::Error) -> Option<SyncFailure> {
    let mut chain = String::new();
    let mut source: Option<&dyn std::error::Error> = Some(err);
    while let Some(e) = source {
        chain.push_str(&e.to_string());
        chain.push('\n');
        source = e.source();
    }
    if looks_like_untrusted_cert(&chain) {
        Some(SyncFailure::TlsUntrusted)
    } else if err.is_timeout() {
        Some(SyncFailure::Timeout)
    } else if err.is_connect() {
        Some(SyncFailure::Offline)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use anki::error::{NetworkError, SyncError};

    use super::*;

    fn net(kind: NetworkErrorKind, info: &str) -> AnkiError {
        AnkiError::NetworkError {
            source: NetworkError {
                info: info.into(),
                kind,
            },
        }
    }

    fn sync(kind: SyncErrorKind, info: &str) -> AnkiError {
        AnkiError::SyncError {
            source: SyncError {
                info: info.into(),
                kind,
            },
        }
    }

    #[test]
    fn classifies_rslib_errors() {
        let cases = [
            (net(NetworkErrorKind::Offline, ""), SyncFailure::Offline),
            (net(NetworkErrorKind::Timeout, ""), SyncFailure::Timeout),
            (
                net(
                    NetworkErrorKind::Other,
                    "invalid peer certificate: UnknownIssuer",
                ),
                SyncFailure::TlsUntrusted,
            ),
            (
                net(NetworkErrorKind::Other, "error sending request for url ()"),
                SyncFailure::Offline,
            ),
            (
                net(NetworkErrorKind::Other, "request or response body error"),
                SyncFailure::Offline,
            ),
            (
                net(
                    NetworkErrorKind::Other,
                    "HTTP status client error (404 Not Found) for url ()",
                ),
                SyncFailure::Other,
            ),
            (
                net(NetworkErrorKind::Other, "builder error"),
                SyncFailure::Other,
            ),
            (net(NetworkErrorKind::ProxyAuth, ""), SyncFailure::Other),
            (sync(SyncErrorKind::AuthFailed, ""), SyncFailure::AuthFailed),
            (
                sync(SyncErrorKind::ServerMessage, "manutenção"),
                SyncFailure::ServerMessage,
            ),
            (
                sync(SyncErrorKind::ClockIncorrect, ""),
                SyncFailure::ClockIncorrect,
            ),
            (
                sync(SyncErrorKind::UploadTooLarge, "1 > 0"),
                SyncFailure::UploadTooLarge,
            ),
            (
                sync(SyncErrorKind::ResyncRequired, ""),
                SyncFailure::ResyncRequired,
            ),
            (
                sync(
                    SyncErrorKind::SanityCheckFailed {
                        client: None,
                        server: None,
                    },
                    "",
                ),
                SyncFailure::ResyncRequired,
            ),
            (
                sync(SyncErrorKind::DatabaseCheckRequired, ""),
                SyncFailure::ResyncRequired,
            ),
            (
                sync(SyncErrorKind::ClientTooOld, ""),
                SyncFailure::ClientTooOld,
            ),
            (
                sync(SyncErrorKind::ServerError, ""),
                SyncFailure::ServerError,
            ),
            (sync(SyncErrorKind::Conflict, ""), SyncFailure::ServerError),
            (sync(SyncErrorKind::Other, "x"), SyncFailure::Other),
            (AnkiError::Interrupted, SyncFailure::Aborted),
            (AnkiError::CollectionNotOpen, SyncFailure::Other),
        ];
        for (err, expected) in cases {
            assert_eq!(classify(&err).0, expected, "{err:?}");
        }
        let (_, detail) = classify(&sync(SyncErrorKind::ServerMessage, "manutenção"));
        let message = SyncFailure::ServerMessage.message(detail.as_deref());
        assert_eq!(message, "manutenção");
    }

    /// The exact error of a connection dropped in the middle of a full download (CI run
    /// 40085887656, through the TLS proxy), as rslib 26.09.3 builds it.
    const CI_DROPPED_DOWNLOAD: &str = "HttpError { code: 303, context: \"reading stream\", \
        source: Some(Custom { kind: ConnectionAborted, error: \"stream failure (code=303)\" }) }";

    /// An `HttpError` the way rslib's `IoMonitor` builds it for a failed body stream, converted
    /// by rslib's own `From<HttpError> for AnkiError`.
    fn stream_error(source: std::io::Error) -> AnkiError {
        use anki::sync::error::HttpError;
        use reqwest::StatusCode;
        AnkiError::from(HttpError {
            code: StatusCode::SEE_OTHER,
            context: "reading stream".into(),
            source: Some(Box::new(source)),
        })
    }

    #[test]
    fn a_dropped_transfer_is_a_transient_network_failure() {
        use std::io::{Error as IoError, ErrorKind};

        // The CI shape, both as rslib converts it and as the text it keeps.
        let ci = stream_error(IoError::new(
            ErrorKind::ConnectionAborted,
            "stream failure (code=303)",
        ));
        let AnkiError::SyncError { source } = &ci else {
            panic!("rslib changed how it reports a stream failure: {ci:?}");
        };
        assert!(matches!(source.kind, SyncErrorKind::Other), "{ci:?}");
        assert_eq!(source.info, CI_DROPPED_DOWNLOAD);
        for err in [ci, sync(SyncErrorKind::Other, CI_DROPPED_DOWNLOAD)] {
            let (kind, detail) = classify(&err);
            assert_eq!(kind, SyncFailure::Offline, "{err:?}");
            assert_eq!(detail, None);
            assert!(kind.is_transient());
        }

        // Every io kind of a cut connection, custom and simple io errors alike.
        for kind in [
            ErrorKind::ConnectionAborted,
            ErrorKind::ConnectionReset,
            ErrorKind::BrokenPipe,
            ErrorKind::UnexpectedEof,
        ] {
            for source in [IoError::new(kind, "x"), IoError::from(kind)] {
                let err = stream_error(source);
                assert_eq!(classify(&err).0, SyncFailure::Offline, "{err:?}");
            }
        }
        for source in [
            IoError::new(ErrorKind::TimedOut, "x"),
            IoError::from(ErrorKind::TimedOut),
        ] {
            let err = stream_error(source);
            assert_eq!(classify(&err).0, SyncFailure::Timeout, "{err:?}");
            assert!(SyncFailure::Timeout.is_transient());
        }
        // An OS error (connection reset by peer) keeps its kind in the Debug text too.
        let err = stream_error(IoError::from_raw_os_error(104));
        if IoError::from_raw_os_error(104).kind() == ErrorKind::ConnectionReset {
            assert_eq!(classify(&err).0, SyncFailure::Offline, "{err:?}");
        }
        // Any "stream failure" of a sync request is the network too.
        let err = stream_error(IoError::other("stream failure (code=303)"));
        assert_eq!(classify(&err).0, SyncFailure::Offline, "{err:?}");

        // Not the network: other io kinds, other HttpErrors and plain "other" sync errors.
        for err in [
            stream_error(IoError::new(ErrorKind::InvalidData, "bad zstd")),
            stream_error(IoError::new(ErrorKind::PermissionDenied, "x")),
            sync(SyncErrorKind::Other, "missing original size"),
            sync(
                SyncErrorKind::Other,
                "HttpError { code: 400, context: \"decoding zstd body\", source: None }",
            ),
            sync(SyncErrorKind::ServerMessage, CI_DROPPED_DOWNLOAD),
        ] {
            assert_ne!(classify(&err).0, SyncFailure::Offline, "{err:?}");
        }
        // The pt-BR message of the app's network failure, not rslib's Debug text.
        let err = from_anki(&sync(SyncErrorKind::Other, CI_DROPPED_DOWNLOAD), &[]);
        assert_eq!(err.code(), "anki.sync.offline");
        assert_eq!(
            err.to_string(),
            "Sem conexão com o servidor de sincronização."
        );
    }

    #[test]
    fn codes_messages_and_transience() {
        assert_eq!(SyncFailure::TlsUntrusted.code(), "anki.sync.tlsUntrusted");
        assert_eq!(
            SyncFailure::AnkiWebRefused.code(),
            "anki.sync.ankiWebRefused"
        );
        assert_eq!(
            serde_json::to_value(SyncFailure::TlsUntrusted).expect("json"),
            "tlsUntrusted"
        );
        let transient: Vec<_> = ALL.iter().filter(|k| k.is_transient()).collect();
        assert_eq!(
            transient,
            [
                &SyncFailure::Offline,
                &SyncFailure::Timeout,
                &SyncFailure::ServerError
            ]
        );
        for kind in ALL {
            // The code is `anki.sync.` + the camelCase serde name.
            let name = serde_json::to_value(kind).expect("json");
            assert_eq!(
                kind.code(),
                format!("anki.sync.{}", name.as_str().expect("str"))
            );
            assert!(!kind.message(None).is_empty());
        }
        assert_eq!(
            SyncFailure::Other.message(Some("x")),
            "Falha na sincronização: x"
        );
        let err = sync_error(SyncFailure::Offline, None);
        assert_eq!(err.code(), "anki.sync.offline");
        assert_eq!(
            err.to_string(),
            "Sem conexão com o servidor de sincronização."
        );
        let json = serde_json::to_value(&err).expect("json");
        assert_eq!(json["code"], "anki.sync.offline");
    }

    #[test]
    fn secrets_are_removed_from_messages() {
        let err = from_anki(
            &sync(
                SyncErrorKind::ServerMessage,
                "senha s3gr3d0 e chave abc123 erradas",
            ),
            &["s3gr3d0", "abc123", ""],
        );
        let text = err.to_string();
        assert!(
            !text.contains("s3gr3d0") && !text.contains("abc123"),
            "{text}"
        );
    }

    const ALL: [SyncFailure; 16] = [
        SyncFailure::Offline,
        SyncFailure::Timeout,
        SyncFailure::TlsUntrusted,
        SyncFailure::AuthFailed,
        SyncFailure::InvalidUrl,
        SyncFailure::AnkiWebRefused,
        SyncFailure::InvalidCertificate,
        SyncFailure::ClockIncorrect,
        SyncFailure::ServerError,
        SyncFailure::ServerMessage,
        SyncFailure::UploadTooLarge,
        SyncFailure::ResyncRequired,
        SyncFailure::ClientTooOld,
        SyncFailure::Busy,
        SyncFailure::Aborted,
        SyncFailure::Other,
    ];
}
