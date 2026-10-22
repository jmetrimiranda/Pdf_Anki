//! Phase 0 Tauri commands (spec 15). Every command returns `AppError` (`{ code, message }`).
//! All of them block on the collection or the PDF engine, so they run on the blocking pool.

use std::sync::Arc;

use core_anki::DeckTree;
use core_pdf::{DocHandle, DocInfo, DocumentEngine, OutlineItem, PageWords, SearchHit, SearchOpts};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

type Shared<'a> = State<'a, Arc<AppState>>;

async fn blocking<R, F>(state: &Shared<'_>, f: F) -> Result<R, AppError>
where
    R: Send + 'static,
    F: FnOnce(&AppState) -> Result<R, AppError> + Send + 'static,
{
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || f(&state)).await?
}

fn doc_handle(doc_id: &str) -> Result<DocHandle, AppError> {
    Ok(doc_id.parse::<DocHandle>()?)
}

#[tauri::command]
pub async fn anki_deck_tree(state: Shared<'_>) -> Result<DeckTree, AppError> {
    let anki = blocking(&state, AppState::anki).await?;
    Ok(anki.deck_tree().await?)
}

#[tauri::command]
pub async fn doc_open_path(state: Shared<'_>, path: String) -> Result<DocInfo, AppError> {
    blocking(&state, move |s| {
        let bytes = std::fs::read(&path).map_err(|e| AppError::read_file(&path, &e))?;
        let doc = s.pdf().open(Arc::new(bytes), None)?;
        tracing::info!(%doc, path, "document open");
        s.pdf()
            .info(doc)
            .inspect_err(|_| s.pdf().close(doc))
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn doc_info(state: Shared<'_>, doc_id: String) -> Result<DocInfo, AppError> {
    blocking(&state, move |s| Ok(s.pdf().info(doc_handle(&doc_id)?)?)).await
}

#[tauri::command]
pub async fn doc_outline(state: Shared<'_>, doc_id: String) -> Result<Vec<OutlineItem>, AppError> {
    blocking(&state, move |s| {
        Ok(s.pdf().outline(doc_handle(&doc_id)?)?)
    })
    .await
}

#[tauri::command]
pub async fn doc_words(
    state: Shared<'_>,
    doc_id: String,
    page: usize,
) -> Result<PageWords, AppError> {
    blocking(&state, move |s| {
        Ok(s.pdf().page_words(doc_handle(&doc_id)?, page)?)
    })
    .await
}

#[tauri::command]
pub async fn doc_search(
    state: Shared<'_>,
    doc_id: String,
    q: String,
) -> Result<Vec<SearchHit>, AppError> {
    blocking(&state, move |s| {
        let doc = doc_handle(&doc_id)?;
        if q.trim().is_empty() {
            s.pdf().info(doc)?; // still report a closed document
            return Ok(Vec::new());
        }
        Ok(s.pdf().search(doc, &q, SearchOpts::default())?)
    })
    .await
}

#[tauri::command]
pub async fn doc_close(state: Shared<'_>, doc_id: String) -> Result<(), AppError> {
    blocking(&state, move |s| {
        s.pdf().close(doc_handle(&doc_id)?);
        Ok(())
    })
    .await
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn dev_smoke(state: Shared<'_>) -> Result<crate::SmokeReport, AppError> {
    blocking(&state, |s| crate::smoke::run(s).map(|(report, _)| report)).await
}
