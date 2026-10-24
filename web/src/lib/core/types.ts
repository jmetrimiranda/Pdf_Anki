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

export type LibraryEntry = Book & {
  position: ReadingPosition | null;
  /** The book has a finished vocabulary scan (the menu offers "Relatório de vocabulário"). */
  vocabScanned: boolean;
};

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

/**
 * `book_open`: the book and where to open it: the last page read (0-based; for an EPUB the spine section) and, for an
 * EPUB, the last CFI read (`null` for a PDF or a book never opened).
 */
export interface BookOpenInfo {
  book: LibraryEntry;
  page: number;
  format: BookFormat;
  cfi: string | null;
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

/**
 * Where a `leitor://` link points: `page` (`?pagina=N`, a PDF page) or `chapter` (`?cap=N[&cfi=…]`, an EPUB spine
 * section).
 */
export type LinkUnit = 'page' | 'chapter';

/** A `leitor://livro/<uid>?pagina=N&q=…` (PDF) or `?cap=N&cfi=…&q=…` (EPUB) link found in the note's Fonte field. */
export interface SourceLink {
  bookUid: string;
  /** 1-based, as in the link (`pagina` or `cap`). */
  page: number;
  unit: LinkUnit;
  /** EPUB CFI of the passage (`cfi=`), `null` when absent. */
  cfi: string | null;
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
  /** Code card (spec 11.2): studied with the app's editor and checker; `null` for every other card. */
  code: CodeCard | null;
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
  /** The book's last vocabulary scan (spec 10.1 "Vocabulário 94% →"), `null` when never scanned. */
  vocab: BookPanelVocab | null;
  /** The generated per-chapter subdeck of the chapter at `page` (`…::Cap 03`), `null` when none. */
  chapterDeck: BookDeckInfo | null;
}

export interface BookPanelVocab {
  scanUid: string;
  /** 0..=1. */
  coverageKnown: number;
  coverageWithLearning: number;
  /** The scanned range's label (`Cap 3`, `p. 21-45`), `null` for the whole book. */
  rangeLabel: string | null;
  /** Epoch ms. */
  scannedAt: number;
}

/** Fields absent = unchanged; `null` = clear. */
export interface BookPanelPatch {
  contentDeckId?: number | null;
  lastDeckId?: number | null;
  lastKind?: BookCardKind | null;
  reviewDeckId?: number | null;
}

/** A note whose Fonte links to this book ("Cards desta página" / "Cards deste capítulo"). */
export interface BookCard {
  noteId: number;
  cardIds: number[];
  deckId: number;
  notetype: string;
  /** 1-based, as in the link (a page, or a chapter for `unit: 'chapter'`). */
  page: number;
  unit: LinkUnit;
  /** EPUB CFI of the passage, `null` when the link has none. */
  cfi: string | null;
  query: string | null;
  /** Plain text of the first field (short). */
  preview: string;
}

/** "Definir palavra" (spec 12.7): the lemma and, when a note exists in the vocabulary folder, its definition. */
export interface WordDefinition {
  word: string;
  lemma: string;
  /** WordNet part of speech of the lemma (`null`: not in WordNet or no data). */
  pos: VocabPos | null;
  /** Status of the lemma in the book's last scan / the vocabulary folder (`null`: unknown, no scan). */
  status: VocabStatus | null;
  /** The known lemma this word derives from (spec 12.3 I), when any. */
  family: VocabLemmaRef | null;
  /** First-sense WordNet definition (offline), when the data is installed. */
  wordnetDefinition: string | null;
  /** Where the definition shown comes from: the note in the deck, WordNet, or none. */
  definitionSource: 'note' | 'wordnet' | null;
  vocabRootDeckId: number | null;
  vocabRootName: string | null;
  note: { noteId: number; deckName: string; notetype: string; definition: string | null; preview: string } | null;
}

/** A parsed `leitor://livro/<uid>?pagina=N&q=…` (or `?cap=N&cfi=…&q=…`) link opened by the system (spec 10.2). */
export interface DeepLink {
  bookUid: string;
  /** 1-based (a page, or a chapter for `unit: 'chapter'`). */
  page: number;
  unit: LinkUnit;
  cfi: string | null;
  query: string | null;
}

// ---------------------------------------------------------------- EPUB (spec 7.1, 14, 15)

export type EpubAnnotationKind = 'highlight' | 'underline' | 'note' | 'bookmark';

/** A highlight, underline, note or bookmark of an EPUB (`epub_annotation`, CFI range). Times are epoch ms. */
export interface EpubAnnotation {
  uid: string;
  bookUid: string;
  kind: EpubAnnotationKind;
  /** EPUB CFI (a range for highlights/underlines/notes, a point for bookmarks). */
  cfi: string;
  /** 0-based spine section the CFI points into. */
  section: number;
  /** The passage (plain text), when there is one. */
  text: string | null;
  /** `#rrggbb` (PdfCraft's palette), `null` for the kind's default color. */
  color: string | null;
  comment: string | null;
  updatedAt: number;
}

/**
 * `epub_annotation_upsert`: a new annotation (`uid` absent or null: the core picks one) or a change of an existing
 * one. Only these keys (the core refuses unknown ones).
 */
export interface EpubAnnotationInput {
  uid?: string | null;
  bookUid: string;
  kind: EpubAnnotationKind;
  cfi: string;
  text?: string | null;
  color?: string | null;
  comment?: string | null;
}

/** One word form to color in the EPUB reader ("Realçar vocabulário", spec 12.7). */
export interface EpubMarkWord {
  /** Lowercase surface form as in the text (typographic apostrophes normalised to `'`). */
  form: string;
  lemma: string;
  /** `unknown`/`suspended` (coral) or `learning`/`new` (amber). */
  status: VocabStatus;
  /** `#d85a30` (unknown, suspended) or `#ba7517` (learning, new in the deck). */
  color: string;
}

/** The forms to color in one section (`vocab_epub_marks`). */
export interface EpubSectionMarks {
  /** 0-based spine section. */
  section: number;
  words: EpubMarkWord[];
}

// ---------------------------------------------------------------- OCR (spec 7.2, 6.6, 15)

/** `ocr_info`: what the library and the panel need to offer "Reconhecer texto". */
export interface OcrInfo {
  /** The book is a PDF and the OCR models are installed. */
  available: boolean;
  status: OcrStatus;
  /** `false` = "parece escaneado" (spec 6.6). */
  hasText: boolean;
  pages: number;
  /** The book's running OCR job, else its last one of this app run (if still known). */
  job: JobProgress | null;
  /** pt-BR message of the last failure, when `status` is `failed`. */
  lastError: string | null;
}

/** `ocr_start`: the job (`job://<jobId>`). */
export interface OcrStarted {
  jobId: string;
  /** The book's OCR was already running: this is its job. */
  alreadyRunning: boolean;
}

/** What an OCR job did (`JobProgress.ocr`), filled in when it ends. */
export interface OcrJobInfo {
  /** Words added to the text layer. */
  words: number;
  /** Pages recognised. */
  pagesRead: number;
  /** Pages left alone (they already had text, or could not be read). */
  pagesSkipped: number;
  /** The `fileVersion` of the new version with the text layer. */
  fileVersion: number | null;
  /** Average time per recognised page (ms). */
  msPerPage: number | null;
}

// ---------------------------------------------------------------- code cards (spec 11, 14, 15)

/** Kind of code card (spec 11.1). */
export type CodeCardRole = 'command' | 'program';

/** Raw field HTML of a code card (`''` when the type lacks the field); decode with `htmlToCode`. */
export interface CodeCardFields {
  answer: string;
  accepted: string;
  requires: string;
  notes: string;
  language: string;
  mode: string;
  initial: string;
  setup: string;
  tests: string;
  input: string;
  expectedOutput: string;
}

/**
 * What the code review needs from a code card. For code cards `StudyCard.questionHtml` is only the question field
 * (no type box) and `typeAnswer` is false.
 */
export interface CodeCard {
  role: CodeCardRole;
  notetypeId: number;
  /** One of the app's types ("Código · Comando"/"Código · Programa") rather than a mapped user type. */
  appType: boolean;
  /** The notetype has an `Aceitas` field ("Contestar" adds there; otherwise to `code_note_extra`). */
  acceptedField: boolean;
  /** The card's answer template shows the notes field (the UI then doesn't repeat it). */
  answerShowsNotes: boolean;
  /** The card's answer template prints the answer field (the UI then doesn't repeat the reference answer). */
  answerShowsAnswer: boolean;
  fields: CodeCardFields;
}

/** Fields of a user notetype with the "Comando" role (names of that notetype's fields). */
export interface CodeMappingFields {
  question: string;
  answer: string;
  notes: string | null;
}

/** Role of a mapped notetype (`notetype_mapping.role`); the UI only assigns `code_command`. */
export type CodeMappingRole = 'code_command' | 'code_program';

/** A user notetype with the "Comando" role (Configurações → Código, `code_mapping_list`). */
export interface CodeMapping {
  notetypeId: number;
  notetypeName: string;
  role: CodeMappingRole;
  fields: CodeMappingFields;
  noteCount: number;
  /** Mapped fields the notetype no longer has (its cards are then studied normally). */
  missingFields: string[];
  updatedAt: number;
}

/** Extra accepted answers / required prefixes of a note (`code_note_extra`; empty lists when none). */
export interface CodeNoteExtra {
  noteId: number;
  accepted: string[];
  requires: string[];
}

/** "Contestar" → where the answer went: the Aceitas field, `code_note_extra`, or nowhere (already accepted). */
export type CodeAcceptTarget = 'field' | 'extra' | 'already';

export interface CodeAcceptResult {
  target: CodeAcceptTarget;
  /** Every accepted answer of the note afterwards (plain text). */
  accepted: string[];
}

export interface CompileResult {
  ok: boolean;
  stderr: string;
  timeMs: number;
}

export interface RunResult {
  /** `null` when killed by a signal. */
  exitCode: number | null;
  /** `SIGKILL`, `SIGXCPU`, `SIGXFSZ`… */
  signal: string | null;
  stdout: string;
  stderr: string;
  timeMs: number;
  timedOut: boolean;
  truncated: boolean;
}

/** `code_run_cpp` (spec 11.5). */
export interface CppRunResult {
  backend: 'local' | 'remote';
  compiler: string | null;
  compile: CompileResult;
  /** `null` when the compilation failed. */
  run: RunResult | null;
}

/** `code_format_cpp`: clang-format's output (`formatter: null` = returned unchanged, no clang-format). */
export interface CppFormatResult {
  formatted: string;
  formatter: 'clang-format' | null;
}

export type CppBackendChoice = 'auto' | 'local' | 'remote';

/** What can run C++ on this device (Configurações → Código). */
export interface CodeStatus {
  cpp: {
    /** `null` on builds without local compilation (mobile). */
    local: { compiler: string | null; clangFormat: boolean } | null;
    remote: { url: string | null; tokenSet: boolean };
  };
  /** Where C++ runs now (`none`: nowhere, the cards use `estrutura`). */
  cppBackend: 'local' | 'remote' | 'none';
}

export interface CodeSettings {
  /** Suggest "Fácil" when correct in under `suggestEasySecs` seconds (off by default, spec 11.2). */
  suggestEasy: boolean;
  suggestEasySecs: number;
  /** Mode `saida`: compare exactly (default: ignore trailing whitespace). */
  outputExact: boolean;
  cppBackend: CppBackendChoice;
  runnerUrl: string | null;
  /** The runner token is in the system keychain (it never leaves the core). */
  runnerTokenSet: boolean;
}

/** Absent = unchanged; `runnerToken: null` removes the token, `runnerUrl: null` clears the URL. */
export interface CodeSettingsPatch {
  suggestEasy?: boolean;
  suggestEasySecs?: number;
  outputExact?: boolean;
  cppBackend?: CppBackendChoice;
  runnerUrl?: string | null;
  runnerToken?: string | null;
}

/** "Testar runner". */
export interface RunnerTestResult {
  ok: boolean;
  /** pt-BR. */
  message: string;
}

export type ImportItemKind = 'command' | 'program';
export type ProgramMode = 'testes' | 'saida' | 'estrutura';

/** One `###` of the Markdown import (spec 11.7). */
export interface ImportItem {
  /** 0-based position (what `include` refers to). */
  index: number;
  /** 1-based line of the heading. */
  line: number;
  title: string;
  kind: ImportItemKind | null;
  language: string | null;
  mode: ProgramMode | null;
  /** Plain text by field name (Pergunta, Resposta, Aceitas, …). */
  fields: Record<string, string>;
  tags: string[];
  /** The item cannot be added (pt-BR). */
  errors: string[];
  /** Added, but something was ignored (pt-BR). */
  warnings: string[];
}

export interface ImportPreview {
  items: ImportItem[];
  warnings: string[];
  /** The whole text was refused (no items then). */
  errors: string[];
}

export interface CodeImportResult {
  added: number;
  noteIds: number[];
  /** Items not added (errors, or not included). */
  skipped: number;
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

// ---------------------------------------------------------------- vocabulary scan (spec 12, 14, 15)

/** WordNet part of speech: noun, verb, adjective, adverb. */
export type VocabPos = 'n' | 'v' | 'a' | 'r';

/**
 * `known`: mature in the folder (or counted as known); `learning`: studied, interval under the limit; `new`: in the
 * folder, never studied; `suspended`: only suspended cards; `unknown`: not in the folder; `ignored`/`proper`: manual
 * adjustments or detected proper nouns (out of the metrics).
 */
export type VocabStatus = 'known' | 'learning' | 'new' | 'suspended' | 'unknown' | 'ignored' | 'proper';

/** Why a row has its status: a manual adjustment, the decks, a function word, a form or the family of a known word. */
export type VocabStatusSource = 'override' | 'deck' | 'function' | 'form' | 'family';

/** "Eu sei" criterion (spec 12.1 step 4). */
export interface VocabConfig {
  /** Mature = interval ≥ this many days (21, Anki's definition). */
  knownIvlDays: number;
  /** Young cards (studied, interval under the limit) count as known. */
  countYoung: boolean;
  suspendedPolicy: 'ignore' | 'known';
  /** Function words ("the", "of"…) count as known. */
  functionWordsKnown: boolean;
  /** Derivatives of known words (learner ← learn): a card (default) or known (spec 12.3 I). */
  derivedPolicy: 'card' | 'known';
}

/** The vocabulary folder and criterion saved as defaults (settings `vocab_*`). */
export interface VocabSettings {
  /** `null` until chosen (or when the deck was deleted). */
  rootDeckId: number | null;
  rootName: string | null;
  /** Subdecks left out of the folder. */
  excludedDeckIds: number[];
  config: VocabConfig;
}

/** Absent = unchanged; `rootDeckId: null` clears the folder. */
export interface VocabSettingsPatch {
  rootDeckId?: number | null;
  excludedDeckIds?: number[];
  config?: VocabConfig;
}

export interface VocabFolderDeck {
  deckId: number;
  /** Full name with `::`. */
  name: string;
  /** 0 for the root, 1 for its children… */
  depth: number;
  /** Cards and notes in this deck only (not its subdecks). */
  cardCount: number;
  noteCount: number;
}

export interface VocabFolderNotetype {
  notetypeId: number;
  name: string;
  fields: string[];
  /** Notes of this type in the folder. */
  noteCount: number;
  /** The field saved in `notetype_mapping` (role vocab), `null` when not mapped yet. */
  mappedField: string | null;
  /** By the field name (`Word`, `Palavra`, `Front`…), else the first field. */
  suggestedField: string;
  /** Up to 5 words read from the mapped (else suggested) field. */
  samples: string[];
}

/** `vocab_folder`: the chosen parent deck, every subdeck (recursively) and the notetypes found in them. */
export interface VocabFolder {
  root: { deckId: number; name: string };
  /** The root first, then its subdecks in tree order. */
  decks: VocabFolderDeck[];
  notetypes: VocabFolderNotetype[];
}

/** A user notetype's vocabulary field (`notetype_mapping`, role `vocab`). */
export interface VocabMapping {
  notetypeId: number;
  field: string;
}

/** What part of the book to scan (spec 12.1 step 2). */
export type VocabRangeSpec = { kind: 'all' } | { kind: 'outline'; ids: string[] } | { kind: 'pages'; text: string };

/** A range resolved against the book (`vocab_range_check`, and the report header). */
export interface ResolvedRange {
  kind: VocabRangeSpec['kind'];
  /** 0-based inclusive page intervals, sorted and merged. */
  pages: [number, number][];
  /** Outline titles joined by " + " (outline), the normalized pages (`p. 21-45`), `null` for the whole book. */
  label: string | null;
  /** For people: `Livro inteiro`, `Cap 3 (p. 21–45)`, `p. 21–45, 60, 72–80`. */
  display: string;
  /** `cap-3`, `p-21-45`; `null` for the whole book. */
  slug: string | null;
  /** Subdeck name of the generated deck (`Cap 3`, `p. 21-45`); `null` for the whole book. */
  subdeck: string | null;
  /** Outline item ids (outline ranges). */
  items: string[];
  /** The pages as typed, normalized (`21-45, 60, 72-80`), for page ranges. */
  text: string | null;
}

export interface VocabOutlineItem {
  id: string;
  title: string;
  /** 0-based target page, `null` when the item has no page (cannot be chosen). */
  page: number | null;
  /** The item's range by the rule of spec 12.1 (0-based inclusive), `null` without a page. */
  startPage: number | null;
  endPage: number | null;
  children: VocabOutlineItem[];
}

/** The PDF outline of the current version (incl. bookmarks made in PdfCraft). */
export interface VocabOutline {
  pageCount: number;
  items: VocabOutlineItem[];
}

export interface VocabJob {
  jobId: string;
  scanUid: string;
}

export type JobStage =
  'queued' | 'text' | 'lemmas' | 'known' | 'compare' | 'ocr' | 'writing' | 'ai' | 'done' | 'failed' | 'cancelled';

export type JobKind = 'vocabScan' | 'ocr' | 'aiEnrich';

/** Payload of `job://<jobId>` and of `job_status`. */
export interface JobProgress {
  jobId: string;
  kind: JobKind;
  bookUid: string;
  /** The vocabulary scan's uid (`''` for other jobs). */
  scanUid: string;
  stage: JobStage;
  done: number;
  total: number;
  /** The book's per-page lemma table was reused (no PDF read). */
  reused: boolean;
  error: CoreErrorPayload | null;
  /** OCR jobs: what was recognised and written (absent for other kinds and until the job ends). */
  ocr?: OcrJobInfo;
}

export interface VocabLemmaRef {
  lemma: string;
  status: VocabStatus;
}

/** One lemma of the report (spec 12.5). */
export interface VocabRow {
  lemma: string;
  /** The most common original form in the range. */
  form: string;
  pos: VocabPos | null;
  /** `forms`: inflections of known words that are lemmas of their own (unchecked by default). */
  group: 'main' | 'forms' | 'proper' | 'phrasal';
  status: VocabStatus;
  /** `null`: nothing says anything about it (unknown, detected proper nouns). */
  statusSource: VocabStatusSource | null;
  /** Occurrences in the range. */
  occurrences: number;
  /** 0-based, first page in the range. */
  firstPage: number;
  /** 0-based pages of the range where it occurs. */
  pages: number[];
  zipf: number | null;
  /** Zipf < 2.5 or not in the frequency list. */
  rare: boolean;
  /** First example sentence in the range (original spelling). */
  example: string | null;
  /** UTF-16 offsets of the form inside `example` (end exclusive). */
  exampleSpan: [number, number] | null;
  examplePage: number | null;
  /** `forms` group: the known base word (learning ← learn). */
  base: VocabLemmaRef | null;
  /** Derivatives: the known word of the same family (learner → learn). */
  family: VocabLemmaRef | null;
  /** A note made by an earlier scan of this book ("já no deck do livro"). */
  existingNoteId: number | null;
  defaultSelected: boolean;
  /** Chapter (1-based `VocabChapter.index`) of `firstPage`. */
  chapter: number | null;
  /** Index of the first occurrence among the words of `firstPage` (reading order). */
  position: number;
}

export interface VocabCurvePoint {
  /** Words learned (the most frequent unknown ones first). */
  n: number;
  /** 0..=1. */
  coverage: number;
}

export interface VocabMetrics {
  totalTokens: number;
  knownTokens: number;
  learningTokens: number;
  /** 0..=1. */
  coverageKnown: number;
  coverageWithLearning: number;
  unknownLemmas: number;
  /** Unknown lemmas with 2 or more occurrences. */
  unknownLemmasRepeated: number;
  /**
   * Unknown lemmas to learn, most frequent first, to reach 95% / 98% (0 when already there; all of them when the
   * goal cannot be reached). The curve starts at the coverage with learning.
   */
  wordsTo95: number;
  wordsTo98: number;
  curve: VocabCurvePoint[];
  properLemmas: number;
  formsLemmas: number;
}

/** Coverage of a chapter that touches the range (only its part inside the range). */
export interface VocabChapter {
  /** 1-based. */
  index: number;
  label: string;
  startPage: number;
  endPage: number;
  totalTokens: number;
  knownTokens: number;
  /** 0..=1. */
  coverageKnown: number;
  coverageWithLearning: number;
}

export interface VocabDeckNaming {
  /** `<pasta>::Livros::<Título>`. */
  baseName: string;
  subdeck: string | null;
  /** The deck the cards go to (`baseName` or `baseName::subdeck`). */
  fullName: string;
  /** `trecho::cap-3`, `null` for the whole book. */
  rangeTag: string | null;
  /** `livro::animal-farm`. */
  bookTag: string;
}

/** `vocab_report`: the last finished scan of the book. */
export interface VocabReport {
  scanUid: string;
  bookUid: string;
  title: string;
  author: string | null;
  /** Epoch ms. */
  scannedAt: number;
  folder: { rootDeckId: number; rootName: string; deckCount: number };
  range: ResolvedRange;
  config: VocabConfig;
  metrics: VocabMetrics;
  chapters: VocabChapter[];
  rows: VocabRow[];
  deck: VocabDeckNaming;
}

/** "Já sei", "Ignorar", "Nome próprio"; `null` removes the adjustment. */
export type VocabOverride = 'known' | 'ignored' | 'proper';

export interface VocabDeckOptions {
  order: 'reading' | 'frequency';
  /** One subdeck per chapter (`…::Cap 01`). */
  perChapter: boolean;
  /** The optional Português → Inglês card. */
  card2: boolean;
  /** `ai` arrives with Phase 8 (refused before that). */
  enrich: 'wordnet' | 'ai';
}

export interface VocabDeckResult {
  /** The deck of the range (or of the book). */
  deckId: number;
  deckName: string;
  /** Every deck that received cards (full names). */
  decks: string[];
  /** Notes created. */
  created: number;
  noteIds: number[];
  /** Lemmas already in the vocabulary folder. */
  skippedExisting: string[];
  /** Lemmas created by an earlier scan of this book. */
  skippedPrevious: string[];
}

export interface VocabMark {
  lemma: string;
  form: string;
  status: 'unknown' | 'learning';
  /** Page view space, like `PageWord.rects`. */
  rects: Rect[];
}

export interface VocabPageMarks {
  page: number;
  marks: VocabMark[];
}

/** "Adicionar ao deck do livro" from the reading popover. */
export interface VocabWordAdded {
  noteId: number;
  deckId: number;
  deckName: string;
}

/** One bundled data set (credits in Configurações → Sobre). */
export interface VocabDataSource {
  name: string;
  /** The pinned release ("2025", "3.1.1"). */
  version: string;
  /** SPDX id ("CC-BY-4.0"). */
  license: string;
  url: string | null;
}

/** The bundled vocabulary data (`vocab_data_info`). */
export interface VocabDataInfo {
  available: boolean;
  wordnet: VocabDataSource | null;
  frequency: VocabDataSource | null;
  stopwords: VocabDataSource | null;
  schemaVersion: number | null;
}

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
// ---------------------------------------------------------------- AI (spec 13, docs/planos/fase-8.md)

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'deepseek';
export type AiEffort = 'minimum' | 'low' | 'medium' | 'high';
/** `define` and `cards` use the enrichment settings. */
export type AiFeature = 'enrich' | 'define' | 'cards' | 'judge';

/** Provider, model and effort of one function (`enrich` or `judge`). */
export interface AiFunctionSettings {
  /** `null`: the function is off. */
  provider: AiProvider | null;
  /** Chosen by the user; `null` = the provider's default for the function. */
  model: string | null;
  /** The model the calls use. */
  effectiveModel: string | null;
  effort: AiEffort;
  maxOutputTokens: number;
}

/** One provider in Configurações → IA: the key never leaves the keychain, only its last 4 characters. */
export interface AiProviderInfo {
  id: AiProvider;
  label: string;
  /** The adapter exists in this version. */
  available: boolean;
  hasKey: boolean;
  keySuffix: string | null;
}

export interface AiSettings {
  enrich: AiFunctionSettings;
  judge: AiFunctionSettings;
  limitDayUsd: number;
  limitMonthUsd: number;
  confirmAboveUsd: number;
  backgroundEnrich: boolean;
  backgroundPaused: boolean;
  providers: AiProviderInfo[];
  keychainAvailable: boolean;
}

/** A missing field is left alone; `provider: null` turns the function off. */
export interface AiFunctionPatch {
  provider?: AiProvider | null;
  model?: string | null;
  effort?: AiEffort;
  maxOutputTokens?: number;
}

export interface AiSettingsPatch {
  enrich?: AiFunctionPatch;
  judge?: AiFunctionPatch;
  limitDayUsd?: number;
  limitMonthUsd?: number;
  confirmAboveUsd?: number;
  backgroundEnrich?: boolean;
  backgroundPaused?: boolean;
  /** Providers the user just agreed to send data to: required in the same patch that activates one. */
  consent?: AiProvider[];
}

export interface AiKeyTest {
  ok: boolean;
  code: string | null;
  message: string;
  model: string;
}

/** One model of the price table (US$ per million tokens, base tier). */
export interface AiModelPrice {
  provider: string;
  model: string;
  roleDefault: string | null;
  checkedAt: string;
  source: string | null;
  input: number;
  cachedInput: number | null;
  output: number;
  hasTiers: boolean;
  edited: boolean;
  stale: boolean;
}

export interface AiRates {
  input: number;
  cachedInput?: number | null;
  cacheWrite?: number | null;
  output: number;
}

export type AiBudgetState = 'ok' | 'warning' | 'blocked';

export interface AiUsageTotal {
  provider: string;
  feature: string;
  calls: number;
  costUsd: number;
}

export interface AiUsage {
  dayUsd: number;
  monthUsd: number;
  limitDayUsd: number;
  limitMonthUsd: number;
  state: AiBudgetState;
  day: AiUsageTotal[];
  month: AiUsageTotal[];
}

export type AiCardKind = 'basico' | 'cloze' | 'comando' | 'programa';

export type AiEstimateRequest =
  | { feature: 'cards'; text: string; kind: AiCardKind; n: number }
  | { feature: 'deck'; bookUid: string; scanUid: string; lemmas: string[] };

export interface AiEstimate {
  worstUsd: number;
  calls: number;
  /** Words already in the cache (no cost). */
  cached: number;
  toSend: number;
  needsConfirmation: boolean;
  state: AiBudgetState;
  provider: string;
  model: string;
}

/** What the code review screen sends to the judge (it already ran the checker). */
export interface AiJudgeRequest {
  language: string;
  question: string;
  answer: string;
  accepted: string[];
  userAnswer: string;
  autoVerdict: string;
  diffs: string;
}

export interface AiJudgeResult {
  veredito: 'correto' | 'equivalente' | 'quase' | 'errado';
  explicacao: string;
  /** 1 Errei … 4 Fácil: a suggestion, the user rates. */
  notaSugerida: number;
}

/** A proposed card: fields by the prompt's names (`frente`/`verso`, `texto`, `pergunta`/`resposta`…). */
export interface AiCardProposal {
  fields: Record<string, string>;
  tags: string[];
}

export interface AiWordSense {
  lemma: string;
  class: string;
  definition: string;
  translation: string;
  cached: boolean;
}

export interface AiEnrichStarted {
  /** `null` when every word was already in the cache. */
  jobId: string | null;
  alreadyRunning: boolean;
  cached: number;
  toSend: number;
}

export interface AiQueueItem {
  uid: string;
  noteId: number;
  lemma: string;
  pos: string;
  sentence: string;
  leftFields: string;
  createdAt: number;
  state: 'pending' | 'failed';
  attempts: number;
  error: string | null;
}

export interface AiQueueInfo {
  enabled: boolean;
  paused: boolean;
  pending: number;
  failed: number;
  /** Why the queue isn't moving (cap, no network, paused above the confirmation threshold…). */
  status: string | null;
  items: AiQueueItem[];
}

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
  /** `page` (0-based, the page shown) picks `chapterDeck`. */
  bookPanelInfo(uid: string, page?: number): Promise<BookPanelInfo>;
  bookPanelSet(uid: string, patch: BookPanelPatch): Promise<BookPanelInfo>;
  /** Notes whose Fonte links to this book. */
  ankiBookCards(uid: string): Promise<BookCard[]>;
  /** One word only (`invalid_input` otherwise). `bookUid` is context for later phases. */
  vocabDefine(word: string, bookUid: string | null): Promise<WordDefinition>;

  // Vocabulary scan (spec 12, 15)
  vocabSettingsGet(): Promise<VocabSettings>;
  vocabSettingsSet(patch: VocabSettingsPatch): Promise<VocabSettings>;
  /** The folder under `rootDeckId`: every subdeck with counts and the notetypes with their vocabulary field. */
  vocabFolder(rootDeckId: number): Promise<VocabFolder>;
  /** Up to 5 words of `field` in the notes of `notetypeId` inside the folder. */
  vocabMappingSamples(
    rootDeckId: number,
    excludedDeckIds: number[],
    notetypeId: number,
    field: string,
  ): Promise<string[]>;
  vocabMappingGet(): Promise<VocabMapping[]>;
  vocabMappingSet(notetypeId: number, field: string): Promise<VocabMapping[]>;
  /** The outline (incl. PdfCraft bookmarks) of the current version, with each item's range. */
  vocabOutline(uid: string): Promise<VocabOutline>;
  /** Resolves a range; `vocab_range_invalid` with a pt-BR message for bad page lists. */
  vocabRangeCheck(uid: string, range: VocabRangeSpec): Promise<ResolvedRange>;
  /** Starts a scan in the background (`job://<jobId>`); the folder and criterion become the defaults. */
  vocabScanStart(
    uid: string,
    rootDeckId: number,
    excludedDeckIds: number[],
    range: VocabRangeSpec,
    config: VocabConfig,
  ): Promise<VocabJob>;
  /** Scans the last range again with the current settings and adjustments (seconds: the table is reused). */
  vocabRescan(uid: string): Promise<VocabJob>;
  /** The last finished scan of the book, `null` when none. */
  vocabReport(uid: string): Promise<VocabReport | null>;
  vocabOverrideSet(lemmas: string[], status: VocabOverride | null): Promise<void>;
  /** Creates the notes of `lemmas` (spec 12.6); `vocab_prepare_needed` when "Vocabulário · Livro" is missing. */
  vocabGenerateDeck(
    uid: string,
    scanUid: string,
    lemmas: string[],
    options: VocabDeckOptions,
  ): Promise<VocabDeckResult>;
  /** Underline rects of unknown/learning words on these pages (0-based), from the last scan. */
  vocabMarks(uid: string, pages: number[]): Promise<VocabPageMarks[]>;
  /** "Adicionar ao deck do livro" (reading popover): one note at once, enriched later. */
  vocabAddWord(uid: string, lemma: string, page: number, form: string): Promise<VocabWordAdded>;
  vocabDataInfo(): Promise<VocabDataInfo>;
  /** The word forms to color in these EPUB sections (0-based, at most 5), from the last scan. */
  vocabEpubMarks(uid: string, sections: number[]): Promise<EpubSectionMarks[]>;

  // EPUB annotations (spec 7.1, 14)
  /** The book's live annotations, in no particular order. */
  epubAnnotationList(uid: string): Promise<EpubAnnotation[]>;
  epubAnnotationUpsert(input: EpubAnnotationInput): Promise<EpubAnnotation>;
  /** Tombstones the annotation (a no-op when already gone). */
  epubAnnotationDelete(annotationUid: string): Promise<void>;

  // OCR (spec 7.2)
  ocrInfo(uid: string): Promise<OcrInfo>;
  /** Starts "Reconhecer texto" in the background (`job://<jobId>`, kind 'ocr'); the result is a new version. */
  ocrStart(uid: string): Promise<OcrStarted>;
  /** Cancels the book's OCR job; `false` when none was running. */
  ocrCancel(uid: string): Promise<boolean>;

  // Jobs (spec 15)
  /** `null` when the job is unknown (finished long ago, or another app run). */
  jobStatus(jobId: string): Promise<JobProgress | null>;
  jobCancel(jobId: string): Promise<void>;
  /** `job://<jobId>`; calls `jobStatus` once after subscribing, so an early end is never missed. */
  onJobProgress(jobId: string, cb: (p: JobProgress) => void): Unlisten;

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

  // Code cards (spec 11, 15)
  codeMappingList(): Promise<CodeMapping[]>;
  /** Assigns the "Comando" role to a user notetype (`fields`), or removes it (`null`). App types are refused. */
  codeMappingSet(notetypeId: number, fields: CodeMappingFields | null): Promise<CodeMapping[]>;
  codeNoteExtraGet(noteId: number): Promise<CodeNoteExtra>;
  codeNoteExtraSet(noteId: number, accepted: string[], requires: string[]): Promise<CodeNoteExtra>;
  /** "Contestar": adds `answer` to the note's accepted answers (Aceitas field, else `code_note_extra`). */
  codeAcceptAnswer(noteId: number, answer: string): Promise<CodeAcceptResult>;
  /** Compiles and runs C++ (local compiler on desktop, else the runner); `code_cpp_unavailable` when neither. */
  codeRunCpp(files: Record<string, string>, stdin: string): Promise<CppRunResult>;
  codeFormatCpp(code: string): Promise<CppFormatResult>;
  codeStatus(): Promise<CodeStatus>;
  codeSettingsGet(): Promise<CodeSettings>;
  codeSettingsSet(patch: CodeSettingsPatch): Promise<CodeSettings>;
  codeRunnerTest(): Promise<RunnerTestResult>;
  /** Parses a Markdown batch (preview with the errors of each item). */
  codeImportMarkdown(text: string): Promise<ImportPreview>;
  /** Adds the items `include` (indexes) of `text` to `deckId`. */
  codeImportCommit(text: string, deckId: number, include: number[]): Promise<CodeImportResult>;

  // AI (spec 13): every call leaves from the core; keys stay in the system keychain.
  aiSettingsGet(): Promise<AiSettings>;
  aiSettingsSet(patch: AiSettingsPatch): Promise<AiSettings>;
  /** The key crosses the IPC once, into the keychain. */
  aiKeySet(provider: AiProvider, key: string): Promise<AiSettings>;
  aiKeyDelete(provider: AiProvider): Promise<AiSettings>;
  /** "Testar chave": one call with no tokens, only on the user's click. */
  aiKeyTest(provider: AiProvider): Promise<AiKeyTest>;
  aiPricesGet(): Promise<AiModelPrice[]>;
  /** Edits (or, with `null`, restores) a model's price; a new model becomes usable once priced. */
  aiPricesSet(provider: AiProvider, model: string, rates: AiRates | null): Promise<AiModelPrice[]>;
  aiUsage(): Promise<AiUsage>;
  aiEstimate(request: AiEstimateRequest): Promise<AiEstimate>;
  /** `confirmed`: the user accepted a call above the confirmation threshold (`ai_needs_confirmation`). */
  aiJudgeCode(request: AiJudgeRequest, confirmed: boolean): Promise<AiJudgeResult>;
  aiCardsFromText(text: string, kind: AiCardKind, n: number, confirmed: boolean): Promise<AiCardProposal[]>;
  /** Without `sentence`, `at` (book and page) finds it: the example of that page in the book's vocabulary table. */
  aiDefineWord(
    lemma: string,
    pos: VocabPos | null,
    sentence: string,
    confirmed: boolean,
    at?: { bookUid: string; page: number },
  ): Promise<AiWordSense>;
  /** Fills the AI cache for a deck (a job); "Gerar deck" with `enrich: 'ai'` then reads it. */
  aiEnrichStart(bookUid: string, scanUid: string, lemmas: string[], confirmed: boolean): Promise<AiEnrichStarted>;
  aiQueueGet(): Promise<AiQueueInfo>;
  aiQueueSetPaused(paused: boolean): Promise<AiQueueInfo>;
  aiQueueRemove(uid: string): Promise<AiQueueInfo>;
  aiQueueRetry(): Promise<AiQueueInfo>;
  /** Queues a Vocabulário note created from the selection (when the background enrichment is on). */
  aiQueueAddNote(noteId: number, sentence: string): Promise<AiQueueInfo>;
  /** `ai://queue`: the background queue changed. */
  onAiQueue(cb: (q: AiQueueInfo) => void): Unlisten;

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
  /** `page` 0-based (an EPUB's spine section); `cfi` the EPUB location (left out / null for a PDF). */
  positionSet(uid: string, page: number, progress: number, cfi?: string | null): Promise<ReadingPosition>;
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
  /** Native "open files" dialog (PDF, EPUB). Empty when cancelled. */
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
