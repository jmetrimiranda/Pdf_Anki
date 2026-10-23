//! The manual check of spec 12.8 ("100 tokens aleatórios de um livro real: lema e status corretos em ≥ 95%"):
//! samples tokens of a PDF with their lemma and status into a CSV for review by hand.
//!
//! ```text
//! cargo run -p leitor-estudos --example vocab_sample -- <book.pdf> [--n 100] [--seed S] \
//!     [--anki-dir DIR --root 'Vocabulário'] > sample.csv
//! ```
//!
//! Without `--anki-dir` only function words count as known. With it, the statuses come from the notes of the
//! vocabulary folder `--root` (and its subdecks) of the collection in `DIR` (`collection.anki2`), with the field
//! suggested by name for each notetype. Use a COPY of a collection: opening it with this Anki core may upgrade it.
//! The data pack comes from `LEITOR_VOCAB_DATA_DIR` or `data/generated/vocab` (`scripts/build-wordnet.sh`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use core_vocab::{KnownIndex, KnownNote, PageInput, ScanConfig};

struct Args {
    pdf: PathBuf,
    n: usize,
    seed: u64,
    anki_dir: Option<PathBuf>,
    root: Option<String>,
}

fn parse() -> Result<Args, String> {
    let mut args = std::env::args().skip(1);
    let mut pdf = None;
    let mut n = 100;
    let mut seed = 2026;
    let mut anki_dir = None;
    let mut root = None;
    while let Some(a) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} precisa de um valor"));
        match a.as_str() {
            "--n" => n = value("--n")?.parse().map_err(|_| "--n: número inválido")?,
            "--seed" => {
                seed = value("--seed")?
                    .parse()
                    .map_err(|_| "--seed: número inválido")?
            }
            "--anki-dir" => anki_dir = Some(PathBuf::from(value("--anki-dir")?)),
            "--root" => root = Some(value("--root")?),
            _ if a.starts_with("--") => return Err(format!("opção desconhecida: {a}")),
            _ => pdf = Some(PathBuf::from(a)),
        }
    }
    let pdf = pdf
        .ok_or("uso: vocab_sample <livro.pdf> [--n 100] [--seed S] [--anki-dir DIR --root NOME]")?;
    if anki_dir.is_some() != root.is_some() {
        return Err("--anki-dir e --root vão juntos".into());
    }
    Ok(Args {
        pdf,
        n,
        seed,
        anki_dir,
        root,
    })
}

fn known_index(
    dir: &std::path::Path,
    root: &str,
    lex: &core_vocab::Lexicon,
) -> Result<KnownIndex, String> {
    let svc = core_anki::AnkiService::open(dir).map_err(|e| e.to_string())?;
    let root = root.to_owned();
    let notes = svc
        .call_blocking(move |col| {
            let Some(root_id) = core_anki::book::deck_by_name(col, &root)? else {
                return Ok(None);
            };
            let info = core_anki::vocab::folder(col, root_id)?;
            let decks: Vec<i64> = info.decks.iter().map(|d| d.deck_id).collect();
            let mapping: HashMap<i64, usize> = info
                .notetypes
                .iter()
                .map(|nt| (nt.notetype_id, core_vocab::suggest_field(&nt.fields)))
                .collect();
            core_anki::vocab::known_notes(col, &decks, &mapping, 21).map(Some)
        })
        .map_err(|e| e.to_string())?;
    let _ = svc.shutdown();
    let notes = notes.ok_or("o deck --root não existe nessa coleção")?;
    eprintln!(
        "vocab_sample: {} notas na pasta de vocabulário",
        notes.len()
    );
    let notes: Vec<KnownNote> = notes
        .into_iter()
        .map(|(note_id, field_html, status)| KnownNote {
            note_id,
            field_html,
            status: match status {
                core_anki::vocab::NoteStatusRaw::Mature => core_vocab::NoteStatus::Mature,
                core_anki::vocab::NoteStatusRaw::Learning => core_vocab::NoteStatus::Learning,
                core_anki::vocab::NoteStatusRaw::New => core_vocab::NoteStatus::New,
                core_anki::vocab::NoteStatusRaw::Suspended => core_vocab::NoteStatus::Suspended,
            },
        })
        .collect();
    Ok(KnownIndex::build(&notes, lex, &ScanConfig::default()))
}

fn run() -> Result<(), String> {
    let args = parse()?;
    let data = leitor_app::vocab::VocabData::default();
    if let Some(generated) = leitor_app::vocab::data::source_tree_dir().parent() {
        data.set_resource_dir(generated.to_path_buf());
    }
    let lex = data.lexicon().map_err(|e| e.message)?;
    let bytes = std::fs::read(&args.pdf).map_err(|e| format!("{}: {e}", args.pdf.display()))?;
    let pages = core_pdf::extract_book_text(
        Arc::new(bytes),
        None,
        core_pdf::ExtractOptions::default(),
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .map_err(|e| e.to_string())?;
    let inputs: Vec<PageInput> = pages
        .iter()
        .map(|p| PageInput {
            unit: u32::try_from(p.page).unwrap_or(u32::MAX),
            text: &p.text,
        })
        .collect();
    let known = match (&args.anki_dir, &args.root) {
        (Some(dir), Some(root)) => Some(known_index(dir, root, &lex)?),
        _ => None,
    };
    let rows = core_vocab::sample_tokens(&inputs, &lex, known.as_ref(), args.n, args.seed);
    if rows.is_empty() {
        return Err("o livro não tem texto (escaneado?)".into());
    }
    print!("{}", core_vocab::to_csv(&rows));
    eprintln!(
        "vocab_sample: {} tokens de {} páginas (semente {}). Confira lema e status à mão (meta: ≥ 95% corretos).",
        rows.len(),
        pages.len(),
        args.seed
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("vocab_sample: {e}");
            ExitCode::FAILURE
        }
    }
}
