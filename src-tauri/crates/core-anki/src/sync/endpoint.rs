//! The sync server address typed by the user, normalized for rslib.

use std::fmt;

use url::Url;

use super::failure::{SyncFailure, sync_error};
use crate::error::Result;

/// Absolute `http(s)` URL of a self-hosted sync server, always ending with `/` (rslib joins
/// `sync/…` and `msync/…` onto it). AnkiWeb is refused: this app only syncs with the user's own
/// server (docs/PROJETO.md 9).
#[derive(Clone, PartialEq, Eq)]
pub struct SyncEndpoint(Url);

impl SyncEndpoint {
    /// Trims, accepts only `http`/`https` with a host and without userinfo, query or fragment,
    /// appends `/` to the path if missing (`https://h/anki` → `https://h/anki/`) and refuses
    /// `ankiweb.net` and its subdomains.
    pub fn parse(input: &str) -> Result<Self> {
        let invalid = || sync_error(SyncFailure::InvalidUrl, None);
        let input = input.trim();
        if input.is_empty() || input.len() > 2048 {
            return Err(invalid());
        }
        let mut url = Url::parse(input).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.cannot_be_a_base()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        match url.host_str() {
            None | Some("") => return Err(invalid()),
            Some(host) if is_ankiweb(host) => {
                return Err(sync_error(SyncFailure::AnkiWebRefused, None));
            }
            Some(_) => {}
        }
        if !url.path().ends_with('/') {
            let path = format!("{}/", url.path());
            url.set_path(&path);
        }
        Ok(Self(url))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn is_https(&self) -> bool {
        self.0.scheme() == "https"
    }

    /// Host name or IP literal (IPv6 in brackets), lowercase.
    pub fn host(&self) -> &str {
        self.0.host_str().unwrap_or_default()
    }

    /// A redirect target sent by the server (`new_endpoint`), accepted only when it keeps the
    /// scheme and host of `self` (and is not AnkiWeb).
    pub(crate) fn accept_redirect(&self, target: &str) -> Result<Self> {
        let next = Self::parse(target)?;
        if next.0.scheme() == self.0.scheme() && next.host() == self.host() {
            Ok(next)
        } else {
            Err(sync_error(
                SyncFailure::Other,
                Some("o servidor pediu para usar outro endereço, o que foi recusado.".into()),
            ))
        }
    }
}

/// `ankiweb.net` or any subdomain (case-insensitive, trailing dot ignored). The only place in the
/// crate that names AnkiWeb (a test greps for it).
fn is_ankiweb(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "ankiweb.net" || host.ends_with(".ankiweb.net")
}

impl fmt::Display for SyncEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Debug for SyncEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SyncEndpoint({})", self.as_str())
    }
}

impl serde::Serialize for SyncEndpoint {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn kind(input: &str) -> Option<SyncFailure> {
        match SyncEndpoint::parse(input) {
            Ok(_) => None,
            Err(Error::Sync { kind, .. }) => Some(kind),
            Err(other) => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn normalizes_valid_urls() {
        for (input, expected) in [
            ("https://anki.example.com", "https://anki.example.com/"),
            ("https://anki.example.com/", "https://anki.example.com/"),
            ("  https://anki.example.com/  ", "https://anki.example.com/"),
            ("https://h/anki", "https://h/anki/"),
            ("https://h/anki/", "https://h/anki/"),
            ("http://ankisync-dev:8080", "http://ankisync-dev:8080/"),
            (
                "HTTPS://Anki.Example.COM:8443/x/y",
                "https://anki.example.com:8443/x/y/",
            ),
            ("http://127.0.0.1:8080/", "http://127.0.0.1:8080/"),
            ("http://[::1]:8080", "http://[::1]:8080/"),
        ] {
            let ep = SyncEndpoint::parse(input).unwrap_or_else(|e| panic!("{input}: {e}"));
            assert_eq!(ep.as_str(), expected, "{input}");
        }
        let ep = SyncEndpoint::parse("https://Anki.Example.com:8443/a").expect("valid");
        assert!(ep.is_https());
        assert_eq!(ep.host(), "anki.example.com");
        assert!(!SyncEndpoint::parse("http://h").expect("valid").is_https());
    }

    #[test]
    fn refuses_invalid_urls() {
        for input in [
            "",
            "   ",
            "anki.example.com",
            "localhost:8080",
            "ftp://h/",
            "file:///tmp/x",
            "mailto:a@b.c",
            "https://",
            "https://user:pw@h/",
            "https://user@h/",
            "https://h/?a=1",
            "https://h/?",
            "https://h/#x",
            "not a url",
            "https://h h/",
        ] {
            assert_eq!(kind(input), Some(SyncFailure::InvalidUrl), "{input:?}");
        }
    }

    #[test]
    fn refuses_ankiweb() {
        for input in [
            "https://ankiweb.net/",
            "https://sync.ankiweb.net/",
            "https://SYNC.ANKIWEB.NET",
            "http://ANKIWEB.NET/",
            "https://sync2.ankiweb.net./",
            "https://a.b.ankiweb.net:443/sync/",
        ] {
            assert_eq!(kind(input), Some(SyncFailure::AnkiWebRefused), "{input}");
        }
        // Lookalikes are ordinary hosts.
        assert_eq!(kind("https://notankiweb.net/"), None);
        assert_eq!(kind("https://ankiweb.net.example.com/"), None);
    }

    #[test]
    fn redirects_must_keep_scheme_and_host() {
        let ep = SyncEndpoint::parse("https://h:8443/").expect("valid");
        assert_eq!(
            ep.accept_redirect("https://h/other")
                .expect("same host")
                .as_str(),
            "https://h/other/"
        );
        for bad in [
            "http://h:8443/",
            "https://other/",
            "https://sync.ankiweb.net/",
            "x",
        ] {
            assert!(ep.accept_redirect(bad).is_err(), "{bad}");
        }
    }
}
