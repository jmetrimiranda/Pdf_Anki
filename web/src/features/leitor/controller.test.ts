import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeitorController, openTimeoutMs, READY_TIMEOUT_MS, type LeitorCore, type LeitorUi } from './controller';
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
  const ready = () => send({ type: 'pdfcraft:ready', version: '0.9', bridge: 1 });
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

    // In front, page asked for: the fork goes to it and answers with pdfcraft:active.
    const going = c.openBook(UID_A, { page: 7 });
    await flush();
    expect(lastPosted()).toMatchObject({ type: 'pdfcraft:open', id: UID_A, page: 7 });
    send({ type: 'pdfcraft:active', id: UID_A, page: 7, pageCount: 12 });
    await expect(going).resolves.toBe(true);

    // Page 0 of an open book is sent explicitly too (otherwise the tab would stay where it is).
    const top = c.openBook(UID_A, { page: 0 });
    await flush();
    expect(lastPosted()).toMatchObject({ type: 'pdfcraft:open', id: UID_A, page: 0 });
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
    expect(frame.posted).toHaveLength(1);
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
