//! A custom root certificate (PEM) for a self-hosted server with a private CA.

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::failure::{SyncFailure, sync_error};
use crate::error::Result;

/// Largest accepted PEM text.
pub const MAX_CERT_PEM_BYTES: usize = 64 * 1024;

const BEGIN_CERT: &str = "-----BEGIN CERTIFICATE-----";
const END_CERT: &str = "-----END CERTIFICATE-----";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateInfo {
    /// SHA-256 of the DER, uppercase hex pairs joined by `:`.
    pub fingerprint_sha256: String,
}

/// Accepts exactly one PEM `CERTIFICATE` block (and no other PEM block) that rustls can load as
/// a root; at most [`MAX_CERT_PEM_BYTES`].
pub fn validate_certificate(pem: &str) -> Result<CertificateInfo> {
    let der =
        parse_single_cert(pem).ok_or_else(|| sync_error(SyncFailure::InvalidCertificate, None))?;
    // reqwest only parses the certificate when a client is built with it.
    let cert = reqwest::Certificate::from_pem(pem.as_bytes())
        .map_err(|_| sync_error(SyncFailure::InvalidCertificate, None))?;
    reqwest::Client::builder()
        .use_rustls_tls()
        .tls_built_in_root_certs(false)
        .add_root_certificate(cert)
        .build()
        .map_err(|_| sync_error(SyncFailure::InvalidCertificate, None))?;
    Ok(CertificateInfo {
        fingerprint_sha256: fingerprint(&der),
    })
}

/// The DER bytes of the only certificate in `pem`, if it has exactly one PEM block and that
/// block is a well-formed certificate.
fn parse_single_cert(pem: &str) -> Option<Vec<u8>> {
    if pem.len() > MAX_CERT_PEM_BYTES || pem.matches("-----BEGIN ").count() != 1 {
        return None;
    }
    let start = pem.find(BEGIN_CERT)? + BEGIN_CERT.len();
    let len = pem[start..].find(END_CERT)?;
    let body: String = pem[start..start + len]
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body)
        .ok()?;
    // An X.509 certificate is a DER SEQUENCE.
    (der.len() > 16 && der[0] == 0x30).then_some(der)
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    /// Throwaway self-signed certificates (no private key kept), only parsed here.
    const CERT_1: &str = include_str!("../../tests/fixtures/sync/test-cert-1.pem");
    const CERT_2: &str = include_str!("../../tests/fixtures/sync/test-cert-2.pem");

    fn is_invalid(pem: &str) -> bool {
        matches!(
            validate_certificate(pem),
            Err(Error::Sync {
                kind: SyncFailure::InvalidCertificate,
                ..
            })
        )
    }

    #[test]
    fn rejects_zero_two_garbage_and_huge() {
        assert!(is_invalid(""));
        assert!(is_invalid("hello"));
        assert!(is_invalid(
            "-----BEGIN CERTIFICATE-----\nnot base64!\n-----END CERTIFICATE-----\n"
        ));
        assert!(is_invalid(
            "-----BEGIN CERTIFICATE-----\naGVsbG8gd29ybGQ=\n-----END CERTIFICATE-----\n"
        ));
        assert!(is_invalid(
            "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
        ));
        assert!(is_invalid(&format!("{CERT_1}{CERT_2}")), "two certificates");
        assert!(is_invalid(&format!(
            "{CERT_1}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
        )));
        let huge = format!("{CERT_1}{}", " ".repeat(MAX_CERT_PEM_BYTES));
        assert!(is_invalid(&huge));
    }

    #[test]
    fn accepts_one_certificate() {
        let info = validate_certificate(CERT_1).expect("valid certificate");
        assert_eq!(
            info.fingerprint_sha256,
            "C9:4C:3A:9D:A4:E1:D3:06:8C:E9:18:4F:BE:20:5C:FF:37:AF:7A:A6:E9:94:16:E2:21:52:8C:19:D2:D3:4F:06"
        );
        let json = serde_json::to_value(&info).expect("json");
        assert!(json["fingerprintSha256"].is_string());
        // Windows line endings and surrounding blank lines are fine.
        let crlf = format!("\n\n{}\n", CERT_2.replace('\n', "\r\n"));
        assert!(validate_certificate(&crlf).is_ok());
    }

    #[test]
    fn fingerprint_format() {
        let fp = fingerprint(b"abc");
        assert_eq!(
            fp,
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
    }
}
