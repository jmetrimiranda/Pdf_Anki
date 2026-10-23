// The app side of the PdfCraft postMessage bridge (spec 6.1, 6.2, 18). Framework-free so it can be unit tested
// with a fake iframe window. Every incoming message is validated: wrong origin/source, unknown type, bad shape or
// an id the app never opened → dropped (with a dev log warning), never thrown.

/** Info-dict key the fork stamps into every saved PDF (spec 6.5). */
export const INFO_KEY = 'LeitorBookUid';
/** Lowest `bridge` version in `pdfcraft:ready` with the Phase 1 messages (ids, active, page, activity…). */
export const MIN_BRIDGE = 1;
export const MAX_BYTES = 2 * 1024 ** 3;
export const MAX_NAME = 512;
const UID_RE = /^[0-9a-f]{64}$/;

export type PdfcraftTheme = 'light' | 'dark';

export type BridgeIn =
  | { type: 'pdfcraft:ready'; version: string | null; bridge: number }
  | { type: 'pdfcraft:failed'; error: string; id: string | null }
  | { type: 'pdfcraft:active'; id: string | null; page: number; pageCount: number }
  | { type: 'pdfcraft:page'; id: string | null; page: number; pageCount: number | null }
  | { type: 'pdfcraft:activity'; id: string | null }
  | { type: 'pdfcraft:dirty'; dirty: boolean; ids: string[] | null }
  | { type: 'pdfcraft:save'; id: string | null; name: string; saveAs: boolean; bytes: ArrayBuffer }
  | { type: 'pdfcraft:save-failed'; id: string; error: string }
  | { type: 'pdfcraft:theme'; theme: PdfcraftTheme };

export type BridgeInType = BridgeIn['type'];

export type BridgeOut =
  | { type: 'pdfcraft:open'; name: string; bytes: ArrayBuffer; id: string; page?: number; infoKey: string }
  | { type: 'pdfcraft:request-save'; id: string };

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

/**
 * Validates one message against the protocol. `known(id)` says whether the app opened that id; messages about
 * other ids are rejected. Pure: no side effects.
 */
export function parseMessage(data: unknown, known: (id: string) => boolean): ParseResult {
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
  }
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
    const parsed = parseMessage(event.data, (id) => this.openIds.has(id));
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

  /** Opens (or, if already open, brings to front) a book. The bytes are transferred. */
  open(args: { id: string; name: string; bytes: ArrayBuffer | Uint8Array; page: number }): boolean {
    const buffer = ownBuffer(args.bytes);
    const name = args.name.slice(0, MAX_NAME) || 'documento.pdf';
    this.openIds.add(args.id);
    // Page 0 is left out: PdfCraft then opens the file exactly as it opens any file (going to page 0 explicitly
    // scrolls to the page edge, a few pixels off its usual first view).
    const page = Math.max(0, Math.floor(args.page));
    return this.post(
      { type: 'pdfcraft:open', name, bytes: buffer, id: args.id, ...(page > 0 ? { page } : {}), infoKey: INFO_KEY },
      [buffer],
    );
  }

  requestSave(id: string): boolean {
    return this.post({ type: 'pdfcraft:request-save', id });
  }
}
