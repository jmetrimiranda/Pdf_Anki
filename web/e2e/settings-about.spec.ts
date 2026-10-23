// Configurações → Sobre: version and credits of the bundled data and programs (spec 12.2).
import { expect, setTheme, shot, stubPdfcraft, test, vocabMock } from './fixtures';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`credits and licences (${theme})`, async ({ page }, info) => {
    await setTheme(page, theme);
    await page.goto('/configuracoes');
    await page.getByRole('link', { name: 'Sobre' }).click();
    await expect(page).toHaveURL(/\/configuracoes\/sobre$/);
    await expect(page.getByRole('heading', { name: 'Sobre', level: 2 })).toBeVisible();
    await expect(page.getByTestId('about-version')).toHaveText(/^Versão \d+\.\d+\.\d+/);
    const credits = page.getByTestId('about-credit');
    await expect(credits.filter({ hasText: 'Open English WordNet' })).toBeVisible();
    await expect(credits.filter({ hasText: 'Modelos de OCR (ocrs)' })).toContainText('CC BY-SA 4.0');
    await expect(credits.filter({ hasText: /^Anki/ })).toContainText('AGPL-3.0');
    await expect(credits.filter({ hasText: 'PdfCraft' })).toContainText('MIT / Apache-2.0');
    await expect(credits.filter({ hasText: 'Pyodide' })).toContainText('MPL-2.0');
    await expect(credits.filter({ hasText: 'CodeMirror' })).toContainText('MIT');
    await page.screenshot({ path: shot(`vocab-about-${theme}`, info.project.name), fullPage: true });
  });
}

test('says when the vocabulary data is not installed', async ({ page }) => {
  await page.goto('/configuracoes/codigo');
  await vocabMock.setDataAvailable(page, false);
  await page.goto('/configuracoes/sobre');
  await expect(page.getByText('Dados de vocabulário não instalados').first()).toBeVisible();
});
