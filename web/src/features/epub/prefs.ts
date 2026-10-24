// Reading preferences of the EPUB reader (spec 7.1: themes and letter size), kept in localStorage
// `leitor.epub.prefs` for every book, and the CSS they turn into inside the section documents (renderer.setStyles).
import { useSyncExternalStore } from 'react';
import { getTheme } from '../../lib/theme';

export type EpubTheme = 'light' | 'sepia' | 'dark';
export type LineHeight = 'compact' | 'normal' | 'relaxed';

export interface EpubPrefs {
  theme: EpubTheme;
  /** Letter size in percent, 80–200 in steps of 10. */
  fontSize: number;
  lineHeight: LineHeight;
}

export const PREFS_KEY = 'leitor.epub.prefs';
export const FONT_MIN = 80;
export const FONT_MAX = 200;
export const FONT_STEP = 10;

/** Page background and text of each theme (spec 7.1; Sépia like the app's reading tokens). */
export const THEME_COLORS: Record<EpubTheme, { bg: string; fg: string; link: string }> = {
  light: { bg: '#ffffff', fg: '#1f1f1f', link: '#2a7ae2' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#2f5f9e' },
  dark: { bg: '#1e1e1e', fg: '#d6d6d6', link: '#8ab4f8' },
};

export const LINE_HEIGHTS: Record<LineHeight, number> = { compact: 1.3, normal: 1.5, relaxed: 1.8 };

function defaultPrefs(): EpubPrefs {
  let theme: EpubTheme = 'light';
  try {
    theme = getTheme() === 'dark' ? 'dark' : 'light';
  } catch {
    // No document (tests): light.
  }
  return { theme, fontSize: 100, lineHeight: 'normal' };
}

export function clampFont(n: number): number {
  if (!Number.isFinite(n)) return 100;
  const stepped = Math.round(n / FONT_STEP) * FONT_STEP;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, stepped));
}

/** Parses stored prefs; anything missing or invalid falls back to the default. */
export function parsePrefs(raw: string | null): EpubPrefs {
  const base = defaultPrefs();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof EpubPrefs, unknown>>;
    return {
      theme: v.theme === 'light' || v.theme === 'sepia' || v.theme === 'dark' ? v.theme : base.theme,
      fontSize: typeof v.fontSize === 'number' ? clampFont(v.fontSize) : base.fontSize,
      lineHeight:
        v.lineHeight === 'compact' || v.lineHeight === 'normal' || v.lineHeight === 'relaxed'
          ? v.lineHeight
          : base.lineHeight,
    };
  } catch {
    return base;
  }
}

let current: EpubPrefs | null = null;
const listeners = new Set<() => void>();

export function getPrefs(): EpubPrefs {
  if (!current) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(PREFS_KEY);
    } catch {
      raw = null;
    }
    current = parsePrefs(raw);
  }
  return current;
}

export function setPrefs(patch: Partial<EpubPrefs>): EpubPrefs {
  const next: EpubPrefs = { ...getPrefs(), ...patch };
  next.fontSize = clampFont(next.fontSize);
  current = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Not persisted (private mode); still applies to this session.
  }
  for (const l of listeners) l();
  return next;
}

/** Forgets the cached prefs (tests). */
export function resetPrefsCache(): void {
  current = null;
  for (const l of listeners) l();
}

export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useEpubPrefs(): EpubPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

/** The EPUB page theme, so the book panel can match its neutral tones (spec 4). */
export function useEpubTheme(): EpubTheme {
  return useEpubPrefs().theme;
}

/**
 * The CSS injected into every section document. Background and text follow the theme; the book's own colours are
 * kept on the light pages, while the dark page forces readable text (links keep their colour unless unreadable,
 * see `fixLinkContrast`). Letter size scales the root; line spacing applies to running text.
 */
export function readerCss(p: EpubPrefs): string {
  const c = THEME_COLORS[p.theme];
  const lh = LINE_HEIGHTS[p.lineHeight];
  const dark = p.theme === 'dark';
  return `@namespace epub "http://www.idpf.org/2007/ops";
html { color-scheme: ${dark ? 'dark' : 'light'}; font-size: ${p.fontSize}% !important; }
html, body { background: ${c.bg} !important; color: ${c.fg} !important; }
body { font-size: 1rem !important; }
p, li, blockquote, dd, dt, div, td, th, figcaption { line-height: ${lh} !important; }
${dark ? `body :not(a):not(a *):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; }` : ''}
img, svg, video { max-width: 100%; }
pre { white-space: pre-wrap !important; }
::selection { background: ${dark ? 'rgba(110, 168, 255, 0.4)' : 'rgba(42, 122, 226, 0.28)'}; }
aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="rearnote"] { display: none; }
`;
}

function luminance(rgb: [number, number, number]): number {
  const lin = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function parseColor(css: string): [number, number, number] | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (h) {
    const n = parseInt(h[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

/** WCAG contrast ratio of two CSS colours (`rgb(…)` or `#rrggbb`); 21 when one can't be parsed. */
export function contrast(a: string, b: string): number {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return 21;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Links keep the book's colour unless it is unreadable on the page (contrast < 3): then the theme's link colour. */
export function fixLinkContrast(doc: Document, theme: EpubTheme): number {
  const view = doc.defaultView;
  if (!view) return 0;
  const { bg, link } = THEME_COLORS[theme];
  let fixed = 0;
  const links = Array.from(doc.querySelectorAll('a[href]')).slice(0, 2000) as HTMLElement[];
  for (const a of links) {
    a.style.removeProperty('color');
    if (contrast(view.getComputedStyle(a).color, bg) < 3) {
      a.style.setProperty('color', link, 'important');
      fixed++;
    }
  }
  return fixed;
}
