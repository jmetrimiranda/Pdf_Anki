// Spec 12.7, 6.2 and 20 ("marks sobre as palavras certas") with the REAL PdfCraft web build: the vocabulary highlight
// sends `pdfcraft:marks` with exactly the unknown (coral) and learning (amber) words of the visible pages, PdfCraft
// draws the underlines under the right words (located in a screenshot of the iframe, no fixed coordinates), a click
// on one gives `pdfcraft:mark-click` and the popover, a double-click there selects that same word, and the marks never
// reach the saved PDF, never make it dirty and survive PdfCraft's undo. No sleeps: PdfCraft frames are awaited with
// `pdfcraftFrames`, and every assertion is about what is drawn or sent, never about how fast.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  absNow,
  expect,
  fromHost,
  fromPdfcraft,
  importBytes,
  now,
  pdfcraftFrame,
  pdfcraftFrames,
  requestSave,
  test,
  VISUAL_DIR,
  waitForMessage,
  type Logged,
} from './helpers';

type Rect = [number, number, number, number];

const TITLE = 'Vocab marks';
/** One distinct line per page (layout of `makePdf`: Helvetica 11 pt at x 72, baseline 72 pt from the top). */
const PAGES = [
  'The learner locked the windmill while the animals were learning',
  'The animals ate their dinner in the barn',
  'Night came to the farm',
  // Enough pages that no line is taken for a running header or footer (one in more than 30% of the pages).
  'The hens slept on the beams of the old house',
  'Morning light fell on the yard',
  'The pigs read the old books',
];
/** With the mock collection's folder "Vocabulário" (src/lib/core/mock/ankiData.ts, spec 12.3 A/I). */
const EXPECTED_PAGE0 = [
  // learner: derived from "learn" (known) → a card (coral).
  { word: 'learner', color: '#d85a30' },
  // locked ← lock: a young card (interval 6 days) → learning (amber).
  { word: 'locked', color: '#ba7517' },
  // windmill: not in the folder → unknown (coral).
  { word: 'windmill', color: '#d85a30' },
];
/** Known (or function) words of page 1: never underlined. "learning" is a form of "learn" (spec 12.3 I). */
const KNOWN_PAGE0 = ['The', 'the', 'while', 'animals', 'were', 'learning'];
const CORAL = [0xd8, 0x5a, 0x30] as const;
const AMBER = [0xba, 0x75, 0x17] as const;
/** Page fill: a light yellow no PdfCraft chrome uses, so the page is easy to find in a screenshot. */
const PAGE_RGB = [255, 240, 199] as const;
const PAGE_W = 612;
const PAGE_H = 792;

/**
 * A PDF laid out exactly like `makePdf` (so the mock core reads its words back and places them with Helvetica's
 * widths), with each page filled with PAGE_RGB.
 */
function vocabPdf(): Uint8Array {
  const objs: string[] = [];
  const kids = PAGES.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${PAGES.length} /Kids [${kids}] >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const [r, g, b] = PAGE_RGB.map((c) => (c / 255).toFixed(4));
  PAGES.forEach((line, i) => {
    const s =
      `${r} ${g} ${b} rg 0 0 ${PAGE_W} ${PAGE_H} re f\n0 0 0 rg\n` +
      `BT\n/F1 11 Tf\n15 TL\n72 ${PAGE_H - 72} Td\n(${line}) Tj\nT*\nET\n`;
    objs[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objs[5 + 2 * i] = `<< /Length ${s.length} >>\nstream\n${s}endstream`;
  });
  objs.push(`<< /Title (${TITLE}) /Producer (Leitor de Estudos e2e) >>`);
  const info = objs.length - 1;
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}

// ---------------------------------------------------------------- the app and the mock core

const panel = (page: Page) => page.getByTestId('book-panel');
const toggle = (page: Page) => panel(page).getByRole('switch', { name: 'Realçar vocabulário' });

/** Imports the book (it opens in PdfCraft), scans it with the folder "Vocabulário", and shows the panel again. */
async function openScanned(page: Page): Promise<string> {
  await page.goto('/biblioteca');
  const uid = await importBytes(page, `/home/jorge/Livros/${TITLE}.pdf`, vocabPdf());
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid });
  await page.evaluate(async (id) => {
    const core = window.__leitor!.core;
    const root = (await core.ankiDeckNames()).find((d) => d.name === 'Vocabulário')!.id;
    const settings = await core.vocabSettingsSet({ rootDeckId: root });
    const job = await core.vocabScanStart(id, root, [], { kind: 'all' }, settings.config);
    await new Promise<void>((resolve, reject) => {
      const off = core.onJobProgress(job.jobId, (p) => {
        if (p.stage === 'done') {
          off();
          resolve();
        } else if (p.stage === 'failed' || p.stage === 'cancelled') reject(new Error(`scan ${p.stage}`));
      });
    });
  }, uid);
  // Back from another tab (as after the wizard): the panel and the marks ask the core again.
  const nav = page.getByRole('navigation', { name: 'Abas' });
  await nav.getByRole('link', { name: 'Biblioteca' }).click();
  await nav.getByRole('link', { name: 'Leitor' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await expect(toggle(page)).toBeEnabled();
  return uid;
}

async function pageWords(page: Page, uid: string, p: number) {
  return page.evaluate(({ id, n }) => window.__leitor!.core.docWords(id, n), { id: uid, n: p });
}

/** The `pdfcraft:marks` the app sent (recorded inside the iframe) after `afterAbs` (absolute time, `absNow`). */
async function marksSent(page: Page, afterAbs = 0): Promise<Logged[]> {
  return (await fromHost(page)).filter((m) => m.type === 'pdfcraft:marks' && m.abs >= afterAbs);
}

/** The marks PdfCraft holds for page `p`, replaying the messages (a page listed replaces that page's marks). */
async function heldMarks(page: Page, uid: string, p: number) {
  let held: { rects: Rect[]; color: string }[] = [];
  for (const m of await fromHost(page)) {
    if (m.id !== uid) continue;
    if (m.type === 'pdfcraft:clear-marks') held = [];
    if (m.type !== 'pdfcraft:marks') continue;
    const here = (m.marks ?? []).filter((x) => x.page === p);
    if (here.length) held = here.filter((x) => x.rects.length > 0).map((x) => ({ rects: x.rects, color: x.color }));
  }
  return held;
}

/** The words of `p` under the held marks (by identical rects), with their colors, in order. */
async function markedWords(page: Page, uid: string, p: number) {
  const words = (await pageWords(page, uid, p)).words;
  return (await heldMarks(page, uid, p)).map((m) => {
    const w = words.find((x) => JSON.stringify(x.rects) === JSON.stringify(m.rects));
    return { word: w?.text ?? `?${JSON.stringify(m.rects)}`, color: m.color };
  });
}

// ---------------------------------------------------------------- what PdfCraft drew

interface WordInk {
  text: string;
  /** Viewport CSS px of the word's rect (from the core's page words). */
  box: { x: number; y: number; w: number; h: number };
  /** Dark (glyph) pixels inside the word's rect, viewport CSS px; null when none. */
  dark: { x0: number; x1: number; y0: number; y1: number } | null;
  coral: { n: number; x0: number; x1: number; y0: number; y1: number };
  amber: { n: number; x0: number; x1: number; y0: number; y1: number };
}

/**
 * Screenshot of the iframe → page 1 (the first band of PAGE_RGB) → for each word of `words` (page view space), the
 * dark glyph pixels inside its rect and the coral/amber pixels under it (from its middle to 7 pt below its rect).
 */
async function ink(page: Page, words: { text: string; rects: Rect[] }[]): Promise<WordInk[] | null> {
  const el = await pdfcraftFrame(page).frameElement();
  const box = await el.boundingBox();
  if (!box) return null;
  const png = await el.screenshot();
  const res = await page.evaluate(
    async ({ b64, rgb, coral, amber, list, pageW }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const near = (i: number, ref: readonly number[], tol: number) =>
        Math.abs(data[i]! - ref[0]!) <= tol &&
        Math.abs(data[i + 1]! - ref[1]!) <= tol &&
        Math.abs(data[i + 2]! - ref[2]!) <= tol;
      let y0 = -1;
      let x0 = width;
      let x1 = -1;
      // Page rows: a long run of page color (icons of PdfCraft's panels may share the color, never in a long run).
      let best = 0;
      for (let y = 0; y < height; y++) {
        let run = 0;
        let longest = 0;
        let end = -1;
        for (let x = 0; x < width; x++) {
          run = near((y * width + x) * 4, rgb, 12) ? run + 1 : 0;
          if (run > longest) {
            longest = run;
            end = x;
          }
        }
        if (longest >= 150) {
          if (y0 < 0) y0 = y;
          if (longest > best) {
            best = longest;
            x0 = end - longest + 1;
            x1 = end;
          }
        } else if (y0 >= 0) break;
      }
      if (y0 < 0 || x1 <= x0) return null;
      const s = (x1 - x0 + 1) / pageW;
      const out = list.map((w) => {
        const [rx, ry, rw, rh] = w.rects[0]!;
        const bx0 = Math.floor(x0 + rx * s);
        const by0 = Math.floor(y0 + ry * s);
        const bx1 = Math.ceil(x0 + (rx + rw) * s);
        const by1 = Math.ceil(y0 + (ry + rh) * s);
        let dark: { x0: number; x1: number; y0: number; y1: number } | null = null;
        for (let y = Math.max(0, by0); y < Math.min(height, by1); y++) {
          for (let x = Math.max(0, bx0); x < Math.min(width, bx1); x++) {
            const i = (y * width + x) * 4;
            if (data[i]! + data[i + 1]! + data[i + 2]! < 300) {
              dark = dark
                ? {
                    x0: Math.min(dark.x0, x),
                    x1: Math.max(dark.x1, x),
                    y0: Math.min(dark.y0, y),
                    y1: Math.max(dark.y1, y),
                  }
                : { x0: x, x1: x, y0: y, y1: y };
            }
          }
        }
        const dist = (i: number, ref: readonly number[]) =>
          Math.max(Math.abs(data[i]! - ref[0]!), Math.abs(data[i + 1]! - ref[1]!), Math.abs(data[i + 2]! - ref[2]!));
        // A pixel of an underline: close to one of the two colors and clearly closer to it than to the other.
        const scan = (ref: readonly number[]) => {
          const other = ref === coral ? amber : coral;
          const r = { n: 0, x0: width, x1: -1, y0: height, y1: -1 };
          const top = Math.round((by0 + by1) / 2);
          const bottom = Math.min(height, Math.ceil(by1 + 7 * s));
          for (let y = Math.max(0, top); y < bottom; y++) {
            for (let x = Math.max(0, bx0 + 1); x < Math.min(width, bx1 - 1); x++) {
              const i = (y * width + x) * 4;
              const d = dist(i, ref);
              if (d <= 28 && dist(i, other) >= d + 8) {
                r.n++;
                r.x0 = Math.min(r.x0, x);
                r.x1 = Math.max(r.x1, x);
                r.y0 = Math.min(r.y0, y);
                r.y1 = Math.max(r.y1, y);
              }
            }
          }
          return r;
        };
        return { text: w.text, box: [bx0, by0, bx1, by1], dark, coral: scan(coral), amber: scan(amber) };
      });
      return { width, words: out };
    },
    {
      b64: png.toString('base64'),
      rgb: [...PAGE_RGB],
      coral: [...CORAL],
      amber: [...AMBER],
      list: words,
      pageW: PAGE_W,
    },
  );
  if (!res) return null;
  // Screenshot px → viewport CSS px (WebKit's device scale is 2).
  const k = box.width / res.width;
  const X = (v: number) => box.x + v * k;
  const Y = (v: number) => box.y + v * k;
  return res.words.map((w) => ({
    text: w.text,
    box: { x: X(w.box[0]!), y: Y(w.box[1]!), w: (w.box[2]! - w.box[0]!) * k, h: (w.box[3]! - w.box[1]!) * k },
    dark: w.dark ? { x0: X(w.dark.x0), x1: X(w.dark.x1 + 1), y0: Y(w.dark.y0), y1: Y(w.dark.y1 + 1) } : null,
    coral: { n: w.coral.n, x0: X(w.coral.x0), x1: X(w.coral.x1 + 1), y0: Y(w.coral.y0), y1: Y(w.coral.y1 + 1) },
    amber: { n: w.amber.n, x0: X(w.amber.x0), x1: X(w.amber.x1 + 1), y0: Y(w.amber.y0), y1: Y(w.amber.y1 + 1) },
  }));
}

/** Polls the screenshot until `ok` holds for what PdfCraft drew (it draws marks on its next frames). */
async function inkUntil(
  page: Page,
  words: { text: string; rects: Rect[] }[],
  ok: (ink: WordInk[]) => boolean,
  message: string,
): Promise<WordInk[]> {
  let last: WordInk[] | null = null;
  await expect
    .poll(
      async () => {
        last = await ink(page, words);
        return !!last && ok(last);
      },
      { timeout: 60_000, message },
    )
    .toBe(true)
    .catch(async (e: Error) => {
      await page.screenshot({ path: 'test-results/vocab-marks-failure.png' }).catch(() => undefined);
      throw new Error(`${e.message}\nlast analysis: ${JSON.stringify(last)}`);
    });
  return last!;
}

const colorOf = (w: WordInk, hex: string) => (hex === '#d85a30' ? w.coral : w.amber);
const otherOf = (w: WordInk, hex: string) => (hex === '#d85a30' ? w.amber : w.coral);

/** The underline of `w` in `hex`: under the glyphs, as wide as the word (±4 px), and nothing in the other color. */
function underlined(w: WordInk, hex: string): boolean {
  const u = colorOf(w, hex);
  if (!w.dark || u.n < 4 || otherOf(w, hex).n > 2) return false;
  const overlap = Math.min(u.x1, w.dark.x1) - Math.max(u.x0, w.dark.x0);
  const glyphs = w.dark.x1 - w.dark.x0;
  return (
    overlap >= 0.8 * glyphs &&
    u.x0 >= w.dark.x0 - 4 &&
    u.x1 <= w.dark.x1 + 4 &&
    // Just below the glyphs' middle, never above them and at most a few px under the rect.
    u.y0 > (w.dark.y0 + w.dark.y1) / 2 &&
    u.y0 <= w.box.y + w.box.h + 6
  );
}

const plain = (w: WordInk) => w.coral.n + w.amber.n <= 1;

// ---------------------------------------------------------------- tests

test('marks underline exactly the unknown and learning words, where PdfCraft draws them; never saved', async ({
  page,
}) => {
  const uid = await openScanned(page);
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  expect(await marksSent(page)).toEqual([]);

  // "Realçar vocabulário" on: pdfcraft:marks for the page in front and its neighbours.
  const onAt = await now(page);
  const onAbs = await absNow(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await marksSent(page, onAbs)).length).toBeGreaterThan(0);
  const sent = (await marksSent(page, onAbs))[0]!;
  expect(sent).toMatchObject({ id: uid, set: 'vocab' });
  // The page in front and the next ones (a page without unknown/learning words gets no entry).
  const sentPages = new Set(sent.marks!.map((m) => m.page));
  expect(sentPages.has(0) && sentPages.has(1)).toBe(true);
  expect([...sentPages].every((p) => p <= 2)).toBe(true);
  expect(sent.marks!.every((m) => m.style === 'underline')).toBe(true);
  // Exactly the expected words, with the core's word rects (vocab_marks vs doc_words of the same page).
  expect(await markedWords(page, uid, 0)).toEqual(EXPECTED_PAGE0);
  // Page 2: "ate" (eat: not in the folder) and "dinner", "barn" (unknown); the rest is known or a function word.
  const page1 = (await markedWords(page, uid, 1)).map((m) => m.word);
  expect(page1).not.toContain('animals');
  expect(page1).not.toContain('their');
  // The words PdfCraft drew them on: marks-shown with the count of page 1.
  await waitForMessage(
    page,
    { type: 'pdfcraft:marks-shown', id: uid, set: 'vocab', page: 0, count: 3 },
    { after: onAt },
  );

  // On the canvas: each underline in its color under its word's glyphs, none under a known word.
  const words = (await pageWords(page, uid, 0)).words;
  const marked = EXPECTED_PAGE0.map((e) => words.find((w) => w.text === e.word)!);
  const known = KNOWN_PAGE0.flatMap((k) => words.filter((w) => w.text === k));
  const drawn = await inkUntil(
    page,
    [...marked, ...known],
    (all) =>
      EXPECTED_PAGE0.every((e, i) => underlined(all[i]!, e.color)) && all.slice(EXPECTED_PAGE0.length).every(plain),
    'coral/amber underlines under learner, locked, windmill and nothing under the known words',
  );

  // A click on "windmill": pdfcraft:mark-click with its page and index, a rect inside the iframe, and the popover.
  const frameBox = (await (await pdfcraftFrame(page).frameElement()).boundingBox())!;
  const windmill = drawn[2]!;
  const cx = (windmill.dark!.x0 + windmill.dark!.x1) / 2;
  const cy = (windmill.dark!.y0 + windmill.dark!.y1) / 2;
  const clickAt = await now(page);
  await page.mouse.move(cx, cy);
  await pdfcraftFrames(page, 2);
  await page.mouse.down();
  await pdfcraftFrames(page, 1);
  await page.mouse.up();
  const click = await waitForMessage(
    page,
    { type: 'pdfcraft:mark-click', id: uid, page: 0, index: 2 },
    { after: clickAt },
  );
  expect(click.set).toBe('vocab');
  const [rx, ry, rw, rh] = click.rect!;
  expect(rx).toBeGreaterThanOrEqual(0);
  expect(ry).toBeGreaterThanOrEqual(0);
  expect(rx + rw).toBeLessThanOrEqual(frameBox.width);
  expect(ry + rh).toBeLessThanOrEqual(frameBox.height);
  // The rect is the word on screen (CSS px relative to the iframe).
  expect(Math.abs(frameBox.x + rx - windmill.box.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(rw - windmill.box.w)).toBeLessThanOrEqual(4);
  const pop = page.getByTestId('vocab-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('windmill');
  await expect(pop).toContainText('desconhecida');
  await expect(pop).toContainText('A mill powered by the wind turning its sails.');
  // Over the word: the popover's anchor is where the word is.
  const anchor = await page.getByTestId('vocab-anchor').evaluate((el) => el.getBoundingClientRect().x);
  expect(Math.abs(anchor - windmill.box.x)).toBeLessThanOrEqual(4);
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);

  // A double-click on the same spot selects exactly that word in PdfCraft: the mark and PdfCraft's text agree.
  // First a click on the blank page far from the word: PdfCraft counts quick presses at the same spot as one
  // multi-click, and the earlier click on the mark must not make this a triple click (the line).
  await page.mouse.click(cx, cy + 120);
  await pdfcraftFrames(page, 3);
  await page.mouse.move(cx, cy);
  await pdfcraftFrames(page, 3);
  const dblAt = await now(page);
  await page.mouse.dblclick(cx, cy);
  const sel = await waitForMessage(page, { type: 'pdfcraft:selection', id: uid, page: 0 }, { after: dblAt });
  expect((sel.text ?? '').trim()).toBe('windmill');
  const mark = words.find((w) => w.text === 'windmill')!.rects[0]!;
  const selRect = sel.rects![0]!;
  expect(Math.abs(selRect[0] - mark[0])).toBeLessThanOrEqual(2);
  expect(Math.abs(selRect[0] + selRect[2] - (mark[0] + mark[2]))).toBeLessThanOrEqual(3);
  expect(selRect[1]).toBeLessThan(mark[1] + mark[3]);
  expect(selRect[1] + selRect[3]).toBeGreaterThan(mark[1]);
  // Clear the selection (a click on the blank page below the line).
  await page.mouse.click(cx, cy + 120);
  await pdfcraftFrames(page, 3);

  // Ctrl+Z inside PdfCraft: marks are not in its undo history.
  await page.keyboard.press('Control+z');
  await pdfcraftFrames(page, 4);
  await inkUntil(
    page,
    marked,
    (all) => EXPECTED_PAGE0.every((e, i) => underlined(all[i]!, e.color)),
    'marks after undo',
  );

  // Never saved, never dirty: a save with the marks equals a save without them.
  const dirtyBefore = (await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:dirty' && m.dirty && m.at >= onAt);
  expect(dirtyBefore).toEqual([]);
  const withMarksAt = await now(page);
  const withMarksAbs = await absNow(page);
  await requestSave(page, uid);
  const withMarks = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { after: withMarksAt });
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  await expect
    .poll(async () => (await fromHost(page)).some((m) => m.type === 'pdfcraft:clear-marks' && m.abs >= withMarksAbs))
    .toBe(true);
  await inkUntil(page, marked, (all) => all.every(plain), 'no underline once the highlight is off');
  const withoutAt = await now(page);
  await requestSave(page, uid);
  const without = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { after: withoutAt });
  expect({ size: withMarks.size, annots: withMarks.hasAnnots, titles: withMarks.titles }).toEqual({
    size: without.size,
    annots: without.hasAnnots,
    titles: without.titles,
  });
  expect(withMarks.hasAnnots).toBe(false);
  expect((await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:dirty' && m.dirty && m.at >= onAt)).toEqual([]);

  // A bookmark made in PdfCraft goes into the saved PDF's outline (the Trecho tree reads it from there).
  const bm = page.getByTestId('book-panel');
  await expect(bm).toBeVisible();
  await page.mouse.click(cx, cy + 120);
  await pdfcraftFrames(page);
  await page.keyboard.press('Control+b');
  await waitForMessage(page, { type: 'pdfcraft:dirty', dirty: true }, { after: withoutAt });
  await pdfcraftFrames(page);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Cap Moinho');
  await page.keyboard.press('Enter');
  await pdfcraftFrames(page);
  const bookmarkAt = await now(page);
  await requestSave(page, uid);
  const withBookmark = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { after: bookmarkAt });
  expect(withBookmark.hasOutlines).toBe(true);
  expect(withBookmark.titles).toContain('Cap Moinho');
});

test('popover: "Adicionar ao deck do livro" turns the mark amber; "Já sei" and "Nome próprio" remove it', async ({
  page,
}, info) => {
  const uid = await openScanned(page);
  await page.goto(`/leitor?livro=${uid}&realce=1`);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid });
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => markedWords(page, uid, 0)).toEqual(EXPECTED_PAGE0);
  const words = (await pageWords(page, uid, 0)).words;
  const target = (w: string) => words.find((x) => x.text === w)!;

  /** Clicks the word `w` (located on the canvas) and waits for the popover. */
  const open = async (w: string, index: number) => {
    const [found] = await inkUntil(page, [target(w)], (all) => !!all[0]!.dark, `glyphs of ${w}`);
    const d = found!.dark!;
    const at = await now(page);
    await page.mouse.move((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2);
    await pdfcraftFrames(page, 2);
    await page.mouse.down();
    await pdfcraftFrames(page, 1);
    await page.mouse.up();
    await waitForMessage(page, { type: 'pdfcraft:mark-click', id: uid, page: 0, index }, { after: at });
    const pop = page.getByTestId('vocab-popover');
    await expect(pop).toContainText(w);
    return pop;
  };

  // Adicionar: the note lands in the book's deck (Vocabulário::Livros::Vocab marks) and windmill turns amber.
  let pop = await open('windmill', 2);
  await expect(pop).toContainText('A mill powered by the wind turning its sails.');
  mkdirSync(VISUAL_DIR, { recursive: true });
  await page.screenshot({ path: path.join(VISUAL_DIR, `vocab-popover-${info.project.name}.png`) });
  await pop.getByRole('button', { name: 'Adicionar ao deck do livro' }).click();
  await expect(page.getByText('Adicionado a Vocabulário::Livros::Vocab marks')).toBeVisible();
  await expect(pop).toHaveCount(0);
  const added = await page.evaluate(() =>
    window
      .__leitorMock!.anki.logs.filter((l) => l.kind === 'vocabAddWord')
      .map((l) => ({ lemma: l.lemma, deckId: l.deckId })),
  );
  expect(added).toHaveLength(1);
  expect(added[0]!.lemma).toBe('windmill');
  const deckNames = await page.evaluate(() => window.__leitor!.core.ankiDeckNames());
  expect(deckNames.find((d) => d.id === added[0]!.deckId)?.name).toBe('Vocabulário::Livros::Vocab marks');
  await expect
    .poll(() => markedWords(page, uid, 0))
    .toEqual([EXPECTED_PAGE0[0], EXPECTED_PAGE0[1], { word: 'windmill', color: '#ba7517' }]);
  await inkUntil(page, [target('windmill')], (all) => underlined(all[0]!, '#ba7517'), 'windmill underlined in amber');

  // Já sei: "learner" is no longer underlined.
  pop = await open('learner', 0);
  await pop.getByRole('button', { name: 'Já sei' }).click();
  await expect(page.getByText('“learner” marcada como conhecida.')).toBeVisible();
  await expect
    .poll(() => markedWords(page, uid, 0))
    .toEqual([EXPECTED_PAGE0[1], { word: 'windmill', color: '#ba7517' }]);
  await inkUntil(page, [target('learner')], (all) => plain(all[0]!), 'learner without underline');

  // Nome próprio: "locked" (now index 0) goes too.
  pop = await open('locked', 0);
  await pop.getByRole('button', { name: 'Nome próprio' }).click();
  await expect(page.getByText('“lock” marcada como nome próprio.')).toBeVisible();
  await expect.poll(() => markedWords(page, uid, 0)).toEqual([{ word: 'windmill', color: '#ba7517' }]);
  expect(await page.evaluate(() => window.__leitorMock!.vocab.overrides)).toEqual({ learner: 'known', lock: 'proper' });
});
