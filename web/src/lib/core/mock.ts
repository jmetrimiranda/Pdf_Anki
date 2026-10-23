// In-browser stand-in for the Rust core: used by `vite --mode mock`, Playwright and Vitest.
// The library lives in memory and is persisted in sessionStorage ('leitor.mock'), so reloading the
// page simulates restarting the app. PDFs are real files produced by `makePdf`.
import { layoutPageText, makePdf, PDF_PAGE_SIZE, pdfBytesToLatin1 } from '../pdf/minimalPdf';
import {
  ankiState,
  buildDeckTree,
  emitAnkiChanged,
  emitAnkiPageEvent,
  later,
  listenTo,
  persistAnki,
  resetAnki,
  setMockBookUidProvider,
  type MockAnkiLog,
} from './mock/ankiData';
import { createAnkiDecksMock, mockDailyBackup } from './mock/ankiDecks';
import { ankiNotesMock } from './mock/ankiNotes';
import { ankiStudyMock } from './mock/ankiStudy';
import { ankiSyncMock, mockSyncHandle, resetSync, syncCollectionReplaced, type MockSyncHandle } from './mock/ankiSync';
import {
  CoreError,
  type AddedBook,
  type AddOutcome,
  type Book,
  type BookPatch,
  type CoreClient,
  type AnkiChanged,
  type AnkiPageEvent,
  type BackupInfo,
  type DeckTree,
  type LibraryEntry,
  type PageWord,
  type PageWords,
  type ReadingPosition,
  type SavedVersion,
  type StopReason,
} from './types';

// ---------------------------------------------------------------- decks

/** The mock collection's deck list (kept for the component gallery at /dev/ui). */
export function mockDeckTree(): DeckTree {
  return buildDeckTree();
}

// ---------------------------------------------------------------- book contents

type TextKind = 'ros' | 'farm' | 'generic' | 'scanned';

/** How to regenerate a book's ORIGINAL bytes (the saved versions are stored as bytes). */
interface BookSpec {
  pages: number;
  title: string;
  author: string | null;
  kind: TextKind;
  /** Makes the file (and so the book_uid) unique. */
  marker: string;
}

const TEXTS: Record<Exclude<TextKind, 'scanned'>, string[]> = {
  ros: [
    'A robot is rarely a single program. It is a small society of processes that talk to each other all the time: one reads the laser, another estimates where the robot is, a third decides where to go next.',
    'The basic unit is the node. A node is a process that does one job well and exposes that job through topics, services and actions.',
    'Topics carry streams of messages. A publisher does not know who is listening, and a subscriber does not know who is speaking.',
    'Quality of service settings let each topic choose between speed and certainty. Reliable delivery retries until the message arrives.',
  ],
  farm: [
    'Mr. Jones, of the Manor Farm, had locked the hen-houses for the night, but was too drunk to remember to shut the pop-holes.',
    'As soon as the light in the bedroom went out there was a stirring and a fluttering all through the farm buildings.',
    'Old Major was so highly regarded on the farm that everyone was quite ready to lose an hour sleep in order to hear what he had to say.',
  ],
  generic: [
    'Reading a little every day builds a large vocabulary over time. New words become familiar when they appear again and again.',
    'A good study routine mixes reading, reviewing and writing. Short sessions repeated often beat long sessions done rarely.',
  ],
};

function pageText(spec: BookSpec, i: number): string {
  if (spec.kind === 'scanned') return '';
  const paras = TEXTS[spec.kind];
  const body = Array.from({ length: 6 }, (_, k) => paras[(i + k) % paras.length]).join('\n');
  return `${spec.title} — ${i + 1}\n${i === 0 ? `${spec.marker}\n` : ''}${body}`;
}

function originalBytes(spec: BookSpec): Uint8Array {
  return makePdf({
    pages: spec.pages,
    title: spec.title,
    ...(spec.author ? { author: spec.author } : {}),
    textPerPage: (i) => pageText(spec, i),
    outline: spec.kind !== 'scanned',
  });
}

// ---------------------------------------------------------------- bytes helpers

/** Deterministic 64-hex digest (stand-in for sha256; the mock never needs a real one). */
export function mockHash(bytes: Uint8Array): string {
  const lanes = new Uint32Array(8);
  for (let l = 0; l < 8; l++) lanes[l] = (0x811c9dc5 ^ Math.imul(l + 1, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    for (let l = 0; l < 8; l++) lanes[l] = Math.imul(lanes[l]! ^ (b + l), 0x01000193) >>> 0;
  }
  // Mix in the length so prefixes differ.
  for (let l = 0; l < 8; l++) lanes[l] = Math.imul(lanes[l]! ^ bytes.length, 0x01000193) >>> 0;
  return Array.from(lanes, (n) => n.toString(16).padStart(8, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  return btoa(pdfBytesToLatin1(bytes));
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** `LeitorBookUid` from the Info dict (literal or hex-free ASCII form), by plain byte search like the core. */
export function findLeitorBookUid(bytes: Uint8Array): string | null {
  const m = /\/LeitorBookUid\s*\(([0-9a-f]{64})\)/.exec(pdfBytesToLatin1(bytes));
  return m?.[1] ?? null;
}

function countPages(bytes: Uint8Array): number {
  return pdfBytesToLatin1(bytes).match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function fileTitle(path: string): string {
  return baseName(path).replace(/\.pdf$/i, '');
}

// ---------------------------------------------------------------- state

interface BookRec {
  book: Book;
  spec: BookSpec;
  removed: boolean;
}

export interface MockSessionEvent {
  kind: 'start' | 'heartbeat' | 'stop';
  uid: string | null;
  page: number | null;
  reason: StopReason | null;
  at: number;
}

export interface MockSavedVersion {
  uid: string;
  fileVersion: number;
  fileHash: string;
  size: number;
  /** Whether the bytes carried `/LeitorBookUid <uid>`. */
  hasBookUid: boolean;
  at: number;
}

interface MockState {
  books: BookRec[];
  positions: Record<string, ReadingPosition>;
  /** Current version bytes (base64) of books that were saved at least once. */
  versions: Record<string, string>;
  savedVersions: MockSavedVersion[];
  /** Fake file system for exports: path → base64. */
  files: Record<string, string>;
  sessions: MockSessionEvent[];
  openedExternally: string[];
  pendingOpen: string[];
  nextPick: string[] | null;
  /** `undefined`: default path; `null`: the user cancels the save dialog. */
  nextExportPath?: string | null;
  /** Paths chosen in the save dialog and not yet written (one export each, like `export_pick_path`). */
  exportGrants?: string[];
}

const STORAGE_KEY = 'leitor.mock';

/** Mirrors `ExportGrants` in the core: exports only write to a path just chosen in the save dialog, once. */
function takeExportGrant(path: string): void {
  const grants = state.exportGrants ?? [];
  if (!grants.includes(path)) {
    throw new CoreError('export_not_granted', 'Escolha onde salvar a cópia na janela de exportação.');
  }
  state.exportGrants = grants.filter((p) => p !== path);
}
const APP_DIR = '/home/jorge/.local/share/dev.jmetri.leitor-estudos';
const DAY = 86_400_000;

function newRec(spec: BookSpec, now: number, extra: Partial<Book> = {}): BookRec {
  const bytes = originalBytes(spec);
  const uid = mockHash(bytes);
  return {
    spec,
    removed: false,
    book: {
      bookUid: uid,
      title: spec.title,
      author: spec.author,
      language: 'en',
      format: 'pdf',
      fileName: `${spec.title}.pdf`,
      pages: spec.pages,
      hasText: spec.kind !== 'scanned',
      ocrStatus: 'none',
      fileHash: uid,
      fileVersion: 1,
      contentDeckId: null,
      collectionFolder: null,
      addedAt: now,
      updatedAt: now,
      localPath: `${APP_DIR}/books/${uid}/v1.pdf`,
      localHash: uid,
      downloaded: true,
      ...extra,
    },
  };
}

function seedState(): MockState {
  const now = Date.now();
  const ros = newRec(
    { pages: 12, title: 'ROS 2 na prática', author: 'Jorge Metri', kind: 'ros', marker: 'seed-ros' },
    now - 3 * DAY,
  );
  const scanned = newRec(
    { pages: 8, title: 'Apostila digitalizada', author: null, kind: 'scanned', marker: 'seed-scan' },
    now - 2 * DAY,
  );
  const farm = newRec(
    { pages: 10, title: 'Animal Farm', author: 'George Orwell', kind: 'farm', marker: 'seed-farm' },
    now - DAY,
    { collectionFolder: 'Inglês' },
  );
  return {
    books: [ros, scanned, farm],
    positions: {
      [ros.book.bookUid]: { page: 4, offset: 0, cfi: null, progress: 5 / 12, updatedAt: now - 60_000 },
      [farm.book.bookUid]: { page: 1, offset: 0, cfi: null, progress: 2 / 10, updatedAt: now - DAY + 60_000 },
    },
    versions: {},
    savedVersions: [],
    files: {},
    sessions: [],
    openedExternally: [],
    pendingOpen: [],
    nextPick: null,
  };
}

function loadState(): MockState {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockState;
      if (Array.isArray(parsed.books) && parsed.positions && parsed.versions) return parsed;
    }
  } catch {
    // Corrupt or unavailable storage: start over.
  }
  return seedState();
}

let state: MockState = loadState();

// e2e hook: options injected before the app starts (`mockInit` in e2e/fixtures.ts).
{
  const holder = globalThis as {
    __leitorMockInit?: { pendingOpen?: string[]; nextPick?: string[]; nextPackagePick?: string | null };
  };
  const init = holder.__leitorMockInit;
  if (init) {
    if (init.pendingOpen) state.pendingOpen = init.pendingOpen;
    if (init.nextPick) state.nextPick = init.nextPick;
    if (init.nextPackagePick !== undefined) {
      ankiState().nextPackagePick = init.nextPackagePick;
      persistAnki();
    }
    delete holder.__leitorMockInit;
  }
}

// The Fonte links of the mock Anki notes point at the mock library's books.
setMockBookUidProvider((title) => state.books.find((r) => r.book.title === title)?.book.bookUid ?? null);

function persist(): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded (huge saved versions): keep the in-memory state only.
  }
}

// ---------------------------------------------------------------- queries

function liveRec(uid: string): BookRec {
  const rec = state.books.find((r) => r.book.bookUid === uid && !r.removed);
  if (!rec) throw new CoreError('book_not_found', 'Este livro não está na biblioteca.');
  return rec;
}

function entry(rec: BookRec): LibraryEntry {
  return structuredClone({ ...rec.book, position: state.positions[rec.book.bookUid] ?? null });
}

function currentBytes(rec: BookRec): Uint8Array {
  const saved = state.versions[rec.book.bookUid];
  return saved ? fromBase64(saved) : originalBytes(rec.spec);
}

/** Simple monospace-ish word boxes over the lines `makePdf` draws (Helvetica ≈ 0.5 em per char). */
function pageWords(rec: BookRec, page: number): PageWords {
  if (!Number.isInteger(page) || page < 0 || page >= rec.book.pages) {
    throw new CoreError('page_out_of_range', `A página ${page + 1} não existe neste documento.`);
  }
  const lines = layoutPageText(pageText(rec.spec, page));
  let text = '';
  const words: PageWord[] = [];
  for (const line of lines) {
    const lineStart = text.length;
    const charW = line.size * 0.5;
    for (const m of line.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
      const start = lineStart + m.index;
      words.push({
        index: words.length,
        text: m[0],
        start,
        end: start + m[0].length,
        rects: [[line.x + m.index * charW, line.baseline - line.size * 0.8, m[0].length * charW, line.size * 1.05]],
      });
    }
    text += `${line.text}\n`;
  }
  return { page, width: PDF_PAGE_SIZE.width, height: PDF_PAGE_SIZE.height, text, words };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

const COVER_TONES = ['#e8eedc', '#e3e9f2', '#f2e8e1', '#ece6f2', '#e6f0ec'];

/** Placeholder cover: a soft page with the title, like a rendered first page. */
export function mockCoverSvg(title: string, author: string | null, scanned = false): string {
  const tone = COVER_TONES[title.length % COVER_TONES.length];
  const words = title.split(/\s+/);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && last.length + w.length < 14) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  const titleSvg = lines
    .slice(0, 4)
    .map((l, i) => `<text x="20" y="${70 + i * 22}" font-size="18" font-weight="600">${escapeXml(l)}</text>`)
    .join('');
  const bars = scanned
    ? Array.from(
        { length: 8 },
        (_, i) => `<rect x="20" y="${170 + i * 10}" width="${120 - (i % 3) * 18}" height="4" fill="#00000022"/>`,
      ).join('')
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240" viewBox="0 0 180 240">` +
    `<rect width="180" height="240" fill="${tone}"/>` +
    `<g fill="#1f1f1f" font-family="Georgia,'DejaVu Serif',serif">${titleSvg}</g>` +
    (author
      ? `<text x="20" y="215" font-size="11" fill="#555" font-family="sans-serif">${escapeXml(author)}</text>`
      : '') +
    bars +
    `</svg>`
  );
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------- mutations

function addFromBytes(path: string, bytes: Uint8Array, replace = false): AddedBook {
  const now = Date.now();
  const hash = mockHash(bytes);
  const stamped = findLeitorBookUid(bytes);
  const uid = stamped ?? hash;
  const rec = state.books.find((r) => r.book.bookUid === uid);
  let outcome: AddOutcome;
  if (rec && !rec.removed) {
    if (rec.book.fileHash === hash || uid === hash) {
      outcome = 'existing';
    } else if (!replace) {
      return { book: entry(rec), outcome: 'otherVersion' };
    } else {
      storeVersion(rec, bytes, hash, now);
      outcome = 'newVersion';
    }
  } else if (rec) {
    rec.removed = false;
    rec.book.updatedAt = now;
    if (rec.book.fileHash !== hash && uid !== hash) storeVersion(rec, bytes, hash, now);
    outcome = 'restored';
  } else {
    // An unknown file: exported copies from another device keep their stamped uid.
    const pages = countPages(bytes) || 1;
    const spec: BookSpec = { pages, title: fileTitle(path), author: null, kind: 'generic', marker: path };
    const fresh = newRec(spec, now, { fileName: baseName(path) });
    fresh.book.bookUid = uid;
    fresh.book.localPath = `${APP_DIR}/books/${uid}/v1.pdf`;
    if (uid !== mockHash(originalBytes(spec))) {
      // The original bytes are not ours to regenerate: keep the imported ones as the current version.
      state.versions[uid] = toBase64(bytes);
      fresh.book.fileHash = hash;
      fresh.book.localHash = hash;
    }
    state.books.push(fresh);
    outcome = 'created';
  }
  persist();
  return { book: entry(liveRec(uid)), outcome };
}

function storeVersion(rec: BookRec, bytes: Uint8Array, hash: string, now: number): void {
  const b = rec.book;
  b.fileVersion += 1;
  b.fileHash = hash;
  b.localHash = hash;
  b.localPath = `${APP_DIR}/books/${b.bookUid}/v${b.fileVersion}.pdf`;
  b.updatedAt = now;
  const pages = countPages(bytes);
  if (pages > 0) b.pages = pages;
  state.versions[b.bookUid] = toBase64(bytes);
  state.savedVersions.push({
    uid: b.bookUid,
    fileVersion: b.fileVersion,
    fileHash: hash,
    size: bytes.length,
    hasBookUid: findLeitorBookUid(bytes) === b.bookUid,
    at: now,
  });
}

function addFromPath(path: string, replace = false): AddedBook {
  if (!/\.pdf$/i.test(path)) {
    throw new CoreError('unsupported_format', 'Formato não suportado. Escolha um arquivo PDF.');
  }
  if (/corrompido/i.test(path)) {
    throw new CoreError('pdf_invalid', 'O arquivo não é um PDF válido ou está corrompido.');
  }
  const exported = state.files[path];
  if (exported) return addFromBytes(path, fromBase64(exported), replace);
  const spec: BookSpec = {
    pages: 6,
    title: fileTitle(path),
    author: null,
    kind: /escanead/i.test(path) ? 'scanned' : 'generic',
    marker: path,
  };
  const bytes = originalBytes(spec);
  const uid = mockHash(bytes);
  const rec = state.books.find((r) => r.book.bookUid === uid);
  if (rec && !rec.removed) return { book: entry(rec), outcome: 'existing' };
  if (rec) {
    rec.removed = false;
    rec.book.updatedAt = Date.now();
    persist();
    return { book: entry(rec), outcome: 'restored' };
  }
  const fresh = newRec(spec, Date.now(), { fileName: baseName(path) });
  state.books.push(fresh);
  persist();
  return { book: entry(fresh), outcome: 'created' };
}

function update(uid: string, patch: BookPatch): LibraryEntry {
  const rec = liveRec(uid);
  const b = rec.book;
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new CoreError('invalid_input', 'O título não pode ficar vazio.');
    b.title = patch.title.trim();
  }
  if (patch.author !== undefined) b.author = patch.author?.trim() || null;
  if (patch.language !== undefined) b.language = patch.language;
  if (patch.contentDeckId !== undefined) b.contentDeckId = patch.contentDeckId;
  if (patch.collectionFolder !== undefined) b.collectionFolder = patch.collectionFolder?.trim() || null;
  if (patch.pages !== undefined && Number.isInteger(patch.pages) && patch.pages >= 0) b.pages = patch.pages;
  b.updatedAt = Date.now();
  persist();
  return entry(rec);
}

function saveVersion(uid: string, buf: ArrayBuffer, baseVersion?: number): SavedVersion {
  const rec = liveRec(uid);
  const bytes = new Uint8Array(buf);
  if (pdfBytesToLatin1(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new CoreError('pdf_invalid', 'O PdfCraft devolveu um arquivo que não é PDF.');
  }
  if (findLeitorBookUid(bytes) !== uid) {
    throw new CoreError('book_uid_missing', 'O arquivo salvo não traz a identificação deste livro (LeitorBookUid).');
  }
  const hash = mockHash(bytes);
  if (hash === rec.book.fileHash) {
    return { fileHash: hash, fileVersion: rec.book.fileVersion, changed: false, keptNewer: false };
  }
  // Like the core: a save based on an older version keeps the current one (as a `replaced-` copy there).
  const keptNewer = baseVersion !== undefined && baseVersion !== rec.book.fileVersion;
  storeVersion(rec, bytes, hash, Date.now());
  persist();
  return { fileHash: hash, fileVersion: rec.book.fileVersion, changed: true, keptNewer };
}

function logSession(
  kind: MockSessionEvent['kind'],
  uid: string | null,
  page: number | null,
  reason: StopReason | null,
) {
  state.sessions.push({ kind, uid, page, reason, at: Date.now() });
  persist();
}

// ---------------------------------------------------------------- events (test hooks)

const openPathListeners = new Set<(paths: string[]) => void>();
const dropListeners = new Set<(paths: string[]) => void>();

// ---------------------------------------------------------------- client

export { setMockLatency } from './mock/ankiData';

function sortedEntries(): LibraryEntry[] {
  return state.books.filter((r) => !r.removed).map(entry);
}

const baseClient = {
  kind: 'mock',

  libraryList: () => later(sortedEntries),
  libraryAdd: (path, opts) => later(() => addFromPath(path, !!opts?.replace)),
  libraryRemove: (uid) =>
    later(() => {
      const rec = liveRec(uid);
      rec.removed = true;
      persist();
    }),
  libraryUpdate: (uid, patch) => later(() => update(uid, patch)),
  bookOpen: (uid) =>
    later(() => {
      const rec = liveRec(uid);
      const page = Math.min(state.positions[uid]?.page ?? 0, Math.max(0, rec.book.pages - 1));
      return { book: entry(rec), page };
    }),

  bookBytes: (uid) => later(() => toArrayBuffer(currentBytes(liveRec(uid)))),
  bookSaveVersion: (uid, bytes, baseVersion) => later(() => saveVersion(uid, bytes, baseVersion)),
  bookExport: (uid, path) =>
    later(() => {
      takeExportGrant(path);
      state.files[path] = toBase64(currentBytes(liveRec(uid)));
      persist();
    }),
  exportBytes: (path, bytes) =>
    later(() => {
      takeExportGrant(path);
      state.files[path] = toBase64(new Uint8Array(bytes));
      persist();
    }),
  bookOpenExternal: (uid) =>
    later(() => {
      liveRec(uid);
      state.openedExternally.push(uid);
      persist();
    }),
  docWords: (uid, page) => later(() => pageWords(liveRec(uid), page)),

  positionGet: (uid) =>
    later(() => {
      liveRec(uid);
      return structuredClone(state.positions[uid] ?? null);
    }),
  positionSet: (uid, page, progress) =>
    later(() => {
      const rec = liveRec(uid);
      const p = Math.max(0, Math.min(Math.floor(page), Math.max(0, rec.book.pages - 1)));
      state.positions[uid] = {
        page: p,
        offset: 0,
        cfi: null,
        progress: Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)),
        updatedAt: Date.now(),
      };
      persist();
    }),
  readingSessionStart: (uid, page) =>
    later(() => {
      liveRec(uid);
      logSession('start', uid, page, null);
    }),
  readingSessionHeartbeat: (uid, page) => later(() => logSession('heartbeat', uid, page, null)),
  readingSessionStop: (uid, reason) => later(() => logSession('stop', uid, null, reason)),

  pendingOpenPaths: () =>
    later(() => {
      const paths = state.pendingOpen;
      state.pendingOpen = [];
      persist();
      return paths;
    }),
  devSmoke: () =>
    later(() => {
      const rec = state.books[0] ?? seedState().books[0]!;
      return {
        doc: { pageCount: rec.book.pages, title: rec.book.title, author: rec.book.author },
        page1DataUrl: svgDataUrl(mockCoverSvg(rec.book.title, rec.book.author)),
        words: pageWords(rec, 0).words.length,
        millis: { anki: 38, pdfOpen: 12, pdfText: 4, cover: 21 },
      };
    }),
  devLog: () => Promise.resolve(),
  coverUrl: (uid) => {
    const rec = state.books.find((r) => r.book.bookUid === uid);
    if (!rec) return svgDataUrl(mockCoverSvg('', null));
    return svgDataUrl(mockCoverSvg(rec.book.title, rec.book.author, !rec.book.hasText));
  },
  pickBookFiles: () =>
    later(() => {
      const picked = state.nextPick ?? ['/home/jorge/Livros/Leitura semanal.pdf'];
      state.nextPick = null;
      persist();
      return picked;
    }),
  pickExportPath: (defaultName: string) =>
    later(() => {
      const next = state.nextExportPath;
      delete state.nextExportPath;
      const path = next === undefined ? `/home/jorge/Exportados/${defaultName}` : next;
      if (path !== null) state.exportGrants = [...(state.exportGrants ?? []).filter((p) => p !== path), path].slice(-8);
      persist();
      return path;
    }),
  onOpenPaths: (cb) => listenTo(openPathListeners, cb),
  onDragDropPaths: (cb) => listenTo(dropListeners, cb),
  onWindowCloseRequested: () => () => undefined,
} satisfies Partial<CoreClient>;

/** The whole mock core: library/reader (above) + the Anki parts, one file per feature package. */
export const mockClient: CoreClient = {
  ...baseClient,
  ...createAnkiDecksMock({
    takeExportGrant,
    writeFile: (path, content) => {
      state.files[path] = btoa(unescape(encodeURIComponent(content)));
      persist();
    },
    collectionReplaced: syncCollectionReplaced,
  }),
  ...ankiStudyMock,
  ...ankiNotesMock,
  ...ankiSyncMock,
};

// ---------------------------------------------------------------- e2e handle

/** `window.__leitorMock`: lets Playwright inspect and drive the mock core (the `sync*` members drive the sync mock). */
export interface LeitorMockHandle extends MockSyncHandle {
  readonly books: LibraryEntry[];
  readonly savedVersions: MockSavedVersion[];
  readonly sessions: MockSessionEvent[];
  readonly positions: Record<string, ReadingPosition>;
  readonly files: string[];
  readonly openedExternally: string[];
  reset(): void;
  /** Paths the next "Adicionar livro" dialog returns. */
  setNextPick(paths: string[]): void;
  /** Path the next "Exportar cópia" dialog returns (`null` = cancelled). */
  setNextExportPath(path: string | null): void;
  /** Paths returned by the next `pendingOpenPaths()` (launch with "Abrir com"). */
  setPendingOpen(paths: string[]): void;
  /** Simulates "Abrir com" while running. */
  openPaths(paths: string[]): void;
  /** Simulates dropping files on the window. */
  dropPaths(paths: string[]): void;
  /** The mock Anki collection. */
  readonly anki: MockAnkiHandle;
}

/** `window.__leitorMock.anki`: inspects and drives the mock Anki collection. */
export interface MockAnkiHandle {
  /** Answers, imports, exports, deletes… in order. */
  readonly logs: MockAnkiLog[];
  /** Full deck names. */
  readonly deckNames: string[];
  readonly notetypeNames: string[];
  readonly backups: BackupInfo[];
  readonly dataset: 'seed' | 'colpkg';
  /** Path the next "Importar pacote" dialog returns (`null` = cancelled). */
  setNextPackagePick(path: string | null): void;
  /** Path the next image dialog of the editor returns (`null` = cancelled). */
  setNextImageFile(path: string | null): void;
  /** Fires `anki://changed`. */
  fireChanged(reason?: AnkiChanged['reason']): void;
  /** Fires `anki://page` (what the core sends for the Anki pages: ready, close, importDone…). */
  firePageEvent(e: AnkiPageEvent): void;
  /** Runs the daily backup like the core's ticker (null when today's already exists). */
  dailyBackup(): BackupInfo | null;
}

const ankiHandle: MockAnkiHandle = {
  get logs() {
    return structuredClone(ankiState().logs);
  },
  get deckNames() {
    return ankiState()
      .decks.map((d) => d.name)
      .sort();
  },
  get notetypeNames() {
    return ankiState().notetypes.map((n) => n.name);
  },
  get backups() {
    return structuredClone(ankiState().backups);
  },
  get dataset() {
    return ankiState().dataset;
  },
  setNextPackagePick(path) {
    ankiState().nextPackagePick = path;
    persistAnki();
  },
  setNextImageFile(path) {
    ankiState().nextImageFile = path;
    persistAnki();
  },
  fireChanged(reason = 'page') {
    emitAnkiChanged({ reason });
  },
  firePageEvent(e) {
    emitAnkiPageEvent(e);
  },
  dailyBackup: () => mockDailyBackup(),
};

export const mockHandle: LeitorMockHandle = {
  get books() {
    return sortedEntries();
  },
  get savedVersions() {
    return structuredClone(state.savedVersions);
  },
  get sessions() {
    return structuredClone(state.sessions);
  },
  get positions() {
    return structuredClone(state.positions);
  },
  get files() {
    return Object.keys(state.files);
  },
  get openedExternally() {
    return [...state.openedExternally];
  },
  get anki() {
    return ankiHandle;
  },
  reset() {
    state = seedState();
    persist();
    resetAnki();
    resetSync();
  },
  setNextPick(paths) {
    state.nextPick = paths;
    persist();
  },
  setNextExportPath(path) {
    state.nextExportPath = path;
    persist();
  },
  setPendingOpen(paths) {
    state.pendingOpen = paths;
    persist();
  },
  openPaths(paths) {
    for (const cb of openPathListeners) cb(paths);
  },
  dropPaths(paths) {
    for (const cb of dropListeners) cb(paths);
  },
  syncSetOffline: (offline) => mockSyncHandle.syncSetOffline(offline),
  syncRequireFull: (choice) => mockSyncHandle.syncRequireFull(choice),
  syncSetLastSyncAt: (ms) => mockSyncHandle.syncSetLastSyncAt(ms),
  syncRefuseKey: () => mockSyncHandle.syncRefuseKey(),
  syncStatus: () => mockSyncHandle.syncStatus(),
  get syncNotifications() {
    return mockSyncHandle.syncNotifications;
  },
};

declare global {
  interface Window {
    __leitorMock?: LeitorMockHandle;
  }
}

export function installMockHandle(): void {
  if (typeof window !== 'undefined') window.__leitorMock = mockHandle;
}
