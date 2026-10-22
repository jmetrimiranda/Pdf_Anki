import { expect, fullShot, setTheme, shot, test } from './fixtures';

for (const theme of ['light', 'dark'] as const) {
  test(`/dev/ui renders every component (${theme} app theme)`, async ({ page }, info) => {
    await setTheme(page, theme);
    await page.goto('/dev/ui');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByTestId('gallery-light')).toBeVisible();
    await expect(page.getByTestId('gallery-dark')).toBeVisible();
    for (const gallery of ['gallery-light', 'gallery-dark']) {
      const g = page.getByTestId(gallery);
      await expect(g.getByRole('button', { name: 'Abrir arquivo' }).first()).toBeVisible();
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
});

test('/biblioteca shows the empty state and opens a document tab', async ({ page }, info) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/biblioteca$/);
  await expect(page.getByText('Nenhum livro na biblioteca ainda.')).toBeVisible();
  await page.screenshot({ path: shot('biblioteca', info.project.name) });

  await page.getByRole('button', { name: 'Abrir arquivo' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Abrir arquivo' });
  await dialog.getByRole('button', { name: 'Abrir' }).click();
  await expect(page).toHaveURL(/\/doc\/mock-/);
  await expect(page.getByRole('link', { name: 'ROS 2 na prática' })).toBeVisible();
  await expect(page.getByTestId('page-indicator')).toHaveText(/^1 \/ \d+$/);
  await expect(page.locator('[data-page="0"] .word-layer span').first()).toBeAttached();
  await expect(page.locator('[data-page="0"] img')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: shot('doc', info.project.name) });

  const docUrl = new URL(page.url()).pathname;
  await page.getByRole('button', { name: /^Fechar ROS 2/ }).click();
  await expect(page).toHaveURL(/\/biblioteca$/);
  // Closing the tab released the document in the core (in-app navigation keeps the mock's state).
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, docUrl);
  await expect(page.getByText('Este documento não está aberto.')).toBeVisible();
});

test('reader keys: arrows turn pages only outside widgets, zoom keeps the page', async ({ page }) => {
  await page.goto('/biblioteca');
  await page.getByRole('button', { name: 'Abrir arquivo' }).first().click();
  await page.getByRole('dialog', { name: 'Abrir arquivo' }).getByRole('button', { name: 'Abrir' }).click();
  const indicator = page.getByTestId('page-indicator');
  await expect(indicator).toHaveText(/^1 \/ \d+$/);

  // Inside the toolbar the arrows move focus, not pages.
  await page.getByRole('button', { name: 'Diminuir zoom' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(indicator).toHaveText(/^1 \//);

  const viewer = page.getByTestId('viewer');
  await page.keyboard.press('Escape'); // the focused button's tooltip covers the viewer corner
  await viewer.click({ position: { x: 4, y: 4 } });
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(indicator).toHaveText(/^5 \//);

  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect(page.getByText('125%')).toBeVisible();
  await expect(indicator).toHaveText(/^5 \//);
  // Page 5 is still the one under the reading line (a third down the viewer).
  const box = (await page.locator('[data-page="4"]').boundingBox())!;
  const vbox = (await viewer.boundingBox())!;
  const line = vbox.y + vbox.height / 3;
  expect(box.y).toBeLessThanOrEqual(line);
  expect(box.y + box.height).toBeGreaterThan(line);
  await page.keyboard.press('ArrowRight');
  await expect(indicator).toHaveText(/^6 \//);
});

test('/dev/smoke renders page 1 with word spans', async ({ page }, info) => {
  await page.goto('/dev/smoke');
  const pageView = page.locator('[data-page="0"]');
  await expect(pageView.locator('img')).toBeVisible();
  const spans = pageView.locator('.word-layer span');
  await expect(spans.first()).toBeAttached();
  const count = Number(await page.getByTestId('word-count').textContent());
  expect(count).toBeGreaterThan(100);
  expect(await spans.count()).toBe(count);
  // Spans sit inside the page box.
  const box = (await pageView.boundingBox())!;
  const first = (await spans.first().boundingBox())!;
  expect(first.x).toBeGreaterThanOrEqual(box.x);
  expect(first.y).toBeGreaterThanOrEqual(box.y);
  await expect(page.getByTestId('timings')).toContainText('Anki');
  await page.getByRole('checkbox', { name: 'Mostrar caixas' }).check();
  await fullShot(page, shot('smoke', info.project.name));
});

test('keyboard shortcuts: ? lists shortcuts, Ctrl+Shift+A opens Anki', async ({ page }) => {
  await page.goto('/biblioteca');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Atalhos do teclado' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+A');
  await expect(page).toHaveURL(/\/anki$/);
});

test('narrow screens turn tabs into a menu', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/anki');
  await page.getByRole('button', { name: 'Anki' }).click();
  await expect(page.getByRole('menuitem', { name: 'Biblioteca' })).toBeVisible();
  await page.screenshot({ path: shot('narrow-menu', info.project.name) });
  await page.getByRole('menuitem', { name: 'Biblioteca' }).click();
  await expect(page).toHaveURL(/\/biblioteca$/);
});
