// Mirrors the Rust core's serde (camelCase) types. Keep in sync with src-tauri.

/** [x, y, w, h] in points, page view space (origin top-left, y down, rotation and crop applied). */
export type Rect = [number, number, number, number];

export interface DeckNode {
  id: number;
  name: string;
  fullName: string;
  level: number;
  newCount: number;
  learnCount: number;
  reviewCount: number;
  collapsed: boolean;
  children: DeckNode[];
}

export interface StudiedToday {
  cards: number;
  seconds: number;
}

export interface DeckTree {
  decks: DeckNode[];
  studiedToday: StudiedToday;
}

export interface PageSize {
  width: number;
  height: number;
}

export interface DocInfo {
  docId: string;
  pageCount: number;
  pages: PageSize[];
  title: string | null;
  author: string | null;
}

export interface OutlineItem {
  title: string;
  /** 0-based page index, or null when the destination could not be resolved. */
  page: number | null;
  children: OutlineItem[];
}

export interface PageWord {
  /** Word number on the page. */
  index: number;
  text: string;
  /** Offsets in the page text in UTF-16 code units (`text.slice(start, end)` is the word), end exclusive. */
  start: number;
  end: number;
  rects: Rect[];
}

export interface PageWords {
  page: number;
  width: number;
  height: number;
  text: string;
  words: PageWord[];
}

export interface SearchHit {
  page: number;
  rects: Rect[];
  context: string;
}

export interface SmokeReport {
  collectionPath: string;
  deckTree: DeckTree;
  doc: DocInfo;
  page1Url: string;
  words: number;
  millis: { anki: number; pdfOpen: number; pdfText: number };
}

/** Error payload of every command: `{ code, message }` with a pt-BR message. */
export interface CoreErrorPayload {
  code: string;
  message: string;
}

export class CoreError extends Error implements CoreErrorPayload {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

export interface PageImageOptions {
  /** Output pixels per point. */
  scale: number;
  theme?: 'claro' | 'sepia' | 'escuro';
  /** Low-detail render for thumbnails (spec 6.2: `preview: true`). */
  preview?: boolean;
}

/** One function per Tauri command (Phase 0 subset, spec 15), plus the page image URL builder. */
export interface CoreClient {
  readonly kind: 'tauri' | 'mock';
  ankiDeckTree(): Promise<DeckTree>;
  docOpenPath(path: string): Promise<DocInfo>;
  docInfo(docId: string): Promise<DocInfo>;
  docOutline(docId: string): Promise<OutlineItem[]>;
  docWords(docId: string, page: number): Promise<PageWords>;
  docSearch(docId: string, q: string): Promise<SearchHit[]>;
  docClose(docId: string): Promise<void>;
  devSmoke(): Promise<SmokeReport>;
  /** URL of a rendered page (0-based). Always goes through `protocolUrl` in Tauri. */
  pageImageUrl(docId: string, page: number, opts: PageImageOptions): string;
}
