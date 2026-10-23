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
  readonly books: { bookUid: string; title: string; fileVersion: number; fileHash: string }[];
  readonly savedVersions: { uid: string; fileVersion: number; fileHash: string; size: number; hasBookUid: boolean }[];
  readonly sessions: {
    kind: 'start' | 'heartbeat' | 'stop';
    uid: string | null;
    page: number | null;
    reason: string | null;
  }[];
  readonly positions: Record<string, { page: number; progress: number }>;
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
