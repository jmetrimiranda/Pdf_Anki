// The mock's background jobs (spec 15: `job://<id>`, `job_status`, `job_cancel`), shared by the vocabulary scan
// (mock/vocab.ts) and OCR (mock/ocr.ts). Like `app/src/jobs.rs`: progress goes to the job's listeners, `jobStatus`
// answers with the last progress, `jobCancel` flags the job (its runner stops at the next step).
import type { CoreClient, JobProgress } from '../types';
import { listenTo } from './ankiData';

export interface MockJob {
  progress: JobProgress;
  cancelled: boolean;
  /** What the job was started with, to tell another request apart (vocabulary scans). */
  params: string;
}

const jobs = new Map<string, MockJob>();
const listeners = new Map<string, Set<(p: JobProgress) => void>>();

export const FINISHED_STAGES: readonly JobProgress['stage'][] = ['done', 'failed', 'cancelled'];

export function isFinished(job: MockJob): boolean {
  return FINISHED_STAGES.includes(job.progress.stage);
}

export function addJob(job: MockJob): void {
  jobs.set(job.progress.jobId, job);
}

export function jobById(jobId: string): MockJob | undefined {
  return jobs.get(jobId);
}

/** The running (not finished, not cancelled) job of `kind` for a book. */
export function runningJob(kind: JobProgress['kind'], bookUid: string): MockJob | undefined {
  return [...jobs.values()].find(
    (j) => j.progress.kind === kind && j.progress.bookUid === bookUid && !j.cancelled && !isFinished(j),
  );
}

/** Updates the job's progress and tells its listeners. */
export function emitJob(job: MockJob, patch: Partial<JobProgress>): void {
  job.progress = { ...job.progress, ...patch };
  const p = structuredClone(job.progress);
  for (const cb of [...(listeners.get(p.jobId) ?? [])]) cb(p);
}

export function clearJobs(): void {
  for (const j of jobs.values()) j.cancelled = true;
  jobs.clear();
}

export type JobMockKeys = 'jobStatus' | 'jobCancel' | 'onJobProgress';

export function createJobsMock(later: <T>(fn: () => T) => Promise<T>): Pick<CoreClient, JobMockKeys> {
  return {
    jobStatus: (jobId) =>
      later(() => {
        const job = jobs.get(jobId);
        return job ? structuredClone(job.progress) : null;
      }),
    jobCancel: (jobId) =>
      later(() => {
        const job = jobs.get(jobId);
        if (job) job.cancelled = true;
      }),
    onJobProgress: (jobId, cb) => {
      const set = listeners.get(jobId) ?? new Set();
      listeners.set(jobId, set);
      let stopped = false;
      const deliver = (p: JobProgress) => {
        if (!stopped) cb(p);
      };
      const stop = listenTo(set, deliver);
      // Like the Tauri client: ask once after subscribing (an early end is never missed).
      setTimeout(() => {
        const job = jobs.get(jobId);
        if (job) deliver(structuredClone(job.progress));
      }, 0);
      return () => {
        stopped = true;
        stop();
      };
    },
  };
}
