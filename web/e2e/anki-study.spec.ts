// "Estudar" against the mock core (spec 8.2, 8.4, 21): the card in its sandboxed frame (vite-plugin-anki-card serves
// reviewer.html + card-bridge.js + reviewer.js, the real one when scripts/fetch-anki-web.sh ran, else a stub), the
// answer flow, keys, undo, MathJax, type-in-the-answer, and the frame's isolation.
import type { Frame, Page } from '@playwright/test';
import { ankiLogs, expect, fakePdfcraft, fakeReceived, shot, stubPdfcraft, suspendCards, test } from './fixtures';

/** Like fixtures' setTheme, but only in the app's top window: the sandboxed card frame has no localStorage. */
async function setAppTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => {
    if (window !== window.top) return;
    try {
      localStorage.setItem('leitor.theme', t);
    } catch {
      // Not persisted.
    }
  }, theme);
}

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

const studyUrl = (deck: string) => `/anki/estudar?nome=${encodeURIComponent(deck)}`;
const cardFrameEl = (page: Page) => page.locator('iframe[title="Card"]');
const card = (page: Page) => page.frameLocator('iframe[title="Card"]');
const counts = (page: Page) => page.getByTestId('study-counts');
const showAnswer = (page: Page) => page.getByRole('button', { name: 'Mostrar resposta' });
const good = (page: Page) => page.getByRole('button', { name: /^Bom/ });

async function shown(page: Page, side: 'question' | 'answer') {
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-shown', side);
}

/** The card frame as a Playwright Frame (for evaluate). */
async function frameOf(page: Page): Promise<Frame> {
  const handle = await cardFrameEl(page).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('no card frame');
  return frame;
}

/** Answers "Bom" until the card on screen shows the fixture image (the deck starts with a learning card). */
async function studyUntilImage(page: Page) {
  for (let i = 0; i < 6; i++) {
    await shown(page, 'question');
    if ((await card(page).locator('img[src="fixture-image.png"]').count()) > 0) return;
    await showAnswer(page).click();
    await shown(page, 'answer');
    await good(page).click();
  }
  throw new Error('no image card');
}

async function hasAnkiWeb(page: Page): Promise<boolean> {
  const res = await page.request.get('/_anki/js/vendor/mathjax/tex-chtml-full.js');
  return res.ok();
}

test('the card frame is sandboxed and cannot reach the app', async ({ page }) => {
  await page.goto(studyUrl('Oxford::Oxford 3000'));
  await shown(page, 'question');
  await expect(cardFrameEl(page)).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = await frameOf(page);
  const parentAccess = await frame.evaluate(() => {
    try {
      return typeof (parent as unknown as { __leitorMock?: unknown }).__leitorMock;
    } catch {
      return 'blocked';
    }
  });
  expect(parentAccess).toBe('blocked');
  const ipc = await frame.evaluate(
    () => typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
  expect(ipc).toBe('undefined');
  // Only the four card methods may be POSTed to the card origin (403 otherwise, like the app's card protocol).
  const post = (m: string) =>
    page.request.post(`/__card/_anki/${m}`, { headers: { 'Content-Type': 'application/binary' }, data: '' });
  expect((await post('addNote')).status()).toBe(403);
  expect((await post('importAnkiPackage')).status()).toBe(403);
  expect((await post('i18nResources')).status()).toBe(200);
});

test('studies 5000 palavras: image, play button, answer buttons, counters and undo', async ({ page }) => {
  await page.goto(studyUrl('5000 palavras'));
  await shown(page, 'question');
  await expect(counts(page)).toHaveText('3 + 1 + 3');

  // Space shows the answer; the four buttons carry the interval labels.
  await page.keyboard.press('Space');
  await shown(page, 'answer');
  for (const [name, n] of [
    ['De novo', 1],
    ['Difícil', 2],
    ['Bom', 3],
    ['Fácil', 4],
  ] as const) {
    await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(page.getByTestId(`interval-${n}`)).not.toBeEmpty();
  }

  // Three answers "Bom": the counters move and the answers reach the core.
  await page.keyboard.press('Enter');
  for (let i = 0; i < 2; i++) {
    await shown(page, 'question');
    await page.keyboard.press('Space');
    await shown(page, 'answer');
    await page.keyboard.press('3');
  }
  await shown(page, 'question');
  await expect(counts(page)).not.toHaveText('3 + 1 + 3');
  const answers = (await ankiLogs(page)).filter((l) => l.kind === 'answer');
  expect(answers).toHaveLength(3);
  expect(answers.every((a) => a.rating === 3)).toBe(true);

  // Ctrl+Z brings the last card back.
  const before = await counts(page).textContent();
  await page.keyboard.press('Control+z');
  await expect(counts(page)).not.toHaveText(before ?? '');
  expect((await ankiLogs(page)).filter((l) => l.kind === 'undo')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Desfazer resposta' })).toBeDisabled();

  // The image card: the picture is inside the frame, the answer has a play button.
  await studyUntilImage(page);
  const img = card(page).locator('img[src="fixture-image.png"]');
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await showAnswer(page).click();
  await shown(page, 'answer');
  await expect(card(page).locator('a.replay-button').first()).toBeVisible();
});

test('Matemática renders MathJax', async ({ page }) => {
  test.skip(!(await hasAnkiWeb(page)), 'anki-web assets missing (scripts/fetch-anki-web.sh): the stub has no MathJax');
  await page.goto(studyUrl('Matemática'));
  await shown(page, 'question');
  await expect(card(page).locator('mjx-container').first()).toBeVisible({ timeout: 15_000 });
});

test('ROS 2 — Revisão: type the answer, Enter shows the comparison', async ({ page }) => {
  // The stock "type in the answer" card (the code cards of the deck use the code panel, e2e/code-review.spec.ts).
  await page.goto('/anki');
  await suspendCards(page, 'deck:"ROS 2 — Revisão" -note:"Básico (digite a resposta)"');
  await page.goto(studyUrl('ROS 2 — Revisão'));
  await shown(page, 'question');
  const input = card(page).locator('#typeans');
  await expect(input).toBeVisible();
  await input.fill('colcon build');
  await input.press('Enter');
  await shown(page, 'answer');
  await expect(card(page).locator('code#typeans .typeGood').first()).toBeVisible();
  await expect(card(page).locator('code#typeans .typeBad')).toHaveCount(0);
});

test('E edits, * marks, - buries and @ suspends from the keyboard', async ({ page }) => {
  await page.goto(studyUrl('Oxford::Oxford 3000'));
  await shown(page, 'question');
  const first = await page.getByTestId('study-page').getAttribute('data-card-id');

  await page.keyboard.press('*');
  await expect.poll(async () => (await ankiLogs(page)).filter((l) => l.kind === 'mark')).toHaveLength(1);

  await page.keyboard.press('e');
  const editor = page.getByRole('dialog', { name: 'Editar nota' });
  await expect(editor).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();

  await page.keyboard.press('-');
  await expect.poll(async () => (await ankiLogs(page)).filter((l) => l.kind === 'bury')).toHaveLength(1);
  await shown(page, 'question');
  await expect(page.getByTestId('study-page')).not.toHaveAttribute('data-card-id', first ?? '');

  await page.keyboard.press('@');
  await expect.poll(async () => (await ankiLogs(page)).filter((l) => l.kind === 'suspend')).toHaveLength(1);
  // Neither is an answer: Ctrl+Z stays disabled.
  await expect(page.getByRole('button', { name: 'Desfazer resposta' })).toBeDisabled();
});

test('?resposta=1 opens the first card with its answer shown', async ({ page }) => {
  for (const deck of ['5000 palavras', 'Matemática']) {
    await page.goto(`${studyUrl(deck)}&resposta=1`);
    await shown(page, 'answer');
    await expect(page.getByRole('button', { name: /^Bom/ })).toBeVisible();
  }
});

test('Gramática::Cloze shows the cloze and its answer', async ({ page }) => {
  await page.goto(studyUrl('Gramática::Cloze'));
  await shown(page, 'question');
  await expect(card(page).locator('.cloze').first()).toBeVisible();
  await page.keyboard.press('Space');
  await shown(page, 'answer');
  await expect(card(page).locator('.cloze').first()).not.toHaveText('[...]');
});

test('Abrir no livro opens the book of the Fonte link in the Leitor and finds the excerpt there', async ({ page }) => {
  await fakePdfcraft(page);
  await page.goto(studyUrl('Livros::Animal Farm'));
  await shown(page, 'question');
  await page.keyboard.press('Space');
  await shown(page, 'answer');
  const button = page.getByRole('button', { name: 'Abrir no livro' });
  // "Abrir o livro em Animal Farm, p. N": the page of the Fonte link (1-based).
  const pageN = Number(/p\. (\d+)/.exec((await button.getAttribute('title')) ?? '')?.[1]);
  expect(pageN).toBeGreaterThan(0);
  await button.click();
  await expect(page).toHaveURL(/\/leitor/);
  // PdfCraft is asked for that page (0-based; the fake PdfCraft has 60 pages, like the mock book) and to find the excerpt of the link.
  await expect
    .poll(async () =>
      (await fakeReceived(page)).some(
        (m) =>
          (m.type === 'pdfcraft:goto' || m.type === 'pdfcraft:open') &&
          m.page === Math.min(pageN - 1, 59) &&
          typeof m.find === 'string' &&
          m.find.length > 0,
      ),
    )
    .toBe(true);
});

for (const theme of ['light', 'dark'] as const) {
  test(`screenshots of the study screen (${theme})`, async ({ page }, info) => {
    await setAppTheme(page, theme);
    await page.goto(studyUrl('5000 palavras'));
    await studyUntilImage(page);
    await expect(card(page).locator('img[src="fixture-image.png"]')).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`anki-study-question-${theme}`, info.project.name) });
    await showAnswer(page).click();
    await shown(page, 'answer');
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`anki-study-answer-${theme}`, info.project.name) });
  });
}
