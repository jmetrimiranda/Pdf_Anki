// The Leitor tab's brain (spec 6.4, 6.5): owns the bridge, opens books, records progress and reading sessions,
// and saves PdfCraft's edits as new book versions. Framework-free; React reads it through `subscribe`/`snapshot`.
import { Autosave, realTimers, type FlushReason, type Timers } from './autosave';
import { leitorBridgeMessages } from '../../i18n/pt-BR/leitorBridge';
import {
  BridgeClient,
  MIN_BRIDGE,
  normalizeFind,
  type BridgeIn,
  type MenuItem,
  type PdfcraftTheme,
  type Rect,
} from './bridge';
import type { EpubMarkWord, EpubSectionMarks } from '../../lib/core/types';
import { EpubVocab } from './epubVocab';
import { SessionWiring, type StopReason } from './sessions';
import { frameLoad, LeitorTimings } from './timings';
import { VOCAB_SET, VocabMarks, type VocabMark, type VocabPageMarks } from './vocabMarks';
export type { EpubMarkWord, EpubSectionMarks };

/** What the controller needs from the core (adapted from `CoreClient` in index.ts; faked in tests). */
export interface LeitorCore {
  /** book_open(uid): file name for PdfCraft's tab, title, last page read, the known page count and current version. */
  openInfo(uid: string): Promise<OpenInfo>;
  /** book_bytes(uid): the current version. */
  bytes(uid: string): Promise<ArrayBuffer | Uint8Array>;
  /**
   * book_save_version: `baseVersion` is the version the PdfCraft tab was opened from. `keptNewer`: the current
   * version was newer than that base (imported while the tab was open) and the core kept it as a copy.
   */
  saveVersion(
    uid: string,
    bytes: Uint8Array,
    baseVersion?: number,
  ): Promise<{ fileVersion: number; keptNewer: boolean }>;
  /** Asks where to export (Tauri save dialog); null when cancelled. */
  pickExportPath(defaultName: string): Promise<string | null>;
  exportBook(uid: string, path: string): Promise<void>;
  exportBytes(path: string, bytes: Uint8Array): Promise<void>;
  openExternal(uid: string): Promise<void>;
  /** `cfi`: the EPUB location (absent for a PDF). */
  positionSet(uid: string, page: number, progress: number, cfi?: string | null): Promise<void>;
  setPages(uid: string, pages: number): Promise<void>;
  sessionStart(uid: string, page: number): Promise<void>;
  sessionHeartbeat(uid: string, page: number): Promise<void>;
  sessionStop(uid: string, reason: StopReason): Promise<void>;
  /** vocab_marks(uid, pages): the vocabulary marks of those pages; `null` when the book was never scanned. */
  vocabMarks(uid: string, pages: number[]): Promise<VocabPageMarks[] | null>;
  /** vocab_epub_marks(uid, sections): the marks of those EPUB sections; `null` when never scanned. */
  epubMarks(uid: string, sections: number[]): Promise<EpubSectionMarks[] | null>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface OpenInfo {
  name: string;
  title: string;
  /** Last page read (0-based); for an EPUB the spine section. */
  page: number;
  /** Page count; for an EPUB the spine section count. */
  pages: number;
  fileVersion: number;
  /** `epub` books open in the app's EPUB reader, not in PdfCraft (spec 7.1). */
  format: 'pdf' | 'epub';
  /** The EPUB's last location read (null: never opened, or a PDF). */
  cfi: string | null;
}

/** Where the EPUB reader is (its `onLocation`). */
export interface EpubLocation {
  /** 0-based spine section on screen. */
  section: number;
  sectionCount: number;
  cfi: string;
  /** 0..=1 through the book. */
  fraction: number;
  /** The TOC label of the section on screen (null: none). */
  tocLabel: string | null;
}

/** A selection in the EPUB reader. */
export interface EpubSelectionInfo {
  text: string;
  /** CFI range of the selection. */
  cfi: string;
  section: number;
  tocLabel: string | null;
}

/**
 * What the controller drives in the EPUB reader (features/epub's handle, adapted in LeitorHost). One EPUB at a time.
 */
export interface EpubFront {
  /** Loads a book; resolves with its section count once it shows, null on failure (the reader shows the error). */
  open(o: {
    uid: string;
    bytes: ArrayBuffer | Uint8Array;
    title: string;
    cfi: string | null;
    section?: number;
    find?: string | null;
  }): Promise<{ sectionCount: number } | null>;
  /** Goes to a CFI, or a section (finding `find` there). Resolves whether `find` was found (true without find). */
  goTo(o: { cfi?: string | null; section?: number; find?: string | null }): Promise<boolean>;
  openDrawer(which: EpubDrawer): void;
  /** The vocabulary forms underlined in `section` (`null` clears that section). */
  setVocabMarks(section: number, words: EpubMarkWord[] | null): void;
  clearVocabMarks(): void;
  /** The current selection, right now (null: none). */
  selectionNow(): EpubSelectionInfo | null;
  /** Writes the pending location now (before another book replaces this one). */
  flush?(): void;
}

export type EpubDrawer = 'toc' | 'annotations' | 'search';

/** The EPUB in the reader (spec 7.1); `section`/`sectionCount` play the role of page/pageCount when it is in front. */
export interface EpubState {
  uid: string;
  title: string;
  section: number;
  sectionCount: number;
  cfi: string | null;
  fraction: number;
  tocLabel: string | null;
}

/** Which reader is in front in the Leitor tab: PdfCraft (PDFs) or the EPUB reader. */
export type LeitorFront = 'pdfcraft' | 'epub';

/** The text selected in the book in front (`pdfcraft:selection`). */
export interface LeitorSelection {
  id: string;
  /** 0-based PdfCraft page; for an EPUB the spine section. */
  page: number;
  text: string;
  /** Page view space points, y down (empty for an EPUB). */
  rects: Rect[];
  /** EPUB only: the selection's CFI range. */
  cfi?: string | null;
  /** `chapter` for an EPUB selection (absent: a PDF page). */
  unit?: 'page' | 'chapter';
  /** EPUB only: the TOC label of the section (the Fonte's label). */
  label?: string | null;
}

/** The selection a panel request carries; `id` is null for a document outside the library. */
export type PanelSelection = Omit<LeitorSelection, 'id'> & { id: string | null };

export type PanelRequestKind = 'card' | 'ai' | 'define';

/** Something the "Painel Anki do livro" must show: the card form, the AI notice or the definition popover. */
export interface PanelRequest {
  kind: PanelRequestKind;
  /** PdfCraft's selection menu, an app shortcut (Ctrl+Shift+N / Alt+C) or the panel's own button. */
  via: 'menu' | 'shortcut' | 'button';
  /**
   * `id` is null for a document PdfCraft opened by itself (not in the library): "Definir palavra" and the AI notice
   * still work; "Criar card" explains that the book must be added to the library first.
   */
  selection: PanelSelection | null;
  /** The clicked menu item in viewport CSS px (iframe rect + PdfCraft's iframe-relative anchor); null otherwise. */
  anchor: { x: number; y: number; width: number; height: number } | null;
}

/** Result of the last `pdfcraft:goto` with a find (`pdfcraft:found`). */
export interface FoundResult {
  id: string;
  page: number;
  query: string;
  found: boolean;
}

/** A click on a highlighted word (`pdfcraft:mark-click` of the 'vocab' set, or the EPUB reader's) the popover shows. */
export interface MarkClick {
  id: string;
  /** 0-based page (an EPUB's spine section). */
  page: number;
  /** The mark's index on the page (as sent). */
  index: number;
  mark: VocabMark;
  /** The word on screen, viewport CSS px. */
  anchor: { x: number; y: number; width: number; height: number };
}

/** The app's items PdfCraft last showed in a selection menu (iframe-relative CSS px rects; for tests). */
export interface MenuShown {
  id: string | null;
  items: { key: string; rect: Rect }[];
}

/** Items added to PdfCraft's own selection menu (spec 6.2, 10.2, 10.3, 12.7); keys are the PanelRequest kinds. */
export const MENU_ITEMS: readonly MenuItem[] = [
  { key: 'card', label: leitorBridgeMessages['leitor.menu.card'] },
  { key: 'ai', label: leitorBridgeMessages['leitor.menu.ai'] },
  { key: 'define', label: leitorBridgeMessages['leitor.menu.define'] },
];

function isPanelKind(key: string): key is PanelRequestKind {
  return key === 'card' || key === 'ai' || key === 'define';
}

export interface LeitorUi {
  navigateToLeitor(): void;
  toast(
    key:
      | 'reader.saveFailed'
      | 'reader.exported'
      | 'reader.keptNewer'
      | 'reader.openExternalFailed'
      | 'leitor.gotoNotFound'
      | 'bookPanel.selectFirst'
      | 'bookPanel.notInLibrary'
      | 'vocabReading.marksFailed'
      | 'reader.reloadedAfterOcr'
      | 'epub.openFailed',
    tone: 'error' | 'success' | 'info',
    vars?: Record<string, string>,
  ): void;
  /** Library data changed (pages, position, version): mark the cached queries stale. */
  libraryChanged(): void;
}

export type StartStatus = 'idle' | 'loading' | 'ready' | 'failed';
export type StartError = 'build-missing' | 'old-bridge' | 'timeout' | 'error';

export interface OpenError {
  uid: string;
  title: string;
  /** Who failed: PdfCraft (`pdfcraft:failed`), the wait for `pdfcraft:active`, or the core (reading the file). */
  kind: 'pdfcraft' | 'timeout' | 'core';
  /** PdfCraft's or the core's technical message, when there is one (empty on a timeout). Shown as a detail line. */
  error: string;
}

export interface LeitorSnapshot {
  /** The iframe exists (mounted on the first visit to /leitor or the first openBook, never unmounted). */
  mounted: boolean;
  /** Bumped to recreate the iframe after a startup failure ("Tentar de novo"). */
  generation: number;
  status: StartStatus;
  startError: StartError | null;
  /** PdfCraft's own startup error text (for `reader.startFailedHint`). */
  startDetail: string | null;
  /** The Leitor tab is on screen. */
  visible: boolean;
  /** Book in front in PdfCraft (null: home screen or a file opened inside PdfCraft). */
  activeId: string | null;
  activeTitle: string | null;
  page: number;
  pageCount: number;
  /** Book being opened (between `open` and `active`). */
  openingId: string | null;
  /** Its title, once the core told it (null before). */
  openingTitle: string | null;
  openError: OpenError | null;
  theme: PdfcraftTheme | null;
  /** The panel is showing (effective: in a compact window it starts closed and floats over PdfCraft). */
  panelOpen: boolean;
  /** Compact window: the panel floats over the iframe instead of taking its width; toggles are not remembered. */
  panelCompact: boolean;
  /** Books with edits not stored as a version yet. */
  unsavedIds: string[];
  /** The close dialog (unsaved edits) is showing. */
  closePrompt: boolean;
  /** Shorthands for the shell: `status === 'ready'`, `activeId`, the ids sent to PdfCraft. */
  ready: boolean;
  activeBookUid: string | null;
  openIds: string[];
  /** Text selected in the book in front (null: none, or another document is in front). */
  selection: LeitorSelection | null;
  /** Result of the last goto with a find. */
  found: FoundResult | null;
  /** The app's items in the last selection menu PdfCraft showed. */
  menuShown: MenuShown | null;
  /** Which reader is in front; activeId/activeTitle/page/pageCount follow it. */
  front: LeitorFront;
  /** The EPUB loaded in the EPUB reader (stays loaded while PdfCraft is in front). */
  epub: EpubState | null;
  /** PdfCraft has library books open (the EPUB reader offers "Voltar aos PDFs"). */
  pdfOpen: boolean;
  /** The EPUB reader is mounted (the first EPUB opened; never unmounted, like the iframe). */
  epubMounted: boolean;
}

const PANEL_KEY = 'leitor.panelOpen';
export const READY_TIMEOUT_MS = 30_000;
export const POSITION_DEBOUNCE_MS = 1_000;

/** Time to wait for `active` after `open`: 20 s + 1 s per 5 MB. */
export function openTimeoutMs(byteLength: number): number {
  return 20_000 + Math.ceil(byteLength / (5 * 1024 * 1024)) * 1_000;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A wait for `pdfcraft:active`; `goto` when it answers a `pdfcraft:goto` (no bytes sent). */
interface OpenWait {
  d: Deferred<boolean>;
  timer: unknown;
  goto?: { held: FoundResult | null; grace: unknown };
}

/**
 * How long "Card da seleção" waits for PdfCraft to hand over a selection still in its 300 ms debounce
 * (`pdfcraft:selection-now` → `pdfcraft:selection-sent`, two frames normally) before using the last one it has.
 */
export const SELECTION_NOW_TIMEOUT_MS = 400;

/** After a `found: false` without `active`, how long to wait before deciding PdfCraft no longer has the tab. */
export const GOTO_GRACE_MS = 1_500;
/** `openFailures` value for a goto PdfCraft answered as for a tab it doesn't have. */
const MISSING_TAB = '\u0000missing-tab';

/** `openBook` options: where to open (`page` 0-based; for an EPUB the spine section), what to find, the EPUB CFI. */
export interface OpenOptions {
  page?: number;
  find?: string | null;
  /** EPUB only: the location to open at (wins over `page`). */
  cfi?: string | null;
  /** Internal: reopen without switching to the Leitor tab or bringing the reader to front. */
  quiet?: boolean;
}

/** How long `openBook` waits for the EPUB reader to mount before giving up. */
export const EPUB_FRONT_TIMEOUT_MS = 10_000;

export class StartFailed extends Error {
  constructor(readonly reason: StartError) {
    super(`PdfCraft did not start (${reason})`);
  }
}

export interface ControllerOptions {
  core: LeitorCore;
  /** Same-origin as the iframe. */
  origin?: string;
  host?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  timers?: Timers;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
  timings?: LeitorTimings;
}

export class LeitorController {
  readonly core: LeitorCore;
  readonly bridge: BridgeClient;
  readonly autosave: Autosave;
  readonly sessions: SessionWiring;
  /** The vocabulary highlight (spec 12.7): `pdfcraft:marks` of the set 'vocab'. */
  readonly vocab: VocabMarks;
  /** How long the tab takes to show up (window.__leitorTimings). */
  readonly timings: LeitorTimings;
  private ui: LeitorUi | null = null;
  private frameWindow: Window | null = null;
  private readonly timers: Timers;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly listeners = new Set<() => void>();
  private snap: LeitorSnapshot;
  private readyWait: Deferred<void> | null = null;
  private readyTimer: unknown;
  private readonly titles = new Map<string, string>();
  private readonly knownPages = new Map<string, number>();
  /** The `fileVersion` each open PdfCraft tab holds (sent with its saves, spec 6.5). */
  private readonly baseVersions = new Map<string, number>();
  private readonly openWaits = new Map<string, OpenWait>();
  /** The last page PdfCraft reported for each open book (reopened there after OCR). */
  private readonly lastPages = new Map<string, number>();
  private readonly positionTimers = new Map<string, { timer: unknown; page: number; pageCount: number }>();
  private closeResolver: ((ok: boolean) => void) | null = null;
  private readonly openFailures = new Map<string, string>();
  private frameElement: { getBoundingClientRect(): { left: number; top: number } } | null = null;
  private readonly panelListeners = new Set<(r: PanelRequest) => void>();
  private readonly markListeners = new Set<(c: MarkClick) => void>();
  /** A request made while no panel was listening (e.g. the shortcut before the Leitor was ever shown). */
  private pendingRequest: PanelRequest | null = null;
  /** `pdfcraft:selection-now` requests waiting for their `pdfcraft:selection-sent`, by seq. */
  private readonly selectionWaits = new Map<number, { resolve: () => void; timer: unknown }>();
  private selectionSeq = 0;
  /** PdfCraft's own view (the snapshot shows it while PdfCraft is in front). */
  private pdfView: Pick<LeitorSnapshot, 'activeId' | 'activeTitle' | 'page' | 'pageCount'> = {
    activeId: null,
    activeTitle: null,
    page: 0,
    pageCount: 0,
  };
  /** The EPUB reader's handle (registered by LeitorHost once mounted). */
  private epubFront: EpubFront | null = null;
  private epubFrontWaits: ((f: EpubFront) => void)[] = [];
  /** The EPUB location not written yet (debounced like the PDF pages). */
  private epubPending: { timer: unknown; uid: string; loc: EpubLocation } | null = null;
  /** Bumped by every EPUB open: a slower earlier open never takes over. */
  private epubSeq = 0;
  /** The vocabulary highlight of the EPUB reader (spec 12.7 for EPUB). */
  readonly epubVocab: EpubVocab;
  constructor(opts: ControllerOptions) {
    this.core = opts.core;
    this.timers = opts.timers ?? realTimers;
    this.timings = opts.timings ?? new LeitorTimings();
    this.storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
    const origin = opts.origin ?? globalThis.location?.origin ?? '';
    const host = opts.host ?? (globalThis as unknown as Window);
    this.snap = {
      mounted: false,
      generation: 0,
      status: 'idle',
      startError: null,
      startDetail: null,
      visible: false,
      activeId: null,
      activeTitle: null,
      page: 0,
      pageCount: 0,
      openingId: null,
      openingTitle: null,
      openError: null,
      theme: null,
      panelOpen: this.storage?.getItem(PANEL_KEY) !== '0',
      panelCompact: false,
      unsavedIds: [],
      closePrompt: false,
      ready: false,
      activeBookUid: null,
      openIds: [],
      selection: null,
      found: null,
      menuShown: null,
      front: 'pdfcraft',
      epub: null,
      pdfOpen: false,
      epubMounted: false,
    };
    this.bridge = new BridgeClient({
      host,
      origin,
      frame: () => this.frameWindow,
      onMessage: (m) => this.onMessage(m),
      warn: (msg) => this.core.log('warn', msg),
    });
    this.autosave = new Autosave({
      timers: this.timers,
      requestSave: (id) => this.bridge.requestSave(id),
      store: async (id, bytes) => {
        const saved = await this.core.saveVersion(id, bytes, this.baseVersions.get(id));
        // The tab's content is now this version.
        this.baseVersions.set(id, saved.fileVersion);
        // Its marks stay in PdfCraft (they are not part of the file); the core tells whether the words moved.
        this.vocab.refresh(id);
        if (saved.keptNewer) {
          this.core.log('warn', `leitor: ${id} was saved over a newer version; the core kept that version`);
          this.ui?.toast('reader.keptNewer', 'info', { titulo: this.titles.get(id) ?? id.slice(0, 8) });
        }
      },
      exportCopy: async (id, name) => {
        const path = await this.core.pickExportPath(name || `${this.titles.get(id) ?? 'livro'}.pdf`);
        if (!path) return;
        await this.core.exportBook(id, path);
        this.ui?.toast('reader.exported', 'success');
      },
      exportUnbound: async (name, bytes) => {
        const path = await this.core.pickExportPath(name || 'documento.pdf');
        if (!path) return;
        await this.core.exportBytes(path, bytes);
        this.ui?.toast('reader.exported', 'success');
      },
      onStoreFailed: (id, e) => {
        this.core.log('error', `leitor: saving ${id || 'export'} failed: ${errorText(e)}`);
        this.ui?.toast('reader.saveFailed', 'error', {
          titulo: (id && this.titles.get(id)) || id.slice(0, 8) || 'documento',
          erro: errorText(e),
        });
        this.syncUnsaved();
      },
      onStored: () => {
        this.ui?.libraryChanged();
        this.syncUnsaved();
      },
    });
    this.vocab = new VocabMarks({
      fetch: (uid, pages) => this.core.vocabMarks(uid, pages),
      isOpen: (uid) => this.bridge.isOpen(uid),
      sendMarks: (uid, set, pages) => this.bridge.sendMarks(uid, set, pages),
      clearMarks: (uid, set) => this.bridge.clearMarks(uid, set),
      storage: this.storage,
      onError: (uid, e, first) => {
        // Silent in the reader: a log line, and a toast only the first time.
        this.warn(`vocab_marks ${uid.slice(0, 8)}`, e);
        if (first) this.ui?.toast('vocabReading.marksFailed', 'error');
      },
    });
    this.epubVocab = new EpubVocab({
      fetch: (uid, sections) => this.core.epubMarks(uid, sections),
      show: (uid, section, words) => {
        if (this.snap.epub?.uid === uid) this.epubFront?.setVocabMarks(section, words);
      },
      clear: (uid) => {
        if (this.snap.epub?.uid === uid) this.epubFront?.clearVocabMarks();
      },
      isOn: (uid) => this.vocab.isOn(uid),
      onError: (uid, e) => this.warn(`vocab_epub_marks ${uid.slice(0, 8)}`, e),
    });
    this.sessions = new SessionWiring({
      start: (uid, page) => void this.core.sessionStart(uid, page).catch((e) => this.warn('session start', e)),
      heartbeat: (uid, page) =>
        void this.core.sessionHeartbeat(uid, page).catch((e) => this.warn('session heartbeat', e)),
      stop: (uid, reason) => void this.core.sessionStop(uid, reason).catch((e) => this.warn('session stop', e)),
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  // ------------------------------------------------------------ store

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): LeitorSnapshot => this.snap;

  /**
   * Patches the snapshot. `activeId`/`activeTitle`/`page`/`pageCount` in a patch are PdfCraft's view; the snapshot
   * shows the EPUB's (section as the page) instead while the EPUB reader is in front.
   */
  private set(patch: Partial<LeitorSnapshot>) {
    for (const k of ['activeId', 'activeTitle', 'page', 'pageCount'] as const) {
      if (k in patch) (this.pdfView as Record<string, unknown>)[k] = patch[k];
    }
    const next = { ...this.snap, ...patch };
    const epubFront = next.front === 'epub' && next.epub !== null;
    const view = epubFront
      ? {
          activeId: next.epub!.uid,
          activeTitle: next.epub!.title,
          page: next.epub!.section,
          pageCount: next.epub!.sectionCount,
        }
      : this.pdfView;
    const openIds = [...this.bridge.state.openIds].sort();
    this.snap = {
      ...next,
      ...view,
      ready: next.status === 'ready',
      activeBookUid: view.activeId,
      openIds: openIds.join() === this.snap.openIds.join() ? this.snap.openIds : openIds,
      pdfOpen: openIds.length > 0,
    };
    for (const fn of this.listeners) fn();
  }

  private syncUnsaved() {
    const ids = this.autosave.dirtyIds.sort();
    if (ids.join() !== this.snap.unsavedIds.join()) this.set({ unsavedIds: ids });
  }

  private warn(what: string, e: unknown) {
    this.core.log('warn', `leitor: ${what} failed: ${String(e)}`);
  }

  // ------------------------------------------------------------ wiring from React

  setUi(ui: LeitorUi | null) {
    this.ui = ui;
  }

  /** Creates the iframe (idempotent) and starts waiting for `pdfcraft:ready`. */
  mount() {
    this.bridge.attach();
    if (this.snap.mounted) return;
    this.timings.mounting();
    this.beginStart();
    this.set({ mounted: true });
  }

  private beginStart() {
    this.readyWait = deferred<void>();
    // Nobody may be waiting yet; don't report an unhandled rejection.
    this.readyWait.promise.catch(() => {});
    this.timers.clearTimeout(this.readyTimer);
    this.readyTimer = this.timers.setTimeout(() => this.startFailed('timeout'), READY_TIMEOUT_MS);
    this.set({ status: 'loading', startError: null, startDetail: null });
  }

  /** "Tentar de novo" after a startup failure: a fresh iframe. */
  restart() {
    this.bridge.reset();
    this.vocab.reset();
    this.frameWindow = null;
    this.beginStart();
    this.set({
      generation: this.snap.generation + 1,
      activeId: null,
      activeTitle: null,
      openingId: null,
      openingTitle: null,
      ...this.pdfFrontReset(),
    });
  }

  /** What a new PdfCraft document clears in the snapshot: the selection and finds, when PdfCraft is in front. */
  private pdfFrontReset(): Partial<LeitorSnapshot> {
    return this.snap.front === 'pdfcraft' ? { selection: null, found: null, menuShown: null } : { menuShown: null };
  }

  /** The iframe loaded a new document (it reloaded itself): nothing is open in it any more. */
  frameReloaded() {
    // The EPUB reader's session is not PdfCraft's to end.
    if (this.snap.front === 'pdfcraft') this.sessions.active(null, 0);
    this.bridge.reset();
    this.vocab.reset();
    for (const id of [...this.openWaits.keys()]) this.resolveOpen(id, false);
    this.beginStart();
    this.set({
      activeId: null,
      activeTitle: null,
      openingId: null,
      openingTitle: null,
      page: 0,
      pageCount: 0,
      ...this.pdfFrontReset(),
    });
  }

  /** The iframe's window (on its `load`), or null when it goes away. */
  setFrameWindow(win: Window | null) {
    this.frameWindow = win;
  }

  /** The iframe element (its position turns PdfCraft's iframe-relative menu anchors into viewport coordinates). */
  setFrameElement(el: { getBoundingClientRect(): { left: number; top: number } } | null) {
    this.frameElement = el;
  }

  setVisible(visible: boolean) {
    if (visible === this.snap.visible) return;
    this.set({ visible });
    if (visible && this.snap.status === 'ready') this.timings.shown(this.frameWindow);
    // Back from another tab (a scan, a generated deck, "Já sei" in the report): the marks may have changed.
    if (visible) this.refreshVocab();
    if (!visible) {
      this.timings.hidden();
      // Leaving the Leitor tab (spec 6.4/6.5): save now, record the page, end the session.
      this.flushPositions();
      void this.autosave.flush('tab');
    }
    this.sessions.setTabVisible(visible);
  }

  setPageVisible(visible: boolean) {
    this.sessions.setPageVisible(visible);
  }

  togglePanel(open?: boolean) {
    const next = open ?? !this.snap.panelOpen;
    // Only the wide-window choice is remembered: the compact one is a temporary overlay.
    if (!this.snap.panelCompact) this.storage?.setItem(PANEL_KEY, next ? '1' : '0');
    this.set({ panelOpen: next });
  }

  /**
   * The window became compact (or wide again). Compact: the panel closes without touching the remembered choice and
   * opens as an overlay on demand; wide: the remembered choice comes back.
   */
  setPanelCompact(compact: boolean) {
    if (compact === this.snap.panelCompact) return;
    this.set({
      panelCompact: compact,
      panelOpen: compact ? false : this.storage?.getItem(PANEL_KEY) !== '0',
    });
  }

  // ------------------------------------------------------------ bridge events

  private startFailed(reason: StartError, detail: string | null = null) {
    this.timers.clearTimeout(this.readyTimer);
    if (this.snap.status === 'failed') return;
    this.set({ status: 'failed', startError: reason, startDetail: detail });
    this.readyWait?.reject(new StartFailed(reason));
    for (const [, w] of this.openWaits) w.d.resolve(false);
  }

  private onMessage(m: BridgeIn) {
    switch (m.type) {
      case 'pdfcraft:ready':
        this.timers.clearTimeout(this.readyTimer);
        if (m.bridge < MIN_BRIDGE) {
          this.startFailed('old-bridge');
          return;
        }
        this.timings.ready(frameLoad(this.frameWindow));
        // A new PdfCraft document (first start or a reload) knows none of the app's menu items.
        this.bridge.setMenuItems(MENU_ITEMS);
        this.set({ status: 'ready', startError: null });
        this.readyWait?.resolve();
        return;
      case 'pdfcraft:failed':
        if (m.id) {
          this.vocab.forget(m.id);
          this.openFailures.set(m.id, m.error);
          this.resolveOpen(m.id, false);
          return;
        }
        if (this.snap.status !== 'ready') {
          if (m.error === 'build-missing') this.startFailed('build-missing');
          else this.startFailed('error', m.error);
        } else this.core.log('error', `leitor: PdfCraft failed: ${m.error}`);
        return;
      case 'pdfcraft:active':
        this.onActive(m.id, m.page, m.pageCount);
        return;
      case 'pdfcraft:page': {
        if (m.id === null) return;
        const pageCount = m.pageCount ?? (m.id === this.pdfView.activeId ? this.pdfView.pageCount : 0);
        if (m.id === this.pdfView.activeId) {
          this.set({ page: m.page, ...(m.pageCount !== null ? { pageCount: m.pageCount } : {}) });
        }
        this.lastPages.set(m.id, m.page);
        this.schedulePosition(m.id, m.page, pageCount);
        if (this.snap.front === 'pdfcraft') this.sessions.activity(m.id, m.page);
        this.vocab.view(m.id, m.page, pageCount);
        return;
      }
      case 'pdfcraft:activity':
        if (m.id === null) return;
        this.autosave.activity(m.id);
        if (this.snap.front === 'pdfcraft') this.sessions.activity(m.id);
        return;
      case 'pdfcraft:dirty':
        this.autosave.setDirty(this.bridge.state.dirtyIds);
        this.syncUnsaved();
        return;
      case 'pdfcraft:save':
        void this.autosave.onSave(m).finally(() => this.syncUnsaved());
        return;
      case 'pdfcraft:save-failed':
        this.autosave.onSaveFailed(m.id, m.error);
        return;
      case 'pdfcraft:theme':
        this.set({ theme: m.theme });
        return;
      case 'pdfcraft:selection':
        this.onSelection(m.id, m.page, m.text, m.rects);
        return;
      case 'pdfcraft:menu': {
        if (!isPanelKind(m.key)) return;
        // PdfCraft shows our items for every document, also those it opened by itself (id null): the panel still
        // defines the word or shows the AI notice; a card needs a library book (its Fonte links to it).
        if (m.id === null && m.key === 'card') {
          this.ui?.toast('bookPanel.notInLibrary', 'info');
          return;
        }
        const selection = m.text.trim() ? { id: m.id, page: m.page, text: m.text, rects: m.rects } : null;
        // The menu may beat the debounced `pdfcraft:selection`: the clicked selection is the current one.
        if (m.id !== null && m.id === this.pdfView.activeId && selection)
          this.set({ selection: { ...selection, id: m.id } });
        this.emitPanelRequest({ kind: m.key, via: 'menu', selection, anchor: this.viewportAnchor(m.anchor) });
        return;
      }
      case 'pdfcraft:menu-shown':
        this.set({ menuShown: { id: m.id, items: m.items } });
        return;
      case 'pdfcraft:selection-sent':
        // Messages arrive in order: every wait up to this seq has its selection by now.
        for (const seq of [...this.selectionWaits.keys()]) {
          if (m.seq === null || seq <= m.seq) this.endSelectionWait(seq);
        }
        return;
      case 'pdfcraft:mark-click':
        this.markClicked(m.id, m.set, m.page, m.index, m.rect);
        return;
      case 'pdfcraft:marks-shown':
        return;
      case 'pdfcraft:found': {
        if (m.id === null) return;
        const result: FoundResult = { id: m.id, page: m.page, query: m.query, found: m.found };
        const goto = this.openWaits.get(m.id)?.goto;
        if (goto) {
          // No `active` yet for this goto: it may still come (same PdfCraft frame), or never, when PdfCraft no
          // longer has the tab (it then answers only with found: false).
          goto.held = result;
          this.timers.clearTimeout(goto.grace);
          if (!m.found) {
            const id = m.id;
            goto.grace = this.timers.setTimeout(() => {
              this.openFailures.set(id, MISSING_TAB);
              this.resolveOpen(id, false);
            }, GOTO_GRACE_MS);
          }
          return;
        }
        this.applyFound(result);
        return;
      }
    }
  }

  private applyFound(result: FoundResult) {
    this.set({ found: result });
    if (!result.found) this.ui?.toast('leitor.gotoNotFound', 'info', { pagina: String(result.page + 1) });
  }

  private onSelection(id: string | null, page: number, text: string, rects: Rect[]) {
    // Only the book in front has a selection the panel can use; id-less documents are not the library's.
    if (id === null || id !== this.pdfView.activeId || this.snap.front !== 'pdfcraft') return;
    if (!text.trim()) {
      if (this.snap.selection !== null) this.set({ selection: null });
      return;
    }
    this.set({ selection: { id, page, text, rects } });
  }

  private markClicked(id: string, set: string, page: number, index: number, rect: Rect) {
    if (set !== VOCAB_SET) return;
    const mark = this.vocab.markAt(id, page, index);
    const anchor = this.viewportAnchor(rect);
    if (!mark || !anchor) return;
    for (const fn of [...this.markListeners]) fn({ id, page, index, mark, anchor });
  }

  private viewportAnchor(anchor: Rect | null): PanelRequest['anchor'] {
    if (!anchor) return null;
    let left = 0;
    let top = 0;
    try {
      const r = this.frameElement?.getBoundingClientRect();
      left = r?.left ?? 0;
      top = r?.top ?? 0;
    } catch {
      // Detached element: keep the iframe-relative position.
    }
    return { x: left + anchor[0], y: top + anchor[1], width: anchor[2], height: anchor[3] };
  }

  private emitPanelRequest(r: PanelRequest) {
    if (r.kind === 'card') {
      // The form lives in the panel: show it (an overlay in a compact window) on the Leitor tab.
      this.ui?.navigateToLeitor();
      if (!this.snap.panelOpen) this.togglePanel(true);
    }
    if (this.panelListeners.size === 0) {
      this.pendingRequest = r;
      return;
    }
    for (const fn of [...this.panelListeners]) fn(r);
  }

  private onActive(id: string | null, page: number, pageCount: number) {
    const previous = this.pdfView.activeId;
    if (previous !== id) {
      if (previous !== null) {
        // Document switch (spec 6.4/6.5): record its page, save its edits.
        this.flushPositions(previous);
        void this.autosave.flush('doc', [previous]);
      }
    }
    this.set({
      activeId: id,
      activeTitle: id ? (this.titles.get(id) ?? null) : null,
      page,
      pageCount,
      ...(previous !== id && this.snap.front === 'pdfcraft' ? { selection: null, menuShown: null } : {}),
      ...(id !== null && this.snap.openError?.uid === id ? { openError: null } : {}),
    });
    if (this.snap.front === 'pdfcraft') this.sessions.active(id, page);
    if (id !== null) {
      this.lastPages.set(id, page);
      this.resolveOpen(id, true);
      this.vocab.view(id, page, pageCount);
      const known = this.knownPages.get(id);
      if (pageCount > 0 && known !== pageCount) {
        this.knownPages.set(id, pageCount);
        void this.core
          .setPages(id, pageCount)
          .then(() => this.ui?.libraryChanged())
          .catch((e) => this.warn('library_update', e));
      }
    }
  }

  private resolveOpen(id: string, ok: boolean) {
    const w = this.openWaits.get(id);
    if (!w) return;
    this.openWaits.delete(id);
    this.timers.clearTimeout(w.timer);
    if (w.goto) {
      this.timers.clearTimeout(w.goto.grace);
      if (ok && w.goto.held) this.applyFound(w.goto.held);
    }
    w.d.resolve(ok);
  }

  // ------------------------------------------------------------ progress

  private schedulePosition(id: string, page: number, pageCount: number) {
    const prev = this.positionTimers.get(id);
    if (prev) this.timers.clearTimeout(prev.timer);
    const timer = this.timers.setTimeout(() => this.writePosition(id), POSITION_DEBOUNCE_MS);
    this.positionTimers.set(id, { timer, page, pageCount });
  }

  private writePosition(id: string) {
    const p = this.positionTimers.get(id);
    if (!p) return;
    this.positionTimers.delete(id);
    this.timers.clearTimeout(p.timer);
    const progress = p.pageCount > 0 ? Math.min(1, (p.page + 1) / p.pageCount) : 0;
    void this.core
      .positionSet(id, p.page, progress)
      .then(() => this.ui?.libraryChanged())
      .catch((e) => this.warn('position_set', e));
  }

  private flushPositions(only?: string) {
    for (const id of [...this.positionTimers.keys()]) {
      if (only === undefined || id === only) this.writePosition(id);
    }
    if (only === undefined || this.epubPending?.uid === only) this.flushEpubPosition();
  }

  // ------------------------------------------------------------ public API

  /** Resolves once PdfCraft is ready; rejects with StartFailed. Mounts the iframe if needed. */
  async whenReady(): Promise<void> {
    this.mount();
    if (this.snap.status === 'ready') return;
    if (this.snap.status === 'failed') throw new StartFailed(this.snap.startError ?? 'error');
    await this.readyWait?.promise;
  }

  /**
   * Opens a library book in PdfCraft at its last page (spec 6.4), or at `opts.page` (0-based; "Abrir no livro" from a
   * card's Fonte link and `leitor://` deep links, spec 10.2). With `opts.find`, PdfCraft then runs its own find for
   * that text on (or near) the page (`pdfcraft:goto`); the result arrives as `pdfcraft:found` (snapshot `found`, a
   * toast when not found). A book PdfCraft already has gets only `pdfcraft:goto` (no bytes); a closed one is opened at
   * the page and gets the goto after `pdfcraft:active`. Resolves true when PdfCraft reports the book active; false
   * when it failed or timed out (the overlay offers the system viewer and a retry). Without page and find, a book
   * PdfCraft already has is brought to front where the reader left it.
   */
  async openBook(uid: string, opts?: OpenOptions): Promise<boolean> {
    if (!opts?.quiet) this.ui?.navigateToLeitor();
    // An EPUB the reader already holds needs nothing from PdfCraft.
    if (this.snap.epub?.uid === uid) return this.openEpub(uid, null, opts);
    this.set({ openError: null, openingId: uid, openingTitle: this.titles.get(uid) ?? null });
    let info: OpenInfo;
    try {
      info = await this.core.openInfo(uid);
    } catch (e) {
      this.warn('book_open', e);
      this.set({
        openingId: null,
        openingTitle: null,
        openError: { uid, title: this.titles.get(uid) ?? '', kind: 'core', error: errorText(e) },
      });
      return false;
    }
    this.titles.set(uid, info.title);
    if (info.format === 'epub') {
      if (this.snap.openingId === uid) this.set({ openingId: null, openingTitle: null });
      return this.openEpub(uid, info, opts);
    }
    if (!opts?.quiet) this.showFront('pdfcraft');
    try {
      await this.whenReady();
    } catch {
      this.set({ openingId: null, openingTitle: null });
      return false;
    }
    const askedPage = opts?.page;
    const hasPage = askedPage !== undefined && Number.isFinite(askedPage);
    const find = normalizeFind(opts?.find);
    const goto = hasPage || find !== null;
    // A tab PdfCraft already has only needs a goto: don't read the file.
    const gotoOnly = goto && this.bridge.isOpen(uid);
    let bytes: ArrayBuffer | Uint8Array | null = null;
    try {
      if (!gotoOnly) bytes = await this.core.bytes(uid);
    } catch (e) {
      this.warn('book_open', e);
      this.set({
        openingId: null,
        openingTitle: null,
        openError: { uid, title: this.titles.get(uid) ?? '', kind: 'core', error: errorText(e) },
      });
      return false;
    }
    this.knownPages.set(uid, info.pages);
    if (this.pdfView.activeId === uid && !goto) {
      // Already in front and no page asked for: nothing to wait for.
      this.set({ openingId: null, openingTitle: null, activeTitle: info.title });
      return true;
    }
    if (this.snap.openingId === uid) this.set({ openingTitle: info.title });
    if (find !== null) this.set({ found: null });
    const pv = this.pdfView;
    const pages = pv.activeId === uid && pv.pageCount > 0 ? pv.pageCount : info.pages;
    const wanted = hasPage ? Math.floor(askedPage) : pv.activeId === uid ? pv.page : info.page;
    const page = pages > 0 ? Math.min(Math.max(0, wanted), pages - 1) : Math.max(0, wanted);

    let ok: boolean;
    if (gotoOnly) {
      ok = await this.waitActive(uid, 0, () => this.bridge.goto(uid, page, find), true);
      if (!ok && this.openFailures.has(uid)) {
        // PdfCraft no longer has that tab (closed without the app noticing): open it again.
        this.bridge.forget(uid);
        this.baseVersions.delete(uid);
        return this.openBook(uid, opts);
      }
    } else {
      const data = bytes as ArrayBuffer | Uint8Array;
      // A tab PdfCraft already has keeps the content it was opened from, even if the library got a newer version.
      if (!this.bridge.isOpen(uid) || !this.baseVersions.has(uid)) this.baseVersions.set(uid, info.fileVersion);
      // A new tab holds no marks yet.
      if (!this.bridge.isOpen(uid)) this.vocab.forget(uid);
      // When the id is already open the fork ignores the bytes, brings the tab to front and answers `active`.
      ok = await this.waitActive(uid, data.byteLength, () =>
        this.bridge.open({ id: uid, name: info.name, bytes: data, page }),
      );
      // Freshly opened at the page: now find the text there.
      if (ok && find !== null) this.bridge.goto(uid, page, find);
    }
    if (this.snap.openingId === uid) this.set({ openingId: null, openingTitle: null });
    if (!ok) {
      // Keep the id known: a slow PdfCraft may still open it, and its messages must not be dropped.
      const failure = this.openFailures.get(uid);
      this.set({
        openError: {
          uid,
          title: info.title,
          kind: failure === undefined ? 'timeout' : 'pdfcraft',
          error: failure ?? '',
        },
      });
    }
    return ok;
  }

  // ------------------------------------------------------------ EPUB (spec 7.1)

  /** The EPUB reader mounted (LeitorHost) or went away. */
  setEpubFront(front: EpubFront | null) {
    this.epubFront = front;
    if (front) for (const resolve of this.epubFrontWaits.splice(0)) resolve(front);
  }

  private whenEpubFront(): Promise<EpubFront | null> {
    if (this.epubFront) return Promise.resolve(this.epubFront);
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        const i = this.epubFrontWaits.indexOf(done);
        if (i >= 0) this.epubFrontWaits.splice(i, 1);
        resolve(null);
      }, EPUB_FRONT_TIMEOUT_MS);
      const done = (f: EpubFront) => {
        this.timers.clearTimeout(timer);
        resolve(f);
      };
      this.epubFrontWaits.push(done);
    });
  }

  /**
   * Brings PdfCraft or the EPUB reader to front (the other stays loaded behind, spec 7.1). The reading session, the
   * selection and the panel follow the reader in front.
   */
  showFront(front: LeitorFront) {
    if (front === 'epub' && !this.snap.epub) return;
    if (front === this.snap.front) return;
    if (this.snap.front === 'epub') this.flushEpubPosition();
    else {
      const pdf = this.pdfView.activeId;
      if (pdf !== null) {
        this.flushPositions(pdf);
        void this.autosave.flush('doc', [pdf]);
      }
    }
    this.set({ front, selection: null, menuShown: null });
    if (front === 'epub') this.sessions.active(this.snap.epub!.uid, this.snap.epub!.section);
    else this.sessions.active(this.pdfView.activeId, this.pdfView.page);
  }

  /** Opens (or goes to a place in) an EPUB in the EPUB reader; `info` is null when the reader already holds it. */
  private async openEpub(uid: string, info: OpenInfo | null, opts?: OpenOptions): Promise<boolean> {
    const seq = ++this.epubSeq;
    const askedPage = opts?.page;
    const section = askedPage !== undefined && Number.isFinite(askedPage) ? Math.max(0, Math.floor(askedPage)) : null;
    const cfi = opts?.cfi?.trim() || null;
    const find = normalizeFind(opts?.find);
    const current = this.snap.epub;
    if (current && current.uid === uid) {
      if (!opts?.quiet) this.showFront('epub');
      this.set({ openError: null });
      if (cfi === null && section === null && find === null) return true;
      const front = await this.whenEpubFront();
      if (!front || seq !== this.epubSeq) return false;
      if (find !== null) this.set({ found: null });
      const found = await front.goTo({ cfi, ...(section !== null ? { section } : {}), find }).catch(() => false);
      if (find !== null && seq === this.epubSeq) this.applyEpubFound(uid, section ?? current.section, find, found);
      return true;
    }
    if (!info) return false;
    // One EPUB at a time: the one in the reader records where it was first.
    if (current) {
      try {
        this.epubFront?.flush?.();
      } catch (e) {
        this.warn('epub flush', e);
      }
      this.flushEpubPosition();
    }
    if (!this.snap.epubMounted) this.set({ epubMounted: true });
    let bytes: ArrayBuffer | Uint8Array;
    try {
      bytes = await this.core.bytes(uid);
    } catch (e) {
      this.warn('book_bytes', e);
      this.ui?.toast('epub.openFailed', 'error', { titulo: info.title });
      return false;
    }
    const front = await this.whenEpubFront();
    if (seq !== this.epubSeq) return false;
    if (!front) {
      this.ui?.toast('epub.openFailed', 'error', { titulo: info.title });
      return false;
    }
    const start = section ?? (cfi === null && info.cfi === null ? info.page : null);
    const pages = Math.max(0, info.pages);
    this.set({
      epub: {
        uid,
        title: info.title,
        section: start !== null ? Math.min(start, Math.max(0, pages - 1)) : Math.max(0, info.page),
        sectionCount: pages,
        cfi: cfi ?? info.cfi,
        fraction: pages > 0 ? Math.min(1, (Math.max(0, info.page) + 1) / pages) : 0,
        tocLabel: null,
      },
      openError: null,
      ...(find !== null ? { found: null } : {}),
    });
    this.epubVocab.setBook(uid, pages);
    if (!opts?.quiet) {
      if (this.snap.front === 'epub') {
        this.set({ selection: null });
        this.sessions.active(uid, this.snap.epub!.section);
      } else this.showFront('epub');
    }
    let opened: { sectionCount: number } | null;
    try {
      // The passage is looked for after the book shows (goTo answers whether it was found).
      opened = await front.open({
        uid,
        bytes,
        title: info.title,
        cfi: cfi ?? (section === null ? info.cfi : null),
        ...(start !== null ? { section: start } : {}),
        find: null,
      });
    } catch (e) {
      this.warn('epub open', e);
      opened = null;
    }
    if (seq !== this.epubSeq) return opened !== null;
    if (!opened) {
      this.ui?.toast('epub.openFailed', 'error', { titulo: info.title });
      return false;
    }
    const epub = this.snap.epub;
    if (epub?.uid === uid && opened.sectionCount > 0 && opened.sectionCount !== epub.sectionCount) {
      this.set({ epub: { ...epub, sectionCount: opened.sectionCount } });
      this.epubVocab.setBook(uid, opened.sectionCount);
    }
    // The vocabulary highlight starts where the reader opened.
    if (this.snap.epub?.uid === uid) this.epubVocab.shown(uid, this.snap.epub.section);
    if (find !== null) {
      const at = section ?? this.snap.epub?.section ?? 0;
      const found = await front.goTo({ cfi, ...(section !== null ? { section } : {}), find }).catch(() => false);
      if (seq === this.epubSeq) this.applyEpubFound(uid, at, find, found);
    }
    return true;
  }

  private applyEpubFound(uid: string, section: number, query: string, found: boolean) {
    const result: FoundResult = { id: uid, page: section, query, found };
    this.set({ found: result });
    if (!found) this.ui?.toast('leitor.gotoNotFound', 'info', { pagina: String(section + 1) });
  }

  /** The EPUB reader moved (`onLocation`): progress (debounced), session activity and the vocabulary marks. */
  epubLocation(uid: string, loc: EpubLocation) {
    const epub = this.snap.epub;
    if (!epub || epub.uid !== uid) return;
    const section = Math.max(0, Math.floor(loc.section));
    const sectionCount = loc.sectionCount > 0 ? loc.sectionCount : epub.sectionCount;
    this.set({
      epub: {
        ...epub,
        section,
        sectionCount,
        cfi: loc.cfi || epub.cfi,
        fraction: Number.isFinite(loc.fraction) ? Math.max(0, Math.min(1, loc.fraction)) : epub.fraction,
        tocLabel: loc.tocLabel,
      },
    });
    if (loc.cfi) this.scheduleEpubPosition(uid, { ...loc, section, sectionCount });
    if (this.snap.front === 'epub') this.sessions.activity(uid, section);
    this.epubVocab.shown(uid, section, sectionCount);
  }

  /** Reading activity in the EPUB reader (scroll, keys, selection): keeps the session alive (spec 6.4). */
  epubActivity(uid: string) {
    if (this.snap.epub?.uid !== uid || this.snap.front !== 'epub') return;
    this.sessions.activity(uid);
  }

  /** The EPUB reader's selection changed (null: cleared). */
  epubSelection(uid: string, sel: EpubSelectionInfo | null) {
    if (this.snap.epub?.uid !== uid || this.snap.front !== 'epub') return;
    if (!sel || !sel.text.trim()) {
      if (this.snap.selection !== null) this.set({ selection: null });
      return;
    }
    this.set({ selection: this.epubSelectionOf(uid, sel) });
  }

  private epubSelectionOf(uid: string, sel: EpubSelectionInfo): LeitorSelection {
    return {
      id: uid,
      page: sel.section,
      text: sel.text,
      rects: [],
      cfi: sel.cfi,
      unit: 'chapter',
      label: sel.tocLabel,
    };
  }

  /** "Criar card" / "Criar cards com IA" / "Definir palavra" from the EPUB reader's selection menu. */
  epubMenu(
    uid: string,
    key: string,
    sel: EpubSelectionInfo | null,
    anchor: { x: number; y: number; width: number; height: number } | null,
  ) {
    if (!isPanelKind(key) || this.snap.epub?.uid !== uid) return;
    const selection = sel && sel.text.trim() ? this.epubSelectionOf(uid, sel) : null;
    if (selection && this.snap.front === 'epub') this.set({ selection });
    this.emitPanelRequest({ kind: key, via: 'menu', selection, anchor });
  }

  /** The EPUB reader shows `section` (rendered): the vocabulary marks of it and the next. */
  epubSectionShown(uid: string, section: number) {
    if (this.snap.epub?.uid !== uid) return;
    this.epubVocab.shown(uid, section);
  }

  /** A click on an underlined word in the EPUB reader (`form` as reported); `anchor` in viewport CSS px. */
  epubVocabClick(
    uid: string,
    section: number,
    form: string,
    lemma: string,
    anchor: { x: number; y: number; width: number; height: number },
  ) {
    if (this.snap.epub?.uid !== uid) return;
    const word = this.epubVocab.markFor(section, form);
    if (!word && !lemma) return;
    const status = word?.status === 'learning' || word?.status === 'new' ? 'learning' : 'unknown';
    const mark: VocabMark = { lemma: word?.lemma ?? lemma, form: word?.form ?? form, status, rects: [] };
    for (const fn of [...this.markListeners]) fn({ id: uid, page: section, index: -1, mark, anchor });
  }

  /** Opens the EPUB reader's side drawer (`&lateral=sumario|anotacoes|busca`). */
  async openEpubDrawer(uid: string, which: EpubDrawer): Promise<void> {
    if (this.snap.epub?.uid !== uid) return;
    const front = await this.whenEpubFront();
    front?.openDrawer(which);
  }

  private scheduleEpubPosition(uid: string, loc: EpubLocation) {
    if (this.epubPending) this.timers.clearTimeout(this.epubPending.timer);
    const timer = this.timers.setTimeout(() => this.flushEpubPosition(), POSITION_DEBOUNCE_MS);
    this.epubPending = { timer, uid, loc };
  }

  private flushEpubPosition() {
    const p = this.epubPending;
    if (!p) return;
    this.epubPending = null;
    this.timers.clearTimeout(p.timer);
    const progress = Math.max(0, Math.min(1, Number.isFinite(p.loc.fraction) ? p.loc.fraction : 0));
    void this.core
      .positionSet(p.uid, p.loc.section, progress, p.loc.cfi)
      .then(() => this.ui?.libraryChanged())
      .catch((e) => this.warn('position_set', e));
  }

  // ------------------------------------------------------------ after OCR (spec 7.2)

  /**
   * The book got a new version with recognized text (OCR): PdfCraft keeps the old content in its open tab and has no
   * "close tab" message, so its pending edits are saved, the iframe is recreated and the books it had open are opened
   * again at their pages (the one in front last, so it stays in front). A no-op when PdfCraft doesn't have `uid`.
   */
  async reloadPdfcraftBook(uid: string): Promise<void> {
    if (!this.bridge.isOpen(uid)) return;
    await this.flushSaves('ocr');
    const ids = [...this.bridge.state.openIds];
    const active = this.pdfView.activeId;
    const pages = new Map(ids.map((id) => [id, this.lastPages.get(id)] as const));
    this.restart();
    if (this.snap.front === 'pdfcraft') this.sessions.active(null, 0);
    for (const id of ids) this.baseVersions.delete(id);
    if (!(await this.waitStatus())) return;
    const order = [...ids.filter((id) => id !== active), ...(active !== null && ids.includes(active) ? [active] : [])];
    for (const id of order) {
      const page = pages.get(id);
      await this.openBook(id, { quiet: true, ...(page !== undefined ? { page } : {}) });
    }
    this.ui?.toast('reader.reloadedAfterOcr', 'success');
  }

  /** Resolves true once PdfCraft is ready, false when it failed to start (no reliance on one `readyWait`). */
  private waitStatus(): Promise<boolean> {
    if (this.snap.status === 'ready') return Promise.resolve(true);
    if (this.snap.status === 'failed') return Promise.resolve(false);
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        if (this.snap.status === 'ready' || this.snap.status === 'failed') {
          stop();
          resolve(this.snap.status === 'ready');
        }
      });
    });
  }

  /** Sends with `send()` and waits for `pdfcraft:active` of `uid` (false on failure or timeout). */
  private async waitActive(uid: string, size: number, send: () => boolean, goto = false): Promise<boolean> {
    const d = deferred<boolean>();
    const prev = this.openWaits.get(uid);
    if (prev) {
      this.timers.clearTimeout(prev.timer);
      if (prev.goto) this.timers.clearTimeout(prev.goto.grace);
      prev.d.resolve(false);
    }
    const timer = this.timers.setTimeout(() => this.resolveOpen(uid, false), openTimeoutMs(size));
    this.openWaits.set(uid, { d, timer, ...(goto ? { goto: { held: null, grace: undefined } } : {}) });
    this.openFailures.delete(uid);
    if (!send()) this.resolveOpen(uid, false);
    return d.promise;
  }

  /**
   * "Card da seleção" from a shortcut or the panel's button: the panel opens (overlay in a compact window) with the
   * form for the current selection. With nothing selected only a notice shows, where the user is: no jump to the
   * Leitor tab, the panel stays as it is.
   */
  async requestCardFromSelection(via: 'shortcut' | 'button' = 'shortcut'): Promise<void> {
    if (this.snap.front === 'epub' && this.snap.epub) {
      // The EPUB reader answers at once (no debounce across a frame boundary).
      const uid = this.snap.epub.uid;
      let sel: EpubSelectionInfo | null = null;
      try {
        sel = this.epubFront?.selectionNow() ?? null;
      } catch (e) {
        this.warn('epub selection', e);
      }
      if (sel && sel.text.trim()) this.set({ selection: this.epubSelectionOf(uid, sel) });
    } else {
      // A selection made just before the shortcut may still be in PdfCraft's 300 ms debounce: ask for it first.
      await this.selectionNow();
    }
    if (!this.snap.selection?.text.trim()) {
      this.ui?.toast('bookPanel.selectFirst', 'info');
      return;
    }
    this.emitPanelRequest({ kind: 'card', via, selection: this.snap.selection, anchor: null });
  }

  /**
   * Resolves once PdfCraft has sent the selection it was still debouncing (or after `SELECTION_NOW_TIMEOUT_MS`).
   * Nothing to wait for when PdfCraft isn't running, has no book in front or isn't on screen (no fresh selection).
   */
  private selectionNow(): Promise<void> {
    if (this.snap.status !== 'ready' || this.pdfView.activeId === null || !this.snap.visible) return Promise.resolve();
    const seq = ++this.selectionSeq;
    return new Promise<void>((resolve) => {
      const timer = this.timers.setTimeout(() => this.endSelectionWait(seq), SELECTION_NOW_TIMEOUT_MS);
      this.selectionWaits.set(seq, { resolve, timer });
      if (!this.bridge.selectionNow(seq)) this.endSelectionWait(seq);
    });
  }

  private endSelectionWait(seq: number) {
    const w = this.selectionWaits.get(seq);
    if (!w) return;
    this.selectionWaits.delete(seq);
    this.timers.clearTimeout(w.timer);
    w.resolve();
  }

  /**
   * The panel listens for requests (menu items, shortcuts). A request made while nobody listened is delivered to the
   * first listener, once.
   */
  onPanelRequest = (cb: (r: PanelRequest) => void): (() => void) => {
    this.panelListeners.add(cb);
    const pending = this.pendingRequest;
    if (pending) {
      this.pendingRequest = null;
      queueMicrotask(() => {
        if (this.panelListeners.has(cb)) cb(pending);
        else this.pendingRequest ??= pending;
      });
    }
    return () => {
      this.panelListeners.delete(cb);
    };
  };

  /** The popover's listener for clicks on highlighted words (`pdfcraft:mark-click`); returns unsubscribe. */
  onMarkClick = (cb: (c: MarkClick) => void): (() => void) => {
    this.markListeners.add(cb);
    return () => {
      this.markListeners.delete(cb);
    };
  };

  /** Turns the vocabulary highlight of `uid` on or off (remembered per book). */
  setHighlight(uid: string, on: boolean) {
    this.vocab.setOn(uid, on);
    this.epubVocab.setOn(uid, on);
  }

  /** The marks of `uid` (every book when absent) changed in the core: send the visible pages again. */
  refreshVocab(uid?: string) {
    this.vocab.refresh(uid);
    this.epubVocab.refresh(uid);
  }

  /** The panel's mini-review ("Revisar aqui", spec 6.4/10.1) opened or closed: the reading session pauses. */
  setReviewing(on: boolean) {
    this.sessions.setReviewing(on);
  }

  dismissOpenError() {
    this.set({ openError: null });
  }

  async openExternal(uid: string): Promise<void> {
    try {
      await this.core.openExternal(uid);
      this.set({ openError: null });
    } catch (e) {
      this.warn('open external', e);
      this.ui?.toast('reader.openExternalFailed', 'error', { erro: errorText(e) });
    }
  }

  /** Saves every book with edits now. True when all were stored; false on failure or after 10 s. */
  flushSaves(reason: FlushReason = 'manual'): Promise<boolean> {
    this.flushPositions();
    return this.autosave.flush(reason);
  }

  /**
   * The window wants to close: save everything, end the session. Resolves true to let it close; when saving fails
   * it shows the "unsaved" dialog and resolves with the user's choice.
   */
  async onCloseRequested(): Promise<boolean> {
    const saved = await this.flushSaves('close');
    if (!saved) {
      const choice = await new Promise<boolean>((resolve) => {
        this.closeResolver = resolve;
        this.set({ closePrompt: true });
      });
      if (!choice) return false;
    }
    this.sessions.close();
    return true;
  }

  answerClosePrompt(closeAnyway: boolean) {
    const resolve = this.closeResolver;
    this.closeResolver = null;
    this.set({ closePrompt: false });
    resolve?.(closeAnyway);
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message;
  return String(e);
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
