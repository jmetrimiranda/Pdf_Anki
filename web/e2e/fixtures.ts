import { test as base, expect, type Page } from '@playwright/test';

/** Fails the test on any console error or uncaught exception. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('pageerror', (err) => errors.push(err.message));
      await use(errors);
      expect(errors, 'console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('leitor.theme', t), theme);
}

export function shot(name: string, project: string) {
  return `test-results/screens/${name}-${project}.png`;
}

/**
 * The app scrolls inside <main>, so a full-page screenshot would be cut at the viewport.
 * Grows the viewport to fit the tallest scroller, takes the shot and restores the size.
 */
export async function fullShot(page: Page, path: string) {
  const size = page.viewportSize() ?? { width: 1280, height: 820 };
  const extra = await page.evaluate(() =>
    Math.max(
      0,
      ...Array.from(document.querySelectorAll('main *'))
        .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY))
        .map((el) => el.scrollHeight - el.clientHeight),
    ),
  );
  await page.setViewportSize({ width: size.width, height: size.height + extra });
  await page.waitForTimeout(200);
  await page.screenshot({ path });
  await page.setViewportSize(size);
}

/** `window.__leitorMock` (src/lib/core/mock.ts, mock mode only), as seen from the e2e specs. */
export interface LeitorMockHandle {
  readonly books: {
    bookUid: string;
    title: string;
    fileVersion: number;
    fileHash: string;
    format: 'pdf' | 'epub';
    hasText: boolean;
  }[];
  readonly savedVersions: { uid: string; fileVersion: number; fileHash: string; size: number; hasBookUid: boolean }[];
  readonly sessions: {
    kind: 'start' | 'heartbeat' | 'stop';
    uid: string | null;
    page: number | null;
    reason: string | null;
  }[];
  readonly positions: Record<string, { page: number; progress: number; cfi: string | null }>;
  readonly files: string[];
  readonly openedExternally: string[];
  reset(): void;
  setNextPick(paths: string[]): void;
  setNextExportPath(path: string | null): void;
  setPendingOpen(paths: string[]): void;
  openPaths(paths: string[]): void;
  dropPaths(paths: string[]): void;
  readonly anki: MockAnkiHandle;
  /** Sync mock (src/lib/core/mock/ankiSync.ts): network down/up, server asking for a full sync, last sync time. */
  syncSetOffline(offline: boolean): void;
  syncRequireFull(choice: { uploadOk: boolean; downloadOk: boolean } | null): void;
  syncSetLastSyncAt(ms: number | null): void;
  syncStatus(): { state: string; loggedIn: boolean; lastSyncAt: number | null } & Record<string, unknown>;
  readonly syncNotifications: string[];
  /** The vocabulary scan mock (src/lib/core/mock/vocab.ts). */
  readonly vocab: MockVocabHandle;
  setVocabRoot(deckId: number | null): void;
  /** Simulates the OS opening a `leitor://` URL while the app runs. */
  deepLink(url: string): void;
  /** The OCR mock (src/lib/core/mock/ocr.ts). */
  readonly ocr: {
    setModelsAvailable(available: boolean): void;
    setPageDelay(ms: number | null): void;
    failAtPage(page: number | null): void;
  };
  /** The EPUB annotations, tombstones included (src/lib/core/mock/epub.ts). */
  readonly epub: {
    readonly annotations: ({ uid: string; bookUid: string; deleted: boolean } & Record<string, unknown>)[];
  };
}

/** `window.__leitorMock.vocab` (src/lib/core/mock/vocab.ts). */
export interface MockVocabHandle {
  readonly textReads: number;
  readonly overrides: Record<string, 'known' | 'ignored' | 'proper'>;
  setDataAvailable(available: boolean): void;
  setJobDelay(ms: number | null): void;
  setMapping(notetypeName: string, field: string): void;
}

/** `window.__leitorMock.anki` (src/lib/core/mock.ts): the mock Anki collection. */
export interface MockAnkiHandle {
  readonly logs: ({ kind: string; at: number } & Record<string, unknown>)[];
  readonly deckNames: string[];
  readonly notetypeNames: string[];
  readonly backups: {
    path: string;
    fileName: string;
    kind: 'daily' | 'preImport' | 'manual' | 'preSync';
    createdAt: number;
    size: number;
  }[];
  readonly dataset: 'seed' | 'colpkg';
  setNextPackagePick(path: string | null): void;
  setNextImageFile(path: string | null): void;
  fireChanged(reason?: 'import' | 'colpkg' | 'page' | 'backup' | 'sync' | 'syncFull'): void;
  firePageEvent(e: { kind: string } & Record<string, unknown>): void;
  dailyBackup(): unknown;
  /** No C++ compiler and no runner (`code_cpp_unavailable`). */
  setCppAvailable(available: boolean): void;
  codeExtra(noteId: number): { accepted: string[]; requires: string[] };
  noteFields(noteId: number): Record<string, string>;
  /** Suspends the cards matching an Anki search; returns how many. */
  suspend(query: string): number;
  moveCards(query: string, deckName: string): number;
  mapCommand(notetypeName: string, fields: { question: string; answer: string; notes: string | null } | null): void;
}

type MockWindow = { __leitorMock: LeitorMockHandle };

/** Paths the next "Adicionar livro" dialog returns (mock core). */
export async function setNextPick(page: Page, paths: string[]) {
  await page.waitForFunction(() => !!(window as unknown as Partial<MockWindow>).__leitorMock);
  await page.evaluate((p) => (window as unknown as MockWindow).__leitorMock.setNextPick(p), paths);
}

/** Simulates files dropped on the window (Tauri drag and drop, mock core). */
export async function dropPaths(page: Page, paths: string[]) {
  await page.evaluate((p) => (window as unknown as MockWindow).__leitorMock.dropPaths(p), paths);
}

/** Options applied by the mock core when it loads (before the app reads them), e.g. "Abrir com" paths. */
export interface MockInit {
  pendingOpen?: string[];
  nextPick?: string[];
  /** Path the first "Importar" (Anki package) dialog returns; `null` = cancelled. */
  nextPackagePick?: string | null;
}

export async function mockInit(page: Page, init: MockInit) {
  await page.addInitScript((value) => {
    (window as unknown as { __leitorMockInit?: unknown }).__leitorMockInit = value;
  }, init);
}

/**
 * The mocked e2e suite does not load the real PdfCraft (that is the bridge suite, e2e/bridge): /pdfcraft/ answers
 * with an empty page, so the Leitor tab mounts its iframe without the WASM build.
 */
export async function stubPdfcraft(page: Page) {
  await page.route('**/pdfcraft/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>PdfCraft (stub)</title>' }),
  );
}

async function mockReady(page: Page) {
  await page.waitForFunction(() => !!(window as unknown as Partial<MockWindow>).__leitorMock);
}

/** Suspends the cards matching an Anki search in the mock collection (choose which card a deck shows first). */
export async function suspendCards(page: Page, query: string): Promise<number> {
  await mockReady(page);
  return page.evaluate((q) => (window as unknown as MockWindow).__leitorMock.anki.suspend(q), query);
}

/** The mock C++ compiler is there (default) or not (`code_cpp_unavailable`). */
export async function setCppAvailable(page: Page, available: boolean) {
  await mockReady(page);
  await page.evaluate((a) => (window as unknown as MockWindow).__leitorMock.anki.setCppAvailable(a), available);
}

/** Path the next Anki package dialog returns (mock core). */
export async function setNextPackagePick(page: Page, path: string | null) {
  await mockReady(page);
  await page.evaluate((p) => (window as unknown as MockWindow).__leitorMock.anki.setNextPackagePick(p), path);
}

/** The mock Anki collection's log (answers, imports, exports, deletes…). */
export async function ankiLogs(page: Page): Promise<MockAnkiHandle['logs']> {
  await mockReady(page);
  return page.evaluate(() => (window as unknown as MockWindow).__leitorMock.anki.logs);
}

/** Fires an `anki://page` event as the core would (mock core). */
export async function firePageEvent(page: Page, e: { kind: string } & Record<string, unknown>) {
  await mockReady(page);
  await page.evaluate((ev) => (window as unknown as MockWindow).__leitorMock.anki.firePageEvent(ev), e);
}

/** Path the next save dialog returns (mock core; `null` = cancelled). */
export async function setNextExportPath(page: Page, path: string | null) {
  await mockReady(page);
  await page.evaluate((p) => (window as unknown as MockWindow).__leitorMock.setNextExportPath(p), path);
}

/** Drives the sync mock (network, server answers, last sync time). */
export const syncMock = {
  async setOffline(page: Page, offline: boolean) {
    await mockReady(page);
    await page.evaluate((o) => (window as unknown as MockWindow).__leitorMock.syncSetOffline(o), offline);
  },
  async requireFull(page: Page, choice: { uploadOk: boolean; downloadOk: boolean } | null) {
    await mockReady(page);
    await page.evaluate((c) => (window as unknown as MockWindow).__leitorMock.syncRequireFull(c), choice);
  },
  async setLastSyncAt(page: Page, ms: number | null) {
    await mockReady(page);
    await page.evaluate((m) => (window as unknown as MockWindow).__leitorMock.syncSetLastSyncAt(m), ms);
  },
  async status(page: Page) {
    await mockReady(page);
    return page.evaluate(() => (window as unknown as MockWindow).__leitorMock.syncStatus());
  },
};

// ---------------------------------------------------------------- scripted fake PdfCraft (bridge v3)

/** Rect in page view space: [x, y, w, h] points, y down (as the bridge sends them). */
export type FakeRect = [number, number, number, number];

/**
 * A tiny HTML page speaking bridge v3 for the mocked suites (no WASM). It posts `pdfcraft:ready {bridge: 3}`; on
 * `pdfcraft:open` it posts `pdfcraft:active` (60 pages, like the mock Animal Farm); on `pdfcraft:goto` it posts `active` + `page` and
 * `pdfcraft:found {found: true}`; `pdfcraft:selection-now` gets its `pdfcraft:selection-sent`. Everything the app
 * sends is kept in `window.__received` (bytes summarized).
 */
const FAKE_PDFCRAFT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>PdfCraft (fake)</title>
<style>html,body{margin:0;height:100%;font:13px sans-serif;background:#f3f3f5;color:#555}
body{display:flex;align-items:center;justify-content:center}</style></head>
<body><p id="status">PdfCraft (fake)</p>
<script>
(function () {
  var PAGES = 60;
  var origin = location.origin;
  var state = { active: null, page: 0 };
  window.__received = [];
  function post(msg) { parent.postMessage(msg, origin); }
  function clamp(p) { p = Math.floor(Number(p) || 0); return Math.max(0, Math.min(PAGES - 1, p)); }
  function show(id, page) {
    state.active = id; state.page = page;
    document.getElementById('status').textContent = 'PdfCraft (fake) · p. ' + (page + 1);
    post({ type: 'pdfcraft:active', id: id, page: page, pageCount: PAGES });
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || e.source !== parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    var copy = {};
    for (var k in m) {
      if (k === 'bytes') copy.size = m.bytes && m.bytes.byteLength;
      else copy[k] = m[k];
    }
    window.__received.push(copy);
    if (m.type === 'pdfcraft:open') show(m.id, clamp(m.page));
    else if (m.type === 'pdfcraft:goto') {
      var page = clamp(m.page);
      show(m.id, page);
      post({ type: 'pdfcraft:page', id: m.id, page: page, pageCount: PAGES });
      if (typeof m.find === 'string' && m.find)
        post({ type: 'pdfcraft:found', id: m.id, page: page, query: m.find, found: true });
    }
    else if (m.type === 'pdfcraft:selection-now') post({ type: 'pdfcraft:selection-sent', seq: m.seq });
  });
  window.__fake = {
    state: state,
    select: function (s) {
      post({ type: 'pdfcraft:selection', id: state.active, page: s.page, text: s.text, rects: s.rects });
    },
    clear: function () {
      post({ type: 'pdfcraft:selection', id: state.active, page: state.page, text: '', rects: [] });
    },
    menu: function (key, s) {
      var msg = { type: 'pdfcraft:menu', key: key, id: state.active, page: s.page, text: s.text, rects: s.rects };
      if (s.anchor) msg.anchor = s.anchor;
      post(msg);
    },
    turn: function (page) {
      state.page = clamp(page);
      document.getElementById('status').textContent = 'PdfCraft (fake) · p. ' + (state.page + 1);
      post({ type: 'pdfcraft:page', id: state.active, page: state.page, pageCount: PAGES });
    }
  };
  post({ type: 'pdfcraft:ready', version: 'fake', bridge: 3 });
})();
</script></body></html>`;

/** Routes /pdfcraft/** to the scripted fake PdfCraft (bridge v3). Use instead of `stubPdfcraft`. */
export async function fakePdfcraft(page: Page) {
  await page.route('**/pdfcraft/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PDFCRAFT_HTML }),
  );
}

type FakeFrameWindow = {
  __received: Record<string, unknown>[];
  __fake: {
    state: { active: string | null; page: number };
    select(s: { page: number; text: string; rects: FakeRect[] }): void;
    clear(): void;
    menu(key: string, s: { page: number; text: string; rects: FakeRect[]; anchor?: FakeRect }): void;
    turn(page: number): void;
  };
};

/** The fake PdfCraft's frame, once its script ran and a book is in front. */
export async function fakeFrame(page: Page) {
  await expect
    .poll(
      async () => {
        const frame = page.frames().find((f) => f.url().includes('/pdfcraft/'));
        if (!frame) return false;
        return frame
          .evaluate(() => !!(window as unknown as Partial<FakeFrameWindow>).__fake?.state.active)
          .catch(() => false);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return page.frames().find((f) => f.url().includes('/pdfcraft/'))!;
}

const DEFAULT_RECTS: FakeRect[] = [[72, 120, 220, 14]];

/** PdfCraft reports a text selection (`pdfcraft:selection`); `page` is 0-based, as in the bridge. */
export async function fakeSelect(page: Page, sel: { page: number; text: string; rects?: FakeRect[] }) {
  const frame = await fakeFrame(page);
  await frame.evaluate((s) => (window as unknown as FakeFrameWindow).__fake.select(s), {
    page: sel.page,
    text: sel.text,
    rects: sel.rects ?? DEFAULT_RECTS,
  });
}

/** PdfCraft reports an empty selection (cleared). */
export async function fakeClearSelection(page: Page) {
  const frame = await fakeFrame(page);
  await frame.evaluate(() => (window as unknown as FakeFrameWindow).__fake.clear());
}

/** The user clicked one of the app's items in PdfCraft's selection menu (`pdfcraft:menu`). */
export async function fakeMenu(
  page: Page,
  key: string,
  sel: { page: number; text: string; rects?: FakeRect[]; anchor?: FakeRect },
) {
  const frame = await fakeFrame(page);
  await frame.evaluate(({ k, s }) => (window as unknown as FakeFrameWindow).__fake.menu(k, s), {
    k: key,
    s: { page: sel.page, text: sel.text, rects: sel.rects ?? DEFAULT_RECTS, ...(sel.anchor && { anchor: sel.anchor }) },
  });
}

/** Every message the app sent to the fake PdfCraft (bytes summarized as `size`). */
export async function fakeReceived(page: Page): Promise<({ type: string } & Record<string, unknown>)[]> {
  const frame = await fakeFrame(page);
  return frame.evaluate(
    () => (window as unknown as FakeFrameWindow).__received as ({ type: string } & Record<string, unknown>)[],
  );
}

/** The reader turned to `pageIndex` (0-based) in the fake PdfCraft (`pdfcraft:page`). */
export async function fakeTurn(page: Page, pageIndex: number) {
  const frame = await fakeFrame(page);
  await frame.evaluate((p) => (window as unknown as FakeFrameWindow).__fake.turn(p), pageIndex);
}

/** The uid of a mock library book by title. */
export async function bookUid(page: Page, title: string): Promise<string> {
  await mockReady(page);
  return page.evaluate(
    (t) => (window as unknown as MockWindow).__leitorMock.books.find((b) => b.title === t)!.bookUid,
    title,
  );
}

/** Drives the vocabulary mock (src/lib/core/mock/vocab.ts). */
export const vocabMock = {
  async setJobDelay(page: Page, ms: number | null) {
    await mockReady(page);
    await page.evaluate((v) => (window as unknown as MockWindow).__leitorMock.vocab.setJobDelay(v), ms);
  },
  async setMapping(page: Page, notetype: string, field: string) {
    await mockReady(page);
    await page.evaluate(
      ([n, f]) => (window as unknown as MockWindow).__leitorMock.vocab.setMapping(n!, f!),
      [notetype, field],
    );
  },
  async setDataAvailable(page: Page, available: boolean) {
    await mockReady(page);
    await page.evaluate((v) => (window as unknown as MockWindow).__leitorMock.vocab.setDataAvailable(v), available);
  },
  async textReads(page: Page): Promise<number> {
    await mockReady(page);
    return page.evaluate(() => (window as unknown as MockWindow).__leitorMock.vocab.textReads);
  },
};
