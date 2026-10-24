import { describe, expect, it } from 'vitest';
import { isAppShortcut, pageKeyAction } from './keys';

const key = (
  k: string,
  code: string,
  mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {},
) => ({
  key: k,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('EPUB reader keys', () => {
  it('turns pages with arrows, PageUp/PageDown and Space', () => {
    expect(pageKeyAction(key('ArrowRight', 'ArrowRight'))).toBe('right');
    expect(pageKeyAction(key('ArrowLeft', 'ArrowLeft'))).toBe('left');
    expect(pageKeyAction(key('PageDown', 'PageDown'))).toBe('next');
    expect(pageKeyAction(key('PageUp', 'PageUp'))).toBe('prev');
    expect(pageKeyAction(key(' ', 'Space'))).toBe('next');
    expect(pageKeyAction(key(' ', 'Space', { shiftKey: true }))).toBe('prev');
  });

  it('leaves modified keys, other keys and typing alone', () => {
    expect(pageKeyAction(key('ArrowRight', 'ArrowRight', { ctrlKey: true }))).toBeNull();
    expect(pageKeyAction(key('ArrowRight', 'ArrowRight', { shiftKey: true }))).toBeNull();
    expect(pageKeyAction(key('a', 'KeyA'))).toBeNull();
    const input = document.createElement('input');
    expect(pageKeyAction({ ...key(' ', 'Space'), target: input })).toBeNull();
  });

  it('forwards the app shortcuts and nothing else', () => {
    expect(isAppShortcut(key('1', 'Digit1', { ctrlKey: true }))).toBe(true);
    expect(isAppShortcut(key('3', 'Digit3', { metaKey: true }))).toBe(true);
    expect(isAppShortcut(key('2', 'Digit2', { altKey: true }))).toBe(true);
    expect(isAppShortcut(key('N', 'KeyN', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isAppShortcut(key('P', 'KeyP', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isAppShortcut(key('c', 'KeyC', { altKey: true }))).toBe(true);
    expect(isAppShortcut(key('?', 'Slash', { shiftKey: true }))).toBe(true);
    expect(isAppShortcut(key('ArrowRight', 'ArrowRight'))).toBe(false);
    expect(isAppShortcut(key('c', 'KeyC', { ctrlKey: true }))).toBe(false);
    expect(isAppShortcut(key('4', 'Digit4', { ctrlKey: true }))).toBe(false);
    expect(isAppShortcut(key('n', 'KeyN'))).toBe(false);
  });
});
