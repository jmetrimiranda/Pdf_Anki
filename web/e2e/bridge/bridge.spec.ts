// Spec 20 "Ponte com o PdfCraft" (Phase 1 subset) and the Phase 1 acceptance that can be automated: the app in mock
// mode with the REAL PdfCraft web build in the iframe.
import type { Page } from '@playwright/test';
import { makePdf } from '../../src/lib/pdf/minimalPdf';
import {
  bookUid,
  canvasVariance,
  expect,
  fromPdfcraft,
  importBytes,
  now,
  pdfcraftFrame,
  pdfcraftFrames,
  test,
  waitForMessage,
  type Logged,
} from './helpers';

const ROS = 'ROS 2 na prática';

async function fromHost(page: Page): Promise<Logged[]> {
  return pdfcraftFrame(page).evaluate(() => (window as unknown as { __fromHost: Logged[] }).__fromHost);
}

/** Opens a seeded book from the Biblioteca and waits until PdfCraft shows it. */
async function openFromLibrary(page: Page, title: string): Promise<string> {
  await page.goto('/biblioteca');
  const uid = await bookUid(page, title);
  const after = await now(page);
  await page.getByTestId('book-title').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/leitor/);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid }, { after });
  return uid;
}

/** Asks PdfCraft for a save directly, as the autosave does. */
async function requestSave(page: Page, id: string) {
  await page.evaluate((uid) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="PdfCraft"]')!;
    frame.contentWindow!.postMessage({ type: 'pdfcraft:request-save', id: uid }, location.origin);
  }, id);
}

async function frameBox(page: Page) {
  const box = await (await pdfcraftFrame(page).frameElement()).boundingBox();
  if (!box) throw new Error('iframe has no box');
  return box;
}

test('ready → open(id, page) → active → page → activity → request-save → save with LeitorBookUid', async ({ page }) => {
  const uid = await openFromLibrary(page, ROS);
  const log = await fromPdfcraft(page);
  const ready = log.filter((m) => m.type === 'pdfcraft:ready');
  expect(ready).toHaveLength(1);
  expect(ready[0]!.bridge).toBeGreaterThanOrEqual(1);

  // The app sent the book with its id, the saved position (page 5 = index 4) and the Info key.
  const opens = (await fromHost(page)).filter((m) => m.type === 'pdfcraft:open');
  expect(opens).toHaveLength(1);
  expect(opens[0]).toMatchObject({ id: uid, page: 4, infoKey: 'LeitorBookUid' });
  expect(opens[0]!.size).toBeGreaterThan(1000);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid, page: 4, pageCount: 12 });

  // PdfCraft really drew the page (not a blank canvas).
  await expect.poll(() => canvasVariance(page, pdfcraftFrame(page)), { timeout: 20_000 }).toBeGreaterThan(40);
  await expect(page.getByTestId('book-panel')).toContainText(ROS);

  // Scrolling inside PdfCraft reports pages, which become the saved position.
  const box = await frameBox(page);
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
  const beforeScroll = await now(page);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(150);
  }
  await expect
    .poll(
      async () => (await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:page' && m.at > beforeScroll).length,
    )
    .toBeGreaterThan(0);
  const lastPage = async () =>
    (await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:page' && m.id === uid).at(-1)?.page ?? -1;
  await page.waitForTimeout(1500);
  const shown = await lastPage();
  expect(shown).toBeGreaterThan(4);
  await expect.poll(() => page.evaluate((id) => window.__leitorMock!.positions[id]?.page, uid)).toBe(shown);
  const progress = await page.evaluate((id) => window.__leitorMock!.positions[id]!.progress, uid);
  expect(progress).toBeCloseTo((shown + 1) / 12, 5);

  // Activity of the book in front, at most one every 10 s.
  await waitForMessage(page, { type: 'pdfcraft:activity', id: uid });
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(300);
  }
  const activity = (await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:activity');
  for (let i = 1; i < activity.length; i++) {
    expect(activity[i]!.at - activity[i - 1]!.at).toBeGreaterThanOrEqual(9_900);
  }

  // A reading session started for the book (the Leitor is visible and the book in front).
  const sessions = await page.evaluate(() => window.__leitorMock!.sessions);
  expect(sessions.some((s) => s.kind === 'start' && s.uid === uid)).toBe(true);

  // request-save → save: the bytes carry /LeitorBookUid = book_uid and become version 2.
  const beforeSave = await now(page);
  await requestSave(page, uid);
  const save = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { after: beforeSave });
  expect(save.saveAs).toBe(false);
  expect(save.bookUid).toBe(uid);
  await expect.poll(() => page.evaluate(() => window.__leitorMock!.savedVersions.length)).toBe(1);
  const saved = await page.evaluate(() => window.__leitorMock!.savedVersions[0]!);
  expect(saved).toMatchObject({ uid, fileVersion: 2, hasBookUid: true, size: save.size });
});

test('annotate and bookmark inside PdfCraft → autosave → restart → still there, same book_uid, last page', async ({
  page,
}) => {
  const uid = await openFromLibrary(page, ROS);
  await expect.poll(() => canvasVariance(page, pdfcraftFrame(page)), { timeout: 20_000 }).toBeGreaterThan(40);
  const box = await frameBox(page);

  // Every step that needs the UI changed by the previous one waits for PdfCraft frames, not for time (see
  // pdfcraftFrames): on a slow machine the inputs would otherwise be handled in the same egui pass and get lost.
  // A bookmark at the current page (Ctrl+B, PdfCraft's own shortcut) with a name.
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.4);
  await pdfcraftFrames(page);
  await page.keyboard.press('Control+b');
  // The new bookmark is unsaved work; its name field takes the typing from the next frame on.
  await waitForMessage(page, { type: 'pdfcraft:dirty', dirty: true });
  await pdfcraftFrames(page);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Marcador E2E');
  await page.keyboard.press('Enter');
  await pdfcraftFrames(page);
  // A highlight: PdfCraft's "Highlight text" command, then a drag over the page.
  await page.keyboard.press('Control+k');
  await pdfcraftFrames(page);
  await page.keyboard.type('Highlight text');
  await pdfcraftFrames(page);
  await page.keyboard.press('Enter');
  await pdfcraftFrames(page);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await pdfcraftFrames(page, 1);
  await page.mouse.down();
  await pdfcraftFrames(page, 1);
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width * (0.4 + 0.015 * i), box.y + box.height * (0.3 + 0.00375 * i));
    await pdfcraftFrames(page, 1);
  }
  await page.mouse.up();
  await pdfcraftFrames(page);
  // A new highlight opens its note for typing; PdfCraft holds host saves while it is open. Show the Comments panel
  // (right rail, first icon), type the note and save it (Ctrl+Enter).
  await page.mouse.click(box.x + box.width - 23, box.y + 113);
  await pdfcraftFrames(page);
  await page.keyboard.type('Nota E2E');
  await pdfcraftFrames(page);
  await page.keyboard.press('Control+Enter');

  await expect.poll(() => page.evaluate(() => window.__leitor!.state().unsavedIds)).toEqual([uid]);

  // Autosave: 10 s without changes → request-save → save → book_save_version.
  const save = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { timeout: 40_000 });
  // The save came after 10 s without dirty/activity messages (the quiet timer restarts on each one).
  const lastSignal = Math.max(
    ...(await fromPdfcraft(page))
      .filter(
        (m) => m.at < save.at && (m.type === 'pdfcraft:dirty' || (m.type === 'pdfcraft:activity' && m.id === uid)),
      )
      .map((m) => m.at),
  );
  expect(save.at - lastSignal).toBeGreaterThanOrEqual(9_900);
  expect(save).toMatchObject({ bookUid: uid, hasHighlight: true, hasOutlines: true });
  expect(save.titles).toContain('Marcador E2E');
  expect(save.contents).toContain('Nota E2E');
  await expect.poll(() => page.evaluate(() => window.__leitor!.state().unsavedIds)).toEqual([]);
  const books = await page.evaluate(() => window.__leitorMock!.books);
  const book = books.find((b) => b.bookUid === uid)!;
  expect(book.fileVersion).toBe(2);

  // Leave at a known page, then "restart the app" (reload: the mock core persists, PdfCraft starts over).
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  // Leaving the tab flushes the position right away.
  await page
    .getByRole('tab', { name: 'Biblioteca' })
    .or(page.getByRole('link', { name: 'Biblioteca' }))
    .first()
    .click();
  const lastPage = (await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:page' && m.id === uid).at(-1)!.page!;
  await expect.poll(() => page.evaluate((id) => window.__leitorMock!.positions[id]?.page, uid)).toBe(lastPage);

  await page.reload();
  const uidAfter = await openFromLibrary(page, ROS);
  expect(uidAfter).toBe(uid);
  const open = (await fromHost(page)).find((m) => m.type === 'pdfcraft:open')!;
  // PdfCraft received the latest version (with the annotations), at the last page read.
  expect(open).toMatchObject({ id: uid, page: lastPage, size: save.size });
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid, page: lastPage });

  // And the annotations are still in the document PdfCraft has open: a save of it still carries them.
  const t0 = await now(page);
  await requestSave(page, uid);
  const again = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { after: t0 });
  expect(again).toMatchObject({ bookUid: uid, hasHighlight: true });
  expect(again.titles).toContain('Marcador E2E');
  expect(again.contents).toContain('Nota E2E');
});

test('a pre-annotated PDF keeps its annotations and outline through save → restart → reopen', async ({ page }) => {
  await page.goto('/biblioteca');
  const bytes = makePdf({ pages: 3, title: 'Anotado', outline: true, highlight: true });
  const uid = await importBytes(page, '/home/jorge/Livros/anotado.pdf', bytes);
  // "Abrir com" imports and opens it in the Leitor.
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid });
  const t0 = await now(page);
  await requestSave(page, uid);
  const save = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { after: t0 });
  expect(save).toMatchObject({ bookUid: uid, hasAnnots: true, hasOutlines: true, hasHighlight: true });
  await expect.poll(() => page.evaluate(() => window.__leitorMock!.savedVersions.length)).toBe(1);

  // "Restart the app" straight into the deep link: one full page load (the mock core persists, PdfCraft starts
  // over). Not reload() + goto(): the reload lands on /leitor, whose iframe is still downloading PdfCraft's wasm when
  // goto() discards it, and WebKit reports that cancelled fetch ("Load failed") as an uncaught error of the page.
  await page.goto(`/leitor?livro=${uid}`);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid });
  const t1 = await now(page);
  await requestSave(page, uid);
  const again = await waitForMessage(page, { type: 'pdfcraft:save', id: uid }, { after: t1 });
  expect(again).toMatchObject({ bookUid: uid, hasAnnots: true, hasOutlines: true, hasHighlight: true });
});

test('a corrupted PDF shows the fallback with the system viewer and does not break the app', async ({ page }) => {
  await page.goto('/biblioteca');
  const garbage = new TextEncoder().encode('%PDF-1.7\nthis is not really a pdf\n%%EOF\n');
  const uid = await importBytes(page, '/home/jorge/Livros/quebrado.pdf', garbage);
  const error = page.getByTestId('leitor-error');
  await expect(error).toBeVisible({ timeout: 40_000 });
  await expect(error).toContainText('O PdfCraft não conseguiu abrir');
  // The body is the pt-BR hint; PdfCraft's English text is only a small detail line.
  await expect(error).toContainText('O arquivo pode estar corrompido');
  await expect(error.getByTestId('leitor-error-detail')).toBeVisible();
  await error.getByRole('button', { name: 'Abrir no visualizador do sistema' }).click();
  await expect.poll(() => page.evaluate(() => window.__leitorMock!.openedExternally)).toContain(uid);
  await expect(error).toBeHidden();

  // PdfCraft is still alive: a good book opens afterwards.
  const ros = await openFromLibrary(page, ROS);
  expect(ros).not.toBe(uid);
});

test('switching app tabs ends the session but keeps PdfCraft (same document, no new ready)', async ({ page }) => {
  const uid = await openFromLibrary(page, ROS);
  const frameBefore = pdfcraftFrame(page);
  await expect
    .poll(() => page.evaluate(() => window.__leitorMock!.sessions.filter((s) => s.kind === 'start').length))
    .toBe(1);

  await page
    .getByRole('tab', { name: 'Anki' })
    .or(page.getByRole('link', { name: 'Anki' }))
    .first()
    .click();
  await expect(page).toHaveURL(/\/anki/);
  await expect
    .poll(() => page.evaluate(() => window.__leitorMock!.sessions.at(-1)))
    .toMatchObject({ kind: 'stop', reason: 'tab' });
  // Hidden, never removed: the iframe keeps its size and its canvas.
  const host = page.getByTestId('leitor-host');
  await expect(host).toHaveAttribute('data-visible', 'false');
  await expect(host).toHaveCSS('visibility', 'hidden');
  const hiddenBox = await (await frameBefore.frameElement()).boundingBox();
  expect(hiddenBox!.width).toBeGreaterThan(400);

  await page
    .getByRole('tab', { name: 'Leitor' })
    .or(page.getByRole('link', { name: 'Leitor' }))
    .first()
    .click();
  await expect(host).toHaveAttribute('data-visible', 'true');
  expect(pdfcraftFrame(page)).toBe(frameBefore);
  expect((await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:ready')).toHaveLength(1);
  expect(await page.evaluate(() => window.__leitor!.state().activeId)).toBe(uid);
  await expect
    .poll(() => page.evaluate(() => window.__leitorMock!.sessions.filter((s) => s.kind === 'start').length))
    .toBe(2);
});

test("Ctrl+Shift+P and Alt+1 work from inside PdfCraft; Ctrl+2 stays PdfCraft's", async ({ page }) => {
  await openFromLibrary(page, ROS);
  const panel = page.getByTestId('book-panel');
  await expect(panel).toHaveAttribute('data-open', 'true');
  const box = await frameBox(page);
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);

  await page.keyboard.press('Control+Shift+P');
  await expect(panel).toHaveAttribute('data-open', 'false');
  await page.keyboard.press('Control+Shift+P');
  await expect(panel).toHaveAttribute('data-open', 'true');

  // PdfCraft's zoom shortcut: not taken by the app (no tab switch).
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/leitor/);

  // Alt+1 is forwarded: Biblioteca.
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.keyboard.press('Alt+1');
  await expect(page).toHaveURL(/\/biblioteca/);
});

test('a compact window keeps PdfCraft wide: the panel starts closed and floats over it', async ({ page }, info) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openFromLibrary(page, ROS);
  const panel = page.getByTestId('book-panel');
  await expect(panel).toHaveAttribute('data-overlay', 'true');
  await expect(panel).toHaveAttribute('data-open', 'false');
  const closed = await frameBox(page);
  expect(closed.width).toBeGreaterThanOrEqual(800 - 40 - 1);

  await panel.getByRole('button', { name: /Mostrar painel Anki/ }).click();
  await expect(panel).toHaveAttribute('data-open', 'true');
  // Opening it never resizes PdfCraft.
  expect((await frameBox(page)).width).toBe(closed.width);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-results/screens/leitor-compact-${info.project.name}.png` });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveAttribute('data-open', 'false');

  // Wide again: the remembered (default open) panel docks beside PdfCraft.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(panel).toHaveAttribute('data-overlay', 'false');
  await expect(panel).toHaveAttribute('data-open', 'true');
  await expect.poll(async () => Math.round((await frameBox(page)).width)).toBeLessThanOrEqual(1280 - 320);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the panel's neutral tones follow PdfCraft's ${scheme} theme`, async ({ page }, info) => {
    await openFromLibrary(page, ROS);
    if (scheme === 'dark') {
      // PdfCraft's own theme button (top right of its tab band) until it reports dark.
      const box = await frameBox(page);
      for (let i = 0; i < 3; i++) {
        if ((await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:theme').at(-1)?.theme === 'dark') break;
        await page.mouse.click(box.x + box.width - 24, box.y + 19);
        await page.waitForTimeout(600);
      }
    }
    await waitForMessage(page, { type: 'pdfcraft:theme', theme: scheme });
    const panel = page.getByTestId('book-panel');
    await expect(panel).toHaveAttribute('data-theme-pdfcraft', scheme);
    await expect(panel).toHaveCSS('background-color', scheme === 'dark' ? 'rgb(38, 38, 42)' : 'rgb(255, 255, 255)');
    await expect.poll(() => canvasVariance(page, pdfcraftFrame(page)), { timeout: 20_000 }).toBeGreaterThan(40);
    await page.mouse.move(600, 10);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `test-results/screens/leitor-${scheme}-${info.project.name}.png` });
  });
}
