import { describe, expect, it, vi } from 'vitest';
import { MAX_MARK_PAGES, type PageMarks } from './bridge';
import { UID_A, UID_B } from './testing';
import {
  HIGHLIGHT_KEY,
  KEEP_EXTRA,
  MARK_COLORS,
  markWindow,
  PAGES_AFTER,
  PAGES_BEFORE,
  VOCAB_SET,
  VocabMarks,
  type VocabMark,
  type VocabPageMarks,
} from './vocabMarks';

const mark = (lemma: string, status: VocabMark['status'] = 'unknown', x = 10): VocabMark => ({
  lemma,
  form: lemma,
  status,
  rects: [[x, 100, 40, 12]],
});

interface Deferred {
  uid: string;
  pages: number[];
  resolve: (r: VocabPageMarks[] | null) => void;
  reject: (e: unknown) => void;
}

function setup(opts: { open?: string[]; stored?: string | null; marks?: (page: number) => VocabMark[] } = {}) {
  const store = new Map<string, string>();
  if (opts.stored) store.set(HIGHLIGHT_KEY, opts.stored);
  const open = new Set(opts.open ?? [UID_A]);
  const sent: { uid: string; set: string; pages: PageMarks[] }[] = [];
  const cleared: { uid: string; set: string }[] = [];
  const calls: Deferred[] = [];
  const onError = vi.fn();
  let byPage = opts.marks ?? ((page: number) => [mark(`w${page}`), mark(`l${page}`, 'learning', 60)]);
  let notScanned = false;
  let auto = true;
  const fetch = vi.fn(
    (uid: string, pages: number[]) =>
      new Promise<VocabPageMarks[] | null>((resolve, reject) => {
        const d = { uid, pages, resolve, reject };
        calls.push(d);
        if (auto) resolve(notScanned ? null : pages.map((page) => ({ page, marks: byPage(page) })));
      }),
  );
  const m = new VocabMarks({
    fetch,
    isOpen: (uid) => open.has(uid),
    sendMarks: (uid, set, pages) => {
      sent.push({ uid, set, pages });
      return true;
    },
    clearMarks: (uid, set) => {
      cleared.push({ uid, set });
      return true;
    },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    onError,
  });
  return {
    m,
    fetch,
    sent,
    cleared,
    calls,
    store,
    onError,
    open,
    setMarks: (fn: (page: number) => VocabMark[]) => (byPage = fn),
    setNotScanned: (v: boolean) => (notScanned = v),
    setAuto: (v: boolean) => (auto = v),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const pagesOf = (s: { pages: PageMarks[] }) => s.pages.map((p) => p.page);

describe('markWindow', () => {
  it('is the page, the one before and the two after, inside the document', () => {
    expect(markWindow(5, 12)).toEqual([4, 5, 6, 7]);
    expect(markWindow(0, 12)).toEqual([0, 1, 2]);
    expect(markWindow(11, 12)).toEqual([10, 11]);
    expect(markWindow(0, 1)).toEqual([0]);
    expect(markWindow(3, 0)).toEqual([]);
  });
});

describe('VocabMarks', () => {
  it('sends nothing while the highlight is off', async () => {
    const t = setup();
    t.m.view(UID_A, 3, 12);
    await settle();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it('asks for the page in front and its neighbours once, with coral and amber underlines', async () => {
    const t = setup();
    t.m.view(UID_A, 3, 12);
    t.m.setOn(UID_A, true);
    await settle();
    expect(t.fetch).toHaveBeenCalledWith(UID_A, [2, 3, 4, 5]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.set).toBe(VOCAB_SET);
    expect(pagesOf(t.sent[0]!)).toEqual([2, 3, 4, 5]);
    expect(t.sent[0]!.pages[0]!.marks).toEqual([
      { rects: [[10, 100, 40, 12]], color: MARK_COLORS.unknown },
      { rects: [[60, 100, 40, 12]], color: MARK_COLORS.learning },
    ]);
    expect(MARK_COLORS).toEqual({ unknown: '#d85a30', learning: '#ba7517' });

    // The same page again: nothing new. The next page: only the page not sent yet.
    t.m.view(UID_A, 3, 12);
    await settle();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.m.view(UID_A, 4, 12);
    await settle();
    expect(t.fetch).toHaveBeenLastCalledWith(UID_A, [6]);
    expect(pagesOf(t.sent.at(-1)!)).toEqual([6]);
  });

  it('never asks twice for a page still on its way', async () => {
    const t = setup();
    t.setAuto(false);
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 12);
    t.m.view(UID_A, 1, 12);
    expect(t.fetch.mock.calls.map((c) => c[1])).toEqual([[0, 1, 2], [3]]);
  });

  it('maps a click index to the mark at that position of the page', async () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 3);
    await settle();
    expect(t.m.markAt(UID_A, 1, 0)?.lemma).toBe('w1');
    expect(t.m.markAt(UID_A, 1, 1)).toMatchObject({ lemma: 'l1', status: 'learning' });
    expect(t.m.markAt(UID_A, 1, 2)).toBeNull();
    expect(t.m.markAt(UID_B, 1, 0)).toBeNull();
  });

  it('clears the marks when turned off and drops answers that arrive after', async () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 3);
    await settle();
    t.setAuto(false);
    t.m.view(UID_A, 2, 6);
    t.m.setOn(UID_A, false);
    expect(t.cleared).toEqual([{ uid: UID_A, set: VOCAB_SET }]);
    t.calls.at(-1)!.resolve([{ page: 4, marks: [mark('late')] }]);
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.m.markAt(UID_A, 0, 0)).toBeNull();
  });

  it('remembers the choice per book in localStorage', () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    expect(JSON.parse(t.store.get(HIGHLIGHT_KEY)!)).toEqual([UID_A]);
    const again = setup({ stored: JSON.stringify([UID_B, 7]) });
    expect(again.m.isOn(UID_B)).toBe(true);
    expect(again.m.isOn(UID_A)).toBe(false);
    expect(setup({ stored: '{not json' }).m.isOn(UID_A)).toBe(false);
  });

  it('sends only the pages that changed after a refresh ("Já sei"), clearing a page left without marks', async () => {
    const t = setup({
      marks: (p) => (p === 1 ? [mark('windmill'), mark('animals', 'learning', 80)] : [mark(`x${p}`)]),
    });
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 3);
    await settle();
    expect(t.sent).toHaveLength(1);
    // "Já sei" on windmill: page 1 loses it; page 2 loses its only mark.
    t.setMarks((p) => (p === 1 ? [mark('animals', 'learning', 80)] : p === 2 ? [] : [mark(`x${p}`)]));
    t.m.refresh(UID_A);
    await settle();
    expect(t.fetch).toHaveBeenLastCalledWith(UID_A, [0, 1, 2]);
    const last = t.sent.at(-1)!;
    expect(last.pages).toEqual([
      { page: 1, marks: [{ rects: [[80, 100, 40, 12]], color: MARK_COLORS.learning }] },
      { page: 2, marks: [] },
    ]);
    expect(t.m.markAt(UID_A, 1, 0)?.lemma).toBe('animals');
    // Nothing changed: no message.
    t.m.refresh(UID_A);
    await settle();
    expect(t.sent).toHaveLength(2);
  });

  it('turns a word amber after it was added (status change on the same rects)', async () => {
    const t = setup({ marks: () => [mark('windmill')] });
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 1);
    await settle();
    t.setMarks(() => [mark('windmill', 'learning')]);
    t.m.refresh();
    await settle();
    expect(t.sent.at(-1)!.pages).toEqual([{ page: 0, marks: [{ rects: [[10, 100, 40, 12]], color: '#ba7517' }] }]);
  });

  it('clears pages out of view on a refresh', async () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 20);
    await settle();
    t.m.view(UID_A, 4, 20);
    await settle();
    t.m.refresh(UID_A);
    await settle();
    const last = t.sent.at(-1)!;
    // Pages 0–2 (sent before, still kept but out of the window) are cleared in the same message; 3–6 are unchanged.
    expect(last.pages).toEqual([0, 1, 2].map((page) => ({ page, marks: [] })));
    expect(t.cleared).toEqual([]);
  });

  it('clears and forgets pages far from the one in front as the reader moves', async () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 20);
    await settle();
    t.m.view(UID_A, 10, 20);
    // The clear goes out before the new window is fetched.
    expect(t.sent.at(-1)!.pages).toEqual([0, 1, 2].map((page) => ({ page, marks: [] })));
    await settle();
    expect(pagesOf(t.sent.at(-1)!)).toEqual([9, 10, 11, 12]);
    expect(t.m.markAt(UID_A, 0, 0)).toBeNull();
    expect(t.m.markAt(UID_A, 10, 0)?.lemma).toBe('w10');
    // Back a little: only the pages never sent are fetched; 9–12 are still held.
    const fetched = t.fetch.mock.calls.length;
    t.m.view(UID_A, 8, 20);
    await settle();
    expect(t.fetch.mock.calls.at(-1)![1]).toEqual([7, 8]);
    expect(t.fetch.mock.calls.length).toBe(fetched + 1);
  });

  it('keeps a bounded number of pages over a long reading session', async () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    // What PdfCraft holds, replayed from the messages (an empty list clears the page).
    const held = new Set<number>();
    let seen = 0;
    let most = 0;
    for (let p = 0; p < 300; p++) {
      t.m.view(UID_A, p, 300);
      await settle();
      for (const msg of t.sent.slice(seen)) {
        expect(msg.pages.length).toBeLessThanOrEqual(MAX_MARK_PAGES);
        for (const pm of msg.pages) {
          if (pm.marks.length > 0) held.add(pm.page);
          else held.delete(pm.page);
        }
      }
      seen = t.sent.length;
      most = Math.max(most, held.size);
      for (const h of held) expect(Math.abs(h - p)).toBeLessThanOrEqual(PAGES_AFTER + KEEP_EXTRA);
    }
    expect(most).toBeLessThanOrEqual(PAGES_BEFORE + PAGES_AFTER + 1 + 2 * KEEP_EXTRA);
    expect([...held].sort((a, b) => a - b)).toEqual([295, 296, 297, 298, 299]);
    // A jump far away clears what was held.
    t.m.view(UID_A, 10, 300);
    await settle();
    for (const msg of t.sent.slice(seen))
      for (const pm of msg.pages) {
        if (pm.marks.length > 0) held.add(pm.page);
        else held.delete(pm.page);
      }
    expect([...held].sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
    expect(t.cleared).toEqual([]);
  });

  it('sends nothing for a book that was never scanned', async () => {
    const t = setup();
    t.setNotScanned(true);
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 4);
    await settle();
    expect(t.sent).toEqual([]);
    expect(t.m.snapshot().notScanned).toEqual([UID_A]);
  });

  it('does nothing for a document PdfCraft does not hold', async () => {
    const t = setup({ open: [] });
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 4);
    await settle();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('reports failures, the first one as first, and tries again on the next page', async () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    t.setAuto(false);
    t.m.view(UID_A, 0, 4);
    t.calls.at(-1)!.reject(new Error('boom'));
    await settle();
    t.m.view(UID_A, 1, 4);
    t.calls.at(-1)!.reject(new Error('again'));
    await settle();
    expect(t.onError.mock.calls.map((c) => c[2])).toEqual([true, false]);
    expect(t.fetch.mock.calls[1]![1]).toEqual([0, 1, 2, 3]);
  });

  it('sends everything again after a reload (reset) or when the tab is opened again (forget)', async () => {
    const t = setup();
    t.m.setOn(UID_A, true);
    t.m.view(UID_A, 0, 2);
    await settle();
    t.m.forget(UID_A);
    t.m.view(UID_A, 0, 2);
    await settle();
    expect(t.sent).toHaveLength(2);
    t.m.reset();
    t.m.view(UID_A, 0, 2);
    await settle();
    expect(t.sent).toHaveLength(3);
  });
});
