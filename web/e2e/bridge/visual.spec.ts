// Phase 1 acceptance 1: the reading screen is PdfCraft without visual changes. Same PDF, same viewport, same
// PdfCraft settings (one browser context, so one localStorage): the app's iframe vs PdfCraft web alone.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { makePdf } from '../../src/lib/pdf/minimalPdf';
import {
  canvasVariance,
  expect,
  importBytes,
  pdfcraftFrame,
  test,
  VISUAL_DIR,
  waitForMessage,
  writeFixture,
} from './helpers';

/** Pixels whose summed RGB difference exceeds this count as different (anti-aliasing noise stays below). */
const CHANNEL_THRESHOLD = 48;
/** At most this fraction of the pixels may differ. */
const MAX_DIFF_RATIO = 0.001;

interface DiffResult {
  width: number;
  height: number;
  different: number;
  ratio: number;
  diffPng: string;
}

/** Compares two PNGs in the browser (no image library needed); returns the stats and a diff image. */
async function diffPngs(page: Page, a: Buffer, b: Buffer): Promise<DiffResult> {
  return page.evaluate(
    async ({ a64, b64, threshold }) => {
      const load = async (src: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${src}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const [ia, ib] = await Promise.all([load(a64), load(b64)]);
      const width = Math.min(ia.width, ib.width);
      const height = Math.min(ia.height, ib.height);
      const out = new ImageData(width, height);
      let different = Math.abs(ia.width * ia.height - ib.width * ib.height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pa = (y * ia.width + x) * 4;
          const pb = (y * ib.width + x) * 4;
          const po = (y * width + x) * 4;
          const d =
            Math.abs(ia.data[pa]! - ib.data[pb]!) +
            Math.abs(ia.data[pa + 1]! - ib.data[pb + 1]!) +
            Math.abs(ia.data[pa + 2]! - ib.data[pb + 2]!);
          if (d > threshold) {
            different++;
            out.data.set([255, 0, 64, 255], po);
          } else {
            const g = 0.3 * ia.data[pa]! + 0.59 * ia.data[pa + 1]! + 0.11 * ia.data[pa + 2]!;
            const v = 255 - (255 - g) * 0.25;
            out.data.set([v, v, v, 255], po);
          }
        }
      }
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d')!.putImageData(out, 0, 0);
      const diffPng = c.toDataURL('image/png').split(',')[1]!;
      return { width, height, different, ratio: different / (ia.width * ia.height), diffPng };
    },
    { a64: a.toString('base64'), b64: b.toString('base64'), threshold: CHANNEL_THRESHOLD },
  );
}

/** Screenshots until two in a row are identical (PdfCraft finished drawing and animating). */
async function stableShot(shoot: () => Promise<Buffer>): Promise<Buffer> {
  let last = await shoot();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const next = await shoot();
    if (next.equals(last)) return next;
    last = next;
  }
  return last;
}

test('the Leitor tab shows PdfCraft exactly as PdfCraft web alone', async ({ page, context }, info) => {
  const bytes = makePdf({ pages: 6, title: 'Mesmo PDF', outline: true });
  const url = writeFixture('mesmo.pdf', bytes);

  // (a) The app: the book imported and opened in the Leitor (first page: no saved position).
  await page.goto('/biblioteca');
  const uid = await importBytes(page, '/home/jorge/Livros/mesmo.pdf', bytes);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid, page: 0 });
  const frameEl = await pdfcraftFrame(page).frameElement();
  await expect.poll(() => canvasVariance(page, pdfcraftFrame(page)), { timeout: 30_000 }).toBeGreaterThan(40);
  const box = (await frameEl.boundingBox())!;
  // App toasts ("adicionado à biblioteca") float over everything; wait until they are gone.
  await expect(page.locator('[aria-live] [role="status"], [aria-live] [role="alert"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  const appShot = await stableShot(() => frameEl.screenshot());

  // (b) PdfCraft web alone, in a window the size of the iframe, opening the same bytes from a URL.
  const solo = await context.newPage();
  await solo.setViewportSize({ width: Math.round(box.width), height: Math.round(box.height) });
  await solo.goto(`/pdfcraft/index.html?file=${encodeURIComponent(url)}`);
  await expect
    .poll(async () => (await solo.screenshot()).length, { timeout: 60_000, message: 'PdfCraft alone draws the page' })
    .toBeGreaterThan(appShot.length * 0.5);
  const soloShot = await stableShot(() => solo.screenshot());

  const result = await diffPngs(page, appShot, soloShot);
  mkdirSync(VISUAL_DIR, { recursive: true });
  const name = info.project.name;
  writeFileSync(path.join(VISUAL_DIR, `${name}-app.png`), appShot);
  writeFileSync(path.join(VISUAL_DIR, `${name}-pdfcraft.png`), soloShot);
  writeFileSync(path.join(VISUAL_DIR, `${name}-diff.png`), Buffer.from(result.diffPng, 'base64'));
  writeFileSync(
    path.join(VISUAL_DIR, `${name}.json`),
    JSON.stringify({ ...result, diffPng: undefined, viewport: box, threshold: CHANNEL_THRESHOLD }, null, 2),
  );
  console.log(
    `visual identity (${name}): ${result.width}x${result.height}, ${result.different} px differ (${(result.ratio * 100).toFixed(3)}%)`,
  );
  const dpr = await page.evaluate(() => devicePixelRatio);
  expect(result.width).toBe(Math.round(box.width * dpr));
  expect(result.ratio).toBeLessThanOrEqual(MAX_DIFF_RATIO);
});
