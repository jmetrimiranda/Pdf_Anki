// The main-thread side of the Python code cards (spec 11.4): one Pyodide worker (workers/python.worker.ts), created
// and preloaded on the first Python card shown (not at app start). Runs go one at a time; each has 5 s from the
// moment it is posted to a READY worker. On timeout (or a cancel) the worker is terminated — the only way to stop
// Python running in WebAssembly without cross-origin isolation — and a new one is created and preloaded for the
// next run.
import type { MainToPython, PythonRunRequest, PythonRunResult, PythonToMain } from '../../../workers/pythonProtocol';

export const DEFAULT_PYTHON_TIMEOUT_MS = 5_000;
/** Loading Pyodide (a ~13 MB interpreter, from disk) takes a few seconds; past this the load failed. */
export const PYTHON_LOAD_TIMEOUT_MS = 60_000;

/** What the manager needs from a Worker (a fake one in the tests). */
export interface WorkerLike {
  postMessage(m: MainToPython): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<PythonToMain>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export type PythonRun = Omit<PythonRunRequest, 'type' | 'id'>;

export type PythonOutcome =
  | { kind: 'result'; result: PythonRunResult; durationMs: number }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'cancelled' }
  /** Pyodide could not be loaded (missing files, CSP, out of memory…). */
  | { kind: 'loadError'; message: string }
  /** The harness itself failed (should not happen). */
  | { kind: 'runError'; message: string };

interface Slot {
  worker: WorkerLike;
  ready: Promise<void>;
  /** The handler of the run in flight (results are matched by id). */
  onRun: ((m: PythonToMain) => void) | null;
  failed: boolean;
}

export class PythonManager {
  private slot: Slot | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  /** Workers created so far (tests and the e2e check that a timeout recreates it). */
  created = 0;

  constructor(
    private readonly factory: WorkerFactory,
    private readonly timeoutMs: number = DEFAULT_PYTHON_TIMEOUT_MS,
    private readonly loadTimeoutMs: number = PYTHON_LOAD_TIMEOUT_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Creates and loads the worker when there is none (idempotent). */
  preload(): void {
    this.ensure();
  }

  /** The worker is loaded (or loading) — for the UI's "Carregando Python…". */
  get loading(): boolean {
    return this.slot !== null;
  }

  private ensure(): Slot {
    if (this.slot && !this.slot.failed) return this.slot;
    if (this.slot) this.drop(this.slot);
    const worker = this.factory();
    this.created += 1;
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A rejection nobody awaits yet (preload) must not be reported as unhandled.
    ready.catch(() => undefined);
    const slot: Slot = { worker, ready, onRun: null, failed: false };
    const fail = (message: string) => {
      slot.failed = true;
      rejectReady(new Error(message));
      slot.onRun?.({ type: 'loadError', message });
    };
    const timer = setTimeout(() => fail('timeout'), this.loadTimeoutMs);
    worker.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        clearTimeout(timer);
        resolveReady();
      } else if (m.type === 'loadError') {
        clearTimeout(timer);
        fail(m.message);
      } else {
        slot.onRun?.(m);
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      e.preventDefault?.();
      fail(e.message || 'worker error');
    };
    worker.postMessage({ type: 'preload' });
    this.slot = slot;
    return slot;
  }

  private drop(slot: Slot) {
    slot.onRun = null;
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.terminate();
    if (this.slot === slot) this.slot = null;
  }

  /** Terminates the worker and starts a fresh one (timeouts, cancels). */
  private recycle(slot: Slot) {
    this.drop(slot);
    this.ensure();
  }

  /** Runs one request (after the ones before it). */
  run(req: PythonRun, signal?: AbortSignal): Promise<PythonOutcome> {
    const next = this.queue.then(() => this.runNow(req, signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runNow(req: PythonRun, signal?: AbortSignal): Promise<PythonOutcome> {
    if (signal?.aborted) return { kind: 'cancelled' };
    const slot = this.ensure();
    const aborted = new Promise<'aborted'>((resolve) => {
      signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    try {
      const r = await Promise.race([slot.ready.then(() => 'ready' as const), aborted]);
      // Cancelled while loading: the load goes on for the next run.
      if (r === 'aborted') return { kind: 'cancelled' };
    } catch (e) {
      this.drop(slot);
      return { kind: 'loadError', message: e instanceof Error ? e.message : String(e) };
    }
    const id = this.nextId++;
    return new Promise<PythonOutcome>((resolve) => {
      const started = this.now();
      let done = false;
      const finish = (o: PythonOutcome, recycle: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        slot.onRun = null;
        if (recycle) this.recycle(slot);
        resolve(o);
      };
      const timer = setTimeout(
        () => finish({ kind: 'timeout', durationMs: Math.round(this.now() - started) }, true),
        this.timeoutMs,
      );
      signal?.addEventListener('abort', () => finish({ kind: 'cancelled' }, true), { once: true });
      slot.onRun = (m) => {
        if (m.type === 'result' && m.id === id)
          finish({ kind: 'result', result: m.result, durationMs: Math.round(this.now() - started) }, false);
        else if (m.type === 'runError' && m.id === id) finish({ kind: 'runError', message: m.message }, true);
        else if (m.type === 'loadError') finish({ kind: 'loadError', message: m.message }, true);
      };
      slot.worker.postMessage({ type: 'run', id, ...req });
    });
  }

  /** Stops everything (tests). */
  dispose(): void {
    if (this.slot) this.drop(this.slot);
  }
}

function createWorker(): WorkerLike {
  return new Worker(new URL('../../../workers/python.worker.ts', import.meta.url), {
    type: 'module',
    name: 'python',
  }) as unknown as WorkerLike;
}

let shared: PythonManager | null = null;

/** The app's Python manager (one worker for every Python card). */
export function pythonManager(): PythonManager {
  shared ??= new PythonManager(createWorker);
  return shared;
}

/** Replaces the shared manager (tests). */
export function setPythonManager(m: PythonManager | null): void {
  shared?.dispose();
  shared = m;
}
