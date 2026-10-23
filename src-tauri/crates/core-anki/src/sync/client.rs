//! The HTTP client and the rslib `SyncAuth` of a sync operation.
//!
//! - One fresh `reqwest::Client` per operation (pooled connections are tied to the tokio runtime
//!   that opened them; the actor uses its own runtime).
//! - rustls only, HTTP/1 (like upstream), optional extra root certificate (system roots stay on).
//! - No automatic redirects, and a resolver that only resolves the configured host: whatever rslib
//!   does with a server-provided `new_endpoint`, this client can only reach the user's server.
//! - [`make_auth`] is the only way the crate builds a `SyncAuth`, and its endpoint is never `None`
//!   (`None` means AnkiWeb in rslib).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anki::sync::login::SyncAuth;
use reqwest::Client;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use super::failure::{SyncFailure, classify_reqwest, sync_error};
use super::{SyncConfig, SyncEndpoint};
use crate::error::Result;

pub(crate) fn build_client(cfg: &SyncConfig) -> Result<Client> {
    let mut builder = Client::builder()
        .use_rustls_tls()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(u64::from(
            cfg.io_timeout_secs.clamp(1, 600),
        )))
        .dns_resolver(Arc::new(OnlyHost(cfg.endpoint.host().to_owned())));
    if let Some(pem) = cfg.ca_cert_pem.as_deref().filter(|p| !p.trim().is_empty()) {
        super::validate_certificate(pem)?;
        let cert = reqwest::Certificate::from_pem(pem.as_bytes())
            .map_err(|_| sync_error(SyncFailure::InvalidCertificate, None))?;
        builder = builder.add_root_certificate(cert);
    }
    builder
        .build()
        .map_err(|e| sync_error(SyncFailure::Other, Some(format!("cliente HTTP: {e}"))))
}

/// The single constructor of rslib's `SyncAuth` in this crate.
pub(crate) fn make_auth(
    endpoint: &SyncEndpoint,
    hkey: &str,
    io_timeout_secs: u32,
) -> Result<SyncAuth> {
    let auth = SyncAuth::try_from(anki_proto::sync::SyncAuth {
        hkey: hkey.to_owned(),
        endpoint: Some(endpoint.as_str().to_owned()),
        io_timeout_secs: Some(io_timeout_secs),
    })
    .map_err(|_| sync_error(SyncFailure::InvalidUrl, None))?;
    if auth.endpoint.is_none() {
        // Unreachable with Some(..) above; never fall back to AnkiWeb.
        return Err(sync_error(SyncFailure::InvalidUrl, None));
    }
    Ok(auth)
}

/// After a failure rslib could only describe as "error sending request", asks the server root
/// directly to tell an offline server or an untrusted certificate apart.
pub(crate) async fn diagnose(cfg: &SyncConfig) -> Option<SyncFailure> {
    let client = build_client(cfg).ok()?;
    let timeout = Duration::from_secs(u64::from(cfg.io_timeout_secs.clamp(1, 600)));
    match client
        .get(cfg.endpoint.as_str())
        .timeout(timeout)
        .send()
        .await
    {
        Ok(_) => None,
        Err(e) => classify_reqwest(&e),
    }
}

/// DNS resolver that only answers for the configured host.
struct OnlyHost(String);

impl Resolve for OnlyHost {
    fn resolve(&self, name: Name) -> Resolving {
        let allowed = name.as_str().eq_ignore_ascii_case(&self.0);
        let host = name.as_str().to_owned();
        Box::pin(async move {
            if !allowed {
                return Err(format!("host {host} is not the configured sync server").into());
            }
            let addrs: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let addrs: Addrs = Box::new(addrs.into_iter());
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_always_has_the_endpoint() {
        let ep = SyncEndpoint::parse("http://ankisync-dev:8080/sub").expect("valid");
        let auth = make_auth(&ep, "k", 30).expect("auth");
        assert_eq!(
            auth.endpoint.as_ref().map(|u| u.as_str()),
            Some("http://ankisync-dev:8080/sub/")
        );
        assert_eq!(auth.io_timeout_secs, Some(30));
    }

    /// `SyncAuth` must only be built by [`make_auth`]: any other construction could leave the
    /// endpoint `None`, which rslib turns into AnkiWeb.
    #[test]
    fn sync_auth_is_only_built_by_make_auth() {
        let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut offenders = Vec::new();
        let mut ankiweb = Vec::new();
        visit(std::path::Path::new(src), &mut |path, text| {
            let name = path.to_string_lossy().into_owned();
            let is_client = name.ends_with("sync/client.rs");
            for needle in [
                "SyncAuth {",
                "SyncAuth::default",
                "SyncAuth::try_from",
                "sync_login(",
            ] {
                let count = text.matches(needle).count();
                let allowed = match (needle, is_client) {
                    ("SyncAuth::try_from" | "SyncAuth {", true) => 1,
                    ("sync_login(", false) if name.ends_with("sync/mod.rs") => 1,
                    _ => 0,
                };
                if count > allowed {
                    offenders.push(format!("{name}: {needle}"));
                }
            }
            if text.contains("ankiweb.net") && !name.ends_with("sync/endpoint.rs") {
                ankiweb.push(name);
            }
        });
        assert!(offenders.is_empty(), "{offenders:?}");
        assert!(
            ankiweb.is_empty(),
            "AnkiWeb URL outside the refusal check: {ankiweb:?}"
        );
    }

    fn visit(dir: &std::path::Path, f: &mut dyn FnMut(&std::path::Path, &str)) {
        for entry in std::fs::read_dir(dir).expect("src dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit(&path, f);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).expect("read source");
                // Unit tests (this one included) may name things freely.
                let text = text.split("#[cfg(test)]").next().unwrap_or_default();
                f(&path, text);
            }
        }
    }
}
