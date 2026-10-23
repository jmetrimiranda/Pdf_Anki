// "Painel Anki do livro" (spec 10, 12.7) against the mock core and the scripted fake PdfCraft (bridge v2): the book's
// decks and counts, "＋ Card da seleção" from the panel button, PdfCraft's menu item and Ctrl+Shift+N, the Fonte link,
// "Cards desta página", the AI notice and "Definir palavra".
import type { Page } from '@playwright/test';
import {
  expect,
  fakeFrame,
  fakeMenu,
  fakePdfcraft,
  fakeSelect,
  fakeTurn,
  setTheme,
  shot,
  test,
  type LeitorMockHandle,
} from './fixtures';

type MockWindow = { __leitorMock: LeitorMockHandle };

test.beforeEach(async ({ page }) => {
  await fakePdfcraft(page);
});

const panel = (page: Page) => page.getByTestId('book-panel');
const form = (page: Page) => page.getByRole('form', { name: 'Novo card' });

async function farmUid(page: Page): Promise<string> {
  await page.waitForFunction(() => !!(window as unknown as Partial<MockWindow>).__leitorMock);
  return page.evaluate(
    () => (window as unknown as MockWindow).__leitorMock.books.find((b) => b.title === 'Animal Farm')!.bookUid,
  );
}

async function addLogs(page: Page) {
  return page.evaluate(() =>
    (window as unknown as MockWindow).__leitorMock.anki.logs.filter((l) => l.kind === 'addNote'),
  );
}

/** Animal Farm from the Biblioteca, in the fake PdfCraft, turned to its first page. */
async function openAnimalFarm(page: Page) {
  await page.goto('/biblioteca');
  const uid = await farmUid(page);
  await page.getByTestId('book-title').filter({ hasText: 'Animal Farm' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await fakeFrame(page);
  await fakeTurn(page, 0);
  await expect(panel(page)).toHaveAttribute('data-open', 'true');
  return uid;
}

test('book decks, cards of the page, cards from the selection (button, PdfCraft menu, Ctrl+Shift+N)', async ({
  page,
}, info) => {
  const uid = await openAnimalFarm(page);
  const vocab = panel(page).getByTestId('book-deck-vocab');
  // No vocabulary folder yet: the top-level Livros::<Título> deck, with its counts.
  await expect(vocab).toContainText('Livros::Animal Farm');
  await expect(vocab.getByLabel('2 novos, 0 aprendendo, 0 para revisar')).toBeVisible();
  const pageCards = panel(page).getByRole('region', { name: 'Cards desta página (p. 1)' });
  await expect(pageCards).toContainText('Where does the story of Animal Farm begin?');
  await expect(pageCards).not.toContainText('What did the animals build on the knoll?');

  const button = panel(page).getByRole('button', { name: /Card da seleção/ });
  await expect(button).toBeDisabled();
  await expect(panel(page).getByTestId('book-panel-selection')).toHaveText('Selecione um trecho no livro');
  await page.screenshot({ path: shot('painel-light', info.project.name) });

  // 1) The panel button with the last selection → Básico.
  await fakeSelect(page, { page: 0, text: 'Old Major was so highly\nregarded on the farm' });
  await expect(button).toBeEnabled();
  await expect(panel(page).getByTestId('book-panel-selection')).toContainText('Old Major was so highly regarded');
  await button.click();
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByRole('textbox', { name: 'Frente' })).toHaveValue(
    'Old Major was so highly regarded on the farm',
  );
  await expect(form(page).getByTestId('card-form-fonte')).toHaveText('Animal Farm, p. 1');
  await page.screenshot({ path: shot('painel-form', info.project.name) });
  const back = form(page).getByRole('textbox', { name: 'Verso' });
  await expect(back).toBeFocused();
  await back.fill('o Velho Major');
  await back.press('Control+Enter');
  await expect(page.getByText('Card adicionado')).toBeVisible();
  await expect(form(page)).toHaveCount(0);
  let added = (await addLogs(page)).at(-1)!;
  expect(added.fields).toEqual([
    'Old Major was so highly regarded on the farm',
    'o Velho Major',
    `<a href="leitor://livro/${uid}?pagina=1&amp;q=Old%20Major%20was%20so%20highly%20regarded%20on%20the%20farm">Animal Farm, p. 1</a>`,
  ]);
  expect(added.tags).toEqual(['leitor']);
  await expect(pageCards).toContainText('Old Major was so highly regarded on the farm');

  // 2) PdfCraft's own selection menu ("Criar card") → Cloze, preparing the collection first.
  await fakeMenu(page, 'card', { page: 0, text: 'All animals are equal' });
  await expect(form(page)).toBeVisible();
  await form(page).getByRole('radio', { name: 'Cloze' }).click();
  const prepare = form(page).getByRole('button', { name: 'Preparar coleção' });
  if (await prepare.isVisible()) await prepare.click();
  const text = form(page).getByRole('textbox', { name: 'Texto' });
  await expect(text).toHaveValue('All animals are equal');
  await text.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(4, 11);
  });
  await text.press('Control+Shift+C');
  await expect(text).toHaveValue('All {{c1::animals}} are equal');
  await text.press('Control+Enter');
  await expect(form(page)).toHaveCount(0);
  added = (await addLogs(page)).at(-1)!;
  expect(added.fields).toEqual([
    'All {{c1::animals}} are equal',
    '',
    `<a href="leitor://livro/${uid}?pagina=1&amp;q=All%20animals%20are%20equal">Animal Farm, p. 1</a>`,
  ]);
  await expect(pageCards).toContainText('All {{c1::animals}} are equal');

  // 3) Ctrl+Shift+N with the focus in the panel (outside PdfCraft) uses the last selection.
  await button.focus();
  await page.keyboard.press('Control+Shift+N');
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByRole('radio', { name: 'Cloze', checked: true })).toBeVisible();
  // The last kind (Cloze) opens with its text focused; Esc there cancels the form only.
  await expect(form(page).getByRole('textbox', { name: 'Texto' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form(page)).toHaveCount(0);
  await expect(panel(page)).toHaveAttribute('data-open', 'true');
});

test('"Criar cards com IA" points to Configurações → IA; "Definir palavra" shows the lemma', async ({ page }) => {
  await openAnimalFarm(page);
  await fakeMenu(page, 'define', { page: 0, text: 'animals', anchor: [120, 180, 110, 24] });
  const pop = page.getByTestId('define-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('animals');
  await expect(pop).toContainText('Lema: animal');
  await expect(pop).toContainText('Nenhuma nota com esta palavra no deck de vocabulário do livro.');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);

  await fakeMenu(page, 'ai', { page: 0, text: 'All animals are equal' });
  const dialog = page.getByRole('dialog', { name: 'Criar cards com IA' });
  await expect(dialog).toContainText('A IA ainda não está configurada.');
  await dialog.getByRole('button', { name: 'Abrir Configurações → IA' }).click();
  await expect(page).toHaveURL(/\/configuracoes\/ia$/);
  await expect(page.getByText('Provedor de IA: em breve…')).toBeVisible();
});

test('captures: dark theme and a 390 px window', async ({ page }, info) => {
  await setTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  const uid = await openAnimalFarm(page);
  await fakeSelect(page, { page: 0, text: 'Four legs good, two legs bad' });
  await expect(panel(page).getByRole('button', { name: /Card da seleção/ })).toBeEnabled();
  await page.screenshot({ path: shot('painel-dark', info.project.name) });

  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(`/leitor?livro=${uid}&painel=card&trecho=${encodeURIComponent('All animals are equal')}`);
  await fakeFrame(page);
  await expect(form(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute('data-overlay', 'true');
  await expect(form(page).getByRole('textbox', { name: 'Frente' })).toHaveValue('All animals are equal');
  await expect(form(page).getByRole('combobox', { name: 'Deck' })).toBeEnabled();
  await page.screenshot({ path: shot('painel-390', info.project.name) });
  // Esc closes the form first, then the overlay.
  await form(page).getByRole('textbox', { name: 'Verso' }).press('Escape');
  await expect(form(page)).toHaveCount(0);
  await expect(panel(page)).toHaveAttribute('data-open', 'true');
});
