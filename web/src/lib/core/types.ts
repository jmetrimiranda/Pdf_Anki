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
  /** Filtered (dynamic) deck: no options page, cannot hold subdecks of normal decks. */
  filtered: boolean;
  /** Cards in this deck and its subdecks (used by the delete confirmation). */
  total: number;
  children: DeckNode[];
}

export interface StudiedToday {
  cards: number;
  seconds: number;
}

export interface DeckTree {
  decks: DeckNode[];
  studiedToday: StudiedToday;
  /** The collection's current deck (Anki's `curDeck`). */
  currentDeckId: number;
}

export interface DeckName {
  id: number;
  /** Full name with `::` separators. */
  name: string;
  filtered: boolean;
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

// ---------------------------------------------------------------- Anki (spec 8, 15)

/** `anki_prepare_collection`: app notetypes created now / already there (names). */
export interface PrepareReport {
  created: string[];
  existing: string[];
}

export interface ImportSummary {
  added: number;
  updated: number;
  duplicates: number;
  conflicts: number;
  skipped: number;
}

export interface ExportOptions {
  withScheduling: boolean;
  withMedia: boolean;
}

export interface ExportResult {
  notes: number;
}

/** `preSync`: made before a full sync (either direction, spec 8.1/9). */
export type BackupKind = 'daily' | 'preImport' | 'manual' | 'preSync';

export interface BackupInfo {
  path: string;
  fileName: string;
  kind: BackupKind;
  /** Epoch ms. */
  createdAt: number;
  /** Bytes. */
  size: number;
}

export interface QueueCounts {
  new: number;
  learn: number;
  review: number;
}

export type AvTag =
  { kind: 'sound'; file: string } | { kind: 'tts'; text: string; lang: string; voices: string[]; speed: number };

/** A `leitor://livro/<uid>?pagina=N&q=…` link found in the note's Fonte field. */
export interface SourceLink {
  bookUid: string;
  /** 1-based, as in the link. */
  page: number;
  query: string | null;
  label: string;
}

export type StudyQueue = 'new' | 'learn' | 'review';

export interface StudyCard {
  cardId: number;
  noteId: number;
  deckId: number;
  deckName: string;
  questionHtml: string;
  answerPreloadHtml: string;
  bodyClass: string;
  questionAv: AvTag[];
  answerAv: AvTag[];
  autoplay: boolean;
  replayQuestionOnAnswer: boolean;
  queue: StudyQueue;
  counts: QueueCounts;
  showCounts: boolean;
  /** Labels of Again/Hard/Good/Easy with the next intervals (as in Anki desktop). */
  buttons: [string, string, string, string];
  showIntervals: boolean;
  flag: number;
  marked: boolean;
  typeAnswer: boolean;
  stateMutation: { key: string; js: string } | null;
  source: SourceLink | null;
  canUndo: boolean;
  showTimer: boolean;
  timerMaxSecs: number;
}

export type StudyNext =
  | { kind: 'card'; card: StudyCard }
  | { kind: 'done'; deckId: number; deckName: string; counts: QueueCounts; canUndo: boolean };

export interface AnswerSide {
  html: string;
  av: AvTag[];
  /** Interval labels of the four answer buttons, from the card's current (possibly mutated) scheduling states. */
  buttons: [string, string, string, string];
}

export type CardAction = 'bury' | 'buryNote' | 'suspend' | 'suspendNote' | 'flag' | 'mark';

export interface CardActionResult {
  flag: number;
  marked: boolean;
  next: StudyNext | null;
}

export interface FieldInfo {
  name: string;
  fontName: string;
  fontSize: number;
  rtl: boolean;
  plainText: boolean;
}

export interface NotetypeInfo {
  id: number;
  name: string;
  kind: 'normal' | 'cloze';
  fields: FieldInfo[];
  templates: string[];
  /** The app's own type (`Básico (Leitor)`, `Código · Comando`…), or null for the user's/stock types. */
  appType: string | null;
  noteCount: number;
}

export interface AddDefaults {
  notetypeId: number;
  deckId: number;
}

export interface NoteData {
  id: number;
  notetypeId: number;
  fields: string[];
  tags: string[];
  cardIds: number[];
  deckId: number;
  mtime: number;
}

export type NoteCheck = 'normal' | 'empty' | 'duplicate' | 'missingCloze' | 'notetypeNotCloze' | 'fieldNotCloze';

export interface NewNote {
  notetypeId: number;
  deckId: number;
  fields: string[];
  tags: string[];
}

export interface NoteAdded {
  noteId: number;
  cardCount: number;
}

export type BrowseColumn =
  'sortField' | 'template' | 'deck' | 'cardDue' | 'cardIvl' | 'cardEase' | 'noteCrt' | 'noteMod';

export interface BrowseOrder {
  column: BrowseColumn;
  reverse: boolean;
}

export interface BrowseRow {
  cardId: number;
  noteId: number;
  sortField: string;
  template: string;
  deck: string;
  due: string;
  flag: number;
  marked: boolean;
  suspended: boolean;
  buried: boolean;
}

export interface ForgetOptions {
  restorePosition: boolean;
  resetCounts: boolean;
}

/** Payload of the `anki://changed` event: the collection changed outside the UI's own calls. */
export interface AnkiChanged {
  /** `sync`: a normal sync merged changes; `syncFull`: a full sync replaced the collection (study sessions reset). */
  reason: 'import' | 'colpkg' | 'page' | 'backup' | 'sync' | 'syncFull';
}

/** Payload of the `anki://page` event (core `BridgeEvent`, serde tag `kind`). */
export type AnkiPageEvent =
  | { kind: 'close' }
  | { kind: 'ready' }
  | { kind: 'importDone' }
  | { kind: 'searchInBrowser'; search: string }
  | { kind: 'changed' }
  | { kind: 'openLink'; url: string }
  | { kind: 'error'; message: string };

/** File type of the "save as" dialog opened by `pickExportPath`. */
export type ExportKind = 'pdf' | 'apkg';

// ---------------------------------------------------------------- Book panel (spec 10, 12.7)

/** Who studies: the Anki tab or the book panel's mini-review ("Revisar aqui"). Only one at a time (spec 10.1). */
export type StudyOwner = 'tab' | 'panel';

/** Payload of the `anki://study-owner` event: the study session changed hands. */
export interface StudyOwnerChange {
  /** Who studies now (`null`: nobody). */
  owner: StudyOwner | null;
  /** The owner whose open session was just taken over (show a notice there), or `null`. */
  preempted: StudyOwner | null;
}

export interface MiniReviewOpened {
  /** The collection's current deck before the mini-review switched it (restored on close). */
  previousDeckId: number;
  preempted: StudyOwner | null;
  next: StudyNext;
}

export interface MiniReviewClosed {
  /** The deck restored as current, or `null` when nothing was restored (e.g. the Anki tab took over). */
  restoredDeckId: number | null;
}

/** Card types of "＋ Card da seleção" (spec 10.2). */
export type BookCardKind = 'basic' | 'cloze' | 'codeCommand' | 'codeProgram' | 'vocab';

export interface BookDeckInfo {
  role: 'vocab' | 'content';
  /** `null` when the deck does not exist (yet). */
  deckId: number | null;
  /** Full name with `::`. */
  name: string;
  exists: boolean;
  counts: QueueCounts | null;
}

export interface BookPanelInfo {
  bookUid: string;
  title: string;
  /** The vocabulary folder (setting `vocab_root_deck_id`), when chosen and still there. */
  vocabRootDeckId: number | null;
  vocabRootName: string | null;
  /** `<vocab root>::Livros::<Título>`, or `Livros::<Título>` while no vocabulary folder is chosen. */
  vocabDeck: BookDeckInfo;
  /** The book's content deck (`book.content_deck_id`), `null` when not set. */
  contentDeck: BookDeckInfo | null;
  /** Deck last used to add a card from this book (`null` when unset or deleted). */
  lastDeckId: number | null;
  lastKind: BookCardKind | null;
  /** Deck last reviewed with "Revisar aqui" (`null` when unset or deleted). */
  reviewDeckId: number | null;
}

/** Fields absent = unchanged; `null` = clear. */
export interface BookPanelPatch {
  contentDeckId?: number | null;
  lastDeckId?: number | null;
  lastKind?: BookCardKind | null;
  reviewDeckId?: number | null;
}

/** A note whose Fonte links to this book ("Cards desta página"). */
export interface BookCard {
  noteId: number;
  cardIds: number[];
  deckId: number;
  notetype: string;
  /** 1-based, as in the link. */
  page: number;
  query: string | null;
  /** Plain text of the first field (short). */
  preview: string;
}

/** "Definir palavra" (spec 12.7): the lemma and, when a note exists in the vocabulary folder, its definition. */
export interface WordDefinition {
  word: string;
  lemma: string;
  vocabRootDeckId: number | null;
  vocabRootName: string | null;
  note: { noteId: number; deckName: string; notetype: string; definition: string | null; preview: string } | null;
}

/** A parsed `leitor://livro/<uid>?pagina=N&q=…` link opened by the system (spec 10.2). */
export interface DeepLink {
  bookUid: string;
  /** 1-based. */
  page: number;
  query: string | null;
}

// ---------------------------------------------------------------- Anki sync (spec 9)

/**
 * `off`: not logged in; `idle`: logged in, nothing running; `offline`: the last attempt found no network (the core
 * retries at `nextRetryAt` and when the network returns); `error`: the last attempt failed (`lastError`);
 * `fullSyncRequired`: waits for the user's choice in the full sync dialog (`fullSync`), no automatic attempts.
 */
export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'fullSyncRequired';

export interface SyncErrorInfo {
  code: string;
  /** pt-BR. */
  message: string;
}

/** Which directions a required full sync allows (`uploadOk` false: this device's collection is empty). */
export interface FullSyncChoice {
  uploadOk: boolean;
  downloadOk: boolean;
}

/** `anki_sync_status` and the `anki://sync` event. The password and the key never leave the core. */
export interface AnkiSyncStatus {
  state: SyncState;
  /** Server address (settings), kept after logout. */
  url: string | null;
  user: string | null;
  loggedIn: boolean;
  /** SHA-256 of the extra root certificate trusted for the server, when one is set. */
  certificateFingerprint: string | null;
  /** The first sync of this account has not happened yet (it always downloads). */
  firstSyncPending: boolean;
  /** Epoch ms of the last successful sync. */
  lastSyncAt: number | null;
  lastError: SyncErrorInfo | null;
  fullSync: FullSyncChoice | null;
  /** Epoch ms of the next automatic attempt after a failure. */
  nextRetryAt: number | null;
  mediaSyncing: boolean;
  /** pt-BR; media errors never fail the collection sync. */
  mediaError: string | null;
  /** Message from the server (shown as is). */
  serverMessage: string | null;
}

export type FullSyncDirection = 'download' | 'upload';

export interface FullSyncResult {
  status: AnkiSyncStatus;
  /** The backup made before the full sync. */
  backup: BackupInfo;
}

/** What the UI tells the core's sync scheduler (the timers live in the core). */
export type SyncNotifyEvent = 'tabEntered' | 'online' | 'offline' | 'visible';

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

  // Anki · decks and collection
  ankiDeckTree(): Promise<DeckTree>;
  ankiDeckNames(): Promise<DeckName[]>;
  /** Creates a deck (full name with `::`) and returns its id. */
  ankiDeckCreate(name: string): Promise<number>;
  ankiDeckRename(deckId: number, name: string): Promise<void>;
  /** Moves decks under `parentId` (`null` = top level). */
  ankiDeckMove(deckIds: number[], parentId: number | null): Promise<void>;
  ankiDeckDelete(deckId: number): Promise<{ cardsDeleted: number }>;
  ankiDeckSetCollapsed(deckId: number, collapsed: boolean): Promise<void>;
  ankiSetCurrentDeck(deckId: number): Promise<void>;
  /** "Preparar coleção": creates the app notetypes that are missing (idempotent). */
  ankiPrepareCollection(): Promise<PrepareReport>;

  // Anki · study
  /** `owner` defaults to `'tab'`; starting in one place preempts the other's session (`anki://study-owner`). */
  ankiStudyNext(deckId: number, owner?: StudyOwner): Promise<StudyNext>;
  ankiShowAnswer(cardId: number, typed: string | null): Promise<AnswerSide>;
  /** `rating`: 1 Again, 2 Hard, 3 Good, 4 Easy; `ms`: time on the card. */
  ankiAnswer(cardId: number, rating: number, ms: number): Promise<StudyNext>;
  ankiUndo(): Promise<StudyNext>;
  ankiCardAction(cardId: number, action: CardAction, flag?: number): Promise<CardActionResult>;
  /** Closes `owner`'s session only (default `'tab'`); a no-op when the other owner studies. */
  ankiStudyClose(owner?: StudyOwner): Promise<void>;
  /** "Revisar aqui": remembers the current deck, switches to `deckId` and studies it as the panel. */
  ankiMiniReviewOpen(deckId: number): Promise<MiniReviewOpened>;
  /** Closes the mini-review and restores the previous deck (unless the Anki tab took over). */
  ankiMiniReviewClose(): Promise<MiniReviewClosed>;
  /** `anki://study-owner`. */
  onStudyOwner(cb: (c: StudyOwnerChange) => void): Unlisten;

  // Book panel (spec 10, 12.7)
  bookPanelInfo(uid: string): Promise<BookPanelInfo>;
  bookPanelSet(uid: string, patch: BookPanelPatch): Promise<BookPanelInfo>;
  /** Notes whose Fonte links to this book. */
  ankiBookCards(uid: string): Promise<BookCard[]>;
  /** One word only (`invalid_input` otherwise). `bookUid` is context for later phases. */
  vocabDefine(word: string, bookUid: string | null): Promise<WordDefinition>;

  // Anki · notes
  ankiNotetypes(): Promise<NotetypeInfo[]>;
  ankiAddDefaults(deckId: number | null): Promise<AddDefaults>;
  ankiNoteGet(noteId: number): Promise<NoteData>;
  ankiNoteCheck(notetypeId: number, fields: string[]): Promise<NoteCheck>;
  ankiNoteAdd(note: NewNote): Promise<NoteAdded>;
  ankiNoteUpdate(noteId: number, fields: string[], tags: string[]): Promise<void>;
  /** Adds a file to the collection's media folder (raw IPC body); returns the stored file name. */
  ankiMediaAdd(name: string, bytes: ArrayBuffer | Uint8Array): Promise<string>;
  ankiTagsAll(): Promise<string[]>;

  // Anki · browse
  /** Card ids matching an Anki search. */
  ankiSearch(query: string, order: BrowseOrder | null): Promise<number[]>;
  /** Table rows (at most 500 ids per call). */
  ankiBrowseRows(cardIds: number[]): Promise<BrowseRow[]>;
  ankiCardsSetDeck(cardIds: number[], deckId: number): Promise<number>;
  ankiNotesTags(noteIds: number[], add: string, remove: string): Promise<void>;
  ankiCardsSuspend(cardIds: number[], suspended: boolean): Promise<void>;
  ankiCardsForget(cardIds: number[], opts: ForgetOptions): Promise<void>;
  ankiNotesDelete(noteIds: number[]): Promise<number>;
  /** Prepares the Anki "change notetype" page for these notes. */
  ankiChangeNotetypePrepare(noteIds: number[]): Promise<{ notetypeId: number }>;

  // Anki · import/export/backups
  /** Native open dialog (.apkg/.colpkg), opened by the core; grants reading that path for 10 min. */
  ankiPickPackage(): Promise<string | null>;
  ankiImport(path: string): Promise<ImportSummary>;
  /** Replaces the whole collection (a backup is made first). */
  ankiImportColpkg(path: string): Promise<BackupInfo>;
  /** `path` must come from `pickExportPath(…, 'apkg')`. */
  ankiExport(deckId: number, path: string, opts: ExportOptions): Promise<ExportResult>;
  ankiBackupNow(): Promise<BackupInfo>;
  ankiBackups(): Promise<BackupInfo[]>;

  // Anki · web pages and card frame (spec 8.3, 8.4)
  /** URL of a reused Anki page (`deck-options/1`, `graphs`…); `night` adds `#night`. */
  ankiPageUrl(route: string, night: boolean): string;
  /** The sandboxed card frame (reviewer.html on the `card` protocol). */
  cardFrameUrl(): string;
  /** A media file of the collection, on the `card` protocol. */
  cardMediaUrl(name: string): string;
  /** `anki://changed`: the collection changed (import, page, backup…). */
  onAnkiChanged(cb: (e: AnkiChanged) => void): Unlisten;
  /** `anki://page`: events of the Anki pages (close, ready, import done…). */
  onAnkiPageEvent(cb: (e: AnkiPageEvent) => void): Unlisten;

  // Anki · sync (spec 9)
  ankiSyncStatus(): Promise<AnkiSyncStatus>;
  /**
   * Logs in (the password goes to the server once and is never stored; the key goes to the system keychain), then
   * starts the first sync (always a download). `certificatePem`: a root certificate to trust for this server
   * (`null` keeps the one already set).
   */
  ankiSyncLogin(url: string, user: string, password: string, certificatePem: string | null): Promise<AnkiSyncStatus>;
  ankiSyncLogout(): Promise<AnkiSyncStatus>;
  /** Sets (PEM) or removes (`null`) the extra root certificate trusted for the server. */
  ankiSyncSetCertificate(pem: string | null): Promise<AnkiSyncStatus>;
  /** "Sincronizar agora": a normal sync (+ media). Failures come back in the status, not as errors. */
  ankiSync(): Promise<AnkiSyncStatus>;
  /** The user's choice in the full sync dialog; a backup is made first in both directions. */
  ankiSyncFull(direction: FullSyncDirection): Promise<FullSyncResult>;
  ankiSyncNotify(event: SyncNotifyEvent): Promise<void>;
  /** `anki://sync`: the sync status changed. */
  onAnkiSync(cb: (s: AnkiSyncStatus) => void): Unlisten;

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
  /** `leitor://` links the app was launched with, consumed once. */
  pendingDeepLinks(): Promise<DeepLink[]>;
  /** `leitor://deep-link`: a `leitor://` link opened while the app runs (second instance, OS handler). */
  onDeepLink(cb: (l: DeepLink) => void): Unlisten;
  devSmoke(): Promise<SmokeReport>;
  /** Forwards a UI log line to the core's log (no-op in the mock). */
  devLog(level: LogLevel, message: string): Promise<void>;
  /** Library cover (first page). `fileVersion` busts the cache when a new version is saved. */
  coverUrl(uid: string, fileVersion: number): string;
  /** Native "open files" dialog (PDF). Empty when cancelled. */
  pickBookFiles(): Promise<string[]>;
  /** Native "save as" dialog, opened by the core; the chosen path is the only one `bookExport`/`exportBytes`
   *  will write to, once. `null` when cancelled. */
  pickExportPath(defaultName: string, kind?: ExportKind): Promise<string | null>;
  /** Native "open" dialog for one image (png/jpg/jpeg/gif/webp); the path, or `null` when cancelled. */
  pickImageFile(): Promise<string | null>;
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
