import { describe, expect, it, vi } from 'vitest';
import { forwardShortcuts, isForwardedShortcut, type KeyLike } from './keys';

const k = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('isForwardedShortcut', () => {
  it.each([
    ['Alt+1', k('1', 'Digit1', { altKey: true })],
    ['Alt+2', k('2', 'Digit2', { altKey: true })],
    ['Alt+3', k('3', 'Digit3', { altKey: true })],
    ['Ctrl+Shift+P', k('P', 'KeyP', { ctrlKey: true, shiftKey: true })],
    ['Cmd+Shift+P', k('p', 'KeyP', { metaKey: true, shiftKey: true })],
    ['Alt+C', k('c', 'KeyC', { altKey: true })],
    ['Alt+C (macOS ç)', k('ç', 'KeyC', { altKey: true })],
    ['Alt+C (other layout, key c)', k('c', 'KeyJ', { altKey: true })],
  ])('forwards %s', (_n, e) => expect(isForwardedShortcut(e)).toBe(true));

  it.each([
    // PdfCraft's own: zoom presets, open/save/find/print, new comment…
    ['Ctrl+1', k('1', 'Digit1', { ctrlKey: true })],
    ['Ctrl+2', k('2', 'Digit2', { ctrlKey: true })],
    ['Ctrl+3', k('3', 'Digit3', { ctrlKey: true })],
    ['Ctrl+P', k('p', 'KeyP', { ctrlKey: true })],
    ['Ctrl+O', k('o', 'KeyO', { ctrlKey: true })],
    ['Ctrl+S', k('s', 'KeyS', { ctrlKey: true })],
    ['Ctrl+F', k('f', 'KeyF', { ctrlKey: true })],
    // "Go to page…" inside PdfCraft: never the app's "Card da seleção" there.
    ['Ctrl+Shift+N', k('N', 'KeyN', { ctrlKey: true, shiftKey: true })],
    ['Cmd+Shift+N', k('n', 'KeyN', { metaKey: true, shiftKey: true })],
    // The save prompt's "Don't save".
    ['Alt+N', k('n', 'KeyN', { altKey: true })],
    ['Alt+D', k('d', 'KeyD', { altKey: true })],
    ['Ctrl+C', k('c', 'KeyC', { ctrlKey: true })],
    ['Ctrl+Alt+C', k('c', 'KeyC', { ctrlKey: true, altKey: true })],
    ['Alt+Shift+C', k('C', 'KeyC', { altKey: true, shiftKey: true })],
    ['plain c', k('c', 'KeyC')],
    ['Alt+4', k('4', 'Digit4', { altKey: true })],
    ['Alt+Shift+1', k('!', 'Digit1', { altKey: true, shiftKey: true })],
    ['Ctrl+Alt+Shift+P', k('P', 'KeyP', { ctrlKey: true, shiftKey: true, altKey: true })],
    ['plain 1', k('1', 'Digit1')],
    ['?', k('?', 'Slash', { shiftKey: true })],
  ])('leaves %s to PdfCraft', (_n, e) => expect(isForwardedShortcut(e)).toBe(false));
});

describe('forwardShortcuts', () => {
  it('stops the forwarded keys inside the frame and re-dispatches them on the app document', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const win = iframe.contentWindow!;
    const inFrame = vi.fn();
    const inApp = vi.fn();
    win.document.addEventListener('keydown', inFrame);
    const onApp = (e: KeyboardEvent) => inApp(e.key, e.altKey);
    document.addEventListener('keydown', onApp);
    const detach = forwardShortcuts(win, document);
    const press = (init: KeyboardEventInit) => {
      // The iframe's own KeyboardEvent, as a real key press inside it would be.
      const Ctor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
      const e = new Ctor('keydown', { ...init, bubbles: true, cancelable: true });
      win.document.body.dispatchEvent(e);
      return e;
    };

    expect(press({ key: '2', code: 'Digit2', altKey: true }).defaultPrevented).toBe(true);
    expect(inFrame).not.toHaveBeenCalled();
    expect(inApp).toHaveBeenCalledWith('2', true);

    expect(press({ key: '2', code: 'Digit2', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(inFrame).toHaveBeenCalledTimes(1);
    expect(inApp).toHaveBeenCalledTimes(1);

    // Alt+C ("Card da seleção") is the app's from anywhere; Ctrl+Shift+N stays PdfCraft's "Go to page…".
    expect(press({ key: 'c', code: 'KeyC', altKey: true }).defaultPrevented).toBe(true);
    expect(inFrame).toHaveBeenCalledTimes(1);
    expect(inApp).toHaveBeenLastCalledWith('c', true);
    const ctrlShiftN = press({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true });
    expect(ctrlShiftN.defaultPrevented).toBe(false);
    expect(inFrame).toHaveBeenCalledTimes(2);
    expect(inApp).toHaveBeenCalledTimes(2);

    detach();
    press({ key: '1', code: 'Digit1', altKey: true });
    expect(inApp).toHaveBeenCalledTimes(2);
    document.removeEventListener('keydown', onApp);
    iframe.remove();
  });
});
