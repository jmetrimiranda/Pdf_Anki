// `leitor://livro/<uid>?pagina=N&q=…` deep links (spec 10.2) against the mocked core and the scripted fake PdfCraft
// (bridge v2): a link given at launch and one forwarded while the app runs open the book at the page and ask PdfCraft
// to find the passage; an unknown book shows a notice; an invalid URL is ignored.
import type { Page } from '@playwright/test';
import { expect, fakePdfcraft, fakeReceived, test } from './fixtures';

async function farmUid(page: Page): Promise<string> {
  await page.waitForFunction(() => !!window.__leitorMock);
  return page.evaluate(() => window.__leitorMock!.books.find((b) => b.title === 'Animal Farm')!.bookUid);
}

/** The messages the app sent to PdfCraft about `uid`, without the bytes. */
async function sentAbout(page: Page, uid: string) {
  return (await fakeReceived(page))
    .filter((m) => m.id === uid && (m.type === 'pdfcraft:open' || m.type === 'pdfcraft:goto'))
    .map(({ type, page: p, find }) => ({ type, page: p, ...(find === undefined ? {} : { find }) }));
}

async function found(page: Page) {
  return page.evaluate(() => window.__leitor!.state().found);
}

test.beforeEach(async ({ page }) => {
  await fakePdfcraft(page);
});

test('a link the app was launched with opens the book at the page and finds the passage', async ({ page }) => {
  await page.goto('/biblioteca');
  const uid = await farmUid(page);
  await page.addInitScript((url) => {
    (window as unknown as { __leitorMockInit?: unknown }).__leitorMockInit = { pendingDeepLinks: [url] };
  }, `leitor://livro/${uid}?pagina=3&q=the%20windmill`);
  await page.reload();
  await expect(page).toHaveURL(/\/leitor/);
  await expect
    .poll(() => sentAbout(page, uid))
    .toEqual([
      { type: 'pdfcraft:open', page: 2 },
      { type: 'pdfcraft:goto', page: 2, find: 'the windmill' },
    ]);
  await expect.poll(() => found(page)).toEqual({ id: uid, page: 2, query: 'the windmill', found: true });
  await expect.poll(() => page.evaluate(() => window.__leitor!.state().page)).toBe(2);
});

test('a link forwarded while the app runs opens the book; the next one only moves it', async ({ page }) => {
  await page.goto('/biblioteca');
  const uid = await farmUid(page);
  await page.evaluate((u) => window.__leitorMock!.deepLink(`leitor://livro/${u}?pagina=2&q=Old%20Major`), uid);
  await expect(page).toHaveURL(/\/leitor/);
  await expect.poll(() => found(page)).toMatchObject({ page: 1, query: 'Old Major', found: true });

  // From another tab: back to the Leitor, PdfCraft already has the book, so only a goto (no bytes).
  await page.getByRole('link', { name: 'Anki' }).click();
  await expect(page).toHaveURL(/\/anki/);
  await page.evaluate((u) => window.__leitorMock!.deepLink(`leitor://livro/${u}?pagina=5&q=windmill`), uid);
  await expect(page).toHaveURL(/\/leitor/);
  await expect.poll(() => found(page)).toMatchObject({ page: 4, query: 'windmill', found: true });
  expect(await sentAbout(page, uid)).toEqual([
    { type: 'pdfcraft:open', page: 1 },
    { type: 'pdfcraft:goto', page: 1, find: 'Old Major' },
    { type: 'pdfcraft:goto', page: 4, find: 'windmill' },
  ]);
});

test('a link to a book this computer does not have shows a notice; an invalid one is ignored', async ({ page }) => {
  await page.goto('/biblioteca');
  await page.waitForFunction(() => !!window.__leitorMock);
  await page.evaluate(() => window.__leitorMock!.deepLink(`leitor://livro/${'f'.repeat(64)}?pagina=3&q=x`));
  await expect(page.getByText('Este livro não está na Biblioteca deste computador.')).toBeVisible();
  await expect(page).toHaveURL(/\/biblioteca/);

  for (const url of ['leitor://livro/abc?pagina=3', 'https://example.com/livro/x', 'leitor://evil/../../x']) {
    await page.evaluate((u) => window.__leitorMock!.deepLink(u), url);
  }
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/biblioteca/);
  await expect(page.getByTestId('leitor-host')).toHaveCount(0);
});
