import { describe, expect, it } from 'vitest';
import { shellActionFor } from './shortcuts';

function key(init: KeyboardEventInit, target?: HTMLElement): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, ...init });
  if (target) Object.defineProperty(e, 'target', { value: target });
  return e;
}

const body = () => document.body;
const iframe = (title = 'PdfCraft') => {
  const el = document.createElement('iframe');
  el.title = title;
  return el;
};

describe('shellActionFor', () => {
  it('maps Ctrl+1/2/3 to the app tabs when focus is outside the iframe', () => {
    expect(shellActionFor(key({ key: '1', code: 'Digit1', ctrlKey: true }), body())).toEqual({
      kind: 'tab',
      to: '/biblioteca',
    });
    expect(shellActionFor(key({ key: '2', code: 'Digit2', ctrlKey: true }), body())).toEqual({
      kind: 'tab',
      to: '/leitor',
    });
    expect(shellActionFor(key({ key: '3', code: 'Digit3', metaKey: true }), body())).toEqual({
      kind: 'tab',
      to: '/anki',
    });
  });

  it('leaves Ctrl+1/2/3 to PdfCraft while the iframe has focus', () => {
    expect(shellActionFor(key({ key: '1', code: 'Digit1', ctrlKey: true }), iframe())).toBeNull();
    expect(shellActionFor(key({ key: 'o', code: 'KeyO', ctrlKey: true }), iframe())).toBeNull();
    expect(shellActionFor(key({ key: '?' }), iframe())).toBeNull();
  });

  it('maps Alt+1/2/3 from anywhere, by physical key', () => {
    expect(shellActionFor(key({ key: '¡', code: 'Digit1', altKey: true }), iframe())).toEqual({
      kind: 'tab',
      to: '/biblioteca',
    });
    expect(shellActionFor(key({ key: '2', code: 'Digit2', altKey: true }), body())).toEqual({
      kind: 'tab',
      to: '/leitor',
    });
    expect(shellActionFor(key({ key: '4', code: 'Digit4', altKey: true }), body())).toBeNull();
    expect(shellActionFor(key({ key: '1', code: 'Digit1', altKey: true, shiftKey: true }), body())).toBeNull();
  });

  it('toggles the panel with Ctrl+Shift+P, also when forwarded from the iframe', () => {
    expect(shellActionFor(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), body())).toEqual({
      kind: 'togglePanel',
    });
    expect(shellActionFor(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }), iframe())).toEqual({
      kind: 'togglePanel',
    });
    // Ctrl+P is PdfCraft's print: never ours.
    expect(shellActionFor(key({ key: 'p', code: 'KeyP', ctrlKey: true }), body())).toBeNull();
  });

  it('opens "Adicionar livro" with Ctrl+O and the help with ? (not while typing)', () => {
    expect(shellActionFor(key({ key: 'o', code: 'KeyO', ctrlKey: true }), body())).toEqual({ kind: 'addBooks' });
    expect(shellActionFor(key({ key: '?' }, body()), body())).toEqual({ kind: 'help' });
    const input = document.createElement('input');
    expect(shellActionFor(key({ key: '?' }, input), input)).toBeNull();
  });

  it('no longer claims the removed document-tab shortcuts', () => {
    expect(shellActionFor(key({ key: 'w', code: 'KeyW', ctrlKey: true }), body())).toBeNull();
    expect(shellActionFor(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), body())).toBeNull();
    expect(shellActionFor(key({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }), body())).toBeNull();
    expect(shellActionFor(key({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }), body())).toBeNull();
  });

  it('only the PdfCraft frame keeps Ctrl+1/2/3: the card and Anki page frames let them through', () => {
    const card = iframe('Card');
    expect(shellActionFor(key({ key: '2', code: 'Digit2', ctrlKey: true }), card)).toEqual({
      kind: 'tab',
      to: '/leitor',
    });
    expect(shellActionFor(key({ key: '2', code: 'Digit2', ctrlKey: true }), iframe())).toBeNull();
    expect(shellActionFor(key({ key: '?' }), iframe('Opções do deck'))).toEqual({ kind: 'help' });
  });
});
