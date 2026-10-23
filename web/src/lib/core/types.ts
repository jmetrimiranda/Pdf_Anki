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

// ---------------------------------------------------------------- library (spec 6.6, 14)

export type BookFormat = 'pdf' | 'epub';
export type OcrStatus = 'none' | 'running' | 'done' | 'failed';

/** A library book (`core-store` `Book`, serde camelCase). Times are epoch ms, UTC. */
export interface Book {
  /** Lowercase hex sha256 of the ORIGINAL file; never changes with annotations. */
  bookUid: string;
  title: string;
  author: string | null;
  language: string;
  format: BookFormat;
  fileName: string;
  pages: number;
  hasText: boolean;
  ocrStatus: OcrStatus;
  /** sha256 of the current version of the file (with PdfCraft's annotations). */
  fileHash: string;
  /** 1 for the original, +1 per saved version. */
  fileVersion: number;
  contentDeckId: number | null;
  collectionFolder: string | null;
  addedAt: number;
  updatedAt: number;
  /** Where the current version is on this device (not synced). */
  localPath: string | null;
  localHash: string | null;
  downloaded: boolean;
}

/** Where the reader was in a book. `page` is 0-based, `progress` is 0..=1. */
export interface ReadingPosition {
  page: number;
  offset: number;
  cfi: string | null;
  progress: number;
  updatedAt: number;
}

export type LibraryEntry = Book & { position: ReadingPosition | null };

/**
 * `created`: new book; `existing`: already in the library (nothing changed); `restored`: a removed
 * book is back; `newVersion`: the file carries the `LeitorBookUid` of a library book and became its
 * current version; `otherVersion`: it carries that stamp but differs from the current version and nothing
 * changed (ask the user, then call again with `replace`; the replaced version is kept on disk).
 */
export type AddOutcome = 'created' | 'existing' | 'restored' | 'newVersion' | 'otherVersion';

export interface AddedBook {
  book: LibraryEntry;
  outcome: AddOutcome;
}

/** Partial update: a missing field is left alone; `null` clears a nullable field. */
export interface BookPatch {
  title?: string;
  author?: string | null;
  language?: string;
  contentDeckId?: number | null;
  collectionFolder?: string | null;
  /** Page count as reported by PdfCraft when it differs from the import's. */
  pages?: number;
}

/** `book_open`: the book and the page to open it at (last page read, 0-based). */
export interface BookOpenInfo {
  book: LibraryEntry;
  page: number;
}

/** `book_save_version`: `changed` is false when the bytes equal the current version. */
export interface SavedVersion {
  fileHash: string;
  fileVersion: number;
  changed: boolean;
  /** The save was based on an older version than the current one; the core kept that current version as a copy. */
  keptNewer: boolean;
}

/** Why a reading session ended (spec 6.4). */
export type StopReason = 'tab' | 'doc' | 'idle' | 'background' | 'close' | 'review';

// ---------------------------------------------------------------- dev

export interface SmokeReport {
  doc: { pageCount: number; title: string | null; author: string | null };
  /** First page as a PNG data URL (the cover the core draws). */
  page1DataUrl: string;
  words: number;
  millis: { anki: number; pdfOpen: number; pdfText: number; cover: number };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Unlisten = () => void;

/** One function per Tauri command (spec 15), plus the platform helpers the UI needs. */
export interface CoreClient {
  readonly kind: 'tauri' | 'mock';

  // Anki
  ankiDeckTree(): Promise<DeckTree>;

  // Library
  libraryList(): Promise<LibraryEntry[]>;
  libraryAdd(path: string, opts?: { replace?: boolean }): Promise<AddedBook>;
  libraryRemove(uid: string): Promise<void>;
  libraryUpdate(uid: string, patch: BookPatch): Promise<LibraryEntry>;
  bookOpen(uid: string): Promise<BookOpenInfo>;

  // Document
  /** Bytes of the current version (for `pdfcraft:open`), over raw IPC. */
  bookBytes(uid: string): Promise<ArrayBuffer>;
  /** Stores bytes from `pdfcraft:save` as a new version (raw IPC body, uid in a header). */
  /** `baseVersion`: the `fileVersion` the PdfCraft tab was opened from (see `SavedVersion.keptNewer`). */
  bookSaveVersion(uid: string, bytes: ArrayBuffer, baseVersion?: number): Promise<SavedVersion>;
  /** Copies the current version to `path` (from `pickExportPath`). */
  bookExport(uid: string, path: string): Promise<void>;
  /** Writes bytes to the path just chosen in `pickExportPath` (export of a document outside the library). */
  exportBytes(path: string, bytes: ArrayBuffer): Promise<void>;
  /** Opens the current version in the system's default PDF viewer. */
  bookOpenExternal(uid: string): Promise<void>;
  docWords(uid: string, page: number): Promise<PageWords>;

  // Reading
  positionGet(uid: string): Promise<ReadingPosition | null>;
  positionSet(uid: string, page: number, progress: number): Promise<void>;
  readingSessionStart(uid: string, page: number): Promise<void>;
  readingSessionHeartbeat(uid: string, page: number): Promise<void>;
  /** Ends `uid`'s session; a no-op when another book's session is open (a late stop). */
  readingSessionStop(uid: string | null, reason: StopReason): Promise<void>;

  // Platform
  /** Paths the app was launched with ("Abrir com"), consumed once. */
  pendingOpenPaths(): Promise<string[]>;
  devSmoke(): Promise<SmokeReport>;
  /** Forwards a UI log line to the core's log (no-op in the mock). */
  devLog(level: LogLevel, message: string): Promise<void>;
  /** Library cover (first page). `fileVersion` busts the cache when a new version is saved. */
  coverUrl(uid: string, fileVersion: number): string;
  /** Native "open files" dialog (PDF). Empty when cancelled. */
  pickBookFiles(): Promise<string[]>;
  /** Native "save as" dialog, opened by the core; the chosen path is the only one `bookExport`/`exportBytes`
   *  will write to, once. `null` when cancelled. */
  pickExportPath(defaultName: string): Promise<string | null>;
  /** Files opened with the app while it is running ("Abrir com", second instance). */
  onOpenPaths(cb: (paths: string[]) => void): Unlisten;
  /** Files dropped on the window; `onHover` reports when a drag enters/leaves it. */
  onDragDropPaths(cb: (paths: string[]) => void, onHover?: (hovering: boolean) => void): Unlisten;
  /**
   * Window close: the close is held until `handler` resolves; `true` closes the window,
   * `false` keeps it open.
   */
  onWindowCloseRequested(handler: () => Promise<boolean>): Unlisten;
}
