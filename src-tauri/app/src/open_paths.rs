//! "Abrir com" (spec 6.6): PDF paths from the command line. The first launch keeps them until the
//! UI asks (`pending_open_paths`); a second launch hands them to the running app, which emits
//! [`crate::OPEN_PATHS_EVENT`] and comes to the front.

use std::path::Path;

/// The arguments that are existing `.pdf` files, made absolute against `cwd`. Flags and anything
/// else (a launcher's own arguments) are ignored.
pub fn pdf_paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        let arg = arg.strip_prefix("file://").unwrap_or(&arg);
        let path = Path::new(arg);
        let is_pdf = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        if !is_pdf {
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
    use tauri::{Emitter, Manager};

    let paths = pdf_paths_from_args(argv.into_iter().skip(1), Path::new(cwd));
    tracing::info!(count = paths.len(), "second launch");
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
    fn keeps_existing_pdfs_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.pdf"), b"%PDF").unwrap();
        std::fs::write(dir.path().join("b.txt"), b"x").unwrap();
        let abs = dir.path().join("a.pdf").display().to_string();
        let got = pdf_paths_from_args(
            ["--flag", "a.pdf", "b.txt", "missing.pdf", abs.as_str()]
                .into_iter()
                .map(String::from),
            dir.path(),
        );
        assert_eq!(got, vec![abs]);
    }
}
