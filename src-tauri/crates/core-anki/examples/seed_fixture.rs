//! Builds the test fixture collection (docs/PROJETO.md 20) in a folder and prints its
//! `FixtureInfo` as JSON.
//!
//! `cargo run -p core-anki --example seed_fixture -- <LEITOR_DATA_DIR>/anki [--isolation-probe] [--vocab] [--force]
//! [--book-uid=<sha256>]`
//!
//! `--vocab` adds the vocabulary folder ("Vocabulário" with "Inglês básico", "Oxford" and an empty subdeck) for the
//! vocabulary scan.
//!
//! `--book-uid` points the Animal Farm note's `Fonte` link at a real book of the library (captures), instead of
//! the fixture's made-up `book_uid`.
//!
//! The collection must not be open (close the app first). Without `--force` an existing
//! collection in the folder is an error; with it the collection, its media and media DB are
//! deleted first.

use std::path::PathBuf;
use std::process::ExitCode;

use core_anki::CollectionPaths;
use core_anki::anki::collection::CollectionBuilder;
use core_anki::anki::notes::NoteId;
use core_anki::fixture::{BOOK_UID, FixtureInfo, FixtureOptions, build};

fn main() -> ExitCode {
    let mut dir: Option<PathBuf> = None;
    let mut opts = FixtureOptions::default();
    let mut force = false;
    let mut book_uid: Option<String> = None;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--isolation-probe" => opts.isolation_probe = true,
            "--vocab" => opts.vocab = true,
            "--force" => force = true,
            flag if flag.starts_with("--book-uid=") => {
                let uid = &flag["--book-uid=".len()..];
                if uid.len() != 64 || !uid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
                    eprintln!("--book-uid precisa de 64 caracteres hexadecimais minúsculos");
                    return ExitCode::FAILURE;
                }
                book_uid = Some(uid.to_string());
            }
            flag if flag.starts_with("--") => {
                eprintln!("opção desconhecida: {flag}");
                return ExitCode::FAILURE;
            }
            path => dir = Some(PathBuf::from(path)),
        }
    }
    let Some(dir) = dir else {
        eprintln!(
            "uso: seed_fixture <pasta da coleção> [--isolation-probe] [--vocab] [--force] [--book-uid=<sha256>]"
        );
        return ExitCode::FAILURE;
    };
    let paths = CollectionPaths::in_dir(&dir);
    if paths.collection.exists() {
        if !force {
            eprintln!(
                "a pasta {} já tem uma coleção (use --force para substituí-la)",
                dir.display()
            );
            return ExitCode::FAILURE;
        }
        let wal = PathBuf::from(format!("{}-wal", paths.collection.display()));
        for file in [&paths.collection, &paths.media_db, &wal] {
            let _ = std::fs::remove_file(file);
        }
        let _ = std::fs::remove_dir_all(&paths.media_folder);
    }
    let built = build(&dir, opts).and_then(|info| match &book_uid {
        Some(uid) => relink_book(&paths, info, uid),
        None => Ok(info),
    });
    match built {
        Ok(info) => match serde_json::to_string_pretty(&info) {
            Ok(json) => {
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// Rewrites the fixture's `leitor://livro/<BOOK_UID>` link in the Animal Farm note to `uid`.
fn relink_book(
    paths: &CollectionPaths,
    mut info: FixtureInfo,
    uid: &str,
) -> core_anki::Result<FixtureInfo> {
    let Some(&nid) = info.notes.get("fonte") else {
        return Ok(info);
    };
    let mut col = CollectionBuilder::new(&paths.collection)
        .set_media_paths(paths.media_folder.clone(), paths.media_db.clone())
        .build()
        .map_err(|e| core_anki::Error::InvalidInput(e.to_string()))?;
    let replaced = col
        .find_and_replace(vec![NoteId(nid)], BOOK_UID, uid, Some("Fonte".to_string()))
        .map_err(|e| core_anki::Error::InvalidInput(e.to_string()));
    let closed = col
        .close(None)
        .map_err(|e| core_anki::Error::InvalidInput(e.to_string()));
    replaced?;
    closed?;
    info.book_uid = uid.to_string();
    Ok(info)
}
