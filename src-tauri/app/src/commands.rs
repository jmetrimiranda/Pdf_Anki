//! Tauri commands (spec 15). Every command returns `AppError` (`{ code, message }`, pt-BR) and is
//! a thin wrapper over an [`AppState`] method run on the blocking pool. File bytes travel as raw
//! IPC bodies (`tauri::ipc::Request` / `Response`), never as JSON arrays.

use std::path::PathBuf;
use std::sync::Arc;

use core_anki::DeckTree;
use core_pdf::PageWords;
use core_store::{ClosedSession, LibraryEntry, ReadingPosition};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::error::AppError;
use crate::export_grant::ExportGrants;
use crate::library::{AddedBook, BookOpen, LibraryPatch, SavedVersion};
use crate::reading::{SessionStarted, StopReasonArg};
use crate::state::AppState;

type Shared<'a> = State<'a, Arc<AppState>>;

/// Header of `book_save_version` with the book's `book_uid`.
pub const BOOK_UID_HEADER: &str = "x-book-uid";
/// Optional header of `book_save_version`: the `file_version` the PdfCraft tab was opened from.
pub const BASE_VERSION_HEADER: &str = "x-base-version";
/// Header of `export_bytes` with the percent-encoded absolute destination path.
pub const PATH_HEADER: &str = "x-path";

async fn blocking<R, F>(state: &Shared<'_>, f: F) -> Result<R, AppError>
where
    R: Send + 'static,
    F: FnOnce(&AppState) -> Result<R, AppError> + Send + 'static,
{
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || f(&state)).await?
}

#[tauri::command]
pub async fn anki_deck_tree(state: Shared<'_>) -> Result<DeckTree, AppError> {
    let anki = blocking(&state, AppState::anki).await?;
    Ok(anki.deck_tree().await?)
}

#[tauri::command]
pub async fn library_list(state: Shared<'_>) -> Result<Vec<LibraryEntry>, AppError> {
    blocking(&state, AppState::library_list).await
}

#[tauri::command]
pub async fn library_add(
    state: Shared<'_>,
    path: String,
    replace: Option<bool>,
) -> Result<AddedBook, AppError> {
    let replace = replace.unwrap_or(false);
    blocking(&state, move |s| {
        s.library_add(&PathBuf::from(path), replace)
    })
    .await
}

#[tauri::command]
pub async fn library_remove(state: Shared<'_>, uid: String) -> Result<(), AppError> {
    blocking(&state, move |s| s.library_remove(&uid)).await
}

#[tauri::command]
pub async fn library_update(
    state: Shared<'_>,
    uid: String,
    patch: LibraryPatch,
) -> Result<LibraryEntry, AppError> {
    blocking(&state, move |s| s.library_update(&uid, patch)).await
}

#[tauri::command]
pub async fn book_open(state: Shared<'_>, uid: String) -> Result<BookOpen, AppError> {
    blocking(&state, move |s| s.book_open(&uid)).await
}

/// The current version as a raw `ArrayBuffer` (for `pdfcraft:open`).
#[tauri::command]
pub async fn book_bytes(state: Shared<'_>, uid: String) -> Result<Response, AppError> {
    let bytes = blocking(&state, move |s| s.book_bytes(&uid)).await?;
    Ok(Response::new(bytes))
}

/// Raw body: the PDF from `pdfcraft:save`; header `x-book-uid`, optional `x-base-version` (the
/// `file_version` the PdfCraft tab was opened from).
#[tauri::command]
pub async fn book_save_version(
    state: Shared<'_>,
    request: Request<'_>,
) -> Result<SavedVersion, AppError> {
    let uid = header(&request, BOOK_UID_HEADER)?;
    let base = match request.headers().get(BASE_VERSION_HEADER) {
        None => None,
        Some(v) => Some(
            v.to_str()
                .ok()
                .and_then(|v| v.parse::<u32>().ok())
                .ok_or_else(|| {
                    bad_request(&format!("cabeçalho {BASE_VERSION_HEADER} inválido."))
                })?,
        ),
    };
    let bytes = raw_body(&request)?;
    blocking(&state, move |s| s.book_save_version_from(&uid, bytes, base)).await
}

/// "Exportar cópia": the core opens the save dialog itself and grants the chosen path for one
/// `book_export`/`export_bytes`, so the UI (or the same-origin PdfCraft iframe) cannot write to a
/// path the user did not pick (spec 18). `None` when the user cancels.
#[tauri::command]
pub async fn export_pick_path<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    grants: State<'_, ExportGrants>,
    default_name: String,
    title: String,
) -> Result<Option<String>, AppError> {
    let file_name = export_file_name(&default_name);
    let picked =
        tauri::async_runtime::spawn_blocking(move || pick_save_path(&window, &title, &file_name))
            .await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    // The path travels back as a string; one that is not UTF-8 could not be matched later.
    let Some(text) = path.to_str().map(str::to_owned) else {
        return Err(bad_request("caminho de arquivo inválido."));
    };
    grants.grant(path);
    Ok(Some(text))
}

#[cfg(desktop)]
fn pick_save_path<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    title: &str,
    file_name: &str,
) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let picked = window
        .dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .set_file_name(file_name)
        .add_filter("PDF", &["pdf"])
        .blocking_save_file()?;
    picked
        .into_path()
        .map_err(|e| tracing::warn!(%e, "save dialog returned an unusable path"))
        .ok()
}

#[cfg(not(desktop))]
fn pick_save_path<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _title: &str,
    _file_name: &str,
) -> Option<PathBuf> {
    None
}

/// The dialog's suggested name: only a file name (no directories), bounded, never empty.
fn export_file_name(suggested: &str) -> String {
    let name: String = suggested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        "documento.pdf".to_owned()
    } else {
        name.to_owned()
    }
}

/// Copies the current version to a path granted by `export_pick_path`.
#[tauri::command]
pub async fn book_export(
    state: Shared<'_>,
    grants: State<'_, ExportGrants>,
    uid: String,
    path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(path);
    grants.take(&path)?;
    blocking(&state, move |s| s.book_export(&uid, &path)).await
}

/// Raw body: the PDF of a PdfCraft tab that is not a library book; header `x-path` (a path
/// granted by `export_pick_path`).
#[tauri::command]
pub async fn export_bytes(
    state: Shared<'_>,
    grants: State<'_, ExportGrants>,
    request: Request<'_>,
) -> Result<(), AppError> {
    let path = header(&request, PATH_HEADER)?;
    let path = percent_encoding::percent_decode_str(&path)
        .decode_utf8()
        .map_err(|_| bad_request("caminho de arquivo inválido."))?
        .into_owned();
    let path = PathBuf::from(path);
    grants.take(&path)?;
    let bytes = raw_body(&request)?;
    blocking(&state, move |s| s.export_bytes(&path, &bytes)).await
}

/// "Abrir no visualizador do sistema" when PdfCraft cannot open a file.
#[tauri::command]
pub async fn book_open_external<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Shared<'_>,
    uid: String,
) -> Result<(), AppError> {
    let path = blocking(&state, move |s| s.current_file_path(&uid)).await?;
    open_external(&app, &path)
}

#[cfg(desktop)]
fn open_external<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &std::path::Path,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            tracing::warn!(%e, path = %path.display(), "could not open the system viewer");
            AppError::new(
                "open_external",
                "Não foi possível abrir o visualizador de PDF do sistema.",
            )
        })
}

#[cfg(not(desktop))]
fn open_external<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _path: &std::path::Path,
) -> Result<(), AppError> {
    Err(AppError::new(
        "unsupported",
        "Abrir em outro app ainda não está disponível neste aparelho.",
    ))
}

#[tauri::command]
pub async fn doc_words(state: Shared<'_>, uid: String, page: u32) -> Result<PageWords, AppError> {
    blocking(&state, move |s| s.doc_words(&uid, page)).await
}

#[tauri::command]
pub async fn position_get(
    state: Shared<'_>,
    uid: String,
) -> Result<Option<ReadingPosition>, AppError> {
    blocking(&state, move |s| s.position_get(&uid)).await
}

#[tauri::command]
pub async fn position_set(
    state: Shared<'_>,
    uid: String,
    page: u32,
    progress: f64,
) -> Result<ReadingPosition, AppError> {
    blocking(&state, move |s| s.position_set(&uid, page, progress)).await
}

#[tauri::command]
pub async fn reading_session_start(
    state: Shared<'_>,
    uid: String,
    page: u32,
) -> Result<SessionStarted, AppError> {
    blocking(&state, move |s| s.reading_session_start(&uid, page)).await
}

#[tauri::command]
pub async fn reading_session_heartbeat(
    state: Shared<'_>,
    uid: String,
    page: u32,
) -> Result<(), AppError> {
    blocking(&state, move |s| s.reading_session_heartbeat(&uid, page)).await
}

#[tauri::command]
pub async fn reading_session_stop(
    state: Shared<'_>,
    uid: Option<String>,
    reason: StopReasonArg,
) -> Result<Option<ClosedSession>, AppError> {
    blocking(&state, move |s| {
        s.reading_session_stop(uid.as_deref(), reason.into())
    })
    .await
}

#[tauri::command]
pub fn pending_open_paths(state: Shared<'_>) -> Vec<String> {
    state.take_open_paths()
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn dev_smoke(state: Shared<'_>) -> Result<crate::SmokeReport, AppError> {
    blocking(&state, |s| crate::smoke::run(s).map(|(report, _)| report)).await
}

/// UI diagnostics in the app log (e.g. the PdfCraft bridge under Xvfb). Debug builds (or the
/// `bridge-probe` feature) only.
#[cfg(any(debug_assertions, feature = "bridge-probe"))]
#[tauri::command]
pub fn dev_log(level: String, message: String) {
    let message: String = message.chars().take(2000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "leitor_ui", "{message}"),
        "warn" => tracing::warn!(target: "leitor_ui", "{message}"),
        "debug" => tracing::debug!(target: "leitor_ui", "{message}"),
        _ => tracing::info!(target: "leitor_ui", "{message}"),
    }
}

fn header(request: &Request<'_>, name: &str) -> Result<String, AppError> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| bad_request(&format!("falta o cabeçalho {name}.")))
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, AppError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err(bad_request("o arquivo precisa ir como bytes, não JSON.")),
    }
}

fn bad_request(detail: &str) -> AppError {
    AppError::new("invalid_request", format!("Pedido inválido: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::export_file_name;

    #[test]
    fn export_file_name_keeps_only_a_file_name() {
        assert_eq!(export_file_name("Animal Farm.pdf"), "Animal Farm.pdf");
        assert_eq!(export_file_name("/home/u/.ssh/tese.pdf"), "tese.pdf");
        assert_eq!(export_file_name("..\\..\\x.pdf"), "x.pdf");
        assert_eq!(export_file_name(".."), "documento.pdf");
        assert_eq!(export_file_name("  "), "documento.pdf");
        assert_eq!(export_file_name("a\nb.pdf"), "ab.pdf");
        assert_eq!(export_file_name(&"x".repeat(500)).chars().count(), 200);
    }
}
