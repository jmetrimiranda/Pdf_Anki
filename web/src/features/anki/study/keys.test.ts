import { describe, expect, it, vi } from 'vitest';
import { forwardKey, studyKeyAction, type KeyLike } from './keys';

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: '',
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe('studyKeyAction', () => {
  it('Space/Enter show the answer, then answer Good like Anki desktop', () => {
    expect(studyKeyAction(k(' '), 'question', false)).toEqual({ kind: 'showAnswer' });
    expect(studyKeyAction(k('Enter'), 'question', false)).toEqual({ kind: 'showAnswer' });
    expect(studyKeyAction(k(' '), 'answer', false)).toEqual({ kind: 'answer', rating: 3 });
    expect(studyKeyAction(k('Enter'), 'answer', false)).toEqual({ kind: 'answer', rating: 3 });
  });

  it('1-4 answer only on the answer side', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(studyKeyAction(k(String(n)), 'answer', false)).toEqual({ kind: 'answer', rating: n });
      expect(studyKeyAction(k(String(n)), 'question', false)).toBeNull();
    }
    expect(studyKeyAction(k('5'), 'answer', false)).toBeNull();
  });

  it('maps the card actions', () => {
    expect(studyKeyAction(k('e'), 'question', false)).toEqual({ kind: 'edit' });
    expect(studyKeyAction(k('E', { shift: true }), 'answer', false)).toEqual({ kind: 'edit' });
    expect(studyKeyAction(k('*', { shift: true }), 'question', false)).toEqual({ kind: 'mark' });
    expect(studyKeyAction(k('-'), 'question', false)).toEqual({ kind: 'bury' });
    expect(studyKeyAction(k('='), 'question', false)).toEqual({ kind: 'buryNote' });
    expect(studyKeyAction(k('@', { shift: true }), 'question', false)).toEqual({ kind: 'suspend' });
    expect(studyKeyAction(k('!', { shift: true }), 'question', false)).toEqual({ kind: 'suspendNote' });
    expect(studyKeyAction(k('r'), 'answer', false)).toEqual({ kind: 'replay' });
    expect(studyKeyAction(k('x'), 'answer', false)).toBeNull();
  });

  it('Ctrl+Z undoes only when the last operation was an answer', () => {
    expect(studyKeyAction(k('z', { ctrl: true }), 'question', true)).toEqual({ kind: 'undo' });
    expect(studyKeyAction(k('z', { meta: true }), 'answer', true)).toEqual({ kind: 'undo' });
    expect(studyKeyAction(k('z', { ctrl: true }), 'question', false)).toBeNull();
    expect(studyKeyAction(k('Z', { ctrl: true, shift: true }), 'question', true)).toEqual({ kind: 'forward' });
  });

  it('forwards app shortcuts typed in the card frame', () => {
    expect(studyKeyAction(k('1', { alt: true }), 'answer', false)).toEqual({ kind: 'forward' });
    expect(studyKeyAction(k('P', { ctrl: true, shift: true }), 'question', false)).toEqual({ kind: 'forward' });
    expect(studyKeyAction(k('?', { shift: true }), 'question', false)).toEqual({ kind: 'forward' });
  });

  it('forwardKey re-dispatches the key on the window', () => {
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    forwardKey(k('2', { alt: true, code: 'Digit2' }));
    window.removeEventListener('keydown', seen);
    const e = seen.mock.calls[0]![0] as KeyboardEvent;
    expect([e.key, e.code, e.altKey, e.ctrlKey]).toEqual(['2', 'Digit2', true, false]);
  });
});
