import { expect, firePageEvent, setNextPackagePick, stubPdfcraft, test } from './fixtures';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

const frameOf = (page: Page, title: string) => page.frameLocator(`iframe[title="${title}"]`);

test('Opções opens deck-options/<id> in the Anki page frame; Fechar asks the page', async ({ page }) => {
  await page.goto('/anki');
  const row = page.getByRole('tree', { name: 'Decks' }).getByRole('treeitem', { name: /^Oxford,/ });
  await row.hover();
  await row.getByRole('button', { name: 'Ações do deck Oxford' }).click();
  await page.getByRole('menuitem', { name: 'Opções' }).click();
  await expect(page).toHaveURL(/\/anki\/opcoes\/\d+$/);
  const id = /\/anki\/opcoes\/(\d+)$/.exec(page.url())![1];
  const iframe = page.locator('iframe[title="Opções do deck"]');
  await expect(iframe).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads',
  );
  const frame = frameOf(page, 'Opções do deck');
  await expect(frame.getByTestId('mock-anki-route')).toHaveText(`deck-options/${id}`);
  // The page bridge styled the page like desktop.
  await expect(frame.locator('body')).toHaveClass(/^(isLin|isWin|isMac) fancy$/);
  await expect(page.getByRole('status', { name: 'Abrindo a página do Anki…' })).toHaveCount(0);
  // Ready (the core's event): "Fechar" goes through the page's pending-changes hook, which closes.
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Fechar' }).click();
  await expect(page).toHaveURL(/\/anki$/);
  await expect(page.getByRole('tree', { name: 'Decks' })).toBeVisible();
});

test('Estatísticas opens graphs; a search from the page opens Navegar', async ({ page }) => {
  await page.goto('/anki');
  await page.getByRole('tab', { name: 'Estatísticas' }).click();
  await expect(page).toHaveURL(/\/anki\/estatisticas$/);
  const frame = frameOf(page, 'Estatísticas');
  await expect(frame.getByTestId('mock-anki-route')).toHaveText('graphs');
  await frame.getByRole('button', { name: 'Buscar no Navegar' }).click();
  await expect(page).toHaveURL(/\/anki\/navegar\?busca=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('busca') ?? '')).toBe('deck:current is:review');
});

test('Fechar closes the statistics page', async ({ page }) => {
  await page.goto('/anki/estatisticas');
  await expect(frameOf(page, 'Estatísticas').getByTestId('mock-anki-route')).toHaveText('graphs');
  await page.getByRole('button', { name: 'Fechar' }).click();
  await expect(page).toHaveURL(/\/anki$/);
});

test('a Close event from the core closes the page; Escape inside the page closes too', async ({ page }) => {
  await page.goto('/anki');
  await page.goto('/anki/pagina/congrats');
  await expect(frameOf(page, 'Parabéns!').getByTestId('mock-anki-route')).toHaveText('congrats');
  await firePageEvent(page, { kind: 'close' });
  await expect(page).toHaveURL(/\/anki$/);

  await page.goto('/anki/estatisticas');
  const frame = frameOf(page, 'Estatísticas');
  await expect(frame.getByTestId('mock-anki-route')).toHaveText('graphs');
  await frame.locator('body').click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/anki$/);
});

test('import .apkg via the menu opens import-anki-package/<encoded path>', async ({ page }) => {
  await page.goto('/anki');
  await setNextPackagePick(page, '/home/jorge/Downloads/Vocabulário do livro.apkg');
  await page.getByRole('button', { name: 'Importar' }).click();
  await page.getByRole('menuitem', { name: 'Pacote do Anki (.apkg)…' }).click();
  const iframe = page.locator('iframe[title="Importar pacote do Anki"]');
  await expect(iframe).toHaveAttribute(
    'src',
    /\/__mock-anki-page\/import-anki-package\/%2Fhome%2Fjorge%2FDownloads%2FVocabul%C3%A1rio%20do%20livro\.apkg$/,
  );
  await expect(frameOf(page, 'Importar pacote do Anki').getByTestId('mock-anki-route')).toHaveText(
    'import-anki-package//home/jorge/Downloads/Vocabulário do livro.apkg',
  );
  // The import finished: the deck list refreshes when the page is closed.
  await frameOf(page, 'Importar pacote do Anki').getByRole('button', { name: 'Importação concluída' }).click();
  await page.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('tree', { name: 'Decks' })).toBeVisible();
});
