// Phase 7 acceptance (2), spec 7.2 and 21, with the REAL PdfCraft web build: a scanned English PDF after OCR in the
// native core (`core-pdf` `ocr_pages` + `apply_text_layer`, the same invisible text layer as PdfCraft's "Searchable
// Image") is searchable (`pdfcraft:goto {find}` → `pdfcraft:found {found: true}` on the word's page), its words can be
// selected (`pdfcraft:selection` with the word) and highlighted (autosave → /Highlight + LeitorBookUid, the OCR text
// still found after reopening the saved version), while the scan alone has no text (`found: false`).
//
// Fixtures (never committed) come from R2's generator, run inside the devcontainer:
//   cargo run -p core-pdf --features testkit --example ocr_fixture -- <dir>
// (default dir src-tauri/target/fixtures/ocr, in the build volume; LEITOR_OCR_FIXTURE_DIR overrides it).
// No fixed coordinates: words are located on screen through PdfCraft's own marks (`locatePageRect`); no sleeps:
// every step waits for a bridge message or for PdfCraft frames, so the assertions hold at any machine speed.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  dragAcross,
  expect,
  fromHost,
  fromPdfcraft,
  importBytes,
  locatePageRect,
  now,
  pdfcraftFrame,
  pdfcraftFrames,
  test,
  waitForMessage,
  WEB_ROOT,
  type Logged,
} from './helpers';

type Rect = [number, number, number, number];

interface OcrWordsFile {
  pages: { page: number; width: number; height: number; words: { word: string; rect: Rect }[] }[];
}

interface Fixtures {
  scanned: Uint8Array;
  recognised: Uint8Array;
  /** The distinctive word used throughout, as the OCR read it. */
  word: string;
  /** 0-based page of the word. */
  page: number;
  rect: Rect;
}

const FIXTURE_DIR = path.resolve(WEB_ROOT, process.env.LEITOR_OCR_FIXTURE_DIR ?? '../src-tauri/target/fixtures/ocr');
const FIXTURE_CMD =
  'scripts/dev.sh bash -c "cd src-tauri && cargo run -p core-pdf --features testkit --example ocr_fixture"';

/** Reads the OCR fixtures; fails with the command that makes them when they are missing. */
function ocrFixtures(): Fixtures {
  const file = (name: string) => path.join(FIXTURE_DIR, name);
  const missing = ['scanned.pdf', 'scanned-ocr.pdf', 'expected.json', 'ocr-words.json'].filter(
    (n) => !existsSync(file(n)),
  );
  if (missing.length) {
    throw new Error(
      `OCR fixtures missing in ${FIXTURE_DIR} (${missing.join(', ')}): run \`${FIXTURE_CMD}\` (inside the ` +
        'devcontainer, after scripts/fetch-ocr-models.sh), or point LEITOR_OCR_FIXTURE_DIR at its output.',
    );
  }
  const expected = JSON.parse(readFileSync(file('expected.json'), 'utf8')) as { words: string[] };
  const words = JSON.parse(readFileSync(file('ocr-words.json'), 'utf8')) as OcrWordsFile;
  // The first distinctive word the OCR read exactly (case-insensitive), with a usable rect.
  for (const want of expected.words) {
    for (const p of words.pages) {
      const hit = p.words.find((w) => w.word.toLowerCase() === want.toLowerCase() && w.rect[2] > 4 && w.rect[3] > 2);
      if (hit) {
        return {
          scanned: readFileSync(file('scanned.pdf')),
          recognised: readFileSync(file('scanned-ocr.pdf')),
          word: hit.word,
          page: p.page,
          rect: hit.rect,
        };
      }
    }
  }
  throw new Error(`none of ${expected.words.join(', ')} is among the OCR words of ${file('ocr-words.json')}`);
}

/** Imports `bytes` (the shell opens it in the Leitor) and waits until PdfCraft shows it. */
async function importAndOpen(page: Page, name: string, bytes: Uint8Array): Promise<string> {
  await page.goto('/biblioteca');
  const uid = await importBytes(page, `/home/jorge/Livros/${name}`, bytes);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid });
  return uid;
}

/** "Abrir no livro" at `pageIndex` finding `word` (`pdfcraft:goto {find}`); resolves with `pdfcraft:found`. */
async function find(page: Page, uid: string, pageIndex: number, word: string): Promise<Logged> {
  const after = await now(page);
  await page.evaluate(({ id, p, w }) => void window.__leitor!.openBook(id, { page: p, find: w }), {
    id: uid,
    p: pageIndex,
    w: word,
  });
  return waitForMessage(page, { type: 'pdfcraft:found', id: uid, query: word }, { after });
}

const collapse = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Every `pdfcraft:selection` PdfCraft sent after `after`. */
async function selections(page: Page, after: number): Promise<Logged[]> {
  return (await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:selection' && m.at >= after);
}

test('a recognised scan: PdfCraft finds, selects and highlights an OCR word; the saved version keeps the text', async ({
  page,
}) => {
  const fx = ocrFixtures();
  const uid = await importAndOpen(page, 'Scanned OCR.pdf', fx.recognised);

  // (a) Search: the OCR'd word is found on its page.
  const found = await find(page, uid, fx.page, fx.word);
  expect(found).toMatchObject({ found: true, page: fx.page });

  // (b) Selection: a drag across the word (located through PdfCraft's own page mapping) reports its text.
  const box = await locatePageRect(page, uid, fx.page, fx.rect);
  const y = (box.y0 + box.y1) / 2;
  const t0 = await now(page);
  await dragAcross(page, box.x0 + 1, box.x1 - 1, y);
  let texts: string[] = [];
  await expect
    .poll(
      async () => {
        texts = (await selections(page, t0)).map((m) => collapse(m.text));
        return texts.some((s) => s.toLowerCase().includes(fx.word.toLowerCase()));
      },
      { timeout: 30_000, message: `pdfcraft:selection with “${fx.word}”` },
    )
    .toBe(true)
    .catch((e: Error) => {
      throw new Error(`${e.message}\nselections reported: ${JSON.stringify(texts)}`);
    });
  await expect
    .poll(() => page.evaluate(() => window.__leitor!.state().selection?.text ?? ''))
    .toMatch(new RegExp(fx.word, 'i'));

  // (c) Annotation: PdfCraft's "Highlight text" over the word, its note, then the autosave. The word is located again
  // first (PdfCraft may have scrolled to show the selection bar).
  const again = await locatePageRect(page, uid, fx.page, fx.rect);
  await page.keyboard.press('Control+k');
  await pdfcraftFrames(page);
  await page.keyboard.type('Highlight text');
  await pdfcraftFrames(page);
  await page.keyboard.press('Enter');
  await pdfcraftFrames(page);
  await dragAcross(page, again.x0 + 1, again.x1 - 1, (again.y0 + again.y1) / 2);
  await waitForMessage(page, { type: 'pdfcraft:dirty', dirty: true });
  // A new highlight opens its note; PdfCraft holds host saves while it is open (bridge.spec.ts): Comments panel
  // (right rail, first icon), type the note, Ctrl+Enter.
  const frame = (await (await pdfcraftFrame(page).frameElement()).boundingBox())!;
  await page.mouse.click(frame.x + frame.width - 23, frame.y + 113);
  await pdfcraftFrames(page);
  await page.keyboard.type('Nota OCR');
  await pdfcraftFrames(page);
  await page.keyboard.press('Control+Enter');

  const save = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { timeout: 60_000 });
  expect(save).toMatchObject({ bookUid: uid, hasHighlight: true });
  await expect.poll(() => page.evaluate(() => window.__leitor!.state().unsavedIds)).toEqual([]);
  await expect
    .poll(() => page.evaluate((id) => window.__leitorMock!.savedVersions.filter((v) => v.uid === id), uid))
    .toEqual([expect.objectContaining({ uid, fileVersion: 2, hasBookUid: true, size: save.size })]);

  // Restart: the saved version (annotations + OCR layer) is what PdfCraft gets, and the word is still found there.
  await page.reload();
  await page.waitForFunction(() => !!window.__leitor);
  await page.evaluate((id) => void window.__leitor!.openBook(id), uid);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid });
  const open = (await fromHost(page)).filter((m) => m.type === 'pdfcraft:open' && m.id === uid).at(-1)!;
  expect(open.size).toBe(save.size);
  expect(await find(page, uid, fx.page, fx.word)).toMatchObject({ found: true, page: fx.page });
});

test('the scan alone has no text: PdfCraft does not find the word the OCR reads', async ({ page }) => {
  const fx = ocrFixtures();
  const uid = await importAndOpen(page, 'Scanned.pdf', fx.scanned);
  expect(await find(page, uid, fx.page, fx.word)).toMatchObject({ found: false });
});
