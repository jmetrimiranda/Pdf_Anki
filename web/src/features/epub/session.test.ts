// The open watchdog: when foliate never settles (e.g. the CSP refuses a section frame in the production build), the
// reader must reach its error state with "Tentar de novo" instead of spinning forever.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpubReaderEvents } from './types';

vi.mock('@foliate/view.js', () => ({}));
vi.mock('./loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./loader')>();
  return {
    ...actual,
    openEpubBook: vi.fn(async () => ({ sections: [{ linear: 'yes' }], toc: [], destroy() {} })),
  };
});

/** A <foliate-view> whose open() never settles. */
class HangingView extends HTMLElement {
  closed = false;
  open() {
    return new Promise<void>(() => {});
  }
  close() {
    this.closed = true;
  }
}
if (!customElements.get('foliate-view')) customElements.define('foliate-view', HangingView);

function events(): EpubReaderEvents {
  return {
    onLocation: vi.fn(),
    onActivity: vi.fn(),
    onSelection: vi.fn(),
    onMenu: vi.fn(),
    onVocabClick: vi.fn(),
    onSectionShown: vi.fn(),
    onKey: vi.fn(),
    onError: vi.fn(),
  };
}

const api = { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(async () => {}) };

describe('EpubSession open watchdog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails with a pt-BR timeout error (and can retry) when foliate never finishes opening', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { EpubSession, OPEN_TIMEOUT_MS } = await import('./session');
    expect(OPEN_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    const host = document.createElement('div');
    document.body.append(host);
    const ev = events();
    const session = new EpubSession(
      host,
      () => ev,
      api,
      async () => {},
    );
    session.openTimeoutMs = 30;
    const opening = session.open({ uid: 'b1', bytes: new Uint8Array([1]), title: 'Livro' });
    expect(session.snapshot().status).toBe('loading');
    await expect(opening).rejects.toThrow('O livro demorou demais para abrir.');
    const snap = session.snapshot();
    expect(snap.status).toBe('error');
    expect(snap.error).toEqual({ kind: 'timeout', message: 'O livro demorou demais para abrir.' });
    expect(ev.onError).toHaveBeenCalledWith('O livro demorou demais para abrir.');
    // The hung view is torn down.
    expect(host.querySelector('foliate-view')).toBeNull();
    // "Tentar de novo" starts a new open (which times out again here).
    const again = session.retry();
    expect(again).not.toBeNull();
    expect(session.snapshot().status).toBe('loading');
    await expect(again!).rejects.toThrow('O livro demorou demais para abrir.');
    expect(session.snapshot().status).toBe('error');
    session.close();
    host.remove();
  });
});
