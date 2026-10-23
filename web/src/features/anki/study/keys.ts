// Study screen keys (spec 8.2, like Anki desktop's reviewer): Space/Enter show the answer (and answer "Bom" on the
// answer side), 1–4 answer, E edits, Ctrl+Z undoes the last answer, * marks, - buries, @ suspends, R replays audio.
// They come from the app document (keydown on window) or from the card iframe ({t:'key'} forwarded by the shim).

/** A keydown, from a KeyboardEvent or from the card shim's message. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type Rating = 1 | 2 | 3 | 4;

export type StudyKeyAction =
  | { kind: 'showAnswer' }
  | { kind: 'answer'; rating: Rating }
  | { kind: 'edit' }
  | { kind: 'undo' }
  | { kind: 'mark' }
  | { kind: 'bury' }
  | { kind: 'buryNote' }
  | { kind: 'suspend' }
  | { kind: 'suspendNote' }
  | { kind: 'replay' }
  /** Not a study key: an app shortcut (Alt+1, Ctrl+Shift+P, ?…) that a key from the card frame must reach. */
  | { kind: 'forward' };

export type Side = 'question' | 'answer';

export function keyLikeOf(e: KeyboardEvent): KeyLike {
  return { key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
}

/** The study action of a key, or null. `canUndo` gates Ctrl+Z (only an answer can be undone, spec 10.1). */
export function studyKeyAction(k: KeyLike, side: Side, canUndo: boolean): StudyKeyAction | null {
  const mod = k.ctrl || k.meta;
  if (mod && !k.alt && !k.shift && (k.key.toLowerCase() === 'z' || k.code === 'KeyZ')) {
    return canUndo ? { kind: 'undo' } : null;
  }
  if (mod || k.alt) return { kind: 'forward' };
  switch (k.key) {
    case ' ':
    case 'Enter':
      return side === 'question' ? { kind: 'showAnswer' } : { kind: 'answer', rating: 3 };
    case '1':
    case '2':
    case '3':
    case '4':
      return side === 'answer' ? { kind: 'answer', rating: Number(k.key) as Rating } : null;
    case 'e':
    case 'E':
      return { kind: 'edit' };
    case '*':
      return { kind: 'mark' };
    case '-':
      return { kind: 'bury' };
    case '=':
      return { kind: 'buryNote' };
    case '@':
      return { kind: 'suspend' };
    case '!':
      return { kind: 'suspendNote' };
    case 'r':
    case 'R':
    case 'F5':
      return { kind: 'replay' };
    case '?':
      return { kind: 'forward' };
    default:
      return null;
  }
}

/** Re-dispatches a key from the card frame on the app window, so the shell's shortcuts (Alt+1/2/3, ?…) work there too. */
export function forwardKey(k: KeyLike, target: Pick<Window, 'dispatchEvent'> = window): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: k.key,
      code: k.code ?? '',
      ctrlKey: k.ctrl,
      shiftKey: k.shift,
      altKey: k.alt,
      metaKey: k.meta,
      bubbles: true,
      cancelable: true,
    }),
  );
}
