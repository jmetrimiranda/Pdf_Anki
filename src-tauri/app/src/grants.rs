//! One-shot path grants (spec 18).
//!
//! - **Export (write) grants.** `book_export`, `export_bytes` and `anki_export` write files outside
//!   the app folder, so they only accept a path the user has just chosen in the save dialog that
//!   the core itself opened (`export_pick_path`).
//! - **Read grants.** `anki_import` and `anki_import_colpkg` read a package from anywhere, so they
//!   only accept a path the user handed to the app: picked in the open dialog the core opened
//!   (`anki_pick_package`), given on the command line / a second launch ("Abrir com") or dropped
//!   on the window.
//!
//! Any script running at the UI's origin (including the same-origin PdfCraft iframe, which can
//! reach `parent.__TAURI_INTERNALS__`) therefore cannot read or overwrite an arbitrary file: without
//! the user choosing it, the path is never granted.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::AppError;

/// A grant left unused (e.g. the export failed before writing) expires after this long.
pub const GRANT_TTL: Duration = Duration::from_secs(10 * 60);
/// At most this many pending grants are kept; the oldest is dropped first.
const MAX_GRANTS: usize = 8;

/// Paths granted once each, for [`GRANT_TTL`].
struct PathGrants {
    pending: Mutex<Vec<(PathBuf, Instant)>>,
}

impl PathGrants {
    const fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
        }
    }

    fn grant_at(&self, path: PathBuf, now: Instant) {
        let mut pending = self.lock();
        pending.retain(|(p, at)| p != &path && now.saturating_duration_since(*at) < GRANT_TTL);
        if pending.len() >= MAX_GRANTS {
            pending.remove(0);
        }
        pending.push((path, now));
    }

    /// Consumes the grant; `false` when there is none (or it expired).
    fn take_at(&self, path: &Path, now: Instant) -> bool {
        let mut pending = self.lock();
        pending.retain(|(_, at)| now.saturating_duration_since(*at) < GRANT_TTL);
        match pending.iter().position(|(p, _)| p == path) {
            Some(i) => {
                pending.remove(i);
                true
            }
            None => false,
        }
    }

    fn contains_at(&self, path: &Path, now: Instant) -> bool {
        self.lock()
            .iter()
            .any(|(p, at)| p == path && now.saturating_duration_since(*at) < GRANT_TTL)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(PathBuf, Instant)>> {
        // A poisoned lock only means a panic elsewhere; the list itself stays consistent.
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Write grants: paths chosen in the core-opened save dialog.
pub struct ExportGrants(PathGrants);

impl Default for ExportGrants {
    fn default() -> Self {
        Self(PathGrants::new())
    }
}

impl ExportGrants {
    /// Records `path` (just chosen by the user in the save dialog) as writable once.
    pub fn grant(&self, path: PathBuf) {
        self.grant_at(path, Instant::now());
    }

    /// Consumes the grant for `path`; fails if the user did not choose it (or it expired).
    pub fn take(&self, path: &Path) -> Result<(), AppError> {
        self.take_at(path, Instant::now())
    }

    pub fn grant_at(&self, path: PathBuf, now: Instant) {
        self.0.grant_at(path, now);
    }

    pub fn take_at(&self, path: &Path, now: Instant) -> Result<(), AppError> {
        if self.0.take_at(path, now) {
            return Ok(());
        }
        tracing::warn!(path = %path.display(), "export to a path not chosen in the save dialog");
        Err(AppError::new(
            "export_not_granted",
            "Escolha onde salvar a cópia na janela de exportação.",
        ))
    }
}

/// Read grants: packages the user picked, opened with the app or dropped on the window.
pub struct ReadGrants(PathGrants);

impl Default for ReadGrants {
    fn default() -> Self {
        Self(PathGrants::new())
    }
}

impl ReadGrants {
    pub fn grant(&self, path: PathBuf) {
        self.grant_at(path, Instant::now());
    }

    /// Consumes the grant for `path`; fails with `anki_path_not_allowed` without one.
    pub fn take(&self, path: &Path) -> Result<(), AppError> {
        self.take_at(path, Instant::now())
    }

    /// Whether `path` is currently granted (without consuming it).
    pub fn is_granted(&self, path: &Path) -> bool {
        self.0.contains_at(path, Instant::now())
    }

    pub fn grant_at(&self, path: PathBuf, now: Instant) {
        self.0.grant_at(path, now);
    }

    pub fn take_at(&self, path: &Path, now: Instant) -> Result<(), AppError> {
        if self.0.take_at(path, now) {
            return Ok(());
        }
        tracing::warn!(path = %path.display(), "import of a package the user did not choose");
        Err(path_not_allowed())
    }
}

/// The error of an import whose path was not granted or has the wrong extension.
pub fn path_not_allowed() -> AppError {
    AppError::new(
        "anki_path_not_allowed",
        "Escolha o pacote do Anki pela janela de importação, abra-o com o app ou arraste-o para a janela.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn only_a_granted_path_is_writable_and_only_once() {
        let g = ExportGrants::default();
        let t0 = Instant::now();
        assert_eq!(
            g.take_at(&p("/home/u/tese.pdf"), t0).unwrap_err().code,
            "export_not_granted"
        );
        g.grant_at(p("/tmp/copia.pdf"), t0);
        assert!(g.take_at(&p("/home/u/tese.pdf"), t0).is_err());
        assert!(g.take_at(&p("/tmp/copia.pdf"), t0).is_ok());
        assert!(
            g.take_at(&p("/tmp/copia.pdf"), t0).is_err(),
            "grants are one-shot"
        );
    }

    #[test]
    fn grants_expire() {
        let g = ExportGrants::default();
        let t0 = Instant::now();
        g.grant_at(p("/tmp/a.pdf"), t0);
        assert!(g.take_at(&p("/tmp/a.pdf"), t0 + GRANT_TTL).is_err());
        g.grant_at(p("/tmp/b.pdf"), t0);
        assert!(
            g.take_at(&p("/tmp/b.pdf"), t0 + GRANT_TTL - Duration::from_secs(1))
                .is_ok()
        );
    }

    #[test]
    fn pending_grants_are_bounded() {
        let g = ExportGrants::default();
        let t0 = Instant::now();
        for i in 0..=MAX_GRANTS {
            g.grant_at(p(&format!("/tmp/{i}.pdf")), t0);
        }
        assert!(
            g.take_at(&p("/tmp/0.pdf"), t0).is_err(),
            "the oldest grant was dropped"
        );
        assert!(g.take_at(&p(&format!("/tmp/{MAX_GRANTS}.pdf")), t0).is_ok());
    }

    #[test]
    fn read_grants_are_separate_and_one_shot() {
        let read = ReadGrants::default();
        let export = ExportGrants::default();
        let t0 = Instant::now();
        export.grant_at(p("/tmp/x.apkg"), t0);
        assert_eq!(
            read.take_at(&p("/tmp/x.apkg"), t0).unwrap_err().code,
            "anki_path_not_allowed",
            "a write grant is not a read grant"
        );
        read.grant_at(p("/tmp/x.apkg"), t0);
        assert!(read.0.contains_at(&p("/tmp/x.apkg"), t0));
        assert!(read.take_at(&p("/tmp/x.apkg"), t0).is_ok());
        assert!(read.take_at(&p("/tmp/x.apkg"), t0).is_err());
        read.grant_at(p("/tmp/y.colpkg"), t0);
        assert!(read.take_at(&p("/tmp/y.colpkg"), t0 + GRANT_TTL).is_err());
    }
}
