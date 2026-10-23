//! Builds the test fixture collection (docs/PROJETO.md 20) in a folder and prints its
//! `FixtureInfo` as JSON.
//!
//! `cargo run -p core-anki --example seed_fixture -- <LEITOR_DATA_DIR>/anki [--isolation-probe] [--force]`
//!
//! The collection must not be open (close the app first). Without `--force` an existing
//! collection in the folder is an error; with it the collection, its media and media DB are
//! deleted first.

use std::path::PathBuf;
use std::process::ExitCode;

use core_anki::CollectionPaths;
use core_anki::fixture::{FixtureOptions, build};

fn main() -> ExitCode {
    let mut dir: Option<PathBuf> = None;
    let mut opts = FixtureOptions::default();
    let mut force = false;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--isolation-probe" => opts.isolation_probe = true,
            "--force" => force = true,
            flag if flag.starts_with("--") => {
                eprintln!("opção desconhecida: {flag}");
                return ExitCode::FAILURE;
            }
            path => dir = Some(PathBuf::from(path)),
        }
    }
    let Some(dir) = dir else {
        eprintln!("uso: seed_fixture <pasta da coleção> [--isolation-probe] [--force]");
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
    match build(&dir, opts) {
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
