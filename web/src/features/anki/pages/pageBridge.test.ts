import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import source from '../../../../../src-tauri/app/assets/anki-page/page-bridge.js?raw';

interface FakeWindow {
  document: Document;
  parent: Window;
  location: { hash: string };
  navigator: { userAgent: string };
  addEventListener: Window['addEventListener'];
  bridgeCommand?: (cmd: string) => boolean;
  pycmd?: (cmd: string) => boolean;
  anki?: { deckOptionsPendingChanges?: () => unknown };
  __leitorPageBridge?: boolean;
}

/**
 * Runs page-bridge.js against a stand-in window: the real jsdom document and event target, and a real (iframe)
 * window as the parent, whose postMessage is spied.
 */
function install(opts: { hash?: string; ua?: string } = {}) {
  const parentFrame = document.createElement('iframe');
  document.body.appendChild(parentFrame);
  const parent = parentFrame.contentWindow!;
  const posted = vi.spyOn(parent, 'postMessage').mockImplementation(() => undefined);
  const listeners: [string, EventListener][] = [];
  const fake: FakeWindow = {
    document,
    parent,
    location: { hash: opts.hash ?? '' },
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (X11; Linux x86_64)' },
    addEventListener: ((type: string, fn: EventListener) => {
      listeners.push([type, fn]);
      window.addEventListener(type, fn);
    }) as Window['addEventListener'],
  };
  new Function('window', source)(fake);
  const cleanup = () => {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn);
    parentFrame.remove();
  };
  const messages = () => posted.mock.calls.map((c) => c[0] as Record<string, unknown>);
  const fromParent = (data: unknown, source: Window = parent) =>
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  return { fake, parent, messages, fromParent, cleanup };
}

let env: ReturnType<typeof install> | null = null;
beforeEach(() => {
  document.documentElement.className = '';
  delete document.documentElement.dataset.bsTheme;
  document.body.className = '';
  document.title = 'Opções do deck';
});
afterEach(() => {
  env?.cleanup();
  env = null;
});

describe('page-bridge.js', () => {
  it('defines bridgeCommand/pycmd, which post to the parent and return false', () => {
    env = install();
    expect(env.fake.bridgeCommand?.('browserSearch: deck:current')).toBe(false);
    expect(env.fake.pycmd).toBe(env.fake.bridgeCommand);
    expect(env.messages()).toContainEqual({
      source: 'leitor-anki-page',
      t: 'bridgeCommand',
      cmd: 'browserSearch: deck:current',
    });
  });

  it('styles the page like desktop and reports loaded (document already complete)', () => {
    env = install({ hash: '#night' });
    expect(document.body.classList.contains('isLin')).toBe(true);
    expect(document.body.classList.contains('fancy')).toBe(true);
    expect(document.body.classList.contains('nightMode')).toBe(true);
    expect(document.body.classList.contains('night_mode')).toBe(true);
    expect(document.documentElement.classList.contains('night-mode')).toBe(true);
    expect(document.documentElement.dataset.bsTheme).toBe('dark');
    expect(document.title).toBe('Opções do deck');
    expect(document.querySelector('style[data-leitor="page-bridge"]')).toBeTruthy();
    expect(env.messages()).toContainEqual({ source: 'leitor-anki-page', t: 'loaded' });
  });

  it('uses the platform class of the user agent', () => {
    env = install({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(document.body.classList.contains('isWin')).toBe(true);
  });

  it('closes on Escape', () => {
    env = install();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(env.messages()).toContainEqual({ source: 'leitor-anki-page', t: 'close' });
  });

  it('on requestClose, lets deck options handle pending changes when the hook exists', async () => {
    env = install();
    const pending = vi.fn(async () => undefined);
    env.fake.anki = { deckOptionsPendingChanges: pending };
    env.fromParent({ t: 'requestClose' });
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveBeenCalledTimes(1);
    expect(env.messages().some((m) => m.t === 'close')).toBe(false);
  });

  it('on requestClose without the hook, posts close', () => {
    env = install();
    env.fromParent({ t: 'requestClose' });
    expect(env.messages()).toContainEqual({ source: 'leitor-anki-page', t: 'close' });
  });

  it('toggles the theme classes on {t:"theme"}', () => {
    env = install();
    env.fromParent({ t: 'theme', night: true });
    expect(document.documentElement.classList.contains('night-mode')).toBe(true);
    expect(document.body.classList.contains('nightMode')).toBe(true);
    env.fromParent({ t: 'theme', night: false });
    expect(document.documentElement.classList.contains('night-mode')).toBe(false);
    expect(document.documentElement.dataset.bsTheme).toBe('light');
    expect(document.body.classList.contains('night_mode')).toBe(false);
  });

  it('ignores messages that do not come from the parent window', () => {
    env = install();
    env.fromParent({ t: 'requestClose' }, window);
    env.fromParent({ t: 'theme', night: true }, window);
    expect(env.messages().some((m) => m.t === 'close')).toBe(false);
    expect(document.documentElement.classList.contains('night-mode')).toBe(false);
  });
});
