//! Anki sync with the user's own server (docs/PROJETO.md 9): login, normal sync, full sync
//! (always with a backup first) and media sync, through rslib's client.
//!
//! Rules enforced here:
//! - Only a self-hosted server: [`SyncEndpoint`] refuses AnkiWeb, rslib's `SyncAuth` is always
//!   built with an endpoint (never the AnkiWeb default) and the HTTP client can only resolve the
//!   configured host.
//! - The first sync of the app always downloads ([`decide`]); nothing ever uploads unless the user
//!   asks through [`AnkiService::sync_full`]. Every full sync writes a `PreSync` backup first.
//! - The network check runs off the actor: an offline server never blocks studying. Only an actual
//!   normal/full sync holds the collection.
//! - Passwords are never stored or logged; the caller keeps the hkey in the system keychain.
//!
//! [`AnkiService::sync_full`]: crate::AnkiService::sync_full

mod cert;
mod client;
mod decide;
mod endpoint;
mod failure;
mod flow;

use std::fmt;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

pub use cert::{CertificateInfo, MAX_CERT_PEM_BYTES, validate_certificate};
pub use decide::{Action, decide};
pub use endpoint::SyncEndpoint;
pub use failure::SyncFailure;

use crate::error::{Error, Result};
use crate::types::BackupInfo;
use failure::sync_error;

/// Default network inactivity timeout, in seconds.
pub const DEFAULT_IO_TIMEOUT_SECS: u32 = 30;

/// Where and how to reach the sync server.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub endpoint: SyncEndpoint,
    /// Extra trusted root certificate (PEM) for a server with a private CA. The system roots
    /// stay trusted.
    pub ca_cert_pem: Option<String>,
    pub io_timeout_secs: u32,
}

impl SyncConfig {
    pub fn new(endpoint: SyncEndpoint) -> Self {
        Self {
            endpoint,
            ca_cert_pem: None,
            io_timeout_secs: DEFAULT_IO_TIMEOUT_SECS,
        }
    }
}

/// A logged-in account: the server config and the hkey returned by [`login`].
#[derive(Clone)]
pub struct SyncCredentials {
    pub config: SyncConfig,
    pub hkey: String,
}

impl fmt::Debug for SyncCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SyncCredentials")
            .field("config", &self.config)
            .field("hkey", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FullSyncDirection {
    Download,
    Upload,
}

/// Which directions the full-sync dialog may offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSyncChoice {
    pub upload_ok: bool,
    pub download_ok: bool,
}

#[derive(Debug, Clone)]
pub enum SyncOutcome {
    NoChanges,
    Normal,
    FullDownloaded {
        backup: BackupInfo,
    },
    FullUploaded {
        backup: BackupInfo,
    },
    /// Nothing was changed; the user must choose a direction ([`FullSyncChoice`]).
    FullSyncRequired(FullSyncChoice),
}

#[derive(Debug, Clone)]
pub struct SyncReport {
    pub outcome: SyncOutcome,
    /// Text the server asked to show, if any.
    pub server_message: Option<String>,
    /// Address the server moved to (same scheme and host only); the caller should persist it.
    pub new_endpoint: Option<SyncEndpoint>,
    /// Media sync failure (the collection sync itself succeeded), with its pt-BR message.
    pub media_error: Option<(SyncFailure, String)>,
    /// The local collection changed (the UI must refresh).
    pub collection_changed: bool,
}

/// Logs in and returns the hkey. The password is only sent to the server: it is never stored,
/// logged nor included in errors.
pub async fn login(cfg: &SyncConfig, user: &str, password: &str) -> Result<String> {
    let user = user.trim();
    if user.is_empty() || password.is_empty() {
        return Err(Error::InvalidInput(
            "informe o usuário e a senha do servidor de sincronização.".into(),
        ));
    }
    let http = client::build_client(cfg)?;
    // Validates the endpoint the same way as every other request.
    client::make_auth(&cfg.endpoint, "", cfg.io_timeout_secs)?;
    match anki::sync::login::sync_login(
        user,
        password,
        Some(cfg.endpoint.as_str().to_owned()),
        http,
    )
    .await
    {
        Ok(auth) if !auth.hkey.is_empty() => Ok(auth.hkey),
        Ok(_) => Err(sync_error(SyncFailure::AuthFailed, None)),
        Err(err) => Err(flow::refine(cfg, failure::from_anki(&err, &[password, user])).await),
    }
}

/// Sync state shared by the handles of one [`crate::AnkiService`].
#[derive(Default)]
pub(crate) struct SyncControl {
    running: AtomicBool,
    /// A normal/full sync is running on the actor (rslib's `want_abort` reaches it).
    on_actor: AtomicBool,
    /// Bumped by `abort_sync`; pending network steps stop when it changes.
    cancel: tokio::sync::watch::Sender<u64>,
    media: Mutex<Option<flow::MediaTask>>,
}

/// Marks a sync as running until dropped.
pub(crate) struct RunningGuard<'a>(&'a AtomicBool);

impl SyncControl {
    pub(crate) fn try_start(&self) -> Result<RunningGuard<'_>> {
        self.running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| RunningGuard(&self.running))
            .map_err(|_| sync_error(SyncFailure::Busy, None))
    }

    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub(crate) fn on_actor(&self) -> RunningGuard<'_> {
        self.on_actor.store(true, Ordering::Release);
        RunningGuard(&self.on_actor)
    }

    pub(crate) fn is_on_actor(&self) -> bool {
        self.on_actor.load(Ordering::Acquire)
    }
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_debug_redacts_the_hkey() {
        let creds = SyncCredentials {
            config: SyncConfig::new(SyncEndpoint::parse("http://localhost:8080").expect("url")),
            hkey: "segredo-hkey-123".into(),
        };
        let text = format!("{creds:?}");
        assert!(!text.contains("segredo-hkey-123"), "{text}");
        assert!(text.contains("<redacted>") && text.contains("localhost:8080"));
    }

    #[test]
    fn serde_names() {
        assert_eq!(
            serde_json::to_value(FullSyncDirection::Download).expect("json"),
            "download"
        );
        let dir: FullSyncDirection = serde_json::from_value("upload".into()).expect("parse");
        assert_eq!(dir, FullSyncDirection::Upload);
        let choice = FullSyncChoice {
            upload_ok: true,
            download_ok: false,
        };
        assert_eq!(
            serde_json::to_value(choice).expect("json"),
            serde_json::json!({ "uploadOk": true, "downloadOk": false })
        );
    }

    #[test]
    fn busy_guard() {
        let control = SyncControl::default();
        let guard = control.try_start().expect("first");
        assert!(control.is_running());
        assert!(matches!(
            control.try_start(),
            Err(Error::Sync {
                kind: SyncFailure::Busy,
                ..
            })
        ));
        drop(guard);
        assert!(!control.is_running());
        assert!(control.try_start().is_ok());
    }
}
