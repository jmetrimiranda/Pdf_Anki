import { expect, setNextPackagePick, setTheme, shot, stubPdfcraft, test } from './fixtures';

// Screenshots of the Anki tab shell (decks, menus, dialogs, an Anki page frame), light and dark, for the visual
// review (docs/PROJETO.md §4). The study and notes screens have their own specs.
test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`Anki decks screens (${theme})`, async ({ page }, info) => {
    const file = (s: string) => shot(`anki-${s}-${theme}`, info.project.name);
    // Menus and dialogs animate in: let them settle before the shot.
    const snap = async (s: string) => {
      await page.waitForTimeout(250);
      await page.screenshot({ path: file(s) });
    };
    await setTheme(page, theme);
    await page.goto('/anki');
    const tree = page.getByRole('tree', { name: 'Decks' });
    await expect(tree.getByRole('treeitem', { name: /^5000 palavras,/ })).toBeVisible();
    await page.mouse.move(0, 0);
    await snap('decks');

    const oxford = tree.getByRole('treeitem', { name: /^Oxford,/ }).first();
    await oxford.hover();
    await oxford.getByRole('button', { name: 'Ações do deck Oxford' }).click();
    await expect(page.getByRole('menuitem', { name: 'Criar subdeck' })).toBeVisible();
    await snap('deck-menu');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Mais ações' }).click();
    await expect(page.getByRole('menuitem', { name: 'Preparar coleção' })).toBeVisible();
    await snap('more-menu');
    await page.keyboard.press('Escape');

    const words = tree.getByRole('treeitem', { name: /^5000 palavras,/ });
    await words.hover();
    await words.getByRole('button', { name: 'Ações do deck 5000 palavras' }).click();
    await page.getByRole('menuitem', { name: 'Exportar .apkg…' }).click();
    await expect(page.getByRole('dialog', { name: 'Exportar “5000 palavras”' })).toBeVisible();
    await snap('export');
    await page.keyboard.press('Escape');

    await setNextPackagePick(page, '/home/jorge/Anki/colecao.colpkg');
    await page.getByRole('button', { name: 'Importar' }).click();
    await expect(page.getByRole('menuitem', { name: 'Coleção inteira (.colpkg)…' })).toBeVisible();
    await snap('import-menu');
    await page.getByRole('menuitem', { name: 'Coleção inteira (.colpkg)…' }).click();
    const first = page.getByRole('dialog', { name: 'Substituir a coleção inteira?' });
    await expect(first).toBeVisible();
    await snap('colpkg-1');
    await first.getByRole('button', { name: 'Continuar' }).click();
    const sure = page.getByRole('dialog', { name: 'Tem certeza?' });
    await sure.getByRole('checkbox').check();
    await snap('colpkg-2');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Backups…' }).click();
    await expect(page.getByRole('dialog', { name: 'Backups da coleção' }).getByRole('listitem')).toHaveCount(2);
    await snap('backups');
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: 'Estatísticas' }).click();
    await expect(page.frameLocator('iframe[title="Estatísticas"]').getByTestId('mock-anki-route')).toHaveText('graphs');
    await snap('page-frame');

    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('/anki');
    await expect(page.getByRole('tree', { name: 'Decks' })).toBeVisible();
    await snap('decks-narrow');
  });
}
