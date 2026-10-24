// The Leitor controller with EPUBs (spec 7.1) and after OCR (spec 7.2): the EPUB reader in front, switching readers,
// the position with its CFI, sessions by section, selection → panel, Ctrl+Shift+N, the vocabulary marks of sections
// and `reloadPdfcraftBook`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpubMarkWord, EpubSectionMarks } from '../../lib/core/types';
import {
  EPUB_FRONT_TIMEOUT_MS,
  LeitorController,
  POSITION_DEBOUNCE_MS,
  type EpubFront,
  type EpubSelectionInfo,
  type LeitorCore,
  type LeitorUi,
  type MarkClick,
  type OpenInfo,
  type PanelRequest,
} from './controller';
import { IDLE_MS } from './sessions';
import { fakeCore, fakeFrame, fakeHost, ORIGIN, UID_A, UID_B, viTimers } from './testing';

const UID_E = 'e'.repeat(64);
const UID_F = 'f'.repeat(64);
const CFI = 'epubcfi(/6/6!/4/2/1:0)';
const CFI_3 = 'epubcfi(/6/8!/4/2/1:12)';

function epubInfo(uid: string): OpenInfo {
  return {
    name: `${uid[0]}.epub`,
    title: `EPUB ${uid[0]}`,
    page: 2,
    pages: 8,
    fileVersion: 1,
    format: 'epub',
    cfi: uid === UID_E ? CFI : null,
  };
}

function setup(over: Partial<LeitorCore> = {}) {
  const { host, deliver } = fakeHost();
  const frame = fakeFrame();
  const base = fakeCore(over);
  const pdfInfo = base.openInfo;
  const core = fakeCore({
    openInfo: vi.fn(async (uid: string) => (uid === UID_E || uid === UID_F ? epubInfo(uid) : pdfInfo(uid))),
    ...over,
  });
  const c = new LeitorController({
    core,
    origin: ORIGIN,
    host,
    timers: viTimers,
    storage: null,
    now: () => Date.now(),
  });
  const ui: LeitorUi = { navigateToLeitor: vi.fn(), toast: vi.fn(), libraryChanged: vi.fn() };
  c.setUi(ui);
  c.setFrameWindow(frame.win as unknown as Window);
  const send = (data: Record<string, unknown>) => deliver(data, frame.win);
  const ready = () => send({ type: 'pdfcraft:ready', version: '0.9', bridge: 3 });
  let selection: EpubSelectionInfo | null = null;
  const front: EpubFront & { calls: string[] } = {
    calls: [],
    open: vi.fn(async (o) => {
      front.calls.push(`open:${o.uid[0]}:${o.cfi}:${o.section}:${o.find}`);
      return { sectionCount: 8 };
    }),
    goTo: vi.fn(async (o) => {
      front.calls.push(`goTo:${o.cfi}:${o.section}:${o.find}`);
      return o.find !== 'nowhere';
    }),
    openDrawer: vi.fn((w) => void front.calls.push(`drawer:${w}`)),
    setVocabMarks: vi.fn(),
    clearVocabMarks: vi.fn(),
    selectionNow: vi.fn(() => selection),
    flush: vi.fn(),
  };
  const setSelection = (s: EpubSelectionInfo | null) => {
    selection = s;
  };
  return { c, core, ui, send, ready, frame, front, setSelection };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
/** Lets a chain of awaited core calls run (openInfo → ready → bytes → open). */
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush();
};

async function openPdf(s: ReturnType<typeof setup>, uid: string, page = 4) {
  const p = s.c.openBook(uid);
  await flush();
  s.send({ type: 'pdfcraft:active', id: uid, page, pageCount: 12 });
  return p;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LeitorController · EPUB open path', () => {
  it('opens an EPUB in the EPUB reader at its last CFI, without PdfCraft', async () => {
    const s = setup();
    s.c.setEpubFront(s.front);
    await expect(s.c.openBook(UID_E)).resolves.toBe(true);
    expect(s.ui.navigateToLeitor).toHaveBeenCalled();
    expect(s.core.bytes).toHaveBeenCalledWith(UID_E);
    expect(s.front.calls).toEqual([`open:e:${CFI}:undefined:null`]);
    // PdfCraft was never needed (not mounted, nothing posted).
    expect(s.c.snapshot().mounted).toBe(false);
    expect(s.frame.posted).toEqual([]);
    expect(s.c.snapshot()).toMatchObject({
      front: 'epub',
      epubMounted: true,
      activeId: UID_E,
      activeBookUid: UID_E,
      activeTitle: 'EPUB e',
      page: 2,
      pageCount: 8,
      epub: { uid: UID_E, title: 'EPUB e', section: 2, sectionCount: 8, cfi: CFI },
    });
  });

  it('waits for the reader to mount (the first EPUB mounts it), and gives up after a while', async () => {
    const s = setup();
    const opening = s.c.openBook(UID_E);
    await flush();
    expect(s.c.snapshot().epubMounted).toBe(true);
    expect(s.front.open).not.toHaveBeenCalled();
    s.c.setEpubFront(s.front);
    await expect(opening).resolves.toBe(true);

    const t = setup();
    const late = t.c.openBook(UID_E);
    await vi.advanceTimersByTimeAsync(EPUB_FRONT_TIMEOUT_MS);
    await expect(late).resolves.toBe(false);
    expect(t.ui.toast).toHaveBeenCalledWith('epub.openFailed', 'error', { titulo: 'EPUB e' });
  });

  it('opens at a chapter / CFI / passage (Abrir no livro), then only goes there once loaded', async () => {
    const s = setup();
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E, { page: 3, cfi: CFI_3, find: 'Filby' });
    // Opened at the place, then the passage is looked for there (its result is the snapshot's `found`).
    expect(s.front.calls).toEqual([`open:e:${CFI_3}:3:null`, `goTo:${CFI_3}:3:Filby`]);
    expect(s.c.snapshot().found).toEqual({ id: UID_E, page: 3, query: 'Filby', found: true });
    expect(s.c.snapshot().epub).toMatchObject({ section: 3, cfi: CFI_3 });
    // Loaded: a link only moves the reader (no bytes again).
    await s.c.openBook(UID_E, { page: 4, find: 'nowhere' });
    expect(s.core.bytes).toHaveBeenCalledTimes(1);
    expect(s.front.calls.at(-1)).toBe('goTo:null:4:nowhere');
    expect(s.c.snapshot().found).toEqual({ id: UID_E, page: 4, query: 'nowhere', found: false });
    expect(s.ui.toast).toHaveBeenCalledWith('leitor.gotoNotFound', 'info', { pagina: '5' });
    // Without a place: just brought to front.
    await s.c.openBook(UID_E);
    expect(s.front.goTo).toHaveBeenCalledTimes(2);
  });

  it('one EPUB at a time: opening another records where the first was', async () => {
    const s = setup();
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E);
    s.c.epubLocation(UID_E, { section: 5, sectionCount: 8, cfi: CFI_3, fraction: 0.6, tocLabel: 'IV' });
    expect(s.core.positionSet).not.toHaveBeenCalled();
    await s.c.openBook(UID_F);
    expect(s.front.flush).toHaveBeenCalled();
    expect(s.core.positionSet).toHaveBeenCalledWith(UID_E, 5, 0.6, CFI_3);
    expect(s.c.snapshot().epub?.uid).toBe(UID_F);
    expect(s.front.calls.at(-1)).toBe('open:f:null:2:null');
  });

  it('a failing reader toasts and resolves false', async () => {
    const s = setup();
    s.c.setEpubFront({ ...s.front, open: vi.fn(async () => null) });
    await expect(s.c.openBook(UID_E)).resolves.toBe(false);
    expect(s.ui.toast).toHaveBeenCalledWith('epub.openFailed', 'error', { titulo: 'EPUB e' });
  });
});

describe('LeitorController · switching readers', () => {
  it('keeps both loaded; the snapshot, the session and the panel follow the reader in front', async () => {
    const s = setup();
    s.c.mount();
    s.ready();
    s.c.setVisible(true);
    s.c.setEpubFront(s.front);
    await openPdf(s, UID_A);
    expect(s.c.snapshot()).toMatchObject({ front: 'pdfcraft', activeId: UID_A, page: 4, pdfOpen: true });
    expect(s.core.sessionStart).toHaveBeenLastCalledWith(UID_A, 4);

    await s.c.openBook(UID_E);
    expect(s.c.snapshot()).toMatchObject({ front: 'epub', activeId: UID_E, page: 2, pageCount: 8 });
    expect(s.core.sessionStop).toHaveBeenLastCalledWith(UID_A, 'doc');
    expect(s.core.sessionStart).toHaveBeenLastCalledWith(UID_E, 2);

    // PdfCraft messages while the EPUB is in front change PdfCraft's view only.
    s.send({ type: 'pdfcraft:page', id: UID_A, page: 6, pageCount: 12 });
    expect(s.c.snapshot()).toMatchObject({ activeId: UID_E, page: 2 });

    // "Voltar aos PDFs".
    s.c.showFront('pdfcraft');
    expect(s.c.snapshot()).toMatchObject({ front: 'pdfcraft', activeId: UID_A, page: 6, epub: { uid: UID_E } });
    expect(s.core.sessionStop).toHaveBeenLastCalledWith(UID_E, 'doc');
    expect(s.core.sessionStart).toHaveBeenLastCalledWith(UID_A, 6);

    // Opening the EPUB again only brings it back (no reload).
    await s.c.openBook(UID_E);
    expect(s.front.open).toHaveBeenCalledTimes(1);
    expect(s.c.snapshot().front).toBe('epub');

    // Opening a PDF brings PdfCraft to front; the EPUB stays loaded behind.
    await openPdf(s, UID_B, 0);
    expect(s.c.snapshot()).toMatchObject({ front: 'pdfcraft', activeId: UID_B, epub: { uid: UID_E } });
  });
});

describe('LeitorController · EPUB position and sessions', () => {
  async function opened() {
    const s = setup();
    s.c.setVisible(true);
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E);
    return s;
  }

  it('writes the position with its CFI, debounced by 1 s; leaving the tab writes it at once', async () => {
    const s = await opened();
    s.c.epubLocation(UID_E, { section: 3, sectionCount: 8, cfi: CFI_3, fraction: 0.4, tocLabel: 'Chapter III' });
    s.c.epubLocation(UID_E, { section: 3, sectionCount: 8, cfi: CFI_3, fraction: 0.42, tocLabel: 'Chapter III' });
    expect(s.c.snapshot()).toMatchObject({ page: 3, epub: { cfi: CFI_3, fraction: 0.42, tocLabel: 'Chapter III' } });
    await vi.advanceTimersByTimeAsync(POSITION_DEBOUNCE_MS - 1);
    expect(s.core.positionSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.core.positionSet).toHaveBeenCalledTimes(1);
    expect(s.core.positionSet).toHaveBeenCalledWith(UID_E, 3, 0.42, CFI_3);

    s.c.epubLocation(UID_E, { section: 4, sectionCount: 8, cfi: CFI, fraction: 0.5, tocLabel: null });
    s.c.setVisible(false);
    expect(s.core.positionSet).toHaveBeenLastCalledWith(UID_E, 4, 0.5, CFI);
    // Another book's location is ignored.
    s.c.epubLocation(UID_F, { section: 1, sectionCount: 8, cfi: CFI, fraction: 0.1, tocLabel: null });
    await vi.advanceTimersByTimeAsync(POSITION_DEBOUNCE_MS);
    expect(s.core.positionSet).toHaveBeenCalledTimes(2);
  });

  it('sessions by section: start, heartbeats, a new session after 2 min idle, stop on tab switch', async () => {
    const s = await opened();
    expect(s.core.sessionStart).toHaveBeenCalledWith(UID_E, 2);
    s.c.epubLocation(UID_E, { section: 3, sectionCount: 8, cfi: CFI_3, fraction: 0.4, tocLabel: null });
    expect(s.core.sessionHeartbeat).toHaveBeenLastCalledWith(UID_E, 3);
    s.c.epubActivity(UID_E);
    expect(s.core.sessionHeartbeat).toHaveBeenCalledTimes(2);
    // 2 min without activity: the core ended it; reading again starts a new one (short ones are the core's to drop).
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    s.c.epubActivity(UID_E);
    expect(s.core.sessionStart).toHaveBeenCalledTimes(2);
    expect(s.core.sessionStart).toHaveBeenLastCalledWith(UID_E, 3);
    s.c.setVisible(false);
    expect(s.core.sessionStop).toHaveBeenLastCalledWith(UID_E, 'tab');
    // Hidden: activity doesn't restart it.
    s.c.epubActivity(UID_E);
    expect(s.core.sessionStart).toHaveBeenCalledTimes(2);
  });

  it('the mini-review pauses the EPUB session too', async () => {
    const s = await opened();
    s.c.setReviewing(true);
    expect(s.core.sessionStop).toHaveBeenLastCalledWith(UID_E, 'review');
    s.c.setReviewing(false);
    expect(s.core.sessionStart).toHaveBeenLastCalledWith(UID_E, 2);
  });
});

describe('LeitorController · EPUB selection and the panel', () => {
  const sel: EpubSelectionInfo = { text: 'the Time Traveller', cfi: CFI_3, section: 3, tocLabel: 'Chapter III' };

  it('keeps the reader selection (chapter, CFI, label) and turns its menu into panel requests', async () => {
    const s = setup();
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E);
    const requests: PanelRequest[] = [];
    s.c.onPanelRequest((r) => requests.push(r));
    s.c.epubSelection(UID_E, sel);
    expect(s.c.snapshot().selection).toEqual({
      id: UID_E,
      page: 3,
      text: 'the Time Traveller',
      rects: [],
      cfi: CFI_3,
      unit: 'chapter',
      label: 'Chapter III',
    });
    s.c.epubMenu(UID_E, 'card', sel, { x: 10, y: 20, width: 5, height: 5 });
    s.c.epubMenu(UID_E, 'define', { ...sel, text: 'Traveller' }, { x: 1, y: 2, width: 3, height: 4 });
    s.c.epubMenu(UID_E, 'nope', sel, null);
    expect(requests.map((r) => [r.kind, r.via, r.selection?.cfi, r.anchor?.x])).toEqual([
      ['card', 'menu', CFI_3, 10],
      ['define', 'menu', CFI_3, 1],
    ]);
    s.c.epubSelection(UID_E, null);
    expect(s.c.snapshot().selection).toBeNull();
  });

  it('Ctrl+Shift+N asks the reader for its selection right now', async () => {
    const s = setup();
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E);
    const requests: PanelRequest[] = [];
    s.c.onPanelRequest((r) => requests.push(r));
    await s.c.requestCardFromSelection('shortcut');
    expect(s.ui.toast).toHaveBeenCalledWith('bookPanel.selectFirst', 'info');
    expect(requests).toEqual([]);
    s.setSelection(sel);
    await s.c.requestCardFromSelection('shortcut');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'card',
      via: 'shortcut',
      selection: { id: UID_E, page: 3, unit: 'chapter', cfi: CFI_3, label: 'Chapter III' },
    });
  });

  it('opens the reader drawer for `&lateral=`', async () => {
    const s = setup();
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E);
    await s.c.openEpubDrawer(UID_E, 'toc');
    await s.c.openEpubDrawer(UID_F, 'search');
    expect(s.front.calls.filter((c) => c.startsWith('drawer'))).toEqual(['drawer:toc']);
  });
});

describe('LeitorController · EPUB vocabulary marks', () => {
  const words: EpubMarkWord[] = [
    { form: 'geometry', lemma: 'geometry', status: 'unknown', color: '#d85a30' },
    { form: 'paradox', lemma: 'paradox', status: 'learning', color: '#ba7517' },
  ];
  const marks = (sections: number[]): EpubSectionMarks[] =>
    sections.map((section) => ({ section, words: section === 2 ? words : [] }));

  it('fetches the section on screen and the next, follows the reader, and opens the popover on a click', async () => {
    const epubMarks = vi.fn(async (_uid: string, sections: number[]) => marks(sections));
    const s = setup({ epubMarks });
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E);
    expect(epubMarks).not.toHaveBeenCalled();
    s.c.setHighlight(UID_E, true);
    await flush();
    // The reader opened at section 2.
    expect(epubMarks).toHaveBeenCalledWith(UID_E, [2, 3]);
    expect(s.front.setVocabMarks).toHaveBeenCalledWith(2, words);
    expect(s.front.setVocabMarks).toHaveBeenCalledWith(3, []);
    s.c.epubSectionShown(UID_E, 3);
    await flush();
    // Only what is new is fetched; sections left behind are cleared in the reader.
    expect(epubMarks).toHaveBeenLastCalledWith(UID_E, [4]);
    expect(s.front.setVocabMarks).toHaveBeenCalledWith(2, null);
    s.c.epubSectionShown(UID_E, 2);
    await flush();

    const clicks: MarkClick[] = [];
    s.c.onMarkClick((m) => clicks.push(m));
    s.c.epubVocabClick(UID_E, 2, 'Paradox', 'paradox', { x: 100, y: 200, width: 30, height: 12 });
    expect(clicks).toEqual([
      {
        id: UID_E,
        page: 2,
        index: -1,
        mark: { lemma: 'paradox', form: 'paradox', status: 'learning', rects: [] },
        anchor: { x: 100, y: 200, width: 30, height: 12 },
      },
    ]);

    // A refresh asks again; turning it off clears the reader.
    s.c.refreshVocab(UID_E);
    await flush();
    expect(epubMarks).toHaveBeenLastCalledWith(UID_E, [2, 3]);
    s.c.setHighlight(UID_E, false);
    expect(s.front.clearVocabMarks).toHaveBeenCalled();
    s.c.epubSectionShown(UID_E, 4);
    await flush();
    expect(epubMarks).not.toHaveBeenCalledWith(UID_E, [4, 5]);
  });

  it('a book never scanned shows nothing', async () => {
    const s = setup({ epubMarks: vi.fn(async () => null) });
    s.c.setEpubFront(s.front);
    await s.c.openBook(UID_E);
    s.c.setHighlight(UID_E, true);
    await flush();
    expect(s.front.setVocabMarks).toHaveBeenCalledWith(2, []);
    expect(s.front.setVocabMarks).not.toHaveBeenCalledWith(2, words);
  });
});

describe('LeitorController.reloadPdfcraftBook (after OCR)', () => {
  it('saves, recreates PdfCraft and reopens its books at their pages, the one in front last', async () => {
    const s = setup();
    s.c.mount();
    s.ready();
    s.c.setVisible(true);
    await openPdf(s, UID_B, 0);
    s.send({ type: 'pdfcraft:page', id: UID_B, page: 7, pageCount: 12 });
    await openPdf(s, UID_A, 4);
    expect(s.c.snapshot().openIds).toEqual([UID_A, UID_B]);
    const flushSaves = vi.spyOn(s.c, 'flushSaves');

    const before = s.frame.posted.length;
    const reload = s.c.reloadPdfcraftBook(UID_A);
    expect(flushSaves).toHaveBeenCalledWith('ocr');
    await settle();
    expect(s.c.snapshot()).toMatchObject({ generation: 1, status: 'loading', activeId: null, openIds: [] });
    // The new iframe (LeitorHost remounts it for the new generation).
    s.c.setFrameWindow(s.frame.win as unknown as Window);
    s.ready();
    await settle();
    const opens = () => s.frame.posted.slice(before).filter((p) => p.msg.type === 'pdfcraft:open');
    expect(opens().map((p) => [p.msg.id, p.msg.page])).toEqual([[UID_B, 7]]);
    s.send({ type: 'pdfcraft:active', id: UID_B, page: 7, pageCount: 12 });
    await settle();
    expect(opens().map((p) => [p.msg.id, p.msg.page])).toEqual([
      [UID_B, 7],
      [UID_A, 4],
    ]);
    s.send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    await reload;
    expect(s.c.snapshot()).toMatchObject({ activeId: UID_A, openIds: [UID_A, UID_B] });
    expect(s.ui.toast).toHaveBeenCalledWith('reader.reloadedAfterOcr', 'success');
    // Reopened quietly: no jump to the Leitor tab for the reopening.
    expect(s.ui.navigateToLeitor).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when PdfCraft does not have the book', async () => {
    const s = setup();
    s.c.mount();
    s.ready();
    await openPdf(s, UID_B, 0);
    await s.c.reloadPdfcraftBook(UID_A);
    expect(s.c.snapshot()).toMatchObject({ generation: 0, activeId: UID_B });
    expect(s.ui.toast).not.toHaveBeenCalledWith('reader.reloadedAfterOcr', 'success');
  });

  it('keeps an EPUB in front while PdfCraft reopens behind it', async () => {
    const s = setup();
    s.c.mount();
    s.ready();
    s.c.setEpubFront(s.front);
    await openPdf(s, UID_A, 4);
    await s.c.openBook(UID_E);
    const reload = s.c.reloadPdfcraftBook(UID_A);
    await settle();
    s.c.setFrameWindow(s.frame.win as unknown as Window);
    s.ready();
    await settle();
    s.send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    await reload;
    expect(s.c.snapshot()).toMatchObject({ front: 'epub', activeId: UID_E, openIds: [UID_A] });
  });
});
