// "Reconhecer texto" (spec 6.6, 7.2) against the mock core: the scanned book's badge and action, the dialog (English
// only, time estimate, new version), the background job with progress, cancel and "models missing", the
// `/biblioteca?ocr=<uid>` link, the book panel's notice, and EPUB items in the library. The mock OCR job walks the
// pages with `job://` progress like `app/src/ocr.rs` (src/lib/core/mock/ocr.ts).
import type { Page } from '@playwright/test';
import { dropPaths, expect, fakeFrame, fakePdfcraft, shot, test, vocabMock, type LeitorMockHandle } from './fixtures';

/** `window.__leitorMock.ocr` (src/lib/core/mock/ocr.ts). */
interface OcrHandle {
  setModelsAvailable(available: boolean): void;
  setPageDelay(ms: number | null): void;
}
type MockWindow = { __leitorMock: LeitorMockHandle & { ocr: OcrHandle } };

const SCANNED = 'Apostila digitalizada';
const DONE = 'Texto reconhecido: agora dá para buscar, selecionar e escanear o vocabulário deste livro.';

test.beforeEach(async ({ page }) => {
  await fakePdfcraft(page);
});

async function mockReady(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as Partial<MockWindow>).__leitorMock);
}

/** The mock OCR settings live in memory: set them after every page load. */
async function ocrMock(page: Page, opts: { pageDelay?: number | null; models?: boolean }) {
  await mockReady(page);
  await page.evaluate((o) => {
    const ocr = (window as unknown as MockWindow).__leitorMock.ocr;
    if (o.pageDelay !== undefined) ocr.setPageDelay(o.pageDelay);
    if (o.models !== undefined) ocr.setModelsAvailable(o.models);
  }, opts);
}

async function book(page: Page, title: string) {
  await mockReady(page);
  return page.evaluate((t) => (window as unknown as MockWindow).__leitorMock.books.find((b) => b.title === t)!, title);
}

const item = (page: Page, title: string) => page.getByTestId('book').filter({ hasText: title });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Reconhecer texto' });

test('a scanned book: quiet badge, "Reconhecer texto", the English-only dialog with the estimate', async ({
  page,
}, info) => {
  await page.goto('/biblioteca');
  const scanned = item(page, SCANNED);
  await expect(scanned.getByText('Parece escaneado')).toBeVisible();
  // Books with text have neither.
  await expect(item(page, 'Animal Farm').getByText('Parece escaneado')).toHaveCount(0);
  await expect(item(page, 'Animal Farm').getByRole('button', { name: 'Reconhecer texto' })).toHaveCount(0);

  // Also in the book's menu.
  await page.getByRole('button', { name: `Ações do livro ${SCANNED}` }).click();
  await expect(page.getByRole('menuitem', { name: 'Reconhecer texto' })).toBeVisible();
  await page.keyboard.press('Escape');

  await scanned.getByRole('button', { name: 'Reconhecer texto' }).click();
  await expect(dialog(page)).toContainText('lê livros escaneados em inglês');
  await expect(dialog(page)).toContainText('livros em português não ficam corretos');
  // 8 pages at the default 4 s/page: under a minute.
  await expect(dialog(page).getByTestId('ocr-estimate')).toContainText(
    'Leva alguns segundos por página — menos de 1 min para este livro.',
  );
  await expect(dialog(page)).toContainText('nova versão do PDF');
  await expect(dialog(page).getByRole('button', { name: 'Reconhecer texto' })).toBeEnabled();
  await page.screenshot({ path: shot('ocr-dialog', info.project.name) });
  await dialog(page).getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('start → progress page by page → done: the badge goes and the book has a new version', async ({ page }, info) => {
  await page.goto('/biblioteca');
  await ocrMock(page, { pageDelay: 250 });
  const before = await book(page, SCANNED);
  const scanned = item(page, SCANNED);
  await scanned.getByRole('button', { name: 'Reconhecer texto' }).click();
  await dialog(page).getByRole('button', { name: 'Reconhecer texto' }).click();
  await expect(dialog(page)).toHaveCount(0);

  const progress = scanned.getByTestId('ocr-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/Reconhecendo texto… página \d de 8/);
  await page.screenshot({ path: shot('ocr-progress', info.project.name) });
  // It advances (the bar's value grows) until the new version is written.
  const value = () => progress.getByRole('progressbar').getAttribute('aria-valuenow');
  const first = Number((await value()) ?? 0);
  await expect.poll(async () => Number((await value()) ?? -1)).toBeGreaterThan(first);

  await expect(page.getByText(DONE)).toBeVisible({ timeout: 15_000 });
  await expect(scanned.getByText('Parece escaneado')).toHaveCount(0);
  await expect(scanned.getByRole('button', { name: 'Reconhecer texto' })).toHaveCount(0);
  await expect.poll(async () => (await book(page, SCANNED)).fileVersion).toBe(before.fileVersion + 1);
  // The measured speed is kept for the next estimate.
  expect(await page.evaluate(() => Number(localStorage.getItem('leitor.ocr.msPerPage')))).toBeGreaterThan(0);
});

test('390 px list: a running OCR shows its progress and cancel on the item, from the ⋯ menu', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/biblioteca');
  await ocrMock(page, { pageDelay: 600 });
  const scanned = item(page, SCANNED);
  // The plain offer lives in the menu on narrow screens.
  await expect(scanned.getByRole('button', { name: 'Reconhecer texto' })).toBeHidden();
  await scanned.getByRole('button', { name: `Ações do livro ${SCANNED}` }).click();
  await page.getByRole('menuitem', { name: 'Reconhecer texto' }).click();
  await dialog(page).getByRole('button', { name: 'Reconhecer texto' }).click();
  await expect(dialog(page)).toHaveCount(0);

  const progress = scanned.getByTestId('ocr-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/Reconhecendo texto… página \d de 8/);
  const cancel = scanned.getByRole('button', { name: `Cancelar o reconhecimento de texto de ${SCANNED}` });
  await expect(cancel).toBeVisible();
  // The row fits the screen (no horizontal overflow).
  const box = await scanned.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: shot('ocr-progress-390', info.project.name) });
  await cancel.click();
  await expect(page.getByText('Reconhecimento de texto cancelado. Nada mudou no livro.')).toBeVisible();
  await expect(progress).toHaveCount(0);
});

test('cancel mid-way: back to the offer, nothing changed', async ({ page }) => {
  await page.goto('/biblioteca');
  await ocrMock(page, { pageDelay: 600 });
  const before = await book(page, SCANNED);
  const scanned = item(page, SCANNED);
  await scanned.getByRole('button', { name: 'Reconhecer texto' }).click();
  await dialog(page).getByRole('button', { name: 'Reconhecer texto' }).click();
  await expect(scanned.getByTestId('ocr-progress')).toContainText(/Reconhecendo texto… página/);
  await scanned.getByRole('button', { name: `Cancelar o reconhecimento de texto de ${SCANNED}` }).click();
  await expect(page.getByText('Reconhecimento de texto cancelado. Nada mudou no livro.')).toBeVisible();
  await expect(scanned.getByRole('button', { name: 'Reconhecer texto' })).toBeVisible();
  await expect(scanned.getByText('Parece escaneado')).toBeVisible();
  expect((await book(page, SCANNED)).fileVersion).toBe(before.fileVersion);
});

test('without the OCR models the action is disabled and says why', async ({ page }) => {
  await page.goto('/biblioteca');
  await ocrMock(page, { models: false });
  await item(page, SCANNED).getByRole('button', { name: 'Reconhecer texto' }).click();
  await expect(dialog(page)).toContainText(
    'Os modelos de reconhecimento de texto (OCR) não estão instalados. Reinstale o app.',
  );
  await expect(dialog(page).getByRole('button', { name: 'Reconhecer texto' })).toBeDisabled();
});

test('/biblioteca?ocr=<uid> opens the dialog for that book', async ({ page }) => {
  await page.goto('/biblioteca');
  const { bookUid } = await book(page, SCANNED);
  await page.goto(`/biblioteca?ocr=${bookUid}`);
  await expect(dialog(page)).toBeVisible();
  await expect(page).toHaveURL(/\/biblioteca$/);
});

test('/biblioteca?ocr=<uid> of a book with text only clears the URL', async ({ page }) => {
  await page.goto('/biblioteca');
  const { bookUid } = await book(page, 'Animal Farm');
  await page.goto(`/biblioteca?ocr=${bookUid}`);
  await expect(page).toHaveURL(/\/biblioteca$/);
  await expect(item(page, 'Animal Farm')).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});

test('the vocabulary wizard of a scanned book leads to "Reconhecer texto"', async ({ page }) => {
  await page.goto('/biblioteca');
  const { bookUid } = await book(page, SCANNED);
  await vocabMock.setMapping(page, 'Vocab (Word)', 'Word');
  await vocabMock.setMapping(page, 'Oxford (Front/Back)', 'Front');
  await page.goto(`/vocabulario/escanear?livro=${bookUid}`);
  await expect(page.getByTestId('vocab-step-pasta')).toBeVisible();
  const next = page.getByTestId('vocab-wizard-footer').getByRole('button', { name: /^(Continuar|Escanear)$/ });
  // Pasta → Trecho → Critério (the fields are mapped) → Escanear: the core refuses a book without text.
  await next.click();
  await expect(page.getByTestId('vocab-step-trecho')).toBeVisible();
  await next.click();
  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
  await next.click();
  await page.getByTestId('vocab-needs-ocr').click();
  await expect(page).toHaveURL(/\/biblioteca$/);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('lê livros escaneados em inglês');
});

test('the book panel offers OCR for the open scanned PDF and shows the progress', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/biblioteca');
  // The fake PdfCraft reports 60 pages (the app stores PdfCraft's count): the quickest mock pace.
  await ocrMock(page, { pageDelay: 100 });
  await page.getByTestId('book-title').filter({ hasText: SCANNED }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await fakeFrame(page);
  const notice = page.getByTestId('ocr-panel-notice');
  await expect(notice).toContainText('Este livro parece escaneado.');
  await notice.getByRole('button', { name: 'Reconhecer texto' }).click();
  await dialog(page).getByRole('button', { name: 'Reconhecer texto' }).click();
  await expect(notice.getByTestId('ocr-progress')).toBeVisible();
  await expect(page.getByText(DONE)).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);

  // A book with text has no notice.
  await page.goto('/biblioteca');
  await page.getByTestId('book-title').filter({ hasText: 'Animal Farm' }).click();
  await fakeFrame(page);
  await expect(page.getByTestId('book-panel')).toContainText('Animal Farm');
  await expect(page.getByTestId('ocr-panel-notice')).toHaveCount(0);
});

test('the library takes a dropped .epub and marks it EPUB; other formats are refused', async ({ page }) => {
  await page.goto('/biblioteca');
  await mockReady(page);
  await dropPaths(page, ['/home/jorge/Livros/Um livro novo.epub']);
  const epub = item(page, 'Um livro novo');
  await expect(epub).toBeVisible();
  await expect(epub.getByTestId('format-badge')).toHaveText('EPUB');
  await expect(epub.getByText('Parece escaneado')).toHaveCount(0);

  await dropPaths(page, ['/home/jorge/Livros/notas.txt']);
  await expect(
    page.getByText(
      'Não foi possível adicionar notas.txt: Formato não suportado. A biblioteca aceita arquivos PDF e EPUB.',
    ),
  ).toBeVisible();
});
