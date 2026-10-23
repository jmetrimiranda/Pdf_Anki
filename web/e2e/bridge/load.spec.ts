// How long the Leitor tab takes to show up (LEITOR_LOAD=1, projects load-chromium and load-webkit): the app in mock
// mode with the REAL PdfCraft web build. Click on the "Leitor" app tab → `pdfcraft:ready`, on the first opening of a
// session (cold: fresh browser context, empty HTTP cache; warm: same context, HTTP cache filled by an earlier page),
// and on later openings (Biblioteca/Anki → Leitor: the iframe must not reload; click → a frame painted in it).
// Numbers come from window.__leitorTimings (src/features/leitor/timings.ts) and the frame's Resource Timing.
// Results: test-results/load-<project>.json and a table in the output. No GPU here: WebGL is software.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type BrowserType, type Page } from '@playwright/test';
import { requirePdfcraftBuild, WEB_ROOT } from './helpers';

const RUNS = 5;
const viewport = { width: 1280, height: 820 };

interface FirstRun {
  mode: 'cold' | 'warm';
  /** Click on the tab → `pdfcraft:ready` received by the app. */
  clickToReadyMs: number;
  /** Click → the controller saw the activation (router + React). */
  clickToActivateMs: number;
  /** From the controller's activation (window.__leitorTimings 'first'). */
  activateToReadyMs: number;
  /** Activation → iframe document start → .wasm response end → trunk's init() resolved (compile + instantiate). */
  frameStartMs: number | null;
  wasmFetchedMs: number | null;
  wasmInitDoneMs: number | null;
  /** Bytes over the network for the .wasm (0: from cache; WebKit may not report it). */
  wasmTransferKB: number | null;
}

interface AgainRun {
  via: string;
  /** Click on the tab → a frame painted inside the visible iframe. */
  clickToPaintMs: number;
  /** The controller's own number (activation → painted). */
  activateToPaintMs: number;
}

/** Runs in every frame: when trunk's init() resolved (iframe) and every `pdfcraft:ready` (top). */
function probe() {
  const w = window as unknown as { __trunkAbs?: number; __readyAbs?: number[]; __probeOn?: boolean };
  if (w.__probeOn) return;
  w.__probeOn = true;
  w.__readyAbs = [];
  addEventListener('TrunkApplicationStarted', () => (w.__trunkAbs = performance.timeOrigin + performance.now()));
  addEventListener('message', (e: MessageEvent) => {
    if (window.parent === window && (e.data as { type?: string } | null)?.type === 'pdfcraft:ready') {
      w.__readyAbs!.push(performance.timeOrigin + performance.now());
    }
  });
  // The click as the page saw it (event time), for every tab click.
  addEventListener(
    'click',
    (e) => ((window as unknown as { __clickAbs?: number }).__clickAbs = performance.timeOrigin + e.timeStamp),
    { capture: true },
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function stats(xs: (number | null)[]) {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { n: v.length, median: round1(median), min: v[0]!, max: v.at(-1)! };
}

async function newContext(browser: Browser, disableCache: boolean): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(probe);
  if (disableCache && browser.browserType().name() === 'chromium') {
    // A fresh context already starts with an empty cache; make it explicit where the protocol allows it.
    ctx.on('page', async (p) => {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    });
  }
  return ctx;
}

/**
 * A context with an on-disk profile: the ephemeral contexts keep their HTTP cache in memory, and Chromium's memory
 * cache does not keep a 40 MB response, so a "warm" opening needs a real profile (as the installed app has).
 */
async function persistentContext(type: BrowserType, dir: string): Promise<BrowserContext> {
  const launch = test.info().project.use.launchOptions ?? {};
  const ctx = await type.launchPersistentContext(dir, { ...launch, viewport });
  await ctx.addInitScript(probe);
  return ctx;
}

function tab(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Abas' }).getByRole('link', { name, exact: true });
}

async function openLibrary(page: Page) {
  await page.goto('/biblioteca');
  await expect(tab(page, 'Leitor')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

/** First opening of the Leitor in this page: click → ready, with the iframe's load breakdown. */
async function firstOpening(page: Page, mode: FirstRun['mode']): Promise<FirstRun> {
  await openLibrary(page);
  expect(await page.locator('iframe[title="PdfCraft"]').count(), 'no iframe before the first visit').toBe(0);
  await tab(page, 'Leitor').click();
  await page.waitForFunction(() => window.__leitorTimings?.some((t) => t.kind === 'first'), null, {
    timeout: 120_000,
  });
  return page.evaluate((mode) => {
    const w = window as unknown as { __clickAbs: number; __readyAbs: number[] };
    const first = window.__leitorTimings!.find((t) => t.kind === 'first')!;
    const activate = performance.timeOrigin + performance.getEntriesByName('leitor:activate')[0]!.startTime;
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="PdfCraft"]')!.contentWindow!;
    const trunk = (frame as unknown as { __trunkAbs?: number }).__trunkAbs;
    const wasm = frame.performance.getEntriesByType('resource').find((e) => e.name.endsWith('.wasm')) as
      PerformanceResourceTiming | undefined;
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      mode,
      clickToReadyMs: r(w.__readyAbs[0]! - w.__clickAbs),
      clickToActivateMs: r(activate - w.__clickAbs),
      activateToReadyMs: first.ms,
      frameStartMs: first.frameStartMs ?? null,
      wasmFetchedMs: first.wasmFetchedMs ?? null,
      wasmInitDoneMs: trunk ? r(trunk - activate) : null,
      wasmTransferKB: wasm && wasm.transferSize >= 0 ? r(wasm.transferSize / 1024) : null,
    };
  }, mode);
}

/** Leaves the Leitor for `via` and comes back, checking the iframe was not reloaded. */
async function againOpening(page: Page, via: string): Promise<AgainRun> {
  const host = page.getByTestId('leitor-host');
  await tab(page, via).click();
  await expect(host).toHaveAttribute('data-visible', 'false');
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => window.__leitorTimings!.filter((t) => t.kind === 'again').length);
  await tab(page, 'Leitor').click();
  await expect(host).toHaveAttribute('data-visible', 'true');
  await page.waitForFunction((n) => window.__leitorTimings!.filter((t) => t.kind === 'again').length > n, before, {
    timeout: 30_000,
  });
  return page.evaluate((via) => {
    const w = window as unknown as { __clickAbs: number };
    const painted = performance.getEntriesByName('leitor:again-painted').at(-1)!;
    const again = window.__leitorTimings!.filter((t) => t.kind === 'again').at(-1)!;
    return {
      via,
      clickToPaintMs: Math.round((performance.timeOrigin + painted.startTime - w.__clickAbs) * 10) / 10,
      activateToPaintMs: again.ms,
    };
  }, via);
}

/** Marks the iframe's document; `same()` tells whether it is still that document, element and single ready. */
async function markFrame(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe[title="PdfCraft"]')!;
    const w = window as unknown as { __iframeEl: unknown; __frameOrigin: number };
    w.__iframeEl = el;
    w.__frameOrigin = el.contentWindow!.performance.timeOrigin;
    (el.contentWindow as unknown as { __leitorMarker: string }).__leitorMarker = 'still-here';
  });
  return () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLIFrameElement>('iframe[title="PdfCraft"]')!;
      const w = window as unknown as { __iframeEl: unknown; __frameOrigin: number; __readyAbs: number[] };
      return {
        sameElement: el === w.__iframeEl,
        marker: (el.contentWindow as unknown as { __leitorMarker?: string }).__leitorMarker ?? null,
        sameDocument: el.contentWindow!.performance.timeOrigin === w.__frameOrigin,
        readyCount: w.__readyAbs.length,
        firstCount: window.__leitorTimings!.filter((t) => t.kind === 'first').length,
      };
    });
}

test('Leitor tab: first and later openings', async ({ browser, playwright, browserName }) => {
  requirePdfcraftBuild();
  test.setTimeout(1_200_000);
  const project = test.info().project.name;

  // Warm-up (not counted): Vite transforms the app's modules once.
  {
    const ctx = await newContext(browser, false);
    const page = await ctx.newPage();
    await firstOpening(page, 'warm');
    await ctx.close();
  }

  const first: FirstRun[] = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await newContext(browser, true);
    const page = await ctx.newPage();
    first.push(await firstOpening(page, 'cold'));
    await ctx.close();
  }

  // Warm: one profile; a first page fills the HTTP cache (and the compiled-wasm cache, where the engine has one).
  const profile = mkdtempSync(path.join(tmpdir(), 'leitor-load-'));
  const warmCtx = await persistentContext(playwright[browserName], profile);
  {
    const page = await warmCtx.newPage();
    await firstOpening(page, 'warm');
    await page.close();
  }
  for (let i = 0; i < RUNS; i++) {
    const page = await warmCtx.newPage();
    first.push(await firstOpening(page, 'warm'));
    await page.close();
  }

  // Later openings, in a page whose Leitor is ready.
  const page = await warmCtx.newPage();
  await firstOpening(page, 'warm');
  const check = await markFrame(page);
  const again: AgainRun[] = [];
  for (let i = 0; i < RUNS; i++) again.push(await againOpening(page, i % 2 ? 'Anki' : 'Biblioteca'));
  const after = await check();
  expect(after, 'the iframe was not reloaded by switching tabs').toEqual({
    sameElement: true,
    marker: 'still-here',
    sameDocument: true,
    readyCount: 1,
    firstCount: 1,
  });
  await warmCtx.close();
  rmSync(profile, { recursive: true, force: true });

  const cold = first.filter((r) => r.mode === 'cold');
  const warm = first.filter((r) => r.mode === 'warm');
  const row = (name: string, xs: (number | null)[]) => ({ metric: name, ...stats(xs) });
  const table = [
    row(
      'cold: click → ready',
      cold.map((r) => r.clickToReadyMs),
    ),
    row(
      'cold: click → activation',
      cold.map((r) => r.clickToActivateMs),
    ),
    row(
      'cold: activation → iframe doc start',
      cold.map((r) => r.frameStartMs),
    ),
    row(
      'cold: activation → wasm fetched',
      cold.map((r) => r.wasmFetchedMs),
    ),
    row(
      'cold: activation → wasm init done',
      cold.map((r) => r.wasmInitDoneMs),
    ),
    row(
      'cold: activation → ready',
      cold.map((r) => r.activateToReadyMs),
    ),
    row(
      'cold: wasm transfer KB',
      cold.map((r) => r.wasmTransferKB),
    ),
    row(
      'warm: click → ready',
      warm.map((r) => r.clickToReadyMs),
    ),
    row(
      'warm: click → activation',
      warm.map((r) => r.clickToActivateMs),
    ),
    row(
      'warm: activation → iframe doc start',
      warm.map((r) => r.frameStartMs),
    ),
    row(
      'warm: activation → wasm fetched',
      warm.map((r) => r.wasmFetchedMs),
    ),
    row(
      'warm: activation → wasm init done',
      warm.map((r) => r.wasmInitDoneMs),
    ),
    row(
      'warm: activation → ready',
      warm.map((r) => r.activateToReadyMs),
    ),
    row(
      'warm: wasm transfer KB',
      warm.map((r) => r.wasmTransferKB),
    ),
    row(
      'again: click → painted',
      again.map((r) => r.clickToPaintMs),
    ),
    row(
      'again: activation → painted',
      again.map((r) => r.activateToPaintMs),
    ),
  ];
  console.log(`\n${project} (${browser.version()}), software WebGL, ${RUNS} runs each`);
  console.table(table);
  mkdirSync(path.join(WEB_ROOT, 'test-results'), { recursive: true });
  writeFileSync(
    path.join(WEB_ROOT, 'test-results', `load-${project}.json`),
    JSON.stringify({ project, browser: browser.version(), table, first, again, at: new Date().toISOString() }, null, 2),
  );

  expect(cold).toHaveLength(RUNS);
  expect(warm).toHaveLength(RUNS);
  expect(again).toHaveLength(RUNS);
});
