//! Long background tasks (spec 15: "Tarefas longas … emitem eventos de progresso (`job://<id>`) e
//! podem ser canceladas"). A [`JobRegistry`] keeps the progress and the cancel flag of each job; the
//! job's thread reports through a [`JobHandle`], which throttles the progress events (at most
//! [`MAX_EVENTS_PER_SEC`] per job, stage changes and the end always go out).
//!
//! The UI subscribes to `job://<jobId>` and then polls `job_status` once, so an event sent before
//! the subscription is never lost.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::state::lock;

/// Most progress events per second per job.
pub const MAX_EVENTS_PER_SEC: u32 = 10;
/// Finished jobs kept for `job_status`.
const KEEP_FINISHED: usize = 32;

/// Prefix of the progress event name: `job://<jobId>`.
pub const JOB_EVENT_PREFIX: &str = "job://";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    VocabScan,
    /// Text recognition of a scanned PDF (spec 7.2, `crate::ocr`).
    Ocr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStage {
    Queued,
    /// Reading the book's text (only when the per-page table must be rebuilt).
    Text,
    /// Building the per-page lemma table.
    Lemmas,
    /// Reading the known vocabulary from the collection.
    Known,
    /// Comparing and building the report.
    Compare,
    /// Recognising the text of the pages (OCR); `done`/`total` are pages.
    Ocr,
    /// Writing the new version of the file with the text layer (OCR).
    Writing,
    Done,
    Failed,
    Cancelled,
}

impl JobStage {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

/// What an OCR job did (`JobProgress::ocr`), filled in when it ends.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrJobInfo {
    /// Words added to the text layer.
    pub words: u64,
    /// Pages recognised.
    pub pages_read: u32,
    /// Pages left alone (they already had text, or could not be read).
    pub pages_skipped: u32,
    /// The `file_version` of the new version with the text layer.
    pub file_version: Option<u32>,
    /// Average time per recognised page.
    pub ms_per_page: Option<u64>,
}

/// Payload of `job://<jobId>` and of `job_status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    pub kind: JobKind,
    pub book_uid: String,
    /// The vocabulary scan of a `vocabScan` job; `""` for other kinds.
    pub scan_uid: String,
    pub stage: JobStage,
    pub done: u64,
    pub total: u64,
    /// The book's per-page lemma table was reused (no PDF read).
    pub reused: bool,
    pub error: Option<JobError>,
    /// OCR jobs: what was recognised and written (absent for other kinds and until the job ends).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr: Option<OcrJobInfo>,
}

/// Where progress goes (the app emits `job://<id>`; tests collect).
pub type JobSink = Arc<dyn Fn(JobProgress) + Send + Sync>;

struct Entry {
    progress: JobProgress,
    cancel: Arc<AtomicBool>,
    last_emit: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    jobs: HashMap<String, Entry>,
    finished: VecDeque<String>,
}

/// Every job of the app run: id → progress + cancel flag.
#[derive(Clone, Default)]
pub struct JobRegistry {
    inner: Arc<Mutex<Inner>>,
}

/// What [`JobRegistry::start`] returns.
pub enum Started {
    New(JobHandle),
    /// A job of the same kind is already running for the book.
    Running(JobProgress),
}

impl JobRegistry {
    /// Registers a queued job, unless one of the same kind is still running for the book.
    pub fn start(&self, kind: JobKind, book_uid: &str, scan_uid: &str, sink: JobSink) -> Started {
        let mut inner = lock(&self.inner);
        if let Some(running) = inner.jobs.values().find(|e| {
            e.progress.kind == kind
                && e.progress.book_uid == book_uid
                && !e.progress.stage.is_terminal()
        }) {
            return Started::Running(running.progress.clone());
        }
        let job_id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = JobProgress {
            job_id: job_id.clone(),
            kind,
            book_uid: book_uid.to_owned(),
            scan_uid: scan_uid.to_owned(),
            stage: JobStage::Queued,
            done: 0,
            total: 0,
            reused: false,
            error: None,
            ocr: None,
        };
        inner.jobs.insert(
            job_id.clone(),
            Entry {
                progress,
                cancel: Arc::clone(&cancel),
                last_emit: None,
            },
        );
        Started::New(JobHandle {
            registry: self.clone(),
            job_id,
            cancel,
            sink,
        })
    }

    pub fn status(&self, job_id: &str) -> Option<JobProgress> {
        lock(&self.inner)
            .jobs
            .get(job_id)
            .map(|e| e.progress.clone())
    }

    /// Asks a job to stop; `false` when unknown or already finished.
    pub fn cancel(&self, job_id: &str) -> bool {
        match lock(&self.inner).jobs.get(job_id) {
            Some(e) if !e.progress.stage.is_terminal() => {
                e.cancel.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    }

    /// The running job of `kind` for a book, if any.
    pub fn running_for(&self, kind: JobKind, book_uid: &str) -> Option<JobProgress> {
        lock(&self.inner)
            .jobs
            .values()
            .find(|e| {
                e.progress.kind == kind
                    && e.progress.book_uid == book_uid
                    && !e.progress.stage.is_terminal()
            })
            .map(|e| e.progress.clone())
    }

    /// Cancels every running job (app exit).
    pub fn cancel_all(&self) {
        for e in lock(&self.inner).jobs.values() {
            e.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Applies `f` to the job and returns the progress to emit, if any (throttled).
    fn update(&self, job_id: &str, f: impl FnOnce(&mut JobProgress)) -> Option<JobProgress> {
        let mut inner = lock(&self.inner);
        let entry = inner.jobs.get_mut(job_id)?;
        if entry.progress.stage.is_terminal() {
            return None;
        }
        let before = entry.progress.stage;
        f(&mut entry.progress);
        let now = Instant::now();
        let stage_changed = entry.progress.stage != before;
        let terminal = entry.progress.stage.is_terminal();
        let min_gap = Duration::from_millis(1000 / u64::from(MAX_EVENTS_PER_SEC));
        let due = entry
            .last_emit
            .is_none_or(|at| now.duration_since(at) >= min_gap);
        if !(stage_changed || terminal || due) {
            return None;
        }
        entry.last_emit = Some(now);
        let out = entry.progress.clone();
        if terminal {
            inner.finished.push_back(job_id.to_owned());
            while inner.finished.len() > KEEP_FINISHED {
                if let Some(old) = inner.finished.pop_front() {
                    inner.jobs.remove(&old);
                }
            }
        }
        Some(out)
    }
}

/// The job's side: progress, cancellation and the end. Dropping a handle without finishing marks
/// the job failed (a panic in the job thread never leaves it "running").
pub struct JobHandle {
    registry: JobRegistry,
    job_id: String,
    cancel: Arc<AtomicBool>,
    sink: JobSink,
}

impl JobHandle {
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// A shareable flag for loops that only check for cancellation.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    fn apply(&self, f: impl FnOnce(&mut JobProgress)) {
        if let Some(p) = self.registry.update(&self.job_id, f) {
            (self.sink)(p);
        }
    }

    /// Enters a stage (always emitted).
    pub fn stage(&self, stage: JobStage, total: u64) {
        self.apply(|p| {
            p.stage = stage;
            p.done = 0;
            p.total = total;
        });
    }

    /// Progress within the stage (throttled).
    pub fn progress(&self, done: u64, total: u64) {
        self.apply(|p| {
            p.done = done;
            p.total = total;
        });
    }

    pub fn set_reused(&self, reused: bool) {
        // Not an event on its own: it goes out with the next stage.
        let mut inner = lock(&self.registry.inner);
        if let Some(e) = inner.jobs.get_mut(&self.job_id) {
            e.progress.reused = reused;
        }
    }

    /// Records what an OCR job did. Not an event on its own: it goes out with the next stage (the end).
    pub fn set_ocr(&self, info: OcrJobInfo) {
        let mut inner = lock(&self.registry.inner);
        if let Some(e) = inner.jobs.get_mut(&self.job_id) {
            e.progress.ocr = Some(info);
        }
    }

    pub fn done(self) {
        self.apply(|p| {
            p.stage = JobStage::Done;
            p.done = p.total;
        });
    }

    pub fn cancelled(self) {
        self.apply(|p| p.stage = JobStage::Cancelled);
    }

    pub fn failed(self, code: &str, message: &str) {
        self.apply(|p| {
            p.stage = JobStage::Failed;
            p.error = Some(JobError {
                code: code.to_owned(),
                message: message.to_owned(),
            });
        });
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // No-op when the job already ended (terminal stages are final).
        self.apply(|p| {
            p.stage = JobStage::Failed;
            p.error = Some(JobError {
                code: "internal".into(),
                message: "Erro interno do app.".into(),
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collector() -> (JobSink, Arc<Mutex<Vec<JobProgress>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = Arc::clone(&seen);
        (Arc::new(move |p| lock(&s).push(p)), seen)
    }

    #[test]
    fn one_job_per_book_and_kind() {
        let reg = JobRegistry::default();
        let (sink, seen) = collector();
        let Started::New(h) = reg.start(JobKind::VocabScan, "b", "s1", Arc::clone(&sink)) else {
            panic!("first start");
        };
        let Started::Running(p) = reg.start(JobKind::VocabScan, "b", "s2", Arc::clone(&sink))
        else {
            panic!("second start must return the running job");
        };
        assert_eq!(p.job_id, h.job_id());
        assert_eq!(p.scan_uid, "s1");
        assert!(matches!(
            reg.start(JobKind::VocabScan, "other", "s3", Arc::clone(&sink)),
            Started::New(_)
        ));
        let id = h.job_id().to_owned();
        h.stage(JobStage::Text, 10);
        for i in 0..100 {
            h.progress(i, 10);
        }
        h.done();
        let events = lock(&seen).clone();
        let mine: Vec<_> = events.iter().filter(|e| e.job_id == id).collect();
        assert!(mine.len() <= 4, "throttled: {}", mine.len());
        assert_eq!(mine.first().unwrap().stage, JobStage::Text);
        assert_eq!(mine.last().unwrap().stage, JobStage::Done);
        assert_eq!(reg.status(&id).unwrap().stage, JobStage::Done);
        assert!(matches!(
            reg.start(JobKind::VocabScan, "b", "s4", sink),
            Started::New(_)
        ));
    }

    #[test]
    fn ocr_jobs_have_their_own_stages_and_info() {
        let reg = JobRegistry::default();
        let (sink, seen) = collector();
        let Started::New(scan) = reg.start(JobKind::VocabScan, "b", "s", Arc::clone(&sink)) else {
            panic!("scan");
        };
        // Another kind for the same book is its own job.
        let Started::New(h) = reg.start(JobKind::Ocr, "b", "", Arc::clone(&sink)) else {
            panic!("ocr next to a scan");
        };
        let Started::Running(p) = reg.start(JobKind::Ocr, "b", "", Arc::clone(&sink)) else {
            panic!("one ocr per book");
        };
        assert_eq!(p.job_id, h.job_id());
        assert_eq!(
            reg.running_for(JobKind::Ocr, "b").map(|p| p.job_id),
            Some(h.job_id().to_owned())
        );
        let id = h.job_id().to_owned();
        h.stage(JobStage::Ocr, 3);
        for page in 1..=3 {
            h.progress(page, 3);
        }
        h.stage(JobStage::Writing, 1);
        let info = OcrJobInfo {
            words: 120,
            pages_read: 2,
            pages_skipped: 1,
            file_version: Some(2),
            ms_per_page: Some(1500),
        };
        h.set_ocr(info.clone());
        h.done();
        let events: Vec<_> = lock(&seen)
            .iter()
            .filter(|e| e.job_id == id)
            .cloned()
            .collect();
        let stages: Vec<_> = events.iter().map(|e| e.stage).collect();
        assert!(stages.starts_with(&[JobStage::Ocr]), "{stages:?}");
        assert!(stages.contains(&JobStage::Writing), "{stages:?}");
        assert_eq!(stages.last(), Some(&JobStage::Done));
        let last = events.last().unwrap();
        assert_eq!(last.ocr.as_ref(), Some(&info));
        assert_eq!(last.scan_uid, "");
        let json = serde_json::to_value(last).unwrap();
        assert_eq!(json["kind"], "ocr");
        assert_eq!(json["stage"], "done");
        assert_eq!(json["ocr"]["pagesRead"], 2);
        assert_eq!(json["ocr"]["msPerPage"], 1500);
        assert_eq!(json["ocr"]["fileVersion"], 2);
        assert_eq!(serde_json::to_value(JobStage::Writing).unwrap(), "writing");
        // Other jobs don't carry the field at all.
        scan.stage(JobStage::Text, 1);
        let json = serde_json::to_value(reg.status(scan.job_id()).unwrap()).unwrap();
        assert!(json.get("ocr").is_none(), "{json}");
        scan.done();
    }

    #[test]
    fn cancel_and_drop() {
        let reg = JobRegistry::default();
        let (sink, _) = collector();
        let Started::New(h) = reg.start(JobKind::VocabScan, "b", "s", Arc::clone(&sink)) else {
            panic!()
        };
        let id = h.job_id().to_owned();
        assert!(reg.cancel(&id));
        assert!(h.is_cancelled());
        h.cancelled();
        assert_eq!(reg.status(&id).unwrap().stage, JobStage::Cancelled);
        assert!(!reg.cancel(&id));
        let Started::New(h) = reg.start(JobKind::VocabScan, "b", "s", sink) else {
            panic!()
        };
        let id = h.job_id().to_owned();
        drop(h);
        let st = reg.status(&id).unwrap();
        assert_eq!(st.stage, JobStage::Failed);
        assert_eq!(st.error.unwrap().code, "internal");
    }
}
