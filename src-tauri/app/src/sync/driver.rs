//! The scheduler task: waits for a notification or the next due time of the [`Policy`], then
//! runs the sync the policy chose and records the outcome (settings, keychain, status, events).
//!
//! Every blocking step (store, keychain, collection open) runs on the blocking pool; the sync
//! itself is the core's async `AnkiService::sync`, whose network check never holds the
//! collection. Never touches the smoke collection.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

use core_anki::{Error as CoreError, SyncCredentials, SyncFailure, SyncOutcome, SyncReport};
use core_store::setting_keys as keys;

use super::{AppState, Finished, Reason, SyncErrorInfo, SyncSettings, Trigger, blocking, now_ms};
use crate::anki::{AnkiHandles, ChangeReason, UiEvent};
use crate::error::AppError;
use crate::secrets::sync_account;

/// The task re-checks at least this often (shutdown, clock jumps after suspend).
const IDLE_RECHECK: Duration = Duration::from_secs(60);

/// Starts the scheduler once (app `setup`; commands call it too, so tests need no setup).
pub fn ensure_started(state: &Arc<AppState>) {
    if state.sync.driver_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let weak = Arc::downgrade(state);
    let wake = Arc::clone(&state.sync.wake);
    tauri::async_runtime::spawn(async move {
        if let Some(state) = weak.upgrade() {
            let s = Arc::clone(&state);
            match blocking(move || s.sync_init().map(|_| ())).await {
                Ok(()) => state.with_policy(|p, _| p.notify(Trigger::AppOpened, now_ms())),
                Err(e) => tracing::warn!(code = %e.code, "sync scheduler without settings: {e}"),
            }
        }
        run_loop(weak, wake).await;
        tracing::debug!("sync scheduler stopped");
    });
}

async fn run_loop(weak: Weak<AppState>, wake: Arc<tokio::sync::Notify>) {
    loop {
        let Some(state) = weak.upgrade() else { break };
        if state.is_shutting_down() {
            break;
        }
        let now = now_ms();
        let job = state.with_policy(|p, hub| {
            let reason = p.poll(now)?;
            p.started(now);
            let waiters = if reason.is_user_initiated() {
                std::mem::take(&mut hub.waiters)
            } else {
                Vec::new()
            };
            Some((reason, waiters))
        });
        if let Some((reason, waiters)) = job {
            run_job(&state, reason).await;
            for w in waiters {
                let _ = w.send(());
            }
            continue;
        }
        let next = state.with_policy(|p, _| p.next_wakeup(now));
        drop(state);
        let sleep = next.map_or(IDLE_RECHECK, |t| {
            Duration::from_millis(u64::try_from(t - now).unwrap_or(0)).min(IDLE_RECHECK)
        });
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(sleep) => {}
        }
    }
}

type Prepared = (
    SyncSettings,
    Option<(SyncCredentials, String)>,
    Option<AnkiHandles>,
);

/// One sync: credentials, the core sync, then the outcome recorded and announced.
async fn run_job(state: &Arc<AppState>, reason: Reason) {
    let generation = state.sync.generation();
    tracing::debug!(?reason, "sync starting");
    let s = Arc::clone(state);
    let prepared: Result<Prepared, AppError> = blocking(move || {
        let settings = s.sync_settings()?;
        let creds = s.sync_credentials(&settings)?;
        let handles = match creds {
            Some(_) => Some(s.anki_handles()?),
            None => None,
        };
        let _ = s.emit_sync_status();
        Ok((settings, creds, handles))
    })
    .await;
    let (settings, creds, handles) = match prepared {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(code = %e.code, "could not prepare the sync: {e}");
            state.with_policy(|p, hub| {
                p.finished(Finished::Failed, now_ms());
                hub.last_error = Some(SyncErrorInfo::from(&e));
            });
            emit(state).await;
            return;
        }
    };
    let (Some((creds, account)), Some(handles)) = (creds, handles) else {
        // Logged out (no URL, user or key).
        state.with_policy(|p, _| {
            p.finished(Finished::Failed, now_ms());
            p.set_logged_out();
        });
        emit(state).await;
        return;
    };
    let first_sync = settings.first_done.as_deref() != Some(account.as_str());
    let result = handles.svc.sync(&creds, first_sync).await;
    let s = Arc::clone(state);
    let recorded = blocking(move || {
        if s.sync.generation() != generation {
            // Logged out or into another account meanwhile: the result is stale.
            s.with_policy(|p, _| p.finished(Finished::Failed, now_ms()));
            return Ok(());
        }
        match result {
            Ok(report) => record_success(&s, &settings, &account, &handles, report),
            Err(e) => {
                record_failure(&s, &account, e);
                Ok(())
            }
        }
    })
    .await;
    if let Err(e) = recorded {
        tracing::warn!(code = %e.code, "could not record the sync result: {e}");
        state.with_policy(|p, hub| {
            if p.is_running() {
                p.finished(Finished::Failed, now_ms());
            }
            hub.last_error = Some(SyncErrorInfo::from(&e));
        });
    }
    emit(state).await;
}

fn record_success(
    state: &AppState,
    settings: &SyncSettings,
    account: &str,
    handles: &AnkiHandles,
    report: SyncReport,
) -> Result<(), AppError> {
    let mut account = account.to_owned();
    if let Some(next) = &report.new_endpoint
        && let Some(user) = settings.user.as_deref()
    {
        // The server moved (same scheme and host, checked by the core): follow it.
        let moved = sync_account(user, next.as_str());
        if moved != account {
            if let Some(hkey) = state.sync.secrets.get(&account)? {
                state.sync.secrets.set(&moved, &hkey)?;
                state.sync.secrets.delete(&account)?;
            }
            state.set_text_setting(keys::ANKI_SYNC_URL, Some(next.as_str()))?;
            if settings.first_done.as_deref() == Some(account.as_str()) {
                state.set_text_setting(keys::ANKI_SYNC_FIRST_DONE, Some(&moved))?;
            }
            tracing::info!(endpoint = %next, "sync server moved");
            account = moved;
        }
    }
    let now = now_ms();
    let changed = match &report.outcome {
        SyncOutcome::FullSyncRequired(choice) => {
            let choice = *choice;
            tracing::info!(?choice, "full sync required: waiting for the user");
            state.with_policy(|p, hub| {
                p.finished(Finished::FullSyncRequired, now);
                hub.full_sync = Some(choice);
                hub.last_error = None;
                hub.last_failure = None;
                hub.server_message = report.server_message.clone();
            });
            None
        }
        outcome => {
            state.with_store(|s| s.set_setting(keys::ANKI_SYNC_LAST_AT, now.into()))?;
            state.set_text_setting(keys::ANKI_SYNC_FIRST_DONE, Some(&account))?;
            state.with_policy(|p, hub| {
                p.finished(Finished::Success, now);
                hub.full_sync = None;
                hub.last_error = None;
                hub.last_failure = None;
                hub.server_message = report.server_message.clone();
                hub.media_error = report.media_error.as_ref().map(|(_, m)| m.clone());
            });
            match outcome {
                SyncOutcome::FullDownloaded { backup } | SyncOutcome::FullUploaded { backup } => {
                    tracing::info!(backup = %backup.file_name, "collection replaced by a full sync");
                    Some(ChangeReason::SyncFull)
                }
                SyncOutcome::Normal => Some(ChangeReason::Sync),
                _ => report.collection_changed.then_some(ChangeReason::Sync),
            }
        }
    };
    if let Some(reason) = changed {
        if reason == ChangeReason::SyncFull {
            // The collection was closed and reopened: the study session is gone.
            handles.study.reset();
            handles.bridge.reset();
        }
        state.emit(UiEvent::AnkiChanged(reason));
    }
    Ok(())
}

fn record_failure(state: &AppState, account: &str, err: CoreError) {
    let kind = match &err {
        CoreError::Sync { kind, .. } => Some(*kind),
        _ => None,
    };
    let app_err = AppError::from(err);
    let now = now_ms();
    let outcome = match kind {
        Some(SyncFailure::AuthFailed) => {
            if let Err(e) = state.sync.secrets.delete(account) {
                tracing::warn!(code = %e.code, "could not delete the refused sync key");
            }
            Finished::AuthFailed
        }
        Some(k) if k.is_transient() => Finished::Transient,
        _ => Finished::Failed,
    };
    // An aborted or concurrent sync is not an error the user must see.
    let silent = matches!(kind, Some(SyncFailure::Aborted | SyncFailure::Busy));
    tracing::info!(code = %app_err.code, ?outcome, "sync failed");
    state.with_policy(|p, hub| {
        p.finished(outcome, now);
        if !silent {
            hub.last_error = Some(SyncErrorInfo::from(&app_err));
            hub.last_failure = kind;
        }
    });
}

async fn emit(state: &Arc<AppState>) {
    let s = Arc::clone(state);
    if let Err(e) = blocking(move || s.emit_sync_status()).await {
        tracing::warn!(code = %e.code, "could not send the sync status: {e}");
    }
}
