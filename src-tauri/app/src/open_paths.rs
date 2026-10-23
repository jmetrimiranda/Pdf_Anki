//! "Abrir com" (spec 6.6, 8.5): PDF and Anki package paths from the command line. The first launch
//! keeps them until the UI asks (`pending_open_paths`); a second launch hands them to the running
//! app, which emits [`crate::OPEN_PATHS_EVENT`] and comes to the front. The UI routes each path by
//! its extension (`.pdf` → library, `.apkg`/`.colpkg` → Anki import after confirmation); the core
//! grants a one-shot read of the packages (see [`crate::grants`]).

use std::path::Path;

/// Extensions the app opens, lowercase.
pub const OPEN_EXTENSIONS: &[&str] = &["pdf", "apkg", "colpkg"];

/// Lowercased extension of `path`, if it is one the app opens.
pub fn open_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?;
    OPEN_EXTENSIONS
        .iter()
        .copied()
        .find(|known| ext.eq_ignore_ascii_case(known))
}

/// Whether `path` has the extension of an Anki package (`.apkg` or `.colpkg`).
pub fn is_anki_package(path: &Path) -> bool {
    matches!(open_kind(path), Some("apkg" | "colpkg"))
}

/// Whether `path` ends in `.{ext}` (case-insensitive).
pub fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// The arguments that are existing `.pdf`, `.apkg` or `.colpkg` files, made absolute against
/// `cwd`. Flags and anything else (a launcher's own arguments) are ignored.
pub fn open_paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        let arg = arg.strip_prefix("file://").unwrap_or(&arg);
        let path = Path::new(arg);
        if open_kind(path).is_none() {
            continue;
        }
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        if path.is_file() {
            let path = path.display().to_string();
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// Called by the single-instance plugin in the running app with the second launch's arguments.
#[cfg(desktop)]
pub fn second_instance<R: tauri::Runtime>(app: &tauri::AppHandle<R>, argv: Vec<String>, cwd: &str) {
    use std::sync::Arc;

    use tauri::{Emitter, Manager};

    let paths = open_paths_from_args(argv.into_iter().skip(1), Path::new(cwd));
    tracing::info!(count = paths.len(), "second launch");
    if let Some(state) = app.try_state::<Arc<crate::AppState>>() {
        state.grant_packages(&paths);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if !paths.is_empty()
        && let Err(e) = app.emit_to("main", crate::OPEN_PATHS_EVENT, &paths)
    {
        tracing::warn!(%e, "could not hand the opened files to the UI");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_existing_pdfs_and_anki_packages_only() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.pdf", "b.txt", "deck.APKG", "col.colpkg", "x.anki2"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        let abs = |n: &str| dir.path().join(n).display().to_string();
        let a = abs("a.pdf");
        let got = open_paths_from_args(
            [
                "--flag",
                "a.pdf",
                "b.txt",
                "missing.pdf",
                a.as_str(),
                "deck.APKG",
                "col.colpkg",
                "x.anki2",
                "missing.apkg",
            ]
            .into_iter()
            .map(String::from),
            dir.path(),
        );
        assert_eq!(got, vec![a, abs("deck.APKG"), abs("col.colpkg")]);
    }

    #[test]
    fn classifies_by_extension() {
        assert_eq!(open_kind(Path::new("/x/Livro.PDF")), Some("pdf"));
        assert!(is_anki_package(Path::new("/x/a.Apkg")));
        assert!(is_anki_package(Path::new("/x/a.colpkg")));
        assert!(!is_anki_package(Path::new("/x/a.pdf")));
        assert!(!is_anki_package(Path::new("/x/apkg")));
        assert!(has_extension(Path::new("a.COLPKG"), "colpkg"));
        assert!(!has_extension(Path::new("a.colpkg.txt"), "colpkg"));
    }
}
