// Vocabulary scan wizard (spec 12.1) against the mock core: folder (mandatory, subdecks), range (outline and pages),
// fields, criterion and the scan with its progress, ending in the report.
import type { Page } from '@playwright/test';
import { bookUid, expect, fullShot, setTheme, shot, stubPdfcraft, test, vocabMock } from './fixtures';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

/** The wizard's footer button ("Continuar", or "Escanear" on the last step). */
function next(page: Page) {
  return page.getByTestId('vocab-wizard-footer').getByRole('button', { name: /^(Continuar|Escanear)$/ });
}

async function openWizard(page: Page): Promise<string> {
  await page.goto('/biblioteca');
  const uid = await bookUid(page, 'Animal Farm');
  await page.getByRole('button', { name: 'Ações do livro Animal Farm' }).click();
  await page.getByRole('menuitem', { name: 'Escanear vocabulário' }).click();
  await expect(page).toHaveURL(/\/vocabulario\/escanear\?/);
  await expect(page.getByTestId('vocab-step-pasta')).toBeVisible();
  return uid;
}

test('folder → outline range → fields → criterion → scan → report', async ({ page }, info) => {
  await openWizard(page);
  // The Biblioteca tab stays selected.
  await expect(page.getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page');
  // Default folder "Vocabulário", with every subdeck and its card count.
  const subdecks = page.getByTestId('vocab-subdeck');
  await expect(subdecks).toHaveCount(5);
  await expect(subdecks.nth(1)).toContainText('Inglês básico');
  await expect(subdecks.nth(1)).toContainText('27 cards');
  await page.getByRole('checkbox', { name: 'Vocabulário::Livros', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Vocabulário::Livros::Teste' })).not.toBeChecked();
  await expect(page.getByText('3 de 5 decks')).toBeVisible();
  await fullShot(page, shot('vocab-wizard-pasta', info.project.name));
  await next(page).click();

  await expect(page.getByTestId('vocab-step-trecho')).toBeVisible();
  await page.getByRole('radio', { name: 'Por bookmarks/sumário' }).click();
  const tree = page.getByRole('tree', { name: 'Sumário e bookmarks do livro' });
  await tree.getByRole('checkbox', { name: 'Cap 2' }).check();
  await expect(tree.getByRole('checkbox', { name: 'A morte do Major' })).toBeChecked();
  await expect(tree.getByRole('checkbox', { name: 'A morte do Major' })).toBeDisabled();
  await tree.getByRole('checkbox', { name: 'Cap 2' }).uncheck();
  await tree.getByRole('checkbox', { name: 'Cap 3' }).check();
  await expect(page.getByTestId('vocab-range-resolved')).toHaveText('Cap 3 (p. 13–18) · 6 páginas');
  await fullShot(page, shot('vocab-wizard-trecho', info.project.name));
  await next(page).click();

  await expect(page.getByTestId('vocab-step-campos')).toBeVisible();
  const oxford = page.getByTestId('vocab-notetype').filter({ hasText: 'Oxford (Front/Back)' });
  await expect(oxford.getByTestId('vocab-field-select')).toHaveValue('Front');
  await expect(oxford.getByTestId('vocab-field-samples')).toContainText('abandon');
  await oxford.getByTestId('vocab-field-select').selectOption('Back');
  await expect(oxford.getByTestId('vocab-field-samples')).toContainText('abandonar');
  await oxford.getByTestId('vocab-field-select').selectOption('Front');
  await expect(oxford.getByTestId('vocab-field-samples')).toContainText('abandon');
  await next(page).click();

  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
  await expect(page.getByTestId('vocab-ivl-days')).toHaveValue('21');
  await expect(page.getByRole('switch', { name: 'Palavras funcionais contam como conhecidas' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await fullShot(page, shot('vocab-wizard-criterio', info.project.name));
  await vocabMock.setJobDelay(page, 150);
  await next(page).click();

  await expect(page.getByTestId('vocab-scan-progress')).toBeVisible();
  await expect(page.getByText('Lendo o texto…')).toBeVisible();
  await page.screenshot({ path: shot('vocab-wizard-escanear', info.project.name) });
  await expect(page).toHaveURL(/\/vocabulario\?livro=/, { timeout: 15_000 });
  await expect(page.getByTestId('vocab-range')).toHaveText('Trecho: Cap 3 (p. 13–18)');
});

test('the pages field shows the core’s errors and the resolved pages', async ({ page }) => {
  await openWizard(page);
  await next(page).click();
  await page.getByRole('radio', { name: 'Páginas' }).click();
  const input = page.getByTestId('vocab-range-pages');
  for (const [text, error] of [
    ['0', 'As páginas começam em 1.'],
    ['45-21', 'O intervalo 45-21 está invertido. Use 21-45.'],
    ['400', 'A página 400 não existe (o livro tem 60 páginas).'],
    ['abc', '“abc” não é uma página válida. Use números, como 37, 21-45 ou 21-45, 60, 72-80.'],
  ] as const) {
    await input.fill(text);
    await expect(page.getByText(error)).toBeVisible();
    await expect(next(page)).toBeDisabled();
  }
  await input.fill('21-45, 50, 52-60');
  await expect(page.getByTestId('vocab-range-resolved')).toHaveText('p. 21–45, 50, 52–60 · 35 páginas');
  await expect(next(page)).toBeEnabled();
});

test('a deep link past "Pasta" waits for a saved folder; cancelling a scan', async ({ page }) => {
  await page.goto('/biblioteca');
  const uid = await bookUid(page, 'Animal Farm');
  await page.goto(`/vocabulario/escanear?livro=${uid}&passo=criterio`);
  await expect(page.getByTestId('vocab-step-pasta')).toBeVisible();
  await vocabMock.setMapping(page, 'Vocab (Word)', 'Word');
  await vocabMock.setMapping(page, 'Oxford (Front/Back)', 'Front');
  await page.goto(`/vocabulario/escanear?livro=${uid}`);
  await expect(page.getByTestId('vocab-step-pasta')).toBeVisible();
  await vocabMock.setJobDelay(page, 400);
  // Pasta → Trecho → Critério (the fields are mapped) → Escanear.
  await next(page).click();
  await expect(page.getByTestId('vocab-step-trecho')).toBeVisible();
  await next(page).click();
  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
  await next(page).click();
  await expect(page.getByTestId('vocab-scan-progress')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByText('Escaneamento cancelado.')).toBeVisible();
  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
  // The folder is saved only when a scan starts: now the deep link goes straight to the step.
  await page.goto(`/vocabulario/escanear?livro=${uid}&passo=criterio`);
  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`wizard at 390 px (${theme})`, async ({ page }, info) => {
    await setTheme(page, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/biblioteca');
    const uid = await bookUid(page, 'Animal Farm');
    await page.goto(`/vocabulario/escanear?livro=${uid}`);
    await expect(page.getByTestId('vocab-step-pasta')).toBeVisible();
    await expect(page.getByTestId('vocab-subdeck')).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await fullShot(page, shot(`vocab-wizard-390-${theme}`, info.project.name));
    await next(page).click();
    await page.getByRole('radio', { name: 'Por bookmarks/sumário' }).click();
    await expect(page.getByRole('tree', { name: 'Sumário e bookmarks do livro' })).toBeVisible();
    await fullShot(page, shot(`vocab-wizard-trecho-390-${theme}`, info.project.name));
  });
}
