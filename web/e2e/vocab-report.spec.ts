// Vocabulary report and deck generation (spec 12.4–12.6) against the mock core: "Já sei" updates the statuses, the
// deck of a range is a subdeck named after it with the `trecho::` tag (checked on the Anki tab), a second range never
// offers the words created before, and screenshots in light, dark and 390 px.
import type { Page } from '@playwright/test';
import { bookUid, expect, fullShot, setTheme, shot, stubPdfcraft, test, vocabMock } from './fixtures';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

function next(page: Page) {
  return page.getByTestId('vocab-wizard-footer').getByRole('button', { name: /^(Continuar|Escanear)$/ });
}

/** Runs the wizard on Animal Farm with the folder "Vocabulário" and the given range; ends on the report. */
async function scan(page: Page, range: { outline: string } | { pages: string }): Promise<string> {
  await page.goto('/biblioteca');
  const uid = await bookUid(page, 'Animal Farm');
  await vocabMock.setMapping(page, 'Vocab (Word)', 'Word');
  await vocabMock.setMapping(page, 'Oxford (Front/Back)', 'Front');
  await page.goto(`/vocabulario/escanear?livro=${uid}`);
  await expect(page.getByTestId('vocab-step-pasta')).toBeVisible();
  await expect(page.getByTestId('vocab-subdeck')).toHaveCount(5);
  await next(page).click();
  if ('outline' in range) {
    await page.getByRole('radio', { name: 'Por bookmarks/sumário' }).click();
    await page
      .getByRole('tree', { name: 'Sumário e bookmarks do livro' })
      .getByRole('checkbox', { name: range.outline, exact: true })
      .check();
  } else {
    await page.getByRole('radio', { name: 'Páginas' }).click();
    await page.getByTestId('vocab-range-pages').fill(range.pages);
  }
  await expect(page.getByTestId('vocab-range-resolved')).toContainText('páginas');
  await next(page).click();
  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
  await next(page).click();
  await expect(page.getByTestId('vocab-range')).toBeVisible({ timeout: 15_000 });
  return uid;
}

const rows = (page: Page) => page.getByTestId('vocab-row');
const row = (page: Page, lemma: string) => page.locator(`[data-testid="vocab-row"][data-lemma="${lemma}"]`);

test('report → "Já sei" → generate the Cap 3 deck, found on the Anki tab with its tag', async ({ page }, info) => {
  await scan(page, { outline: 'Cap 3' });
  await expect(page.getByTestId('vocab-range')).toHaveText('Trecho: Cap 3 (p. 13–18)');
  await expect(page.getByTestId('vocab-offline')).toHaveText(
    'Detecção offline, sem IA. A IA só preenche Definição e Tradução, se estiver ligada.',
  );
  await expect(page.getByTestId('vocab-goal-98')).toContainText('você chega a 98%');
  await expect(page.getByRole('img', { name: /^Curva de cobertura/ })).toBeVisible();
  await expect(row(page, 'harrow')).toBeVisible();
  await page.screenshot({ path: shot('vocab-report', info.project.name) });

  // "Já sei" on one word: the scan runs again (reusing the table) and the word leaves the unknown list.
  const toolbar = page.getByRole('toolbar', { name: 'Ações com as palavras selecionadas' });
  // Some words are checked: the header box clears them.
  await page.getByRole('checkbox', { name: 'Selecionar todas as palavras mostradas' }).click();
  await expect(toolbar.getByRole('button', { name: 'Gerar deck (0)' })).toBeVisible();
  await row(page, 'harrow').getByRole('checkbox').check();
  await expect(toolbar.getByRole('button', { name: 'Gerar deck (1)' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Já sei' }).click();
  await expect(page.getByText('Status atualizados.')).toBeVisible();
  await expect(row(page, 'harrow')).toHaveCount(0);
  expect(await vocabMock.textReads(page)).toBe(1);
  const search = page.getByRole('searchbox', { name: 'Buscar palavra' });
  await search.fill('harrow');
  await expect(row(page, 'harrow')).toContainText('conhecida');
  await search.fill('');

  // Generate the deck with the 98% selection.
  const goal = toolbar.getByRole('button', { name: /^Selecionar as \d+ para 98%$/ });
  const n = Number(/\d+/.exec((await goal.textContent()) ?? '')![0]);
  await goal.click();
  await toolbar.getByRole('button', { name: `Gerar deck (${n})` }).click();
  const dialog = page.getByRole('dialog', { name: 'Gerar deck' });
  await expect(dialog.getByTestId('vocab-deck-name')).toHaveText('Vocabulário::Livros::Animal Farm::Cap 3');
  await expect(dialog.getByTestId('vocab-deck-tags')).toContainText('trecho::cap-3');
  await expect(dialog.getByRole('radio', { name: /IA/ })).toBeDisabled();
  await expect(dialog.getByText('— chega numa próxima versão')).toBeVisible();
  await dialog.screenshot({ path: shot('vocab-generate', info.project.name) });
  await dialog.getByTestId('vocab-deck-create').click();
  await expect(page.getByText(`${n} cards criados em Vocabulário::Livros::Animal Farm::Cap 3.`)).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Gerar deck (0)' })).toBeVisible();

  // The Anki tab: the subdeck exists and its notes carry the range tag.
  await page.getByRole('link', { name: 'Anki' }).click();
  const tree = page.getByRole('tree', { name: 'Decks' });
  await expect(tree.getByRole('treeitem', { name: /^Cap 3, / })).toBeVisible();
  await page.goto('/anki/navegar?busca=tag%3Atrecho%3A%3Acap-3');
  await expect(page.getByTestId('browse-count')).toHaveText(`${n} cards`);
});

test('a pages range: header, subdeck "p. 21-45", and no word of an earlier scan offered again', async ({
  page,
}, info) => {
  await scan(page, { pages: '21-45' });
  await expect(page.getByTestId('vocab-range')).toHaveText('Trecho: p. 21–45');
  const toolbar = page.getByRole('toolbar', { name: 'Ações com as palavras selecionadas' });
  await toolbar.getByRole('button', { name: /^Gerar deck \(\d+\)$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Gerar deck' });
  await expect(dialog.getByTestId('vocab-deck-name')).toHaveText('Vocabulário::Livros::Animal Farm::p. 21-45');
  await expect(dialog.getByTestId('vocab-deck-tags')).toContainText('trecho::p-21-45');
  await dialog.getByTestId('vocab-deck-create').click();
  await expect(page.getByText(/cards criados em Vocabulário::Livros::Animal Farm::p\. 21-45\./)).toBeVisible();

  // Another range of the same book: the created words show "já no deck do livro" and can't be checked.
  await page.getByRole('button', { name: 'Escanear outro trecho' }).click();
  await expect(page.getByTestId('vocab-step-trecho')).toBeVisible();
  await page.getByRole('radio', { name: 'Páginas' }).click();
  await page.getByTestId('vocab-range-pages').fill('25-50');
  await expect(page.getByTestId('vocab-range-resolved')).toHaveText('p. 25–50 · 26 páginas');
  await next(page).click();
  await expect(page.getByTestId('vocab-step-criterio')).toBeVisible();
  await next(page).click();
  await expect(page.getByTestId('vocab-range')).toHaveText('Trecho: p. 25–50', { timeout: 15_000 });
  await page.getByRole('searchbox', { name: 'Buscar palavra' }).fill('windmill');
  const windmill = row(page, 'windmill');
  await expect(windmill).toContainText('já no deck do livro');
  await expect(windmill.getByRole('checkbox')).toBeDisabled();
  // None of the rows created before is selectable.
  await page.getByRole('searchbox', { name: 'Buscar palavra' }).fill('');
  await page.getByRole('combobox', { name: 'Status' }).selectOption('all');
  const disabled = await rows(page).evaluateAll((els) =>
    els
      .filter((el) => el.textContent?.includes('já no deck do livro'))
      .map((el) => el.querySelector('input')!.disabled),
  );
  expect(disabled.length).toBeGreaterThan(0);
  expect(disabled.every(Boolean)).toBe(true);
  await page.screenshot({ path: shot('vocab-report-second-range', info.project.name) });
});

for (const theme of ['light', 'dark'] as const) {
  test(`report screenshots (${theme}, desktop and 390 px)`, async ({ page }, info) => {
    await setTheme(page, theme);
    await scan(page, { outline: 'Cap 5' });
    await page.getByRole('combobox', { name: 'Status' }).selectOption('all');
    await expect(row(page, 'windmill')).toBeVisible();
    await page.screenshot({ path: shot(`vocab-report-${theme}`, info.project.name) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row(page, 'windmill')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: shot(`vocab-report-390-${theme}`, info.project.name) });
    await fullShot(page, shot(`vocab-report-390-full-${theme}`, info.project.name));
    await page.getByTestId('vocab-generate').click();
    await expect(page.getByRole('dialog', { name: 'Gerar deck' })).toBeVisible();
    await page.screenshot({ path: shot(`vocab-generate-390-${theme}`, info.project.name) });
  });
}
