// Public contract of the EPUB reader (W2 mounts it in the Leitor tab; docs/tecnico/foliate.md).
import type { EpubVocabWord } from './vocab';

export type { EpubVocabWord } from './vocab';
export type { EpubTheme } from './prefs';

export interface EpubOpenOptions {
  uid: string;
  bytes: Uint8Array;
  title: string;
  cfi?: string | null;
  section?: number | null;
  find?: string | null;
}

export interface EpubLocation {
  uid: string;
  section: number;
  sectionCount: number;
  cfi: string;
  /** 0..1 in the whole book. */
  fraction: number;
  tocLabel: string | null;
}

export interface EpubSelection {
  uid: string;
  section: number;
  cfi: string;
  text: string;
  /** [left, top, width, height] in CSS px relative to the reader host element. */
  rect: [number, number, number, number];
}

export interface EpubReaderEvents {
  /** Debounced: at most 1 per 250 ms (and flushed by `close`). */
  onLocation(l: EpubLocation): void;
  /** Pointer/wheel/keys/touch in the book, at most 1 per 10 s (same rule as pdfcraft:activity). */
  onActivity(uid: string): void;
  /** 300 ms debounce, like PdfCraft. */
  onSelection(s: EpubSelection | null): void;
  /** From the selection toolbar. */
  onMenu(key: 'card' | 'ai' | 'define', s: EpubSelection): void;
  onVocabClick(e: {
    uid: string;
    section: number;
    form: string;
    lemma: string;
    rect: [number, number, number, number];
  }): void;
  /** A section was laid out (the vocabulary loads its marks). */
  onSectionShown(uid: string, section: number): void;
  /** keydown of an app shortcut inside the book iframes (Ctrl+1/2/3, Alt+1/2/3, Ctrl+Shift+N, Ctrl+Shift+P, Alt+C, ?). */
  onKey(e: KeyboardEvent): void;
  onError(message: string): void;
}

export interface EpubReaderHandle {
  /** Throws on an unreadable book. */
  open(o: EpubOpenOptions): Promise<{ sectionCount: number }>;
  goTo(t: { cfi?: string | null; section?: number | null; find?: string | null }): Promise<{ found: boolean | null }>;
  /** Flushes the pending onLocation. */
  close(): void;
  currentLocation(): EpubLocation | null;
  selectionNow(): EpubSelection | null;
  setVocabMarks(section: number, words: EpubVocabWord[] | null): void;
  clearVocabMarks(): void;
  openDrawer(kind: 'toc' | 'annotations' | 'search' | null): void;
  readonly theme: 'light' | 'sepia' | 'dark';
}

export type DrawerKind = 'toc' | 'annotations' | 'search';
