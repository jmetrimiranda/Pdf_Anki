import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOTO_GRACE_MS,
  LeitorController,
  openTimeoutMs,
  READY_TIMEOUT_MS,
  SELECTION_NOW_TIMEOUT_MS,
  type LeitorCore,
  type LeitorUi,
} from './controller';
import { fakeCore, fakeFrame, fakeHost, ORIGIN, UID_A, UID_B, viTimers } from './testing';

function setup(over: Partial<LeitorCore> = {}) {
  const { host, deliver } = fakeHost();
  const frame = fakeFrame();
  const core = fakeCore(over);
  const store = new Map<string, string>();
  const c = new LeitorController({
    core,
    origin: ORIGIN,
    host,
    timers: viTimers,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    now: () => Date.now(),
  });
  const ui: LeitorUi = { navigateToLeitor: vi.fn(), toast: vi.fn(), libraryChanged: vi.fn() };
  c.setUi(ui);
  c.mount();
  c.setFrameWindow(frame.win as unknown as Window);
  const send = (data: Record<string, unknown>) => deliver(data, frame.win);
  const ready = () => send({ type: 'pdfcraft:ready', version: '0.9', bridge: 3 });
  const lastPosted = () => frame.posted.at(-1)?.msg;
  return { c, core, ui, send, ready, frame, lastPosted, store };
}

/** Lets the awaited core calls inside openBook run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LeitorController startup', () => {
  it('is loading until ready, then ready', () => {
    const { c, ready } = setup();
    expect(c.snapshot().mounted).toBe(true);
    expect(c.snapshot().status).toBe('loading');
    ready();
    expect(c.snapshot().status).toBe('ready');
  });

  it('fails after 30 s without ready', async () => {
    const { c } = setup();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(c.snapshot()).toMatchObject({ status: 'failed', startError: 'timeout' });
  });

  it('reports a missing build and an old bridge', () => {
    const a = setup();
    a.send({ type: 'pdfcraft:failed', error: 'build-missing' });
    expect(a.c.snapshot()).toMatchObject({ status: 'failed', startError: 'build-missing' });
    const b = setup();
    b.send({ type: 'pdfcraft:ready', version: '0.9' });
    expect(b.c.snapshot()).toMatchObject({ status: 'failed', startError: 'old-bridge' });
    // The Phase 1 bridge has no selection, menu items or goto.
    const v1 = setup();
    v1.send({ type: 'pdfcraft:ready', version: '0.9', bridge: 1 });
    expect(v1.c.snapshot()).toMatchObject({ status: 'failed', startError: 'old-bridge' });
    expect(v1.frame.posted).toEqual([]);
    // The Phase 4 bridge has no marks (spec 12.7).
    const v2 = setup();
    v2.send({ type: 'pdfcraft:ready', version: '0.9', bridge: 2 });
    expect(v2.c.snapshot()).toMatchObject({ status: 'failed', startError: 'old-bridge' });
  });

  it("keeps PdfCraft's startup error text", () => {
    const { c, send } = setup();
    send({ type: 'pdfcraft:failed', error: 'WebGL unavailable' });
    expect(c.snapshot()).toMatchObject({ status: 'failed', startError: 'error', startDetail: 'WebGL unavailable' });
  });

  it('restart recreates the iframe', () => {
    const { c, send } = setup();
    send({ type: 'pdfcraft:failed', error: 'x' });
    c.restart();
    expect(c.snapshot()).toMatchObject({ status: 'loading', generation: 1 });
  });
});

describe('LeitorController.openBook', () => {
  it('waits for ready, posts open at the last page and resolves on active', async () => {
    const { c, core, ui, ready, send, lastPosted } = setup();
    const opening = c.openBook(UID_A);
    expect(ui.navigateToLeitor).toHaveBeenCalled();
    await flush();
    expect(lastPosted()).toBeUndefined();
    ready();
    await flush();
    expect(lastPosted()).toMatchObject({
      type: 'pdfcraft:open',
      id: UID_A,
      page: 4,
      name: 'a.pdf',
      infoKey: 'LeitorBookUid',
    });
    expect(c.snapshot().openingId).toBe(UID_A);
    send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    await expect(opening).resolves.toBe(true);
    expect(c.snapshot()).toMatchObject({
      activeId: UID_A,
      activeTitle: 'Livro a',
      page: 4,
      pageCount: 12,
      openingId: null,
    });
    expect(c.snapshot()).toMatchObject({ ready: true, activeBookUid: UID_A, openIds: [UID_A] });
    // Same page count as the library: no update.
    expect(core.setPages).not.toHaveBeenCalled();
  });

  it('opens at the requested page (Abrir no livro) and clamps it to the book', async () => {
    const { c, ready, send, lastPosted } = setup();
    ready();
    const opening = c.openBook(UID_A, { page: 6 });
    await flush();
    expect(lastPosted()).toMatchObject({ type: 'pdfcraft:open', id: UID_A, page: 6 });
    send({ type: 'pdfcraft:active', id: UID_A, page: 6, pageCount: 12 });
    await expect(opening).resolves.toBe(true);

    const b = setup();
    b.ready();
    void b.c.openBook(UID_A, { page: 500 });
    await flush();
    expect(b.lastPosted()).toMatchObject({ type: 'pdfcraft:open', page: 11 });

    const d = setup();
    d.ready();
    void d.c.openBook(UID_A, { page: -3 });
    await flush();
    // Page 0 is the bridge's default (not sent).
    expect(d.lastPosted()).toMatchObject({ type: 'pdfcraft:open', id: UID_A });
    expect((d.lastPosted() as { page?: number }).page ?? 0).toBe(0);
  });

  it('moves a book PdfCraft already has to the requested page (Abrir no livro)', async () => {
    const { c, ready, send, lastPosted, frame } = setup();
    ready();
    const first = c.openBook(UID_A);
    await flush();
    send({ type: 'pdfcraft:active', id: UID_A, page: 2, pageCount: 12 });
    await expect(first).resolves.toBe(true);

    // In front, no page asked for: nothing is sent.
    const sent = frame.posted.length;
    await expect(c.openBook(UID_A)).resolves.toBe(true);
    expect(frame.posted.length).toBe(sent);

    // In front, page asked for: a goto (no bytes); the fork answers with pdfcraft:active.
    const going = c.openBook(UID_A, { page: 7 });
    await flush();
    expect(lastPosted()).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 7 });
    send({ type: 'pdfcraft:active', id: UID_A, page: 7, pageCount: 12 });
    await expect(going).resolves.toBe(true);

    // Page 0 of an open book is sent too (otherwise the tab would stay where it is).
    const top = c.openBook(UID_A, { page: 0 });
    await flush();
    expect(lastPosted()).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 0 });
    send({ type: 'pdfcraft:active', id: UID_A, page: 0, pageCount: 12 });
    await expect(top).resolves.toBe(true);
  });

  it('updates the page count when PdfCraft disagrees with the library', async () => {
    const { c, core, ready, send } = setup();
    ready();
    const opening = c.openBook(UID_A);
    await flush();
    send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 13 });
    await opening;
    expect(core.setPages).toHaveBeenCalledWith(UID_A, 13);
  });

  it('shows the fallback when PdfCraft reports failed {id}', async () => {
    const { c, ready, send } = setup();
    ready();
    const opening = c.openBook(UID_A);
    await flush();
    send({ type: 'pdfcraft:failed', id: UID_A, error: 'not a PDF' });
    await expect(opening).resolves.toBe(false);
    expect(c.snapshot().openError).toEqual({ uid: UID_A, title: 'Livro a', kind: 'pdfcraft', error: 'not a PDF' });
  });

  it('shows the fallback when no active arrives in time (20 s + 1 s per 5 MB)', async () => {
    expect(openTimeoutMs(0)).toBe(20_000);
    expect(openTimeoutMs(12 * 1024 * 1024)).toBe(23_000);
    const { c, ready } = setup();
    ready();
    const opening = c.openBook(UID_A);
    await flush();
    // The fake book has 5 bytes: 20 s + 1 s.
    await vi.advanceTimersByTimeAsync(20_999);
    expect(c.snapshot().openError).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(opening).resolves.toBe(false);
    expect(c.snapshot().openError).toMatchObject({ uid: UID_A, kind: 'timeout', error: '' });
  });

  it('the fallback opens the system viewer', async () => {
    const { c, core, ready, send } = setup();
    ready();
    const opening = c.openBook(UID_A);
    await flush();
    send({ type: 'pdfcraft:failed', id: UID_A, error: 'x' });
    await opening;
    await c.openExternal(UID_A);
    expect(core.openExternal).toHaveBeenCalledWith(UID_A);
    expect(c.snapshot().openError).toBeNull();
  });

  it('a failing system viewer shows an error toast and keeps the fallback', async () => {
    const { c, ui, ready, send } = setup({ openExternal: () => Promise.reject(new Error('sem visualizador')) });
    ready();
    const opening = c.openBook(UID_A);
    await flush();
    send({ type: 'pdfcraft:failed', id: UID_A, error: 'x' });
    await opening;
    await c.openExternal(UID_A);
    expect(ui.toast).toHaveBeenCalledWith('reader.openExternalFailed', 'error', { erro: 'sem visualizador' });
    expect(c.snapshot().openError).toMatchObject({ uid: UID_A });
  });

  it('exposes the book being opened until PdfCraft reports it active', async () => {
    const { c, ready, send } = setup();
    ready();
    const opening = c.openBook(UID_A);
    expect(c.snapshot().openingId).toBe(UID_A);
    await flush();
    expect(c.snapshot().openingTitle).toBe('Livro a');
    send({ type: 'pdfcraft:active', id: UID_A, page: 0, pageCount: 3 });
    await opening;
    expect(c.snapshot().openingId).toBeNull();
    expect(c.snapshot().openingTitle).toBeNull();
  });

  it('a core error while opening shows the fallback', async () => {
    const { c, ready } = setup({
      bytes: () => Promise.reject(new Error('arquivo sumiu')),
    });
    ready();
    await expect(c.openBook(UID_A)).resolves.toBe(false);
    expect(c.snapshot().openError).toMatchObject({ uid: UID_A, kind: 'core', error: 'arquivo sumiu' });
  });

  it('an already active book resolves at once', async () => {
    const { c, ready, send, frame } = setup();
    ready();
    const first = c.openBook(UID_A);
    await flush();
    send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    await first;
    await expect(c.openBook(UID_A)).resolves.toBe(true);
    // menu-items (on ready) and the open: nothing more.
    expect(frame.posted.map((p) => p.msg.type)).toEqual(['pdfcraft:menu-items', 'pdfcraft:open']);
  });

  it('returns false when PdfCraft cannot start', async () => {
    const { c, send } = setup();
    const opening = c.openBook(UID_A);
    send({ type: 'pdfcraft:failed', error: 'no WebGL' });
    await expect(opening).resolves.toBe(false);
  });
});

describe('LeitorController progress, autosave and sessions', () => {
  async function opened() {
    const s = setup();
    s.ready();
    s.c.setVisible(true);
    const p = s.c.openBook(UID_A);
    await flush();
    s.send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    await p;
    return s;
  }

  it('records the page debounced by 1 s', async () => {
    const { send, core } = await opened();
    send({ type: 'pdfcraft:page', id: UID_A, page: 5 });
    send({ type: 'pdfcraft:page', id: UID_A, page: 6 });
    await vi.advanceTimersByTimeAsync(999);
    expect(core.positionSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(core.positionSet).toHaveBeenCalledTimes(1);
    expect(core.positionSet).toHaveBeenCalledWith(UID_A, 6, 7 / 12);
  });

  it('flushes the page on tab switch', async () => {
    const { c, send, core } = await opened();
    send({ type: 'pdfcraft:page', id: UID_A, page: 9 });
    c.setVisible(false);
    expect(core.positionSet).toHaveBeenCalledWith(UID_A, 9, 10 / 12);
  });

  it('starts a session on activation, heartbeats on activity, stops on tab switch', async () => {
    const { c, send, core } = await opened();
    expect(core.sessionStart).toHaveBeenCalledWith(UID_A, 4);
    send({ type: 'pdfcraft:activity', id: UID_A });
    expect(core.sessionHeartbeat).toHaveBeenCalledWith(UID_A, 4);
    c.setVisible(false);
    expect(core.sessionStop).toHaveBeenCalledWith(UID_A, 'tab');
  });

  it('stops with "doc" and saves the previous book on document switch', async () => {
    const { c, send, core, frame } = await opened();
    send({ type: 'pdfcraft:dirty', dirty: true, ids: [UID_A] });
    const p = c.openBook(UID_B);
    await flush();
    send({ type: 'pdfcraft:active', id: UID_B, page: 0, pageCount: 3 });
    await p;
    expect(core.sessionStop).toHaveBeenCalledWith(UID_A, 'doc');
    expect(core.sessionStart).toHaveBeenLastCalledWith(UID_B, 0);
    expect(frame.posted.map((x) => x.msg.type)).toContain('pdfcraft:request-save');
    expect(frame.posted.find((x) => x.msg.type === 'pdfcraft:request-save')?.msg.id).toBe(UID_A);
  });

  it('autosaves after 10 s of quiet and stores the save as a version', async () => {
    const { c, send, core, frame, ui } = await opened();
    send({ type: 'pdfcraft:dirty', dirty: true, ids: [UID_A] });
    expect(c.snapshot().unsavedIds).toEqual([UID_A]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frame.posted.at(-1)?.msg).toEqual({ type: 'pdfcraft:request-save', id: UID_A });
    send({ type: 'pdfcraft:save', id: UID_A, name: 'a.pdf', saveAs: false, bytes: new ArrayBuffer(8) });
    send({ type: 'pdfcraft:dirty', dirty: false, ids: [] });
    await flush();
    expect(core.saveVersion).toHaveBeenCalledWith(UID_A, expect.any(Uint8Array), 1);
    expect(ui.libraryChanged).toHaveBeenCalled();
    expect(c.snapshot().unsavedIds).toEqual([]);
  });

  it('saves carry the version the tab was opened from, even after a newer version is imported', async () => {
    const { c, send, core, ui } = await opened();
    // A stamped copy becomes v5 while A is open; opening A again only brings the old tab to the front.
    (core.openInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'a.pdf',
      title: 'Livro a',
      page: 4,
      pages: 12,
      fileVersion: 5,
    });
    (core.saveVersion as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ fileVersion: 6, keptNewer: true });
    const p = c.openBook(UID_A);
    await flush();
    await p;
    send({ type: 'pdfcraft:save', id: UID_A, name: 'a.pdf', saveAs: false, bytes: new ArrayBuffer(8) });
    await flush();
    expect(core.saveVersion).toHaveBeenLastCalledWith(UID_A, expect.any(Uint8Array), 1);
    expect(ui.toast).toHaveBeenCalledWith('reader.keptNewer', 'info', { titulo: 'Livro a' });
    // The tab now holds what it just saved.
    send({ type: 'pdfcraft:save', id: UID_A, name: 'a.pdf', saveAs: false, bytes: new ArrayBuffer(9) });
    await flush();
    expect(core.saveVersion).toHaveBeenLastCalledWith(UID_A, expect.any(Uint8Array), 6);
  });

  it('a failing store toasts reader.saveFailed with the title', async () => {
    const { send, ui } = await opened().then(async (s) => {
      (s.core.saveVersion as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disco cheio'));
      return s;
    });
    send({ type: 'pdfcraft:save', id: UID_A, name: 'a.pdf', saveAs: false, bytes: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ui.toast).toHaveBeenCalledWith('reader.saveFailed', 'error', { titulo: 'Livro a', erro: 'disco cheio' });
  });

  it('"Salvar como" stores and exports a copy', async () => {
    const { send, core, ui } = await opened();
    send({ type: 'pdfcraft:save', id: UID_A, name: 'a.pdf', saveAs: true, bytes: new ArrayBuffer(8) });
    await flush();
    expect(core.saveVersion).toHaveBeenCalled();
    expect(core.pickExportPath).toHaveBeenCalledWith('a.pdf');
    expect(core.exportBook).toHaveBeenCalledWith(UID_A, '/tmp/a.pdf');
    expect(ui.toast).toHaveBeenCalledWith('reader.exported', 'success');
  });

  it('a save of a document outside the library is exported', async () => {
    const { send, core } = await opened();
    send({ type: 'pdfcraft:save', id: null, name: 'outro.pdf', saveAs: false, bytes: new ArrayBuffer(8) });
    await flush();
    expect(core.saveVersion).not.toHaveBeenCalled();
    expect(core.exportBytes).toHaveBeenCalledWith('/tmp/outro.pdf', expect.any(Uint8Array));
  });

  it('window close: flushes, ends the session and lets the window close', async () => {
    const { c, send, core } = await opened();
    send({ type: 'pdfcraft:dirty', dirty: true, ids: [UID_A] });
    const closing = c.onCloseRequested();
    send({ type: 'pdfcraft:save', id: UID_A, name: 'a.pdf', saveAs: false, bytes: new ArrayBuffer(8) });
    await expect(closing).resolves.toBe(true);
    expect(core.sessionStop).toHaveBeenCalledWith(UID_A, 'close');
  });

  it('window close with a failed save asks; cancel keeps the window', async () => {
    const { c, send, core } = await opened();
    send({ type: 'pdfcraft:dirty', dirty: true, ids: [UID_A] });
    const closing = c.onCloseRequested();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.snapshot().closePrompt).toBe(true);
    c.answerClosePrompt(false);
    await expect(closing).resolves.toBe(false);
    expect(core.sessionStop).not.toHaveBeenCalledWith(UID_A, 'close');
    const again = c.onCloseRequested();
    await vi.advanceTimersByTimeAsync(10_000);
    c.answerClosePrompt(true);
    await expect(again).resolves.toBe(true);
    expect(core.sessionStop).toHaveBeenCalledWith(UID_A, 'close');
  });

  it('remembers the panel state', () => {
    const { c, store } = setup();
    expect(c.snapshot().panelOpen).toBe(true);
    c.togglePanel();
    expect(c.snapshot().panelOpen).toBe(false);
    expect(store.get('leitor.panelOpen')).toBe('0');
  });

  it('a compact window closes the panel without remembering it, and restores the choice when wide', () => {
    const { c, store } = setup();
    c.setPanelCompact(true);
    expect(c.snapshot()).toMatchObject({ panelCompact: true, panelOpen: false });
    expect(store.get('leitor.panelOpen')).toBeUndefined();
    c.togglePanel();
    expect(c.snapshot().panelOpen).toBe(true);
    c.togglePanel();
    expect(store.get('leitor.panelOpen')).toBeUndefined();
    c.setPanelCompact(false);
    expect(c.snapshot()).toMatchObject({ panelCompact: false, panelOpen: true });
  });
});

describe('LeitorController · bridge v2 (selection, menu, goto)', () => {
  const MENU = {
    type: 'pdfcraft:menu-items',
    items: [
      { key: 'card', label: 'Criar card' },
      { key: 'ai', label: 'Criar cards com IA' },
      { key: 'define', label: 'Definir palavra' },
    ],
  };

  async function opened(uid = UID_A) {
    const s = setup();
    s.ready();
    const p = s.c.openBook(uid);
    await flush();
    s.send({ type: 'pdfcraft:active', id: uid, page: 4, pageCount: 12 });
    await p;
    return s;
  }

  const selection = (over: Record<string, unknown> = {}) => ({
    type: 'pdfcraft:selection',
    id: UID_A,
    page: 4,
    text: 'the windmill',
    rects: [[10, 20, 100, 12]],
    ...over,
  });

  it('sends the menu items after every ready, also after a reload', () => {
    const { c, ready, frame } = setup();
    ready();
    expect(frame.posted.map((p) => p.msg)).toEqual([MENU]);
    c.frameReloaded();
    ready();
    expect(frame.posted.map((p) => p.msg)).toEqual([MENU, MENU]);
  });

  it('keeps the selection of the book in front and clears it on empty selection', async () => {
    const { c, send } = await opened();
    send(selection());
    expect(c.snapshot().selection).toEqual({ id: UID_A, page: 4, text: 'the windmill', rects: [[10, 20, 100, 12]] });
    send(selection({ text: '', rects: [] }));
    expect(c.snapshot().selection).toBeNull();
    // Whitespace only is no selection either.
    send(selection());
    send(selection({ text: '  \n ' }));
    expect(c.snapshot().selection).toBeNull();
  });

  it('ignores selections of documents not in front or opened by PdfCraft itself', async () => {
    const { c, send } = await opened();
    send(selection({ id: null }));
    expect(c.snapshot().selection).toBeNull();
    const b = c.openBook(UID_B);
    await flush();
    // UID_B is known now but not in front yet.
    send(selection({ id: UID_B }));
    expect(c.snapshot().selection).toBeNull();
    send({ type: 'pdfcraft:active', id: UID_B, page: 0, pageCount: 3 });
    await b;
  });

  it('clears the selection when the document in front changes and on a reload', async () => {
    const { c, send } = await opened();
    send(selection());
    // Same document again (a goto answer): kept.
    send({ type: 'pdfcraft:active', id: UID_A, page: 5, pageCount: 12 });
    expect(c.snapshot().selection).not.toBeNull();
    send({ type: 'pdfcraft:active', id: null, page: 0, pageCount: 0 });
    expect(c.snapshot().selection).toBeNull();
    send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    send(selection());
    c.frameReloaded();
    expect(c.snapshot().selection).toBeNull();
  });

  it('selection messages notify subscribers but no page work happens', async () => {
    const { c, send, core } = await opened();
    const calls = core.calls.length;
    const fn = vi.fn();
    c.subscribe(fn);
    send(selection());
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(core.calls.length).toBe(calls);
  });

  it('turns a menu click into a panel request with a viewport anchor and opens the panel for a card', async () => {
    const { c, send, ui } = await opened();
    c.togglePanel(false);
    c.setFrameElement({ getBoundingClientRect: () => ({ left: 40, top: 56 }) });
    const got: unknown[] = [];
    c.onPanelRequest((r) => got.push(r));
    vi.mocked(ui.navigateToLeitor).mockClear();
    send({ ...selection(), type: 'pdfcraft:menu', key: 'card', anchor: [100, 200, 120, 24] });
    expect(got).toEqual([
      {
        kind: 'card',
        via: 'menu',
        selection: { id: UID_A, page: 4, text: 'the windmill', rects: [[10, 20, 100, 12]] },
        anchor: { x: 140, y: 256, width: 120, height: 24 },
      },
    ]);
    expect(c.snapshot().panelOpen).toBe(true);
    expect(ui.navigateToLeitor).toHaveBeenCalled();
    // The click carries the selection even before the debounced pdfcraft:selection.
    expect(c.snapshot().selection?.text).toBe('the windmill');

    // "Definir palavra" / "Criar cards com IA": a request, the panel stays as it is.
    c.togglePanel(false);
    send({ ...selection({ text: 'windmill' }), type: 'pdfcraft:menu', key: 'define' });
    expect(got.at(-1)).toMatchObject({ kind: 'define', via: 'menu', anchor: null });
    expect(c.snapshot().panelOpen).toBe(false);
    expect(got).toHaveLength(2);

    // A document PdfCraft opened by itself (no id): define and the AI notice still come; a card only explains.
    send({ ...selection({ text: 'windmill' }), type: 'pdfcraft:menu', key: 'define', id: null });
    expect(got.at(-1)).toMatchObject({ kind: 'define', selection: { id: null, text: 'windmill', page: 4 } });
    send({ ...selection(), type: 'pdfcraft:menu', key: 'ai', id: null });
    expect(got.at(-1)).toMatchObject({ kind: 'ai', selection: { id: null } });
    expect(got).toHaveLength(4);
    expect(c.snapshot().selection?.id).toBe(UID_A);
    vi.mocked(ui.navigateToLeitor).mockClear();
    send({ ...selection(), type: 'pdfcraft:menu', key: 'card', id: null });
    expect(got).toHaveLength(4);
    expect(ui.toast).toHaveBeenCalledWith('bookPanel.notInLibrary', 'info');
    expect(ui.navigateToLeitor).not.toHaveBeenCalled();
    expect(c.snapshot().panelOpen).toBe(false);
  });

  it('requestCardFromSelection opens the panel with the current selection; without one only a notice, in place', async () => {
    const { c, send, ui } = await opened();
    c.togglePanel(false);
    const got: { kind: string; via: string; selection: unknown }[] = [];
    const off = c.onPanelRequest((r) => got.push(r));
    vi.mocked(ui.navigateToLeitor).mockClear();
    await c.requestCardFromSelection('shortcut');
    expect(got).toEqual([]);
    expect(ui.toast).toHaveBeenCalledWith('bookPanel.selectFirst', 'info');
    expect(ui.navigateToLeitor).not.toHaveBeenCalled();
    expect(c.snapshot().panelOpen).toBe(false);
    send(selection());
    await c.requestCardFromSelection('button');
    expect(got.at(-1)).toMatchObject({ kind: 'card', via: 'button', selection: { text: 'the windmill', page: 4 } });
    expect(c.snapshot().panelOpen).toBe(true);
    expect(ui.navigateToLeitor).toHaveBeenCalled();

    // Nobody listening (the panel not mounted yet): the request waits for the first listener.
    off();
    await c.requestCardFromSelection();
    const late = vi.fn();
    c.onPanelRequest(late);
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0]![0]).toMatchObject({ kind: 'card', via: 'shortcut' });
  });

  it('requestCardFromSelection first asks PdfCraft for a selection still in its debounce', async () => {
    const { c, send, frame } = await opened();
    c.setVisible(true);
    send(selection({ text: 'old text', page: 2 }));
    const got: { selection: unknown }[] = [];
    c.onPanelRequest((r) => got.push(r));
    // The user selected new text and pressed Alt+C before the 300 ms debounce sent it.
    const asking = c.requestCardFromSelection('shortcut');
    await flush();
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:selection-now', seq: 1 });
    expect(got).toEqual([]);
    send(selection({ text: 'the new text', page: 5 }));
    send({ type: 'pdfcraft:selection-sent', seq: 1 });
    await asking;
    expect(got).toEqual([
      expect.objectContaining({ selection: expect.objectContaining({ text: 'the new text', page: 5 }) }),
    ]);

    // A selection cleared in the meantime: only the notice.
    const clearing = c.requestCardFromSelection('shortcut');
    send(selection({ text: '', rects: [] }));
    send({ type: 'pdfcraft:selection-sent', seq: 2 });
    await clearing;
    expect(got).toHaveLength(1);

    // No answer (an older build, a frame that draws nothing): the last selection after a short wait.
    send(selection({ text: 'kept' }));
    const silent = c.requestCardFromSelection('button');
    await vi.advanceTimersByTimeAsync(SELECTION_NOW_TIMEOUT_MS - 1);
    expect(got).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await silent;
    expect(got.at(-1)).toMatchObject({ selection: { text: 'kept' } });
    // A late or stray answer is harmless.
    send({ type: 'pdfcraft:selection-sent', seq: 3 });
    send({ type: 'pdfcraft:selection-sent', seq: null });

    // Off screen nothing is asked: there is no fresh selection to wait for.
    c.setVisible(false);
    const posted = frame.posted.length;
    await c.requestCardFromSelection('shortcut');
    expect(frame.posted).toHaveLength(posted);
    expect(got).toHaveLength(3);
  });

  it('opens a closed book at the page, then sends the goto with find after active', async () => {
    const { c, ready, send, frame } = setup();
    ready();
    const opening = c.openBook(UID_A, { page: 2, find: ' the\nwindmill ' });
    await flush();
    expect(frame.posted.at(-1)!.msg).toMatchObject({ type: 'pdfcraft:open', id: UID_A, page: 2 });
    expect(frame.posted.some((p) => p.msg.type === 'pdfcraft:goto')).toBe(false);
    send({ type: 'pdfcraft:active', id: UID_A, page: 2, pageCount: 12 });
    await expect(opening).resolves.toBe(true);
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 2, find: 'the windmill' });
    send({ type: 'pdfcraft:found', id: UID_A, page: 2, query: 'the windmill', found: true });
    expect(c.snapshot().found).toEqual({ id: UID_A, page: 2, query: 'the windmill', found: true });
  });

  it('sends only a goto (no bytes) for a book PdfCraft already has', async () => {
    const { c, core, send, frame } = await opened();
    vi.mocked(core.bytes).mockClear();
    const going = c.openBook(UID_A, { page: 0, find: 'the windmill' });
    await flush();
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 0, find: 'the windmill' });
    expect(core.bytes).not.toHaveBeenCalled();
    expect(c.snapshot().found).toBeNull();
    send({ type: 'pdfcraft:active', id: UID_A, page: 0, pageCount: 12 });
    await expect(going).resolves.toBe(true);
    // Find without a page: the page the reader is on.
    void c.openBook(UID_A, { find: 'autumn' });
    await flush();
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 0, find: 'autumn' });
  });

  it('a goto for a tab PdfCraft no longer has opens the book again', async () => {
    const { c, send, frame, ui } = await opened();
    const going = c.openBook(UID_A, { page: 3, find: 'x' });
    await flush();
    expect(frame.posted.at(-1)!.msg.type).toBe('pdfcraft:goto');
    // PdfCraft answers a goto for a tag it doesn't have with found: false only (no active).
    send({ type: 'pdfcraft:found', id: UID_A, page: 3, query: 'x', found: false });
    await vi.advanceTimersByTimeAsync(GOTO_GRACE_MS);
    expect(ui.toast).not.toHaveBeenCalled();
    expect(frame.posted.at(-1)!.msg).toMatchObject({ type: 'pdfcraft:open', id: UID_A, page: 3 });
    send({ type: 'pdfcraft:active', id: UID_A, page: 3, pageCount: 12 });
    await expect(going).resolves.toBe(true);
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 3, find: 'x' });
  });

  it('a found that beats the active of its goto is applied with the active (same PdfCraft frame)', async () => {
    const { c, send, ui } = await opened();
    const going = c.openBook(UID_A, { page: 6, find: 'nothing here' });
    await flush();
    send({ type: 'pdfcraft:found', id: UID_A, page: 6, query: 'nothing here', found: false });
    expect(c.snapshot().found).toBeNull();
    send({ type: 'pdfcraft:active', id: UID_A, page: 6, pageCount: 12 });
    await expect(going).resolves.toBe(true);
    expect(c.snapshot().found).toMatchObject({ page: 6, found: false });
    expect(ui.toast).toHaveBeenCalledWith('leitor.gotoNotFound', 'info', { pagina: '7' });
    // No late reopen.
    await vi.advanceTimersByTimeAsync(GOTO_GRACE_MS * 2);
    expect(c.snapshot().openError).toBeNull();
  });

  it('toasts when the passage is not found on the page', async () => {
    const { c, send, ui } = await opened();
    send({ type: 'pdfcraft:found', id: UID_A, page: 6, query: 'nothing here', found: false });
    expect(c.snapshot().found).toMatchObject({ found: false, page: 6 });
    expect(ui.toast).toHaveBeenCalledWith('leitor.gotoNotFound', 'info', { pagina: '7' });
    vi.mocked(ui.toast).mockClear();
    send({ type: 'pdfcraft:found', id: UID_A, page: 6, query: 'x', found: true });
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it('keeps the last menu shown (for tests)', async () => {
    const { c, send } = await opened();
    send({ type: 'pdfcraft:menu-shown', id: UID_A, items: [{ key: 'card', rect: [1, 2, 3, 4] }] });
    expect(c.snapshot().menuShown).toEqual({ id: UID_A, items: [{ key: 'card', rect: [1, 2, 3, 4] }] });
  });

  it('pauses the reading session while the mini-review is open', async () => {
    const { c, core } = await opened();
    c.setVisible(true);
    await flush();
    expect(core.calls.filter((x) => x.startsWith('start'))).toHaveLength(1);
    c.setReviewing(true);
    expect(core.calls.at(-1)).toBe(`stop(${UID_A},review)`);
    c.setReviewing(false);
    expect(core.calls.at(-1)).toBe(`start(${UID_A},4)`);
  });
});

describe('LeitorController · vocabulary marks (bridge 3)', () => {
  const marks = (page: number) => [
    {
      lemma: 'windmill',
      form: 'windmill',
      status: 'unknown' as const,
      rects: [[20, 30 + page, 50, 14]] as [number, number, number, number][],
    },
    {
      lemma: 'animal',
      form: 'animals',
      status: 'learning' as const,
      rects: [[90, 30, 40, 14]] as [number, number, number, number][],
    },
  ];

  async function opened(over: Partial<LeitorCore> = {}) {
    const s = setup({
      vocabMarks: vi.fn(async (_uid: string, pages: number[]) => pages.map((page) => ({ page, marks: marks(page) }))),
      ...over,
    });
    s.ready();
    const p = s.c.openBook(UID_A);
    await flush();
    s.send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    await p;
    return s;
  }

  const marksSent = (posted: { msg: Record<string, unknown> }[]) =>
    posted.filter((p) => p.msg.type === 'pdfcraft:marks').map((p) => p.msg);

  it('sends the marks of the page in front and its neighbours once the highlight is on, and follows the pages', async () => {
    const { c, core, frame, send } = await opened();
    expect(core.vocabMarks).not.toHaveBeenCalled();
    c.setHighlight(UID_A, true);
    await flush();
    expect(core.vocabMarks).toHaveBeenCalledWith(UID_A, [3, 4, 5, 6]);
    const [first] = marksSent(frame.posted);
    expect(first).toMatchObject({ type: 'pdfcraft:marks', id: UID_A, set: 'vocab' });
    expect((first!.marks as { page: number; color: string; style: string }[]).map((m) => [m.page, m.color])).toEqual([
      [3, '#d85a30'],
      [3, '#ba7517'],
      [4, '#d85a30'],
      [4, '#ba7517'],
      [5, '#d85a30'],
      [5, '#ba7517'],
      [6, '#d85a30'],
      [6, '#ba7517'],
    ]);
    send({ type: 'pdfcraft:page', id: UID_A, page: 5 });
    await flush();
    expect(core.vocabMarks).toHaveBeenLastCalledWith(UID_A, [7]);
    expect(marksSent(frame.posted)).toHaveLength(2);
  });

  it('turns a mark-click into the popover request at the word on screen', async () => {
    const { c, send } = await opened();
    c.setFrameElement({ getBoundingClientRect: () => ({ left: 40, top: 56 }) });
    c.setHighlight(UID_A, true);
    await flush();
    const clicks: unknown[] = [];
    const off = c.onMarkClick((k) => clicks.push(k));
    send({ type: 'pdfcraft:mark-click', id: UID_A, set: 'vocab', index: 1, page: 4, rect: [100, 200, 30, 16] });
    expect(clicks).toEqual([
      {
        id: UID_A,
        page: 4,
        index: 1,
        mark: marks(4)[1],
        anchor: { x: 140, y: 256, width: 30, height: 16 },
      },
    ]);
    // An index past the page's marks, another set or a page never sent: dropped by the bridge.
    send({ type: 'pdfcraft:mark-click', id: UID_A, set: 'vocab', index: 2, page: 4, rect: [1, 1, 1, 1] });
    send({ type: 'pdfcraft:mark-click', id: UID_A, set: 'vocab', index: 0, page: 11, rect: [1, 1, 1, 1] });
    off();
    send({ type: 'pdfcraft:mark-click', id: UID_A, set: 'vocab', index: 0, page: 4, rect: [1, 1, 1, 1] });
    expect(clicks).toHaveLength(1);
  });

  it('clears the marks when turned off; marks never make the book dirty', async () => {
    const { c, frame } = await opened();
    c.setHighlight(UID_A, true);
    await flush();
    c.setHighlight(UID_A, false);
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:clear-marks', id: UID_A, set: 'vocab' });
    expect(c.snapshot().unsavedIds).toEqual([]);
    expect(frame.posted.some((p) => p.msg.type === 'pdfcraft:request-save')).toBe(false);
  });

  it('asks again after a refresh and after a new version is stored', async () => {
    const { c, core, send } = await opened();
    c.setHighlight(UID_A, true);
    await flush();
    vi.mocked(core.vocabMarks).mockClear();
    c.refreshVocab(UID_A);
    await flush();
    expect(core.vocabMarks).toHaveBeenCalledWith(UID_A, [3, 4, 5, 6]);
    vi.mocked(core.vocabMarks).mockClear();
    send({ type: 'pdfcraft:save', id: UID_A, name: 'a.pdf', saveAs: false, bytes: new ArrayBuffer(8) });
    await flush();
    expect(core.vocabMarks).toHaveBeenCalledWith(UID_A, [3, 4, 5, 6]);
  });

  it('shows one toast for failures, then only logs', async () => {
    const { c, ui, send } = await opened({ vocabMarks: vi.fn(async () => Promise.reject(new Error('down'))) });
    c.setHighlight(UID_A, true);
    await flush();
    send({ type: 'pdfcraft:page', id: UID_A, page: 9 });
    await flush();
    expect(vi.mocked(ui.toast).mock.calls.filter((x) => x[0] === 'vocabReading.marksFailed')).toHaveLength(1);
  });

  it('forgets the marks when the iframe reloads', async () => {
    const { c, core } = await opened();
    c.setHighlight(UID_A, true);
    await flush();
    c.frameReloaded();
    expect(c.vocab.markAt(UID_A, 4, 0)).toBeNull();
    expect(core.vocabMarks).toHaveBeenCalledTimes(1);
  });
});
