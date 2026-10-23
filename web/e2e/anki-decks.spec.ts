import { ankiLogs, dropPaths, expect, mockInit, setNextExportPath, setNextPackagePick, stubPdfcraft, test } from './fixtures';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

const tree = (page: Page) => page.getByRole('tree', { name: 'Decks' });
const row = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name},`) })
    .first();

async function deckMenu(page: Page, name: string, item: string) {
  const r = row(page, name);
  await r.hover();
  await r.getByRole('button', { name: `Ações do deck ${name}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('create a deck and a subdeck, rename, move and delete', async ({ page }) => {
  await page.goto('/anki');
  await expect(row(page, '5000 palavras')).toBeVisible();

  await page.getByRole('button', { name: 'Criar deck' }).click();
  let dialog = page.getByRole('dialog', { name: 'Criar deck' });
  await dialog.getByLabel('Nome do deck').fill('Francês');
  await dialog.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByText('Deck “Francês” criado.')).toBeVisible();
  await expect(row(page, 'Francês')).toBeVisible();

  await deckMenu(page, 'Francês', 'Criar subdeck');
  dialog = page.getByRole('dialog', { name: 'Criar subdeck em “Francês”' });
  await dialog.getByLabel('Nome do deck').fill('Verbos');
  await dialog.getByRole('button', { name: 'Criar' }).click();
  await expect(row(page, 'Verbos')).toBeVisible();

  await deckMenu(page, 'Francês', 'Renomear');
  dialog = page.getByRole('dialog', { name: 'Renomear deck' });
  await expect(dialog.getByLabel('Nome do deck')).toHaveValue('Francês');
  await dialog.getByLabel('Nome do deck').fill('Idiomas::');
  await expect(dialog.getByText('Cada parte do nome entre :: precisa ter texto.')).toBeVisible();
  await dialog.getByLabel('Nome do deck').fill('Francês A1');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(row(page, 'Francês A1')).toBeVisible();

  await deckMenu(page, 'Francês A1', 'Mover…');
  dialog = page.getByRole('dialog', { name: 'Mover “Francês A1”' });
  const select = dialog.getByLabel('Colocar dentro de');
  await expect(select.locator('option', { hasText: 'Francês A1::Verbos' })).toHaveCount(0);
  await select.selectOption({ label: 'Vocabulário' });
  await dialog.getByRole('button', { name: 'Mover' }).click();
  await expect(page.getByText('“Francês A1” foi movido.')).toBeVisible();
  expect((await ankiLogs(page)).some((l) => l.kind === 'moveDecks')).toBe(true);

  await deckMenu(page, 'Matemática', 'Excluir');
  dialog = page.getByRole('dialog', { name: 'Excluir “Matemática” e 2 cards?' });
  await dialog.getByRole('button', { name: 'Excluir' }).click();
  await expect(page.getByText('“Matemática” foi excluído (2 cards).')).toBeVisible();
  await expect(row(page, 'Matemática')).toHaveCount(0);
});

test('collapse state persists across a reload', async ({ page }) => {
  await page.goto('/anki');
  const oxford = row(page, 'Oxford');
  await expect(oxford).toHaveAttribute('aria-expanded', 'true');
  await oxford.getByRole('button', { name: 'Recolher' }).click();
  await expect(oxford).toHaveAttribute('aria-expanded', 'false');
  await expect(tree(page).getByRole('treeitem', { name: /^Oxford 3000,/ })).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(row(page, 'Oxford')).toHaveAttribute('aria-expanded', 'false');
  await row(page, 'Oxford').getByRole('button', { name: 'Expandir' }).click();
  await expect(tree(page).getByRole('treeitem', { name: /^Oxford 3000,/ })).toBeVisible();
});

test('export a deck as .apkg with the chosen options', async ({ page }) => {
  await page.goto('/anki');
  await deckMenu(page, '5000 palavras', 'Exportar .apkg…');
  const dialog = page.getByRole('dialog', { name: 'Exportar “5000 palavras”' });
  await dialog.getByRole('checkbox', { name: 'Incluir mídia' }).uncheck();
  await setNextExportPath(page, '/tmp/palavras.apkg');
  await dialog.getByRole('button', { name: 'Escolher onde salvar…' }).click();
  await expect(page.getByText('Deck exportado: 7 notas.')).toBeVisible();
  const log = (await ankiLogs(page)).filter((l) => l.kind === 'export');
  expect(log).toEqual([
    expect.objectContaining({ path: '/tmp/palavras.apkg', withScheduling: true, withMedia: false, notes: 7 }),
  ]);
});

test('prepare the collection, back up and list backups', async ({ page }) => {
  await page.goto('/anki');
  await page.getByRole('button', { name: 'Mais ações' }).click();
  await page.getByRole('menuitem', { name: 'Preparar coleção' }).click();
  await expect(page.getByText('Tipos de nota criados: Cloze (Leitor).')).toBeVisible();
  await page.getByRole('button', { name: 'Mais ações' }).click();
  await page.getByRole('menuitem', { name: 'Preparar coleção' }).click();
  await expect(page.getByText(/^A coleção já está preparada/)).toBeVisible();

  await page.getByRole('button', { name: 'Mais ações' }).click();
  await page.getByRole('menuitem', { name: 'Fazer backup agora' }).click();
  await expect(page.getByText(/^Backup feito: backup-manual-/)).toBeVisible();

  await page.getByRole('button', { name: 'Mais ações' }).click();
  await page.getByRole('menuitem', { name: 'Backups…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Backups da coleção' });
  const list = dialog.getByRole('list', { name: 'Backups da coleção' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('listitem').first()).toContainText('Manual');
  await expect(list).toContainText('Diário');
});

test('replace the collection with a .colpkg (two confirmations)', async ({ page }) => {
  await page.goto('/anki');
  await expect(row(page, 'Matemática')).toBeVisible();
  await setNextPackagePick(page, '/home/jorge/Anki/colecao.colpkg');
  await page.getByRole('button', { name: 'Importar' }).click();
  await page.getByRole('menuitem', { name: 'Coleção inteira (.colpkg)…' }).click();
  await page
    .getByRole('dialog', { name: 'Substituir a coleção inteira?' })
    .getByRole('button', { name: 'Continuar' })
    .click();
  const sure = page.getByRole('dialog', { name: 'Tem certeza?' });
  await expect(sure.getByRole('button', { name: 'Substituir coleção' })).toBeDisabled();
  await sure.getByRole('checkbox', { name: 'Entendo que a coleção atual será substituída' }).check();
  await sure.getByRole('button', { name: 'Substituir coleção' }).click();
  await expect(page.getByText(/^Coleção substituída\. Backup da anterior: backup-antes-de-importar-/)).toBeVisible();
  await expect(tree(page).getByRole('treeitem', { name: /^(5000 palavras|Oxford|ROS 2 — Revisão),/ })).toHaveCount(3);
  await expect(row(page, 'Matemática')).toHaveCount(0);
});

test('a .apkg opened with the app asks, imports and reports', async ({ page }) => {
  await mockInit(page, { pendingOpen: ['/home/jorge/Downloads/Fazenda.apkg'] });
  await page.goto('/biblioteca');
  const dialog = page.getByRole('dialog', { name: 'Importar “Fazenda.apkg” para a coleção?' });
  await dialog.getByRole('button', { name: 'Importar' }).click();
  await expect(page.getByText('Pacote importado: 3 notas adicionadas, 0 atualizadas.')).toBeVisible();
  await expect(page).toHaveURL(/\/anki$/);
  await expect(row(page, 'Fazenda')).toBeVisible();
});

test('a dropped .colpkg replaces the collection only after both confirmations', async ({ page }) => {
  await page.goto('/anki');
  await expect(row(page, 'Matemática')).toBeVisible();
  await dropPaths(page, ['/home/jorge/Anki/colecao.colpkg']);
  const first = page.getByRole('dialog', { name: 'Substituir a coleção inteira?' });
  await expect(first).toBeVisible();
  expect((await ankiLogs(page)).filter((l) => l.kind === 'importColpkg')).toHaveLength(0);
  await first.getByRole('button', { name: 'Continuar' }).click();
  const sure = page.getByRole('dialog', { name: 'Tem certeza?' });
  await expect(sure).toBeVisible();
  expect((await ankiLogs(page)).filter((l) => l.kind === 'importColpkg')).toHaveLength(0);
  await sure.getByRole('checkbox', { name: 'Entendo que a coleção atual será substituída' }).check();
  await sure.getByRole('button', { name: 'Substituir coleção' }).click();
  await expect(page.getByText(/^Coleção substituída\. Backup da anterior: backup-antes-de-importar-/)).toBeVisible();
  expect((await ankiLogs(page)).filter((l) => l.kind === 'importColpkg')).toHaveLength(1);
  await expect(row(page, 'Matemática')).toHaveCount(0);
});

test('cancelling the first .colpkg confirmation imports nothing', async ({ page }) => {
  await page.goto('/anki');
  await dropPaths(page, ['/home/jorge/Anki/colecao.colpkg']);
  const first = page.getByRole('dialog', { name: 'Substituir a coleção inteira?' });
  await first.getByRole('button', { name: 'Cancelar' }).click();
  await expect(first).toBeHidden();
  expect((await ankiLogs(page)).filter((l) => l.kind === 'importColpkg')).toHaveLength(0);
  await expect(row(page, 'Matemática')).toBeVisible();
});
