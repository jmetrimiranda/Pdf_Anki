// Phase 1 acceptance 4 (LEITOR_PERF=1, projects perf-chromium and perf-webkit): a 500-page PDF opens and scrolls in the app as fast
// as in PdfCraft web alone. (A) e2e/bridge/harness.html: PdfCraft in a bare same-origin iframe. (B) the app's Leitor.
// Same browser context (same PdfCraft settings), same iframe size, same bytes. Results: test-results/perf-<project>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { makePdf } from '../../src/lib/pdf/minimalPdf';
import { expect, importBytes, test, WEB_ROOT, writeFixture, type Logged } from './helpers';

const PAGES = 500;
const SCROLL_PAGES = 200;
const HARNESS_ID = 'f'.repeat(64);
const ROUNDS = 3;

interface Run {
  scenario: 'harness' | 'app';
  openToActiveMs: number;
  openToStableMs: number;
  scroll: { frames: number; p50: number; p95: number; longFrames: number; durationMs: number; pagesScrolled: number };
  jsHeapBeforeMB: number | null;
  jsHeapAfterMB: number | null;
  wasmMemoryMB: number | null;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function frameOf(page: Page): Promise<Frame> {
  await page.waitForSelector('iframe[title="PdfCraft"]', { state: 'attached', timeout: 60_000 });
  let f: Frame | undefined;
  await expect
    .poll(() => (f = page.frames().find((x) => x.url().includes('/pdfcraft/'))) !== undefined, { timeout: 60_000 })
    .toBe(true);
  return f!;
}

async function heapMB(frame: Frame): Promise<number | null> {
  return frame.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null;
  });
}

async function wasmMB(frame: Frame): Promise<number | null> {
  return frame.evaluate(() => {
    const w = (window as unknown as { __wasm?: { memory?: WebAssembly.Memory } }).__wasm;
    return w?.memory ? Math.round((w.memory.buffer.byteLength / 1048576) * 10) / 10 : null;
  });
}

/** Measures one PdfCraft (harness or app) from the moment it receives `open` for `id`. */
async function measure(page: Page, scenario: Run['scenario'], id: string): Promise<Run> {
  const frame = await frameOf(page);
  const el = await frame.frameElement();
  const box = (await el.boundingBox())!;

  // open received inside the iframe → active received by the parent (absolute clocks).
  const hostLog = () => frame.evaluate(() => (window as unknown as { __fromHost: Logged[] }).__fromHost);
  const parentLog = () => page.evaluate(() => (window as unknown as { __fromPdfcraft: Logged[] }).__fromPdfcraft);
  let openAbs = 0;
  await expect
    .poll(
      async () => {
        openAbs = (await hostLog()).find((m) => m.type === 'pdfcraft:open' && m.id === id)?.abs ?? 0;
        return openAbs;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  const heapBefore = await heapMB(frame);

  // First settled frame: two identical screenshots in a row after `active`.
  let last: Buffer | null = null;
  let stableAbs = 0;
  let activeAbs = 0;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (!activeAbs) activeAbs = (await parentLog()).find((m) => m.type === 'pdfcraft:active' && m.id === id)?.abs ?? 0;
    const at = await page.evaluate(() => performance.timeOrigin + performance.now());
    const shot = await el.screenshot({ animations: 'allow', caret: 'initial' });
    if (activeAbs && last?.equals(shot)) {
      stableAbs = at;
      break;
    }
    last = shot;
    await page.waitForTimeout(50);
  }
  expect(activeAbs, `${scenario}: active`).toBeGreaterThan(0);
  expect(stableAbs, `${scenario}: settled frame`).toBeGreaterThan(0);

  // Scroll SCROLL_PAGES pages with the wheel while recording frame times inside the iframe.
  const startPage = (await parentLog()).filter((m) => m.type === 'pdfcraft:active' && m.id === id).at(-1)?.page ?? 0;
  await frame.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rec: boolean };
    w.__frames = [];
    w.__rec = true;
    const loop = (t: number) => {
      w.__frames.push(t);
      if (w.__rec) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  const t0 = Date.now();
  let reached = startPage;
  for (let i = 0; i < 400 && reached - startPage < SCROLL_PAGES; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(16);
    if (i % 10 === 9) {
      reached = (await parentLog()).filter((m) => m.type === 'pdfcraft:page' && m.id === id).at(-1)?.page ?? reached;
    }
  }
  await page.waitForTimeout(800);
  const durationMs = Date.now() - t0;
  reached = (await parentLog()).filter((m) => m.type === 'pdfcraft:page' && m.id === id).at(-1)?.page ?? reached;
  const frames = await frame.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rec: boolean };
    w.__rec = false;
    return w.__frames;
  });
  const deltas = frames.slice(1).map((t, i) => t - frames[i]!);
  return {
    scenario,
    openToActiveMs: round1(activeAbs - openAbs),
    openToStableMs: round1(stableAbs - openAbs),
    scroll: {
      frames: frames.length,
      p50: round1(percentile(deltas, 50)),
      p95: round1(percentile(deltas, 95)),
      longFrames: deltas.filter((d) => d > 50).length,
      durationMs,
      pagesScrolled: reached - startPage,
    },
    jsHeapBeforeMB: heapBefore,
    jsHeapAfterMB: await heapMB(frame),
    wasmMemoryMB: await wasmMB(frame),
  };
}

function median(runs: Run[], pick: (r: Run) => number): number {
  return round1(percentile(runs.map(pick), 50));
}

test('500-page PDF: the app opens and scrolls as fast as PdfCraft web alone', async ({ page, context }) => {
  test.setTimeout(900_000);
  const bytes = makePdf({ pages: PAGES, title: 'Livro de 500 páginas', outline: true });
  const url = writeFixture('perf-500.pdf', bytes);
  const view = { width: 960, height: 776 };

  // Seed the book once. The mock keeps its library in this tab's sessionStorage, so the app runs always reuse `page`
  // (parked on about:blank while the harness runs).
  await page.goto('/biblioteca');
  const uid = await importBytes(page, '/home/jorge/Livros/perf-500.pdf', bytes);
  await page.goto('about:blank');

  const runs: Run[] = [];
  for (let round = 0; round < ROUNDS + 1; round++) {
    // (A) harness, at the size of the app's iframe.
    const a = await context.newPage();
    await a.setViewportSize(view);
    await a.goto(`/e2e/bridge/harness.html?file=${encodeURIComponent(url)}&id=${HARNESS_ID}`);
    const ra = await measure(a, 'harness', HARNESS_ID);
    await a.close();
    // (B) the app, opening the book through /leitor?livro= (the same path as a click in the Biblioteca).
    await page.goto(`/leitor?livro=${uid}`);
    const rb = await measure(page, 'app', uid);
    await page.goto('about:blank');
    // Round 0 warms the caches (wasm compile, fonts) for both; it is not counted.
    if (round > 0) runs.push(ra, rb);
  }

  const A = runs.filter((r) => r.scenario === 'harness');
  const B = runs.filter((r) => r.scenario === 'app');
  const summary = {
    pages: PAGES,
    bytes: bytes.length,
    scrollPages: SCROLL_PAGES,
    viewport: view,
    rounds: ROUNDS,
    harness: {
      openToActiveMs: median(A, (r) => r.openToActiveMs),
      openToStableMs: median(A, (r) => r.openToStableMs),
      scrollP50: median(A, (r) => r.scroll.p50),
      scrollP95: median(A, (r) => r.scroll.p95),
      longFrames: median(A, (r) => r.scroll.longFrames),
      wasmMemoryMB: median(A, (r) => r.wasmMemoryMB ?? 0),
      jsHeapAfterMB: median(A, (r) => r.jsHeapAfterMB ?? 0),
    },
    app: {
      openToActiveMs: median(B, (r) => r.openToActiveMs),
      openToStableMs: median(B, (r) => r.openToStableMs),
      scrollP50: median(B, (r) => r.scroll.p50),
      scrollP95: median(B, (r) => r.scroll.p95),
      longFrames: median(B, (r) => r.scroll.longFrames),
      wasmMemoryMB: median(B, (r) => r.wasmMemoryMB ?? 0),
      jsHeapAfterMB: median(B, (r) => r.jsHeapAfterMB ?? 0),
    },
    runs,
    browser: `${test.info().project.name} (${page.context().browser()?.version() ?? '?'})`,
    at: new Date().toISOString(),
  };
  mkdirSync(path.join(WEB_ROOT, 'test-results'), { recursive: true });
  writeFileSync(
    path.join(WEB_ROOT, 'test-results', `perf-${test.info().project.name}.json`),
    JSON.stringify(summary, null, 2),
  );
  const rows = (Object.keys(summary.harness) as (keyof typeof summary.harness)[]).map((k) => ({
    metric: k,
    harness: summary.harness[k],
    app: summary.app[k],
  }));
  console.table(rows);

  // The app may not make PdfCraft slower: B <= A × 1.15 + 50 ms.
  const limit = (x: number) => x * 1.15 + 50;
  expect(summary.app.openToActiveMs).toBeLessThanOrEqual(limit(summary.harness.openToActiveMs));
  expect(summary.app.openToStableMs).toBeLessThanOrEqual(limit(summary.harness.openToStableMs));
  expect(summary.app.scrollP50).toBeLessThanOrEqual(limit(summary.harness.scrollP50));
  expect(summary.app.scrollP95).toBeLessThanOrEqual(limit(summary.harness.scrollP95));
  for (const r of runs)
    expect(r.scroll.pagesScrolled, `${r.scenario} scrolled`).toBeGreaterThanOrEqual(SCROLL_PAGES * 0.9);
});
