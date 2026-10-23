//! `.apkg` import/export, `.colpkg` replacement and `replace_collection`.

mod common;

use std::path::Path;

use core_anki::backup;
use core_anki::fixture::{self, AUDIO_FILE, IMAGE_FILE};
use core_anki::import_export::{export_apkg, import_apkg};
use core_anki::{AnkiService, BackupKind, Error, ExportOptions};

use common::{deck_names, fixture, sql_i64};

#[tokio::test]
async fn export_deck_with_media_and_import_into_a_fresh_collection() -> anyhow::Result<()> {
    let f = fixture()?;
    let words = f.info.decks[fixture::DECK_WORDS];
    let apkg = f.tmp.path().join("palavras.apkg");
    let out = apkg.clone();
    let res = f
        .svc
        .call(move |col| export_apkg(col, words, &out, ExportOptions::default()))
        .await?;
    assert_eq!(res.notes, 9, "8 basic notes + 1 vocab note");
    assert!(apkg.is_file());

    let tmp = tempfile::tempdir()?;
    let b = AnkiService::open(tmp.path())?;
    let src = apkg.clone();
    let summary = b.call(move |col| import_apkg(col, &src)).await?;
    assert_eq!(summary.added, 9);
    assert_eq!(
        (
            summary.updated,
            summary.duplicates,
            summary.conflicts,
            summary.skipped
        ),
        (0, 0, 0, 0)
    );
    let json = serde_json::to_value(summary)?;
    assert_eq!(json["added"], 9);

    let (notes, cards) = b
        .call(|col| {
            Ok((
                sql_i64(col, "select count() from notes")?,
                sql_i64(col, "select count() from cards")?,
            ))
        })
        .await?;
    assert_eq!((notes, cards), (9, 9));
    assert!(b.paths().media_folder.join(IMAGE_FILE).is_file());
    assert!(b.paths().media_folder.join(AUDIO_FILE).is_file());
    assert_eq!(b.call(deck_names).await?, [fixture::DECK_WORDS]);

    // Importing the same package again adds nothing.
    let src = apkg.clone();
    let again = b.call(move |col| import_apkg(col, &src)).await?;
    assert_eq!(again.added, 0);
    assert_eq!(again.duplicates + again.updated, 9, "{again:?}");

    // Export without media/scheduling.
    let math = f.info.decks[fixture::DECK_MATH];
    let plain = f.tmp.path().join("mat.apkg");
    let out = plain.clone();
    let res = f
        .svc
        .call(move |col| {
            export_apkg(
                col,
                math,
                &out,
                ExportOptions {
                    with_scheduling: false,
                    with_media: false,
                },
            )
        })
        .await?;
    assert_eq!(res.notes, 1);

    let err = f
        .svc
        .call(move |col| export_apkg(col, 987_654, &plain, ExportOptions::default()))
        .await
        .expect_err("missing deck");
    assert_eq!(err.code(), "anki.notFound");
    Ok(())
}

/// Bytes that are not a valid package: empty, text, zip magic only, truncations of a real one.
fn garbage_variants(valid: &[u8]) -> Vec<Vec<u8>> {
    let mut out = vec![
        Vec::new(),
        b"isto nao e um pacote".to_vec(),
        b"PK\x03\x04".to_vec(),
        b"PK\x03\x04\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0".to_vec(),
    ];
    // Pseudo-random bytes after a zip magic (deterministic LCG).
    let mut x: u32 = 12345;
    let mut random = b"PK\x03\x04".to_vec();
    for _ in 0..4096 {
        x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
        random.push((x >> 16) as u8);
    }
    out.push(random);
    let steps = 24;
    for i in 1..steps {
        let cut = valid.len() * i / steps;
        out.push(valid[..cut].to_vec());
    }
    out
}

/// A package with bytes flipped in the middle: may still import (the damage can hit unused
/// bytes), but must never panic.
fn flipped(valid: &[u8]) -> Vec<u8> {
    let mut out = valid.to_vec();
    let mid = out.len() / 2;
    let end = (mid + 64).min(out.len());
    for b in &mut out[mid..end] {
        *b ^= 0xA5;
    }
    out
}

fn assert_invalid(res: core_anki::Result<impl std::fmt::Debug>, what: &str) {
    match res {
        Err(Error::InvalidPackage(msg)) => assert!(!msg.is_empty()),
        other => panic!("{what}: expected InvalidPackage, got {other:?}"),
    }
}

#[tokio::test]
async fn garbage_apkg_is_rejected_without_panicking() -> anyhow::Result<()> {
    let f = fixture()?;
    let words = f.info.decks[fixture::DECK_WORDS];
    let apkg = f.tmp.path().join("ok.apkg");
    let out = apkg.clone();
    f.svc
        .call(move |col| export_apkg(col, words, &out, ExportOptions::default()))
        .await?;
    let valid = std::fs::read(&apkg)?;

    let tmp = tempfile::tempdir()?;
    let b = AnkiService::open(&tmp.path().join("b"))?;
    let variants = garbage_variants(&valid);
    assert!(variants.len() >= 25);
    for (i, bytes) in variants.into_iter().enumerate() {
        let path = tmp.path().join(format!("ruim-{i}.apkg"));
        std::fs::write(&path, &bytes)?;
        let res = b.call(move |col| import_apkg(col, &path)).await;
        assert_invalid(res, &format!("variant {i} ({} bytes)", bytes.len()));
    }
    let path = tmp.path().join("invertido.apkg");
    std::fs::write(&path, flipped(&valid))?;
    let p = path.clone();
    match b.call(move |col| import_apkg(col, &p)).await {
        Ok(_) | Err(Error::InvalidPackage(_)) => {}
        Err(other) => panic!("flipped apkg: {other:?}"),
    }
    // Reset: the flipped package may have added notes.
    b.call(|col| {
        let nids = col.search_notes_unordered("")?;
        col.remove_notes(&nids)?;
        for (id, _) in col.get_all_normal_deck_names(true)? {
            col.remove_decks_and_child_decks(&[id])?;
        }
        Ok(())
    })
    .await?;
    // Missing file, wrong extension.
    let missing = tmp.path().join("nao-existe.apkg");
    assert_invalid(
        b.call(move |col| import_apkg(col, &missing)).await,
        "missing",
    );
    let wrong = tmp.path().join("ok.zip");
    std::fs::copy(&apkg, &wrong)?;
    assert_invalid(b.call(move |col| import_apkg(col, &wrong)).await, "ext");
    let err = Error::InvalidPackage("x".into());
    assert_eq!(err.code(), "anki.invalidPackage");

    // The collection is still fine.
    assert!(b.call(deck_names).await?.is_empty());
    Ok(())
}

async fn deck_set(svc: &AnkiService) -> anyhow::Result<Vec<String>> {
    Ok(svc.call(deck_names).await?)
}

#[tokio::test]
async fn colpkg_import_replaces_the_collection_after_a_backup() -> anyhow::Result<()> {
    let f = fixture()?;
    let colpkg = backup::backup_now(&f.svc, BackupKind::Manual).await?;

    let tmp = tempfile::tempdir()?;
    let dir = tmp.path().join("outra");
    let other = AnkiService::open(&dir)?;
    other
        .call(|col| core_anki::decks::create(col, "Antigo"))
        .await?;
    assert_eq!(deck_set(&other).await?, ["Antigo"]);

    let src = tmp.path().join("colecao.colpkg");
    std::fs::copy(&colpkg.path, &src)?;
    let pre = other.import_colpkg(&src).await?;
    assert_eq!(pre.kind, BackupKind::PreImport);
    assert!(Path::new(&pre.path).is_file());
    assert!(pre.file_name.starts_with("antes-de-importar-"));

    let names = deck_set(&other).await?;
    for deck in [fixture::DECK_WORDS, fixture::DECK_OXFORD, fixture::DECK_ROS] {
        assert!(names.iter().any(|n| n == deck), "{deck} in {names:?}");
    }
    assert!(!names.iter().any(|n| n == "Antigo"));
    assert!(other.paths().media_folder.join(IMAGE_FILE).is_file());
    let tree = other.deck_tree().await?;
    assert!(
        tree.find(fixture::DECK_WORDS)
            .is_some_and(|d| d.review_count >= 3)
    );
    // The decks of the user's capture (docs/referencia/capturas/10-anki-lista-de-decks.png).
    let oxford = tree.find(fixture::DECK_OXFORD).expect("Oxford");
    assert!(
        oxford.children.iter().any(|c| c.name == "Oxford 3000"),
        "Oxford::Oxford 3000"
    );
    for deck in [fixture::DECK_WORDS, fixture::DECK_OXFORD, fixture::DECK_ROS] {
        let node = tree.find(deck).expect(deck);
        assert!(
            node.total > 0 && node.new_count + node.learn_count + node.review_count > 0,
            "{deck} has cards due: {node:?}"
        );
    }

    // The pre-import backup holds the old collection: restoring it brings "Antigo" back.
    let restore = tmp.path().join("restaurar.colpkg");
    std::fs::copy(&pre.path, &restore)?;
    other.import_colpkg(&restore).await?;
    assert_eq!(deck_set(&other).await?, ["Antigo"]);
    let backups = backup::list(&backup::backups_dir(other.paths()))?;
    assert_eq!(
        backups
            .iter()
            .filter(|b| b.kind == BackupKind::PreImport)
            .count(),
        2
    );
    Ok(())
}

#[tokio::test]
async fn failing_colpkg_leaves_the_old_collection_usable() -> anyhow::Result<()> {
    let f = fixture()?;
    let colpkg = backup::backup_now(&f.svc, BackupKind::Manual).await?;
    let valid = std::fs::read(&colpkg.path)?;
    let before = deck_set(&f.svc).await?;

    for (i, bytes) in garbage_variants(&valid).into_iter().enumerate() {
        let path = f.tmp.path().join(format!("ruim-{i}.colpkg"));
        std::fs::write(&path, &bytes)?;
        let res = f.svc.import_colpkg(&path).await;
        assert_invalid(res, &format!("colpkg variant {i} ({} bytes)", bytes.len()));
        assert_eq!(deck_set(&f.svc).await?, before, "variant {i}");
    }
    let path = f.tmp.path().join("invertido.colpkg");
    std::fs::write(&path, flipped(&valid))?;
    match f.svc.import_colpkg(&path).await {
        Ok(_) | Err(Error::InvalidPackage(_)) => {}
        Err(other) => panic!("flipped colpkg: {other:?}"),
    }
    assert_eq!(deck_set(&f.svc).await?, before, "flipped");
    // Wrong extension and missing file.
    assert_invalid(
        f.svc.import_colpkg(&f.tmp.path().join("x.colpkg")).await,
        "missing",
    );
    let apkg_named = f.tmp.path().join("pacote.apkg");
    std::fs::copy(&colpkg.path, &apkg_named)?;
    assert_invalid(f.svc.import_colpkg(&apkg_named).await, "extension");

    // The collection is still writable and complete.
    f.svc
        .call(|col| core_anki::decks::create(col, "Depois"))
        .await?;
    assert!(f.svc.deck_tree().await?.find("Depois").is_some());
    assert!(
        f.svc
            .deck_tree()
            .await?
            .find(fixture::DECK_WORDS)
            .is_some_and(|d| d.review_count >= 3)
    );
    Ok(())
}

#[tokio::test]
async fn replace_collection_always_reopens() -> anyhow::Result<()> {
    let tmp = tempfile::tempdir()?;
    let svc = AnkiService::open(tmp.path())?;
    svc.call(|col| core_anki::decks::create(col, "Mantido"))
        .await?;

    // f fails: the collection is reopened and the error returned.
    let err = svc
        .replace_collection(|paths| -> core_anki::Result<()> {
            assert!(paths.collection.is_file());
            Err(Error::InvalidInput("falhou de propósito".into()))
        })
        .await
        .expect_err("f failed");
    assert_eq!(err.code(), "anki.invalidInput");
    assert_eq!(deck_set(&svc).await?, ["Mantido"]);

    // f panics: same.
    let err = svc
        .replace_collection(|_| -> core_anki::Result<()> { panic!("boom") })
        .await
        .expect_err("panic");
    assert!(matches!(err, Error::Panicked));
    assert_eq!(deck_set(&svc).await?, ["Mantido"]);

    // f succeeds with the collection closed (the file can be copied consistently).
    let copy = tmp.path().join("copia.anki2");
    let c2 = copy.clone();
    let size = svc
        .replace_collection(move |p| {
            std::fs::copy(&p.collection, &c2).map_err(|e| Error::InvalidInput(e.to_string()))
        })
        .await?;
    assert!(size > 0);
    assert_eq!(deck_set(&svc).await?, ["Mantido"]);

    // f breaks the file: reopening fails, but the service stays usable once it is fixed.
    let col_path = svc.paths().collection.clone();
    let err = svc
        .replace_collection(|p| {
            std::fs::write(&p.collection, b"lixo").map_err(|e| Error::InvalidInput(e.to_string()))
        })
        .await
        .expect_err("reopen fails");
    assert_eq!(err.code(), "anki.open");
    let err = svc.call(|_| Ok(())).await.expect_err("still broken");
    assert_eq!(err.code(), "anki.open");
    std::fs::copy(&copy, &col_path)?;
    assert_eq!(deck_set(&svc).await?, ["Mantido"], "retry reopens");
    Ok(())
}

/// A `.colpkg` import (or any collection replacement) never runs under a sync: the sync and its
/// media thread hold their own handles on the collection and the media DB.
#[tokio::test]
async fn colpkg_import_waits_for_no_sync() -> anyhow::Result<()> {
    use core_anki::sync::SyncEndpoint;
    use core_anki::{SyncConfig, SyncCredentials};

    let f = fixture()?;
    let colpkg = backup::backup_now(&f.svc, BackupKind::Manual).await?;
    let src = f.tmp.path().join("colecao.colpkg");
    std::fs::copy(&colpkg.path, &src)?;

    // A local server that accepts and never answers: the sync waits on the network.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let hold = tokio::spawn(async move {
        let mut open = Vec::new();
        while let Ok((sock, _)) = listener.accept().await {
            open.push(sock);
        }
    });
    let mut config = SyncConfig::new(SyncEndpoint::parse(&format!("http://127.0.0.1:{port}/"))?);
    config.io_timeout_secs = 30;
    let creds = SyncCredentials {
        config,
        hkey: "hkey-de-teste".into(),
    };
    let svc = f.svc.clone();
    let pending = tokio::spawn(async move { svc.sync(&creds, false).await });
    let started = std::time::Instant::now();
    while !f.svc.sync_running() {
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    let backups = || -> std::io::Result<usize> {
        Ok(std::fs::read_dir(backup::backups_dir(f.svc.paths()))?.count())
    };
    let before = backups()?;
    let res = f.svc.import_colpkg(&src).await;
    assert!(is_busy(&res), "{res:?}");
    assert_eq!(
        backups()?,
        before,
        "no pre-import backup for a refused import"
    );
    let res = f.svc.replace_collection(|_| Ok(())).await;
    assert!(is_busy(&res), "{res:?}");
    // The collection was not touched.
    f.svc
        .call(|col| core_anki::decks::create(col, "Durante"))
        .await?;

    f.svc.abort_sync();
    let res = tokio::time::timeout(std::time::Duration::from_secs(10), pending).await??;
    assert!(res.is_err(), "{res:?}");
    hold.abort();
    assert!(!f.svc.sync_running());
    // No sync: the import goes through.
    let pre = f.svc.import_colpkg(&src).await?;
    assert_eq!(pre.kind, BackupKind::PreImport);
    assert!(f.svc.deck_tree().await?.find("Durante").is_none());
    Ok(())
}

fn is_busy<T>(res: &core_anki::Result<T>) -> bool {
    matches!(
        res,
        Err(Error::Sync {
            kind: core_anki::sync::SyncFailure::Busy,
            ..
        })
    )
}
