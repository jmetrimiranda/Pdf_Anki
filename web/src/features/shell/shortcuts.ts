import type { MessageKey } from '../../i18n';

/** Spec 5.1 shortcuts, shown by the "?" dialog. `ready` marks the ones wired in this phase. */
export const SHORTCUTS: { keys: string[]; label: MessageKey; ready: boolean }[] = [
  { keys: ['Ctrl', 'O'], label: 'shortcuts.open', ready: true },
  { keys: ['Ctrl', 'W'], label: 'shortcuts.closeTab', ready: true },
  { keys: ['Ctrl', 'Tab'], label: 'shortcuts.nextTab', ready: true },
  { keys: ['Ctrl', 'Shift', 'Tab'], label: 'shortcuts.prevTab', ready: true },
  { keys: ['Ctrl', 'F'], label: 'shortcuts.search', ready: true },
  { keys: ['←', '→'], label: 'shortcuts.page', ready: true },
  { keys: ['+', '−'], label: 'shortcuts.zoom', ready: true },
  { keys: ['Ctrl', 'Shift', 'A'], label: 'shortcuts.anki', ready: true },
  { keys: ['Ctrl', 'Shift', 'N'], label: 'shortcuts.cardFromSelection', ready: false },
  { keys: ['?'], label: 'shortcuts.help', ready: true },
];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}
