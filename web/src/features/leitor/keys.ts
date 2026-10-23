// App shortcuts that must also work while focus is inside the PdfCraft iframe (spec 5.1). Only these are taken;
// everything else stays PdfCraft's (it uses Ctrl+1/2/3 for zoom, Ctrl+O/S/F/P, Ctrl+Shift+N "Go to page…", Alt+N/D
// in its save prompt…). App Ctrl+1/2/3 therefore only work with focus outside the iframe; Alt+1/2/3 switch app tabs
// from anywhere, and Alt+C ("Card da seleção", free in PdfCraft) works from anywhere too, while the app's
// Ctrl+Shift+N only applies with focus outside the iframe.

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** True for the shortcuts forwarded from the iframe to the app: Alt+1/2/3, Alt+C and Ctrl+Shift+P. */
export function isForwardedShortcut(e: KeyLike): boolean {
  const digit = /^Digit[123]$/.test(e.code) || /^[123]$/.test(e.key);
  const altOnly = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  if (altOnly && digit) return true;
  if (altOnly && (e.code === 'KeyC' || e.key === 'c' || e.key === 'C')) return true;
  const p = e.code === 'KeyP' || e.key.toLowerCase() === 'p';
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && p;
}

/**
 * Listens (capture phase) on the iframe's window and re-dispatches the forwarded shortcuts on `target` (the app
 * document). Returns the detach function. Needs the iframe on the same origin.
 */
export function forwardShortcuts(frameWindow: Window, target: Document): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isForwardedShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
  };
  frameWindow.addEventListener('keydown', onKeyDown, true);
  return () => frameWindow.removeEventListener('keydown', onKeyDown, true);
}
