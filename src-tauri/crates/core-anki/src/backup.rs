//! `.colpkg` backups with media (docs/PROJETO.md 8.1): one per day (newest [`KEEP_DAILY`] kept),
//! one before every `.colpkg` import / full sync (newest [`KEEP_PRE_IMPORT`] kept) and manual ones
//! (never deleted automatically).
//!
//! Files live in `<collection dir>/backups/`:
//! `diario-YYYY-MM-DD.colpkg`, `antes-de-importar-YYYYMMDD-HHMMSS.colpkg`,
//! `manual-YYYYMMDD-HHMMSS.colpkg` (a `-N` suffix is added if the name is taken). A backup is
//! written to `<name>.partial` and renamed when complete, so a final name is never a half file.
//!
//! The actor is held only for a `VACUUM INTO` copy of the database (the collection stays open);
//! the `.colpkg` (database + media) is compressed from that copy on another thread, so answering
//! cards and the `/_anki` bridge keep working while a large media folder is being archived.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use anki::collection::CollectionBuilder;
use anki::prelude::I18n;

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};

use crate::error::{Error, Result};
use crate::service::{AnkiService, CollectionPaths};
use crate::types::{BackupInfo, BackupKind};

pub const KEEP_DAILY: usize = 7;
pub const KEEP_PRE_IMPORT: usize = 5;

const EXT: &str = ".colpkg";
const PARTIAL: &str = ".partial";
const DAILY_PREFIX: &str = "diario-";
const PRE_IMPORT_PREFIX: &str = "antes-de-importar-";
const MANUAL_PREFIX: &str = "manual-";

pub fn backups_dir(paths: &CollectionPaths) -> PathBuf {
    paths.dir().join("backups")
}

/// Writes a backup of the whole collection with media now.
pub async fn backup_now(svc: &AnkiService, kind: BackupKind) -> Result<BackupInfo> {
    backup_at(svc, kind, Local::now()).await
}

/// Writes today's daily backup if `diario-<local date of now>` does not exist yet.
pub async fn daily_if_due(svc: &AnkiService, now: DateTime<Local>) -> Result<Option<BackupInfo>> {
    let dir = backups_dir(svc.paths());
    if dir.join(daily_name(now.date_naive())).is_file() {
        return Ok(None);
    }
    backup_at(svc, BackupKind::Daily, now).await.map(Some)
}

async fn backup_at(
    svc: &AnkiService,
    kind: BackupKind,
    now: DateTime<Local>,
) -> Result<BackupInfo> {
    // One backup at a time, so two backups never pick the same free name.
    let _guard = BACKUP_LOCK.lock().await;
    let dir = backups_dir(svc.paths());
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    remove_leftovers(&dir);
    let final_path = free_name(&dir, kind, now);
    let partial = PathBuf::from(format!("{}{PARTIAL}", final_path.display()));
    let snapshot = Snapshot(dir.join(format!(
        "{SNAPSHOT_PREFIX}{}.anki2",
        uuid::Uuid::new_v4().simple()
    )));

    // The only part that holds the actor: copying the database file. Compressing
    // the database and the (possibly large) media folder happens on a separate thread, so
    // studying never waits for it.
    svc.snapshot_collection(snapshot.0.clone()).await?;
    let written = write_colpkg(
        snapshot.0.clone(),
        svc.paths().media_folder.clone(),
        partial.clone(),
    )
    .await;
    drop(snapshot);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    std::fs::rename(&partial, &final_path).map_err(|e| Error::io(&final_path, e))?;
    if let Err(err) = rotate(&dir) {
        tracing::warn!(%err, "backup rotation failed");
    }
    parse(&final_path).ok_or_else(|| Error::NotFound(final_path.display().to_string()))
}

static BACKUP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Name prefix of the temporary database copies; [`list`] ignores them (no `.colpkg` suffix).
const SNAPSHOT_PREFIX: &str = ".instantaneo-";

/// Deletes snapshots and `.partial` files left by a backup interrupted when the app closed.
/// Safe because backups never run concurrently ([`BACKUP_LOCK`]).
fn remove_leftovers(dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(SNAPSHOT_PREFIX) || name.ends_with(PARTIAL) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A temporary copy of the collection database, deleted (with any SQLite side files) on drop.
struct Snapshot(PathBuf);

impl Drop for Snapshot {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

/// Builds `out` (a `.colpkg` with media) from the database snapshot on a dedicated thread.
/// The snapshot is opened as its own throwaway collection whose media folder is the real one;
/// opening it never touches the media DB, and rslib only lists and reads the media files.
async fn write_colpkg(snapshot: PathBuf, media_folder: PathBuf, out: PathBuf) -> Result<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("anki-backup".into())
        .spawn(move || {
            let tr = I18n::new(&["pt-BR"]);
            let job = || -> Result<()> {
                let media_db = snapshot.with_extension("mdb");
                let col = CollectionBuilder::new(&snapshot)
                    .set_media_paths(media_folder, media_db)
                    .set_tr(tr.clone())
                    .build()
                    .map_err(|e| Error::from_anki(e, &tr))?;
                col.export_colpkg(&out, true, false)
                    .map_err(|e| Error::from_anki(e, &tr))
            };
            let res = catch_unwind(AssertUnwindSafe(job)).unwrap_or(Err(Error::Panicked));
            let _ = tx.send(res);
        })
        .map_err(Error::Spawn)?;
    rx.await.unwrap_or(Err(Error::Closed))
}

/// Deletes the oldest daily and pre-import backups beyond [`KEEP_DAILY`] / [`KEEP_PRE_IMPORT`].
/// Manual backups are kept. Returns the deleted paths.
pub fn rotate(dir: &Path) -> Result<Vec<PathBuf>> {
    let all = list(dir)?;
    let mut deleted = Vec::new();
    for (kind, keep) in [
        (BackupKind::Daily, KEEP_DAILY),
        (BackupKind::PreImport, KEEP_PRE_IMPORT),
    ] {
        // `list` is newest first.
        for old in all.iter().filter(|b| b.kind == kind).skip(keep) {
            let path = PathBuf::from(&old.path);
            std::fs::remove_file(&path).map_err(|e| Error::io(&path, e))?;
            deleted.push(path);
        }
    }
    Ok(deleted)
}

/// Backups in `dir`, newest first. Unknown files and unfinished `.partial` files are ignored;
/// a missing folder is an empty list.
pub fn list(dir: &Path) -> Result<Vec<BackupInfo>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(dir, e)),
    };
    let mut out: Vec<(BackupInfo, u32)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let path = e.path();
            let (_, _, seq) = parse_name(path.file_name()?.to_str()?)?;
            Some((parse(&path)?, seq))
        })
        .collect();
    out.sort_by(|(a, sa), (b, sb)| {
        (b.created_at, *sb, &b.file_name).cmp(&(a.created_at, *sa, &a.file_name))
    });
    Ok(out.into_iter().map(|(b, _)| b).collect())
}

/// Parses a backup file name into its kind, the local time encoded in it and the `-N` suffix.
pub fn parse_name(name: &str) -> Option<(BackupKind, NaiveDateTime, u32)> {
    let stem = name.strip_suffix(EXT)?;
    let (kind, rest) = if let Some(rest) = stem.strip_prefix(DAILY_PREFIX) {
        (BackupKind::Daily, rest)
    } else if let Some(rest) = stem.strip_prefix(PRE_IMPORT_PREFIX) {
        (BackupKind::PreImport, rest)
    } else {
        (BackupKind::Manual, stem.strip_prefix(MANUAL_PREFIX)?)
    };
    let (stamp_len, fmt) = match kind {
        BackupKind::Daily => (10, "%Y-%m-%d"),
        _ => (15, "%Y%m%d-%H%M%S"),
    };
    let stamp = rest.get(..stamp_len)?;
    let seq = match &rest[stamp_len..] {
        "" => 1,
        suffix => suffix
            .strip_prefix('-')?
            .parse::<u32>()
            .ok()
            .filter(|n| *n >= 2)?,
    };
    let at = match kind {
        BackupKind::Daily => NaiveDate::parse_from_str(stamp, fmt)
            .ok()?
            .and_hms_opt(0, 0, 0)?,
        _ => NaiveDateTime::parse_from_str(stamp, fmt).ok()?,
    };
    Some((kind, at, seq))
}

fn parse(path: &Path) -> Option<BackupInfo> {
    let file_name = path.file_name()?.to_str()?.to_string();
    let (kind, at, _) = parse_name(&file_name)?;
    let meta = std::fs::metadata(path).ok()?;
    let created_at = Local
        .from_local_datetime(&at)
        .earliest()
        .map(|t| t.timestamp_millis())
        .unwrap_or_else(|| at.and_utc().timestamp_millis());
    Some(BackupInfo {
        path: path.to_string_lossy().into_owned(),
        file_name,
        kind,
        created_at,
        size: meta.len(),
    })
}

fn daily_name(date: NaiveDate) -> String {
    format!("{DAILY_PREFIX}{}{EXT}", date.format("%Y-%m-%d"))
}

/// Final name for a new backup. A daily backup replaces the same day's file; other kinds get a
/// `-N` suffix above any existing one when the second is already taken (so a name freed by the
/// rotation is never reused for a newer backup).
fn free_name(dir: &Path, kind: BackupKind, now: DateTime<Local>) -> PathBuf {
    let stem = match kind {
        BackupKind::Daily => return dir.join(daily_name(now.date_naive())),
        BackupKind::PreImport => format!("{PRE_IMPORT_PREFIX}{}", now.format("%Y%m%d-%H%M%S")),
        BackupKind::Manual => format!("{MANUAL_PREFIX}{}", now.format("%Y%m%d-%H%M%S")),
    };
    let taken = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let name = name.strip_suffix(PARTIAL).unwrap_or(&name);
            if !name.starts_with(stem.as_str()) {
                return None;
            }
            parse_name(name).map(|(_, _, seq)| seq)
        })
        .max();
    match taken {
        None => dir.join(format!("{stem}{EXT}")),
        Some(seq) => dir.join(format!("{stem}-{}{EXT}", seq + 1)),
    }
}
