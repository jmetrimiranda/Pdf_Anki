//! One-shot write grants for exports (spec 18). `book_export` and `export_bytes` write files outside
//! the app folder, so they only accept a path the user has just chosen in the save dialog that the
//! core itself opened (`export_pick_path`). Any script running at the UI's origin (including the
//! same-origin PdfCraft iframe, which can reach `parent.__TAURI_INTERNALS__`) therefore cannot
//! overwrite an arbitrary file: without the user picking it, the path is never granted.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::AppError;

/// A grant left unused (e.g. the export failed before writing) expires after this long.
pub const GRANT_TTL: Duration = Duration::from_secs(10 * 60);
/// At most this many pending grants are kept; the oldest is dropped first.
const MAX_GRANTS: usize = 8;

#[derive(Default)]
pub struct ExportGrants {
    pending: Mutex<Vec<(PathBuf, Instant)>>,
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
        let mut pending = self.lock();
        pending.retain(|(p, at)| p != &path && now.saturating_duration_since(*at) < GRANT_TTL);
        if pending.len() >= MAX_GRANTS {
            pending.remove(0);
        }
        pending.push((path, now));
    }

    pub fn take_at(&self, path: &Path, now: Instant) -> Result<(), AppError> {
        let mut pending = self.lock();
        pending.retain(|(_, at)| now.saturating_duration_since(*at) < GRANT_TTL);
        match pending.iter().position(|(p, _)| p == path) {
            Some(i) => {
                pending.remove(i);
                Ok(())
            }
            None => {
                tracing::warn!(path = %path.display(), "export to a path not chosen in the save dialog");
                Err(AppError::new(
                    "export_not_granted",
                    "Escolha onde salvar a cópia na janela de exportação.",
                ))
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(PathBuf, Instant)>> {
        // A poisoned lock only means a panic elsewhere; the list itself stays consistent.
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
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
}
