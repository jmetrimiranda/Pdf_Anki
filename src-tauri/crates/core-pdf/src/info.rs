//! The document Info dictionary: reading and stamping custom keys such as `LeitorBookUid`
//! (spec 6.5), through `pdfcraft-cos` (lazy parse, no page walk) and `pdfcraft-organize`.

use std::sync::Arc;

use pdfcraft_cos::{Document, SaveOptions};

use crate::PdfError;
use crate::error::guard;

/// The Info key that carries the `book_uid` of the original file in every saved version.
pub const LEITOR_BOOK_UID_KEY: &str = "LeitorBookUid";

/// `value` if it is a well-formed `book_uid` (64 lowercase hex digits).
pub(crate) fn valid_book_uid(value: &str) -> Option<String> {
    let v = value.trim();
    (v.len() == 64 && v.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .then(|| v.to_owned())
}

/// The text of the Info entry `key`, or `None` when the file has no such entry. Encrypted files
/// open with the empty user password only; anything else is `NeedsPassword`.
pub fn read_info(bytes: Arc<Vec<u8>>, key: &str) -> Result<Option<String>, PdfError> {
    guard(|| {
        let doc = Document::open(bytes).map_err(PdfError::from_cos)?;
        Ok(pdfcraft_organize::info(&doc, key)
            .map(|v| {
                v.trim_matches(|c: char| c == '\0' || c.is_whitespace())
                    .to_owned()
            })
            .filter(|v| !v.is_empty()))
    })
}

/// `bytes` with the Info entry `key` set to `value`, appended as an incremental update (the
/// original bytes stay untouched). Returns the input unchanged when the entry already holds
/// `value`, so stamping is idempotent.
pub fn stamp_info(bytes: &[u8], key: &str, value: &str) -> Result<Vec<u8>, PdfError> {
    guard(|| {
        let mut doc = Document::open(Arc::new(bytes.to_vec())).map_err(PdfError::from_cos)?;
        if pdfcraft_organize::info(&doc, key).as_deref().map(str::trim) == Some(value.trim()) {
            return Ok(bytes.to_vec());
        }
        pdfcraft_organize::set_info(&mut doc, key, value)
            .map_err(|e| PdfError::InvalidRequest(format!("metadado {key:?} inválido ({e}).")))?;
        pdfcraft_cos::write_incremental(&doc, &SaveOptions::default())
            .map_err(|e| PdfError::Internal(format!("write_incremental: {e}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_uid_shape() {
        let uid = "a".repeat(64);
        assert_eq!(valid_book_uid(&uid), Some(uid.clone()));
        assert_eq!(valid_book_uid(&format!(" {uid}\n")), Some(uid));
        assert_eq!(valid_book_uid(&"A".repeat(64)), None);
        assert_eq!(valid_book_uid(&"g".repeat(64)), None);
        assert_eq!(valid_book_uid(&"a".repeat(63)), None);
        assert_eq!(valid_book_uid(""), None);
    }
}
