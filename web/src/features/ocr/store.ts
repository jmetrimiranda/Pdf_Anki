// Text recognition jobs (spec 7.2) shared by every view of a book: the library item, the OCR dialog and the book
// panel's notice all read the same per-book state, so a job's progress events are subscribed to once and its end
// (toast, query refresh, PdfCraft reload) happens once.
import { core, CoreError, type JobProgress } from '../../lib/core/client';
import { leitorController } from '../leitor/instance';

/** Where a book's OCR is, as the UI shows it. */
export type OcrPhase = 'idle' | 'starting' | 'queued' | 'running' | 'writing' | 'done' | 'failed' | 'cancelled';

export interface OcrJobState {
  phase: OcrPhase;
  jobId: string | null;
  /** Pages recognised so far / pages to recognise (stage `ocr`). */
  done: number;
  total: number;
  /** pt-BR message of a failed run. */
  error: string | null;
}

export type OcrOutcome = 'done' | 'failed' | 'cancelled';

/** What the mounted UI does when a job ends (toast, query invalidation); see `registerOcrEffects`. */
export type OcrEffects = (uid: string, outcome: OcrOutcome, state: OcrJobState) => void;

export const IDLE: OcrJobState = Object.freeze({ phase: 'idle', jobId: null, done: 0, total: 0, error: null });

const MS_PER_PAGE_KEY = 'leitor.ocr.msPerPage';
/** Desktop estimate before any run measured this machine (spec 7.2: "alguns segundos por página"). */
export const DEFAULT_MS_PER_PAGE = 4000;

/** The last measured OCR time per page on this device, else the default. */
export function msPerPage(): number {
  try {
    const v = Number(localStorage.getItem(MS_PER_PAGE_KEY));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MS_PER_PAGE;
  } catch {
    return DEFAULT_MS_PER_PAGE;
  }
}

function rememberMsPerPage(ms: unknown) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
  try {
    localStorage.setItem(MS_PER_PAGE_KEY, String(Math.round(ms)));
  } catch {
    // Not persisted; the default estimate stays.
  }
}

/** Whole minutes for `pages` at the measured speed; 0 means "less than a minute". */
export function estimateMinutes(pages: number, perPage = msPerPage()): number {
  const ms = Math.max(0, pages) * perPage;
  return ms < 60_000 ? 0 : Math.ceil(ms / 60_000);
}

function messageOf(err: unknown): string | null {
  if (err instanceof CoreError || err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return null;
}

const isAlreadyRunning = (err: unknown) =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? /already_running/.test(err.code)
    : false;

const terminal = (p: OcrPhase) => p === 'done' || p === 'failed' || p === 'cancelled';

interface Entry {
  state: OcrJobState;
  unlisten: (() => void) | null;
}

export class OcrStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private effects: OcrEffects[] = [];
  /** Ends that happened while no view was mounted: delivered to the next one that registers. */
  private pending: [string, OcrOutcome, OcrJobState][] = [];

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  get(uid: string): OcrJobState {
    return this.entries.get(uid)?.state ?? IDLE;
  }

  /** Any book with a job that hasn't ended. */
  active(): string[] {
    return [...this.entries].filter(([, e]) => e.state.phase !== 'idle' && !terminal(e.state.phase)).map(([u]) => u);
  }

  /** The latest registration handles job ends; returns the unregister function. */
  registerEffects(fx: OcrEffects): () => void {
    this.effects.push(fx);
    const pending = this.pending.splice(0);
    for (const [uid, outcome, state] of pending) fx(uid, outcome, state);
    return () => {
      const i = this.effects.lastIndexOf(fx);
      if (i >= 0) this.effects.splice(i, 1);
    };
  }

  private set(uid: string, state: OcrJobState) {
    const entry = this.entries.get(uid) ?? { state: IDLE, unlisten: null };
    entry.state = state;
    this.entries.set(uid, entry);
    for (const cb of [...this.listeners]) cb();
  }

  /**
   * "Reconhecer texto": saves PdfCraft's pending edits first (the OCR version is built on the latest annotations),
   * then starts the job in the core, or attaches to the one already running for the book.
   */
  async start(uid: string): Promise<void> {
    const phase = this.get(uid).phase;
    if (phase !== 'idle' && !terminal(phase)) return;
    this.set(uid, { ...IDLE, phase: 'starting' });
    try {
      await leitorController().flushSaves('manual');
      let jobId: string;
      try {
        // A second start returns the job already running for the book (`alreadyRunning`): the same job is followed.
        jobId = (await core.ocrStart(uid)).jobId;
      } catch (err) {
        if (!isAlreadyRunning(err)) throw err;
        const job = (await core.ocrInfo(uid)).job;
        if (!job) throw err;
        jobId = job.jobId;
      }
      this.attach(uid, jobId);
    } catch (err) {
      this.finish(uid, { ...IDLE, phase: 'failed', error: messageOf(err) });
    }
  }

  /** Follows `jobId` (a job started here, or found by `ocr_info` after a reload). */
  attach(uid: string, jobId: string): void {
    const entry = this.entries.get(uid);
    if (entry?.state.jobId === jobId && entry.unlisten) return;
    entry?.unlisten?.();
    const prev = this.get(uid);
    this.set(uid, {
      ...IDLE,
      phase: prev.phase === 'running' || prev.phase === 'writing' ? prev.phase : 'queued',
      jobId,
      total: prev.total,
    });
    // `onJobProgress` may deliver synchronously (a finished job's status): store the unlisten function first.
    const current = this.entries.get(uid)!;
    let ended = false;
    const stop = core.onJobProgress(jobId, (p) => {
      if (this.entries.get(uid)?.state.jobId !== jobId) return;
      ended = this.progress(uid, p) || ended;
    });
    if (ended) stop();
    else current.unlisten = stop;
  }

  /** Applies one event; true when the job ended. */
  private progress(uid: string, p: JobProgress): boolean {
    const prev = this.get(uid);
    const base = { ...prev, jobId: p.jobId, done: p.done, total: p.total || prev.total, error: null };
    switch (p.stage) {
      case 'queued':
        this.set(uid, { ...base, phase: 'queued' });
        return false;
      case 'writing':
        this.set(uid, { ...base, phase: 'writing' });
        return false;
      case 'done':
        rememberMsPerPage(p.ocr?.msPerPage);
        this.finish(uid, { ...base, phase: 'done', done: base.total });
        return true;
      case 'failed':
        this.finish(uid, { ...base, phase: 'failed', error: p.error?.message ?? null });
        return true;
      case 'cancelled':
        this.finish(uid, { ...base, phase: 'cancelled' });
        return true;
      default:
        // `ocr`: pages are being recognised.
        this.set(uid, { ...base, phase: 'running' });
        return false;
    }
  }

  private finish(uid: string, state: OcrJobState) {
    const entry = this.entries.get(uid);
    entry?.unlisten?.();
    if (entry) entry.unlisten = null;
    this.set(uid, state);
    const outcome = state.phase as OcrOutcome;
    if (outcome === 'done') {
      // An open PdfCraft tab shows the old file until it reopens the book's new version.
      void Promise.resolve()
        .then(() => leitorController().reloadPdfcraftBook(uid))
        .catch(() => undefined);
    }
    const fx = this.effects[this.effects.length - 1];
    if (fx) fx(uid, outcome, state);
    else this.pending.push([uid, outcome, state]);
  }

  /** "Cancelar": the core stops after the current page and reports `cancelled`. */
  async cancel(uid: string): Promise<void> {
    const state = this.get(uid);
    if (!state.jobId || terminal(state.phase)) return;
    try {
      await core.ocrCancel(uid);
    } catch (err) {
      // The job may have ended meanwhile; its own event tells the outcome.
      if (!terminal(this.get(uid).phase)) throw err;
    }
  }

  /** Forgets an ended job (back to the offer). */
  dismiss(uid: string): void {
    if (terminal(this.get(uid).phase)) this.set(uid, IDLE);
  }

  /** Tests only. */
  reset(): void {
    for (const e of this.entries.values()) e.unlisten?.();
    this.entries.clear();
    this.effects = [];
    this.pending = [];
    for (const cb of [...this.listeners]) cb();
  }
}

export const ocrStore = new OcrStore();
