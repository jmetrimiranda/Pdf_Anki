//! The zip container with the safety limits of docs/tecnico/epub.md: declared sizes are never
//! trusted (every read goes through `Read::take(limit + 1)`), entry count and compression ratio
//! are capped, encrypted entries mean DRM.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::Arc;

use zip::ZipArchive;

use crate::EpubError;

/// Maximum number of zip entries.
pub const MAX_ENTRIES: usize = 20_000;
/// container.xml, OPF, nav, NCX, encryption.xml.
pub const MAX_PACKAGE_FILE: u64 = 4 << 20;
/// One content document.
pub const MAX_SECTION: u64 = 16 << 20;
/// The cover image.
pub const MAX_COVER: u64 = 10 << 20;
/// Total decompressed bytes during one `texts()` run.
pub const MAX_TOTAL_TEXT: u64 = 512 << 20;
/// Entries bigger than this are checked for a zip-bomb compression ratio.
const RATIO_MIN_SIZE: u64 = 1 << 20;
const MAX_RATIO: u64 = 1000;

/// `Arc<Vec<u8>>` as a `Cursor` source (cheap to clone with the archive).
#[derive(Clone)]
pub(crate) struct Bytes(pub Arc<Vec<u8>>);

impl AsRef<[u8]> for Bytes {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}

#[derive(Clone)]
pub(crate) struct Archive {
    zip: ZipArchive<Cursor<Bytes>>,
    /// Lower-cased name → index, for case-insensitive fallback lookups.
    lower: HashMap<String, usize>,
}

impl Archive {
    pub fn open(bytes: Arc<Vec<u8>>) -> Result<Self, EpubError> {
        if !bytes.starts_with(b"PK") {
            return Err(EpubError::NotEpub);
        }
        let mut zip = ZipArchive::new(Cursor::new(Bytes(bytes))).map_err(|e| {
            tracing::debug!(error = %e, "not a zip");
            EpubError::NotEpub
        })?;
        if zip.len() > MAX_ENTRIES {
            return Err(EpubError::TooLarge);
        }
        let mut lower = HashMap::with_capacity(zip.len());
        for i in 0..zip.len() {
            if let Some(name) = zip.name_for_index(i) {
                lower.entry(name.to_lowercase()).or_insert(i);
            }
            // Metadata from the central directory (the local header is only located, not trusted).
            let Ok(file) = zip.by_index_raw(i) else {
                continue;
            };
            if file.encrypted() {
                return Err(EpubError::Drm);
            }
            let (size, packed) = (file.size(), file.compressed_size());
            if size > RATIO_MIN_SIZE && size / packed.max(1) > MAX_RATIO {
                tracing::warn!(entry = file.name(), size, packed, "zip bomb ratio");
                return Err(EpubError::TooLarge);
            }
        }
        Ok(Self { zip, lower })
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.zip.file_names()
    }

    fn index(&self, path: &str) -> Option<usize> {
        self.zip
            .index_for_name(path)
            .or_else(|| self.lower.get(&path.to_lowercase()).copied())
    }

    pub fn contains(&self, path: &str) -> bool {
        self.index(path).is_some()
    }

    /// Reads a whole entry, at most `limit` bytes (`TooLarge` above it). A missing entry or a
    /// broken stream is `Damaged`.
    pub fn read(&self, path: &str, limit: u64) -> Result<Vec<u8>, EpubError> {
        let buf = self.read_upto(path, limit + 1)?;
        if buf.len() as u64 > limit {
            return Err(EpubError::TooLarge);
        }
        Ok(buf)
    }

    /// Reads at most the first `n` bytes of an entry (no error when it is longer).
    pub fn read_prefix(&self, path: &str, n: u64) -> Result<Vec<u8>, EpubError> {
        self.read_upto(path, n)
    }

    fn read_upto(&self, path: &str, n: u64) -> Result<Vec<u8>, EpubError> {
        let idx = self
            .index(path)
            .ok_or_else(|| EpubError::damaged(format!("missing entry {path}")))?;
        let mut zip = self.zip.clone();
        let file = zip.by_index(idx).map_err(|e| match e {
            zip::result::ZipError::UnsupportedArchive(m)
                if m == zip::result::ZipError::PASSWORD_REQUIRED =>
            {
                EpubError::Drm
            }
            e => EpubError::damaged(format!("{path}: {e}")),
        })?;
        let hint = file.size().min(n).min(1 << 20) as usize;
        let mut buf = Vec::with_capacity(hint);
        file.take(n)
            .read_to_end(&mut buf)
            .map_err(|e| EpubError::damaged(format!("{path}: {e}")))?;
        Ok(buf)
    }
}
