//! The book files in the app folder (spec 6.5/6.6):
//!
//! - `books/{book_uid}/v{n}-{file_hash[..8]}.pdf`: one file per saved version. The current and the
//!   previous version are kept; older ones are pruned after a new version is recorded.
//! - `books/{book_uid}/replaced-v{n}-{file_hash[..8]}.pdf`: a version that an imported copy
//!   replaced (spec 6.6). Never pruned; deleted only with the book.
//! - `books/{book_uid}/v{n}-{file_hash[..8]}.epub`: the file of an EPUB book (it never changes: its annotations live
//!   in the app database, spec 7.1).
//! - `covers/{book_uid}-v{n}.png`: the cover cache (created on import or on the first request). For EPUB books it
//!   holds the book's own cover image as is (PNG, JPEG, GIF or WebP; the `pdf` protocol sniffs the type).
//!
//! The database stores paths relative to the data dir (`book_file.local_path`), so a moved data
//! dir keeps working. Writes are atomic: temp file in the same directory, fsync, rename, fsync of
//! the directory where the platform supports it.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::AppError;

pub const BOOKS_DIR: &str = "books";
pub const COVERS_DIR: &str = "covers";
/// File name prefix of the versions an imported copy replaced (never pruned).
pub const REPLACED_PREFIX: &str = "replaced-";

#[derive(Clone, Debug)]
pub struct BookFiles {
    data_dir: PathBuf,
}

impl BookFiles {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn book_dir(&self, uid: &str) -> PathBuf {
        self.data_dir.join(BOOKS_DIR).join(uid)
    }

    /// `books/{uid}/v{n}-{hash8}.pdf`, relative to the data dir, with `/` separators.
    pub fn version_rel_path(uid: &str, version: u32, file_hash: &str) -> String {
        let short = file_hash.get(..8).unwrap_or(file_hash);
        format!("{BOOKS_DIR}/{uid}/v{version}-{short}.pdf")
    }

    /// Resolves a stored `local_path`. Relative paths live under the data dir; anything that would
    /// escape it (`..`) is refused. Absolute paths (older rows) are taken as they are.
    pub fn resolve(&self, stored: &str) -> Option<PathBuf> {
        let path = Path::new(stored);
        if path.is_absolute() {
            return Some(path.to_path_buf());
        }
        if path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return None;
        }
        Some(self.data_dir.join(path))
    }

    pub fn cover_path(&self, uid: &str, version: u32) -> PathBuf {
        self.data_dir
            .join(COVERS_DIR)
            .join(format!("{uid}-v{version}.png"))
    }

    /// Writes a version file atomically and returns its relative path.
    pub fn write_version(
        &self,
        uid: &str,
        version: u32,
        file_hash: &str,
        bytes: &[u8],
    ) -> Result<String, AppError> {
        let rel = Self::version_rel_path(uid, version, file_hash);
        let path = self.data_dir.join(&rel);
        write_atomic(&path, bytes).map_err(|e| write_error(&path, &e))?;
        Ok(rel)
    }

    /// `books/{uid}/v{n}-{hash8}.epub`, relative to the data dir.
    pub fn epub_rel_path(uid: &str, version: u32, file_hash: &str) -> String {
        let short = file_hash.get(..8).unwrap_or(file_hash);
        format!("{BOOKS_DIR}/{uid}/v{version}-{short}.epub")
    }

    /// Writes the file of an EPUB book atomically and returns its relative path.
    pub fn write_epub(
        &self,
        uid: &str,
        version: u32,
        file_hash: &str,
        bytes: &[u8],
    ) -> Result<String, AppError> {
        let rel = Self::epub_rel_path(uid, version, file_hash);
        let path = self.data_dir.join(&rel);
        write_atomic(&path, bytes).map_err(|e| write_error(&path, &e))?;
        Ok(rel)
    }

    /// Keeps a copy of a version that an imported file replaced. Returns its relative path.
    pub fn write_replaced(
        &self,
        uid: &str,
        version: u32,
        file_hash: &str,
        bytes: &[u8],
    ) -> Result<String, AppError> {
        let short = file_hash.get(..8).unwrap_or(file_hash);
        let rel = format!("{BOOKS_DIR}/{uid}/{REPLACED_PREFIX}v{version}-{short}.pdf");
        let path = self.data_dir.join(&rel);
        write_atomic(&path, bytes).map_err(|e| write_error(&path, &e))?;
        Ok(rel)
    }

    /// Writes a cover PNG atomically (best effort is the caller's call).
    pub fn write_cover(&self, uid: &str, version: u32, png: &[u8]) -> io::Result<PathBuf> {
        let path = self.cover_path(uid, version);
        write_atomic(&path, png)?;
        Ok(path)
    }

    /// Deletes every version file of `uid` except the ones named in `keep` (relative paths) and the
    /// `replaced-` copies, and covers of versions older than `keep_cover_from`. Errors are logged, never returned: a
    /// leftover file only costs disk space.
    pub fn prune(&self, uid: &str, keep: &[&str], keep_cover_from: u32) {
        let keep: Vec<PathBuf> = keep.iter().filter_map(|k| self.resolve(k)).collect();
        if let Ok(entries) = fs::read_dir(self.book_dir(uid)) {
            for entry in entries.flatten() {
                let path = entry.path();
                let replaced = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(REPLACED_PREFIX));
                if replaced || keep.iter().any(|k| k == &path) {
                    continue;
                }
                remove_logged(&path);
            }
        }
        self.remove_covers(uid, |version| version < keep_cover_from);
    }

    /// Deletes all the files of a book (library removal).
    pub fn remove_book(&self, uid: &str) {
        let dir = self.book_dir(uid);
        if dir.exists()
            && let Err(e) = fs::remove_dir_all(&dir)
        {
            tracing::warn!(path = %dir.display(), %e, "could not delete the book files");
        }
        self.remove_covers(uid, |_| true);
    }

    fn remove_covers(&self, uid: &str, mut pred: impl FnMut(u32) -> bool) {
        let Ok(entries) = fs::read_dir(self.data_dir.join(COVERS_DIR)) else {
            return;
        };
        let prefix = format!("{uid}-v");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(version) = name
                .to_str()
                .and_then(|n| n.strip_prefix(&prefix))
                .and_then(|n| n.strip_suffix(".png"))
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            if pred(version) {
                remove_logged(&entry.path());
            }
        }
    }
}

fn remove_logged(path: &Path) {
    if let Err(e) = fs::remove_file(path)
        && e.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), %e, "could not delete an old file");
    }
}

pub fn write_error(path: &Path, e: &io::Error) -> AppError {
    tracing::warn!(path = %path.display(), %e, "could not write file");
    let message = match e.kind() {
        io::ErrorKind::PermissionDenied => format!("Sem permissão para gravar: {}", path.display()),
        io::ErrorKind::StorageFull => "Não há espaço livre no disco.".to_owned(),
        _ => format!("Não foi possível gravar o arquivo: {}", path.display()),
    };
    AppError::new("file_write", message)
}

/// Temp file in the same directory, fsync, rename over `path`, fsync the directory.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("arquivo");
    // Unique per write: two threads writing the same path (e.g. two cover requests that both
    // missed the cache) must not share, and truncate, one temp file.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}.{n}.tmp", std::process::id()));
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    sync_dir(dir);
    Ok(())
}

/// Makes the rename durable. Directories cannot be opened for fsync on Windows; NTFS journals the
/// rename itself.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Err(e) = File::open(dir).and_then(|d| d.sync_all()) {
        tracing::debug!(path = %dir.display(), %e, "directory fsync failed");
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "ab00000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn concurrent_atomic_writes_never_leave_a_partial_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cover.png");
        let big: Vec<u8> = (0..2_000_000u32).map(|i| (i % 251) as u8).collect();
        for _ in 0..5 {
            std::thread::scope(|scope| {
                for _ in 0..8 {
                    scope.spawn(|| write_atomic(&path, &big).unwrap());
                }
            });
            assert_eq!(fs::read(&path).unwrap(), big);
        }
        let names: Vec<_> = fs::read_dir(tmp.path()).unwrap().flatten().collect();
        assert_eq!(names.len(), 1, "no temp files are left behind");
    }

    #[test]
    fn paths_are_relative_and_checked() {
        assert_eq!(
            BookFiles::version_rel_path(UID, 3, "0123456789abcdef"),
            format!("books/{UID}/v3-01234567.pdf")
        );
        let files = BookFiles::new("/data");
        assert_eq!(
            files.resolve("books/x/v1-a.pdf"),
            Some(PathBuf::from("/data/books/x/v1-a.pdf"))
        );
        assert_eq!(files.resolve("../etc/passwd"), None);
        assert_eq!(files.resolve("books/../../x"), None);
    }

    #[test]
    fn atomic_writes_replace_and_prune_keeps_the_named_files() {
        let dir = tempfile::tempdir().unwrap();
        let files = BookFiles::new(dir.path());
        let v1 = files.write_version(UID, 1, "11111111aa", b"one").unwrap();
        let v2 = files.write_version(UID, 2, "22222222bb", b"two").unwrap();
        let v3 = files.write_version(UID, 3, "33333333cc", b"three").unwrap();
        for v in 1..=3 {
            files.write_cover(UID, v, b"png").unwrap();
        }
        files.prune(UID, &[&v2, &v3], 2);
        assert!(!dir.path().join(&v1).exists());
        assert_eq!(fs::read(dir.path().join(&v3)).unwrap(), b"three");
        assert!(dir.path().join(&v2).exists());
        assert!(!files.cover_path(UID, 1).exists());
        assert!(files.cover_path(UID, 2).exists());
        // No temp files are left behind.
        let names: Vec<_> = fs::read_dir(files.book_dir(UID))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2);

        files.remove_book(UID);
        assert!(!files.book_dir(UID).exists());
        assert!(!files.cover_path(UID, 3).exists());
    }
}
