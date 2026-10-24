// Mock of "Reconhecer texto" (spec 7.2, 15: `ocr_info`, `ocr_start`, `ocr_cancel`): a background job that walks the
// book's pages with `job://<id>` progress (stage `ocr`, then `writing`), at most 10 events per second, and then writes
// a new version of the PDF whose pages carry the scanned book's text (mock.ts makes the bytes). Cancel, failure and
// "models missing" behave like `app/src/ocr.rs`.
import {
  CoreError,
  type BookFormat,
  type CoreClient,
  type JobProgress,
  type OcrInfo,
  type OcrStarted,
  type OcrStatus,
} from '../types';
import { later, mockLatency } from './ankiData';
import { addJob, emitJob, jobById, runningJob, type MockJob } from './jobs';

/** What the OCR mock needs from the mock library (mock.ts). */
export interface OcrDeps {
  /** Throws `book_not_found` like the core. */
  book(uid: string): { format: BookFormat; pages: number; hasText: boolean; ocrStatus: OcrStatus };
  setStatus(uid: string, status: OcrStatus): void;
  /** Writes the recognized version (text layer on every page); returns its `fileVersion`. */
  writeRecognized(uid: string): number;
}

/** The core's errors (code + pt-BR message), verbatim from `app/src/ocr.rs`. */
export const OCR_ERRORS = {
  modelsMissing: () =>
    new CoreError(
      'ocr_models_missing',
      'Os modelos de reconhecimento de texto não foram encontrados nesta instalação.',
    ),
  notPdf: () => new CoreError('ocr_not_pdf', 'O reconhecimento de texto é só para PDFs.'),
  hasText: () => new CoreError('ocr_has_text', 'Este livro já tem texto; o reconhecimento de texto não é necessário.'),
  engine: () => new CoreError('pdf_ocr', 'Não foi possível carregar o reconhecimento de texto.'),
};

/** At most 10 progress events per second (spec 15). */
const MIN_STEP_MS = 100;

let modelsAvailable = true;
let pageDelayMs: number | null = null;
let failAtPage: number | null = null;
let nextJob = 1;
/** book uid → its last OCR job id of this run (`ocr_info.job` after the end). */
const lastJob = new Map<string, string>();

function stepMs(): number {
  return Math.max(MIN_STEP_MS, pageDelayMs ?? Math.round(mockLatency()));
}

function wait(): Promise<void> {
  return new Promise((r) => setTimeout(r, stepMs()));
}

function info(deps: OcrDeps, uid: string): OcrInfo {
  const book = deps.book(uid);
  const last = lastJob.get(uid);
  const job = runningJob('ocr', uid) ?? (last ? jobById(last) : undefined);
  return {
    available: book.format === 'pdf' && modelsAvailable,
    status: book.ocrStatus,
    hasText: book.hasText,
    pages: book.pages,
    job: job ? structuredClone(job.progress) : null,
    lastError: book.ocrStatus === 'failed' ? (job?.progress.error?.message ?? null) : null,
  };
}

/** Words the mock "recognizes" per page (the text layer of `writeRecognized`). */
const WORDS_PER_PAGE = 96;

async function run(deps: OcrDeps, job: MockJob, uid: string, pages: number): Promise<void> {
  const started = Date.now();
  const cancelled = () => {
    deps.setStatus(uid, 'none');
    emitJob(job, { stage: 'cancelled' });
  };
  const fail = (e: CoreError) => {
    deps.setStatus(uid, 'failed');
    emitJob(job, { stage: 'failed', error: { code: e.code, message: e.message } });
  };
  try {
    await wait();
    if (job.cancelled) return cancelled();
    emitJob(job, { stage: 'ocr', done: 0, total: pages });
    for (let page = 0; page < pages; page++) {
      await wait();
      if (job.cancelled) return cancelled();
      if (failAtPage !== null && page >= failAtPage) {
        failAtPage = null;
        return fail(OCR_ERRORS.engine());
      }
      emitJob(job, { done: page + 1 });
    }
    emitJob(job, { stage: 'writing', done: 0, total: 1 });
    await wait();
    if (job.cancelled) return cancelled();
    const fileVersion = deps.writeRecognized(uid);
    // What was done arrives with the end (like `JobProgress::ocr` in the core).
    emitJob(job, {
      stage: 'done',
      done: 1,
      total: 1,
      ocr: {
        words: pages * WORDS_PER_PAGE,
        pagesRead: pages,
        pagesSkipped: 0,
        fileVersion,
        msPerPage: Math.max(1, Math.round((Date.now() - started) / Math.max(1, pages))),
      },
    });
  } catch (e) {
    fail(e instanceof CoreError ? e : OCR_ERRORS.engine());
  }
}

function start(deps: OcrDeps, uid: string): OcrStarted {
  const book = deps.book(uid);
  if (book.format !== 'pdf') throw OCR_ERRORS.notPdf();
  if (!modelsAvailable) throw OCR_ERRORS.modelsMissing();
  if (book.hasText && book.ocrStatus !== 'failed' && book.ocrStatus !== 'running') throw OCR_ERRORS.hasText();
  const running = runningJob('ocr', uid);
  if (running) return { jobId: running.progress.jobId, alreadyRunning: true };
  const jobId = `ocr-${nextJob++}`;
  const job: MockJob = {
    progress: {
      jobId,
      kind: 'ocr',
      bookUid: uid,
      scanUid: '',
      stage: 'queued',
      done: 0,
      total: book.pages,
      reused: false,
      error: null,
    },
    cancelled: false,
    params: '',
  };
  addJob(job);
  lastJob.set(uid, jobId);
  deps.setStatus(uid, 'running');
  void run(deps, job, uid, book.pages);
  return { jobId, alreadyRunning: false };
}

export type OcrMockKeys = 'ocrInfo' | 'ocrStart' | 'ocrCancel';

export function createOcrMock(deps: OcrDeps): Pick<CoreClient, OcrMockKeys> {
  return {
    ocrInfo: (uid) => later(() => info(deps, uid)),
    ocrStart: (uid) => later(() => start(deps, uid)),
    ocrCancel: (uid) =>
      later(() => {
        deps.book(uid);
        const job = runningJob('ocr', uid);
        if (job) job.cancelled = true;
        return job !== undefined;
      }),
  };
}

/** `window.__leitorMock.ocr`. */
export interface MockOcrHandle {
  /** `false`: the OCR models are missing (`ocr_models_missing`). */
  setModelsAvailable(available: boolean): void;
  /** Time per recognized page (ms, at least 100); `null` restores the default (the mock latency). */
  setPageDelay(ms: number | null): void;
  /** The next job fails when it reaches this 0-based page (`pdf_ocr`); `null` clears it. */
  failAtPage(page: number | null): void;
  /** The last progress of a job (`null` when unknown). */
  job(jobId: string): JobProgress | null;
}

export const mockOcrHandle: MockOcrHandle = {
  setModelsAvailable(available) {
    modelsAvailable = available;
  },
  setPageDelay(ms) {
    pageDelayMs = ms;
  },
  failAtPage(page) {
    failAtPage = page;
  },
  job(jobId) {
    const j = jobById(jobId);
    return j ? structuredClone(j.progress) : null;
  },
};

export function resetOcr(): void {
  lastJob.clear();
  modelsAvailable = true;
  pageDelayMs = null;
  failAtPage = null;
}
