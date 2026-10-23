// Markdown batch import of code cards (spec 11.7) against the mock core: the exact example of the spec, an invalid
// item left out, the toast and Navegar. Screenshots: test-results/screens/codigo-importar*.png.
import type { Page } from '@playwright/test';
import { SPEC_EXAMPLE } from '../src/features/code-import/example';
import { expect, fullShot, setTheme, shot, stubPdfcraft, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

const INVALID = '### Pergunta sem resposta\nSó texto, nenhum bloco de código.\n';

async function openImport(page: Page) {
  await page.goto('/anki');
  await page.getByRole('button', { name: 'Importar' }).first().click();
  await page.getByRole('menuitem', { name: 'Cards de código (Markdown)…' }).click();
  await expect(page).toHaveURL(/\/anki\/importar-codigo/);
  await expect(page.getByRole('heading', { name: 'Importar cards de código (Markdown)' })).toBeVisible();
}

async function chooseDeck(page: Page, name: string) {
  const select = page.getByRole('combobox', { name: 'Deck' });
  const value = await select.locator('option', { hasText: new RegExp(`^${name}$`) }).getAttribute('value');
  await select.selectOption(value!);
}

test('imports the exact example of the spec and leaves an invalid item out', async ({ page }) => {
  await openImport(page);
  const prepare = page.getByRole('button', { name: 'Preparar coleção' });
  if (await prepare.isVisible()) await prepare.click();
  await page.getByRole('textbox', { name: 'Texto em Markdown' }).fill(`${SPEC_EXAMPLE}\n${INVALID}`);
  const items = page.getByTestId('code-import-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Ver a transformação entre os frames world e turtle1');
  await expect(items.nth(0)).toContainText('Comando');
  await expect(items.nth(1)).toContainText('Programa · Python · testes');
  await expect(items.nth(0).getByTestId('code-import-error')).toHaveCount(0);
  await expect(items.nth(1).getByTestId('code-import-error')).toHaveCount(0);
  await expect(items.nth(2).getByTestId('code-import-error').first()).toBeVisible();
  await expect(items.nth(2).getByRole('checkbox')).toBeDisabled();

  await chooseDeck(page, 'ROS 2 — Revisão');
  await page.getByRole('button', { name: 'Adicionar 2 cards' }).click();
  await expect(page.getByText('2 cards adicionados ao deck ROS 2 — Revisão').first()).toBeVisible();

  await page.getByRole('link', { name: 'Ver no Navegar' }).click();
  await expect(page).toHaveURL(/\/anki\/navegar\?busca=/);
  const table = page.getByRole('grid');
  await expect(table).toContainText('Ver a transformação entre os frames world e turtle1');
  await expect(table).toContainText('Função que soma os pares de uma lista');
});

for (const theme of ['light', 'dark'] as const) {
  test(`screenshots of the Markdown import (${theme})`, async ({ page }, info) => {
    await setTheme(page, theme);
    await openImport(page);
    await page.getByRole('textbox', { name: 'Texto em Markdown' }).fill(`${SPEC_EXAMPLE}\n${INVALID}`);
    await expect(page.getByTestId('code-import-item')).toHaveCount(3);
    await fullShot(page, shot(`codigo-importar-${theme}`, info.project.name));
  });
}

test('the Markdown import at 390 px', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openImport(page);
  await page.getByRole('textbox', { name: 'Texto em Markdown' }).fill(SPEC_EXAMPLE);
  await expect(page.getByTestId('code-import-item')).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await fullShot(page, shot('codigo-importar-390', info.project.name));
});
