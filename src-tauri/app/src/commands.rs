//! Tauri commands (spec 15). Every command returns `AppError` (`{ code, message }`, pt-BR) and is
//! a thin wrapper over an [`AppState`] method run on the blocking pool. File bytes travel as raw
//! IPC bodies (`tauri::ipc::Request` / `Response`), never as JSON arrays.

use std::path::PathBuf;
use std::sync::Arc;

use core_anki::browse::{BrowseOrder, BrowseRow, ForgetOptions};
use core_anki::notes::{AddDefaults, NewNote, NoteAdded, NoteCheck, NoteData, NotetypeInfo};
use core_anki::study::{AnswerSide, CardAction, CardActionResult, StudyNext};
use core_anki::{
    BackupInfo, DeckName, DeckTree, ExportOptions, ExportResult, ImportSummary, PrepareReport,
};
use core_pdf::PageWords;
use core_store::{ClosedSession, LibraryEntry, ReadingPosition};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::anki::{ChangeNotetypePrepared, DeckDeleted};
use crate::error::AppError;
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
/// Header of `anki_media_add` with the percent-encoded file name.
pub const FILE_NAME_HEADER: &str = "x-file-name";

async fn blocking<R, F>(state: &Shared<'_>, f: F) -> Result<R, AppError>
where
    R: Send + 'static,
    F: FnOnce(&AppState) -> Result<R, AppError> + Send + 'static,
{
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || f(&state)).await?
}

/// Makes sure the collection (and the study session/bridge) is open, off the async runtime, so the
/// `AppState::anki_*` methods below never block a runtime worker on the first open.
async fn anki_ready(state: &Shared<'_>) -> Result<(), AppError> {
    blocking(state, |s| s.anki_handles().map(|_| ())).await
}

#[tauri::command]
pub async fn anki_deck_tree(state: Shared<'_>) -> Result<DeckTree, AppError> {
    anki_ready(&state).await?;
    state.anki_deck_tree().await
}

#[tauri::command]
pub async fn anki_deck_names(state: Shared<'_>) -> Result<Vec<DeckName>, AppError> {
    anki_ready(&state).await?;
    state.anki_deck_names().await
}

#[tauri::command]
pub async fn anki_deck_create(state: Shared<'_>, name: String) -> Result<i64, AppError> {
    anki_ready(&state).await?;
    state.anki_deck_create(name).await
}

#[tauri::command]
pub async fn anki_deck_rename(
    state: Shared<'_>,
    deck_id: i64,
    name: String,
) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_deck_rename(deck_id, name).await
}

#[tauri::command]
pub async fn anki_deck_move(
    state: Shared<'_>,
    deck_ids: Vec<i64>,
    parent_id: Option<i64>,
) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_deck_move(deck_ids, parent_id).await
}

#[tauri::command]
pub async fn anki_deck_delete(state: Shared<'_>, deck_id: i64) -> Result<DeckDeleted, AppError> {
    anki_ready(&state).await?;
    state.anki_deck_delete(deck_id).await
}

#[tauri::command]
pub async fn anki_deck_set_collapsed(
    state: Shared<'_>,
    deck_id: i64,
    collapsed: bool,
) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_deck_set_collapsed(deck_id, collapsed).await
}

#[tauri::command]
pub async fn anki_set_current_deck(state: Shared<'_>, deck_id: i64) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_set_current_deck(deck_id).await
}

#[tauri::command]
pub async fn anki_prepare_collection(state: Shared<'_>) -> Result<PrepareReport, AppError> {
    anki_ready(&state).await?;
    state.anki_prepare_collection().await
}

#[tauri::command]
pub async fn anki_study_next(state: Shared<'_>, deck_id: i64) -> Result<StudyNext, AppError> {
    anki_ready(&state).await?;
    state.anki_study_next(deck_id).await
}

#[tauri::command]
pub async fn anki_show_answer(
    state: Shared<'_>,
    card_id: i64,
    typed: Option<String>,
) -> Result<AnswerSide, AppError> {
    anki_ready(&state).await?;
    state.anki_show_answer(card_id, typed).await
}

#[tauri::command]
pub async fn anki_answer(
    state: Shared<'_>,
    card_id: i64,
    rating: u8,
    ms: u32,
) -> Result<StudyNext, AppError> {
    anki_ready(&state).await?;
    state.anki_answer(card_id, rating, ms).await
}

#[tauri::command]
pub async fn anki_undo(state: Shared<'_>) -> Result<StudyNext, AppError> {
    anki_ready(&state).await?;
    state.anki_undo().await
}

#[tauri::command]
pub async fn anki_card_action(
    state: Shared<'_>,
    card_id: i64,
    action: CardAction,
    flag: Option<u8>,
) -> Result<CardActionResult, AppError> {
    anki_ready(&state).await?;
    state.anki_card_action(card_id, action, flag).await
}

#[tauri::command]
pub async fn anki_study_close(state: Shared<'_>) -> Result<(), AppError> {
    blocking(&state, AppState::anki_study_close).await
}

#[tauri::command]
pub async fn anki_notetypes(state: Shared<'_>) -> Result<Vec<NotetypeInfo>, AppError> {
    anki_ready(&state).await?;
    state.anki_notetypes().await
}

#[tauri::command]
pub async fn anki_add_defaults(
    state: Shared<'_>,
    deck_id: Option<i64>,
) -> Result<AddDefaults, AppError> {
    anki_ready(&state).await?;
    state.anki_add_defaults(deck_id).await
}

#[tauri::command]
pub async fn anki_note_get(state: Shared<'_>, note_id: i64) -> Result<NoteData, AppError> {
    anki_ready(&state).await?;
    state.anki_note_get(note_id).await
}

#[tauri::command]
pub async fn anki_note_check(
    state: Shared<'_>,
    notetype_id: i64,
    fields: Vec<String>,
) -> Result<NoteCheck, AppError> {
    anki_ready(&state).await?;
    state.anki_note_check(notetype_id, fields).await
}

#[tauri::command]
pub async fn anki_note_add(state: Shared<'_>, note: NewNote) -> Result<NoteAdded, AppError> {
    anki_ready(&state).await?;
    state.anki_note_add(note).await
}

#[tauri::command]
pub async fn anki_note_update(
    state: Shared<'_>,
    note_id: i64,
    fields: Vec<String>,
    tags: Vec<String>,
) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_note_update(note_id, fields, tags).await
}

/// Raw body: the image bytes; header `x-file-name` (percent-encoded). Returns the media name.
#[tauri::command]
pub async fn anki_media_add(state: Shared<'_>, request: Request<'_>) -> Result<String, AppError> {
    let name = header(&request, FILE_NAME_HEADER)?;
    let name = percent_encoding::percent_decode_str(&name)
        .decode_utf8()
        .map_err(|_| bad_request("nome de arquivo inválido."))?
        .into_owned();
    let bytes = raw_body(&request)?;
    anki_ready(&state).await?;
    state.anki_media_add(name, bytes).await
}

#[tauri::command]
pub async fn anki_tags_all(state: Shared<'_>) -> Result<Vec<String>, AppError> {
    anki_ready(&state).await?;
    state.anki_tags_all().await
}

#[tauri::command]
pub async fn anki_search(
    state: Shared<'_>,
    query: String,
    order: Option<BrowseOrder>,
) -> Result<Vec<i64>, AppError> {
    anki_ready(&state).await?;
    state.anki_search(query, order).await
}

#[tauri::command]
pub async fn anki_browse_rows(
    state: Shared<'_>,
    card_ids: Vec<i64>,
) -> Result<Vec<BrowseRow>, AppError> {
    anki_ready(&state).await?;
    state.anki_browse_rows(card_ids).await
}

#[tauri::command]
pub async fn anki_cards_set_deck(
    state: Shared<'_>,
    card_ids: Vec<i64>,
    deck_id: i64,
) -> Result<u32, AppError> {
    anki_ready(&state).await?;
    state.anki_cards_set_deck(card_ids, deck_id).await
}

#[tauri::command]
pub async fn anki_notes_tags(
    state: Shared<'_>,
    note_ids: Vec<i64>,
    add: String,
    remove: String,
) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_notes_tags(note_ids, add, remove).await
}

#[tauri::command]
pub async fn anki_cards_suspend(
    state: Shared<'_>,
    card_ids: Vec<i64>,
    suspended: bool,
) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_cards_suspend(card_ids, suspended).await
}

#[tauri::command]
pub async fn anki_cards_forget(
    state: Shared<'_>,
    card_ids: Vec<i64>,
    opts: ForgetOptions,
) -> Result<(), AppError> {
    anki_ready(&state).await?;
    state.anki_cards_forget(card_ids, opts).await
}

#[tauri::command]
pub async fn anki_notes_delete(state: Shared<'_>, note_ids: Vec<i64>) -> Result<u32, AppError> {
    anki_ready(&state).await?;
    state.anki_notes_delete(note_ids).await
}

#[tauri::command]
pub async fn anki_change_notetype_prepare(
    state: Shared<'_>,
    note_ids: Vec<i64>,
) -> Result<ChangeNotetypePrepared, AppError> {
    anki_ready(&state).await?;
    state.anki_change_notetype_prepare(note_ids).await
}

/// The open dialog for "Importar" (.apkg/.colpkg), opened by the core: the chosen path gets a
/// one-shot read grant for `anki_import`/`anki_import_colpkg`. `None` when cancelled (or on
/// platforms without the dialog).
#[tauri::command]
pub async fn anki_pick_package<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: Shared<'_>,
) -> Result<Option<String>, AppError> {
    let picked = tauri::async_runtime::spawn_blocking(move || pick_package(&window)).await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let Some(text) = path.to_str().map(str::to_owned) else {
        return Err(bad_request("caminho de arquivo inválido."));
    };
    state.read_grants().grant(path);
    Ok(Some(text))
}

#[cfg(desktop)]
fn pick_package<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let picked = window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Importar do Anki")
        .add_filter("Anki", &["apkg", "colpkg"])
        .blocking_pick_file()?;
    picked
        .into_path()
        .map_err(|e| tracing::warn!(%e, "open dialog returned an unusable path"))
        .ok()
}

#[cfg(not(desktop))]
fn pick_package<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> Option<PathBuf> {
    None
}

#[tauri::command]
pub async fn anki_import(state: Shared<'_>, path: String) -> Result<ImportSummary, AppError> {
    anki_ready(&state).await?;
    state.anki_import(&path).await
}

#[tauri::command]
pub async fn anki_import_colpkg(state: Shared<'_>, path: String) -> Result<BackupInfo, AppError> {
    anki_ready(&state).await?;
    state.anki_import_colpkg(&path).await
}

#[tauri::command]
pub async fn anki_export(
    state: Shared<'_>,
    deck_id: i64,
    path: String,
    opts: ExportOptions,
) -> Result<ExportResult, AppError> {
    anki_ready(&state).await?;
    state.anki_export(deck_id, &path, opts).await
}

#[tauri::command]
pub async fn anki_backup_now(state: Shared<'_>) -> Result<BackupInfo, AppError> {
    anki_ready(&state).await?;
    state.anki_backup_now().await
}

#[tauri::command]
pub async fn anki_backups(state: Shared<'_>) -> Result<Vec<BackupInfo>, AppError> {
    blocking(&state, AppState::anki_backups).await
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

/// What `export_pick_path` saves: a PDF (default) or an Anki deck package.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    #[default]
    Pdf,
    Apkg,
}

impl ExportKind {
    fn filter(self) -> (&'static str, &'static str) {
        match self {
            Self::Pdf => ("PDF", "pdf"),
            Self::Apkg => ("Pacote do Anki", "apkg"),
        }
    }
}

/// "Exportar cópia" / "Exportar .apkg": the core opens the save dialog itself and grants the
/// chosen path for one `book_export`/`export_bytes`/`anki_export`, so the UI (or the same-origin
/// PdfCraft iframe) cannot write to a path the user did not pick (spec 18). `None` when the user
/// cancels.
#[tauri::command]
pub async fn export_pick_path<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: Shared<'_>,
    default_name: String,
    title: String,
    kind: Option<ExportKind>,
) -> Result<Option<String>, AppError> {
    let kind = kind.unwrap_or_default();
    let file_name = export_file_name(&default_name, kind);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        pick_save_path(&window, &title, &file_name, kind)
    })
    .await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    // The path travels back as a string; one that is not UTF-8 could not be matched later.
    let Some(text) = path.to_str().map(str::to_owned) else {
        return Err(bad_request("caminho de arquivo inválido."));
    };
    state.export_grants().grant(path);
    Ok(Some(text))
}

#[cfg(desktop)]
fn pick_save_path<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    title: &str,
    file_name: &str,
    kind: ExportKind,
) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let (filter, ext) = kind.filter();
    let picked = window
        .dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(filter, &[ext])
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
    _kind: ExportKind,
) -> Option<PathBuf> {
    None
}

/// The dialog's suggested name: only a file name (no directories), bounded, never empty, with
/// the extension of `kind` (added when missing).
fn export_file_name(suggested: &str, kind: ExportKind) -> String {
    let (_, ext) = kind.filter();
    // Deck names use `::` for subdecks; `<>:"|?*` are not valid in Windows file names.
    let name: String = suggested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .replace("::", " - ")
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .take(200)
        .collect();
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return match kind {
            ExportKind::Pdf => "documento.pdf".to_owned(),
            ExportKind::Apkg => "deck.apkg".to_owned(),
        };
    }
    if crate::open_paths::has_extension(std::path::Path::new(name), ext) {
        name.to_owned()
    } else {
        format!("{name}.{ext}")
    }
}

/// Copies the current version to a path granted by `export_pick_path`.
#[tauri::command]
pub async fn book_export(state: Shared<'_>, uid: String, path: String) -> Result<(), AppError> {
    let path = PathBuf::from(path);
    state.export_grants().take(&path)?;
    blocking(&state, move |s| s.book_export(&uid, &path)).await
}

/// Raw body: the PDF of a PdfCraft tab that is not a library book; header `x-path` (a path
/// granted by `export_pick_path`).
#[tauri::command]
pub async fn export_bytes(state: Shared<'_>, request: Request<'_>) -> Result<(), AppError> {
    let path = header(&request, PATH_HEADER)?;
    let path = percent_encoding::percent_decode_str(&path)
        .decode_utf8()
        .map_err(|_| bad_request("caminho de arquivo inválido."))?
        .into_owned();
    let path = PathBuf::from(path);
    state.export_grants().take(&path)?;
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
    use super::{ExportKind, export_file_name};

    #[test]
    fn export_file_name_keeps_only_a_file_name() {
        let pdf = |s: &str| export_file_name(s, ExportKind::Pdf);
        assert_eq!(pdf("Animal Farm.pdf"), "Animal Farm.pdf");
        assert_eq!(pdf("/home/u/.ssh/tese.pdf"), "tese.pdf");
        assert_eq!(pdf("..\\..\\x.pdf"), "x.pdf");
        assert_eq!(pdf(".."), "documento.pdf");
        assert_eq!(pdf("  "), "documento.pdf");
        assert_eq!(pdf("a\nb.pdf"), "ab.pdf");
        assert_eq!(pdf(&"x".repeat(500)).chars().count(), 204);
        assert_eq!(pdf("Livro"), "Livro.pdf");
    }

    #[test]
    fn apkg_names_get_the_extension() {
        let apkg = |s: &str| export_file_name(s, ExportKind::Apkg);
        assert_eq!(apkg("5000 palavras"), "5000 palavras.apkg");
        assert_eq!(apkg("Oxford::Oxford 3000"), "Oxford - Oxford 3000.apkg");
        assert_eq!(apkg("a:b?"), "a_b_.apkg");
        assert_eq!(apkg("deck.APKG"), "deck.APKG");
        assert_eq!(apkg("../../etc/x"), "x.apkg");
        assert_eq!(apkg(""), "deck.apkg");
        let kind: ExportKind = serde_json::from_value(serde_json::json!("apkg")).unwrap();
        assert_eq!(kind, ExportKind::Apkg);
        assert!(serde_json::from_value::<ExportKind>(serde_json::json!("exe")).is_err());
    }
}
