// The AI (spec 13, docs/planos/fase-8.md) against the mock core's simulated provider: the key in Configurações → IA
// (only its end is shown), the consent dialog of each activation, then the code judge. No network, fake keys.
// Screenshots: test-results/screens/ia-*.png.
import type { Page } from '@playwright/test';
import { expect, fullShot, shot, stubPdfcraft, test } from './fixtures';

const KEY = 'test-key-anthropic-TEST';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
});

async function activate(page: Page, fn: 'enrich' | 'judge', capture?: string) {
  await page.getByTestId(`ai-provider-${fn}`).selectOption('anthropic');
  const dialog = page.getByRole('dialog', { name: 'Ativar Claude (Anthropic)?' });
  await expect(dialog).toContainText('api.anthropic.com');
  await expect(dialog).toContainText('Cards de um trecho');
  if (capture) await dialog.screenshot({ path: capture });
  await dialog.getByTestId('ai-consent-activate').click();
  await expect(dialog).toHaveCount(0);
}

async function setUpClaude(page: Page, captures?: string) {
  await page.goto('/configuracoes/ia');
  await expect(page.getByRole('heading', { name: 'IA', level: 2 })).toBeVisible();
  const row = page.getByTestId('ai-key-anthropic');
  await expect(row.getByTestId('ai-key-status')).toHaveText('sem chave');
  await row.getByLabel('Cole a chave de Claude (Anthropic)').fill(KEY);
  await row.getByRole('button', { name: 'Salvar chave' }).click();
  await expect(row.getByTestId('ai-key-status')).toHaveText('chave •••• TEST');
  await expect(row.getByLabel('Cole a chave de Claude (Anthropic)')).toHaveValue('');
  await activate(page, 'enrich', captures && shot('ia-consentimento', captures));
  await activate(page, 'judge');
  await expect(page.getByTestId('ai-model-enrich')).toHaveValue('');
  await expect(page.getByTestId('ai-function-judge')).toContainText('claude-sonnet-5-5 (padrão)');
}

test('Configurações → IA: the key shows only its end, each activation asks, the key test', async ({ page }, info) => {
  await setUpClaude(page, info.project.name);
  const row = page.getByTestId('ai-key-anthropic');
  await row.getByRole('button', { name: 'Testar chave' }).click();
  await expect(row).toContainText('Chave válida (modelo claude-haiku-5-5).');
  expect(await page.locator('body').innerText()).not.toContain('anthropic-TEST');
  await expect(page.getByTestId('ai-key-openai')).toContainText('em breve');
  // The "saved" toasts would cover the top of the capture.
  await expect(page.getByRole('button', { name: 'Dispensar' })).toHaveCount(0, { timeout: 15_000 });
  await fullShot(page, shot('ia-configuracoes', info.project.name));
});

test('the code judge answers with the simulated AI and never rates the card', async ({ page }, info) => {
  await setUpClaude(page);
  await page.goto(`/anki/estudar?nome=${encodeURIComponent('ROS 2 — Revisão')}`);
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-shown', 'question');
  const input = page.getByTestId('code-command-input');
  await input.fill('ls -la');
  await input.press('Enter');
  await expect(page.getByTestId('code-verdict')).toHaveText('Errado');
  await page.getByRole('button', { name: 'Pedir avaliação da IA' }).click();
  const result = page.getByTestId('code-ai-result');
  await expect(result).toHaveAttribute('data-verdict', 'errado');
  await expect(result).toContainText('Sugestão da IA: De novo. Você decide a nota.');
  await page.getByTestId('code-panel').screenshot({ path: shot('ia-juiz', info.project.name) });
  await page.goto('/configuracoes/ia');
  await expect(page.getByTestId('ai-usage-rows')).toContainText('Claude (Anthropic) · Juiz de código: 1 chamada');
});
