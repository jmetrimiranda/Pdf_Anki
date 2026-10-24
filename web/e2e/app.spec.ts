import { dropPaths, expect, fullShot, mockInit, setNextPick, setTheme, shot, stubPdfcraft, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`/dev/ui renders every component (${theme} app theme)`, async ({ page }, info) => {
    await setTheme(page, theme);
    await page.goto('/dev/ui');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByTestId('gallery-light')).toBeVisible();
    await expect(page.getByTestId('gallery-dark')).toBeVisible();
    for (const gallery of ['gallery-light', 'gallery-dark']) {
      const g = page.getByTestId(gallery);
      await expect(g.getByRole('button', { name: 'Adicionar livro' }).first()).toBeVisible();
      await expect(g.getByRole('tablist')).toBeVisible();
      await expect(g.getByRole('tree')).toBeVisible();
      await expect(g.getByRole('switch')).toBeVisible();
    }
    // The dark column really is dark.
    const bg = await page.getByTestId('gallery-dark').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(20, 20, 20)');
    await fullShot(page, shot(`dev-ui-${theme}`, info.project.name));

    // Floating surfaces open inside their themed column.
    await page.getByTestId('gallery-dark').getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Estudar' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('gallery-light').getByRole('button', { name: 'Diálogo' }).click();
    await expect(page.getByRole('dialog', { name: 'Excluir o deck?' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
}

test('/anki shows the mock deck tree', async ({ page }, info) => {
  await page.goto('/anki');
  const tree = page.getByRole('tree', { name: 'Decks' });
  await expect(tree.getByRole('treeitem', { name: /5000 palavras/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /^.*Oxford 3000/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /ROS 2 — Revisão/ }).first()).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /^Teste/ })).toBeVisible();
  await expect(page.getByTestId('studied-today')).toHaveText('Estudados hoje: 5 cards em 2,83 min (34 s/card)');
  // Rows are announced with their counts, and the deck menu opens from the keyboard.
  const first = tree.getByRole('treeitem', { name: /^5000 palavras, 0 novos, 17 aprendendo, 1002 para revisar$/ });
  await first.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Ações do deck 5000 palavras' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(first).toBeFocused();

  // Collapsed deck expands.
  const ros = tree.getByRole('treeitem', { name: /ROS 2 — Revisão/ }).first();
  await expect(ros).toHaveAttribute('aria-expanded', 'false');
  await ros.getByRole('button', { name: 'Expandir' }).click();
  await expect(tree.getByRole('treeitem', { name: /Comandos/ })).toBeVisible();
  await page.screenshot({ path: shot('anki', info.project.name) });

  // The Anki sub-tabs are routes.
  const tabs = page.getByRole('tablist', { name: 'Seções do Anki' });
  await expect(tabs.getByRole('tab')).toHaveText(['Decks', 'Adicionar', 'Navegar', 'Estatísticas']);
  for (const tab of await tabs.getByRole('tab').all()) await expect(tab).toBeEnabled();
  await tabs.getByRole('tab', { name: 'Navegar' }).click();
  await expect(page).toHaveURL(/\/anki\/navegar$/);
  await page.getByRole('tab', { name: 'Decks' }).click();
  await expect(page).toHaveURL(/\/anki$/);
});

test('app tabs navigate and highlight; shortcuts switch tabs', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/biblioteca$/);
  const nav = page.getByRole('navigation', { name: 'Abas' });
  await expect(nav.getByRole('link')).toHaveText(['Biblioteca', 'Leitor', 'Anki']);
  await expect(nav.getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: 'Anki' }).click();
  await expect(page).toHaveURL(/\/anki$/);
  await expect(nav.getByRole('link', { name: 'Anki' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Biblioteca' })).not.toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: 'Leitor' }).click();
  await expect(page).toHaveURL(/\/leitor$/);
  await expect(nav.getByRole('link', { name: 'Leitor' })).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press('Control+1');
  await expect(page).toHaveURL(/\/biblioteca$/);
  await page.keyboard.press('Control+3');
  await expect(page).toHaveURL(/\/anki$/);
  await page.keyboard.press('Alt+2');
  await expect(page).toHaveURL(/\/leitor$/);
  await page.keyboard.press('Alt+1');
  await expect(page).toHaveURL(/\/biblioteca$/);

  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Atalhos do teclado' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Ir para o Leitor');
  await expect(dialog).toContainText('Mostrar ou esconder o painel Anki do livro');
  await expect(dialog).toContainText('atalhos do próprio PdfCraft');
  await page.keyboard.press('Escape');
});

test('the Library shows the seeded books with covers, progress, search and collections', async ({ page }, info) => {
  await page.goto('/biblioteca');
  const books = page.getByTestId('book');
  await expect(books).toHaveCount(4);
  await expect(page.getByTestId('book-title')).toHaveText([
    'ROS 2 na prática',
    'The Time Machine',
    'Animal Farm',
    'Apostila digitalizada',
  ]);
  await expect(page.getByText('p. 5 de 12')).toBeVisible();
  await expect(page.getByText('Parece escaneado')).toBeVisible();
  // The EPUB carries its format badge.
  await expect(page.getByTestId('format-badge')).toHaveText(['EPUB']);
  // Covers loaded (data: SVGs from the mock core).
  for (const img of await page.getByRole('img', { name: /^Capa de / }).all()) {
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  await page.screenshot({ path: shot('biblioteca', info.project.name) });

  const search = page.getByRole('searchbox', { name: 'Buscar por título ou autor' });
  await search.fill('ORWELL');
  await expect(page.getByTestId('book-title')).toHaveText(['Animal Farm']);
  await search.fill('pratica');
  await expect(page.getByTestId('book-title')).toHaveText(['ROS 2 na prática']);
  await search.fill('');

  const chips = page.getByRole('group', { name: 'Coleções' });
  await chips.getByRole('button', { name: 'Inglês' }).click();
  await expect(page.getByTestId('book-title')).toHaveText(['The Time Machine', 'Animal Farm']);
  await chips.getByRole('button', { name: 'Todas' }).click();
  await expect(books).toHaveCount(4);

  await page.getByRole('radio', { name: 'Lista' }).click();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Lista' })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: shot('biblioteca-lista', info.project.name) });
});

test('adding books: success, corrupted file and duplicates keep the app usable', async ({ page }) => {
  await page.goto('/biblioteca');
  await expect(page.getByTestId('book')).toHaveCount(4);
  await setNextPick(page, ['/home/jorge/Livros/Livro corrompido.pdf']);
  await page.getByRole('button', { name: 'Adicionar livro' }).first().click();
  await expect(page.getByText(/^Não foi possível adicionar Livro corrompido\.pdf: /)).toBeVisible();
  await expect(page.getByTestId('book')).toHaveCount(4);

  await setNextPick(page, ['/home/jorge/Livros/Dom Casmurro.pdf']);
  await page.keyboard.press('Control+o');
  await expect(page.getByText('“Dom Casmurro” foi adicionado à biblioteca.')).toBeVisible();
  await expect(page.getByTestId('book')).toHaveCount(5);

  await setNextPick(page, ['/home/jorge/Livros/Dom Casmurro.pdf']);
  await page.getByRole('button', { name: 'Adicionar livro' }).first().click();
  await expect(page.getByText('Este livro já está na biblioteca')).toBeVisible();
  await expect(page.getByTestId('book')).toHaveCount(5);

  // A reload is an app restart: the library is still there.
  await page.reload();
  await expect(page.getByTestId('book')).toHaveCount(5);
});

test('rename, move to a collection and remove a book', async ({ page }) => {
  await page.goto('/biblioteca');
  await expect(page.getByTestId('book')).toHaveCount(4);

  await page.getByRole('button', { name: 'Ações do livro Apostila digitalizada' }).click();
  await page.getByRole('menuitem', { name: 'Renomear' }).click();
  const rename = page.getByRole('dialog', { name: 'Renomear livro' });
  await rename.getByLabel('Título').fill('Apostila de cálculo');
  await rename.getByRole('button', { name: 'Salvar' }).click();
  await expect(rename).toBeHidden();
  await expect(page.getByTestId('book-title').filter({ hasText: 'Apostila de cálculo' })).toBeVisible();

  await page.getByRole('button', { name: 'Ações do livro Apostila de cálculo' }).click();
  await page.getByRole('menuitem', { name: 'Mover para coleção…' }).click();
  const move = page.getByRole('dialog', { name: 'Mover para coleção' });
  await move.getByLabel('Coleção').fill('Matemática');
  await move.getByRole('button', { name: 'Salvar' }).click();
  await expect(move).toBeHidden();
  const chips = page.getByRole('group', { name: 'Coleções' });
  await chips.getByRole('button', { name: 'Matemática' }).click();
  await expect(page.getByTestId('book-title')).toHaveText(['Apostila de cálculo']);
  await chips.getByRole('button', { name: 'Todas' }).click();

  await page.getByRole('button', { name: 'Ações do livro Animal Farm' }).click();
  await page.getByRole('menuitem', { name: 'Remover da biblioteca' }).click();
  await page
    .getByRole('dialog', { name: 'Remover “Animal Farm” da biblioteca?' })
    .getByRole('button', { name: 'Remover' })
    .click();
  await expect(page.getByText('“Animal Farm” foi removido da biblioteca.')).toBeVisible();
  await expect(page.getByTestId('book')).toHaveCount(3);
  await expect(chips.getByRole('button', { name: 'Inglês' })).toHaveCount(1);
  // Removing the last book of "Inglês" removes the chip too.
  await page.getByRole('button', { name: 'Ações do livro The Time Machine' }).click();
  await page.getByRole('menuitem', { name: 'Remover da biblioteca' }).click();
  await page
    .getByRole('dialog', { name: 'Remover “The Time Machine” da biblioteca?' })
    .getByRole('button', { name: 'Remover' })
    .click();
  await expect(page.getByTestId('book')).toHaveCount(2);
  await expect(chips.getByRole('button', { name: 'Inglês' })).toHaveCount(0);
});

test('clicking a book goes to the Leitor tab', async ({ page }) => {
  await page.goto('/biblioteca');
  await page.getByTestId('book-title').filter({ hasText: 'ROS 2 na prática' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await expect(page.getByRole('navigation', { name: 'Abas' }).getByRole('link', { name: 'Leitor' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Back to the Library: the reader host stays mounted (hidden), so PdfCraft keeps its state.
  await page.keyboard.press('Alt+1');
  await expect(page).toHaveURL(/\/biblioteca$/);
  await expect(page.getByTestId('leitor-host')).toHaveCount(1);
});

test('"Abrir com" and dropped files are imported; the last one opens in the Leitor', async ({ page }) => {
  await mockInit(page, { pendingOpen: ['/home/jorge/Downloads/Aberto pelo sistema.pdf'] });
  await page.goto('/biblioteca');
  await expect(page).toHaveURL(/\/leitor/);
  await page.keyboard.press('Alt+1');
  await expect(page.getByTestId('book-title').filter({ hasText: 'Aberto pelo sistema' })).toBeVisible();

  await dropPaths(page, ['/home/jorge/Downloads/Solto na janela.pdf']);
  await expect(page.getByTestId('book-title').filter({ hasText: 'Solto na janela' })).toBeVisible();
  await expect(page).toHaveURL(/\/biblioteca$/);
});

test('/dev/smoke shows the cover, words and timings', async ({ page }, info) => {
  await page.goto('/dev/smoke');
  await expect(page.getByTestId('page1')).toBeVisible();
  const count = Number(await page.getByTestId('word-count').textContent());
  expect(count).toBeGreaterThan(20);
  await expect(page.getByTestId('timings')).toContainText('Capa');
  await fullShot(page, shot('smoke', info.project.name));
});

test('narrow screens turn tabs into a menu and the library into a list', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/anki');
  await page.getByRole('button', { name: 'Anki' }).click();
  await expect(page.getByRole('menuitem', { name: /Leitor/ })).toBeVisible();
  await page.screenshot({ path: shot('narrow-menu', info.project.name) });
  await page.getByRole('menuitem', { name: /Biblioteca/ }).click();
  await expect(page).toHaveURL(/\/biblioteca$/);
  await expect(page.getByTestId('book')).toHaveCount(4);
  await expect(page.getByRole('radio', { name: 'Lista' })).toHaveCount(0);
  await page.screenshot({ path: shot('narrow-biblioteca', info.project.name) });
});
