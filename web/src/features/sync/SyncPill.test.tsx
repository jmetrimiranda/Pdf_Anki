import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import type { AnkiSyncStatus } from '../../lib/core/types';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { TooltipProvider } from '../../components/ui';
import { SyncPill, syncPillHint, syncPillText } from './SyncPill';
import { syncStatusKey } from './useSyncStatus';

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

const NOW = new Date(2026, 9, 23, 15, 30).getTime();

function status(patch: Partial<AnkiSyncStatus>): AnkiSyncStatus {
  return {
    state: 'idle',
    url: 'https://anki.example.org/',
    user: 'test',
    loggedIn: true,
    certificateFingerprint: null,
    firstSyncPending: false,
    lastSyncAt: NOW,
    lastError: null,
    fullSync: null,
    nextRetryAt: null,
    mediaSyncing: false,
    mediaError: null,
    serverMessage: null,
    ...patch,
  };
}

const pill = () => screen.getByTestId('sync-pill');

describe('sync pill text', () => {
  it('names every state', () => {
    expect(syncPillText(undefined, NOW)).toBe('Sync desligado');
    expect(syncPillText(status({ state: 'off', loggedIn: false }), NOW)).toBe('Sync desligado');
    expect(syncPillText(status({ state: 'syncing' }), NOW)).toBe('Sincronizando…');
    expect(syncPillText(status({ lastSyncAt: NOW - 30_000 }), NOW)).toBe('Sincronizado agora');
    expect(syncPillText(status({ lastSyncAt: NOW - 2 * 60_000 }), NOW)).toBe('Sincronizado há 2 min');
    expect(syncPillText(status({ lastSyncAt: NOW - 3 * 3_600_000 }), NOW)).toBe('Sincronizado há 3 h');
    expect(syncPillText(status({ lastSyncAt: NOW - 30 * 3_600_000 }), NOW)).toMatch(
      /^Sincronizado em \d\d\/\d\d\/2026$/,
    );
    expect(syncPillText(status({ lastSyncAt: null }), NOW)).toBe('Ainda não sincronizado');
    expect(syncPillText(status({ state: 'offline' }), NOW)).toBe('Sem conexão');
    expect(syncPillText(status({ state: 'error' }), NOW)).toBe('Erro na sincronização');
    expect(syncPillText(status({ state: 'fullSyncRequired' }), NOW)).toBe('Sync completa necessária');
    const refused = { code: 'anki_sync_auth_failed', message: 'A sessão expirou.' };
    expect(syncPillText(status({ state: 'off', loggedIn: false, lastError: refused }), NOW)).toBe('Entre de novo');
    expect(syncPillHint(status({ state: 'off', loggedIn: false, lastError: refused }))).toBe('A sessão expirou.');
  });

  it('has a hint when off and offline', () => {
    expect(syncPillHint(undefined)).toBe('Configure o servidor em Configurações → Anki e sincronização');
    const retry = new Date(2026, 9, 23, 15, 31).getTime();
    expect(syncPillHint(status({ state: 'offline', nextRetryAt: retry }))).toBe('Tentando de novo às 15:31');
    expect(syncPillHint(status({ state: 'offline' }))).toBe('Tenta de novo quando a rede voltar.');
    expect(syncPillHint(status({}))).toBeNull();
  });
});

describe('SyncPill in the top bar', () => {
  it('is off by default; the popover links to the settings', async () => {
    const router = await renderApp();
    await waitFor(() => expect(pill().dataset.syncState).toBe('off'));
    expect(pill().textContent).toBe('Sync desligado');
    fireEvent.click(pill());
    const link = await screen.findByRole('link', { name: 'Configurações de sincronização' });
    expect(screen.queryByRole('button', { name: 'Sincronizar agora' })).toBeNull();
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/configuracoes/anki'));
  });

  it('shows each state the core reports', async () => {
    await renderApp();
    await waitFor(() => expect(queryClient.getQueryData(syncStatusKey)).toBeDefined());
    const set = (s: AnkiSyncStatus) => act(() => void queryClient.setQueryData(syncStatusKey, s));

    set(status({ state: 'syncing' }));
    await waitFor(() => expect(pill().textContent).toBe('Sincronizando…'));
    expect(within(pill()).getByRole('status')).toBeTruthy();

    set(status({ lastSyncAt: Date.now() - 2 * 60_000 - 1000 }));
    await waitFor(() => expect(pill().textContent).toBe('Sincronizado há 2 min'));

    set(status({ state: 'offline', nextRetryAt: Date.now() + 60_000 }));
    await waitFor(() => expect(pill().textContent).toBe('Sem conexão'));

    set(status({ state: 'error', lastError: { code: 'anki_sync_server_error', message: 'O servidor falhou.' } }));
    await waitFor(() => expect(pill().textContent).toBe('Erro na sincronização'));
    expect(pill().className).toContain('text-error');
    fireEvent.click(pill());
    expect(await screen.findByText('O servidor falhou.')).toBeTruthy();
  });

  it('"Sincronizar agora" runs a sync and is disabled while syncing', async () => {
    await renderApp();
    await act(async () => {
      await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null);
    });
    await waitFor(() => expect(pill().textContent).toBe('Sincronizado agora'));
    const sync = vi.spyOn(mockClient, 'ankiSync');
    fireEvent.click(pill());
    const button = await screen.findByRole('button', { name: 'Sincronizar agora' });
    fireEvent.click(button);
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Conectado como test em http://ankisync:8080/')).toBeTruthy();
    sync.mockRestore();
  });

  it('does not log out silently when the server refuses the key', async () => {
    await renderApp();
    await act(async () => {
      await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null);
    });
    await waitFor(() => expect(pill().dataset.syncState).toBe('idle'));
    act(() => mockHandle.syncRefuseKey());
    await waitFor(() => expect(pill().textContent).toBe('Entre de novo'));
    expect(pill().dataset.syncState).toBe('off');
    expect(pill().className).toContain('text-error');
    fireEvent.click(pill());
    expect(
      await screen.findByText(
        'A sincronização foi desligada: Usuário ou senha incorretos, ou a sessão expirou. Entre de novo.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Configurações de sincronização' })).toBeTruthy();
  });

  it('reopens the full sync dialog while one is required', async () => {
    await renderApp();
    await act(async () => {
      await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null);
    });
    await waitFor(() => expect(pill().dataset.syncState).toBe('idle'));
    act(() => mockHandle.syncRequireFull({ uploadOk: true, downloadOk: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Sincronização completa necessária' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agora não' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(pill().textContent).toBe('Sync completa necessária');
    fireEvent.click(pill());
    expect(await screen.findByRole('dialog', { name: 'Sincronização completa necessária' })).toBeTruthy();
  });
});

describe('SyncPill clock', () => {
  it('re-renders the relative time every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(NOW);
      const client = new QueryClient();
      client.setQueryData(syncStatusKey, status({ lastSyncAt: NOW - 50_000 }));
      render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <SyncPill />
          </TooltipProvider>
        </QueryClientProvider>,
      );
      expect(pill().textContent).toBe('Sincronizado agora');
      act(() => vi.advanceTimersByTime(30_000));
      expect(pill().textContent).toBe('Sincronizado há 1 min');
      act(() => vi.advanceTimersByTime(60_000));
      expect(pill().textContent).toBe('Sincronizado há 2 min');
    } finally {
      vi.useRealTimers();
    }
  });
});
