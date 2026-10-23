// "Revisar aqui" (spec 10.1) against the mock core and the scripted fake PdfCraft: the mini-review in the book panel
// studies one of the book's decks with the Anki tab's engine (the card in the same sandboxed frame), switches the
// current deck and restores it on close, pauses the reading session (reason 'review'), only undoes an answer, and
// shares the study session with the Anki tab — one place at a time.
import type { Page } from '@playwright/test';
import { expect, fakeFrame, fakePdfcraft, shot, test, type LeitorMockHandle } from './fixtures';

type MockWindow = { __leitorMock: LeitorMockHandle & { anki: { currentDeckId: number; studyOwner: string | null } } };

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
  await fakePdfcraft(page);
});

async function mockValue<T>(page: Page, f: string): Promise<T> {
  await page.waitForFunction(() => !!(window as unknown as Partial<MockWindow>).__leitorMock);
  return page.evaluate((body) => {
    const m = (window as unknown as MockWindow).__leitorMock;
    return new Function('m', `return (${body});`)(m) as T;
  }, f);
}

const currentDeckId = (page: Page) => mockValue<number>(page, 'm.anki.currentDeckId');
const studyOwner = (page: Page) => mockValue<string | null>(page, 'm.anki.studyOwner');
const sessions = (page: Page) => mockValue<LeitorMockHandle['sessions']>(page, 'm.sessions');

const mini = (page: Page) => page.getByRole('region', { name: 'Revisão rápida' });
const panel = (page: Page) => page.getByTestId('book-panel');
const miniCard = (page: Page) => mini(page).locator('iframe[title="Card"]');

/** Opens Animal Farm in the Leitor (fake PdfCraft) with the book panel open. */
async function openAnimalFarm(page: Page) {
  await page.goto('/biblioteca');
  const uid = await mockValue<string>(page, "m.books.find((b) => b.title === 'Animal Farm').bookUid");
  await page.goto(`/leitor?livro=${uid}`);
  await fakeFrame(page);
  await expect(panel(page)).toHaveAttribute('data-open', 'true');
  return uid;
}

async function openReview(page: Page) {
  await panel(page)
    .getByRole('button', { name: /^Revisar aqui/ })
    .first()
    .click();
  await expect(mini(page)).toBeVisible();
  await expect(mini(page)).toHaveAttribute('data-side', 'question');
}

test('open → card in the sandboxed frame → answer → Ctrl+Z in the panel → close restores the deck', async ({
  page,
}) => {
  await openAnimalFarm(page);
  const before = await currentDeckId(page);
  // Times click → first card on screen in the page itself (no Playwright round trips in the measure).
  await page.evaluate(() => {
    const w = window as unknown as { __rvClick?: number; __rvShown?: number };
    document.addEventListener('click', () => (w.__rvClick ??= performance.now()), { capture: true, once: true });
    const obs = new MutationObserver(() => {
      if (document.querySelector('[data-testid="mini-review"][data-side="question"]')) {
        w.__rvShown ??= performance.now();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await openReview(page);
  const openMs = await page.evaluate(() => {
    const w = window as unknown as { __rvClick?: number; __rvShown?: number };
    return (w.__rvShown ?? Infinity) - (w.__rvClick ?? 0);
  });
  // Spec 10.1 budget with the mock core: the first card in < 300 ms.
  expect(openMs).toBeLessThan(300);
  await expect(miniCard(page)).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await studyOwner(page)).toBe('panel');
  expect(await currentDeckId(page)).not.toBe(before);
  // Reading pauses while the mini-review is open.
  await expect
    .poll(async () => (await sessions(page)).some((s) => s.kind === 'stop' && s.reason === 'review'))
    .toBe(true);

  const undo = mini(page).getByRole('button', { name: 'Desfazer resposta' });
  await expect(undo).toBeDisabled();
  await mini(page).getByRole('button', { name: 'Mostrar resposta' }).click();
  await expect(mini(page)).toHaveAttribute('data-side', 'answer');
  const cardId = await mini(page).getAttribute('data-card-id');
  await mini(page).getByRole('button', { name: /^Bom/ }).click();
  await expect(undo).toBeEnabled();
  // Focus in the panel: Ctrl+Z undoes the answer (the same card is back).
  await mini(page).focus();
  await page.keyboard.press('Control+z');
  await expect(mini(page)).toHaveAttribute('data-card-id', cardId ?? '');
  await expect(undo).toBeDisabled();
  const undos = await mockValue<number>(page, "m.anki.logs.filter((l) => l.kind === 'undo').length");
  expect(undos).toBe(1);

  const startsBefore = (await sessions(page)).filter((s) => s.kind === 'start').length;
  await mini(page).getByRole('button', { name: 'Encerrar revisão' }).first().click();
  await expect(mini(page)).toHaveCount(0);
  await expect.poll(() => currentDeckId(page)).toBe(before);
  // Reading resumes.
  await expect
    .poll(async () => (await sessions(page)).filter((s) => s.kind === 'start').length)
    .toBeGreaterThan(startsBefore);
});

test('one place studies at a time: the Anki tab takes over, "Continuar aqui" takes it back', async ({ page }) => {
  await openAnimalFarm(page);
  await openReview(page);

  // Switch to the Anki tab (in-app navigation: the mock's study session lives in memory) and study another deck.
  await page.getByRole('navigation', { name: 'Abas' }).getByRole('link', { name: 'Anki' }).click();
  await expect(page).toHaveURL(/\/anki/);
  await page.getByRole('tree', { name: 'Decks' }).getByRole('button', { name: 'Oxford 3000', exact: true }).click();
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-side', 'question');
  await expect(page.getByText('A revisão rápida do painel foi pausada.')).toBeVisible();
  expect(await studyOwner(page)).toBe('tab');
  const tabDeck = await currentDeckId(page);

  // Back to the Leitor: the panel is paused.
  await page.getByRole('navigation', { name: 'Abas' }).getByRole('link', { name: 'Leitor' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await expect(mini(page)).toHaveAttribute('data-paused', 'true');
  await expect(mini(page).getByText('Revisão pausada: você começou a estudar na aba Anki.')).toBeVisible();
  await mini(page).getByRole('button', { name: 'Continuar aqui' }).click();
  await expect(mini(page)).toHaveAttribute('data-paused', 'false');
  await expect(mini(page)).toHaveAttribute('data-side', 'question');
  expect(await studyOwner(page)).toBe('panel');

  // The Anki tab's choice wins: closing restores the deck it chose (it took the session over).
  await mini(page).getByRole('button', { name: 'Encerrar revisão' }).first().click();
  await expect.poll(() => currentDeckId(page)).toBe(tabDeck);
  expect(await studyOwner(page)).toBeNull();
});

for (const theme of ['light', 'dark'] as const) {
  test(`screenshots of the mini-review (${theme})`, async ({ page }, info) => {
    await setAppTheme(page, theme);
    // The fake PdfCraft reports no theme: the panel (and its card) follow the system's, like the app here.
    await page.emulateMedia({ colorScheme: theme });
    await openAnimalFarm(page);
    await openReview(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`painel-revisao-question-${theme}`, info.project.name) });
    await mini(page).getByRole('button', { name: 'Mostrar resposta' }).click();
    await expect(mini(page)).toHaveAttribute('data-side', 'answer');
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`painel-revisao-answer-${theme}`, info.project.name) });
  });
}
