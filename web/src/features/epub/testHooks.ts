// `window.__epubReader` (development and mock builds only): what the e2e tests wait on and drive, since foliate
// renders inside closed shadow roots. Never installed in the production build.
import { devRoutesEnabled } from '../shell/devRoutes';
import type { EpubSession } from './session';

export interface OverlayInfo {
  kind: string;
  color: string | null;
  id: string | null;
  rects: number;
}

export interface EpubTestHooks {
  session: EpubSession;
  /** The documents of the sections on screen. */
  docs(): Document[];
  /** The marks drawn on the current section (annotations and vocabulary). */
  overlays(): OverlayInfo[];
  /** Text of the visible page(s). */
  visibleText(): string;
  /** Selects the first occurrence of `text` in the visible section; returns false when absent. */
  selectText(text: string): boolean;
  /** The host-relative rect of the first occurrence of `text` (to click it with the mouse). */
  rectOf(text: string): [number, number, number, number] | null;
}

declare global {
  interface Window {
    __epubReader?: EpubTestHooks;
  }
}

function findText(doc: Document, text: string): Range | null {
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = (n.nodeValue ?? '').indexOf(text);
    if (i >= 0) {
      const r = doc.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + text.length);
      return r;
    }
  }
  return null;
}

export function installEpubTestHooks(session: EpubSession): () => void {
  if (!devRoutesEnabled || typeof window === 'undefined') return () => {};
  const contents = () => session.foliateView?.renderer?.getContents?.() ?? [];
  const hooks: EpubTestHooks = {
    session,
    docs: () => contents().map((c) => c.doc),
    overlays: () =>
      contents().flatMap((c) =>
        Array.from(c.overlayer?.element.children ?? []).map((g) => ({
          kind: g.getAttribute('data-kind') ?? 'unknown',
          color: g.getAttribute('fill'),
          id: g.getAttribute('data-annotation'),
          rects: g.querySelectorAll('rect').length,
        })),
      ),
    visibleText: () => session.foliateView?.lastLocation?.range?.toString() ?? '',
    selectText: (text) => {
      for (const { doc } of contents()) {
        const r = findText(doc, text);
        if (!r) continue;
        const sel = doc.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
        return true;
      }
      return false;
    },
    rectOf: (text) => {
      for (const { doc } of contents()) {
        const r = findText(doc, text);
        if (!r) continue;
        const frame = doc.defaultView?.frameElement as HTMLElement | null;
        const host = document.querySelector('[data-testid="epub-host"]');
        if (!frame || !host) return null;
        const fr = frame.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        const b = r.getBoundingClientRect();
        return [fr.left + b.left - hr.left, fr.top + b.top - hr.top, b.width, b.height];
      }
      return null;
    },
  };
  window.__epubReader = hooks;
  return () => {
    if (window.__epubReader === hooks) delete window.__epubReader;
  };
}
