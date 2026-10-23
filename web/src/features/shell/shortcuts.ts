import type { MessageKey } from '../../i18n';

/**
 * App shortcuts of spec 5.1, shown by the "?" dialog. Each entry lists alternative key combos.
 * PdfCraft owns Ctrl+1/2/3 (zoom) while it has focus, so the tab switch also answers to Alt+1/2/3,
 * which the reader forwards from inside the iframe.
 */
export const SHORTCUTS: { combos: string[][]; label: MessageKey; ready: boolean }[] = [
  {
    combos: [
      ['Ctrl', '1'],
      ['Alt', '1'],
    ],
    label: 'shortcuts.library',
    ready: true,
  },
  {
    combos: [
      ['Ctrl', '2'],
      ['Alt', '2'],
    ],
    label: 'shortcuts.reader',
    ready: true,
  },
  {
    combos: [
      ['Ctrl', '3'],
      ['Alt', '3'],
    ],
    label: 'shortcuts.anki',
    ready: true,
  },
  { combos: [['Ctrl', 'Shift', 'P']], label: 'shortcuts.panel', ready: true },
  { combos: [['Ctrl', 'O']], label: 'shortcuts.add', ready: true },
  { combos: [['Ctrl', 'Shift', 'N']], label: 'shortcuts.cardFromSelection', ready: false },
  { combos: [['?']], label: 'shortcuts.help', ready: true },
];

/** Study screen keys (spec 8.2, like Anki desktop), shown under "Anki · Estudar" in the "?" dialog. */
export const STUDY_SHORTCUTS: { combos: string[][]; label: MessageKey }[] = [
  { combos: [['Espaço'], ['Enter']], label: 'anki.shortcuts.showAnswer' },
  { combos: [['1–4']], label: 'anki.shortcuts.answer' },
  { combos: [['E']], label: 'anki.shortcuts.edit' },
  { combos: [['Ctrl', 'Z']], label: 'anki.shortcuts.undo' },
  { combos: [['*']], label: 'anki.shortcuts.mark' },
  { combos: [['-']], label: 'anki.shortcuts.bury' },
  { combos: [['@']], label: 'anki.shortcuts.suspend' },
  { combos: [['R']], label: 'anki.shortcuts.replay' },
];

/** The embedded PdfCraft (LeitorHost's iframe): while it has focus its own shortcuts win. */
export function isPdfcraftFrame(el: Element | null): boolean {
  return el?.tagName === 'IFRAME' && el.getAttribute('title') === 'PdfCraft';
}

export const TAB_PATHS = ['/biblioteca', '/leitor', '/anki'] as const;
export type TabPath = (typeof TAB_PATHS)[number];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** 1, 2 or 3 from the physical digit key (layout independent), else from the produced character. */
function tabDigit(e: KeyboardEvent): 1 | 2 | 3 | null {
  const fromCode = /^(?:Digit|Numpad)([1-3])$/.exec(e.code)?.[1];
  const d = fromCode ?? (/^[1-3]$/.test(e.key) ? e.key : undefined);
  return d ? (Number(d) as 1 | 2 | 3) : null;
}

export type ShellAction =
  { kind: 'tab'; to: TabPath } | { kind: 'togglePanel' } | { kind: 'addBooks' } | { kind: 'help' };

/**
 * Maps a keydown on the app document to a shell action. Never claims a key PdfCraft uses while it
 * has focus: when the PdfCraft iframe is the active element, only Alt+1/2/3 and Ctrl+Shift+P apply (those
 * also arrive re-dispatched by the reader from inside the iframe).
 */
export function shellActionFor(
  e: KeyboardEvent,
  activeElement: Element | null = document.activeElement,
): ShellAction | null {
  const ctrl = e.ctrlKey || e.metaKey;
  // Only the PdfCraft frame owns keys; other frames (the card, Anki pages) forward theirs or keep them inside.
  const iframeFocused = isPdfcraftFrame(activeElement);
  const digit = tabDigit(e);
  if (digit && e.altKey && !ctrl && !e.shiftKey) return { kind: 'tab', to: TAB_PATHS[digit - 1]! };
  if (digit && ctrl && !e.altKey && !e.shiftKey) {
    return iframeFocused ? null : { kind: 'tab', to: TAB_PATHS[digit - 1]! };
  }
  const key = e.key.toLowerCase();
  if (ctrl && e.shiftKey && !e.altKey && (key === 'p' || e.code === 'KeyP')) return { kind: 'togglePanel' };
  if (iframeFocused) return null;
  if (ctrl && !e.shiftKey && !e.altKey && key === 'o') return { kind: 'addBooks' };
  if (e.key === '?' && !ctrl && !e.altKey && !isTypingTarget(e.target)) return { kind: 'help' };
  return null;
}
