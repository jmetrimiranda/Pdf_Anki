import { expect, setTheme, shot, stubPdfcraft, syncMock, test } from './fixtures';
import type { Page } from '@playwright/test';

// Anki sync UI against the mocked core (spec 9): settings, login, the top bar pill, offline, the full sync dialog and
// logout. The mock server accepts test/test on any http(s) address except AnkiWeb.
const DOWNLOAD = 'Baixar do servidor (recomendado se você revisou em outro aparelho)';
const UPLOAD = 'Enviar deste aparelho';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

async function openSettingsFromMenu(page: Page) {
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Configurações…' }).click();
  await expect(page).toHaveURL(/\/configuracoes\/anki$/);
  await expect(page.getByRole('heading', { name: 'Anki e sincronização' })).toBeVisible();
}

async function login(page: Page, url = 'http://ankisync:8080/') {
  await page.getByLabel('Endereço do servidor').fill(url);
  await page.getByLabel('Usuário').fill('test');
  await page.getByLabel('Senha').fill('test');
  await page.getByRole('button', { name: 'Entrar' }).click();
}

test('sync: login, status pill, offline, full sync and logout', async ({ page }) => {
  await page.goto('/biblioteca');
  const pill = page.getByTestId('sync-pill');
  await expect(pill).toHaveText('Sync desligado');

  await openSettingsFromMenu(page);
  // AnkiWeb is refused, before any request.
  await login(page, 'https://ankiweb.net/');
  await expect(page.getByText('Este app não sincroniza com o AnkiWeb. Use o seu servidor próprio.')).toBeVisible();
  await expect(page.getByLabel('Senha')).toHaveValue('');
  await expect(pill).toHaveText('Sync desligado');

  await page.getByLabel('Endereço do servidor').fill('http://ankisync:8080/');
  await expect(page.getByText('Conexão sem criptografia (http). Use só em rede de desenvolvimento.')).toBeVisible();
  await expect(
    page.getByText('A primeira sincronização baixa a coleção do servidor e substitui a deste aparelho.', {
      exact: false,
    }),
  ).toBeVisible();
  await login(page);
  await expect(pill).toHaveText('Sincronizando…');
  await expect(pill).toHaveText('Sincronizado agora');
  await expect(page.getByTestId('sync-connected')).toHaveText('Conectado como test em http://ankisync:8080/');

  await syncMock.setLastSyncAt(page, Date.now() - 2 * 60_000 - 5_000);
  await expect(pill).toHaveText('Sincronizado há 2 min');

  // Offline, then the network comes back: the window's "online" event makes the core sync again.
  await syncMock.setOffline(page, true);
  await expect(pill).toHaveText('Sem conexão');
  await pill.hover();
  await expect(page.getByRole('tooltip')).toContainText(/Tentando de novo às \d\d:\d\d/);
  await syncMock.setOffline(page, false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(pill).toHaveText('Sincronizado agora');

  // "Sincronizar agora" from the pill's popover.
  await pill.click();
  const popover = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Sincronizar agora' }) });
  await expect(popover.getByText('Conectado como test em http://ankisync:8080/')).toBeVisible();
  await syncMock.setLastSyncAt(page, Date.now() - 10 * 60_000);
  await expect(pill).toHaveText('Sincronizado há 10 min');
  await popover.getByRole('button', { name: 'Sincronizar agora' }).click();
  await expect(pill).toHaveText('Sincronizado agora');
  await expect(popover.getByRole('button', { name: 'Sincronizar agora' })).toBeEnabled();
  await page.keyboard.press('Escape');

  // The server needs a full sync: the dialog asks, upload needs a second confirmation.
  await syncMock.requireFull(page, { uploadOk: true, downloadOk: true });
  const dialog = page.getByRole('dialog', { name: 'Sincronização completa necessária' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: DOWNLOAD, exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: UPLOAD, exact: true })).toBeVisible();
  await expect(pill).toHaveText('Sync completa necessária');
  await dialog.getByRole('button', { name: UPLOAD, exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Enviar deste aparelho?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await syncMock.status(page)).state).toBe('fullSyncRequired');

  // Reopened from the pill; download.
  await pill.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: DOWNLOAD, exact: true }).click();
  await expect(
    page.getByText(/^Sincronização completa concluída\. Backup: backup-antes-da-sincronizacao-/),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(pill).toHaveText('Sincronizado agora');

  // The pre-sync backups are listed; the Anki tab has "Sincronizar".
  await page.getByRole('link', { name: 'Anki', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sincronizar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mais ações' }).click();
  await page.getByRole('menuitem', { name: 'Backups…' }).click();
  const backups = page.getByRole('dialog', { name: 'Backups da coleção' });
  await expect(backups.getByRole('listitem').filter({ hasText: 'Antes da sincronização' }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Logout (with confirmation).
  await openSettingsFromMenu(page);
  await page.getByRole('button', { name: 'Sair' }).click();
  const out = page.getByRole('dialog', { name: 'Sair do servidor?' });
  await expect(out).toContainText('A coleção deste aparelho continua aqui.');
  await out.getByRole('button', { name: 'Sair' }).click();
  await expect(pill).toHaveText('Sync desligado');
  await expect(page.getByLabel('Endereço do servidor')).toHaveValue('http://ankisync:8080/');
});

test('settings work on a narrow screen (icon-only pill)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/configuracoes');
  await expect(page).toHaveURL(/\/configuracoes\/anki$/);
  const nav = page.getByRole('navigation', { name: 'Seções das configurações' });
  await expect(nav.getByRole('link', { name: 'Anki e sincronização' })).toBeVisible();
  await login(page);
  const pill = page.getByTestId('sync-pill');
  await expect(pill).toHaveAccessibleName('Sincronização: Sincronizado agora');
  const box = await pill.boundingBox();
  expect(box?.width ?? 0).toBeLessThan(48);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`sync screens (${theme})`, async ({ page }, info) => {
    const snap = async (name: string) => {
      // Toasts of earlier steps would cover the header.
      for (const close of await page.getByRole('button', { name: 'Dispensar' }).all()) await close.click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: shot(`sync-${name}-${theme}`, info.project.name) });
    };
    await setTheme(page, theme);
    await page.goto('/configuracoes/anki');
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    await page.getByLabel('Endereço do servidor').fill('http://ankisync:8080/');
    await page.mouse.move(0, 0);
    await snap('settings-logged-out');

    await login(page);
    const pill = page.getByTestId('sync-pill');
    await expect(pill).toHaveText('Sincronizado agora');
    await syncMock.setLastSyncAt(page, Date.now() - 2 * 60_000 - 5_000);
    await expect(pill).toHaveText('Sincronizado há 2 min');
    await page.mouse.move(0, 0);
    await snap('settings-logged-in');

    await pill.click();
    await expect(page.getByRole('button', { name: 'Sincronizar agora' }).first()).toBeVisible();
    await snap('popover');
    await page.keyboard.press('Escape');

    await syncMock.requireFull(page, { uploadOk: true, downloadOk: true });
    await expect(page.getByRole('dialog', { name: 'Sincronização completa necessária' })).toBeVisible();
    await snap('full-sync');
    await page.getByRole('button', { name: UPLOAD, exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Enviar deste aparelho?' })).toBeVisible();
    await snap('full-sync-confirm');
  });
}
