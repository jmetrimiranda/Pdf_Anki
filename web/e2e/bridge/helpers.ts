// Helpers for the bridge suites: they drive the app (mocked core) with the REAL PdfCraft web build in the iframe.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Frame, type Page } from '@playwright/test';
import { pdfcraftDir } from '../../vite-plugin-pdfcraft';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(here, '..', '..');
export const FIXTURES_DIR = path.join(WEB_ROOT, 'test-results', 'e2e-fixtures');
export const VISUAL_DIR = path.join(WEB_ROOT, 'test-results', 'visual');

/** Fails with a clear message when the PdfCraft web build is missing. */
export function requirePdfcraftBuild() {
  const dir = pdfcraftDir({}, WEB_ROOT);
  if (!existsSync(path.join(dir, 'index.html'))) {
    throw new Error(
      `PdfCraft web build missing in ${dir}: run scripts/build-pdfcraft-web.sh (inside the devcontainer) first.`,
    );
  }
}

/** Writes a file served at /__e2e__/<name> by the dev server (never committed). */
export function writeFixture(name: string, bytes: Uint8Array): string {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(path.join(FIXTURES_DIR, name), bytes);
  return `/__e2e__/${encodeURIComponent(name)}`;
}

/** A bridge message as recorded by the init script (bytes summarized). */
export interface Logged {
  type: string;
  /** performance.now() of the frame that recorded it. */
  at: number;
  /** Absolute time (timeOrigin + now), comparable across frames. */
  abs: number;
  id?: string | null;
  page?: number | null;
  pageCount?: number;
  bridge?: number;
  dirty?: boolean;
  ids?: string[];
  theme?: string;
  error?: string;
  name?: string;
  saveAs?: boolean;
  size?: number;
  /** Value of /LeitorBookUid found in the saved bytes (literal or hex string), if any. */
  bookUid?: string | null;
  hasAnnots?: boolean;
  hasOutlines?: boolean;
  hasHighlight?: boolean;
  /** Literal `/Title (…)` strings in the file (outline entries, Info). */
  titles?: string[];
  /** Literal `/Contents (…)` strings (annotation notes). */
  contents?: string[];
  // Bridge v2 (Phase 4).
  text?: string;
  rects?: [number, number, number, number][];
  key?: string;
  anchor?: [number, number, number, number] | null;
  items?: { key: string; rect: [number, number, number, number] }[] | { key: string; label: string }[];
  query?: string;
  found?: boolean;
  find?: string;
  // Bridge v3 (Phase 6): marks.
  set?: string;
  index?: number;
  rect?: [number, number, number, number];
  count?: number;
  marks?: { page: number; rects: [number, number, number, number][]; style: string; color: string }[];
}

/**
 * Runs in every frame. Top: records what PdfCraft posts (`__fromPdfcraft`). Iframe: records what the app posts
 * (`__fromHost`). Saved bytes are scanned for /LeitorBookUid before the app stores them.
 */
function recorder() {
  const summarize = (data: Record<string, unknown>) => {
    const out: Record<string, unknown> = { at: performance.now(), abs: performance.timeOrigin + performance.now() };
    for (const [k, v] of Object.entries(data)) {
      if (k === 'bytes') continue;
      out[k] = v;
    }
    const bytes = data.bytes;
    if (bytes && typeof bytes === 'object' && 'byteLength' in bytes) {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
      out.size = view.byteLength;
      if (data.type === 'pdfcraft:save') {
        let text = '';
        for (let i = 0; i < view.length; i += 8192) {
          text += String.fromCharCode(...view.subarray(i, Math.min(view.length, i + 8192)));
        }
        const literal = /\/LeitorBookUid\s*\(([^)]*)\)/.exec(text);
        const hex = /\/LeitorBookUid\s*<([0-9a-fA-F\s]*)>/.exec(text);
        let uid: string | null = literal?.[1] ?? null;
        if (!uid && hex?.[1]) {
          const h = hex[1].replace(/\s+/g, '');
          let s = '';
          const start = h.toUpperCase().startsWith('FEFF') ? 4 : 0;
          const step = start ? 4 : 2;
          for (let i = start; i + step <= h.length; i += step)
            s += String.fromCharCode(parseInt(h.slice(i, i + step), 16));
          uid = s;
        }
        out.bookUid = uid;
        out.hasAnnots = /\/Annots\b/.test(text);
        out.hasOutlines = /\/Outlines\b/.test(text);
        out.hasHighlight = /\/Subtype\s*\/Highlight\b/.test(text);
        out.contents = [...text.matchAll(/\/Contents\s*\(([^)]{0,200})\)/g)].slice(0, 200).map((m) => m[1]);
        out.titles = [...text.matchAll(/\/Title\s*\(([^)]{0,200})\)/g)].slice(0, 200).map((m) => m[1]);
      }
    }
    return out;
  };
  const w = window as unknown as { __fromPdfcraft: unknown[]; __fromHost: unknown[]; __recording?: boolean };
  // WebKit may run init scripts twice in the same window (initial about:blank of the iframe).
  if (w.__recording) return;
  w.__recording = true;
  w.__fromPdfcraft = [];
  w.__fromHost = [];
  // trunk's loader announces the instance: keep it to read the WebAssembly memory size (perf.spec.ts).
  addEventListener('TrunkApplicationStarted', (e) => {
    (window as unknown as { __wasm?: unknown }).__wasm = (e as CustomEvent<{ wasm: unknown }>).detail?.wasm;
  });
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string' || !data.type.startsWith('pdfcraft:'))
      return;
    if (window.parent === window) w.__fromPdfcraft.push(summarize(data));
    else w.__fromHost.push(summarize(data));
  });
}

export const test = base.extend<{ consoleErrors: string[] }>({
  page: async ({ page }, use) => {
    requirePdfcraftBuild();
    await page.context().addInitScript(recorder);
    await use(page);
  },
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await use(errors);
      expect(errors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function fromPdfcraft(page: Page): Promise<Logged[]> {
  return page.evaluate(() => (window as unknown as { __fromPdfcraft: Logged[] }).__fromPdfcraft);
}

/** What the app posted to PdfCraft (recorded inside the iframe; bytes summarized). */
export async function fromHost(page: Page): Promise<Logged[]> {
  return pdfcraftFrame(page).evaluate(() => (window as unknown as { __fromHost: Logged[] }).__fromHost);
}

/** Absolute time (timeOrigin + now) in the top page, comparable with `Logged.abs`. */
export async function absNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

export async function waitForMessage(
  page: Page,
  match: Partial<Logged> & { type: string },
  opts: { after?: number; timeout?: number } = {},
): Promise<Logged> {
  let found: Logged | undefined;
  await expect
    .poll(
      async () => {
        const log = await fromPdfcraft(page);
        found = log.find(
          (m) =>
            m.at >= (opts.after ?? 0) &&
            Object.entries(match).every(([k, v]) => (m as unknown as Record<string, unknown>)[k] === v),
        );
        return !!found;
      },
      { timeout: opts.timeout ?? 60_000, message: `waiting for ${JSON.stringify(match)}` },
    )
    .toBe(true);
  return found!;
}

/** Asks PdfCraft for a save directly, as the autosave does. */
export async function requestSave(page: Page, id: string) {
  await page.evaluate((uid) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="PdfCraft"]')!;
    frame.contentWindow!.postMessage({ type: 'pdfcraft:request-save', id: uid }, location.origin);
  }, id);
}

export async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

export function pdfcraftFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes('/pdfcraft/'));
  if (!frame) throw new Error('PdfCraft iframe not found');
  return frame;
}

/**
 * Waits until PdfCraft has drawn `n` more frames. eframe (web) always keeps one requestAnimationFrame pending and
 * runs the app once per frame with ALL the input queued since the previous one (pointer down/up run it right away).
 * On a slow machine (4 vCPUs, software WebGL, another test in parallel) one frame takes hundreds of milliseconds, so
 * fixed sleeps let inputs that need the UI changed by an earlier input land in the same egui pass: Ctrl+K opens the
 * palette, but the text typed in that pass reaches no field and the Enter picks nothing. Each requestAnimationFrame
 * callback queued here runs after eframe's, so `n` of them are `n` real PdfCraft frames.
 */
export async function pdfcraftFrames(page: Page, n = 3): Promise<void> {
  await pdfcraftFrame(page).evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, n);
}

export async function mockBooks(
  page: Page,
): Promise<{ bookUid: string; title: string; pages: number; fileVersion: number }[]> {
  await page.waitForFunction(() => !!window.__leitorMock);
  return page.evaluate(() =>
    window.__leitorMock!.books.map((b) => ({
      bookUid: b.bookUid,
      title: b.title,
      pages: b.pages,
      fileVersion: b.fileVersion,
    })),
  );
}

export async function bookUid(page: Page, title: string): Promise<string> {
  const book = (await mockBooks(page)).find((b) => b.title === title);
  if (!book) throw new Error(`book ${title} not in the mock library`);
  return book.bookUid;
}

/**
 * Puts a file in the mock's fake file system and imports it through "Abrir com" (the shell imports it and opens it
 * in the Leitor). Returns the new book's uid.
 */
export async function importBytes(page: Page, filePath: string, bytes: Uint8Array): Promise<string> {
  const b64 = Buffer.from(bytes).toString('base64');
  // The mock keeps its state in sessionStorage ('leitor.mock'); write the file there and reload to load it. The app
  // persists the mock state on its own startup calls too, so check it survived and try again if not.
  for (let attempt = 0; ; attempt++) {
    await page.waitForFunction(() => !!window.__leitorMock);
    await page.waitForTimeout(500);
    await page.evaluate(
      ({ p, data }) => {
        if (!sessionStorage.getItem('leitor.mock')) window.__leitorMock!.reset();
        const state = JSON.parse(sessionStorage.getItem('leitor.mock')!) as { files: Record<string, string> };
        state.files[p] = data;
        sessionStorage.setItem('leitor.mock', JSON.stringify(state));
      },
      { p: filePath, data: b64 },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.__leitorMock);
    await page.waitForTimeout(500);
    if (await page.evaluate((p) => window.__leitorMock!.files.includes(p), filePath)) break;
    if (attempt >= 3) throw new Error(`could not seed ${filePath} into the mock core`);
  }
  // "Abrir com" reaches only a shell that already listens (an effect after the first render): wait for it rather than
  // trusting the fixed pause above.
  await page.waitForFunction(() => !!window.__leitorMock?.listeningToOpenPaths, undefined, { timeout: 60_000 });
  const before = (await mockBooks(page)).map((b) => b.bookUid);
  await page.evaluate((p) => window.__leitorMock!.openPaths([p]), filePath);
  // The import itself takes milliseconds, but it opens the book in the Leitor at once, and PdfCraft's start-up
  // (WebAssembly compile + software WebGL) then keeps the page's main thread busy for seconds on a slow machine
  // (4 vCPUs, another test in parallel). Polling from here would pay one blocked round trip per sample: wait in the
  // page for the new entry instead, with room for the slowest machine.
  const added = await page.waitForFunction(
    (known) => window.__leitorMock!.books.find((b) => !known.includes(b.bookUid))?.bookUid ?? '',
    before,
    { polling: 100, timeout: 60_000 },
  );
  const uid = (await added.jsonValue()) as string;
  await added.dispose();
  return uid;
}

/** Fraction of distinct colors in a PNG screenshot region (0 = blank). Crude but enough to tell a drawn page. */
export async function canvasVariance(page: Page, frame: Frame): Promise<number> {
  const el = await frame.frameElement();
  const png = await el.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 7) colors.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return colors.size;
  }, png.toString('base64'));
}

// ---------------------------------------------------------------- locating page rects on screen (Phase 7)

/** A screen rect in viewport CSS px. */
export interface ScreenBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where PdfCraft draws a page-space rect (`[x, y, w, h]`, points, y down) right now, in viewport CSS px. It asks
 * PdfCraft itself: an underline mark of a color nothing else uses goes under the rect (`pdfcraft:marks`, set
 * `e2e-locate`), PdfCraft reports it drawn (`pdfcraft:marks-shown`), the underline is found in a screenshot of the
 * iframe, and the mark is removed again. The underline spans the rect's width, so its x range and the rect's
 * aspect give the rect on screen with PdfCraft's own page-to-canvas mapping (zoom, scroll, rotation-free pages),
 * whatever the page looks like (a scanned page has no fill color to look for).
 */
export async function locatePageRect(
  page: Page,
  id: string,
  pageIndex: number,
  rect: [number, number, number, number],
): Promise<ScreenBox> {
  const SET = 'e2e-locate';
  const post = (msg: Record<string, unknown>) =>
    page.evaluate((m) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="PdfCraft"]')!;
      frame.contentWindow!.postMessage(m, location.origin);
    }, msg);
  const after = await now(page);
  await post({
    type: 'pdfcraft:marks',
    id,
    set: SET,
    marks: [{ page: pageIndex, rects: [rect], style: 'underline', color: '#ff00ff' }],
  });
  await waitForMessage(page, { type: 'pdfcraft:marks-shown', id, set: SET, page: pageIndex, count: 1 }, { after });
  const el = await pdfcraftFrame(page).frameElement();
  let line: { x0: number; x1: number; y0: number; y1: number; width: number } | null = null;
  await expect
    .poll(
      async () => {
        const box = await el.boundingBox();
        if (!box) return false;
        const png = await el.screenshot();
        line = await page.evaluate(
          async ({ b64 }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
            let x0 = width;
            let x1 = -1;
            let y0 = height;
            let y1 = -1;
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                // Magenta: red and blue well above green and close to each other. Also under PdfCraft's
                // translucent selection tint, never PdfCraft's own purples (e.g. its highlight swatch).
                const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
                if (r - g >= 100 && b - g >= 100 && Math.abs(r - b) <= 70) {
                  x0 = Math.min(x0, x);
                  x1 = Math.max(x1, x);
                  y0 = Math.min(y0, y);
                  y1 = Math.max(y1, y);
                }
              }
            }
            return x1 < 0 ? null : { x0, x1, y0, y1, width };
          },
          { b64: png.toString('base64') },
        );
        return !!line && line.x1 - line.x0 >= 4;
      },
      { timeout: 30_000, message: `the e2e-locate underline under [${rect.join(', ')}] on page ${pageIndex + 1}` },
    )
    .toBe(true)
    .catch(async (e: Error) => {
      await page.screenshot({ path: 'test-results/locate-page-rect-failure.png' }).catch(() => undefined);
      throw e;
    });
  const box = (await el.boundingBox())!;
  await post({ type: 'pdfcraft:clear-marks', id, set: SET });
  await pdfcraftFrames(page, 2);
  const found = line! as { x0: number; x1: number; y0: number; y1: number; width: number };
  // Screenshot px → viewport CSS px (WebKit's device scale is 2).
  const k = box.width / found.width;
  const x0 = box.x + found.x0 * k;
  const x1 = box.x + (found.x1 + 1) * k;
  // The underline sits at the bottom of the rect: the rect's height follows from its on-screen width.
  const h = ((x1 - x0) * rect[3]) / Math.max(1e-6, rect[2]);
  const bottom = box.y + found.y0 * k;
  return { x0, x1, y0: bottom - h, y1: bottom };
}

/**
 * Drags from `(x0, y)` to `(x1, y)` the way a person does, one PdfCraft frame per step (pointer move, press, moves,
 * release land in separate egui passes on any machine speed).
 */
export async function dragAcross(page: Page, x0: number, x1: number, y: number, steps = 8): Promise<void> {
  await page.mouse.move(x0, y);
  await pdfcraftFrames(page, 2);
  await page.mouse.down();
  await pdfcraftFrames(page, 1);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y);
    await pdfcraftFrames(page, 1);
  }
  await pdfcraftFrames(page, 2);
  await page.mouse.up();
  await pdfcraftFrames(page);
}
