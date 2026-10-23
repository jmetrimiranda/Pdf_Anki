// Vocabulary highlight during reading (spec 12.7): the app underlines the words of the book in front that the user
// doesn't know (coral) or is learning (amber) through PdfCraft's temporary marks (`pdfcraft:marks`, set 'vocab').
// The core computes the rects (`vocab_marks`); this manager asks for the page in front and its neighbours as
// `pdfcraft:page` arrives, sends each batch once, keeps each page's list (a `pdfcraft:mark-click` index is the
// position in it), clears and forgets pages far from the one in front (bounded memory here and in PdfCraft) and
// sends again what changed after an override, an added word, a rescan or a new version.
// Framework-free (unit tested with fakes); the controller owns one.
import type { VocabMark, VocabPageMarks } from '../../lib/core/types';
import { MAX_MARK_PAGES, type PageMarks } from './bridge';

/** The mark set of the vocabulary highlight. */
export const VOCAB_SET = 'vocab';
/** Spec 4: unknown = coral, learning = amber (2 px underline, never a filled background). */
export const MARK_COLORS = { unknown: '#d85a30', learning: '#ba7517' } as const;
/** localStorage: the books with the highlight on (JSON array of uids). */
export const HIGHLIGHT_KEY = 'leitor.vocab.highlight';
/** Pages around the one in front that get marks: page − BEFORE … page + AFTER. */
export const PAGES_BEFORE = 1;
export const PAGES_AFTER = 2;
/**
 * Pages kept beyond the window on each side (scrolling back doesn't fetch again); the rest are cleared in PdfCraft
 * and forgotten, so a long reading session holds at most `markWindow` + 2 × KEEP_EXTRA pages of marks.
 */
export const KEEP_EXTRA = 3;
/** Most books remembered with the highlight on. */
const MAX_REMEMBERED = 500;

export type MarkStatus = VocabMark['status'];

export type { VocabMark, VocabPageMarks };

export interface VocabMarksDeps {
  /** vocab_marks(uid, pages): the marks of those pages; `null` when the book was never scanned. */
  fetch(uid: string, pages: number[]): Promise<VocabPageMarks[] | null>;
  /** Bridge: the document `uid` is open in PdfCraft. */
  isOpen(uid: string): boolean;
  sendMarks(uid: string, set: string, pages: PageMarks[]): boolean;
  clearMarks(uid: string, set: string): boolean;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** A failure (logged; the UI shows a toast once). */
  onError?(uid: string, e: unknown, first: boolean): void;
}

export interface VocabMarksSnapshot {
  /** Books with the highlight on. */
  on: readonly string[];
  /** Books known to be not scanned (`vocab_marks` said so). */
  notScanned: readonly string[];
}

interface BookState {
  /** Bumped by every refresh/off: answers asked for before are stale. */
  epoch: number;
  /** What PdfCraft holds for each page sent (an empty list = nothing there). */
  sent: Map<number, VocabMark[]>;
  pending: Set<number>;
  page: number;
  pageCount: number;
}

/** The pages around `page` that get marks (clamped to the document, at most MAX_MARK_PAGES). */
export function markWindow(page: number, pageCount: number): number[] {
  if (pageCount <= 0) return [];
  const first = Math.max(0, page - PAGES_BEFORE);
  const last = Math.min(pageCount - 1, page + PAGES_AFTER);
  const out: number[] = [];
  for (let p = first; p <= last && out.length < MAX_MARK_PAGES; p++) out.push(p);
  return out;
}

/** Whether `p` is close enough to `page` for its marks to stay (the window plus KEEP_EXTRA on each side). */
function kept(p: number, page: number): boolean {
  return p >= page - PAGES_BEFORE - KEEP_EXTRA && p <= page + PAGES_AFTER + KEEP_EXTRA;
}

function sameMarks(a: readonly VocabMark[] | undefined, b: readonly VocabMark[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((m, i) => {
    const n = b[i]!;
    return m.status === n.status && m.lemma === n.lemma && JSON.stringify(m.rects) === JSON.stringify(n.rects);
  });
}

function toPageMarks(page: number, marks: readonly VocabMark[]): PageMarks {
  return { page, marks: marks.map((m) => ({ rects: m.rects, color: MARK_COLORS[m.status] })) };
}

export class VocabMarks {
  private readonly deps: VocabMarksDeps;
  private readonly books = new Map<string, BookState>();
  private on: Set<string>;
  private readonly notScanned = new Set<string>();
  private failed = false;
  private readonly listeners = new Set<() => void>();
  private snap: VocabMarksSnapshot;

  constructor(deps: VocabMarksDeps) {
    this.deps = deps;
    this.on = new Set(this.load());
    this.snap = this.makeSnapshot();
  }

  // ------------------------------------------------------------ store

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): VocabMarksSnapshot => this.snap;

  private makeSnapshot(): VocabMarksSnapshot {
    return { on: [...this.on].sort(), notScanned: [...this.notScanned].sort() };
  }

  private changed() {
    const next = this.makeSnapshot();
    if (next.on.join() === this.snap.on.join() && next.notScanned.join() === this.snap.notScanned.join()) return;
    this.snap = next;
    for (const fn of this.listeners) fn();
  }

  private load(): string[] {
    try {
      const raw = this.deps.storage?.getItem(HIGHLIGHT_KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(-MAX_REMEMBERED) : [];
    } catch {
      return [];
    }
  }

  private save() {
    try {
      this.deps.storage?.setItem(HIGHLIGHT_KEY, JSON.stringify([...this.on].slice(-MAX_REMEMBERED)));
    } catch {
      // Storage full or denied: the choice lasts for this run only.
    }
  }

  // ------------------------------------------------------------ public API

  isOn(uid: string): boolean {
    return this.on.has(uid);
  }

  /** Turns the highlight of `uid` on (marks for the page in front and its neighbours) or off (clear-marks). */
  setOn(uid: string, on: boolean) {
    if (on === this.on.has(uid)) return;
    if (on) {
      this.on.add(uid);
      this.save();
      this.changed();
      const st = this.books.get(uid);
      if (st) this.request(uid, st);
      return;
    }
    this.on.delete(uid);
    this.save();
    this.changed();
    const st = this.books.get(uid);
    if (st) {
      st.epoch++;
      st.pending.clear();
      const had = st.sent.size > 0;
      st.sent.clear();
      if (had && this.deps.isOpen(uid)) this.deps.clearMarks(uid, VOCAB_SET);
    }
  }

  /** The page in front of `uid` (`pdfcraft:active` / `pdfcraft:page`): marks for it and its neighbours. */
  view(uid: string, page: number, pageCount: number) {
    let st = this.books.get(uid);
    if (!st) {
      st = { epoch: 0, sent: new Map(), pending: new Set(), page, pageCount };
      this.books.set(uid, st);
    }
    st.page = page;
    if (pageCount > 0) st.pageCount = pageCount;
    if (!this.on.has(uid)) return;
    const out = this.evict(st);
    if (out.length > 0 && this.deps.isOpen(uid)) this.send(uid, out);
    this.request(uid, st);
  }

  /**
   * The marks of `uid` (every book when absent) may have changed (override, added word, rescan, new version): ask
   * again for the pages around the one in front and send what changed; pages sent before and now out of view are
   * cleared.
   */
  refresh(uid?: string) {
    if (uid !== undefined) this.notScanned.delete(uid);
    else this.notScanned.clear();
    this.changed();
    for (const [id, st] of this.books) {
      if (uid !== undefined && id !== uid) continue;
      if (!this.on.has(id)) continue;
      st.epoch++;
      st.pending.clear();
      this.request(id, st, true);
    }
  }

  /** The mark at `index` on `page` of `uid`, as sent to PdfCraft (null when unknown). */
  markAt(uid: string, page: number, index: number): VocabMark | null {
    return this.books.get(uid)?.sent.get(page)?.[index] ?? null;
  }

  /** PdfCraft no longer holds `uid`'s marks (tab closed, opened again). */
  forget(uid: string) {
    const st = this.books.get(uid);
    if (!st) return;
    st.epoch++;
    st.pending.clear();
    st.sent.clear();
  }

  /** A new PdfCraft document (reload): nothing is held there any more. */
  reset() {
    for (const uid of [...this.books.keys()]) this.forget(uid);
    this.books.clear();
  }

  // ------------------------------------------------------------ fetching and sending

  /** Asks for the window's pages not sent yet (`all`: every page of the window, to compare with what was sent). */
  private request(uid: string, st: BookState, all = false) {
    if (!this.deps.isOpen(uid)) return;
    const window = markWindow(st.page, st.pageCount);
    const pages = window.filter((p) => !st.pending.has(p) && (all || !st.sent.has(p)));
    if (pages.length === 0) return;
    for (const p of pages) st.pending.add(p);
    const epoch = st.epoch;
    void this.deps
      .fetch(uid, pages)
      .then((res) => {
        if (st.epoch !== epoch || !this.on.has(uid) || this.books.get(uid) !== st) return;
        for (const p of pages) st.pending.delete(p);
        this.apply(uid, st, pages, res, all);
      })
      .catch((e: unknown) => {
        if (st.epoch === epoch) for (const p of pages) st.pending.delete(p);
        const first = !this.failed;
        this.failed = true;
        this.deps.onError?.(uid, e, first);
      });
  }

  private apply(uid: string, st: BookState, pages: number[], res: VocabPageMarks[] | null, all: boolean) {
    if (res === null) {
      // Not scanned (or no longer: the text changed): nothing to show.
      this.notScanned.add(uid);
      this.changed();
      if (st.sent.size > 0) {
        st.sent.clear();
        this.deps.clearMarks(uid, VOCAB_SET);
      }
      return;
    }
    if (this.notScanned.delete(uid)) this.changed();
    const got = new Map<number, VocabMark[]>();
    // Pages the reader has left while they were fetched are not kept.
    for (const p of pages) if (kept(p, st.page)) got.set(p, []);
    for (const r of res) if (got.has(r.page)) got.set(r.page, r.marks);

    // A full refresh: pages sent before and outside this window are stale now.
    const stale = all ? [...st.sent.keys()].filter((p) => !got.has(p)) : [];
    const out: PageMarks[] = all ? [] : this.evict(st);
    for (const p of stale) {
      if ((st.sent.get(p)?.length ?? 0) > 0) out.push({ page: p, marks: [] });
      st.sent.delete(p);
    }
    for (const [p, marks] of got) {
      const before = st.sent.get(p);
      st.sent.set(p, marks);
      if (sameMarks(before, marks)) continue;
      // A page that had nothing and still has nothing needs no message.
      if (marks.length === 0 && (before?.length ?? 0) === 0) continue;
      out.push(toPageMarks(p, marks));
    }
    if (out.length > 0) this.send(uid, out);
  }

  /** Forgets the pages sent that are far from the one in front; returns the messages that clear them in PdfCraft. */
  private evict(st: BookState): PageMarks[] {
    const out: PageMarks[] = [];
    for (const [p, marks] of st.sent) {
      if (kept(p, st.page)) continue;
      if (marks.length > 0) out.push({ page: p, marks: [] });
      st.sent.delete(p);
    }
    return out;
  }

  /** Sends `pages` in batches of at most MAX_MARK_PAGES (one `pdfcraft:marks` message each). */
  private send(uid: string, pages: PageMarks[]) {
    for (let i = 0; i < pages.length; i += MAX_MARK_PAGES) {
      this.deps.sendMarks(uid, VOCAB_SET, pages.slice(i, i + MAX_MARK_PAGES));
    }
  }
}
