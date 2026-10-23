//! `.colpkg` backups: names, rotation, daily schedule, and `request_abort` off the actor.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use chrono::{Local, NaiveDate, TimeZone};
use core_anki::backup::{self, KEEP_DAILY, KEEP_PRE_IMPORT, KEEP_PRE_SYNC};
use core_anki::study::Study;
use core_anki::{AnkiService, BackupKind};

use common::fixture;

fn touch(dir: &std::path::Path, name: &str) -> std::io::Result<()> {
    std::fs::write(dir.join(name), b"x")
}

#[test]
fn names_are_parsed_and_unknown_files_ignored() -> anyhow::Result<()> {
    let (kind, at, seq) = backup::parse_name("diario-2026-10-22.colpkg").expect("daily");
    assert_eq!(kind, BackupKind::Daily);
    assert_eq!(
        at.date(),
        NaiveDate::from_ymd_opt(2026, 10, 22).expect("date")
    );
    assert_eq!(seq, 1);
    let (kind, at, _) =
        backup::parse_name("antes-de-importar-20261022-134501.colpkg").expect("pre");
    assert_eq!(kind, BackupKind::PreImport);
    assert_eq!(at.format("%H:%M:%S").to_string(), "13:45:01");
    let (kind, _, seq) = backup::parse_name("manual-20261022-134501-3.colpkg").expect("manual");
    assert_eq!((kind, seq), (BackupKind::Manual, 3));
    for bad in [
        "diario-2026-10-22.colpkg.partial",
        "diario-2026-13-40.colpkg",
        "diario-2026-10-22.apkg",
        "backup-2026-10-22-10.00.00.colpkg",
        "manual-20261022-134501-1.colpkg",
        "manual-20261022-134501-x.colpkg",
        "manual-2026.colpkg",
        "outro.txt",
    ] {
        assert!(backup::parse_name(bad).is_none(), "{bad}");
    }

    let tmp = tempfile::tempdir()?;
    assert!(backup::list(&tmp.path().join("missing"))?.is_empty());
    for name in [
        "diario-2026-10-20.colpkg",
        "diario-2026-10-21.colpkg.partial",
        "manual-20261021-090000.colpkg",
        "antes-de-importar-20261022-080000.colpkg",
        "leia-me.txt",
    ] {
        touch(tmp.path(), name)?;
    }
    let list = backup::list(tmp.path())?;
    let names: Vec<_> = list.iter().map(|b| b.file_name.as_str()).collect();
    assert_eq!(
        names,
        [
            "antes-de-importar-20261022-080000.colpkg",
            "manual-20261021-090000.colpkg",
            "diario-2026-10-20.colpkg",
        ],
        "newest first, .partial and unknown ignored"
    );
    assert_eq!(list[0].kind, BackupKind::PreImport);
    assert_eq!(list[0].size, 1);
    let json = serde_json::to_value(&list[0])?;
    assert_eq!(json["kind"], "preImport");
    assert!(json["createdAt"].is_number() && json["fileName"].is_string());
    let expected = Local
        .with_ymd_and_hms(2026, 10, 22, 8, 0, 0)
        .earliest()
        .expect("local time")
        .timestamp_millis();
    assert_eq!(list[0].created_at, expected);
    Ok(())
}

#[test]
fn rotation_keeps_seven_daily_and_five_pre_import() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    for day in 1..=12 {
        touch(tmp.path(), &format!("diario-2026-10-{day:02}.colpkg"))?;
        touch(
            tmp.path(),
            &format!("antes-de-importar-202610{day:02}-120000.colpkg"),
        )?;
        touch(tmp.path(), &format!("manual-202610{day:02}-120000.colpkg"))?;
    }
    let deleted = backup::rotate(tmp.path())?;
    assert_eq!(deleted.len(), (12 - KEEP_DAILY) + (12 - KEEP_PRE_IMPORT));
    let list = backup::list(tmp.path())?;
    let of = |k: BackupKind| -> Vec<String> {
        list.iter()
            .filter(|b| b.kind == k)
            .map(|b| b.file_name.clone())
            .collect()
    };
    let daily = of(BackupKind::Daily);
    assert_eq!(daily.len(), KEEP_DAILY);
    assert_eq!(daily[0], "diario-2026-10-12.colpkg");
    assert_eq!(daily[6], "diario-2026-10-06.colpkg");
    let pre = of(BackupKind::PreImport);
    assert_eq!(pre.len(), KEEP_PRE_IMPORT);
    assert_eq!(pre[4], "antes-de-importar-20261008-120000.colpkg");
    assert_eq!(of(BackupKind::Manual).len(), 12, "manual backups are kept");
    assert!(backup::rotate(tmp.path())?.is_empty());
    Ok(())
}

#[test]
fn pre_sync_names_and_own_rotation_bucket() -> anyhow::Result<()> {
    let (kind, at, seq) =
        backup::parse_name("antes-da-sincronizacao-20261023-071502.colpkg").expect("pre-sync");
    assert_eq!((kind, seq), (BackupKind::PreSync, 1));
    assert_eq!(
        at.format("%Y-%m-%d %H:%M:%S").to_string(),
        "2026-10-23 07:15:02"
    );
    let (kind, _, seq) =
        backup::parse_name("antes-da-sincronizacao-20261023-071502-2.colpkg").expect("suffix");
    assert_eq!((kind, seq), (BackupKind::PreSync, 2));
    for bad in [
        "antes-da-sincronizacao-20261023.colpkg",
        "antes-da-sincronizacao-20261023-071502.colpkg.partial",
        "antes-da-sincronizacao-20261023-071502-1.colpkg",
        "antes-da-sincronizacao-x.colpkg",
        "antes-da-sincronizacao-20261023-071502.apkg",
    ] {
        assert!(backup::parse_name(bad).is_none(), "{bad}");
    }
    assert_eq!(serde_json::to_value(BackupKind::PreSync)?, "preSync");

    let tmp = tempfile::tempdir()?;
    for day in 1..=9 {
        touch(
            tmp.path(),
            &format!("antes-da-sincronizacao-202610{day:02}-120000.colpkg"),
        )?;
    }
    for day in 1..=3 {
        touch(
            tmp.path(),
            &format!("antes-de-importar-202610{day:02}-120000.colpkg"),
        )?;
    }
    touch(tmp.path(), "antes-da-sincronizacao-leia-me.txt")?;
    let deleted = backup::rotate(tmp.path())?;
    assert_eq!(
        deleted.len(),
        9 - KEEP_PRE_SYNC,
        "pre-import ones are another bucket"
    );
    let list = backup::list(tmp.path())?;
    let pre_sync: Vec<_> = list
        .iter()
        .filter(|b| b.kind == BackupKind::PreSync)
        .map(|b| b.file_name.as_str())
        .collect();
    assert_eq!(pre_sync.len(), KEEP_PRE_SYNC);
    assert_eq!(pre_sync[0], "antes-da-sincronizacao-20261009-120000.colpkg");
    assert_eq!(pre_sync[4], "antes-da-sincronizacao-20261005-120000.colpkg");
    assert_eq!(
        list.iter()
            .filter(|b| b.kind == BackupKind::PreImport)
            .count(),
        3
    );
    assert!(
        tmp.path()
            .join("antes-da-sincronizacao-leia-me.txt")
            .is_file()
    );
    Ok(())
}

#[tokio::test]
async fn pre_sync_backup_is_written_with_its_prefix() -> anyhow::Result<()> {
    let f = fixture()?;
    let info = backup::backup_now(&f.svc, BackupKind::PreSync).await?;
    assert_eq!(info.kind, BackupKind::PreSync);
    assert!(info.file_name.starts_with("antes-da-sincronizacao-"));
    assert!(info.file_name.ends_with(".colpkg") && info.size > 1000);
    let second = backup::backup_now(&f.svc, BackupKind::PreSync).await?;
    assert_ne!(second.file_name, info.file_name, "never overwrites");
    Ok(())
}

#[tokio::test]
async fn backup_now_writes_a_complete_colpkg_quickly() -> anyhow::Result<()> {
    let f = fixture()?;
    let started = Instant::now();
    let info = backup::backup_now(&f.svc, BackupKind::Manual).await?;
    let took = started.elapsed();
    // Generous bound: only catches a pathological slowdown (a CI runner took 1.25 s for the fixture).
    assert!(took < Duration::from_secs(10), "backup took {took:?}");
    assert_eq!(info.kind, BackupKind::Manual);
    assert!(info.file_name.starts_with("manual-") && info.file_name.ends_with(".colpkg"));
    assert!(info.size > 1000);
    let dir = backup::backups_dir(f.svc.paths());
    assert_eq!(dir, f.dir().join("backups"));
    let files: Vec<_> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        files,
        std::slice::from_ref(&info.file_name),
        "no partial or temp file left"
    );

    // The service reopened the collection.
    let tree = f.svc.deck_tree().await?;
    assert!(tree.find(core_anki::fixture::DECK_WORDS).is_some());

    // Same second → a second manual backup gets a suffix, never overwrites.
    let second = backup::backup_now(&f.svc, BackupKind::Manual).await?;
    assert_ne!(second.file_name, info.file_name);
    assert_eq!(backup::list(&dir)?.len(), 2);
    Ok(())
}

#[tokio::test]
async fn daily_backup_runs_once_per_local_date() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;
    let day1 = Local
        .with_ymd_and_hms(2026, 10, 20, 9, 0, 0)
        .earliest()
        .expect("time");
    let first = backup::daily_if_due(&svc, day1).await?.expect("due");
    assert_eq!(first.file_name, "diario-2026-10-20.colpkg");
    assert_eq!(first.kind, BackupKind::Daily);
    let later = day1 + chrono::Duration::hours(10);
    assert!(backup::daily_if_due(&svc, later).await?.is_none());
    let day2 = day1 + chrono::Duration::days(1);
    let second = backup::daily_if_due(&svc, day2).await?.expect("next day");
    assert_eq!(second.file_name, "diario-2026-10-21.colpkg");

    // Rotation runs after each write: 9 more days leave KEEP_DAILY files.
    for d in 2..11 {
        backup::daily_if_due(&svc, day1 + chrono::Duration::days(d)).await?;
    }
    let dir = backup::backups_dir(svc.paths());
    assert_eq!(backup::list(&dir)?.len(), KEEP_DAILY);
    Ok(())
}

#[test]
fn request_abort_works_from_another_thread_while_a_job_runs() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;
    let started = Arc::new(AtomicBool::new(false));
    let seen = std::thread::scope(|s| -> anyhow::Result<bool> {
        let job = {
            let (svc, inner, started) = (svc.clone(), svc.clone(), started.clone());
            s.spawn(move || {
                svc.call_blocking(move |_col| {
                    started.store(true, Ordering::SeqCst);
                    // A long job that only stops when someone requests an abort.
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while Instant::now() < deadline {
                        if inner.abort_requested() {
                            return Ok(true);
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Ok(false)
                })
            })
        };
        while !started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let t = Instant::now();
        svc.request_abort(); // must not wait for the actor
        assert!(t.elapsed() < Duration::from_millis(100));
        Ok(job.join().map_err(|_| anyhow::anyhow!("job panicked"))??)
    })?;
    assert!(seen, "the running job saw the abort");
    Ok(())
}

fn deck(f: &common::Fixture, name: &str) -> i64 {
    *f.info.decks.get(name).expect("fixture deck")
}

/// Incompressible bytes, so the media part of the backup takes real time.
fn noise(len: usize, mut seed: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.extend_from_slice(&seed.to_le_bytes());
    }
    out.truncate(len);
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn studying_does_not_wait_for_the_media_of_a_backup() -> anyhow::Result<()> {
    let f = fixture()?;
    let media = f.svc.paths().media_folder.clone();
    for i in 0..6u64 {
        std::fs::write(media.join(format!("big-{i}.mp3")), noise(8 << 20, i + 1))?;
    }
    let study = Study::new(f.svc.clone());
    let oxford = deck(&f, core_anki::fixture::DECK_OXFORD_3000);
    study.next(oxford).await?; // warm up

    let svc = f.svc.clone();
    let started = Instant::now();
    let job = tokio::spawn(async move { backup::backup_now(&svc, BackupKind::Manual).await });
    let mut latencies = Vec::new();
    let mut answered = 0;
    while !job.is_finished() {
        let t = Instant::now();
        let next = study.next(oxford).await?;
        if let Some(card) = next.card() {
            study.answer(card.card_id, 3, 2_000).await?;
            answered += 1;
        }
        f.svc.deck_tree().await?;
        latencies.push(t.elapsed());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let info = job.await??;
    let backup_took = started.elapsed();
    let worst = latencies.iter().max().copied().unwrap_or_default();
    assert!(info.size > 40 << 20, "media included: {} bytes", info.size);
    assert!(
        latencies.len() >= 3,
        "only {} study rounds during a {backup_took:?} backup",
        latencies.len()
    );
    assert!(answered >= 1, "a card was answered during the backup");
    assert!(
        worst < Duration::from_millis(500) && worst * 3 < backup_took,
        "a study round waited {worst:?} during a {backup_took:?} backup"
    );
    Ok(())
}

#[tokio::test]
async fn backup_restores_with_media_and_keeps_undo() -> anyhow::Result<()> {
    let f = fixture()?;
    let study = Study::new(f.svc.clone());
    let oxford = deck(&f, core_anki::fixture::DECK_OXFORD_3000);
    let first = study.next(oxford).await?.card().expect("card").clone();
    let after = study.answer(first.card_id, 3, 2_000).await?;
    assert!(after.card().expect("card").can_undo);

    let info = backup::backup_now(&f.svc, BackupKind::Manual).await?;
    // The collection was never closed: the answer can still be undone.
    let back = study.undo().await?;
    assert_eq!(back.card().expect("card").card_id, first.card_id);

    let dir = backup::backups_dir(f.svc.paths());
    let names: Vec<_> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        std::slice::from_ref(&info.file_name),
        "snapshot removed"
    );

    let restored = tempfile::tempdir()?;
    let paths = core_anki::CollectionPaths::in_dir(restored.path());
    std::fs::create_dir_all(&paths.media_folder)?;
    core_anki::anki::import_export::package::import_colpkg(
        &info.path,
        paths.collection.to_str().expect("utf-8"),
        &paths.media_folder,
        &paths.media_db,
        Default::default(),
    )?;
    let original_media = std::fs::read_dir(&f.svc.paths().media_folder)?.count();
    assert!(original_media > 0);
    assert_eq!(
        std::fs::read_dir(&paths.media_folder)?.count(),
        original_media
    );
    let count = |svc: AnkiService, sql: &'static str| async move {
        svc.call(move |col| common::sql_i64(col, sql)).await
    };
    let restored_svc = AnkiService::open(restored.path())?;
    let notes = "select count() from notes";
    let reviews = "select count() from revlog";
    assert_eq!(
        count(restored_svc.clone(), notes).await?,
        count(f.svc.clone(), notes).await?
    );
    // The answer made before the backup is in it (undone afterwards in the live collection).
    assert_eq!(
        count(restored_svc, reviews).await?,
        count(f.svc.clone(), reviews).await? + 1
    );
    Ok(())
}
