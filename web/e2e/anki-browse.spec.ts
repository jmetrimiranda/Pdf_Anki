import type { Page } from '@playwright/test';
import { ankiLogs, expect, setTheme, shot, stubPdfcraft, test } from './fixtures';

// "Navegar" (spec 8.2) against the mock core: Anki search, sorting, multi-selection, bulk operations and the side
// note editor. Screenshots: test-results/screens/anki-browse-*.png and anki-edit-dialog-*.png.

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

const grid = (page: Page) => page.getByRole('grid', { name: 'Cards' });
const bodyRows = (page: Page) => grid(page).locator('[role="row"][aria-rowindex]:not([aria-rowindex="1"])');
const row = (page: Page, text: string) => bodyRows(page).filter({ hasText: text });
/** Typing a space in a contenteditable may store a non-breaking space. */
const plain = (fields: unknown) => (fields as string[] | undefined)?.map((f) => f.replace(/&nbsp;|\u00a0/g, ' '));

async function search(page: Page, q: string) {
  const box = page.getByRole('textbox', { name: 'Buscar cards (sintaxe do Anki)' });
  await box.fill(q);
  await box.press('Enter');
}

test('search, sort, select, move, suspend and delete', async ({ page }) => {
  await page.goto('/anki/navegar');
  await expect(page.getByTestId('browse-count')).toHaveText('7 cards');
  await expect(row(page, 'kitchen')).toBeVisible();

  await search(page, 'deck:Oxford*');
  await expect(page.getByTestId('browse-count')).toHaveText('3 cards');
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(bodyRows(page).first()).toContainText('abandon');

  // Sort: the active column toggles direction.
  const header = page.getByRole('columnheader', { name: /Campo de ordenação/ });
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await header.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(bodyRows(page).first()).toContainText('able');
  await page.getByRole('columnheader', { name: /Deck/ }).click();
  await expect(page.getByRole('columnheader', { name: /Deck/ })).toHaveAttribute('aria-sort', 'ascending');
  await header.click();
  await expect(bodyRows(page).first()).toContainText('abandon');

  // Multi-selection: click, Shift-click, Ctrl-click.
  await row(page, 'abandon').click();
  await row(page, 'able').click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 selecionados')).toBeVisible();
  await row(page, 'ability').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByText('2 selecionados')).toBeVisible();
  await expect(row(page, 'ability')).toHaveAttribute('aria-selected', 'false');

  // Move to another deck.
  await page.getByRole('button', { name: 'Mover' }).click();
  const move = page.getByRole('dialog', { name: 'Mover para outro deck' });
  await move.getByLabel('Deck de destino').selectOption({ label: 'Oxford::Oxford 5000' });
  await move.getByRole('button', { name: 'Mover' }).click();
  await expect(page.getByText('2 cards movidos.')).toBeVisible();
  await expect(row(page, 'abandon')).toContainText('Oxford::Oxford 5000');
  await expect(row(page, 'ability')).toContainText('Oxford::Oxford 3000');
  expect((await ankiLogs(page)).filter((l) => l.kind === 'setDeck')).toHaveLength(1);

  // Suspend one card (keyboard: arrows move the selection).
  await row(page, 'abandon').click();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByText('1 selecionado')).toBeVisible();
  await expect(row(page, 'ability')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Suspender' }).click();
  await expect(row(page, 'ability')).toHaveAttribute('data-suspended', 'true');
  await expect(page.getByRole('button', { name: 'Reativar' })).toBeVisible();

  // Delete with confirmation.
  await row(page, 'able').click();
  await page.getByRole('button', { name: 'Excluir' }).click();
  const confirm = page.getByRole('dialog', { name: 'Excluir 1 nota?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Excluir' }).click();
  await expect(page.getByText('1 nota excluída.')).toBeVisible();
  await expect(page.getByTestId('browse-count')).toHaveText('2 cards');
  await expect(row(page, 'able')).toHaveCount(0);

  // Invalid syntax shows Anki's message.
  await search(page, 'deck:"sem fim');
  await expect(page.getByRole('alert')).toContainText('Pesquisa inválida');
});

test('the side editor saves the focused note on blur', async ({ page }) => {
  await page.goto('/anki/navegar?busca=kitchen');
  await row(page, 'kitchen').click();
  const side = page.getByTestId('browse-side');
  const back = side.getByRole('textbox', { name: 'Verso' });
  await expect(back).toHaveText('cozinha');
  await back.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (cômodo)');
  await expect(side.getByText('Alterações não salvas')).toBeVisible();
  // Leaving the editor saves.
  await page.getByRole('textbox', { name: 'Buscar cards (sintaxe do Anki)' }).click();
  await expect(side.getByText('Salvo')).toBeVisible();
  const update = (await ankiLogs(page)).filter((l) => l.kind === 'updateNote').at(-1);
  expect(plain(update?.fields)).toEqual(['kitchen', 'cozinha (cômodo)']);

  // Ctrl+Enter saves too.
  await back.click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(side.getByText('Salvo')).toBeVisible();
  const last = (await ankiLogs(page)).filter((l) => l.kind === 'updateNote').at(-1);
  expect(plain(last?.fields)).toEqual(['kitchen', 'cozinha (cômodo)!']);
});

for (const theme of ['light', 'dark'] as const) {
  test(`browse screenshots (${theme})`, async ({ page }, info) => {
    await setTheme(page, theme);
    await page.goto('/anki/navegar?busca=deck%3A%225000%20palavras%22');
    await expect(row(page, 'kitchen')).toBeVisible();
    await row(page, 'house').click();
    await row(page, 'window').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('browse-side').getByRole('textbox', { name: 'Frente' })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(`anki-browse-${theme}`, info.project.name) });

    await page.getByRole('button', { name: 'Sintaxe de busca' }).click();
    await expect(page.getByText('cards para revisar hoje')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(`anki-browse-help-${theme}`, info.project.name) });
    await page.keyboard.press('Escape');

    // Narrow window: no side panel, the note opens in a dialog (Enter on the focused row).
    await page.setViewportSize({ width: 820, height: 760 });
    await row(page, 'house').click();
    await grid(page).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Editar nota' });
    await expect(dialog.getByRole('textbox', { name: 'Frente' })).toContainText('house');
    await expect(dialog.locator('img')).toHaveCount(1);
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(`anki-edit-dialog-${theme}`, info.project.name) });
    await dialog.getByRole('textbox', { name: 'Verso' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' grande');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).toBeHidden();
    const update = (await ankiLogs(page)).filter((l) => l.kind === 'updateNote').at(-1);
    expect(plain(update?.fields)).toEqual([
      '<img src="fixture-image.png"><br>house',
      'casa [sound:fixture-audio.wav] grande',
    ]);
  });
}
