// Keys inside the EPUB reader (spec 5.1, 7.1). The reader turns pages with ←/→, PageUp/PageDown and Space
// (Shift+Space back); the app shortcuts pressed inside a section iframe are handed to the app (`onKey`). Unlike
// PdfCraft, the EPUB reader owns no Ctrl shortcuts, so the app's Ctrl+1/2/3, Ctrl+Shift+N and Ctrl+Shift+P work here.
import type { KeyLike } from '../leitor/keys';

export type PageKeyAction = 'left' | 'right' | 'next' | 'prev';

function isEditable(target: EventTarget | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** The page turn a key asks for, or null (modifiers, typing in a field, other keys). */
export function pageKeyAction(e: KeyLike & { target?: EventTarget | null }): PageKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.target && isEditable(e.target)) return null;
  switch (e.key) {
    case 'ArrowLeft':
      return e.shiftKey ? null : 'left';
    case 'ArrowRight':
      return e.shiftKey ? null : 'right';
    case 'PageUp':
      return 'prev';
    case 'PageDown':
      return 'next';
    case ' ':
    case 'Spacebar':
      return e.shiftKey ? 'prev' : 'next';
    default:
      return null;
  }
}

/** App shortcuts (spec 5.1) pressed inside the book: Ctrl/⌘+1/2/3, Alt+1/2/3, Ctrl+Shift+N, Alt+C, Ctrl+Shift+P, `?`. */
export function isAppShortcut(e: KeyLike): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const digit = /^Digit[123]$/.test(e.code) || /^[123]$/.test(e.key);
  if (mod && !e.shiftKey && !e.altKey && digit) return true;
  if (e.altKey && !mod && !e.shiftKey && digit) return true;
  const letter = (k: string) => e.code === `Key${k}` || e.key.toLowerCase() === k.toLowerCase();
  if (mod && e.shiftKey && !e.altKey && (letter('N') || letter('P'))) return true;
  if (e.altKey && !mod && !e.shiftKey && letter('C')) return true;
  return e.key === '?' && !mod && !e.altKey;
}
