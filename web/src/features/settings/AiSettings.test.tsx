import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { usd } from './AiSettings';

vi.mock('../leitor', () => ({
  leitor: { openBook: vi.fn(), togglePanel: vi.fn(), flushSaves: vi.fn(async () => true) },
  LeitorHost: () => null,
  useLeitorState: () => ({ ready: false, activeBookUid: null, openIds: [], panelOpen: true, theme: 'light' }),
}));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  queryClient.clear();
});
afterEach(() => vi.restoreAllMocks());

async function open() {
  await renderApp('/configuracoes/ia');
  await screen.findByRole('heading', { name: 'IA', level: 2 });
  await screen.findByTestId('ai-key-anthropic');
}

describe('Configurações → IA', () => {
  it('formats dollars in pt-BR', () => {
    expect(usd(1)).toBe('1,00');
    expect(usd(0.0123)).toBe('0,0123');
  });

  it('stores a key, shows only its end, tests and removes it', async () => {
    const user = userEvent.setup();
    const setKey = vi.spyOn(mockClient, 'aiKeySet');
    await open();
    const row = screen.getByTestId('ai-key-anthropic');
    expect(within(row).getByTestId('ai-key-status').textContent).toBe('sem chave');
    // Providers without an adapter yet are listed as coming.
    // The four providers have their adapter.
    for (const id of ['anthropic', 'openai', 'gemini', 'deepseek'])
      expect(within(screen.getByTestId(`ai-key-${id}`)).queryByText('em breve')).toBeNull();
    const input = within(row).getByLabelText('Cole a chave de Claude (Anthropic)') as HTMLInputElement;
    await user.type(input, 'test-key-anthropic-TEST');
    await user.click(within(row).getByRole('button', { name: 'Salvar chave' }));
    await waitFor(() => expect(within(row).getByTestId('ai-key-status').textContent).toBe('chave •••• TEST'));
    expect(input.value).toBe('');
    expect(setKey).toHaveBeenCalledWith('anthropic', 'test-key-anthropic-TEST');
    expect(document.body.textContent).not.toContain('anthropic-TEST');
    await user.click(within(row).getByRole('button', { name: 'Testar chave' }));
    expect(await within(row).findByText('Chave válida (modelo claude-haiku-5-5).')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Remover chave' }));
    await waitFor(() => expect(within(row).getByTestId('ai-key-status').textContent).toBe('sem chave'));
  });

  it('activating a provider shows what is sent and asks each time', async () => {
    const user = userEvent.setup();
    const set = vi.spyOn(mockClient, 'aiSettingsSet');
    await open();
    const card = screen.getByTestId('ai-function-enrich');
    const select = within(card).getByTestId('ai-provider-enrich') as HTMLSelectElement;
    await user.selectOptions(select, 'anthropic');
    const dialog = await screen.findByRole('dialog', { name: 'Ativar Claude (Anthropic)?' });
    expect(within(dialog).getByText(/api\.anthropic\.com/)).toBeTruthy();
    expect(within(dialog).getByText('Juiz de código')).toBeTruthy();
    // Cancel: nothing changes.
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(set).not.toHaveBeenCalled();
    await user.selectOptions(select, 'anthropic');
    await user.click(await screen.findByTestId('ai-consent-activate'));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ enrich: { provider: 'anthropic' }, consent: ['anthropic'] }));
    expect(await within(card).findByText('Falta a chave de Claude (Anthropic): adicione-a em "Chaves".')).toBeTruthy();
    expect((within(card).getByTestId('ai-model-enrich') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe(
      'claude-haiku-5-5 (padrão)',
    );
    // Turning off needs no dialog.
    await user.selectOptions(within(card).getByTestId('ai-provider-enrich'), '');
    await waitFor(() => expect(set).toHaveBeenLastCalledWith({ enrich: { provider: null } }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves the caps and shows the spending', async () => {
    const user = userEvent.setup();
    await mockClient.aiSettingsSet({ judge: { provider: 'anthropic' }, consent: ['anthropic'] });
    await mockClient.aiKeySet('anthropic', 'test-key-TEST');
    await mockClient.aiJudgeCode(
      { language: 'bash', question: 'q', answer: 'a', accepted: [], userAnswer: 'b', autoVerdict: 'almost', diffs: '' },
      false,
    );
    await open();
    const usage = await screen.findByTestId('ai-usage-rows');
    expect(usage.textContent).toMatch(/Claude \(Anthropic\) · Juiz de código: 1 chamada, US\$ 0,0\d+/);
    const day = screen.getByTestId('ai-limit-day') as HTMLInputElement;
    await user.clear(day);
    await user.type(day, '-1');
    await user.click(screen.getByRole('button', { name: 'Salvar limites' }));
    expect(await screen.findByText('Use valores a partir de 0.')).toBeTruthy();
    await user.clear(day);
    await user.type(day, '0,5');
    await user.click(screen.getByRole('button', { name: 'Salvar limites' }));
    await waitFor(async () => expect((await mockClient.aiSettingsGet()).limitDayUsd).toBe(0.5));
    expect(await screen.findByText(/Hoje: US\$ 0,0\d+ de US\$ 0,50/)).toBeTruthy();
  });

  it('edits and restores a price; the background queue switch needs the enrichment on', async () => {
    const user = userEvent.setup();
    await open();
    const queue = screen.getByTestId('ai-queue');
    expect((within(queue).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    const prices = screen.getByTestId('ai-prices');
    const haiku = within(prices).getByText('claude-haiku-5-5').closest('li')!;
    await user.click(within(haiku).getByRole('button', { name: 'Editar' }));
    const output = screen.getByLabelText('Saída') as HTMLInputElement;
    await user.clear(output);
    await user.type(output, '0,75');
    await user.click(screen.getByRole('button', { name: 'Salvar preço' }));
    await waitFor(() => expect(within(haiku).getByText('editado')).toBeTruthy());
    expect(haiku.textContent).toContain('saída 0,75');
    await user.click(within(haiku).getByRole('button', { name: 'Restaurar' }));
    await waitFor(() => expect(within(haiku).queryByText('editado')).toBeNull());
    fireEvent.click(screen.getByText('O que é enviado'));
  });

  it('the custom URL: local is free and keyless, a new URL asks again, removing it turns the function off', async () => {
    const user = userEvent.setup();
    const set = vi.spyOn(mockClient, 'aiSettingsSet');
    await open();
    const row = screen.getByTestId('ai-key-custom');
    expect(within(row).getByText('sem endereço')).toBeTruthy();
    const url = within(row).getByTestId('ai-custom-url') as HTMLInputElement;
    await user.type(url, 'http://example.com/v1');
    await user.click(within(row).getByRole('button', { name: 'Salvar endereço' }));
    expect(await within(row).findByText(/precisa de https/)).toBeTruthy();
    await user.clear(url);
    await user.type(url, 'http://localhost:11434/v1/');
    await user.click(within(row).getByRole('button', { name: 'Salvar endereço' }));
    expect(await within(row).findByTestId('ai-custom-where')).toBeTruthy();
    expect(within(row).getByTestId('ai-custom-where').textContent).toBe('neste computador · sem custo');
    expect(within(row).getByTestId('ai-key-status').textContent).toBe('chave opcional');

    const card = screen.getByTestId('ai-function-judge');
    await user.selectOptions(within(card).getByTestId('ai-provider-judge'), 'custom');
    const dialog = await screen.findByRole('dialog', { name: 'Ativar Compatível com OpenAI (URL personalizada)?' });
    expect(within(dialog).getByText(/localhost:11434/)).toBeTruthy();
    expect(within(dialog).getByTestId('ai-consent-note').textContent).toContain('não sai da máquina');
    await user.click(within(dialog).getByTestId('ai-consent-activate'));
    expect(await within(card).findByText('Informe o modelo do servidor para usar esta função.')).toBeTruthy();
    expect(within(card).queryByText(/Falta a chave/)).toBeNull();
    expect(within(card).queryByText('Esforço de raciocínio')).toBeNull();
    const model = within(card).getByTestId('ai-custom-model-judge');
    await user.type(model, 'llama3.3');
    await user.click(within(model.closest('form')!).getByRole('button', { name: 'Salvar' }));
    await waitFor(async () => expect((await mockClient.aiSettingsGet()).judge.model).toBe('llama3.3'));
    await user.click(within(row).getByRole('button', { name: 'Testar chave' }));
    expect(await within(row).findByText('Chave válida (modelo llama3.3).')).toBeTruthy();

    // A new URL while in use: the dialog again, for the new host.
    await user.clear(url);
    await user.type(url, 'http://127.0.0.1:1234/v1');
    await user.click(within(row).getByRole('button', { name: 'Salvar endereço' }));
    const again = await screen.findByRole('dialog');
    expect(within(again).getByText(/127\.0\.0\.1:1234/)).toBeTruthy();
    await user.click(within(again).getByTestId('ai-consent-activate'));
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith({ customBaseUrl: 'http://127.0.0.1:1234/v1', consent: ['custom'] }),
    );
    await user.click(within(row).getByRole('button', { name: 'Remover endereço' }));
    await waitFor(async () => expect((await mockClient.aiSettingsGet()).judge.provider).toBeNull());
  });
});
