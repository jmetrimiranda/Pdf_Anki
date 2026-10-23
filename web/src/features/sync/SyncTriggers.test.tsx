import { act, waitFor } from '@testing-library/react';
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

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  queryClient.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('SyncTriggers', () => {
  it('reports entering the Anki tab once per entry, not on its sub-routes', async () => {
    const notify = vi.spyOn(mockClient, 'ankiSyncNotify');
    const router = await renderApp('/biblioteca');
    expect(notify).not.toHaveBeenCalled();
    await act(() => router.navigate({ to: '/anki' }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith('tabEntered');
    await act(() => router.navigate({ to: '/anki/navegar', search: {} }));
    await act(() => router.navigate({ to: '/anki' }));
    await act(() => router.navigate({ to: '/leitor' }));
    expect(notify).toHaveBeenCalledTimes(1);
    await act(() => router.navigate({ to: '/anki/estatisticas' }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  });

  it('does not report "entering" when the app starts on the Anki tab', async () => {
    const notify = vi.spyOn(mockClient, 'ankiSyncNotify');
    await renderApp('/anki');
    await new Promise((r) => setTimeout(r, 20));
    expect(notify).not.toHaveBeenCalledWith('tabEntered');
  });

  it('reports the network and the window becoming visible', async () => {
    const notify = vi.spyOn(mockClient, 'ankiSyncNotify');
    await renderApp('/biblioteca');
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['offline', 'online', 'visible']);
  });
});
