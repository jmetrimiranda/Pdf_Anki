//! Library sync between devices (spec 16, docs/planos/fase-9a.md): books, reading positions, EPUB annotations,
//! "Já sei"/"Nome próprio", notetype roles and code-note extras through `server/library-sync`, with the book files
//! sent in parts and fetched in ranges. The Anki collection keeps its own sync (spec 9).
//!
//! One run: (1) files changed on this device go up first (a 409 → conflict copy); (2) every change of the server is
//! pulled and applied (newer `updated_at` wins; the first sync of a device always takes the server's version);
//! (3) the local changes go up. Runs at start, when a book closes, every 5 minutes and on "Sincronizar agora".
//! Offline: it waits; local changes stay in the database until the next run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use core_libsync::{LibError, LibraryClient, PushResult, RemoteFile, Uploaded, WireRecord};
use core_store::{
    Book, BookFormat, SYNC_KINDS, SyncApplied, SyncRecord, SyncedFile, setting_keys as keys,
};
use serde::Serialize;

use crate::anki::UiEvent;
use crate::error::AppError;
use crate::files::BookFiles;
use crate::state::{AppState, lock};

/// `library://sync` with the new [`LibrarySyncStatus`].
pub const LIBRARY_SYNC_EVENT: &str = "library://sync";
const CURSOR: &str = "library.cursor";
/// The server database's identity the cursor belongs to.
const EPOCH: &str = "library.epoch";
const FIRST_DONE: &str = "library.first_done";
const EVERY: Duration = Duration::from_secs(5 * 60);
const PUSH_BATCH: usize = 500;

impl From<LibError> for AppError {
    fn from(e: LibError) -> Self {
        AppError::new(e.code(), e.to_string())
    }
}

/// What a run is doing (the progress line).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySyncProgress {
    /// `files` (sending books), `pull`, `push` or `download`.
    pub stage: &'static str,
    pub done: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LibrarySyncError {
    pub code: String,
    pub message: String,
}

/// Configurações → Sincronização and the status line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySyncStatus {
    pub url: Option<String>,
    pub user: Option<String>,
    /// This device's name on the server.
    pub device: String,
    pub logged_in: bool,
    pub running: bool,
    /// Epoch ms of the last complete run.
    pub last_sync_at: Option<i64>,
    pub last_error: Option<LibrarySyncError>,
    pub progress: Option<LibrarySyncProgress>,
    /// Conflict copies made by the last run (titles).
    pub conflicts: Vec<String>,
}

#[derive(Default)]
struct HubState {
    last_error: Option<LibrarySyncError>,
    progress: Option<LibrarySyncProgress>,
    conflicts: Vec<String>,
}

/// The library sync's state in [`AppState`].
#[derive(Default)]
pub struct LibrarySyncHub {
    running: AtomicBool,
    /// Books being downloaded (one download per book at a time).
    downloading: Mutex<std::collections::HashSet<String>>,
    /// (book, base version of an open tab) → the conflict copy its saves go to (see `library_stale_save`).
    stale_copies: Mutex<std::collections::HashMap<(String, u32), String>>,
    started: AtomicBool,
    state: Mutex<HubState>,
    wake: Mutex<bool>,
    cv: Condvar,
}

/// The run slot (see `library_sync_slot`): released on drop, even on an early return or a panic.
struct RunSlot<'a>(&'a AtomicBool);

impl Drop for RunSlot<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Keychain account of the device token for the server at `url`.
pub fn library_account(url: &str) -> String {
    format!("library-sync:{url}")
}

/// This computer's name, the default device name.
fn default_device() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "Linux".into())
}

fn not_logged_in() -> AppError {
    AppError::new(
        "library_not_logged_in",
        "Conecte este aparelho ao servidor da biblioteca em Configurações → Anki e sincronização.",
    )
}

fn busy() -> AppError {
    AppError::new("library_sync_busy", "A biblioteca já está sincronizando.")
}

fn to_wire(r: SyncRecord) -> WireRecord {
    WireRecord {
        kind: r.kind,
        key: r.key,
        updated_at: r.updated_at,
        deleted: r.deleted,
        data: r.data,
        seq: 0,
    }
}

fn from_wire(r: WireRecord) -> SyncRecord {
    SyncRecord {
        kind: r.kind,
        key: r.key,
        updated_at: r.updated_at,
        deleted: r.deleted,
        data: r.data,
    }
}

fn synced(f: &RemoteFile) -> SyncedFile {
    SyncedFile {
        hash: f.hash.clone(),
        version: f.version,
    }
}

/// The book a record belongs to (its own key for books and positions).
fn book_of(r: &SyncRecord) -> Option<&str> {
    match r.kind.as_str() {
        "book" | "reading_position" => Some(&r.key),
        "epub_annotation" => r.data.get("bookUid").and_then(|v| v.as_str()),
        _ => None,
    }
}

/// What one run did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LibrarySyncReport {
    pub uploaded: u32,
    pub pulled: u32,
    pub pushed: u32,
    pub conflicts: Vec<String>,
}

impl AppState {
    fn library_text_setting(&self, key: &str) -> Result<Option<String>, AppError> {
        self.with_store(|s| s.setting_as::<Option<String>>(key))
    }

    /// The configured server and this device's client with its token, or `None` (not logged in).
    fn library_client(&self) -> Result<Option<(LibraryClient, String)>, AppError> {
        let Some(url) = self.library_text_setting(keys::LIBRARY_SYNC_URL)? else {
            return Ok(None);
        };
        let Some(token) = self.sync.secrets.get(&library_account(&url))? else {
            return Ok(None);
        };
        Ok(Some((LibraryClient::new(&url)?.with_token(token), url)))
    }

    pub fn library_sync_status(&self) -> Result<LibrarySyncStatus, AppError> {
        let url = self.library_text_setting(keys::LIBRARY_SYNC_URL)?;
        let logged_in = match &url {
            Some(u) => self
                .sync
                .secrets
                .get(&library_account(u))
                .ok()
                .flatten()
                .is_some(),
            None => false,
        };
        let hub = lock(&self.library_sync.state);
        Ok(LibrarySyncStatus {
            user: self.library_text_setting(keys::LIBRARY_SYNC_USER)?,
            device: self
                .library_text_setting(keys::LIBRARY_SYNC_DEVICE)?
                .unwrap_or_else(default_device),
            url,
            logged_in,
            running: self.library_sync.running.load(Ordering::SeqCst),
            last_sync_at: self.with_store(|s| s.setting_as(keys::LIBRARY_SYNC_LAST_AT))?,
            last_error: hub.last_error.clone(),
            progress: hub.progress.clone(),
            conflicts: hub.conflicts.clone(),
        })
    }

    fn emit_library_sync(&self) {
        match self.library_sync_status() {
            Ok(s) => self.emit(UiEvent::LibrarySync(s)),
            Err(e) => tracing::debug!(code = %e.code, "library sync status unavailable"),
        }
    }

    fn library_progress(&self, stage: &'static str, done: u64, total: u64) {
        lock(&self.library_sync.state).progress = Some(LibrarySyncProgress { stage, done, total });
        self.emit_library_sync();
    }

    /// "Conectar": the library user and password give this device a token (kept in the keychain, never shown).
    /// Another server than before starts over as a first sync (download only).
    pub async fn library_sync_login(
        self: &Arc<Self>,
        url: &str,
        user: &str,
        password: &str,
        device: &str,
    ) -> Result<LibrarySyncStatus, AppError> {
        // The run slot is held for the whole login: no run can start against the old server meanwhile.
        let slot = self.library_sync_slot()?;
        let url = core_libsync::normalize_url(url)?;
        let user = user.trim();
        let device = match device.trim() {
            "" => default_device(),
            d => d.to_owned(),
        };
        if user.is_empty() || password.is_empty() {
            return Err(AppError::new(
                "invalid_input",
                "Informe o usuário e a senha da biblioteca.",
            ));
        }
        let token = LibraryClient::new(&url)?
            .login(user, password, &device)
            .await?;
        let previous = self.library_text_setting(keys::LIBRARY_SYNC_URL)?;
        if let Some(prev) = previous.as_deref().filter(|p| *p != url) {
            self.sync.secrets.delete(&library_account(prev))?;
            self.with_store(|s| s.sync_forget())?;
        }
        self.sync.secrets.set(&library_account(&url), &token)?;
        self.with_store(|s| {
            s.set_setting(keys::LIBRARY_SYNC_URL, url.clone().into())?;
            s.set_setting(keys::LIBRARY_SYNC_USER, user.into())?;
            s.set_setting(keys::LIBRARY_SYNC_DEVICE, device.clone().into())
        })?;
        lock(&self.library_sync.state).last_error = None;
        tracing::info!(%url, "library sync: device connected");
        // The slot is free again before the first run is asked for.
        drop(slot);
        self.library_sync_kick();
        self.library_sync_status()
    }

    /// "Desconectar": revokes this device's token on the server (when reachable) and forgets it here.
    pub async fn library_sync_logout(self: &Arc<Self>) -> Result<LibrarySyncStatus, AppError> {
        let _slot = self.library_sync_slot()?;
        if let Some((client, url)) = self.library_client()? {
            if let Err(e) = client.logout().await {
                tracing::info!(
                    code = e.code(),
                    "library logout: server not reached, token forgotten here"
                );
            }
            self.sync.secrets.delete(&library_account(&url))?;
        }
        self.library_sync_status()
    }

    /// Wakes the scheduler (a book closed, "Sincronizar agora" from elsewhere).
    pub(crate) fn library_sync_kick(&self) {
        *lock(&self.library_sync.wake) = true;
        self.library_sync.cv.notify_all();
    }

    /// The scheduler: a run at start, then every 5 minutes or when kicked, while logged in.
    pub fn library_sync_start(self: &Arc<Self>) {
        if self.library_sync.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let state = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("library-sync".into())
            .spawn(move || {
                while !state.is_shutting_down() {
                    if matches!(state.library_client(), Ok(Some(_))) {
                        let _ = tauri::async_runtime::block_on(state.library_sync_now());
                    }
                    let hub = &state.library_sync;
                    let mut woken = lock(&hub.wake);
                    if !*woken {
                        woken = hub
                            .cv
                            .wait_timeout(woken, EVERY)
                            .map(|(g, _)| g)
                            .unwrap_or_else(|p| p.into_inner().0);
                    }
                    *woken = false;
                }
            });
        if let Err(e) = spawned {
            tracing::warn!(%e, "could not start the library sync");
        }
    }

    /// Takes the one slot of runs, logins and logouts (released when dropped).
    fn library_sync_slot(&self) -> Result<RunSlot<'_>, AppError> {
        if self.library_sync.running.swap(true, Ordering::SeqCst) {
            return Err(busy());
        }
        Ok(RunSlot(&self.library_sync.running))
    }

    /// One run now ("Sincronizar agora"); its error is also kept in the status.
    pub async fn library_sync_now(self: &Arc<Self>) -> Result<LibrarySyncStatus, AppError> {
        let slot = self.library_sync_slot()?;
        self.emit_library_sync();
        let result = self.library_sync_run().await;
        {
            let mut hub = lock(&self.library_sync.state);
            hub.progress = None;
            match &result {
                Ok(report) => {
                    hub.last_error = None;
                    // Kept until the user dismisses them (the follow-up run must not erase the notice).
                    hub.conflicts.extend(report.conflicts.iter().cloned());
                }
                Err(e) => {
                    hub.last_error = Some(LibrarySyncError {
                        code: e.code.clone(),
                        message: e.message.clone(),
                    })
                }
            }
        }
        drop(slot);
        self.emit_library_sync();
        match result {
            Ok(report) => {
                // A conflict copy is a new book: it goes up on the next run.
                if !report.conflicts.is_empty() {
                    self.library_sync_kick();
                }
                self.library_sync_status()
            }
            Err(e) => Err(e),
        }
    }

    /// The user read the conflict notice.
    pub fn library_sync_clear_conflicts(&self) -> Result<LibrarySyncStatus, AppError> {
        lock(&self.library_sync.state).conflicts.clear();
        self.emit_library_sync();
        self.library_sync_status()
    }

    /// One complete run (see the module doc).
    pub async fn library_sync_run(self: &Arc<Self>) -> Result<LibrarySyncReport, AppError> {
        let (client, url) = self.library_client()?.ok_or_else(not_logged_in)?;
        let first = self
            .with_store(|s| s.sync_state_get(FIRST_DONE))?
            .as_deref()
            != Some(url.as_str());
        let mut report = LibrarySyncReport::default();

        // (1) Files changed here go up first, so the server can tell about a conflict.
        let books = self.with_store(|s| s.list_books())?;
        let device = self.library_sync_status()?.device;
        for book in books {
            if let Some(title) = self
                .library_upload_book(&client, &book, &device, &mut report)
                .await?
            {
                report.conflicts.push(title);
            }
        }

        // (2) Everything new on the server, applied books first. A cursor from another database (a new or
        // restored server) starts over from 0, with the normal rules.
        let (stored_cursor, stored_epoch) = self.with_store(|s| {
            Ok((
                s.sync_state_get(CURSOR)?
                    .and_then(|c| c.parse::<i64>().ok()),
                s.sync_state_get(EPOCH)?.and_then(|e| e.parse::<i64>().ok()),
            ))
        })?;
        let mut cursor = if first { 0 } else { stored_cursor.unwrap_or(0) };
        let mut incoming: Vec<SyncRecord> = Vec::new();
        let mut epoch = None;
        // A new or restored server database: what this device exchanged before may be missing there, so the
        // exchanged state is forgotten and everything is compared (and sent) again, with the normal rules.
        let mut reset = false;
        loop {
            let page = match client.changes(cursor).await {
                Err(LibError::CursorAhead) if cursor > 0 => {
                    tracing::warn!(
                        "library sync: the server is behind this device's cursor; starting over"
                    );
                    (cursor, reset) = (0, true);
                    incoming.clear();
                    continue;
                }
                other => other?,
            };
            if cursor > 0 && epoch.is_none() && stored_epoch.is_some_and(|e| e != page.epoch) {
                tracing::warn!("library sync: another server database; starting over");
                (cursor, reset) = (0, true);
                incoming.clear();
                epoch = Some(page.epoch);
                continue;
            }
            epoch = Some(page.epoch);
            incoming.extend(page.records.into_iter().map(from_wire));
            cursor = page.cursor;
            self.library_progress("pull", incoming.len() as u64, incoming.len() as u64);
            if !page.more {
                break;
            }
        }
        if reset {
            self.with_store(|s| s.sync_forget_exchanged())?;
        }
        incoming.sort_by_key(|r| {
            SYNC_KINDS
                .iter()
                .position(|k| *k == r.kind)
                .unwrap_or(SYNC_KINDS.len())
        });
        let mut removed = Vec::new();
        for rec in &incoming {
            let applied = self.with_store(|s| s.sync_apply(rec, first))?;
            if applied == SyncApplied::Applied {
                report.pulled += 1;
                if rec.kind == "book" && rec.deleted {
                    removed.push(rec.key.clone());
                }
            }
        }
        for uid in removed {
            let _guard = self.library_guard();
            self.invalidate_docs(&uid);
            self.files().remove_book(&uid);
            let _ = self.with_store(|s| s.set_book_file(&uid, None, None));
        }

        // (2b) Which file each book is at on the server (the file never follows the book record's clock): a book
        // changed on another PC now points at that version, and this device's copy becomes "Baixar".
        let remote = client.files().await?;
        self.library_adopt_server_files(&remote)?;
        if reset {
            // Files the server lost go up again (from base "", conflicts handled as usual).
            for book in self.with_store(|s| s.list_books())? {
                if let Some(title) = self
                    .library_upload_book(&client, &book, &device, &mut report)
                    .await?
                {
                    report.conflicts.push(title);
                }
            }
        }
        self.with_store(|s| {
            s.sync_state_set(CURSOR, &cursor.to_string())?;
            if let Some(e) = epoch {
                s.sync_state_set(EPOCH, &e.to_string())?;
            }
            // The first pull is done: from now on the normal rules apply, even if the push below fails.
            s.sync_state_set(FIRST_DONE, &url)
        })?;

        // (3) Local changes. A book whose current version was made here and isn't on the server yet waits, with
        // its position and annotations (another PC must never see a file it can't download).
        let outgoing = self.with_store(|s| s.sync_outgoing())?;
        let held: std::collections::HashSet<String> = self.with_store(|s| {
            let mut held = std::collections::HashSet::new();
            for b in s.list_books()? {
                let made_here = b.local_hash.as_deref() == Some(b.file_hash.as_str());
                let confirmed = s
                    .sync_file(&b.book_uid)?
                    .is_some_and(|f| f.hash == b.file_hash);
                if made_here && !confirmed {
                    held.insert(b.book_uid);
                }
            }
            Ok(held)
        })?;
        let outgoing: Vec<SyncRecord> = outgoing
            .into_iter()
            .filter(|r| !book_of(r).is_some_and(|b| held.contains(b)))
            .collect();
        let total = outgoing.len() as u64;
        for (n, batch) in outgoing.chunks(PUSH_BATCH).enumerate() {
            let wire: Vec<WireRecord> = batch.iter().cloned().map(to_wire).collect();
            let results = client.push(&wire).await?;
            for (sent, result) in batch.iter().zip(results) {
                match result {
                    PushResult::Accepted { .. } => {
                        self.with_store(|s| {
                            s.sync_mark_seen(&sent.kind, &sent.key, sent.updated_at)
                        })?;
                        report.pushed += 1;
                    }
                    PushResult::Stale { current } => {
                        self.with_store(|s| s.sync_apply(&from_wire(current), false))?;
                        report.pulled += 1;
                    }
                }
            }
            self.library_progress(
                "push",
                ((n + 1) * PUSH_BATCH).min(total as usize) as u64,
                total,
            );
        }
        let now = core_store::now_ms();
        self.with_store(|s| s.set_setting(keys::LIBRARY_SYNC_LAST_AT, now.into()))?;
        tracing::info!(
            uploaded = report.uploaded,
            pulled = report.pulled,
            pushed = report.pushed,
            conflicts = report.conflicts.len(),
            first,
            "library sync done"
        );
        Ok(report)
    }

    /// Points each book at the server's current file, unless this device has a newer version of its own still to
    /// send (it goes up on the next run, from the confirmed base). Under the library lock, as a compare-and-set:
    /// a save made meanwhile always wins.
    fn library_adopt_server_files(&self, remote: &[RemoteFile]) -> Result<(), AppError> {
        let _guard = self.library_guard();
        self.with_store(|s| {
            for f in remote {
                let Some(book) = s.get_book(&f.book_uid)? else {
                    continue;
                };
                let confirmed = s.sync_file(&book.book_uid)?;
                if book.file_hash == f.hash {
                    s.sync_set_file(&book.book_uid, &synced(f))?;
                    continue;
                }
                let made_here = book.local_hash.as_deref() == Some(book.file_hash.as_str());
                let unsent =
                    made_here && confirmed.as_ref().is_none_or(|c| c.hash != book.file_hash);
                if unsent && book.file_hash != book.book_uid {
                    continue;
                }
                s.sync_adopt_file(&book.book_uid, &book.file_hash, &f.hash, f.version)?;
                s.sync_set_file(&book.book_uid, &synced(f))?;
            }
            Ok(())
        })
    }

    /// Sends this device's current file of `book` when the server doesn't have it. On a conflict (409), the
    /// server's version becomes the book's and this one a new book; returns that book's title.
    async fn library_upload_book(
        self: &Arc<Self>,
        client: &LibraryClient,
        book: &Book,
        device: &str,
        report: &mut LibrarySyncReport,
    ) -> Result<Option<String>, AppError> {
        let uid = book.book_uid.as_str();
        // Only the current version of this device (an outdated copy waits for "Baixar").
        let Some(local) = book.local_hash.as_deref().filter(|h| *h == book.file_hash) else {
            return Ok(None);
        };
        let Ok(path) = self.current_file(book) else {
            return Ok(None);
        };
        let confirmed = self.with_store(|s| s.sync_file(uid))?;
        if confirmed.as_ref().is_some_and(|f| f.hash == local) {
            return Ok(None);
        }
        let base = confirmed.map(|f| f.hash).unwrap_or_default();
        // The same file, or the untouched original on a new device: take the server's (step 2b points the book
        // at it).
        if base.is_empty()
            && let Some(info) = client.file_info(uid).await?
            && (info.hash == local || local == uid)
        {
            if info.hash == local {
                self.with_store(|s| s.sync_set_file(uid, &synced(&info)))?;
            }
            return Ok(None);
        }
        let total = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        self.library_progress("files", 0, total);
        let this = Arc::clone(self);
        let up = client
            .upload(uid, &base, &path, move |done, total| {
                this.library_progress("files", done, total)
            })
            .await?;
        match up {
            Uploaded::Done(f) => {
                // The book already points at this file (a save made meanwhile goes up on the next run).
                self.with_store(|s| s.sync_set_file(uid, &synced(&f)))?;
                report.uploaded += 1;
                Ok(None)
            }
            Uploaded::Conflict(current) => {
                let title = self.library_conflict_copy(book, &path, device)?;
                let _guard = self.library_guard();
                self.with_store(|s| {
                    // A save made during the upload wins: then nothing is confirmed, and that newer version gets its
                    // own 409 (and copy) on the next run instead of overwriting the other device's version.
                    if s.sync_adopt_file(uid, local, &current.hash, current.version)? {
                        s.sync_set_file(uid, &synced(&current))?;
                    }
                    Ok(())
                })?;
                tracing::info!(book_uid = uid, "library sync: file conflict, copy kept");
                Ok(Some(title))
            }
        }
    }

    /// Keeps this device's version of a book that changed elsewhere as a new book "<título> (cópia de conflito,
    /// <aparelho>, <data>)" (spec 16). Returns its title.
    fn library_conflict_copy(
        &self,
        book: &Book,
        path: &std::path::Path,
        device: &str,
    ) -> Result<String, AppError> {
        let bytes = std::fs::read(path)
            .map_err(|e| AppError::read_file(&path.display().to_string(), &e))?;
        let _guard = self.library_guard();
        Ok(self.library_conflict_copy_locked(book, bytes, device)?.0)
    }

    /// [`library_conflict_copy`](Self::library_conflict_copy) from bytes, under the library lock (held by the
    /// caller). Returns the copy's title and uid.
    fn library_conflict_copy_locked(
        &self,
        book: &Book,
        bytes: Vec<u8>,
        device: &str,
    ) -> Result<(String, String), AppError> {
        let uid = core_store::book_uid_of(&bytes);
        let date = chrono::Local::now().format("%d/%m/%Y");
        let title = format!("{} (cópia de conflito, {device}, {date})", book.title);
        // A PDF carries the original's LeitorBookUid: the copy gets its own, or saving it would be refused and
        // re-adding an export would land in the original book.
        let bytes = match book.format {
            BookFormat::Pdf => core_pdf::stamp_info(&bytes, core_pdf::LEITOR_BOOK_UID_KEY, &uid)
                .unwrap_or_else(|e| {
                    tracing::warn!(error = ?e, "conflict copy kept without its own stamp");
                    bytes
                }),
            BookFormat::Epub => bytes,
        };
        let file_hash = core_store::book_uid_of(&bytes);
        if self.with_store(|s| s.get_book(&uid))?.is_some() {
            return Ok((title, uid));
        }
        let rel = match book.format {
            BookFormat::Pdf => self.files().write_version(&uid, 1, &file_hash, &bytes)?,
            BookFormat::Epub => self.files().write_epub(&uid, 1, &file_hash, &bytes)?,
        };
        let new = core_store::NewBook {
            book_uid: uid.clone(),
            title: title.clone(),
            author: book.author.clone(),
            language: Some(book.language.clone()),
            format: book.format,
            file_name: book.file_name.clone(),
            pages: book.pages,
            has_text: book.has_text,
            file_hash,
            local_path: Some(rel.clone()),
        };
        self.with_store(|s| s.add_book(&new))
            .inspect_err(|_| self.remove_rel(&rel))?;
        Ok((title, uid))
    }

    /// A PdfCraft save from a tab opened before the book moved to another PC's version (adopted from the server,
    /// not on this device): making it current would overwrite that version on the server. It goes to a conflict
    /// copy instead — the first save of that tab creates it, the next ones are new versions of the copy. Called
    /// under the library lock by `save_version_locked`. Returns the copy's title when it was just created.
    /// The tab of `uid` opened at `base` already saves into a conflict copy.
    pub(crate) fn library_has_stale_copy(&self, uid: &str, base: u32) -> bool {
        lock(&self.library_sync.stale_copies).contains_key(&(uid.to_owned(), base))
    }

    pub(crate) fn library_stale_save(
        &self,
        book: &Book,
        base_version: u32,
        bytes: Vec<u8>,
    ) -> Result<Option<String>, AppError> {
        let key = (book.book_uid.clone(), base_version);
        let existing = lock(&self.library_sync.stale_copies).get(&key).cloned();
        if let Some(copy_uid) = existing
            && let Some(copy) = self.with_store(|s| s.get_book(&copy_uid))?
        {
            let bytes = core_pdf::stamp_info(&bytes, core_pdf::LEITOR_BOOK_UID_KEY, &copy_uid)
                .unwrap_or(bytes);
            self.save_version_unchecked(&copy, bytes)?;
            return Ok(None);
        }
        let device = self.library_sync_status()?.device;
        let (title, copy_uid) = self.library_conflict_copy_locked(book, bytes, &device)?;
        lock(&self.library_sync.stale_copies).insert(key, copy_uid);
        lock(&self.library_sync.state).conflicts.push(title.clone());
        self.emit_library_sync();
        tracing::info!(book_uid = %book.book_uid, "save of an outdated tab kept as a conflict copy");
        Ok(Some(title))
    }

    /// "Baixar": the server's current file of a book, in ranges, becomes this device's copy.
    pub async fn library_download(
        self: &Arc<Self>,
        uid: &str,
    ) -> Result<core_store::LibraryEntry, AppError> {
        let (client, _) = self.library_client()?.ok_or_else(not_logged_in)?;
        if !lock(&self.library_sync.downloading).insert(uid.to_owned()) {
            return Err(AppError::new(
                "library_download_busy",
                "Este livro já está sendo baixado.",
            ));
        }
        let result = self.library_download_inner(&client, uid).await;
        lock(&self.library_sync.downloading).remove(uid);
        lock(&self.library_sync.state).progress = None;
        self.emit_library_sync();
        result
    }

    async fn library_download_inner(
        self: &Arc<Self>,
        client: &LibraryClient,
        uid: &str,
    ) -> Result<core_store::LibraryEntry, AppError> {
        let book = self
            .with_store(|s| s.get_book(uid))?
            .ok_or_else(|| AppError::new("book_not_found", "Livro não encontrado."))?;
        let dir = self.files().book_dir(uid);
        std::fs::create_dir_all(&dir).map_err(|e| crate::files::write_error(&dir, &e))?;
        let tmp = dir.join(format!(".download-{}", uuid::Uuid::new_v4()));
        let this = Arc::clone(self);
        let info = client
            .download(uid, &tmp, move |done, total| {
                this.library_progress("download", done, total)
            })
            .await
            .inspect_err(|_| {
                let _ = std::fs::remove_file(&tmp);
            })?;
        let rel = match book.format {
            BookFormat::Pdf => BookFiles::version_rel_path(uid, info.version, &info.hash),
            BookFormat::Epub => BookFiles::epub_rel_path(uid, info.version, &info.hash),
        };
        let target = self
            .files()
            .resolve(&rel)
            .ok_or_else(|| AppError::internal("download path"))?;
        // Under the library lock: the book must still be at the version this download replaces (a local save
        // made meanwhile wins; the download is dropped).
        let guard = self.library_guard();
        let installed = self.with_store(|s| {
            s.sync_adopt_file(uid, &book.file_hash, &info.hash, info.version)?;
            Ok(s.get_book(uid)?.is_some_and(|b| b.file_hash == info.hash))
        })?;
        if !installed {
            let _ = std::fs::remove_file(&tmp);
            return Err(AppError::new(
                "library_download_stale",
                "O livro mudou neste aparelho durante o download; ele vai para o servidor na próxima sincronização.",
            ));
        }
        std::fs::rename(&tmp, &target).map_err(|e| crate::files::write_error(&target, &e))?;
        let version = self.with_store(|s| {
            s.set_book_file(uid, Some(&rel), Some(&info.hash))?;
            s.sync_set_file(uid, &synced(&info))?;
            Ok(s.get_book(uid)?.map_or(info.version, |b| b.file_version))
        })?;
        self.invalidate_docs(uid);
        self.files().prune(uid, &[&rel], version);
        drop(guard);
        tracing::info!(
            book_uid = uid,
            version = info.version,
            "library sync: book downloaded"
        );
        self.library_entry(uid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_and_records() {
        assert_eq!(
            library_account("https://x.com"),
            "library-sync:https://x.com"
        );
        let r = SyncRecord {
            kind: "epub_annotation".into(),
            key: "u".into(),
            updated_at: 1,
            deleted: false,
            data: serde_json::json!({"bookUid": "b"}),
        };
        assert_eq!(book_of(&r), Some("b"));
        assert_eq!(from_wire(to_wire(r.clone())), r);
    }
}
