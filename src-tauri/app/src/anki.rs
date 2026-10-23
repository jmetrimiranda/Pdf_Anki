//! The Anki side of the shell (spec 8, 15): the handles shared by the commands and the `anki`/
//! `card` protocols (collection service, study session, `/_anki/` bridge), the events sent to the
//! UI, the grant-checked import/export, and the daily backup ticker.
//!
//! Everything here is a plain [`AppState`] method so the integration tests need no webview; the
//! Tauri commands in `commands.rs` are thin wrappers.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use chrono::{DateTime, Local};
use core_anki::bridge::{Bridge, BridgeEvent, Caller, EventSink, PostReply, PostRequest};
use core_anki::browse::{self, BrowseOrder, BrowseRow, ForgetOptions};
use core_anki::notes::{self, AddDefaults, NewNote, NoteAdded, NoteCheck, NoteData, NotetypeInfo};
use core_anki::study::{
    AnswerSide, CardAction, CardActionResult, MiniReviewClosed, MiniReviewOpened, Study, StudyNext,
    StudyOwner,
};
use core_anki::{
    AnkiService, BackupInfo, BackupKind, DeckName, DeckTree, ExportOptions, ExportResult,
    ImportSummary, PrepareReport, backup, decks, import_export, media,
};
use serde::Serialize;

use crate::error::AppError;
use crate::grants;
use crate::open_paths::has_extension;
use crate::state::{AppState, lock};

/// Event with a [`BridgeEvent`] of an Anki page (close, ready, import done, search…).
pub const ANKI_PAGE_EVENT: &str = "anki://page";
/// Event `{ reason }` telling the screens to refetch Anki data.
pub const ANKI_CHANGED_EVENT: &str = "anki://changed";
/// Event [`StudyOwnerChange`]: the study session changed hands (spec 10.1, one place studies at a time).
pub const STUDY_OWNER_EVENT: &str = "anki://study-owner";

/// First daily-backup check after start, then every [`BACKUP_EVERY`].
pub const BACKUP_FIRST_DELAY: Duration = Duration::from_secs(2 * 60);
pub const BACKUP_EVERY: Duration = Duration::from_secs(30 * 60);

/// Why the Anki data changed (payload of [`ANKI_CHANGED_EVENT`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeReason {
    Import,
    Colpkg,
    Page,
    Backup,
    /// A normal sync applied changes from the server.
    Sync,
    /// A full sync replaced the collection (the study session was reset).
    SyncFull,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AnkiChanged {
    pub reason: ChangeReason,
}

/// Payload of [`STUDY_OWNER_EVENT`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyOwnerChange {
    /// Who studies now (`None`: nobody).
    pub owner: Option<StudyOwner>,
    /// The place whose open session was just taken over (it shows a notice), if any.
    pub preempted: Option<StudyOwner>,
}

/// What the core asks the UI (or the OS) to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UiEvent {
    /// `anki://page` with the bridge event as payload.
    AnkiPage(BridgeEvent),
    /// `anki://changed`.
    AnkiChanged(ChangeReason),
    /// Open an http(s) URL in the system browser.
    OpenUrl(String),
    /// `anki://sync` with the new sync status.
    AnkiSync(crate::sync::AnkiSyncStatus),
    /// `anki://study-owner`.
    StudyOwner(StudyOwnerChange),
    /// `leitor://deep-link` (a `leitor://livro/…` link opened by the OS).
    DeepLink(crate::deep_link::DeepLink),
}

/// Receives [`UiEvent`]s: the app emits them to the main window; tests collect them.
pub type UiSink = Arc<dyn Fn(UiEvent) + Send + Sync>;

/// How a bridge event reaches the UI: page events as `anki://page`, `changed` as
/// `anki://changed {reason:'page'}`, links to the system browser (http/https only).
pub fn ui_event_for(event: BridgeEvent) -> Option<UiEvent> {
    match event {
        BridgeEvent::Changed => Some(UiEvent::AnkiChanged(ChangeReason::Page)),
        BridgeEvent::OpenLink { url } => {
            let lower = url.trim_start().to_ascii_lowercase();
            if lower.starts_with("https://") || lower.starts_with("http://") {
                Some(UiEvent::OpenUrl(url))
            } else {
                tracing::warn!("ignored a non-http link from an Anki page");
                None
            }
        }
        other => Some(UiEvent::AnkiPage(other)),
    }
}

/// The collection service and what hangs off it. Cheap to clone.
#[derive(Clone)]
pub struct AnkiHandles {
    pub svc: AnkiService,
    pub study: Study,
    pub bridge: Bridge,
}

/// `anki_deck_delete` result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDeleted {
    pub cards_deleted: u32,
}

/// `anki_change_notetype_prepare` result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeNotetypePrepared {
    pub notetype_id: i64,
}

/// Sends a bridge request, opening the collection if needed (off the async runtime).
pub async fn bridge_post(state: Arc<AppState>, caller: Caller, req: PostRequest) -> PostReply {
    let handles = tauri::async_runtime::spawn_blocking(move || state.anki_handles()).await;
    match handles {
        Ok(Ok(h)) => h.bridge.post(caller, req).await,
        Ok(Err(e)) => PostReply {
            status: 503,
            content_type: "text/plain; charset=utf-8",
            body: e.message.into_bytes(),
        },
        Err(e) => {
            tracing::error!(%e, "bridge task failed");
            PostReply {
                status: 500,
                content_type: "text/plain; charset=utf-8",
                body: "Erro interno.".as_bytes().to_vec(),
            }
        }
    }
}

impl AppState {
    /// The collection service, study session and bridge, opening the collection on first use.
    /// Blocks the first time: call it off the async runtime.
    pub fn anki_handles(&self) -> Result<AnkiHandles, AppError> {
        let mut slot = lock(&self.anki_handles);
        if let Some(h) = slot.as_ref() {
            return Ok(h.clone());
        }
        let svc = self.anki()?;
        let study = Study::new(svc.clone());
        let sink_slot = Arc::clone(&self.ui_sink);
        let sink: EventSink = Arc::new(move |event| {
            if let Some(ui) = ui_event_for(event) {
                emit_with(&sink_slot, ui);
            }
        });
        let bridge = Bridge::new(svc.clone(), study.clone(), sink);
        let handles = AnkiHandles { svc, study, bridge };
        *slot = Some(handles.clone());
        Ok(handles)
    }

    /// Where events for the UI go (the app sets an emitter in `setup`; tests a collector).
    pub fn set_ui_sink(&self, sink: UiSink) {
        *self
            .ui_sink
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sink);
    }

    pub fn emit(&self, event: UiEvent) {
        emit_with(&self.ui_sink, event);
    }

    /// Grants a one-shot read of the Anki packages among "Abrir com"/dropped paths.
    pub fn grant_packages<S: AsRef<str>>(&self, paths: &[S]) {
        for p in paths {
            let path = Path::new(p.as_ref());
            if crate::open_paths::is_anki_package(path) && path.is_absolute() && path.is_file() {
                self.read_grants().grant(path.to_path_buf());
            }
        }
    }

    // --- Decks -----------------------------------------------------------------------------

    pub async fn anki_deck_tree(&self) -> Result<DeckTree, AppError> {
        Ok(self.anki_handles()?.svc.deck_tree().await?)
    }

    pub async fn anki_deck_names(&self) -> Result<Vec<DeckName>, AppError> {
        self.on_col(decks::names).await
    }

    pub async fn anki_deck_create(&self, name: String) -> Result<i64, AppError> {
        self.on_col(move |col| decks::create(col, &name)).await
    }

    pub async fn anki_deck_rename(&self, deck_id: i64, name: String) -> Result<(), AppError> {
        self.on_col(move |col| decks::rename(col, deck_id, &name))
            .await
    }

    pub async fn anki_deck_move(
        &self,
        deck_ids: Vec<i64>,
        parent_id: Option<i64>,
    ) -> Result<(), AppError> {
        self.on_col(move |col| decks::move_decks(col, &deck_ids, parent_id))
            .await
    }

    pub async fn anki_deck_delete(&self, deck_id: i64) -> Result<DeckDeleted, AppError> {
        let cards_deleted = self.on_col(move |col| decks::delete(col, deck_id)).await?;
        Ok(DeckDeleted { cards_deleted })
    }

    pub async fn anki_deck_set_collapsed(
        &self,
        deck_id: i64,
        collapsed: bool,
    ) -> Result<(), AppError> {
        self.on_col(move |col| decks::set_collapsed(col, deck_id, collapsed))
            .await
    }

    pub async fn anki_set_current_deck(&self, deck_id: i64) -> Result<(), AppError> {
        self.on_col(move |col| decks::set_current(col, deck_id))
            .await
    }

    pub async fn anki_prepare_collection(&self) -> Result<PrepareReport, AppError> {
        self.on_col(core_anki::notetypes::prepare_collection).await
    }

    // --- Study -----------------------------------------------------------------------------

    /// Studies `deck_id` in `owner` (default: the Anki tab). Taking the session from the other place emits
    /// [`STUDY_OWNER_EVENT`] with `preempted` (spec 10.1: one place studies at a time).
    pub async fn anki_study_next(
        &self,
        deck_id: i64,
        owner: Option<StudyOwner>,
    ) -> Result<StudyNext, AppError> {
        let owner = owner.unwrap_or(StudyOwner::Tab);
        let study = self.anki_handles()?.study;
        let before = study.owner();
        let started = study.start(deck_id, owner).await?;
        if before != Some(owner) {
            self.emit_study_owner(Some(owner), started.preempted);
        }
        Ok(started.next)
    }

    pub async fn anki_show_answer(
        &self,
        card_id: i64,
        typed: Option<String>,
    ) -> Result<AnswerSide, AppError> {
        Ok(self
            .anki_handles()?
            .study
            .show_answer(card_id, typed)
            .await?)
    }

    pub async fn anki_answer(
        &self,
        card_id: i64,
        rating: u8,
        ms: u32,
    ) -> Result<StudyNext, AppError> {
        if !(1..=4).contains(&rating) {
            return Err(AppError::new(
                "invalid_request",
                "Pedido inválido: a resposta vai de 1 a 4.",
            ));
        }
        let next = self
            .anki_handles()?
            .study
            .answer(card_id, rating, ms)
            .await?;
        // Spec 9: sync 60 s after the last answer of a session.
        self.sync_answered();
        Ok(next)
    }

    pub async fn anki_undo(&self) -> Result<StudyNext, AppError> {
        Ok(self.anki_handles()?.study.undo().await?)
    }

    pub async fn anki_card_action(
        &self,
        card_id: i64,
        action: CardAction,
        flag: Option<u8>,
    ) -> Result<CardActionResult, AppError> {
        Ok(self
            .anki_handles()?
            .study
            .card_action(card_id, action, flag)
            .await?)
    }

    /// Closes `owner`'s session (default: the Anki tab) and nothing else: a preempted place leaving never ends the
    /// other's session.
    pub fn anki_study_close(&self, owner: Option<StudyOwner>) -> Result<(), AppError> {
        let owner = owner.unwrap_or(StudyOwner::Tab);
        if self.anki_handles()?.study.close_owner(owner) {
            self.emit_study_owner(None, None);
        }
        Ok(())
    }

    /// "Revisar aqui" (spec 10.1): remembers the current deck, switches to `deck_id` and studies it in the panel,
    /// taking the session from the Anki tab if it had one.
    pub async fn anki_mini_review_open(&self, deck_id: i64) -> Result<MiniReviewOpened, AppError> {
        let study = self.anki_handles()?.study;
        let before = study.owner();
        let opened = study.mini_review_open(deck_id).await?;
        if before != Some(StudyOwner::Panel) {
            self.emit_study_owner(Some(StudyOwner::Panel), opened.preempted);
        }
        Ok(opened)
    }

    /// Closes the mini-review; the previous deck comes back unless the Anki tab took the session over.
    pub async fn anki_mini_review_close(&self) -> Result<MiniReviewClosed, AppError> {
        let study = self.anki_handles()?.study;
        let before = study.owner();
        let closed = study.mini_review_close().await?;
        if before == Some(StudyOwner::Panel) && study.owner().is_none() {
            self.emit_study_owner(None, None);
        }
        Ok(closed)
    }

    /// On exit: an open mini-review is closed first so the deck from before it is current again (best effort; the
    /// collection is never opened just for this).
    pub fn mini_review_close_on_exit(&self) {
        let Some(h) = lock(&self.anki_handles).clone() else {
            return;
        };
        if h.study.owner() != Some(StudyOwner::Panel) {
            return;
        }
        match tauri::async_runtime::block_on(h.study.mini_review_close()) {
            Ok(closed) => tracing::info!(
                restored = closed.restored_deck_id.is_some(),
                "mini-review closed on exit"
            ),
            Err(e) => tracing::warn!(%e, "could not close the mini-review on exit"),
        }
    }

    /// The collection was closed and reopened (full sync, `.colpkg`): forgets the study session and tells the UI
    /// nobody studies any more. `had_owner` is [`Study::owner`] from before the replacement.
    pub(crate) fn study_reset(&self, study: &Study, had_owner: bool) {
        study.reset();
        if had_owner {
            self.emit_study_owner(None, None);
        }
    }

    fn emit_study_owner(&self, owner: Option<StudyOwner>, preempted: Option<StudyOwner>) {
        self.emit(UiEvent::StudyOwner(StudyOwnerChange { owner, preempted }));
    }

    // --- Notes, browse, media --------------------------------------------------------------

    pub async fn anki_notetypes(&self) -> Result<Vec<NotetypeInfo>, AppError> {
        self.on_col(notes::notetypes).await
    }

    pub async fn anki_add_defaults(&self, deck_id: Option<i64>) -> Result<AddDefaults, AppError> {
        self.on_col(move |col| notes::add_defaults(col, deck_id))
            .await
    }

    pub async fn anki_note_get(&self, note_id: i64) -> Result<NoteData, AppError> {
        self.on_col(move |col| notes::get(col, note_id)).await
    }

    pub async fn anki_note_check(
        &self,
        notetype_id: i64,
        fields: Vec<String>,
    ) -> Result<NoteCheck, AppError> {
        self.on_col(move |col| notes::check(col, notetype_id, fields))
            .await
    }

    pub async fn anki_note_add(&self, note: NewNote) -> Result<NoteAdded, AppError> {
        self.on_col(move |col| notes::add(col, note)).await
    }

    pub async fn anki_note_update(
        &self,
        note_id: i64,
        fields: Vec<String>,
        tags: Vec<String>,
    ) -> Result<(), AppError> {
        self.on_col(move |col| notes::update(col, note_id, fields, tags))
            .await
    }

    pub async fn anki_tags_all(&self) -> Result<Vec<String>, AppError> {
        self.on_col(notes::all_tags).await
    }

    /// Adds a pasted/picked image to the media folder; returns its final file name.
    pub async fn anki_media_add(&self, name: String, bytes: Vec<u8>) -> Result<String, AppError> {
        if bytes.len() > media::MAX_MEDIA_BYTES {
            return Err(core_anki::Error::TooLarge.into());
        }
        self.on_col(move |col| media::add(col, &name, &bytes)).await
    }

    pub async fn anki_search(
        &self,
        query: String,
        order: Option<BrowseOrder>,
    ) -> Result<Vec<i64>, AppError> {
        self.on_col(move |col| browse::search(col, &query, order))
            .await
    }

    pub async fn anki_browse_rows(&self, card_ids: Vec<i64>) -> Result<Vec<BrowseRow>, AppError> {
        self.on_col(move |col| browse::rows(col, &card_ids)).await
    }

    pub async fn anki_cards_set_deck(
        &self,
        card_ids: Vec<i64>,
        deck_id: i64,
    ) -> Result<u32, AppError> {
        self.on_col(move |col| browse::set_deck(col, &card_ids, deck_id))
            .await
    }

    pub async fn anki_notes_tags(
        &self,
        note_ids: Vec<i64>,
        add: String,
        remove: String,
    ) -> Result<(), AppError> {
        self.on_col(move |col| browse::tags(col, &note_ids, &add, &remove))
            .await
    }

    pub async fn anki_cards_suspend(
        &self,
        card_ids: Vec<i64>,
        suspended: bool,
    ) -> Result<(), AppError> {
        self.on_col(move |col| browse::suspend(col, &card_ids, suspended))
            .await
    }

    pub async fn anki_cards_forget(
        &self,
        card_ids: Vec<i64>,
        opts: ForgetOptions,
    ) -> Result<(), AppError> {
        self.on_col(move |col| browse::forget(col, &card_ids, opts))
            .await
    }

    pub async fn anki_notes_delete(&self, note_ids: Vec<i64>) -> Result<u32, AppError> {
        self.on_col(move |col| browse::delete_notes(col, &note_ids))
            .await
    }

    /// Before opening the "change notetype" page: the notes' common notetype (error if they
    /// differ), remembered by the bridge for the page's `changeNotetype` call.
    pub async fn anki_change_notetype_prepare(
        &self,
        note_ids: Vec<i64>,
    ) -> Result<ChangeNotetypePrepared, AppError> {
        let h = self.anki_handles()?;
        let ids = note_ids.clone();
        let notetype_id = h
            .svc
            .call(move |col| browse::common_notetype(col, &ids))
            .await?;
        h.bridge.set_change_notetype_notes(note_ids);
        Ok(ChangeNotetypePrepared { notetype_id })
    }

    // --- Import, export, backups -----------------------------------------------------------

    /// Imports an `.apkg` the user picked, opened with the app or dropped (read grant).
    pub async fn anki_import(&self, path: &str) -> Result<ImportSummary, AppError> {
        let path = self.take_package_grant(path, "apkg")?;
        let summary = self
            .on_col(move |col| import_export::import_apkg(col, &path))
            .await?;
        self.emit(UiEvent::AnkiChanged(ChangeReason::Import));
        Ok(summary)
    }

    /// Replaces the whole collection with a `.colpkg` (read grant; the UI confirmed twice). A
    /// pre-import backup is written first and returned.
    pub async fn anki_import_colpkg(&self, path: &str) -> Result<BackupInfo, AppError> {
        let path = self.take_package_grant(path, "colpkg")?;
        let h = self.anki_handles()?;
        let had_owner = h.study.owner().is_some();
        h.study.close();
        let result = h.svc.import_colpkg(&path).await;
        // Whatever happened, the collection was closed and reopened: nothing cached survives.
        self.study_reset(&h.study, had_owner);
        h.bridge.reset();
        let backup = result?;
        tracing::info!(backup = %backup.file_name, "collection replaced by a .colpkg");
        // Disposable now: the next sync downloads over it (never merges or uploads it).
        if let Err(e) = self.sync_collection_replaced() {
            tracing::warn!(code = %e.code, "could not reset the first-sync flag");
        }
        self.emit(UiEvent::AnkiChanged(ChangeReason::Colpkg));
        Ok(backup)
    }

    /// Exports a deck as `.apkg` to a path granted by `export_pick_path` (kind `apkg`).
    pub async fn anki_export(
        &self,
        deck_id: i64,
        path: &str,
        opts: ExportOptions,
    ) -> Result<ExportResult, AppError> {
        let path = PathBuf::from(path);
        if !has_extension(&path, "apkg") {
            return Err(AppError::new(
                "export_not_granted",
                "O pacote do Anki precisa terminar em .apkg.",
            ));
        }
        self.export_grants().take(&path)?;
        self.on_col(move |col| import_export::export_apkg(col, deck_id, &path, opts))
            .await
    }

    pub async fn anki_backup_now(&self) -> Result<BackupInfo, AppError> {
        let h = self.anki_handles()?;
        let info = backup::backup_now(&h.svc, BackupKind::Manual).await?;
        self.emit(UiEvent::AnkiChanged(ChangeReason::Backup));
        Ok(info)
    }

    pub fn anki_backups(&self) -> Result<Vec<BackupInfo>, AppError> {
        let paths = core_anki::CollectionPaths::in_dir(&self.anki_dir());
        Ok(backup::list(&backup::backups_dir(&paths))?)
    }

    /// One tick of the backup ticker: today's daily backup if it is missing (`now` injected by
    /// the tests). Skipped while the app shuts down.
    pub async fn anki_backup_tick(
        &self,
        now: DateTime<Local>,
    ) -> Result<Option<BackupInfo>, AppError> {
        if self.is_shutting_down() {
            return Ok(None);
        }
        let h = self.anki_handles()?;
        let made = backup::daily_if_due(&h.svc, now).await?;
        if let Some(info) = &made {
            tracing::info!(file = %info.file_name, "daily backup written");
            self.emit(UiEvent::AnkiChanged(ChangeReason::Backup));
        }
        Ok(made)
    }

    /// Checks extension + read grant and returns the path.
    fn take_package_grant(&self, path: &str, ext: &str) -> Result<PathBuf, AppError> {
        let path = PathBuf::from(path);
        if !has_extension(&path, ext) {
            tracing::warn!(path = %path.display(), ext, "import with the wrong extension");
            return Err(grants::path_not_allowed());
        }
        self.read_grants().take(&path)?;
        Ok(path)
    }

    /// Runs `f` on the collection actor.
    async fn on_col<R, F>(&self, f: F) -> Result<R, AppError>
    where
        R: Send + 'static,
        F: FnOnce(&mut core_anki::Collection) -> core_anki::Result<R> + Send + 'static,
    {
        Ok(self.anki_handles()?.svc.call(f).await?)
    }
}

fn emit_with(slot: &std::sync::RwLock<Option<UiSink>>, event: UiEvent) {
    let sink = slot
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    match sink {
        Some(sink) => sink(event),
        None => tracing::debug!(?event, "UI event without a sink"),
    }
}

/// Starts the daily backup ticker: first check [`BACKUP_FIRST_DELAY`] after start, then every
/// [`BACKUP_EVERY`]. Failures are logged; the ticker never takes the app down.
pub fn spawn_backup_ticker(state: &Arc<AppState>) {
    let weak: Weak<AppState> = Arc::downgrade(state);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(BACKUP_FIRST_DELAY).await;
        loop {
            let Some(state) = weak.upgrade() else { break };
            if state.is_shutting_down() {
                break;
            }
            let opened = {
                let state = Arc::clone(&state);
                tauri::async_runtime::spawn_blocking(move || state.anki_handles().map(|_| ())).await
            };
            match opened {
                Ok(Ok(())) => {
                    if let Err(e) = state.anki_backup_tick(Local::now()).await {
                        tracing::warn!(code = %e.code, "daily backup failed: {e}");
                    }
                }
                Ok(Err(e)) => tracing::warn!(code = %e.code, "no collection for the backup: {e}"),
                Err(e) => tracing::warn!(%e, "backup task failed"),
            }
            drop(state);
            tokio::time::sleep(BACKUP_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_events_map_to_ui_events() {
        assert_eq!(
            ui_event_for(BridgeEvent::Changed),
            Some(UiEvent::AnkiChanged(ChangeReason::Page))
        );
        assert_eq!(
            ui_event_for(BridgeEvent::Close),
            Some(UiEvent::AnkiPage(BridgeEvent::Close))
        );
        assert_eq!(
            ui_event_for(BridgeEvent::OpenLink {
                url: "https://docs.ankiweb.net".into()
            }),
            Some(UiEvent::OpenUrl("https://docs.ankiweb.net".into()))
        );
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "leitor://livro/x",
        ] {
            assert_eq!(
                ui_event_for(BridgeEvent::OpenLink { url: bad.into() }),
                None
            );
        }
        let json = serde_json::to_value(AnkiChanged {
            reason: ChangeReason::Colpkg,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "reason": "colpkg" }));
        assert_eq!(serde_json::to_value(ChangeReason::Sync).unwrap(), "sync");
        assert_eq!(
            serde_json::to_value(ChangeReason::SyncFull).unwrap(),
            "syncFull"
        );
    }

    #[test]
    fn backup_schedule() {
        assert_eq!(BACKUP_FIRST_DELAY.as_secs(), 120);
        assert_eq!(BACKUP_EVERY.as_secs(), 1800);
    }
}
