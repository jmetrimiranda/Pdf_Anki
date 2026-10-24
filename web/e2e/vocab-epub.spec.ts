// The vocabulary scan of an EPUB (spec 12 for EPUB, 21 Phase 7) against the mocked core and the real EPUB reader:
// the wizard's "Por sumário" on a nested TOC item, the report in chapters ("cap. N"), then "Realçar vocabulário"
// underlines the words in the reader and a click on one opens the reading popover.
import type { Page } from '@playwright/test';
import { bookUid, expect, stubPdfcraft, test, vocabMock } from './fixtures';

type Overlay = { kind: string; color: string | null; id: string | null; rects: number };
type W = {
  __leitorMock: { anki: { deckNames: string[] } };
  __leitor: {
    state(): { front: string; epub: { uid: string; section: number; cfi: string | null } | null };
    openBook(uid: string, o?: { page?: number }): Promise<boolean>;
  };
  __epubReader?: { overlays(): Overlay[]; rectOf(text: string): [number, number, number, number] | null };
};

function next(page: Page) {
  return page.getByTestId('vocab-wizard-footer').getByRole('button', { name: /^(Continuar|Escanear)$/ });
}

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

async function vocabRoot(page: Page): Promise<number> {
  await page.goto('/biblioteca');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__leitorMock);
  const names = await page.evaluate(() =>
    (
      window as unknown as { __leitor: { core: { ankiDeckNames(): Promise<{ id: number; name: string }[]> } } }
    ).__leitor.core.ankiDeckNames(),
  );
  return names.find((d) => d.name === 'Vocabulário')!.id;
}

test('scans an EPUB by its table of contents and reports in chapters; the reader underlines the words', async ({
  page,
}) => {
  const root = await vocabRoot(page);
  await page.evaluate(
    (id) => (window as unknown as { __leitorMock: { setVocabRoot(id: number): void } }).__leitorMock.setVocabRoot(id),
    root,
  );
  const uid = await bookUid(page, 'The Time Machine');
  await vocabMock.setMapping(page, 'Vocab (Word)', 'Word');
  await vocabMock.setMapping(page, 'Oxford (Front/Back)', 'Front');
  await page.goto(`/vocabulario/escanear?livro=${uid}&passo=trecho`);
  await expect(page.getByTestId('vocab-step-trecho')).toBeVisible();
  await expect(page.getByText('O livro todo: 8 capítulos.')).toBeVisible();

  // "Por sumário": a nested item (a chapter inside Part I).
  await page.getByRole('radio', { name: 'Por sumário' }).click();
  const tree = page.getByRole('tree', { name: 'Sumário do livro' });
  await tree.getByRole('checkbox', { name: 'Chapter II. The Machine' }).check();
  await expect(page.getByTestId('vocab-range-resolved')).toHaveText('Chapter II. The Machine (cap. 3) · 1 capítulo');
  // "Capítulos" uses the same syntax as pages.
  await page.getByRole('radio', { name: 'Capítulos' }).click();
  await page.getByTestId('vocab-range-pages').fill('2-4');
  await expect(page.getByTestId('vocab-range-resolved')).toHaveText('cap. 2–4 · 3 capítulos');
  await page.getByRole('radio', { name: 'Por sumário' }).click();
  await expect(tree.getByRole('checkbox', { name: 'Chapter II. The Machine' })).toBeChecked();
  await next(page).click();

  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
  await next(page).click();
  await expect(page).toHaveURL(/\/vocabulario\?livro=/, { timeout: 20_000 });
  await expect(page.getByTestId('vocab-range')).toHaveText('Trecho: Chapter II. The Machine (cap. 3)');
  const firstRow = page.getByTestId('vocab-row').first();
  await expect(firstRow).toContainText('cap. 3');
  await expect(page.getByRole('columnheader', { name: '1º cap.' })).toBeVisible();

  // A row opens the book at that chapter, finding the word there.
  const lemma = (await firstRow.getAttribute('data-lemma'))!;
  await firstRow.getByRole('button', { name: /^Abrir “.+” no livro, cap\. 3$/ }).click();
  await expect(page).toHaveURL(/\/leitor\?/);
  await expect(page.getByTestId('epub-reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__leitor.state().epub?.section)).toBe(2);
  expect(lemma).toBeTruthy();

  // "Realçar vocabulário": the reader underlines the unknown/learning words of the section (2 px lines, no fills).
  await page.getByTestId('book-panel').getByRole('switch', { name: 'Realçar vocabulário' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as W).__epubReader?.overlays().filter((o) => o.kind === 'vocab').length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  const marks = await page.evaluate(() =>
    (window as unknown as W).__epubReader!.overlays().filter((o) => o.kind === 'vocab'),
  );
  expect(new Set(marks.map((m) => m.color?.toLowerCase())).size).toBeGreaterThan(0);
  for (const m of marks) expect(['#d85a30', '#ba7517']).toContain(m.color?.toLowerCase());

  // A click on an underlined word opens the reading popover at it.
  const word = await page.evaluate(async (u) => {
    const words = await (
      window as unknown as {
        __leitor: { core: { vocabEpubMarks(uid: string, s: number[]): Promise<{ words: { form: string }[] }[]> } };
      }
    ).__leitor.core.vocabEpubMarks(u, [2]);
    // Longer forms first: a short one could match inside another word.
    return words[0]!.words.map((w) => w.form).sort((a, b) => b.length - a.length);
  }, uid);
  let clicked: string | null = null;
  for (const form of word) {
    const rect = await page.evaluate((f) => (window as unknown as W).__epubReader?.rectOf(f) ?? null, form);
    if (!rect || rect[2] <= 0) continue;
    const host = await page.getByTestId('epub-host').boundingBox();
    if (!host) continue;
    const x = host.x + rect[0] + rect[2] / 2;
    const y = host.y + rect[1] + rect[3] / 2;
    if (x < host.x || y < host.y || x > host.x + host.width || y > host.y + host.height) continue;
    await page.mouse.click(x, y);
    clicked = form;
    break;
  }
  expect(clicked).not.toBeNull();
  const popover = page.getByTestId('vocab-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Adicionar ao deck do livro' })).toBeVisible();
});
