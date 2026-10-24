import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_LIBRARY_PASSWORD, mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';

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
  await renderApp('/configuracoes/anki');
  await screen.findByRole('form', { name: 'Biblioteca entre aparelhos' });
}

describe('Configurações → Biblioteca entre aparelhos', () => {
  it('connects with the library password (cleared after sending), syncs now and disconnects', async () => {
    const user = userEvent.setup();
    const login = vi.spyOn(mockClient, 'librarySyncLogin');
    await open();
    const form = screen.getByRole('form', { name: 'Biblioteca entre aparelhos' });
    expect((screen.getByLabelText('Servidor da biblioteca') as HTMLInputElement).value).toBe(
      'https://leitor-sync.jmetrimirandai.com',
    );
    await user.click(screen.getByRole('button', { name: 'Conectar este aparelho' }));
    expect(await screen.findByText('Preencha o endereço, o usuário e a senha.')).toBeTruthy();
    expect(login).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Usuário da biblioteca'), 'jorge');
    const password = screen.getByLabelText('Senha da biblioteca') as HTMLInputElement;
    await user.type(password, 'errada');
    await user.click(screen.getByRole('button', { name: 'Conectar este aparelho' }));
    expect(await screen.findByText('Usuário ou senha da biblioteca incorretos.')).toBeTruthy();
    expect(password.value).toBe('');

    await user.type(password, MOCK_LIBRARY_PASSWORD);
    await user.clear(screen.getByLabelText('Nome deste aparelho'));
    await user.type(screen.getByLabelText('Nome deste aparelho'), 'PC sala');
    await user.click(screen.getByRole('button', { name: 'Conectar este aparelho' }));
    const card = await screen.findByTestId('library-sync');
    expect(form.isConnected).toBe(false);
    expect(card.textContent).toContain('jorge em https://leitor-sync.jmetrimirandai.com · este aparelho: PC sala');
    expect(screen.getByTestId('library-sync-last').textContent).toBe('Ainda não sincronizou.');
    expect(login).toHaveBeenLastCalledWith('https://leitor-sync.jmetrimirandai.com', 'jorge', MOCK_LIBRARY_PASSWORD, 'PC sala');

    await user.click(screen.getByRole('button', { name: 'Sincronizar agora' }));
    await waitFor(() => expect(screen.getByTestId('library-sync-last').textContent).not.toBe('Ainda não sincronizou.'));
    await user.click(screen.getByRole('button', { name: 'Desconectar' }));
    expect(await screen.findByRole('form', { name: 'Biblioteca entre aparelhos' })).toBeTruthy();
    expect((await mockClient.librarySyncStatus()).loggedIn).toBe(false);
  });
});
