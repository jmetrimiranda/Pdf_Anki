import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';

vi.mock('../leitor', () => ({
  leitor: { openBook: vi.fn(), togglePanel: vi.fn(), flushSaves: vi.fn(async () => true) },
  LeitorHost: () => null,
  useLeitorState: () => ({ ready: false, activeBookUid: null, openIds: [], panelOpen: true, theme: 'light' }),
}));

const PEM = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhZG8gZGUgdGVzdGUwCgYIKoZIzj0EAwIw
-----END CERTIFICATE-----
`;

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  queryClient.clear();
});
afterEach(() => vi.restoreAllMocks());

async function open() {
  const router = await renderApp('/configuracoes');
  await waitFor(() => expect(router.state.location.pathname).toBe('/configuracoes/anki'));
  await screen.findByRole('button', { name: 'Entrar' });
  return router;
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

describe('Configurações → Anki e sincronização', () => {
  it('lists the sections of spec 5.2: Anki e sincronização and the IA placeholder are active', async () => {
    const router = await open();
    const nav = screen.getByRole('navigation', { name: 'Seções das configurações' });
    expect(within(nav).getByRole('link', { name: 'Anki e sincronização' }).getAttribute('aria-current')).toBe('page');
    for (const name of ['Geral', 'Leitura', 'Vocabulário', 'Código', 'Integração com o Painel']) {
      expect(within(nav).getByText(name).closest('[aria-disabled="true"]')).toBeTruthy();
    }
    expect(within(nav).getAllByText('em breve')).toHaveLength(5);
    // "Criar cards com IA" (book panel) links here until the AI arrives (Phase 8).
    fireEvent.click(within(nav).getByRole('link', { name: 'IA' }));
    await screen.findByText('Provedor de IA: em breve…');
    expect(router.state.location.pathname).toBe('/configuracoes/ia');
  });

  it('validates the empty fields before calling the core', async () => {
    const login = vi.spyOn(mockClient, 'ankiSyncLogin');
    await open();
    submit();
    expect(await screen.findByText('Informe o endereço do servidor.')).toBeTruthy();
    expect(screen.getByText('Informe o usuário.')).toBeTruthy();
    expect(screen.getByText('Informe a senha.')).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
    expect(field('Senha').type).toBe('password');
    expect(field('Senha').autocomplete).toBe('off');
  });

  it('warns about http and shows the AnkiWeb refusal on the address', async () => {
    await open();
    type('Endereço do servidor', 'http://ankisync:8080/');
    expect(screen.getByText('Conexão sem criptografia (http). Use só em rede de desenvolvimento.')).toBeTruthy();
    type('Endereço do servidor', 'https://ankiweb.net/');
    expect(screen.queryByTestId('sync-http-warning')).toBeNull();
    type('Usuário', 'test');
    type('Senha', 'test');
    submit();
    expect(await screen.findByText(/não sincroniza com o AnkiWeb/)).toBeTruthy();
    expect(field('Endereço do servidor').getAttribute('aria-invalid')).toBe('true');
    expect(field('Senha').value).toBe('');
  });

  it('clears the password after a failed login and logs in with test/test', async () => {
    const login = vi.spyOn(mockClient, 'ankiSyncLogin');
    await open();
    type('Endereço do servidor', 'http://ankisync:8080');
    type('Usuário', 'test');
    type('Senha', 'errada');
    submit();
    expect(await screen.findByText(/^Usuário ou senha incorretos/)).toBeTruthy();
    expect(field('Senha').value).toBe('');
    type('Senha', 'test');
    submit();
    expect(await screen.findByText('Conectado como test em http://ankisync:8080/')).toBeTruthy();
    expect(login).toHaveBeenLastCalledWith('http://ankisync:8080', 'test', 'test', null);
    await waitFor(() => expect(screen.getByTestId('sync-last').textContent).toBe('Sincronizado agora'));
    // Nothing of the password stays in the page or in the session storage.
    expect(document.body.innerHTML).not.toContain('errada');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('errada');
  });

  it('reads a certificate file, shows its fingerprint, and removes it', async () => {
    const setCert = vi.spyOn(mockClient, 'ankiSyncSetCertificate');
    await open();
    const input = screen.getByTestId('sync-cert-input');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([PEM], 'ca.pem', { type: 'application/x-pem-file' })] } });
    });
    await waitFor(() => expect(setCert).toHaveBeenCalledWith(PEM));
    expect((await screen.findByTestId('sync-cert-fingerprint')).textContent).toMatch(
      /^Impressão digital SHA-256: ([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(setCert).toHaveBeenLastCalledWith(null));
    await waitFor(() => expect(screen.getByTestId('sync-cert-fingerprint').textContent).toMatch(/Nenhum certificado/));
  });

  it('refuses a certificate that is too large or not PEM', async () => {
    const setCert = vi.spyOn(mockClient, 'ankiSyncSetCertificate');
    await open();
    const input = screen.getByTestId('sync-cert-input');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'.repeat(65 * 1024)], 'big.pem')] } });
    });
    expect(await screen.findByText('O arquivo é grande demais para um certificado (máximo de 64 KB).')).toBeTruthy();
    expect(setCert).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['hello'], 'x.pem')] } });
    });
    expect(await screen.findByText('O arquivo não contém exatamente um certificado PEM válido.')).toBeTruthy();
  });

  it('offers to choose the copy when a full sync is required, and reopens the dialog', async () => {
    await act(async () => {
      await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null);
    });
    await renderApp('/configuracoes/anki');
    await screen.findByRole('button', { name: 'Sincronizar agora' });
    act(() => mockHandle.syncRequireFull({ uploadOk: true, downloadOk: true }));
    const first = await screen.findByRole('dialog', { name: 'Sincronização completa necessária' });
    fireEvent.click(within(first).getByRole('button', { name: 'Agora não' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('sync-last').textContent).toBe('Sync completa necessária');
    expect(screen.getByText('Escolha qual cópia da coleção fica.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sincronizar agora' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Escolher a cópia…' }));
    expect(await screen.findByRole('dialog', { name: 'Sincronização completa necessária' })).toBeTruthy();
  });

  it('wraps the certificate sentence at spaces; only the fingerprint breaks anywhere', async () => {
    await open();
    const line = screen.getByTestId('sync-cert-fingerprint');
    expect(line.className).not.toContain('break-all');
  });

  it('asks before logging out; the pill goes back to "Sync desligado"', async () => {
    await act(async () => {
      await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null);
    });
    const router = await renderApp('/configuracoes/anki');
    expect(router.state.location.pathname).toBe('/configuracoes/anki');
    fireEvent.click(await screen.findByRole('button', { name: 'Sair' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sair do servidor?' });
    expect(dialog.textContent).toContain('A coleção deste aparelho continua aqui.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockHandle.syncStatus().loggedIn).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sair' }));
    await waitFor(() => expect(screen.getByTestId('sync-pill').textContent).toBe('Sync desligado'));
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(field('Endereço do servidor').value).toBe('http://ankisync:8080/');
  });

  it('asks to log in again when the server refused the stored key', async () => {
    await act(async () => {
      await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null);
    });
    await renderApp('/configuracoes/anki');
    await screen.findByRole('button', { name: 'Sair' });
    act(() => mockHandle.syncRefuseKey());
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(
      screen.getByText(
        'A sincronização foi desligada: Usuário ou senha incorretos, ou a sessão expirou. Entre de novo.',
      ),
    ).toBeTruthy();
    expect(field('Usuário').value).toBe('test');
    expect(screen.getByTestId('sync-pill').textContent).toBe('Entre de novo');
    // A new login clears the notice.
    type('Senha', 'test');
    submit();
    expect(await screen.findByText('Conectado como test em http://ankisync:8080/')).toBeTruthy();
    expect(screen.queryByText(/^A sincronização foi desligada/)).toBeNull();
  });
});
