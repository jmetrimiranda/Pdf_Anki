// Configurações → Código (spec 5.2, 11.1) against the mock core: give the user's own notetype of the deck
// "ROS 2 — Revisão" the Comando role (fields Frente/Comando/Explicação) and study its cards with the interactive
// panel; review options and the C++ section. Screenshots: test-results/screens/codigo-config*.png.
import type { Page } from '@playwright/test';
import { expect, fullShot, setTheme, shot, stubPdfcraft, test } from './fixtures';

const USER_TYPE = 'ROS 2 · Digite o comando';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

async function assignRole(page: Page) {
  await page.goto('/configuracoes/codigo');
  await expect(page.getByRole('heading', { name: 'Código', level: 2 })).toBeVisible();
  await expect(page.getByText('Nenhum tipo de nota seu tem o papel Comando ainda.')).toBeVisible();
  await page.getByRole('button', { name: 'Atribuir a um tipo existente' }).click();
  const form = page.getByRole('form', { name: 'Atribuir o papel Comando' });
  await form.getByRole('combobox', { name: 'Tipo de nota' }).selectOption({ label: USER_TYPE });
  await form.getByTestId('role-question').selectOption('Frente');
  await form.getByTestId('role-answer').selectOption('Comando');
  await form.getByTestId('role-notes').selectOption('Explicação');
  await expect(form).toContainText(
    'O tipo de nota não é alterado: sem mudança de esquema, sem sincronização completa.',
  );
  return form;
}

test('assigns the Comando role to an existing notetype and studies its cards interactively', async ({ page }) => {
  const form = await assignRole(page);
  // The same field twice is refused inline.
  await form.getByTestId('role-answer').selectOption('Frente');
  await form.getByRole('button', { name: 'Atribuir papel' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'A Pergunta, a Resposta e a Observação precisam ser campos diferentes.',
  );
  await form.getByTestId('role-answer').selectOption('Comando');
  await form.getByRole('button', { name: 'Atribuir papel' }).click();

  const row = page.getByTestId('code-mapping');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(USER_TYPE);
  await expect(row).toContainText('Pergunta: Frente · Resposta: Comando · Observação: Explicação');

  await page.goto(`/anki/estudar?nome=${encodeURIComponent('ROS 2 — Revisão')}`);
  // Every card of the deck is a code card now (app types and the assigned one): the panel shows up for them.
  await expect(page.getByTestId('code-panel')).toBeVisible();

  // Removing the role brings the list back to empty.
  await page.goto('/configuracoes/codigo');
  await page.getByRole('button', { name: `Remover o papel Comando de ${USER_TYPE}` }).click();
  await expect(page.getByText('Nenhum tipo de nota seu tem o papel Comando ainda.')).toBeVisible();
});

const noteRow = (page: Page) =>
  page
    .getByRole('grid', { name: 'Cards' })
    .locator('[role="row"][aria-rowindex]:not([aria-rowindex="1"])')
    .filter({ hasText: 'executáveis' })
    .first();

test('the notes of the assigned type get Aceitas/Exige in the note editor (code_note_extra)', async ({ page }) => {
  const form = await assignRole(page);
  await form.getByRole('button', { name: 'Atribuir papel' }).click();
  await expect(page.getByTestId('code-mapping')).toHaveCount(1);

  await page.goto(`/anki/navegar?busca=${encodeURIComponent('executáveis')}`);
  const side = page.getByTestId('browse-side');
  await noteRow(page).click();
  const extra = side.getByTestId('code-extra');
  await expect(extra).toBeVisible();
  await extra
    .getByRole('textbox', { name: 'Outras respostas aceitas' })
    .fill('ros2 pkg executables turtlesim --full-path');
  await extra.getByRole('textbox', { name: 'Exige' }).fill('ros2');
  await expect(side.getByText('Alterações não salvas')).toBeVisible();
  await side.getByRole('button', { name: 'Salvar' }).click();
  await expect(side.getByText('Salvo')).toBeVisible();

  // Kept by the app: back after a reload.
  await page.reload();
  await noteRow(page).click();
  await expect(side.getByRole('textbox', { name: 'Outras respostas aceitas' })).toHaveValue(
    'ros2 pkg executables turtlesim --full-path',
  );
  await expect(side.getByRole('textbox', { name: 'Exige' })).toHaveValue('ros2');
});

test('review options and the runner token (never shown back)', async ({ page }) => {
  await page.goto('/configuracoes/codigo');
  const easy = page.getByRole('switch', { name: 'Sugerir Fácil quando acertar rápido' });
  await expect(easy).toHaveAttribute('aria-checked', 'false');
  await easy.click();
  await expect(easy).toHaveAttribute('aria-checked', 'true');
  const secs = page.getByRole('spinbutton', { name: 'Em menos de (segundos)' });
  await secs.fill('0');
  await secs.blur();
  await expect(page.getByText('Use um número de 1 a 600.')).toBeVisible();
  await secs.fill('15');
  await secs.blur();
  await expect(page.getByText('Use um número de 1 a 600.')).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Endereço do runner' }).fill('https://runner.local.test');
  await page.getByTestId('runner-token').fill('segredo-de-teste-123');
  await page.getByRole('button', { name: 'Salvar runner' }).click();
  await expect(page.getByText('Token salvo no chaveiro')).toBeVisible();
  await expect(page.getByTestId('runner-token')).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Sugerir Fácil quando acertar rápido' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByRole('spinbutton', { name: 'Em menos de (segundos)' })).toHaveValue('15');
  expect(await page.content()).not.toContain('segredo-de-teste-123');
});

for (const theme of ['light', 'dark'] as const) {
  test(`screenshots of Configurações → Código (${theme})`, async ({ page }, info) => {
    await setTheme(page, theme);
    await assignRole(page);
    await fullShot(page, shot(`codigo-config-${theme}`, info.project.name));
  });
}

test('Configurações → Código at 390 px', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await assignRole(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await fullShot(page, shot('codigo-config-390', info.project.name));
});
