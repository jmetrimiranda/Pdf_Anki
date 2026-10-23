// card-bridge.js (src-tauri/app/assets/card) in a jsdom iframe: the shim between reviewer.js and the study screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import shimSource from '../../../../../src-tauri/app/assets/card/card-bridge.js?raw';

type ShimWindow = Window &
  typeof globalThis & {
    pycmd: (cmd: string, cb?: (v: unknown) => void) => boolean;
    bridgeCommand: (cmd: string, cb?: (v: unknown) => void) => boolean;
    _showQuestion: ReturnType<typeof vi.fn>;
    _showAnswer: ReturnType<typeof vi.fn>;
    _drawFlag: ReturnType<typeof vi.fn>;
    _drawMark: ReturnType<typeof vi.fn>;
    getTypedAnswer: () => string | null;
    onShownHook: (() => void)[];
    anki?: { mutateNextCardStates?: (key: string, f: unknown) => Promise<void> };
  };

let frame: HTMLIFrameElement;
let win: ShimWindow;
/** The frame's `window.parent` (jsdom hands the frame a proxy that is not the test's `window`). */
let host: Window;
let posted: unknown[];

function load(before?: (w: ShimWindow) => void) {
  frame = document.createElement('iframe');
  document.body.append(frame);
  win = frame.contentWindow as ShimWindow;
  host = win.parent;
  vi.spyOn(host, 'postMessage').mockImplementation((msg: unknown) => {
    posted.push(msg);
  });
  win._showQuestion = vi.fn();
  win._showAnswer = vi.fn();
  win._drawFlag = vi.fn();
  win._drawMark = vi.fn();
  win.getTypedAnswer = () => 'typed text';
  win.onShownHook = [];
  before?.(win);
  const script = win.document.createElement('script');
  script.textContent = shimSource;
  win.document.head.append(script);
}

/** A message from the host (the test window is the frame's parent). */
function fromHost(data: unknown, source: Window | null | 'host' = 'host') {
  win.dispatchEvent(new win.MessageEvent('message', { data, source: (source === 'host' ? host : source) as Window }));
}

beforeEach(() => {
  posted = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  frame?.remove();
});

describe('card-bridge.js', () => {
  it('announces itself and turns pycmd/bridgeCommand into messages', () => {
    load();
    expect(posted).toContainEqual({ t: 'ready' });
    expect(win.pycmd('ans')).toBe(false);
    expect(posted).toContainEqual({ t: 'pycmd', cmd: 'ans', id: 0 });
    const cb = vi.fn();
    win.bridgeCommand('custom', cb);
    const msg = posted.at(-1) as { id: number };
    expect(msg).toMatchObject({ t: 'pycmd', cmd: 'custom' });
    expect(msg.id).toBeGreaterThan(0);
    fromHost({ t: 'cb', id: msg.id, v: 42 });
    expect(cb).toHaveBeenCalledWith(42);
  });

  it('drives reviewer.js from host messages', () => {
    load();
    fromHost({ t: 'showQuestion', q: '<b>Q</b>', a: 'A', bodyclass: 'card card1 isLin fancy' });
    expect(win._showQuestion).toHaveBeenCalledWith('<b>Q</b>', 'A', 'card card1 isLin fancy');
    fromHost({ t: 'showAnswer', a: 'ANS' });
    expect(win._showAnswer).toHaveBeenCalledWith('ANS');
    fromHost({ t: 'flag', flag: 3 });
    expect(win._drawFlag).toHaveBeenCalledWith(3);
    fromHost({ t: 'mark', mark: 1 });
    expect(win._drawMark).toHaveBeenCalledWith(true);
    fromHost({ t: 'getTypedAnswer' });
    expect(posted).toContainEqual({ t: 'typed', v: 'typed text' });
    win.getTypedAnswer = () => null;
    fromHost({ t: 'getTypedAnswer' });
    expect(posted.at(-1)).toEqual({ t: 'typed', v: '' });
  });

  it('ignores messages that do not come from the parent', () => {
    load();
    fromHost({ t: 'showAnswer', a: 'x' }, win);
    fromHost({ t: 'showAnswer', a: 'x' }, window);
    fromHost({ t: 'showAnswer', a: 'x' }, null);
    fromHost('showAnswer');
    expect(win._showAnswer).not.toHaveBeenCalled();
  });

  it('toggles night mode', () => {
    load();
    fromHost({ t: 'theme', night: true });
    const html = win.document.documentElement;
    expect(html.classList.contains('night-mode')).toBe(true);
    expect(html.getAttribute('data-bs-theme')).toBe('dark');
    expect(win.document.body.classList.contains('nightMode')).toBe(true);
    expect(win.document.body.classList.contains('night_mode')).toBe(true);
    fromHost({ t: 'theme', night: false });
    expect(html.classList.contains('night-mode')).toBe(false);
    expect(win.document.body.classList.contains('nightMode')).toBe(false);
  });

  it('forwards keys, except those typed in fields', () => {
    load();
    win.document.body.innerHTML = '<input id="typeans"><textarea></textarea><div contenteditable="true"></div>';
    const press = (target: EventTarget, init: KeyboardEventInit) =>
      target.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    press(win.document.body, { key: ' ', code: 'Space' });
    expect(posted.at(-1)).toEqual({
      t: 'key',
      key: ' ',
      code: 'Space',
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
    press(win.document.body, { key: '1', code: 'Digit1', altKey: true });
    expect(posted.at(-1)).toMatchObject({ t: 'key', key: '1', alt: true });
    const before = posted.length;
    press(win.document.getElementById('typeans')!, { key: 'a' });
    press(win.document.querySelector('textarea')!, { key: 'Enter' });
    expect(posted.length).toBe(before);
  });

  it('always reports statesMutated, even when the custom JS is broken', async () => {
    load();
    const warn = vi.spyOn(win.console, 'warn').mockImplementation(() => {});
    fromHost({ t: 'mutateStates', key: 'k', js: 'this is ( not javascript' });
    expect(warn).toHaveBeenCalled();
    expect(posted).toContainEqual({ t: 'pycmd', cmd: 'statesMutated:k', id: 0 });

    posted.length = 0;
    win.anki = { mutateNextCardStates: () => Promise.reject(new Error('boom')) };
    fromHost({ t: 'mutateStates', key: 'k', js: 'states.good = 1;' });
    await vi.waitFor(() => expect(posted).toContainEqual({ t: 'pycmd', cmd: 'statesMutated:k', id: 0 }));

    posted.length = 0;
    const seen: unknown[] = [];
    win.anki = {
      mutateNextCardStates: async (key, f) => {
        seen.push(key);
        await (f as (s: unknown, c: unknown, x: unknown) => Promise<void>)({}, {}, {});
      },
    };
    fromHost({ t: 'mutateStates', key: 'the-key', js: 'states.x = 1;' });
    await vi.waitFor(() => expect(posted).toContainEqual({ t: 'pycmd', cmd: 'statesMutated:the-key', id: 0 }));
    expect(seen).toEqual(['the-key']);
    expect(posted.filter((m) => (m as { cmd?: string }).cmd?.startsWith('statesMutated'))).toHaveLength(1);
  });

  it('turns leitor:// clicks into link messages', () => {
    load();
    win.document.body.innerHTML =
      '<a id="l" href="leitor://livro/abc?pagina=2"><b>p. 2</b></a><a id="o" href="#">x</a>';
    const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    win.document.querySelector('#l b')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(posted.at(-1)).toEqual({ t: 'link', href: 'leitor://livro/abc?pagina=2' });
    const before = posted.length;
    win.document.getElementById('o')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(posted.length).toBe(before);
  });

  it('asks for a "shown" when reviewer.js finishes a show', () => {
    load();
    expect(win.bridgeCommand('updateToolbar')).toBe(false);
    expect(posted.some((m) => (m as { cmd?: string }).cmd === 'updateToolbar')).toBe(false);
    expect(win.onShownHook).toHaveLength(1);
    win.onShownHook[0]!();
    expect(posted.at(-1)).toEqual({ t: 'shown' });
  });

  it('replaces storage that throws in the opaque origin with an in-memory one', () => {
    load((w) => {
      for (const name of ['localStorage', 'sessionStorage'])
        Object.defineProperty(w, name, {
          configurable: true,
          get() {
            throw new DOMException('denied', 'SecurityError');
          },
        });
    });
    win.localStorage.setItem('a', '1');
    expect(win.localStorage.getItem('a')).toBe('1');
    expect(win.localStorage.length).toBe(1);
    expect(win.sessionStorage.getItem('missing')).toBeNull();
    win.localStorage.clear();
    expect(win.localStorage.getItem('a')).toBeNull();
  });
});
