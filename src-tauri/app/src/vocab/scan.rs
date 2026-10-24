//! The scan job (spec 12.1 step 5, 12.3, 12.4): text → per-page lemma table (once per text version) → known
//! vocabulary → comparison of the chosen range → report. Runs on its own thread with progress events
//! (`job://<jobId>`) and can be cancelled.
//!
//! The table is cached in the app database (`book_lemma`/`book_lemma_page`, marker `book_lemma_state`) under
//! `text_version = "<ALGO_VERSION>:<text fingerprint>"`; the fingerprint ignores annotations, so a version that
//! PdfCraft saved with only comments or bookmarks still reuses it, and scanning another range never reads the PDF.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use core_anki::vocab::{NoteStatusRaw, VocabFolderInfo, VocabFolderRoot};
use core_store::{
    Book, BookFormat, BookLemmaPageRow, BookLemmaRow, NewVocabScan, VocabOverrideStatus,
    VocabScanMetrics, VocabScanStatus, VocabTableState,
};
use core_vocab::{
    BookLemma, BookLemmaPage, BookTable, ChapterCoverage, CompareInput, FormCount, KnownIndex,
    KnownNote, Lexicon, Metrics, NoteStatus, OutlineAnchor, OutlineNode, OverrideStatus, PageInput,
    Pos, RangeKind, RangeSpec, ResolvedRange, ScanConfig, VocabRow,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::AppError;
use crate::jobs::{JobHandle, JobKind, JobProgress, JobSink, JobStage, Started};
use crate::state::{AppState, lock};

use super::{KnownKey, field_mapping, folder_required, included_decks, normal_deck_name};

/// `vocab_scan_start`/`vocab_rescan`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStarted {
    pub job_id: String,
    pub scan_uid: String,
}

/// The vocabulary folder of a report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFolder {
    pub root_deck_id: i64,
    pub root_name: String,
    /// Decks read (root and included subdecks).
    pub deck_count: u32,
}

/// Where the cards of the report go (spec 12.6).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDeck {
    /// `<pasta>::Livros::<Título>`.
    pub base_name: String,
    /// The range subdeck (`Cap 3`, `p. 21-45`), `None` for the whole book.
    pub subdeck: Option<String>,
    /// `base_name` or `base_name::subdeck`.
    pub full_name: String,
    /// `trecho::cap-3`; `None` for the whole book.
    pub range_tag: Option<String>,
    /// `livro::animal-farm`.
    pub book_tag: String,
}

/// `vocab_report`: one finished scan (spec 12.5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabReport {
    pub scan_uid: String,
    pub book_uid: String,
    pub title: String,
    pub author: Option<String>,
    /// Epoch ms.
    pub scanned_at: i64,
    pub folder: ReportFolder,
    pub range: ResolvedRange,
    pub config: ScanConfig,
    pub metrics: Metrics,
    pub chapters: Vec<ChapterCoverage>,
    pub rows: Vec<VocabRow>,
    pub deck: ReportDeck,
}

/// `vocab_scan.config`: the criterion and the subdecks left out (so a rescan repeats the scan).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredScanConfig {
    #[serde(flatten)]
    pub config: ScanConfig,
    #[serde(default)]
    pub excluded_deck_ids: Vec<i64>,
}

/// What a scan needs once it starts.
struct ScanJob {
    book: Book,
    scan_uid: String,
    root: VocabFolderRoot,
    excluded: Vec<i64>,
    range: ResolvedRange,
    outline: Vec<OutlineNode>,
    page_count: u32,
    config: ScanConfig,
    lex: Arc<Lexicon>,
}

/// `vocab_scan.range`: the resolved range plus, for outline ranges, the title and page of each selected item, so a
/// rescan finds the same items after bookmarks were added, removed or moved (rows of older builds have no anchors).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct StoredRange {
    #[serde(flatten)]
    pub range: ResolvedRange,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anchors: Vec<OutlineAnchor>,
}

/// How long `vocab_scan_start` waits for a superseded scan of the same book to stop.
const SUPERSEDE_WAIT: Duration = Duration::from_secs(10);

fn scan_busy() -> AppError {
    AppError::new(
        "vocab_scan_busy",
        "Outro escaneamento deste livro ainda está terminando. Tente de novo em alguns segundos.",
    )
}

/// The range a resolved range was chosen with (rescans resolve it again against the current outline).
pub(crate) fn spec_of(range: &ResolvedRange) -> RangeSpec {
    match range.kind {
        RangeKind::All => RangeSpec::All,
        RangeKind::Outline => RangeSpec::Outline {
            ids: range.items.clone(),
        },
        RangeKind::Pages => RangeSpec::Pages {
            text: range.text.clone().unwrap_or_default(),
        },
    }
}

pub(crate) fn needs_ocr() -> AppError {
    AppError::new(
        "vocab_needs_ocr",
        "Este livro parece escaneado: reconheça o texto (OCR) antes de escanear o vocabulário.",
    )
}

/// An EPUB without text to read (images only).
pub(crate) fn no_text() -> AppError {
    AppError::new("vocab_no_text", "Este EPUB não tem texto para escanear.")
}

fn cancelled_error() -> AppError {
    AppError::new("cancelled", "Escaneamento cancelado.")
}

pub(crate) fn note_status(raw: NoteStatusRaw) -> NoteStatus {
    match raw {
        NoteStatusRaw::Mature => NoteStatus::Mature,
        NoteStatusRaw::Learning => NoteStatus::Learning,
        NoteStatusRaw::New => NoteStatus::New,
        NoteStatusRaw::Suspended => NoteStatus::Suspended,
    }
}

pub(crate) fn override_status(s: VocabOverrideStatus) -> OverrideStatus {
    match s {
        VocabOverrideStatus::Known => OverrideStatus::Known,
        VocabOverrideStatus::Ignored => OverrideStatus::Ignored,
        VocabOverrideStatus::Proper => OverrideStatus::Proper,
    }
}

// ---------------------------------------------------------------- table <-> store rows

fn lemma_row(l: &BookLemma) -> BookLemmaRow {
    BookLemmaRow {
        lemma: l.lemma.clone(),
        pos: l.pos.map(|p| p.letter().to_string()),
        occurrences: l.occurrences,
        first_unit: l.first_unit,
        example: (!l.example.is_empty()).then(|| l.example.clone()),
        example_span: l.example_span.map(|s| json!(s)),
        units: l.units.clone(),
        is_proper: l.is_proper,
        zipf: l.zipf.map(f64::from),
        forms: serde_json::to_value(&l.forms).unwrap_or_else(|_| json!([])),
    }
}

fn lemma_from_row(r: BookLemmaRow) -> BookLemma {
    BookLemma {
        lemma: r.lemma,
        pos: r.pos.as_deref().and_then(Pos::from_letter),
        occurrences: r.occurrences,
        first_unit: r.first_unit,
        example: r.example.unwrap_or_default(),
        example_span: r
            .example_span
            .and_then(|v| serde_json::from_value::<[u32; 2]>(v).ok()),
        units: r.units,
        is_proper: r.is_proper,
        zipf: r.zipf.map(|z| z as f32),
        forms: serde_json::from_value::<Vec<FormCount>>(r.forms).unwrap_or_default(),
    }
}

/// Page rows keep the reading position of the first occurrence next to the example span:
/// `example_span = {"span": [a, b] | null, "position": n}` (the store leaves the shape to the caller).
fn page_row(p: &BookLemmaPage) -> BookLemmaPageRow {
    BookLemmaPageRow {
        lemma: p.lemma.clone(),
        unit: p.unit,
        occurrences: p.occurrences,
        form: p.form.clone(),
        forms: serde_json::to_value(&p.forms).unwrap_or_else(|_| json!([])),
        example: p.example.clone(),
        example_span: Some(json!({ "span": p.example_span, "position": p.position })),
    }
}

fn page_from_row(r: BookLemmaPageRow) -> BookLemmaPage {
    let (span, position) = match &r.example_span {
        Some(v) => (
            v.get("span")
                .and_then(|s| serde_json::from_value::<[u32; 2]>(s.clone()).ok()),
            v.get("position")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0),
        ),
        None => (None, 0),
    };
    BookLemmaPage {
        lemma: r.lemma,
        unit: r.unit,
        occurrences: r.occurrences,
        form: r.form,
        forms: serde_json::from_value::<Vec<(String, u32)>>(r.forms).unwrap_or_default(),
        example: r.example,
        example_span: span,
        position,
    }
}

/// The book's table: the whole-book lemmas and the page rows of `pages` (0-based inclusive intervals).
pub(crate) struct LoadedTable {
    pub lemmas: Vec<BookLemma>,
    pub pages: Vec<BookLemmaPage>,
}

impl AppState {
    /// `"<ALGO_VERSION>:<fingerprint>"` of the current version (the fingerprint is cached per file hash).
    /// For an EPUB: `"<ALGO_VERSION>:epub:<fingerprint of the section texts>"` (from the text cache).
    pub(crate) fn vocab_text_version(&self, book: &Book) -> Result<String, AppError> {
        if let Some(fp) = lock(&self.vocab.fingerprints).get(&book.file_hash) {
            return Ok(format!("{}:{fp}", core_vocab::ALGO_VERSION));
        }
        let fp = match book.format {
            BookFormat::Epub => format!("epub:{}", self.epub_text_fingerprint(book)?),
            BookFormat::Pdf => {
                let bytes = Arc::new(self.book_bytes(&book.book_uid)?);
                core_pdf::text_fingerprint(bytes, None)?
            }
        };
        let mut cache = lock(&self.vocab.fingerprints);
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(book.file_hash.clone(), fp.clone());
        Ok(format!("{}:{fp}", core_vocab::ALGO_VERSION))
    }

    /// The stored table when it is complete for `text_version`.
    pub(crate) fn vocab_cached_table(
        &self,
        uid: &str,
        text_version: &str,
        pages: &[[u32; 2]],
    ) -> Result<Option<LoadedTable>, AppError> {
        self.with_store(|s| {
            let Some(state) = s.vocab_table_state(uid)? else {
                return Ok(None);
            };
            if state.text_version != text_version
                || state.algo_version != i64::from(core_vocab::ALGO_VERSION)
            {
                return Ok(None);
            }
            let lemmas = s.vocab_table_lemmas(uid)?;
            let rows = s.vocab_table_pages(uid, pages)?;
            Ok(Some(LoadedTable {
                lemmas: lemmas.into_iter().map(lemma_from_row).collect(),
                pages: rows.into_iter().map(page_from_row).collect(),
            }))
        })
    }

    /// The known vocabulary of the folder (spec 12.3 A), cached until the collection, the decks, the mapping or
    /// the criterion change.
    pub(crate) fn vocab_known_index(
        &self,
        root_deck_id: i64,
        excluded: &[i64],
        config: &ScanConfig,
        lex: &Lexicon,
    ) -> Result<(Arc<KnownIndex>, VocabFolderInfo), AppError> {
        let saved = self.with_store(|s| s.vocab_mappings())?;
        let svc = self.anki_handles()?.svc;
        let (info, col_mod) = svc.call_blocking(move |col| {
            let info = core_anki::vocab::folder(col, root_deck_id)?;
            let col_mod: i64 = col
                .storage
                .db()
                .query_row("SELECT mod FROM col", [], |r| r.get(0))
                .unwrap_or(0);
            Ok((info, col_mod))
        })?;
        let deck_ids = included_decks(&info, excluded);
        let mapping = field_mapping(&info, &saved);
        let mut mapping_key: Vec<(i64, usize)> = mapping.iter().map(|(k, v)| (*k, *v)).collect();
        mapping_key.sort_unstable();
        let mut sorted_decks = deck_ids.clone();
        sorted_decks.sort_unstable();
        let key = KnownKey {
            deck_ids: sorted_decks,
            mapping: mapping_key,
            known_ivl_days: config.known_ivl_days,
            config: serde_json::to_string(config).unwrap_or_default(),
            col_mod,
        };
        if let Some((k, index)) = lock(&self.vocab.known).as_ref()
            && *k == key
        {
            return Ok((Arc::clone(index), info));
        }
        let ivl = config.known_ivl_days.max(1);
        let raw = svc.call_blocking(move |col| {
            core_anki::vocab::known_notes(col, &deck_ids, &mapping, ivl)
        })?;
        let notes: Vec<KnownNote> = raw
            .into_iter()
            .map(|(note_id, field_html, status)| KnownNote {
                note_id,
                field_html,
                status: note_status(status),
            })
            .collect();
        let index = Arc::new(KnownIndex::build(&notes, lex, config));
        *lock(&self.vocab.known) = Some((key, Arc::clone(&index)));
        Ok((index, info))
    }

    pub(crate) fn vocab_overrides_map(&self) -> Result<HashMap<String, OverrideStatus>, AppError> {
        Ok(self
            .with_store(|s| s.vocab_overrides())?
            .into_iter()
            .map(|(l, s)| (l, override_status(s)))
            .collect())
    }

    /// Lemma → note id of the "Vocabulário · Livro" notes created from the book (anywhere in the collection).
    pub(crate) fn vocab_previous_notes(&self, uid: &str) -> Result<HashMap<String, i64>, AppError> {
        let uid = uid.to_owned();
        let notes = self
            .anki_handles()?
            .svc
            .call_blocking(move |col| core_anki::vocab::book_vocab_notes(col, &uid))?;
        let mut out = HashMap::new();
        for (nid, lemma, _) in notes {
            if !lemma.is_empty() {
                out.entry(lemma).or_insert(nid);
            }
        }
        Ok(out)
    }

    /// Starts a scan (spec 12.1 step 5) and returns at once; the job reports on `job://<jobId>`. The same scan
    /// (folder, subdecks left out, range and criterion) already running for the book is returned instead; a
    /// different one is cancelled and replaced (`vocab_scan_busy` if it doesn't stop in time). The folder, the
    /// subdecks left out and the criterion become the defaults.
    pub fn vocab_scan_start(
        self: &Arc<Self>,
        uid: &str,
        root_deck_id: i64,
        excluded_deck_ids: Vec<i64>,
        range: RangeSpec,
        config: ScanConfig,
    ) -> Result<ScanStarted, AppError> {
        let book = self.vocab_book(uid)?;
        let lex = self.vocab_lexicon()?;
        let svc = self.anki_handles()?.svc;
        let folder = svc.call_blocking(move |col| {
            Ok(match normal_deck_name(col, root_deck_id)? {
                Some(_) => Some(core_anki::vocab::folder(col, root_deck_id)?),
                None => None,
            })
        })?;
        let Some(folder) = folder else {
            return Err(folder_required());
        };
        let root_name = folder.root.name.clone();
        let deck_ids = included_decks(&folder, &excluded_deck_ids);
        let (resolved, outline, page_count) = self.vocab_resolve(&book, &range)?;
        let config = ScanConfig {
            known_ivl_days: config.known_ivl_days.max(1),
            ..config
        };
        let stored = StoredScanConfig {
            config,
            excluded_deck_ids: excluded_deck_ids.clone(),
        };
        if let Some(running) = self.vocab.jobs.running_for(JobKind::VocabScan, uid) {
            if self.is_same_scan(&running.scan_uid, root_deck_id, &stored, &resolved) {
                return Ok(ScanStarted {
                    job_id: running.job_id,
                    scan_uid: running.scan_uid,
                });
            }
            self.stop_scan(&running.job_id)?;
        }
        // The wizard's choices become the defaults (spec 12.1 step 1: "a escolha fica salva como padrão").
        self.with_store(|s| {
            let mut v = s.vocab_settings()?;
            v.root_deck_id = Some(root_deck_id);
            v.excluded_deck_ids = excluded_deck_ids.clone();
            super::apply_config(&mut v, &config);
            s.set_vocab_settings(&v)
        })?;
        let stored_range = StoredRange {
            anchors: core_vocab::outline_anchors(&resolved, &outline),
            range: resolved.clone(),
        };
        let scan_uid = self.with_store(|s| {
            s.insert_vocab_scan(&NewVocabScan {
                book_uid: uid.to_owned(),
                root_deck_id,
                deck_ids,
                config: serde_json::to_value(&stored).unwrap_or_else(|_| json!({})),
                range: serde_json::to_value(&stored_range)
                    .unwrap_or_else(|_| json!({"kind": "all"})),
            })
        })?;
        let job = match self
            .vocab
            .jobs
            .start(JobKind::VocabScan, uid, &scan_uid, self.job_sink())
        {
            Started::New(job) => job,
            Started::Running(_) => {
                // Another scan of the book started in the meantime: never hand back a scan of other choices.
                let _ = self
                    .with_store(|s| s.end_vocab_scan(&scan_uid, VocabScanStatus::Cancelled, None));
                return Err(scan_busy());
            }
        };
        let started = ScanStarted {
            job_id: job.job_id().to_owned(),
            scan_uid: scan_uid.clone(),
        };
        let work = ScanJob {
            book,
            scan_uid,
            root: VocabFolderRoot {
                deck_id: root_deck_id,
                name: root_name,
            },
            excluded: excluded_deck_ids,
            range: resolved,
            outline,
            page_count,
            config,
            lex,
        };
        let state = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("vocab-scan".into())
            .spawn(move || state.run_scan(job, work));
        if let Err(e) = spawned {
            return Err(AppError::internal(e));
        }
        Ok(started)
    }

    /// Scans the latest finished range again with the same folder and criterion (seconds: the table is reused).
    pub fn vocab_rescan(self: &Arc<Self>, uid: &str) -> Result<ScanStarted, AppError> {
        let row = self
            .with_store(|s| s.latest_vocab_scan(uid, true))?
            .ok_or_else(super::not_scanned)?;
        let stored: StoredScanConfig =
            serde_json::from_value(row.config.clone()).unwrap_or(StoredScanConfig {
                config: ScanConfig::default(),
                excluded_deck_ids: Vec::new(),
            });
        let range = match serde_json::from_value::<StoredRange>(row.range.clone()) {
            Ok(stored) if !stored.anchors.is_empty() => {
                // Find the selected items again by title and page: the outline may have changed.
                let book = self.vocab_book(uid)?;
                let (_, nodes) = self.vocab_outline_nodes(&book)?;
                let ids = core_vocab::rematch_outline_items(&stored.anchors, &nodes)
                    .map_err(|e| super::invalid_range(&e))?;
                RangeSpec::Outline { ids }
            }
            Ok(stored) => spec_of(&stored.range),
            Err(_) => RangeSpec::All,
        };
        self.vocab_scan_start(
            uid,
            row.root_deck_id,
            stored.excluded_deck_ids,
            range,
            stored.config,
        )
    }

    /// Whether the scan `scan_uid` was started with these choices (folder, subdecks left out, criterion, pages).
    fn is_same_scan(
        &self,
        scan_uid: &str,
        root_deck_id: i64,
        stored: &StoredScanConfig,
        range: &ResolvedRange,
    ) -> bool {
        let Ok(Some(row)) = self.with_store(|s| s.vocab_scan(scan_uid)) else {
            return false;
        };
        let config = serde_json::from_value::<StoredScanConfig>(row.config).ok();
        let old_range = serde_json::from_value::<StoredRange>(row.range).ok();
        row.root_deck_id == root_deck_id
            && config.as_ref() == Some(stored)
            && old_range.is_some_and(|r| r.range == *range)
    }

    /// Cancels a running scan and waits for it to end; `vocab_scan_busy` when it doesn't stop in time.
    fn stop_scan(&self, job_id: &str) -> Result<(), AppError> {
        self.vocab.jobs.cancel(job_id);
        let end = std::time::Instant::now() + SUPERSEDE_WAIT;
        loop {
            match self.job_status(job_id) {
                Some(p) if !p.stage.is_terminal() => {}
                _ => return Ok(()),
            }
            if std::time::Instant::now() >= end {
                return Err(scan_busy());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The latest finished report of the book, `None` when never scanned.
    pub fn vocab_report(&self, uid: &str) -> Result<Option<VocabReport>, AppError> {
        let Some(row) = self.with_store(|s| s.latest_vocab_scan(uid, true))? else {
            return Ok(None);
        };
        self.vocab_report_of(&row.uid)
    }

    pub(crate) fn vocab_report_of(&self, scan_uid: &str) -> Result<Option<VocabReport>, AppError> {
        if let Some(r) = lock(&self.vocab.report).as_ref()
            && r.scan_uid == scan_uid
        {
            return Ok(Some((**r).clone()));
        }
        let Some(json) = self.with_store(|s| s.vocab_scan_report(scan_uid))? else {
            return Ok(None);
        };
        let report: VocabReport = serde_json::from_str(&json).map_err(AppError::internal)?;
        *lock(&self.vocab.report) = Some(Arc::new(report.clone()));
        Ok(Some(report))
    }

    /// Progress of a job (`None` when unknown).
    pub fn job_status(&self, job_id: &str) -> Option<JobProgress> {
        self.vocab.jobs.status(job_id)
    }

    pub fn job_cancel(&self, job_id: &str) -> bool {
        self.vocab.jobs.cancel(job_id)
    }

    /// Waits for a job to end (tests, examples, headless runs).
    pub fn job_wait(&self, job_id: &str, timeout: Duration) -> Option<JobProgress> {
        let end = std::time::Instant::now() + timeout;
        loop {
            let p = self.job_status(job_id)?;
            if p.stage.is_terminal() || std::time::Instant::now() >= end {
                return Some(p);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Where job progress goes (`job://<jobId>` events of the UI sink).
    pub(crate) fn job_sink(&self) -> JobSink {
        let slot = Arc::clone(&self.ui_sink);
        Arc::new(move |p| crate::anki::emit_with(&slot, crate::anki::UiEvent::Job(p)))
    }

    fn run_scan(&self, job: JobHandle, work: ScanJob) {
        let uid = work.scan_uid.clone();
        // A panic in the pipeline (a bug, never untrusted input by design) ends the scan as failed.
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.scan_steps(&job, work)))
                .unwrap_or_else(|_| Err(AppError::internal("vocabulary scan panicked")));
        match outcome {
            Ok(()) => job.done(),
            Err(e) if job.is_cancelled() || e.code == "cancelled" => {
                let _ =
                    self.with_store(|s| s.end_vocab_scan(&uid, VocabScanStatus::Cancelled, None));
                job.cancelled();
            }
            Err(e) => {
                tracing::warn!(code = %e.code, "vocabulary scan failed: {e}");
                let _ = self.with_store(|s| {
                    s.end_vocab_scan(&uid, VocabScanStatus::Failed, Some(&e.message))
                });
                job.failed(&e.code, &e.message);
            }
        }
    }

    fn scan_steps(&self, job: &JobHandle, w: ScanJob) -> Result<(), AppError> {
        let check = || {
            if job.is_cancelled() || self.is_shutting_down() {
                Err(cancelled_error())
            } else {
                Ok(())
            }
        };
        let uid = w.book.book_uid.clone();
        let text_version = self.vocab_text_version(&w.book)?;
        check()?;
        // 1–2. The per-page table: reused when complete for this text version, else read and built.
        let table = match self.vocab_cached_table(&uid, &text_version, &w.range.pages)? {
            Some(t) => {
                job.set_reused(true);
                t
            }
            None => {
                let built = self.build_table(job, &w, &text_version)?;
                let in_range = |p: &BookLemmaPage| w.range.contains(p.unit);
                LoadedTable {
                    lemmas: built.lemmas,
                    pages: built.pages.into_iter().filter(in_range).collect(),
                }
            }
        };
        check()?;
        // 3. Known vocabulary.
        job.stage(JobStage::Known, 1);
        let (known, folder) =
            self.vocab_known_index(w.root.deck_id, &w.excluded, &w.config, &w.lex)?;
        check()?;
        // 4. Comparison of the range.
        job.stage(JobStage::Compare, 1);
        let overrides = self.vocab_overrides_map()?;
        let previous = self.vocab_previous_notes(&uid)?;
        let chapters = core_vocab::chapters_in(&w.outline, w.page_count, super::unit_word(&w.book));
        let result = core_vocab::compare(CompareInput {
            lemmas: &table.lemmas,
            pages: &table.pages,
            range: &w.range,
            chapters: &chapters,
            known: &known,
            overrides: &overrides,
            previous_notes: &previous,
            config: &w.config,
            lex: &w.lex,
        });
        check()?;
        let names =
            core_vocab::vocab_deck_names(Some(&w.root.name), &w.book.title, &w.range, false);
        let deck_ids = included_decks(&folder, &w.excluded);
        let report = VocabReport {
            scan_uid: w.scan_uid.clone(),
            book_uid: uid.clone(),
            title: w.book.title.clone(),
            author: w.book.author.clone(),
            scanned_at: core_store::now_ms(),
            folder: super::scan::ReportFolder {
                root_deck_id: w.root.deck_id,
                root_name: folder.root.name.clone(),
                deck_count: u32::try_from(deck_ids.len()).unwrap_or(u32::MAX),
            },
            range: w.range.clone(),
            config: w.config,
            metrics: result.metrics.clone(),
            chapters: result.chapters,
            rows: result.rows,
            deck: ReportDeck {
                base_name: names.book.clone(),
                subdeck: w.range.subdeck.clone(),
                full_name: names.range.clone().unwrap_or_else(|| names.book.clone()),
                range_tag: core_vocab::range_tag(&w.range),
                book_tag: core_vocab::book_tag(&w.book.title),
            },
        };
        let json = serde_json::to_string(&report).map_err(AppError::internal)?;
        let m = &result.metrics;
        let metrics = VocabScanMetrics {
            total_tokens: u64::from(m.total_tokens),
            cov_known: m.coverage_known,
            cov_with_learning: m.coverage_with_learning,
            unknown_lemmas: u64::from(m.unknown_lemmas),
            words_to_95: Some(u64::from(m.words_to_95)),
            words_to_98: Some(u64::from(m.words_to_98)),
        };
        check()?;
        self.with_store(|s| s.finish_vocab_scan(&w.scan_uid, &metrics, &text_version, &json))?;
        Ok(())
    }

    /// Reads the book's text and builds the table (stages `text` and `lemmas`), then stores it.
    fn build_table(
        &self,
        job: &JobHandle,
        w: &ScanJob,
        text_version: &str,
    ) -> Result<BookTable, AppError> {
        if w.book.format == BookFormat::Epub {
            return self.build_epub_table(job, w, text_version);
        }
        if !w.book.has_text {
            return Err(needs_ocr());
        }
        let total = u64::from(w.page_count);
        job.stage(JobStage::Text, total);
        let bytes = Arc::new(self.book_bytes(&w.book.book_uid)?);
        let cancel = job.cancel_flag();
        self.vocab.text_extractions.fetch_add(1, Ordering::Relaxed);
        let pages = core_pdf::extract_book_text(
            bytes,
            None,
            core_pdf::ExtractOptions::default(),
            &cancel,
            &mut |done, total| job.progress(done as u64, total as u64),
        )
        .map_err(|e| match e {
            core_pdf::PdfError::Cancelled => cancelled_error(),
            other => AppError::from(other),
        })?;
        let chars: usize = pages
            .iter()
            .map(|p| p.text.chars().filter(|c| !c.is_whitespace()).count())
            .sum();
        if chars < core_pdf::TextStats::MIN_CHARS {
            return Err(needs_ocr());
        }
        if job.is_cancelled() {
            return Err(cancelled_error());
        }
        job.stage(JobStage::Lemmas, total);
        let inputs: Vec<PageInput> = pages
            .iter()
            .map(|p| PageInput {
                unit: u32::try_from(p.page).unwrap_or(u32::MAX),
                text: &p.text,
            })
            .collect();
        let table = core_vocab::build_book_table(&inputs, &w.lex, &cancel, &mut |done, total| {
            job.progress(u64::from(done), u64::from(total))
        })
        .map_err(super::vocab_error)?;
        self.store_table(w, text_version, &table)?;
        Ok(table)
    }

    /// The EPUB side of [`build_table`](Self::build_table): the section texts come from the `book_text` cache (read
    /// from the file only when it is missing), units are sections and no line counts as a running header.
    fn build_epub_table(
        &self,
        job: &JobHandle,
        w: &ScanJob,
        text_version: &str,
    ) -> Result<BookTable, AppError> {
        let total = u64::from(w.page_count);
        job.stage(JobStage::Text, total);
        let cancel = job.cancel_flag();
        let rows = self.epub_section_texts(&w.book, &cancel, &mut |done, total| {
            job.progress(u64::from(done), u64::from(total))
        })?;
        let chars: usize = rows
            .iter()
            .map(|r| r.text.chars().filter(|c| !c.is_whitespace()).count())
            .sum();
        if chars == 0 {
            return Err(no_text());
        }
        if job.is_cancelled() {
            return Err(cancelled_error());
        }
        job.stage(JobStage::Lemmas, total);
        let inputs: Vec<PageInput> = rows
            .iter()
            .map(|r| PageInput {
                unit: r.unit,
                text: &r.text,
            })
            .collect();
        let table = core_vocab::build_book_table_with(
            &inputs,
            &w.lex,
            core_vocab::TableOptions {
                strip_repeated: false,
            },
            &cancel,
            &mut |done, total| job.progress(u64::from(done), u64::from(total)),
        )
        .map_err(super::vocab_error)?;
        self.store_table(w, text_version, &table)?;
        Ok(table)
    }

    fn store_table(
        &self,
        w: &ScanJob,
        text_version: &str,
        table: &BookTable,
    ) -> Result<(), AppError> {
        let lemma_rows: Vec<BookLemmaRow> = table.lemmas.iter().map(lemma_row).collect();
        let page_rows: Vec<BookLemmaPageRow> = table.pages.iter().map(page_row).collect();
        let state = VocabTableState {
            text_version: text_version.to_owned(),
            algo_version: i64::from(core_vocab::ALGO_VERSION),
            page_count: w.page_count,
            built_at: 0,
            repeated_lines: table.repeated_lines.clone(),
        };
        let uid = w.book.book_uid.clone();
        self.with_store(|s| s.replace_vocab_table(&uid, &state, &lemma_rows, &page_rows))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_rows_keep_the_reading_position() {
        let p = BookLemmaPage {
            lemma: "windmill".into(),
            unit: 3,
            occurrences: 2,
            form: "windmills".into(),
            forms: vec![("windmills".into(), 2)],
            example: Some("the building of the windmills began".into()),
            example_span: Some([20, 29]),
            position: 17,
        };
        assert_eq!(page_from_row(page_row(&p)), p);
        let q = BookLemmaPage {
            example: None,
            example_span: None,
            ..p
        };
        assert_eq!(page_from_row(page_row(&q)), q);
    }

    #[test]
    fn lemma_rows_round_trip() {
        let l = BookLemma {
            lemma: "learn".into(),
            pos: Some(Pos::Verb),
            occurrences: 5,
            first_unit: 2,
            example: "they learn".into(),
            example_span: Some([5, 10]),
            units: vec![2, 4],
            is_proper: false,
            zipf: Some(4.5),
            forms: vec![FormCount {
                form: "learning".into(),
                count: 3,
                alts: vec!["learning".into()],
            }],
        };
        assert_eq!(lemma_from_row(lemma_row(&l)), l);
    }

    #[test]
    fn stored_config_round_trips_and_ranges_give_their_spec() {
        let c = StoredScanConfig {
            config: ScanConfig::default(),
            excluded_deck_ids: vec![4],
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["knownIvlDays"], 21);
        assert_eq!(serde_json::from_value::<StoredScanConfig>(v).unwrap(), c);
        assert_eq!(spec_of(&ResolvedRange::all(10)), RangeSpec::All);
    }
}
