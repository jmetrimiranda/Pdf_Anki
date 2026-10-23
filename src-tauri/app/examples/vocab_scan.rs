//! Runs a vocabulary scan headless on an app data dir, so the report route has data for captures
//! (`scripts/capture.sh` with `LEITOR_CAPTURE_SETUP`) and manual checks.
//!
//! ```text
//! LEITOR_DATA_DIR=<dir> cargo run -p leitor-estudos --example vocab_scan -- <book uid> <root deck name> [pages]
//! ```
//!
//! `pages` is a page range as typed in the wizard ("21-45, 60"); without it the whole book is scanned. The root
//! deck is looked up by its full name ("Vocabulário"). Prints the job's end and the report's metrics as JSON.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use core_vocab::RangeSpec;
use leitor_app::{AppState, JobStage};

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let usage = "uso: LEITOR_DATA_DIR=<dir> vocab_scan <uid do livro> <deck da pasta> [páginas]";
    let uid = args.next().ok_or(usage)?;
    let root_name = args.next().ok_or(usage)?;
    let range = match args.next() {
        Some(text) => RangeSpec::Pages { text },
        None => RangeSpec::All,
    };
    let data_dir = std::env::var_os("LEITOR_DATA_DIR")
        .map(PathBuf::from)
        .ok_or("defina LEITOR_DATA_DIR")?;
    let state = Arc::new(AppState::new(data_dir));
    if let Some(generated) = leitor_app::vocab::data::source_tree_dir().parent() {
        state.set_vocab_resource_dir(generated.to_path_buf());
    }
    let result = scan(&state, &uid, &root_name, range);
    state.shutdown();
    result
}

fn scan(state: &Arc<AppState>, uid: &str, root_name: &str, range: RangeSpec) -> Result<(), String> {
    let name = root_name.to_owned();
    let root = state
        .anki_handles()
        .map_err(|e| e.message)?
        .svc
        .call_blocking(move |col| core_anki::book::deck_by_name(col, &name))
        .map_err(|e| e.to_string())?
        .ok_or(format!("o deck {root_name:?} não existe"))?;
    let config = state.vocab_settings_get().map_err(|e| e.message)?.config;
    let job = state
        .vocab_scan_start(uid, root, vec![], range, config)
        .map_err(|e| e.message)?;
    let end = state
        .job_wait(&job.job_id, Duration::from_secs(600))
        .ok_or("o escaneamento sumiu")?;
    if end.stage != JobStage::Done {
        return Err(format!(
            "escaneamento terminou como {:?}: {:?}",
            end.stage, end.error
        ));
    }
    let report = state
        .vocab_report(uid)
        .map_err(|e| e.message)?
        .ok_or("sem relatório")?;
    let out = serde_json::json!({
        "job": end,
        "range": report.range.display,
        "metrics": {
            "totalTokens": report.metrics.total_tokens,
            "coverageKnown": report.metrics.coverage_known,
            "coverageWithLearning": report.metrics.coverage_with_learning,
            "unknownLemmas": report.metrics.unknown_lemmas,
            "wordsTo95": report.metrics.words_to_95,
            "wordsTo98": report.metrics.words_to_98,
        },
        "rows": report.rows.len(),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("vocab_scan: {e}");
            ExitCode::FAILURE
        }
    }
}
