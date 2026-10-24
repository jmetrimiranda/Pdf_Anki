// The EPUB reading session, framework-free (spec 7.1): one foliate-js <foliate-view> inside a host element, plus
// everything the app adds around it — position (CFI) and progress, page turns (keys, wheel, click zones, swipe),
// selection, annotations stored in the app DB with PdfCraft's look, vocabulary underlines, link handling and the
// activity signal. The React component (EpubReader.tsx) renders the chrome from `snapshot()`.
import type { EPUB, TocItem } from '@foliate/epub.js';
import type { Overlayer } from '@foliate/overlayer.js';
import type { RelocateDetail, View } from '@foliate/view.js';
import { t } from '../../i18n';
import type { EpubAnnotation, EpubAnnotationInput, EpubAnnotationKind } from '../../lib/core/types';
import { compareCfi, excerpt, isDrawn, newAnnotationUid, sortAnnotations } from './annotations';
import { isAppShortcut, pageKeyAction, type PageKeyAction } from './keys';
import { EpubOpenError, openEpubBook } from './loader';
import { DEFAULT_COLOR, drawHighlight, drawUnderline, normalizeColor } from './palette';
import { fixLinkContrast, getPrefs, readerCss, subscribePrefs, type EpubPrefs } from './prefs';
import type { DrawerKind, EpubLocation, EpubOpenOptions, EpubReaderEvents, EpubSelection } from './types';
import { findVocabRanges, type EpubVocabWord } from './vocab';

export interface AnnotationApi {
  list(bookUid: string): Promise<EpubAnnotation[]>;
  upsert(input: EpubAnnotationInput): Promise<EpubAnnotation>;
  remove(annotationUid: string): Promise<void>;
}

export interface TocNode {
  id: number;
  label: string;
  href: string;
  children: TocNode[];
}

export type Rect = [number, number, number, number];

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SessionSnapshot {
  status: SessionStatus;
  uid: string | null;
  title: string;
  error: { kind: 'invalid' | 'drm' | 'too-large' | 'timeout' | 'other'; message: string } | null;
  toc: TocNode[];
  sectionCount: number;
  location: EpubLocation | null;
  /** TOC item id of the current place (for marking it in the drawer). */
  tocId: number | null;
  annotations: EpubAnnotation[];
  /** The bookmark on the visible page, if any. */
  bookmarkHere: EpubAnnotation | null;
  selection: EpubSelection | null;
  /** An annotation clicked on the page (popover), with its place on the host. */
  active: { uid: string; rect: Rect; focusComment: boolean; seq: number } | null;
  /** An external link waiting for confirmation. */
  externalUrl: string | null;
  drawer: DrawerKind | null;
  /** A pt-BR message about a failed save/delete/load of annotations. */
  notice: string | null;
  fixedLayout: boolean;
}

export interface SearchHit {
  cfi: string;
  section: number | null;
  label: string;
  pre: string;
  match: string;
  post: string;
}

const LOCATION_DEBOUNCE_MS = 250;
const SELECTION_DEBOUNCE_MS = 300;
const ACTIVITY_INTERVAL_MS = 10_000;
/** Page-turn fade (spec 4: ≤ 150 ms; none with prefers-reduced-motion). */
export const TURN_ANIMATION_MS = 120;
const WHEEL_GAP_MS = 350;
const MAX_SEARCH_HITS = 300;

const EMPTY: SessionSnapshot = {
  status: 'idle',
  uid: null,
  title: '',
  error: null,
  toc: [],
  sectionCount: 0,
  location: null,
  tocId: null,
  annotations: [],
  bookmarkHere: null,
  selection: null,
  active: null,
  externalUrl: null,
  drawer: null,
  notice: null,
  fixedLayout: false,
};

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function mapToc(items: TocItem[] | null | undefined, counter: { n: number }): TocNode[] {
  return (items ?? []).map((item) => ({
    id: typeof item.id === 'number' ? item.id : counter.n++,
    label: (item.label ?? '').trim(),
    href: item.href ?? '',
    children: mapToc(item.subitems, counter),
  }));
}

/**
 * From handing the parsed book to foliate until the first section is on screen: past this the open fails with a
 * "took too long" error and "Tentar de novo" instead of spinning forever (a frame that never finishes loading).
 */
export const OPEN_TIMEOUT_MS = 30_000;

/** The open watchdog fired. */
class OpenTimeoutError extends Error {
  constructor() {
    super('timed out showing the first section');
  }
}

/** The reader's view of the (closed) shadow DOM: the iframe that shows `doc`. */
function frameOf(doc: Document): HTMLElement | null {
  try {
    return (doc.defaultView?.frameElement as HTMLElement | null) ?? null;
  } catch {
    return null;
  }
}

export class EpubSession {
  private snap: SessionSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private view: View | null = null;
  private book: EPUB | null = null;
  private opts: EpubOpenOptions | null = null;
  private openToken = 0;
  private sectionIndexCache = new Map<string, number | null>();
  private vocab = new Map<number, EpubVocabWord[]>();
  private vocabKeys = new Map<number, string[]>();
  private vocabByKey = new Map<string, EpubVocabWord>();
  private annotationKeys = new Map<number, Set<string>>();
  private locationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLocation: EpubLocation | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = 0;
  private lastWheelTurn = 0;
  private sectionTitles = new Map<string, string>();
  private unsubscribePrefs: (() => void) | null = null;
  private docs = new Map<Document, number>();
  private detachers: (() => void)[] = [];
  private pending = new Map<string, Promise<string | null>>();
  private turning = false;
  /** Set while the initial navigation runs: reports a section that loaded without a document. */
  private sectionLoadFailed: ((reason: string) => void) | null = null;
  /** Temporary uid of a new annotation → the uid the core gave it. */
  private aliases = new Map<string, string>();
  private activeSeq = 0;
  /** Annotations deleted in this session: a late save response must not bring them back. */
  private deletedUids = new Set<string>();
  /** Last page-turn animation duration (test hook). */
  lastTurnAnimationMs = 0;
  /** The open watchdog (see `OPEN_TIMEOUT_MS`; tests shorten it). */
  openTimeoutMs = OPEN_TIMEOUT_MS;
  /** External links the user confirmed (test hook; the real opening goes through the opener plugin). */
  readonly openedUrls: string[] = [];

  constructor(
    private readonly host: HTMLElement,
    private readonly events: () => EpubReaderEvents,
    private readonly api: AnnotationApi,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {}

  // ------------------------------------------------------------------ state

  snapshot = (): SessionSnapshot => this.snap;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private set(patch: Partial<SessionSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  get uid(): string | null {
    return this.snap.uid;
  }

  get foliateView(): View | null {
    return this.view;
  }

  // ------------------------------------------------------------------ open / close

  async open(o: EpubOpenOptions): Promise<{ sectionCount: number }> {
    this.close();
    const token = ++this.openToken;
    this.opts = o;
    this.set({ ...EMPTY, status: 'loading', uid: o.uid, title: o.title, drawer: this.snap.drawer });
    try {
      const book = await openEpubBook(o.bytes);
      if (token !== this.openToken) throw new Error('superseded');
      this.book = book;
      await import('@foliate/view.js');
      const view = document.createElement('foliate-view') as View;
      view.style.display = 'block';
      view.style.width = '100%';
      view.style.height = '100%';
      this.view = view;
      this.listen(view);
      this.host.replaceChildren(view);
      await this.watchOpen(async () => {
        await view.open(book);
        if (token !== this.openToken) throw new Error('superseded');
        const r = view.renderer;
        r.setAttribute('flow', 'paginated');
        r.setAttribute('max-column-count', '2');
        r.setAttribute('max-inline-size', '680px');
        r.setAttribute('gap', '6%');
        r.setAttribute('margin', '40px');
        r.setStyles?.(readerCss(getPrefs()));
        this.unsubscribePrefs = subscribePrefs(() => this.applyPrefs(getPrefs()));
        this.indexToc(book);
        this.set({
          toc: mapToc(book.toc, { n: 100000 }),
          sectionCount: book.sections.length,
          fixedLayout: view.isFixedLayout,
        });
        // Annotations before the first section is laid out, so it draws them right away.
        await this.loadAnnotations(o.uid, token);
        if (token !== this.openToken) throw new Error('superseded');
        await this.navigateInitial(o);
      });
      if (token !== this.openToken) throw new Error('superseded');
      this.set({ status: 'ready' });
      return { sectionCount: book.sections.length };
    } catch (e) {
      if (token !== this.openToken) throw e;
      const kind = e instanceof EpubOpenError ? e.kind : e instanceof OpenTimeoutError ? 'timeout' : 'other';
      const message =
        kind === 'drm'
          ? t('epubReader.drm')
          : kind === 'too-large'
            ? t('epubReader.tooLarge')
            : kind === 'timeout'
              ? t('epubReader.openTimeout')
              : t('epubReader.openFailed');
      console.warn('epub: could not open', e);
      // A step still running after the watchdog fired must not touch the error state.
      this.openToken++;
      this.teardownView();
      this.set({ status: 'error', error: { kind, message } });
      this.events().onError(message);
      throw new Error(message);
    }
  }

  /** Opens the last book again (the "Tentar de novo" of the error state). */
  retry(): Promise<{ sectionCount: number }> | null {
    return this.opts ? this.open(this.opts) : null;
  }

  close(): void {
    this.openToken++;
    this.flushLocation();
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = null;
    this.teardownView();
    this.vocab.clear();
    this.vocabKeys.clear();
    this.vocabByKey.clear();
    this.annotationKeys.clear();
    this.sectionIndexCache.clear();
    this.sectionTitles.clear();
    this.aliases.clear();
    this.deletedUids.clear();
    if (this.snap.status !== 'idle') this.set({ ...EMPTY, drawer: this.snap.drawer });
  }

  private teardownView() {
    for (const d of this.detachers.splice(0)) d();
    this.unsubscribePrefs?.();
    this.unsubscribePrefs = null;
    this.docs.clear();
    try {
      this.view?.close();
    } catch (e) {
      console.warn('epub: close', e);
    }
    this.view?.remove();
    this.view = null;
    try {
      this.book?.destroy();
    } catch {
      // Already gone.
    }
    this.book = null;
  }

  /**
   * Opening the book in foliate and the initial navigation, failing instead of hanging when no section can be shown:
   * foliate's paginator never settles when a section frame loads without a document (e.g. refused by the CSP: it
   * throws from the frame's `load` listener, an uncaught error of this window), `view.open`/`goTo` may never resolve,
   * and it silently shows nothing when every section fails to load. Either way the reader must reach its error state
   * ("Tentar de novo"), never spin forever: a watchdog (`openTimeoutMs`) bounds the whole step.
   */
  private async watchOpen(step: () => Promise<void>) {
    let fail: (e: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      fail = reject;
    });
    failed.catch(() => {});
    this.sectionLoadFailed = (reason) => fail(new Error(`section could not be shown: ${reason}`));
    // Only while nothing is on screen yet: later errors are not about opening the book.
    const onError = (ev: ErrorEvent) => {
      if (this.docs.size === 0 && ev.error instanceof Error) fail(new Error(`section failed: ${ev.error.message}`));
    };
    window.addEventListener('error', onError);
    const timer = setTimeout(() => fail(new OpenTimeoutError()), this.openTimeoutMs);
    try {
      await Promise.race([step(), failed]);
      if (this.docs.size === 0) throw new Error('no section could be shown');
    } finally {
      clearTimeout(timer);
      window.removeEventListener('error', onError);
      this.sectionLoadFailed = null;
    }
  }

  private async navigateInitial(o: EpubOpenOptions) {
    const view = this.view!;
    let done = false;
    if (o.cfi) done = !!(await this.safeGoTo(o.cfi));
    if (!done && o.section != null && o.section >= 0 && o.section < view.book.sections.length) {
      done = !!(await this.safeGoTo(o.section));
    }
    if (!done) {
      const first = view.book.sections.findIndex((s) => s.linear !== 'no');
      await this.safeGoTo(first < 0 ? 0 : first);
    }
    if (o.find) await this.findInCurrentSection(o.find);
  }

  private async safeGoTo(target: string | number) {
    try {
      return await this.view?.goTo(target);
    } catch (e) {
      console.warn('epub: goTo', e);
      return undefined;
    }
  }

  async goTo(target: { cfi?: string | null; section?: number | null; find?: string | null }): Promise<{
    found: boolean | null;
  }> {
    if (!this.view) return { found: null };
    let moved = false;
    if (target.cfi) moved = !!(await this.safeGoTo(target.cfi));
    if (!moved && target.section != null && target.section >= 0 && target.section < this.snap.sectionCount) {
      moved = !!(await this.safeGoTo(target.section));
    }
    if (target.find) return { found: await this.findInCurrentSection(target.find) };
    return { found: null };
  }

  /** Selects the first occurrence of `text` in the current section (the "Fonte" link's passage). */
  private async findInCurrentSection(text: string): Promise<boolean> {
    const view = this.view;
    const index = this.currentSection();
    if (!view || index == null) return false;
    const query = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!query) return false;
    try {
      let cfi: string | null = null;
      for await (const r of view.search({ query, index })) {
        if (typeof r === 'object' && 'cfi' in r) {
          cfi = r.cfi;
          break;
        }
      }
      view.clearSearch();
      if (!cfi) return false;
      await view.select(cfi);
      return true;
    } catch (e) {
      console.warn('epub: find', e);
      return false;
    }
  }

  // ------------------------------------------------------------------ foliate events

  private listen(view: View) {
    const on = (name: string, f: (detail: never) => void) => {
      const h = (e: Event) => f((e as CustomEvent).detail as never);
      view.addEventListener(name, h);
      this.detachers.push(() => view.removeEventListener(name, h));
    };
    on('relocate', (d: RelocateDetail) => this.onRelocate(d));
    on('load', (d: { doc: Document; index: number }) => this.onLoad(d.doc, d.index));
    on('create-overlay', (d: { index: number }) => {
      // The overlayer is attached right after this event returns.
      queueMicrotask(() => this.onOverlay(d.index));
    });
    on('show-annotation', (d: { value: string; index: number; range: Range }) => this.onOverlayClick(d));
    view.addEventListener('external-link', (e) => {
      e.preventDefault();
      const href = String((e as CustomEvent<{ href_: string }>).detail?.href_ ?? '');
      if (/^https?:\/\//i.test(href.trim())) this.set({ externalUrl: href.trim() });
    });
    // Page turns from the chrome around the book (focus on the host).
    const onHostKey = (e: KeyboardEvent) => this.onKeyDown(e, false);
    const onHostWheel = (e: WheelEvent) => this.onWheel(e);
    this.host.addEventListener('keydown', onHostKey);
    this.host.addEventListener('wheel', onHostWheel, { passive: true });
    this.detachers.push(() => {
      this.host.removeEventListener('keydown', onHostKey);
      this.host.removeEventListener('wheel', onHostWheel);
    });
  }

  private onLoad(doc: Document | null, index: number) {
    if (!doc?.documentElement) {
      // A frame without a (readable) document: nothing can be shown or annotated in it.
      this.sectionLoadFailed?.(`section ${index} has no document`);
      return;
    }
    this.docs.set(doc, index);
    const theme = getPrefs().theme;
    try {
      fixLinkContrast(doc, theme);
    } catch {
      // Cosmetic only.
    }
    const activity = () => this.activity();
    doc.addEventListener('pointerdown', activity, { passive: true });
    doc.addEventListener('touchstart', activity, { passive: true });
    doc.addEventListener('keydown', (e) => this.onKeyDown(e, true));
    doc.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    doc.addEventListener('click', (e) => this.onDocClick(e, doc));
    doc.addEventListener('selectionchange', () => this.scheduleSelection());
  }

  private onOverlay(index: number) {
    this.annotationKeys.delete(index);
    this.vocabKeys.delete(index);
    this.drawAnnotations(index);
    this.drawVocab(index);
    const uid = this.snap.uid;
    if (uid) this.events().onSectionShown(uid, index);
  }

  private onRelocate(d: RelocateDetail) {
    const view = this.view;
    const uid = this.snap.uid;
    if (!view || !uid) return;
    const section = d.section?.current ?? this.currentSection() ?? 0;
    const location: EpubLocation = {
      uid,
      section,
      sectionCount: this.snap.sectionCount || view.book.sections.length,
      cfi: d.cfi,
      fraction: Math.min(1, Math.max(0, d.fraction ?? 0)),
      tocLabel: d.tocItem?.label?.trim() || this.sectionTitle(section),
    };
    const moved = this.snap.location?.cfi !== location.cfi;
    this.set({
      location,
      tocId: typeof d.tocItem?.id === 'number' ? d.tocItem.id : null,
      bookmarkHere: this.findBookmarkHere(d.range, section),
      ...(moved ? { active: null } : {}),
    });
    if (this.turning) {
      this.turning = false;
      this.animateTurn();
    }
    this.pendingLocation = location;
    if (!this.locationTimer) {
      this.locationTimer = setTimeout(() => this.flushLocation(), LOCATION_DEBOUNCE_MS);
    }
    // The selection's place on screen changed.
    if (this.snap.selection) this.updateSelection();
  }

  private flushLocation() {
    if (this.locationTimer) clearTimeout(this.locationTimer);
    this.locationTimer = null;
    const l = this.pendingLocation;
    this.pendingLocation = null;
    if (l) this.events().onLocation(l);
  }

  private animateTurn() {
    const el = this.view;
    if (!el || reducedMotion() || typeof el.animate !== 'function') {
      this.lastTurnAnimationMs = 0;
      return;
    }
    this.lastTurnAnimationMs = TURN_ANIMATION_MS;
    el.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: TURN_ANIMATION_MS, easing: 'ease-out' });
  }

  // ------------------------------------------------------------------ input

  private activity() {
    const uid = this.snap.uid;
    if (!uid) return;
    const now = Date.now();
    if (now - this.lastActivity < ACTIVITY_INTERVAL_MS) return;
    this.lastActivity = now;
    this.events().onActivity(uid);
  }

  private onKeyDown(e: KeyboardEvent, inBook: boolean) {
    if (inBook) {
      this.activity();
      if (isAppShortcut(e)) {
        this.events().onKey(e);
        return;
      }
      // Keys in the book's frames never reach the reader's chrome: Escape closes an open drawer here.
      if (e.key === 'Escape' && this.snap.drawer) {
        this.setDrawer(null);
        return;
      }
    }
    const action = pageKeyAction(e);
    if (!action) return;
    if (!inBook && e.target !== this.host && !(e.target instanceof Element && this.host.contains(e.target))) return;
    e.preventDefault();
    void this.turn(action);
  }

  private onWheel(e: WheelEvent) {
    this.activity();
    if (e.ctrlKey) return;
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(delta) < 4) return;
    const now = Date.now();
    if (now - this.lastWheelTurn < WHEEL_GAP_MS) {
      this.lastWheelTurn = now;
      return;
    }
    this.lastWheelTurn = now;
    void this.turn(delta > 0 ? 'next' : 'prev');
  }

  private onDocClick(e: MouseEvent, doc: Document) {
    if (e.defaultPrevented || e.button !== 0) return;
    const target = e.target as Element | null;
    if (target?.closest?.('a[href]')) return;
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const hit = this.overlayerFor(this.docs.get(doc) ?? -1)?.overlayer.hitTest({ x: e.clientX, y: e.clientY });
    if (hit && hit.length) return;
    const frame = frameOf(doc);
    if (!frame) return;
    const fr = frame.getBoundingClientRect();
    const scale = frame.offsetWidth ? fr.width / frame.offsetWidth : 1;
    const host = this.host.getBoundingClientRect();
    const x = fr.left + e.clientX * scale - host.left;
    if (x < host.width * 0.2) void this.turn('left');
    else if (x > host.width * 0.8) void this.turn('right');
  }

  async turn(action: PageKeyAction): Promise<void> {
    const view = this.view;
    if (!view) return;
    // The next relocate is this turn's: it gets the short fade (foliate doesn't say why it relocated).
    this.turning = true;
    try {
      if (action === 'left') await view.goLeft();
      else if (action === 'right') await view.goRight();
      else if (action === 'next') await view.next();
      else await view.prev();
    } catch (e) {
      console.warn('epub: turn', e);
    } finally {
      this.turning = false;
    }
  }

  // ------------------------------------------------------------------ selection

  private scheduleSelection() {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.updateSelection();
    }, SELECTION_DEBOUNCE_MS);
  }

  private updateSelection() {
    const sel = this.selectionNow();
    const prev = this.snap.selection;
    if (!sel && !prev) return;
    if (sel && prev && sel.cfi === prev.cfi && sel.rect.every((v, i) => Math.abs(v - prev.rect[i]!) < 0.5)) return;
    this.set({ selection: sel });
    this.events().onSelection(sel);
  }

  /** The current selection in the book, computed now. */
  selectionNow(): EpubSelection | null {
    const view = this.view;
    const uid = this.snap.uid;
    if (!view || !uid) return null;
    for (const { doc, index } of view.renderer?.getContents?.() ?? []) {
      const sel = doc?.getSelection?.();
      if (!sel || sel.isCollapsed || !sel.rangeCount) continue;
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const range = sel.getRangeAt(0);
      let cfi: string;
      try {
        cfi = view.getCFI(index, range);
      } catch {
        continue;
      }
      const rect = this.toHostRect(range.getBoundingClientRect(), doc);
      if (!rect) continue;
      return { uid, section: index, cfi, text, rect };
    }
    return null;
  }

  clearSelection() {
    for (const { doc } of this.view?.renderer?.getContents?.() ?? []) doc?.getSelection?.()?.removeAllRanges();
    if (this.snap.selection) {
      this.set({ selection: null });
      this.events().onSelection(null);
    }
  }

  /** A rect in the section iframe → [left, top, width, height] relative to the host. */
  private toHostRect(r: DOMRect | DOMRectReadOnly, doc: Document): Rect | null {
    const frame = frameOf(doc);
    if (!frame) return null;
    const fr = frame.getBoundingClientRect();
    const scale = frame.offsetWidth ? fr.width / frame.offsetWidth : 1;
    const host = this.host.getBoundingClientRect();
    return [fr.left + r.left * scale - host.left, fr.top + r.top * scale - host.top, r.width * scale, r.height * scale];
  }

  // ------------------------------------------------------------------ annotations

  private async loadAnnotations(uid: string, token: number) {
    try {
      const list = await this.api.list(uid);
      if (token !== this.openToken) return;
      this.set({ annotations: sortAnnotations(list), notice: null });
    } catch (e) {
      console.warn('epub: annotations', e);
      this.set({ notice: t('epubReader.loadFailed') });
    }
  }

  sectionOf(cfi: string): number | null {
    if (this.sectionIndexCache.has(cfi)) return this.sectionIndexCache.get(cfi)!;
    let index: number | null = null;
    try {
      const r = this.view?.resolveCFI(cfi);
      index = r && Number.isInteger(r.index) && r.index >= 0 ? r.index : null;
    } catch {
      index = null;
    }
    this.sectionIndexCache.set(cfi, index);
    return index;
  }

  private overlayerFor(index: number): { overlayer: Overlayer; doc: Document } | null {
    const c = this.view?.renderer?.getContents?.().find((x) => x.index === index && x.overlayer);
    return c?.overlayer ? { overlayer: c.overlayer, doc: c.doc } : null;
  }

  private drawAnnotations(index: number) {
    const o = this.overlayerFor(index);
    if (!o) return;
    const old = this.annotationKeys.get(index);
    if (old) for (const k of old) o.overlayer.remove(k);
    const keys = new Set<string>();
    const dark = getPrefs().theme === 'dark';
    for (const a of this.snap.annotations) {
      if (!isDrawn(a.kind) || (this.sectionOf(a.cfi) ?? a.section) !== index) continue;
      try {
        const anchor = this.view!.resolveCFI(a.cfi).anchor(o.doc);
        // A Range of the section's realm (instanceof Range would be the app's).
        if (!anchor || !('startContainer' in anchor)) continue;
        const key = `ann:${a.uid}`;
        const color = normalizeColor(a.color);
        if (a.kind === 'underline') o.overlayer.add(key, anchor, drawUnderline, { color, id: a.uid });
        else o.overlayer.add(key, anchor, drawHighlight, { color, dark, note: a.kind === 'note', id: a.uid });
        keys.add(key);
      } catch (e) {
        console.warn('epub: cannot draw annotation', a.uid, e);
      }
    }
    this.annotationKeys.set(index, keys);
  }

  private redrawAllAnnotations() {
    for (const { index } of this.view?.renderer?.getContents?.() ?? []) this.drawAnnotations(index);
  }

  private findBookmarkHere(range: Range | null | undefined, section: number): EpubAnnotation | null {
    const view = this.view;
    if (!view || !range) return null;
    const bookmarks = this.snap.annotations.filter((a) => a.kind === 'bookmark');
    if (!bookmarks.length) return null;
    try {
      const start = range.cloneRange();
      start.collapse(true);
      const end = range.cloneRange();
      end.collapse(false);
      const a = view.getCFI(section, start);
      const b = view.getCFI(section, end);
      return bookmarks.find((m) => compareCfi(m.cfi, a) >= 0 && compareCfi(m.cfi, b) <= 0) ?? null;
    } catch {
      return null;
    }
  }

  private refreshBookmarkHere() {
    const l = this.view?.lastLocation;
    const section = this.snap.location?.section;
    this.set({ bookmarkHere: l && section != null ? this.findBookmarkHere(l.range, section) : null });
  }

  /** Puts `a` in the list (replacing the same uid, and `removeUid` if given), or just removes `removeUid`. */
  private replaceAnnotation(a: EpubAnnotation | null, removeUid?: string) {
    let list = this.snap.annotations.filter((x) => x.uid !== a?.uid && x.uid !== removeUid);
    if (a) list = sortAnnotations([...list, a]);
    this.set({ annotations: list });
  }

  /** Creates a highlight/underline/note from the current selection. */
  async annotateSelection(
    kind: Exclude<EpubAnnotationKind, 'bookmark'>,
    color = DEFAULT_COLOR,
  ): Promise<EpubAnnotation | null> {
    const sel = this.selectionNow() ?? this.snap.selection;
    const uid = this.snap.uid;
    if (!sel || !uid) return null;
    const input: EpubAnnotationInput = {
      bookUid: uid,
      kind,
      cfi: sel.cfi,
      text: sel.text.slice(0, 4000),
      color: normalizeColor(color),
      comment: null,
    };
    this.clearSelection();
    return this.create(input, sel.section, kind === 'note' ? sel.rect : null);
  }

  /**
   * Shows a new annotation at once (under a temporary uid) and stores it; the core picks the real uid. Edits made
   * meanwhile wait for it (`resolveUid`).
   */
  private create(input: EpubAnnotationInput, section: number, noteRect: Rect | null): Promise<EpubAnnotation | null> {
    const temp = `tmp-${newAnnotationUid()}`;
    const optimistic: EpubAnnotation = {
      uid: temp,
      bookUid: input.bookUid,
      kind: input.kind,
      cfi: input.cfi,
      section,
      text: input.text ?? null,
      color: input.color ?? null,
      comment: input.comment ?? null,
      updatedAt: Date.now(),
    };
    this.replaceAnnotation(optimistic);
    if (input.kind === 'bookmark') this.set({ bookmarkHere: optimistic });
    else this.drawAnnotations(section);
    if (noteRect) this.set({ active: { uid: temp, rect: noteRect, focusComment: true, seq: ++this.activeSeq } });
    const done = (async () => {
      try {
        const stored = await this.api.upsert(input);
        this.aliases.set(temp, stored.uid);
        if (this.snap.uid === input.bookUid) {
          this.replaceAnnotation(stored, temp);
          if (this.snap.active?.uid === temp) this.set({ active: { ...this.snap.active, uid: stored.uid } });
          this.set({ notice: null });
          if (input.kind === 'bookmark') this.refreshBookmarkHere();
          else this.drawAnnotations(section);
        }
        return stored;
      } catch (e) {
        console.warn('epub: save annotation', e);
        if (this.snap.uid === input.bookUid) {
          this.replaceAnnotation(null, temp);
          if (this.snap.active?.uid === temp) this.set({ active: null });
          if (input.kind === 'bookmark') this.refreshBookmarkHere();
          else this.drawAnnotations(section);
          this.set({ notice: t('epubReader.saveFailed') });
        }
        return null;
      } finally {
        this.pending.delete(temp);
      }
    })();
    this.pending.set(
      temp,
      done.then((a) => a?.uid ?? null),
    );
    return done;
  }

  /** The stored uid of an annotation (waits for a pending creation). */
  private async resolveUid(uid: string): Promise<string | null> {
    const p = this.pending.get(uid);
    if (p) return p;
    return this.aliases.get(uid) ?? uid;
  }

  /** Changes an annotation (colour; comment → note/highlight). */
  async updateAnnotation(
    uid: string,
    patch: Partial<Pick<EpubAnnotation, 'color' | 'comment'>>,
  ): Promise<EpubAnnotation | null> {
    const realUid = await this.resolveUid(uid);
    const a = realUid ? this.snap.annotations.find((x) => x.uid === realUid) : undefined;
    if (!a || !realUid) return null;
    const next: EpubAnnotation = { ...a, ...patch, updatedAt: Date.now() };
    if (next.kind !== 'bookmark') next.color = normalizeColor(next.color);
    next.comment = next.comment?.trim() ? next.comment : null;
    // A highlight with a comment is a note; a note without one is a highlight again.
    if (patch.comment !== undefined && (next.kind === 'highlight' || next.kind === 'note')) {
      next.kind = next.comment ? 'note' : 'highlight';
    }
    this.replaceAnnotation(next);
    const section = this.drawSectionOf(next);
    try {
      const stored = await this.api.upsert({
        uid: realUid,
        bookUid: next.bookUid,
        kind: next.kind,
        cfi: next.cfi,
        text: next.text,
        color: next.color,
        comment: next.comment,
      });
      if (this.snap.uid === a.bookUid && !this.deletedUids.has(realUid)) {
        this.replaceAnnotation(stored);
        this.set({ notice: null });
        if (section != null) this.drawAnnotations(section);
      }
      return stored;
    } catch (e) {
      console.warn('epub: update annotation', e);
      if (this.snap.uid === a.bookUid && !this.deletedUids.has(realUid)) {
        this.replaceAnnotation(a);
        if (section != null) this.drawAnnotations(section);
        this.set({ notice: t('epubReader.saveFailed') });
      }
      return null;
    }
  }

  async deleteAnnotation(uid: string): Promise<void> {
    const realUid = await this.resolveUid(uid);
    const a = realUid ? this.snap.annotations.find((x) => x.uid === realUid) : undefined;
    if (!a || !realUid) return;
    this.deletedUids.add(realUid);
    this.replaceAnnotation(null, realUid);
    if (this.snap.active?.uid === realUid || this.snap.active?.uid === uid) this.set({ active: null });
    const section = this.drawSectionOf(a);
    this.refreshBookmarkHere();
    try {
      await this.api.remove(realUid);
    } catch (e) {
      console.warn('epub: delete annotation', e);
      this.deletedUids.delete(realUid);
      if (this.snap.uid === a.bookUid) {
        this.replaceAnnotation(a);
        if (section != null) this.drawAnnotations(section);
        this.refreshBookmarkHere();
        this.set({ notice: t('epubReader.deleteFailed') });
      }
    }
  }

  /** Redraws the section of `a` (if on screen) and returns it. */
  private drawSectionOf(a: EpubAnnotation): number | null {
    const section = this.sectionOf(a.cfi) ?? a.section;
    if (section != null && a.kind !== 'bookmark') this.drawAnnotations(section);
    return section;
  }

  /** Adds or removes the bookmark of the visible page. */
  async toggleBookmark(): Promise<void> {
    const here = this.snap.bookmarkHere;
    if (here) return this.deleteAnnotation(here.uid);
    const view = this.view;
    const uid = this.snap.uid;
    const loc = this.snap.location;
    const range = view?.lastLocation?.range;
    if (!view || !uid || !loc || !range) return;
    const start = range.cloneRange();
    start.collapse(true);
    let cfi: string;
    try {
      cfi = view.getCFI(loc.section, start);
    } catch {
      return;
    }
    await this.create(
      {
        bookUid: uid,
        kind: 'bookmark',
        cfi,
        text: excerpt(range.toString(), 120) || null,
        color: null,
        comment: null,
      },
      loc.section,
      null,
    );
  }

  private onOverlayClick(d: { value: string; index: number; range: Range }) {
    const uid = this.snap.uid;
    if (!uid) return;
    const o = this.overlayerFor(d.index);
    const rect = o ? this.toHostRect(d.range.getBoundingClientRect(), o.doc) : null;
    if (!rect) return;
    if (d.value.startsWith('vocab:')) {
      const word = this.vocabByKey.get(d.value);
      if (word) this.events().onVocabClick({ uid, section: d.index, form: word.form, lemma: word.lemma, rect });
      return;
    }
    if (d.value.startsWith('ann:')) {
      const annUid = d.value.slice(4);
      // A click that ends a selection is the selection's, not the annotation's.
      if (this.selectionNow()) return;
      this.set({ active: { uid: annUid, rect, focusComment: false, seq: ++this.activeSeq } });
    }
  }

  setActive(active: SessionSnapshot['active']) {
    this.set({ active });
  }

  async goToAnnotation(uid: string) {
    const a = this.snap.annotations.find((x) => x.uid === uid);
    if (a) await this.safeGoTo(a.cfi);
  }

  dismissNotice() {
    this.set({ notice: null });
  }

  // ------------------------------------------------------------------ vocabulary

  setVocabMarks(section: number, words: EpubVocabWord[] | null) {
    if (words && words.length) this.vocab.set(section, words);
    else this.vocab.delete(section);
    this.drawVocab(section);
  }

  clearVocabMarks() {
    const sections = [...this.vocab.keys(), ...this.vocabKeys.keys()];
    this.vocab.clear();
    for (const s of new Set(sections)) this.drawVocab(s);
  }

  private drawVocab(index: number) {
    const o = this.overlayerFor(index);
    const old = this.vocabKeys.get(index);
    if (o && old) for (const k of old) o.overlayer.remove(k);
    if (old) for (const k of old) this.vocabByKey.delete(k);
    this.vocabKeys.delete(index);
    const words = this.vocab.get(index);
    if (!o || !words?.length) return;
    const keys: string[] = [];
    for (const [i, { range, word }] of findVocabRanges(o.doc, words).entries()) {
      const key = `vocab:${index}:${i}`;
      try {
        o.overlayer.add(key, range, drawUnderline, { color: word.color, kind: 'vocab', id: key });
        keys.push(key);
        this.vocabByKey.set(key, word);
      } catch {
        // A range without boxes (hidden text): skip.
      }
    }
    this.vocabKeys.set(index, keys);
  }

  // ------------------------------------------------------------------ prefs, drawers, links, search

  private applyPrefs(p: EpubPrefs) {
    const view = this.view;
    if (!view) return;
    view.renderer?.setStyles?.(readerCss(p));
    for (const { doc } of view.renderer?.getContents?.() ?? []) {
      try {
        fixLinkContrast(doc, p.theme);
      } catch {
        // Cosmetic only.
      }
    }
    this.redrawAllAnnotations();
  }

  setDrawer(drawer: DrawerKind | null) {
    this.set({ drawer });
  }

  async confirmExternal(open: boolean) {
    const url = this.snap.externalUrl;
    this.set({ externalUrl: null });
    if (!open || !url || !/^https?:\/\//i.test(url)) return;
    this.openedUrls.push(url);
    try {
      await this.openUrl(url);
    } catch (e) {
      console.warn('epub: open url', e);
    }
  }

  async goToHref(href: string) {
    await this.safeGoTo(href);
  }

  currentSection(): number | null {
    return this.snap.location?.section ?? this.view?.renderer?.getContents?.()[0]?.index ?? null;
  }

  private indexToc(book: EPUB) {
    const walk = (items: TocItem[] | null | undefined) => {
      for (const item of items ?? []) {
        const id = book.splitTOCHref(item.href ?? '')[0];
        if (id && !this.sectionTitles.has(id)) this.sectionTitles.set(id, (item.label ?? '').trim());
        walk(item.subitems);
      }
    };
    try {
      walk(book.toc);
    } catch {
      // No usable TOC.
    }
  }

  /** The TOC label of a section (the first TOC entry pointing into it). */
  sectionTitle(section: number): string | null {
    const id = this.book?.sections[section]?.id;
    return (id && this.sectionTitles.get(id)) || null;
  }

  /** Searches the whole book; `onHits` gets the growing list and the progress (0..1). Returns a cancel function. */
  search(query: string, onHits: (hits: SearchHit[], progress: number, done: boolean) => void): () => void {
    const view = this.view;
    let cancelled = false;
    const q = query.trim();
    if (!view || !q) {
      view?.clearSearch();
      onHits([], 1, true);
      return () => {};
    }
    const hits: SearchHit[] = [];
    void (async () => {
      try {
        for await (const r of view.search({ query: q })) {
          if (cancelled) break;
          if (r === 'done') break;
          if ('progress' in r) {
            onHits([...hits], r.progress, false);
          } else if ('subitems' in r) {
            for (const s of r.subitems) {
              if (hits.length >= MAX_SEARCH_HITS) break;
              const section = this.sectionOf(s.cfi);
              hits.push({
                cfi: s.cfi,
                section,
                label: r.label || (section != null ? (this.sectionTitle(section) ?? '') : ''),
                ...s.excerpt,
              });
            }
            onHits([...hits], 1, false);
            if (hits.length >= MAX_SEARCH_HITS) break;
          }
        }
        if (!cancelled) onHits([...hits], 1, true);
      } catch (e) {
        console.warn('epub: search', e);
        if (!cancelled) onHits([...hits], 1, true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }

  clearSearch() {
    this.view?.clearSearch();
  }

  async goToCfi(cfi: string) {
    await this.safeGoTo(cfi);
  }

  focus() {
    try {
      this.view?.renderer?.focusView();
    } catch {
      this.host.focus();
    }
  }
}
