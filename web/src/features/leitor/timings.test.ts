import { describe, expect, it } from 'vitest';
import { LeitorController } from './controller';
import { fakeCore, fakeFrame, fakeHost, ORIGIN } from './testing';
import { frameLoad, LeitorTimings, MAX_TIMINGS, type TimingsEnv } from './timings';

function env() {
  let t = 1_000;
  const marks: string[] = [];
  const paints: (() => void)[] = [];
  const e: TimingsEnv = {
    now: () => t,
    mark: (n) => void marks.push(n),
    measure: (n) => void marks.push(`measure:${n}`),
    afterPaint: (_win, cb) => void paints.push(cb),
  };
  return { e, marks, paints, advance: (ms: number) => (t += ms) };
}

const WIN = {} as Window;

describe('LeitorTimings', () => {
  it('times the first opening once, with the iframe load breakdown', () => {
    const { e, marks, advance } = env();
    const t = new LeitorTimings(e);
    t.mounting();
    advance(10);
    t.mounting(); // a second mount call does not move the start
    advance(1_490);
    t.ready({ documentStart: 1_050, wasmFetched: 1_400 });
    advance(100);
    t.ready(null); // a later ready (reload) is not a first opening
    expect(t.entries()).toEqual([{ kind: 'first', ms: 1_500, frameStartMs: 50, wasmFetchedMs: 400 }]);
    expect(marks).toEqual(['leitor:activate', 'leitor:ready', 'measure:leitor:first-open']);
  });

  it('ignores ready without a mount, and shown before ready', () => {
    const { e, paints } = env();
    const t = new LeitorTimings(e);
    t.ready(null);
    t.mounting();
    t.shown(WIN);
    expect(paints).toHaveLength(0);
    expect(t.entries()).toEqual([]);
  });

  it('times later openings until the iframe painted', () => {
    const { e, paints, advance } = env();
    const t = new LeitorTimings(e);
    t.mounting();
    t.ready(null);
    t.hidden();
    t.shown(WIN);
    advance(33.33);
    paints.shift()!();
    expect(t.entries().at(-1)).toEqual({ kind: 'again', ms: 33.3 });
  });

  it('drops an opening hidden again before the paint, and a missing frame', () => {
    const { e, paints } = env();
    const t = new LeitorTimings(e);
    t.mounting();
    t.ready(null);
    t.shown(WIN);
    t.hidden();
    paints.shift()!();
    t.shown(null);
    expect(t.entries().map((x) => x.kind)).toEqual(['first']);
  });

  it('returns copies and keeps a bounded log', () => {
    const { e, paints } = env();
    const t = new LeitorTimings(e);
    t.mounting();
    t.ready(null);
    for (let i = 0; i < MAX_TIMINGS + 5; i++) {
      t.shown(WIN);
      paints.shift()!();
    }
    const list = t.entries();
    expect(list).toHaveLength(MAX_TIMINGS);
    list[0]!.ms = -1;
    expect(t.entries()[0]!.ms).not.toBe(-1);
  });

  it('survives an afterPaint that throws', () => {
    const { e } = env();
    const t = new LeitorTimings({
      ...e,
      afterPaint: () => {
        throw new Error('gone');
      },
    });
    t.mounting();
    t.ready(null);
    expect(() => t.shown(WIN)).not.toThrow();
  });
});

describe('frameLoad', () => {
  it('reads the document start and the wasm response end', () => {
    const win = {
      performance: {
        timeOrigin: 5_000,
        getEntriesByType: () => [
          { name: 'http://x/pdfcraft/a.js', responseEnd: 10 },
          { name: 'http://x/pdfcraft/a_bg.wasm', responseEnd: 300 },
        ],
      },
    } as unknown as Window;
    expect(frameLoad(win)).toEqual({ documentStart: 5_000, wasmFetched: 5_300 });
    expect(frameLoad(null)).toBeNull();
    expect(frameLoad({} as Window)).toBeNull();
  });
});

describe('LeitorController wiring', () => {
  it('records first on mount → ready and again on a later show', () => {
    const { e, paints, advance } = env();
    const timings = new LeitorTimings(e);
    const { host, deliver } = fakeHost();
    const frame = fakeFrame();
    const c = new LeitorController({ core: fakeCore(), origin: ORIGIN, host, timings, storage: null });
    c.mount();
    c.setVisible(true);
    c.setFrameWindow(frame.win as unknown as Window);
    advance(800);
    deliver({ type: 'pdfcraft:ready', version: '0.9', bridge: 1 }, frame.win);
    c.setVisible(false);
    c.setVisible(true);
    advance(20);
    paints.shift()!();
    expect(timings.entries().map((x) => [x.kind, x.ms])).toEqual([
      ['first', 800],
      ['again', 20],
    ]);
  });
});
