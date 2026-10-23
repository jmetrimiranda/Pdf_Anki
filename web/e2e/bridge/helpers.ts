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

export async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

export function pdfcraftFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes('/pdfcraft/'));
  if (!frame) throw new Error('PdfCraft iframe not found');
  return frame;
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
  const before = new Set((await mockBooks(page)).map((b) => b.bookUid));
  await page.evaluate((p) => window.__leitorMock!.openPaths([p]), filePath);
  let uid = '';
  await expect
    .poll(async () => {
      const added = (await mockBooks(page)).find((b) => !before.has(b.bookUid));
      uid = added?.bookUid ?? '';
      return uid;
    })
    .not.toBe('');
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
