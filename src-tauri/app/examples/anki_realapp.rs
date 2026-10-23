//! Helper of `scripts/anki-real-app.sh` and `scripts/record-anki-posts.sh` (debug aid). The app
//! must be closed (the collection is opened here).
//!
//! - `anki_realapp prep <anki dir> <out dir>`: exports the deck "Matemática" to
//!   `<out dir>/matematica.apkg` and prints `{ "notetypeId", "apkg" }` as JSON. The isolation
//!   probe card itself is `core_anki::fixture::ISOLATION_PROBE_FRONT` (seeded with
//!   `seed_fixture --isolation-probe`).
//! - `anki_realapp colpkg <anki dir> <dest>`: writes a backup of the collection (with media) and
//!   copies it to `<dest>`.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use core_anki::{AnkiService, BackupKind, ExportOptions, backup, decks, fixture, notes};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["prep", dir, out] => prep(Path::new(dir), Path::new(out)),
        ["colpkg", dir, dest] => colpkg(Path::new(dir), Path::new(dest)),
        _ => Err(
            "uso: anki_realapp prep <pasta anki> <saída> | colpkg <pasta anki> <destino>".into(),
        ),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn prep(dir: &Path, out: &Path) -> Result<(), String> {
    let svc = AnkiService::open(dir).map_err(|e| e.to_string())?;
    let apkg = out.join("matematica.apkg");
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let target = apkg.clone();
    let notetype_id = svc
        .call_blocking(move |col| {
            let names = decks::names(col)?;
            let deck_id = |name: &str| {
                names
                    .iter()
                    .find(|d| d.name == name)
                    .map(|d| d.id)
                    .ok_or_else(|| core_anki::Error::NotFound(name.to_owned()))
            };
            core_anki::import_export::export_apkg(
                col,
                deck_id(fixture::DECK_MATH)?,
                &target,
                ExportOptions {
                    with_scheduling: true,
                    with_media: true,
                },
            )?;
            let cards = core_anki::browse::search(
                col,
                &format!("\"deck:{}\"", fixture::DECK_ANIMAL_FARM),
                None,
            )?;
            let row = core_anki::browse::rows(col, &cards[..cards.len().min(1)])?;
            let note = row
                .first()
                .ok_or_else(|| core_anki::Error::NotFound(fixture::DECK_ANIMAL_FARM.into()))?;
            Ok(notes::get(col, note.note_id)?.notetype_id)
        })
        .map_err(|e| e.to_string())?;
    svc.shutdown().map_err(|e| e.to_string())?;
    let json = serde_json::json!({ "notetypeId": notetype_id, "apkg": apkg });
    println!("{json}");
    Ok(())
}

fn colpkg(dir: &Path, dest: &Path) -> Result<(), String> {
    let svc = AnkiService::open(dir).map_err(|e| e.to_string())?;
    let info = tauri::async_runtime::block_on(backup::backup_now(&svc, BackupKind::Manual))
        .map_err(|e| e.to_string())?;
    svc.shutdown().map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(PathBuf::from(&info.path), dest).map_err(|e| e.to_string())?;
    println!("{}", dest.display());
    Ok(())
}
