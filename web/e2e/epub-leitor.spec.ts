// EPUB books in the Leitor tab (spec 7.1, 10, 21 Phase 7) against the mocked core (the sample "The Time Machine",
// built in code) with the real EPUB reader (foliate-js) and the scripted fake PdfCraft: the reader in front with the
// book panel, the place kept across a restart (CFI), a card from the selection with a chapter/CFI Fonte listed in
// "Cards deste capítulo", "Abrir no livro" from the Anki tab, a deep link with cap/cfi, and switching to a PDF and
// back with both kept. Only real signals are awaited (reader status, the controller's state, the mock's records).
import type { Page } from '@playwright/test';
import { dropDevWebsocketErrors, withCsp } from './csp';
import { expect, fakeFrame, fakePdfcraft, fakeTurn, test, type LeitorMockHandle } from './fixtures';

interface EpubState {
  uid: string;
  section: number;
  sectionCount: number;
  cfi: string | null;
  tocLabel: string | null;
}
interface LeitorState {
  front: 'pdfcraft' | 'epub';
  activeId: string | null;
  page: number;
  epub: EpubState | null;
  openIds: string[];
  selection: { text: string; cfi?: string | null; unit?: string } | null;
  found: { id: string; page: number; query: string; found: boolean } | null;
}
type W = {
  __leitorMock: LeitorMockHandle & {
    positions: Record<string, { page: number; cfi: string | null; progress: number }>;
    anki: LeitorMockHandle['anki'];
  };
  __leitor: {
    state(): LeitorState;
    openBook(uid: string, o?: { page?: number; find?: string; cfi?: string }): Promise<boolean>;
    core: { ankiDeckCreate(name: string): Promise<number> };
  };
  __epubReader?: { selectText(text: string): boolean };
};

const state = (page: Page) => page.evaluate(() => (window as unknown as W).__leitor.state());
const panel = (page: Page) => page.getByTestId('book-panel');
const form = (page: Page) => page.getByRole('form', { name: 'Novo card' });

async function epubUid(page: Page): Promise<string> {
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__leitorMock);
  return page.evaluate(
    () => (window as unknown as W).__leitorMock.books.find((b) => b.title === 'The Time Machine')!.bookUid,
  );
}

async function readerReady(page: Page) {
  await expect(page.getByTestId('epub-reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
}

/** The Time Machine from the Biblioteca, in the EPUB reader (`before` runs once the mock core is there). */
async function openTimeMachine(page: Page, before?: () => Promise<void>): Promise<string> {
  await page.goto('/biblioteca');
  const uid = await epubUid(page);
  await before?.();
  await page.getByTestId('book-title').filter({ hasText: 'The Time Machine' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await readerReady(page);
  await expect(page.getByTestId('leitor-host')).toHaveAttribute('data-front', 'epub');
  return uid;
}

/** Goes to a section and waits until the reader reports it (location with a CFI). */
async function goToSection(page: Page, uid: string, section: number) {
  await page.evaluate(([u, s]) => (window as unknown as W).__leitor.openBook(u as string, { page: s as number }), [
    uid,
    section,
  ] as const);
  await expect.poll(async () => (await state(page)).epub?.section).toBe(section);
  await expect.poll(async () => (await state(page)).epub?.cfi ?? '').toMatch(/^epubcfi\(/);
}

test.beforeEach(async ({ page }) => {
  await fakePdfcraft(page);
});

test('opens an EPUB from the library in the EPUB reader, with the book panel', async ({ page }) => {
  const uid = await openTimeMachine(page);
  const s = await state(page);
  expect(s).toMatchObject({ front: 'epub', activeId: uid, epub: { uid, sectionCount: 8 } });
  await expect(panel(page)).toContainText('The Time Machine');
  await expect(panel(page).getByRole('region', { name: /^Cards deste capítulo \(cap\. \d+\)$/ })).toBeVisible();
  // No PdfCraft for an EPUB: its layer stays hidden.
  await expect(page.getByTestId('leitor-pdfcraft')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('epub-back-to-pdfs')).toHaveCount(0);
});

test('opens from the library under the desktop app CSP with no violation', async ({ page, consoleErrors }) => {
  // The app's CSP (tauri.conf.json) as a response header, Vite's inline preamble allowed by hash only: the blob:
  // section iframes of foliate inherit it. Not covered: WebKitGTK's matching of 'self' for the tauri:// origin.
  const violations: string[] = [];
  const withPolicy: string[] = [];
  await withCsp(page, violations, withPolicy, { strictInline: true });
  await openTimeMachine(page);
  await expect(page.getByTestId('epub-reader')).toHaveAttribute('data-status', 'ready');
  await expect
    .poll(() => page.frames().filter((f) => f.url().startsWith('blob:') && !f.isDetached()).length)
    .toBeGreaterThan(0);
  expect(withPolicy.some((u) => u.endsWith('/biblioteca'))).toBe(true);
  expect(violations).toEqual([]);
  dropDevWebsocketErrors(consoleErrors);
});

test('keeps the place (CFI) across a restart', async ({ page }) => {
  const uid = await openTimeMachine(page);
  await goToSection(page, uid, 3);
  // The TOC label comes with the reader's location event, which can land just after the section.
  await expect.poll(async () => (await state(page)).epub?.tocLabel ?? null).not.toBeNull();
  const before = (await state(page)).epub!;
  // Written to the core (debounced): the section and its CFI.
  await expect
    .poll(() => page.evaluate((u) => (window as unknown as W).__leitorMock.positions[u], uid))
    .toMatchObject({ page: 3, cfi: expect.stringMatching(/^epubcfi\(/) });
  const saved = await page.evaluate((u) => (window as unknown as W).__leitorMock.positions[u]!.cfi, uid);

  await page.reload();
  await page.goto('/biblioteca');
  await page.getByTestId('book-title').filter({ hasText: 'The Time Machine' }).click();
  await readerReady(page);
  // Section, TOC label and CFI arrive in the reader's events one after another: wait for all three together.
  await expect
    .poll(async () => {
      const e = (await state(page)).epub;
      return { section: e?.section, tocLabel: e?.tocLabel, cfi: e?.cfi };
    })
    .toEqual({ section: 3, tocLabel: before.tocLabel, cfi: saved });
});

test('a card from the selection gets a chapter/CFI Fonte, shows in "Cards deste capítulo" and opens from the Anki tab', async ({
  page,
}) => {
  // A deck of its own (created before the app reads the deck list), so the Anki tab studies just this card.
  let deck = 0;
  const uid = await openTimeMachine(page, async () => {
    deck = await page.evaluate(() => (window as unknown as W).__leitor.core.ankiDeckCreate('EPUB e2e'));
  });
  await goToSection(page, uid, 1);

  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__epubReader?.selectText('The Time Traveller') ?? false))
    .toBe(true);
  await expect.poll(async () => (await state(page)).selection?.text).toBe('The Time Traveller');
  const selection = (await state(page)).selection!;
  expect(selection).toMatchObject({ unit: 'chapter', cfi: expect.stringMatching(/^epubcfi\(/) });

  // Ctrl+Shift+N (from the app document or forwarded by the reader from inside the book).
  await page.keyboard.press('Control+Shift+N');
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByRole('textbox', { name: 'Frente' })).toHaveValue('The Time Traveller');
  const fonte = form(page).getByTestId('card-form-fonte');
  await expect(fonte).toHaveText(/^The Time Machine, /);
  const href = (await fonte.getAttribute('data-href'))!;
  expect(href).toContain(`leitor://livro/${uid}?cap=2`);
  expect(href).toContain(`cfi=${encodeURIComponent(selection.cfi!)}`);
  expect(href).toContain('q=The%20Time%20Traveller');

  await form(page).getByRole('combobox', { name: 'Deck' }).selectOption(String(deck));
  const back = form(page).getByRole('textbox', { name: 'Verso' });
  await back.fill('o Viajante do Tempo');
  await back.press('Control+Enter');
  await expect(page.getByText('Card adicionado')).toBeVisible();
  const chapterCards = panel(page).getByRole('region', { name: 'Cards deste capítulo (cap. 2)' });
  await expect(chapterCards).toContainText('The Time Traveller');

  // The Anki tab: study the deck, "Abrir no livro" → back in the reader at that CFI, with the passage found.
  await page.goto(`/anki/estudar?deck=${deck}`);
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-shown', 'question');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-shown', 'answer');
  await page.getByRole('button', { name: 'Abrir no livro' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await readerReady(page);
  await expect
    .poll(async () => (await state(page)).found)
    .toEqual({ id: uid, page: 1, query: 'The Time Traveller', found: true });
  await expect.poll(async () => (await state(page)).epub?.section).toBe(1);
});

test('a deep link with cap and cfi opens the chapter and finds the passage', async ({ page }) => {
  const uid = await openTimeMachine(page);
  await goToSection(page, uid, 5);
  await page.getByRole('link', { name: 'Anki' }).click();
  await expect(page).toHaveURL(/\/anki/);
  await page.evaluate(
    (u) => (window as unknown as W).__leitorMock.deepLink(`leitor://livro/${u}?cap=3&q=Psychologist`),
    uid,
  );
  await expect(page).toHaveURL(/\/leitor/);
  await expect
    .poll(async () => (await state(page)).found)
    .toEqual({ id: uid, page: 2, query: 'Psychologist', found: true });
  await expect.poll(async () => (await state(page)).epub?.section).toBe(2);
});

test('switching to a PDF and back keeps both readers loaded', async ({ page }) => {
  await page.goto('/biblioteca');
  const farm = await page.evaluate(
    () => (window as unknown as W).__leitorMock.books.find((b) => b.title === 'Animal Farm')!.bookUid,
  );
  await page.getByTestId('book-title').filter({ hasText: 'Animal Farm' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await fakeFrame(page);
  await fakeTurn(page, 2);
  await expect(page.getByTestId('leitor-host')).toHaveAttribute('data-front', 'pdfcraft');

  await page.getByRole('link', { name: 'Biblioteca' }).click();
  await page.getByTestId('book-title').filter({ hasText: 'The Time Machine' }).click();
  await readerReady(page);
  const uid = await epubUid(page);
  await expect(page.getByTestId('leitor-host')).toHaveAttribute('data-front', 'epub');
  await expect(panel(page)).toContainText('The Time Machine');

  // "Voltar aos PDFs": PdfCraft in front at the page it was, the EPUB still loaded behind.
  await page.getByTestId('epub-back-to-pdfs').click();
  await expect(page.getByTestId('leitor-host')).toHaveAttribute('data-front', 'pdfcraft');
  await expect.poll(() => state(page)).toMatchObject({ front: 'pdfcraft', activeId: farm, page: 2, epub: { uid } });
  await expect(panel(page)).toContainText('Animal Farm');
  await expect(page.getByTestId('leitor-epub')).toHaveAttribute('aria-hidden', 'true');

  // Back to the EPUB from the library: no reload of the book, same place.
  const section = (await state(page)).epub!.section;
  await page.getByRole('link', { name: 'Biblioteca' }).click();
  await page.getByTestId('book-title').filter({ hasText: 'The Time Machine' }).click();
  await expect(page.getByTestId('leitor-host')).toHaveAttribute('data-front', 'epub');
  await expect.poll(() => state(page)).toMatchObject({ front: 'epub', activeId: uid, epub: { section } });
  expect((await state(page)).openIds).toContain(farm);
});
