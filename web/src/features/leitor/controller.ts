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
import { SessionWiring, type StopReason } from './sessions';
import { frameLoad, LeitorTimings } from './timings';

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
  positionSet(uid: string, page: number, progress: number): Promise<void>;
  setPages(uid: string, pages: number): Promise<void>;
  sessionStart(uid: string, page: number): Promise<void>;
  sessionHeartbeat(uid: string, page: number): Promise<void>;
  sessionStop(uid: string, reason: StopReason): Promise<void>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface OpenInfo {
  name: string;
  title: string;
  page: number;
  pages: number;
  fileVersion: number;
}

/** The text selected in the book in front (`pdfcraft:selection`). */
export interface LeitorSelection {
  id: string;
  /** 0-based PdfCraft page. */
  page: number;
  text: string;
  /** Page view space points, y down. */
  rects: Rect[];
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
      | 'bookPanel.notInLibrary',
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
  private readonly positionTimers = new Map<string, { timer: unknown; page: number; pageCount: number }>();
  private closeResolver: ((ok: boolean) => void) | null = null;
  private readonly openFailures = new Map<string, string>();
  private frameElement: { getBoundingClientRect(): { left: number; top: number } } | null = null;
  private readonly panelListeners = new Set<(r: PanelRequest) => void>();
  /** A request made while no panel was listening (e.g. the shortcut before the Leitor was ever shown). */
  private pendingRequest: PanelRequest | null = null;
  /** `pdfcraft:selection-now` requests waiting for their `pdfcraft:selection-sent`, by seq. */
  private readonly selectionWaits = new Map<number, { resolve: () => void; timer: unknown }>();
  private selectionSeq = 0;
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

  private set(patch: Partial<LeitorSnapshot>) {
    const next = { ...this.snap, ...patch };
    const openIds = [...this.bridge.state.openIds].sort();
    this.snap = {
      ...next,
      ready: next.status === 'ready',
      activeBookUid: next.activeId,
      openIds: openIds.join() === this.snap.openIds.join() ? this.snap.openIds : openIds,
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
    this.frameWindow = null;
    this.beginStart();
    this.set({
      generation: this.snap.generation + 1,
      activeId: null,
      activeTitle: null,
      openingId: null,
      openingTitle: null,
      selection: null,
      found: null,
      menuShown: null,
    });
  }

  /** The iframe loaded a new document (it reloaded itself): nothing is open in it any more. */
  frameReloaded() {
    this.sessions.active(null, 0);
    this.bridge.reset();
    for (const id of [...this.openWaits.keys()]) this.resolveOpen(id, false);
    this.beginStart();
    this.set({
      activeId: null,
      activeTitle: null,
      openingId: null,
      openingTitle: null,
      page: 0,
      pageCount: 0,
      selection: null,
      found: null,
      menuShown: null,
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
        const pageCount = m.pageCount ?? (m.id === this.snap.activeId ? this.snap.pageCount : 0);
        if (m.id === this.snap.activeId) {
          this.set({ page: m.page, ...(m.pageCount !== null ? { pageCount: m.pageCount } : {}) });
        }
        this.schedulePosition(m.id, m.page, pageCount);
        this.sessions.activity(m.id, m.page);
        return;
      }
      case 'pdfcraft:activity':
        if (m.id === null) return;
        this.autosave.activity(m.id);
        this.sessions.activity(m.id);
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
        if (m.id !== null && m.id === this.snap.activeId && selection)
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
    if (id === null || id !== this.snap.activeId) return;
    if (!text.trim()) {
      if (this.snap.selection !== null) this.set({ selection: null });
      return;
    }
    this.set({ selection: { id, page, text, rects } });
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
    const previous = this.snap.activeId;
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
      ...(previous !== id ? { selection: null, menuShown: null } : {}),
      ...(id !== null && this.snap.openError?.uid === id ? { openError: null } : {}),
    });
    this.sessions.active(id, page);
    if (id !== null) {
      this.resolveOpen(id, true);
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
  async openBook(uid: string, opts?: { page?: number; find?: string | null }): Promise<boolean> {
    this.ui?.navigateToLeitor();
    this.set({ openError: null, openingId: uid, openingTitle: this.titles.get(uid) ?? null });
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
    let info: OpenInfo;
    let bytes: ArrayBuffer | Uint8Array | null = null;
    try {
      if (gotoOnly) info = await this.core.openInfo(uid);
      else [info, bytes] = await Promise.all([this.core.openInfo(uid), this.core.bytes(uid)]);
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
    this.knownPages.set(uid, info.pages);
    if (this.snap.activeId === uid && !goto) {
      // Already in front and no page asked for: nothing to wait for.
      this.set({ openingId: null, openingTitle: null, activeTitle: info.title });
      return true;
    }
    if (this.snap.openingId === uid) this.set({ openingTitle: info.title });
    if (find !== null) this.set({ found: null });
    const pages = this.snap.activeId === uid && this.snap.pageCount > 0 ? this.snap.pageCount : info.pages;
    const wanted = hasPage ? Math.floor(askedPage) : this.snap.activeId === uid ? this.snap.page : info.page;
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
    // A selection made just before the shortcut may still be in PdfCraft's 300 ms debounce: ask for it first.
    await this.selectionNow();
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
    if (this.snap.status !== 'ready' || this.snap.activeId === null || !this.snap.visible) return Promise.resolve();
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
