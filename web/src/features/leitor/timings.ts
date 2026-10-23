// How long the Leitor tab takes to show up, kept as a tiny read-only log (window.__leitorTimings) and as
// performance marks/measures (`leitor:*`), so e2e specs and the real-app probe can read them.
//   first: tab activation that mounts the iframe → `pdfcraft:ready` (+ when the iframe document and the wasm arrived)
//   again: activation of the already-ready tab → a frame painted inside the now visible iframe (no reload)

export interface LeitorTiming {
  kind: 'first' | 'again';
  ms: number;
  /** first only, ms after activation: the iframe document started loading / the .wasm response ended (null: unknown). */
  frameStartMs?: number | null;
  wasmFetchedMs?: number | null;
}

/** Absolute times (ms since epoch, `timeOrigin + now()`), comparable across the app and the iframe. */
export interface FrameLoad {
  documentStart: number | null;
  wasmFetched: number | null;
}

export interface TimingsEnv {
  /** Absolute time in ms (`performance.timeOrigin + performance.now()`). */
  now(): number;
  mark(name: string): void;
  measure(name: string, from: string, to: string): void;
  /** Calls `cb` once `win` has painted a frame (two rAFs: the first runs before the paint, the second after). */
  afterPaint(win: Window, cb: () => void): void;
}

export const MAX_TIMINGS = 50;

const round1 = (n: number) => Math.round(n * 10) / 10;

export class LeitorTimings {
  private readonly log: LeitorTiming[] = [];
  private firstFrom: number | null = null;
  private firstDone = false;
  private againSeq = 0;

  constructor(private readonly env: TimingsEnv = browserEnv) {}

  /** A copy, newest last. */
  entries(): LeitorTiming[] {
    return this.log.map((e) => ({ ...e }));
  }

  /** The activation that mounts the iframe (only the first call counts). */
  mounting() {
    if (this.firstFrom !== null) return;
    this.firstFrom = this.env.now();
    this.env.mark('leitor:activate');
  }

  /** `pdfcraft:ready` arrived; only the first one after `mounting` is recorded. */
  ready(load: FrameLoad | null = null) {
    if (this.firstFrom === null || this.firstDone) return;
    this.firstDone = true;
    const from = this.firstFrom;
    const rel = (t: number | null | undefined) => (t == null ? null : round1(t - from));
    this.env.mark('leitor:ready');
    this.env.measure('leitor:first-open', 'leitor:activate', 'leitor:ready');
    this.push({
      kind: 'first',
      ms: round1(this.env.now() - from),
      frameStartMs: rel(load?.documentStart),
      wasmFetchedMs: rel(load?.wasmFetched),
    });
  }

  /** The tab became visible again with PdfCraft already ready: time until the iframe paints. */
  shown(frame: Window | null) {
    if (!this.firstDone || !frame) return;
    const seq = ++this.againSeq;
    const from = this.env.now();
    this.env.mark('leitor:again');
    try {
      this.env.afterPaint(frame, () => {
        // Hidden again (or shown once more) before the frame came: that activation has no number.
        if (seq !== this.againSeq) return;
        this.env.mark('leitor:again-painted');
        this.env.measure('leitor:again-open', 'leitor:again', 'leitor:again-painted');
        this.push({ kind: 'again', ms: round1(this.env.now() - from) });
      });
    } catch {
      // The iframe's window went away: nothing to time.
    }
  }

  hidden() {
    this.againSeq++;
  }

  private push(e: LeitorTiming) {
    this.log.push(e);
    if (this.log.length > MAX_TIMINGS) this.log.shift();
  }
}

/** Reads, from the same-origin iframe, when its document started and when the .wasm finished downloading. */
export function frameLoad(win: Window | null): FrameLoad | null {
  try {
    const perf = win?.performance;
    if (!perf) return null;
    const origin = perf.timeOrigin;
    const wasm = perf.getEntriesByType('resource').find((e) => /\.wasm($|\?)/.test(e.name)) as
      PerformanceResourceTiming | undefined;
    return { documentStart: origin, wasmFetched: wasm && wasm.responseEnd > 0 ? origin + wasm.responseEnd : null };
  } catch {
    return null;
  }
}

const browserEnv: TimingsEnv = {
  now: () => performance.timeOrigin + performance.now(),
  mark: (name) => {
    try {
      performance.mark(name);
    } catch {
      // Marks are a debugging aid only.
    }
  },
  measure: (name, from, to) => {
    try {
      performance.measure(name, from, to);
    } catch {
      // Missing mark (cleared by someone): skip.
    }
  },
  afterPaint: (win, cb) => win.requestAnimationFrame(() => win.requestAnimationFrame(() => cb())),
};
