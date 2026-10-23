// The app side of the PdfCraft postMessage bridge (spec 6.1, 6.2, 18). Framework-free so it can be unit tested
// with a fake iframe window. Every incoming message is validated: wrong origin/source, unknown type, bad shape or
// an id the app never opened → dropped (with a dev log warning), never thrown.
import type { Rect } from '../../lib/core/types';

/** Info-dict key the fork stamps into every saved PDF (spec 6.5). */
export const INFO_KEY = 'LeitorBookUid';
/**
 * Lowest `bridge` version in `pdfcraft:ready` the app works with: 2 = the Phase 1 messages (ids, active, page,
 * activity…) plus selection, menu items, goto/find (Phase 4).
 */
export const MIN_BRIDGE = 2;
/** Longest selection text accepted from PdfCraft. */
export const MAX_TEXT = 20_000;
/** Most rects in one selection/menu message. */
export const MAX_RECTS = 2_000;
/** Most items the app adds to PdfCraft's selection menu. */
export const MAX_MENU_ITEMS = 16;
/** Longest `find` text sent with `pdfcraft:goto` (and accepted back in `pdfcraft:found`). */
export const MAX_FIND = 500;
const MENU_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_BYTES = 2 * 1024 ** 3;
export const MAX_NAME = 512;
const UID_RE = /^[0-9a-f]{64}$/;

export type PdfcraftTheme = 'light' | 'dark';

/** `[x, y, width, height]`: points in page view space (y down) for selections; CSS px for menu anchors/items. */
export type { Rect };

/** One item the app adds to PdfCraft's selection menu (`pdfcraft:menu-items`). */
export interface MenuItem {
  key: string;
  label: string;
}

export type BridgeIn =
  | { type: 'pdfcraft:ready'; version: string | null; bridge: number }
  | { type: 'pdfcraft:failed'; error: string; id: string | null }
  | { type: 'pdfcraft:active'; id: string | null; page: number; pageCount: number }
  | { type: 'pdfcraft:page'; id: string | null; page: number; pageCount: number | null }
  | { type: 'pdfcraft:activity'; id: string | null }
  | { type: 'pdfcraft:dirty'; dirty: boolean; ids: string[] | null }
  | { type: 'pdfcraft:save'; id: string | null; name: string; saveAs: boolean; bytes: ArrayBuffer }
  | { type: 'pdfcraft:save-failed'; id: string; error: string }
  | { type: 'pdfcraft:theme'; theme: PdfcraftTheme }
  /** The text selection of a document changed (300 ms after the last change). Empty text = no selection. */
  | { type: 'pdfcraft:selection'; id: string | null; page: number; text: string; rects: Rect[] }
  /** The user picked one of the app's items. `anchor`: the clicked item, CSS px relative to the iframe. */
  | {
      type: 'pdfcraft:menu';
      key: string;
      id: string | null;
      page: number;
      text: string;
      rects: Rect[];
      anchor: Rect | null;
    }
  /** PdfCraft showed a selection menu with (some of) the app's items; rects are CSS px relative to the iframe. */
  | { type: 'pdfcraft:menu-shown'; id: string | null; items: { key: string; rect: Rect }[] }
  /** Result of the find of a `pdfcraft:goto`. */
  | { type: 'pdfcraft:found'; id: string | null; page: number; query: string; found: boolean }
  /** Answer to `pdfcraft:selection-now`, after the `pdfcraft:selection` that was waiting (if any). */
  | { type: 'pdfcraft:selection-sent'; seq: number | null };

export type BridgeInType = BridgeIn['type'];

export type BridgeOut =
  | { type: 'pdfcraft:open'; name: string; bytes: ArrayBuffer; id: string; page?: number; infoKey: string }
  | { type: 'pdfcraft:request-save'; id: string }
  | { type: 'pdfcraft:menu-items'; items: MenuItem[] }
  | { type: 'pdfcraft:goto'; id: string; page: number; find?: string }
  /** Send the debounced selection now (a shortcut right after selecting); answered by `pdfcraft:selection-sent`. */
  | { type: 'pdfcraft:selection-now'; seq: number };

export const INCOMING_TYPES: readonly BridgeInType[] = [
  'pdfcraft:ready',
  'pdfcraft:failed',
  'pdfcraft:active',
  'pdfcraft:page',
  'pdfcraft:activity',
  'pdfcraft:dirty',
  'pdfcraft:save',
  'pdfcraft:save-failed',
  'pdfcraft:theme',
  'pdfcraft:selection',
  'pdfcraft:menu',
  'pdfcraft:menu-shown',
  'pdfcraft:found',
  'pdfcraft:selection-sent',
];

export type ParseResult = { ok: true; msg: BridgeIn } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function isBookUid(v: unknown): v is string {
  return typeof v === 'string' && UID_RE.test(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** `[x, y, w, h]` with finite numbers and a non-negative size. */
export function isRect(v: unknown): v is Rect {
  return (
    Array.isArray(v) && v.length === 4 && v.every(isFiniteNumber) && (v[2] as number) >= 0 && (v[3] as number) >= 0
  );
}

function parseRects(v: unknown): Rect[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_RECTS || !v.every(isRect)) return null;
  return v.map((r: Rect) => [r[0], r[1], r[2], r[3]] as Rect);
}

function parseText(v: unknown): string | null {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > MAX_TEXT) return null;
  return v;
}

/**
 * Validates one message against the protocol. `known(id)` says whether the app opened that id; messages about
 * other ids are rejected. `menuKeys`: the keys of the items the app registered (`pdfcraft:menu-items`); menu
 * messages about any other key are rejected. Pure: no side effects.
 */
export function parseMessage(
  data: unknown,
  known: (id: string) => boolean,
  menuKeys: ReadonlySet<string> = new Set(),
): ParseResult {
  const bad = (reason: string): ParseResult => ({ ok: false, reason });
  if (!isRecord(data)) return bad('not an object');
  const type = data.type;
  if (typeof type !== 'string' || !(INCOMING_TYPES as readonly string[]).includes(type)) {
    return bad(`unknown type ${String(type).slice(0, 40)}`);
  }

  // id: absent/null (a document PdfCraft opened by itself) or a book uid the app opened.
  let id: string | null = null;
  if (data.id !== undefined && data.id !== null) {
    if (!isBookUid(data.id)) return bad('malformed id');
    if (!known(data.id)) return bad('id not opened by the app');
    id = data.id;
  }

  switch (type as BridgeInType) {
    case 'pdfcraft:ready': {
      const version = typeof data.version === 'string' ? data.version.slice(0, 64) : null;
      const bridge = data.bridge === undefined ? 0 : data.bridge;
      if (!isIndex(bridge)) return bad('bad bridge version');
      return { ok: true, msg: { type: 'pdfcraft:ready', version, bridge } };
    }
    case 'pdfcraft:failed': {
      const error = typeof data.error === 'string' ? data.error.slice(0, 2000) : 'unknown';
      return { ok: true, msg: { type: 'pdfcraft:failed', error, id } };
    }
    case 'pdfcraft:active': {
      if (id === null) {
        // No book in front (home screen or a file opened inside PdfCraft): page fields are optional.
        const page = isIndex(data.page) ? data.page : 0;
        const pageCount = isIndex(data.pageCount) ? data.pageCount : 0;
        return { ok: true, msg: { type: 'pdfcraft:active', id, page, pageCount } };
      }
      if (!isIndex(data.page) || !isIndex(data.pageCount)) return bad('bad page');
      if (data.page >= data.pageCount) return bad('page out of range');
      return { ok: true, msg: { type: 'pdfcraft:active', id, page: data.page, pageCount: data.pageCount } };
    }
    case 'pdfcraft:page': {
      if (!isIndex(data.page)) return bad('bad page');
      let pageCount: number | null = null;
      if (data.pageCount !== undefined && data.pageCount !== null) {
        if (!isIndex(data.pageCount) || data.page >= data.pageCount) return bad('bad pageCount');
        pageCount = data.pageCount;
      }
      return { ok: true, msg: { type: 'pdfcraft:page', id, page: data.page, pageCount } };
    }
    case 'pdfcraft:activity':
      return { ok: true, msg: { type: 'pdfcraft:activity', id } };
    case 'pdfcraft:dirty': {
      if (typeof data.dirty !== 'boolean') return bad('bad dirty');
      let ids: string[] | null = null;
      if (data.ids !== undefined && data.ids !== null) {
        if (!Array.isArray(data.ids) || data.ids.length > 1000) return bad('bad ids');
        if (!data.ids.every(isBookUid)) return bad('malformed id in ids');
        // Documents the app didn't open (id-less in PdfCraft) never appear; unknown ones are ignored.
        ids = (data.ids as string[]).filter(known);
      }
      return { ok: true, msg: { type: 'pdfcraft:dirty', dirty: data.dirty, ids } };
    }
    case 'pdfcraft:save': {
      const name = data.name;
      if (typeof name !== 'string' || name.length > MAX_NAME) return bad('bad name');
      if (typeof data.saveAs !== 'boolean') return bad('bad saveAs');
      const bytes = data.bytes;
      if (!(bytes instanceof ArrayBuffer) && !isArrayBufferLike(bytes)) return bad('bad bytes');
      if ((bytes as ArrayBuffer).byteLength > MAX_BYTES) return bad('bytes too large');
      return {
        ok: true,
        msg: { type: 'pdfcraft:save', id, name, saveAs: data.saveAs, bytes: bytes as ArrayBuffer },
      };
    }
    case 'pdfcraft:save-failed': {
      if (id === null) return bad('save-failed without id');
      const error = typeof data.error === 'string' ? data.error.slice(0, 2000) : 'unknown';
      return { ok: true, msg: { type: 'pdfcraft:save-failed', id, error } };
    }
    case 'pdfcraft:theme': {
      if (data.theme !== 'light' && data.theme !== 'dark') return bad('bad theme');
      return { ok: true, msg: { type: 'pdfcraft:theme', theme: data.theme } };
    }
    case 'pdfcraft:selection': {
      if (!isIndex(data.page)) return bad('bad page');
      const text = parseText(data.text);
      if (text === null) return bad('bad text');
      const rects = parseRects(data.rects);
      if (rects === null) return bad('bad rects');
      return { ok: true, msg: { type: 'pdfcraft:selection', id, page: data.page, text, rects } };
    }
    case 'pdfcraft:menu': {
      if (typeof data.key !== 'string' || !menuKeys.has(data.key)) return bad('unknown menu key');
      if (!isIndex(data.page)) return bad('bad page');
      const text = parseText(data.text);
      if (text === null) return bad('bad text');
      const rects = parseRects(data.rects);
      if (rects === null) return bad('bad rects');
      let anchor: Rect | null = null;
      if (data.anchor !== undefined && data.anchor !== null) {
        if (!isRect(data.anchor)) return bad('bad anchor');
        anchor = [data.anchor[0], data.anchor[1], data.anchor[2], data.anchor[3]];
      }
      return { ok: true, msg: { type: 'pdfcraft:menu', key: data.key, id, page: data.page, text, rects, anchor } };
    }
    case 'pdfcraft:menu-shown': {
      if (!Array.isArray(data.items) || data.items.length > MAX_MENU_ITEMS) return bad('bad items');
      const items: { key: string; rect: Rect }[] = [];
      for (const item of data.items as unknown[]) {
        if (!isRecord(item) || typeof item.key !== 'string' || !menuKeys.has(item.key)) return bad('bad item key');
        if (!isRect(item.rect)) return bad('bad item rect');
        items.push({ key: item.key, rect: [item.rect[0], item.rect[1], item.rect[2], item.rect[3]] });
      }
      return { ok: true, msg: { type: 'pdfcraft:menu-shown', id, items } };
    }
    case 'pdfcraft:found': {
      if (!isIndex(data.page)) return bad('bad page');
      if (typeof data.query !== 'string' || data.query.length > MAX_FIND) return bad('bad query');
      if (typeof data.found !== 'boolean') return bad('bad found');
      return { ok: true, msg: { type: 'pdfcraft:found', id, page: data.page, query: data.query, found: data.found } };
    }
    case 'pdfcraft:selection-sent': {
      if (data.seq !== undefined && data.seq !== null && !isIndex(data.seq)) return bad('bad seq');
      return { ok: true, msg: { type: 'pdfcraft:selection-sent', seq: isIndex(data.seq) ? data.seq : null } };
    }
  }
}

/** Whitespace collapsed, trimmed and cut to `MAX_FIND` characters; null when nothing is left. */
export function normalizeFind(find: string | null | undefined): string | null {
  if (typeof find !== 'string') return null;
  const q = find.replace(/\s+/g, ' ').trim().slice(0, MAX_FIND).trim();
  return q || null;
}

/** `instanceof ArrayBuffer` fails across realms (the buffer is created in the iframe), so check the tag too. */
function isArrayBufferLike(v: unknown): v is ArrayBuffer {
  return Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

/** A standalone ArrayBuffer holding exactly `bytes` (transferable without detaching anyone else's data). */
export function ownBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof Uint8Array) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && isArrayBufferLike(bytes.buffer)) {
      return bytes.buffer;
    }
    return bytes.slice().buffer as ArrayBuffer;
  }
  return bytes;
}

export interface BridgeState {
  ready: boolean;
  version: string | null;
  bridge: number;
  openIds: ReadonlySet<string>;
  activeId: string | null;
  page: number;
  pageCount: number;
  dirtyIds: ReadonlySet<string>;
  theme: PdfcraftTheme | null;
}

export interface BridgeOptions {
  /** The parent window (where `message` events arrive). */
  host: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The origin both sides must share. */
  origin: string;
  /** The iframe's current window, or null before it loads. */
  frame: () => Pick<Window, 'postMessage'> | null;
  onMessage: (msg: BridgeIn) => void;
  warn?: (message: string) => void;
}

/** Owns the message channel and the protocol state (what's open, in front, dirty). */
export class BridgeClient {
  private readonly opts: BridgeOptions;
  private readonly openIds = new Set<string>();
  private readonly dirtyIds = new Set<string>();
  /** Keys of the items registered with `setMenuItems` (menu messages about other keys are dropped). */
  private menuKeys: ReadonlySet<string> = new Set();
  private st: Omit<BridgeState, 'openIds' | 'dirtyIds'> = {
    ready: false,
    version: null,
    bridge: 0,
    activeId: null,
    page: 0,
    pageCount: 0,
    theme: null,
  };
  private attached = false;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  get state(): BridgeState {
    return { ...this.st, openIds: new Set(this.openIds), dirtyIds: new Set(this.dirtyIds) };
  }

  isOpen(id: string): boolean {
    return this.openIds.has(id);
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.opts.host.addEventListener('message', this.listener as EventListener);
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.opts.host.removeEventListener('message', this.listener as EventListener);
  }

  /** A new iframe document (reload): nothing is open in it any more. */
  reset() {
    this.openIds.clear();
    this.dirtyIds.clear();
    this.st = { ready: false, version: null, bridge: 0, activeId: null, page: 0, pageCount: 0, theme: this.st.theme };
  }

  private readonly listener = (event: MessageEvent) => {
    const frame = this.opts.frame();
    if (event.origin !== this.opts.origin || !frame || event.source !== frame) return;
    const parsed = parseMessage(event.data, (id) => this.openIds.has(id), this.menuKeys);
    if (!parsed.ok) {
      this.opts.warn?.(`leitor bridge: dropped message (${parsed.reason})`);
      return;
    }
    this.apply(parsed.msg);
    this.opts.onMessage(parsed.msg);
  };

  private apply(msg: BridgeIn) {
    switch (msg.type) {
      case 'pdfcraft:ready':
        this.st.ready = true;
        this.st.version = msg.version;
        this.st.bridge = msg.bridge;
        break;
      case 'pdfcraft:failed':
        if (msg.id) {
          this.openIds.delete(msg.id);
          this.dirtyIds.delete(msg.id);
        }
        break;
      case 'pdfcraft:active':
        this.st.activeId = msg.id;
        this.st.page = msg.page;
        this.st.pageCount = msg.pageCount;
        break;
      case 'pdfcraft:page':
        if (msg.id !== null && msg.id === this.st.activeId) {
          this.st.page = msg.page;
          if (msg.pageCount !== null) this.st.pageCount = msg.pageCount;
        }
        break;
      case 'pdfcraft:dirty':
        if (msg.ids) {
          this.dirtyIds.clear();
          for (const id of msg.ids) this.dirtyIds.add(id);
        } else if (!msg.dirty) {
          this.dirtyIds.clear();
        } else if (this.st.activeId) {
          // Unextended bridge: assume the work is in the document in front.
          this.dirtyIds.add(this.st.activeId);
        }
        break;
      case 'pdfcraft:theme':
        this.st.theme = msg.theme;
        break;
      default:
        break;
    }
  }

  /** Marks `id` closed on the app side (PdfCraft closed the tab, reported through `active`/`dirty`). */
  forget(id: string) {
    this.openIds.delete(id);
    this.dirtyIds.delete(id);
  }

  private post(msg: BridgeOut, transfer?: Transferable[]): boolean {
    const frame = this.opts.frame();
    if (!frame) return false;
    try {
      frame.postMessage(msg, { targetOrigin: this.opts.origin, transfer: transfer ?? [] });
      return true;
    } catch (e) {
      this.opts.warn?.(`leitor bridge: postMessage failed (${String(e)})`);
      return false;
    }
  }

  /**
   * Opens (or, if already open, brings to front) a book. The bytes are transferred. With `goto` the page is always
   * sent, so a tab PdfCraft already has goes to it too (the fork shows `page` for an id already open).
   */
  open(args: { id: string; name: string; bytes: ArrayBuffer | Uint8Array; page: number; goto?: boolean }): boolean {
    const buffer = ownBuffer(args.bytes);
    const name = args.name.slice(0, MAX_NAME) || 'documento.pdf';
    this.openIds.add(args.id);
    // Page 0 is left out unless asked for: PdfCraft then opens the file exactly as it opens any file (going to page 0
    // explicitly scrolls to the page edge, a few pixels off its usual first view).
    const page = Math.max(0, Math.floor(args.page));
    const withPage = page > 0 || args.goto === true;
    return this.post(
      { type: 'pdfcraft:open', name, bytes: buffer, id: args.id, ...(withPage ? { page } : {}), infoKey: INFO_KEY },
      [buffer],
    );
  }

  requestSave(id: string): boolean {
    return this.post({ type: 'pdfcraft:request-save', id });
  }

  /** Adds `items` to PdfCraft's selection menu (replacing the previous ones). Sent again after every `ready`. */
  setMenuItems(items: readonly MenuItem[]): boolean {
    const list = items.slice(0, MAX_MENU_ITEMS).filter((i) => MENU_KEY_RE.test(i.key));
    this.menuKeys = new Set(list.map((i) => i.key));
    return this.post({ type: 'pdfcraft:menu-items', items: list.map((i) => ({ key: i.key, label: i.label })) });
  }

  /**
   * Shows `page` (0-based) of the open document `id` and, with `find`, runs PdfCraft's find for that text on (or
   * near) that page; PdfCraft answers with `pdfcraft:active` and, for a find, `pdfcraft:found`.
   */
  goto(id: string, page: number, find?: string | null): boolean {
    const q = normalizeFind(find);
    return this.post({ type: 'pdfcraft:goto', id, page: Math.max(0, Math.floor(page)), ...(q ? { find: q } : {}) });
  }

  /** Asks PdfCraft to send the selection still in its 300 ms debounce now; it answers `pdfcraft:selection-sent`. */
  selectionNow(seq: number): boolean {
    return this.post({ type: 'pdfcraft:selection-now', seq });
  }
}
