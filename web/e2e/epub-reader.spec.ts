// The EPUB reader (spec 7.1, 4, 18) on its test page (src/features/epub/harness), mocked core, Chromium + WebKit.
// foliate renders inside closed shadow roots: the tests use the section iframes (page.frames(), blob: URLs) and the
// `window.__epubReader` / `window.__epubHarness` hooks, and wait on real signals only.
import type { Frame, Page, TestInfo } from '@playwright/test';
import { dropDevWebsocketErrors, withCsp } from './csp';
import { expect, shot, test } from './fixtures';

const HARNESS = '/src/features/epub/harness/index.html';

// What the page exposes (src/features/epub/testHooks.ts and harness/harness.tsx), as seen from here.
interface HarnessEvent {
  type: string;
  [k: string]: any;
}
interface ReaderHandle {
  goTo(t: { cfi?: string | null; section?: number | null; find?: string | null }): Promise<{ found: boolean | null }>;
  setVocabMarks(section: number, words: { form: string; lemma: string; status: string; color: string }[] | null): void;
  clearVocabMarks(): void;
}
interface Overlay {
  kind: string;
  color: string | null;
  id: string | null;
  rects: number;
}
interface ReaderHooks {
  session: {
    snapshot(): { location: { section: number } | null };
    turn(action: 'next' | 'prev' | 'left' | 'right'): Promise<void>;
    subscribe(cb: () => void): () => void;
    lastTurnAnimationMs: number;
    foliateView: { renderer: { getContents(): { overlayer?: { element: SVGElement } }[] } } | null;
  };
  overlays(): Overlay[];
  visibleText(): string;
  selectText(text: string): boolean;
  rectOf(text: string): [number, number, number, number] | null;
}
declare global {
  interface Window {
    __epubHarness?: {
      events: HarnessEvent[];
      handle: ReaderHandle | null;
      opened: boolean;
      error: string | null;
      openMs: number | null;
      bytes: number;
    };
    __epubReader?: ReaderHooks;
  }
}
type MockEpub = { __leitorMock?: { epub: { annotations: { deleted: boolean }[] } } };
const mockAnnotations = (page: Page, deleted: boolean) =>
  page.evaluate(
    (d) => (window as unknown as MockEpub).__leitorMock?.epub.annotations.filter((a) => a.deleted === d).length,
    deleted,
  );

async function openBook(page: Page, query = '') {
  await page.goto(`${HARNESS}${query}`);
  await page.waitForFunction(() => window.__epubHarness?.opened || window.__epubHarness?.error);
  const error = await page.evaluate(() => window.__epubHarness?.error);
  expect(error).toBeNull();
  await expect(page.getByTestId('epub-reader')).toHaveAttribute('data-status', 'ready');
}

/** The iframe of the section on screen (foliate creates one per section, with a blob: URL). */
async function bookFrame(page: Page): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(async () => {
      const blobs = page.frames().filter((f) => f.url().startsWith('blob:') && !f.isDetached());
      for (const f of blobs.reverse()) {
        try {
          if (await f.evaluate(() => document.body?.textContent?.trim().length ?? 0)) {
            frame = f;
            return true;
          }
        } catch {
          // Detached meanwhile.
        }
      }
      return false;
    })
    .toBe(true);
  return frame!;
}

const rootFontPx = (frame: Frame) =>
  frame.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
const visibleText = (page: Page) => page.evaluate(() => window.__epubReader?.visibleText() ?? '');
const overlays = (page: Page) => page.evaluate(() => window.__epubReader?.overlays() ?? []);
const events = (page: Page, type: string) =>
  page.evaluate((t) => (window.__epubHarness?.events ?? []).filter((e) => e.type === t), type);

async function goToSection(page: Page, section: number) {
  await page.evaluate((s) => window.__epubHarness!.handle!.goTo({ section: s }), section);
  await expect.poll(() => page.evaluate(() => window.__epubReader?.session.snapshot().location?.section)).toBe(section);
}

/** Selects `text` in the book and waits for the selection toolbar. */
async function select(page: Page, text: string) {
  expect(await page.evaluate((s) => window.__epubReader!.selectText(s), text)).toBe(true);
  await expect(page.getByTestId('epub-selection-toolbar')).toBeVisible();
}

/** Clicks the first occurrence of `text` on the page with the mouse. */
async function clickText(page: Page, text: string) {
  const rect = await page.evaluate((s) => window.__epubReader!.rectOf(s), text);
  expect(rect).not.toBeNull();
  const host = (await page.getByTestId('epub-host').boundingBox())!;
  const [x, y, w, h] = rect!;
  await page.mouse.click(host.x + x + w / 2, host.y + y + h / 2);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('epub-test-started')) {
      localStorage.removeItem('leitor.epub.prefs');
      sessionStorage.setItem('epub-test-started', '1');
    }
  });
});

test('opens the sample, turns pages and jumps through the nested TOC', async ({ page }, info) => {
  await openBook(page);
  const frame = await bookFrame(page);
  await expect(frame.locator('body')).toContainText('Part I');
  await expect(page.getByTestId('epub-title')).toHaveText('The Time Machine');
  await expect(page.getByTestId('epub-progress')).toHaveText(/^Cap\. 1 · \d+%$/);

  // Next page → chapter I (the part page is a single page).
  await page.getByRole('button', { name: 'Próxima página' }).click();
  await expect.poll(() => visibleText(page)).toContain('The Time Traveller (for so it will be convenient');
  const chapterFrame = await bookFrame(page);
  await expect(chapterFrame.locator('h1')).toHaveText('Chapter I. Introduction');
  await expect(chapterFrame.locator('img[alt="The Time Machine model"]')).toBeVisible();
  await expect.poll(async () => (await events(page, 'location')).length).toBeGreaterThan(0);

  // TOC: nested items, the current one marked; jump to a chapter inside Part II.
  await page.getByTestId('epub-toc-button').click();
  const toc = page.getByTestId('epub-toc');
  await expect(toc.getByRole('treeitem')).toHaveCount(8);
  await expect(toc.locator('[aria-current="location"]')).toHaveText('Chapter I. Introduction');
  await page.screenshot({ path: shot('epub-toc', info.project.name) });
  await toc.getByRole('button', { name: 'Chapter V. In the Golden Age' }).click();
  await expect(toc).toHaveCount(0);
  await expect.poll(() => visibleText(page)).toContain('Chapter V. In the Golden Age');
  await expect(page.getByTestId('epub-progress')).toHaveText(/^Cap\. 7 · \d+%$/);
  const sections = await events(page, 'sectionShown');
  expect(sections.map((e) => e.section)).toContain(6);

  // Keys inside the book turn pages; app shortcuts go to the app.
  const before = await visibleText(page);
  const shown = await bookFrame(page);
  await shown.locator('body').press('ArrowRight');
  await expect.poll(() => visibleText(page)).not.toBe(before);
  await shown
    .locator('body')
    .press('Control+Shift+P')
    .catch(() => {});
  const keys = await events(page, 'key');
  expect(keys.some((k) => k.key.toLowerCase() === 'p' && k.ctrl && k.shift)).toBe(true);
});

test('drawers take the focus, close on Escape (toolbar, drawer, book) and give it back', async ({ page }) => {
  await openBook(page);
  const tocButton = page.getByTestId('epub-toc-button');
  const toc = page.getByTestId('epub-toc');

  // Opening the TOC focuses its current row (or the first one).
  await tocButton.click();
  const focusedRow = toc.locator('[role="treeitem"]:focus');
  await expect(focusedRow).toHaveCount(1);
  if (await toc.locator('[aria-current="location"]').count()) {
    await expect(focusedRow.locator('[aria-current="location"]')).toHaveCount(1);
  }
  // Escape in the drawer closes it and focus goes back to its toolbar button.
  await page.keyboard.press('Escape');
  await expect(toc).toHaveCount(0);
  await expect(tocButton).toBeFocused();

  // Escape with the focus still on the toolbar button closes the drawer too.
  await tocButton.click();
  await expect(focusedRow).toHaveCount(1);
  await tocButton.focus();
  await page.keyboard.press('Escape');
  await expect(toc).toHaveCount(0);

  // Annotations drawer: focus inside it; Escape gives it back to its button.
  const notesButton = page.getByTestId('epub-annotations-button');
  await notesButton.focus();
  await page.keyboard.press('Enter');
  const notes = page.getByTestId('epub-annotations');
  await expect(notes).toBeVisible();
  await expect.poll(() => notes.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(notes).toHaveCount(0);
  await expect(notesButton).toBeFocused();

  // Escape pressed inside the book closes an open drawer.
  await tocButton.click();
  await expect(toc).toBeVisible();
  const frame = await bookFrame(page);
  await frame.locator('body').press('Escape');
  await expect(toc).toHaveCount(0);
});

test('theme and letter size change and persist after a reload', async ({ page }, info) => {
  await openBook(page, '?section=1');
  await page.getByTestId('epub-appearance').click();
  const panel = page.getByTestId('epub-appearance-panel');
  await panel.getByRole('radio', { name: 'Sépia' }).click();
  await panel.getByRole('button', { name: 'Aumentar a letra' }).click();
  await panel.getByRole('button', { name: 'Aumentar a letra' }).click();
  await expect(page.getByTestId('epub-font-size')).toHaveText('120%');
  const frame = await bookFrame(page);
  await expect
    .poll(() => frame.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(244, 236, 216)');
  await expect.poll(() => rootFontPx(frame)).toBeCloseTo(19.2, 1);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: shot('epub-sepia', info.project.name) });

  await page.reload();
  await page.waitForFunction(() => window.__epubHarness?.opened);
  await expect(page.getByTestId('epub-reader')).toHaveAttribute('data-epub-theme', 'sepia');
  const again = await bookFrame(page);
  await expect
    .poll(() => again.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(244, 236, 216)');
  await expect.poll(() => rootFontPx(again)).toBeCloseTo(19.2, 1);

  await page.getByTestId('epub-appearance').click();
  await page.getByTestId('epub-appearance-panel').getByRole('radio', { name: 'Escuro' }).click();
  await expect
    .poll(() => again.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(30, 30, 30)');
  await expect(page.getByTestId('epub-reader')).toHaveAttribute('data-theme', 'dark');
});

/** Highlight, note, underline and bookmark; reload; colour change and delete. */
async function annotateFlow(page: Page, info: TestInfo, tag = '') {
  await openBook(page, '?section=1');
  await bookFrame(page);

  // Highlight (Yellow, PdfCraft's default).
  await select(page, 'His grey eyes shone');
  await page.getByRole('button', { name: 'Destacar em Amarelo' }).click();
  await expect(page.getByTestId('epub-selection-toolbar')).toHaveCount(0);
  await expect
    .poll(async () => (await overlays(page)).filter((o) => o.kind === 'highlight').map((o) => o.color))
    .toEqual(['#fff000']);

  // Note: highlight + PdfCraft's note icon, comment written in the popover.
  await select(page, 'lean forefinger');
  await page.getByRole('button', { name: 'Nota', exact: true }).click();
  const popover = page.getByTestId('epub-annotation-popover');
  await expect(popover).toBeVisible();
  await popover.getByRole('textbox').fill('Um gesto de professor.');
  await popover.getByRole('button', { name: 'Salvar' }).click();
  await expect(popover).toHaveCount(0);
  await expect.poll(async () => (await overlays(page)).filter((o) => o.kind === 'note').length).toBe(1);

  // Underline.
  await select(page, 'incandescent lights');
  await page.getByRole('button', { name: 'Sublinhar' }).click();
  await expect.poll(async () => (await overlays(page)).filter((o) => o.kind === 'underline').length).toBe(1);

  // Bookmark of this page: a ribbon in the corner.
  await page.getByTestId('epub-bookmark-button').click();
  await expect(page.getByTestId('epub-bookmark-ribbon')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tirar o marcador desta página' })).toBeVisible();
  await page.screenshot({ path: shot(`epub-annotations${tag}`, info.project.name) });

  await expect.poll(() => mockAnnotations(page, false)).toBe(4);

  // Reload: everything comes back from the core and is drawn again.
  await page.reload();
  await page.waitForFunction(() => window.__epubHarness?.opened);
  await bookFrame(page);
  await expect
    .poll(async () => (await overlays(page)).map((o) => o.kind).sort())
    .toEqual(['highlight', 'note', 'underline']);
  await expect(page.getByTestId('epub-bookmark-ribbon')).toBeVisible();
  await page.getByTestId('epub-annotations-button').click();
  const list = page.getByTestId('epub-annotations');
  await expect(list.getByTestId('epub-annotation-item')).toHaveCount(4);
  await expect(list).toContainText('Um gesto de professor.');
  await expect(list.getByTestId('epub-annotation-item').first()).toHaveAttribute('data-kind', 'bookmark');
  await page.screenshot({ path: shot(`epub-annotations-list${tag}`, info.project.name) });
  await list.getByRole('button', { name: 'Fechar' }).click();

  // Colour change and delete from the popover of a clicked highlight.
  await clickText(page, 'grey eyes');
  const pop = page.getByTestId('epub-annotation-popover');
  await expect(pop).toBeVisible();
  await pop.getByRole('button', { name: 'Azul', exact: true }).click();
  await expect
    .poll(async () => (await overlays(page)).filter((o) => o.kind === 'highlight').map((o) => o.color))
    .toEqual(['#0078d6']);
  await pop.getByRole('button', { name: 'Apagar' }).click();
  await expect(pop).toHaveCount(0);
  await expect.poll(async () => (await overlays(page)).filter((o) => o.kind === 'highlight').length).toBe(0);
  await expect.poll(() => mockAnnotations(page, true)).toBe(1);
}

test('highlight, note and bookmark survive a reload; colour change and delete', ({ page }, info) =>
  annotateFlow(page, info));

test('selection toolbar hands card, AI and define to the app', async ({ page }) => {
  await openBook(page, '?section=1');
  await bookFrame(page);
  await select(page, 'recondite matter');
  await expect.poll(async () => (await events(page, 'selection')).filter((e) => e.selection).length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Criar card', exact: true }).click();
  const menu = await events(page, 'menu');
  expect(menu.at(-1)?.key).toBe('card');
  expect(menu.at(-1)?.selection.text).toBe('recondite matter');
  expect(menu.at(-1)?.selection.cfi).toMatch(/^epubcfi\(/);
  expect(menu.at(-1)?.selection.section).toBe(1);
});

test('search finds a word and goes to it', async ({ page }) => {
  await openBook(page);
  await page.getByTestId('epub-search-button').click();
  const drawer = page.getByTestId('epub-search');
  await drawer.getByRole('searchbox').fill('Filby');
  await drawer.getByRole('searchbox').press('Enter');
  await expect(drawer).toContainText(/\d+ resultados?/);
  const hits = drawer.getByTestId('epub-search-hit');
  expect(await hits.count()).toBeGreaterThan(0);
  await hits.first().click();
  await expect.poll(() => visibleText(page)).toContain('Filby');
});

/** Vocabulary underlines (2 px, given colour), click report and clear. */
async function vocabFlow(page: Page) {
  await openBook(page, '?section=1');
  await bookFrame(page);
  await page.evaluate(() =>
    window.__epubHarness!.handle!.setVocabMarks(1, [
      { form: 'recondite', lemma: 'recondite', status: 'unknown', color: '#d85a30' },
      { form: 'traveller', lemma: 'traveller', status: 'learning', color: '#ba7517' },
    ]),
  );
  await expect
    .poll(async () => (await overlays(page)).filter((o) => o.kind === 'vocab').length)
    .toBeGreaterThanOrEqual(2);
  const marks = (await overlays(page)).filter((o) => o.kind === 'vocab');
  expect(new Set(marks.map((m) => m.color))).toEqual(new Set(['#d85a30', '#ba7517']));
  // Underlines, not fills: each rect is 2 px tall.
  const heights = await page.evaluate(() => {
    const el = window.__epubReader!.session.foliateView!.renderer.getContents()[0]!.overlayer!.element;
    return Array.from(el.querySelectorAll('[data-kind="vocab"] rect'), (r) => Number(r.getAttribute('height')));
  });
  expect(heights.every((h) => h === 2)).toBe(true);

  await clickText(page, 'recondite');
  await expect.poll(async () => (await events(page, 'vocabClick')).length).toBe(1);
  const [click] = await events(page, 'vocabClick');
  expect(click).toMatchObject({ form: 'recondite', lemma: 'recondite', section: 1 });

  await page.evaluate(() => window.__epubHarness!.handle!.clearVocabMarks());
  await expect.poll(async () => (await overlays(page)).filter((o) => o.kind === 'vocab').length).toBe(0);
}

test('vocabulary marks are 2 px underlines in the given colour; a click reports the word', ({ page }) =>
  vocabFlow(page));

/** Scripts, handlers, javascript: links and remote resources of a hostile EPUB never run nor load. */
async function hostileFlow(page: Page) {
  const remote: string[] = [];
  page.on('request', (r) => {
    if (/evil\.invalid|example\.org/.test(r.url())) remote.push(r.url());
  });
  await openBook(page, '?book=script');
  const frame = await bookFrame(page);
  await expect(frame.locator('#hostile-text')).toBeVisible();
  // Everything that could run: click the javascript: link, the onclick heading and the form button (if left).
  await clickText(page, 'a javascript link');
  await clickText(page, 'A perfectly ordinary chapter');
  expect(await frame.locator('script').count()).toBe(0);
  expect(await frame.locator('iframe, object, embed, base').count()).toBe(0);
  expect(await frame.evaluate(() => document.querySelectorAll('[onload], [onerror], [onclick]').length)).toBe(0);
  // The external link asks first and never navigates the app.
  await clickText(page, 'an external link');
  await expect(page.getByTestId('epub-external-url')).toHaveText('https://example.org/');
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByTestId('epub-external-url')).toHaveCount(0);
  // Let the page settle on a real signal: the next section loads and lays out.
  await page.getByRole('button', { name: 'Próxima página' }).click();
  await expect.poll(() => visibleText(page)).toContain('The rest of the book.');
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__pwned)).toBeUndefined();
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    expect(
      await f.evaluate(() => (window as unknown as Record<string, unknown>).__pwned).catch(() => undefined),
    ).toBeUndefined();
  }
  expect(remote).toEqual([]);
}

test('a hostile EPUB never runs script or reaches the network', ({ page }) => hostileFlow(page));

/**
 * Hostile sections declared with non-canonical media types (upper case, a charset parameter, text/xml, another +xml,
 * an unknown type): each is opened, shown, and none of its scripts or handlers run.
 */
async function mediaTypesFlow(page: Page) {
  // Same order as MEDIA_TYPE_SECTIONS (src/lib/epub/build.ts).
  const markers = [
    'Upper case media type.',
    'Media type with a parameter.',
    'Plain XML media type.',
    'Another XML media type.',
    'Unknown media type.',
  ];
  for (const [section, marker] of markers.entries()) {
    await openBook(page, `?book=mediatypes&section=${section}`);
    await expect.poll(() => visibleText(page)).toContain(marker);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__pwned)).toBeUndefined();
    for (const f of page.frames()) {
      if (f.isDetached()) continue;
      expect(
        await f.evaluate(() => (window as unknown as Record<string, unknown>).__pwned).catch(() => undefined),
      ).toBeUndefined();
    }
  }
}

test('sections with non-canonical media types are sanitized too', ({ page }) => mediaTypesFlow(page));

test('a section frame without a document ends in the error state, not a spinner', async ({ page, consoleErrors }) => {
  // What WebKitGTK does when the CSP refuses a section frame: the frame fires `load` with no readable document.
  await page.addInitScript(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')!;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return this.src.startsWith('blob:') ? null : desc.get!.call(this);
      },
    });
  });
  await page.goto(`${HARNESS}?book=sample`);
  await expect(page.getByTestId('epub-error')).toContainText('Não foi possível abrir este EPUB.');
  await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  await expect(page.getByTestId('epub-reader')).toHaveAttribute('data-status', 'error');
  expect((await events(page, 'error')).length).toBeGreaterThan(0);
  // foliate's own uncaught error on the missing document (the signal the reader turns into its error state).
  const foliateNull = /\bhead\b|null/;
  expect(consoleErrors.some((e) => foliateNull.test(e))).toBe(true);
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !foliateNull.test(e)));
});

test('an unreadable or DRM book shows an error with "Tentar de novo"', async ({ page }) => {
  await page.goto(`${HARNESS}?book=garbage`);
  await expect(page.getByTestId('epub-error')).toContainText('Não foi possível abrir este EPUB.');
  await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  const errors = await events(page, 'error');
  expect(errors.length).toBeGreaterThan(0);

  await page.goto(`${HARNESS}?book=drm`);
  await expect(page.getByTestId('epub-error')).toContainText('DRM');
});

test('a book without a TOC still opens and says so in the drawer', async ({ page }) => {
  await openBook(page, '?book=notoc');
  await page.getByTestId('epub-toc-button').click();
  await expect(page.getByTestId('epub-toc')).toContainText('Este livro não tem sumário.');
});

test('EPUB 2 (NCX) opens with its nested TOC', async ({ page }) => {
  await openBook(page, '?book=epub2');
  await page.getByTestId('epub-toc-button').click();
  await expect(page.getByTestId('epub-toc').getByRole('treeitem')).toHaveCount(8);
});

async function turnOnce(page: Page): Promise<number> {
  const before = await visibleText(page);
  // foliate ignores a turn while the previous one is settling: click again until the page changes.
  await expect(async () => {
    await page.getByRole('button', { name: 'Próxima página' }).click();
    expect(await visibleText(page)).not.toBe(before);
  }).toPass();
  return page.evaluate(() => window.__epubReader!.session.lastTurnAnimationMs);
}

test('page turns animate in ≤ 150 ms', async ({ page }) => {
  await openBook(page, '?section=1');
  const ms = await turnOnce(page);
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThanOrEqual(150);
});

test('no page-turn animation with prefers-reduced-motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openBook(page, '?section=1');
  expect(await turnOnce(page)).toBe(0);
});

test('a 1 MB EPUB opens fast and turns pages fast', async ({ page, browserName }) => {
  await openBook(page, '?book=big');
  const { openMs, bytes } = await page.evaluate(() => ({
    openMs: window.__epubHarness!.openMs!,
    bytes: window.__epubHarness!.bytes,
  }));
  expect(bytes).toBeGreaterThan(800_000);
  const turnMs = await page.evaluate(async () => {
    const s = window.__epubReader!.session;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      // Until the new page is laid out and reported (foliate then keeps navigation locked 100 ms more).
      const t0 = performance.now();
      let t1 = 0;
      const stop = s.subscribe(() => {
        t1 ||= performance.now();
      });
      await s.turn('next');
      stop();
      times.push((t1 || performance.now()) - t0);
    }
    return times.sort((a, b) => a - b)[2]!;
  });
  console.log(
    `epub perf (${browserName}): open ${Math.round(openMs)} ms, ${bytes} bytes; page turn ${turnMs.toFixed(1)} ms`,
  );
  if (browserName === 'chromium') {
    expect(openMs).toBeLessThan(1500);
    expect(turnMs).toBeLessThan(150);
  }
});

// The same flows under the desktop app's CSP (src-tauri/app/tauri.conf.json), served as a response header: foliate's
// blob: section iframes inherit it (frame-src, frame-ancestors, script-src, img-src...). Only Vite's own inline
// preamble is allowed, by hash, so an inline script from a book stays refused as in the app. A CSP change that breaks
// the reader fails here. Not covered: how WebKitGTK matches 'self' for the app's custom tauri:// origin (the dev
// server's origin is http://localhost).
test.describe('under the desktop app CSP', () => {
  let violations: string[];
  let withPolicy: string[];
  test.beforeEach(async ({ page }) => {
    violations = [];
    withPolicy = [];
    await withCsp(page, violations, withPolicy, { strictInline: true });
  });
  test.afterEach(({ consoleErrors }) => {
    expect(withPolicy.some((u) => u.includes('/src/features/epub/harness/'))).toBe(true);
    dropDevWebsocketErrors(consoleErrors);
  });

  test('opens, highlights, notes and bookmarks with no CSP violation', async ({ page }, info) => {
    await annotateFlow(page, info, '-csp');
    expect(violations).toEqual([]);
  });

  test('vocabulary underlines with no CSP violation', async ({ page }) => {
    await vocabFlow(page);
    expect(violations).toEqual([]);
  });

  test('a hostile EPUB never runs script or reaches the network', async ({ page, consoleErrors }) => {
    await hostileFlow(page);
    // Chromium reports the book's inline handlers and <base> as refused by the policy when the raw section is
    // parsed into an inert DOMParser document (the sanitizer's own parse): the second layer refusing them, never
    // an execution (hostileFlow checks nothing ran). Only such "blocked" reports are tolerated here.
    const blocked = /violates the following Content Security Policy directive.*(blocked|refused)/is;
    for (let i = consoleErrors.length - 1; i >= 0; i--) {
      if (blocked.test(consoleErrors[i]!)) consoleErrors.splice(i, 1);
    }
  });

  test('sections with non-canonical media types are sanitized too', async ({ page, consoleErrors }) => {
    await mediaTypesFlow(page);
    // As for the hostile EPUB above: only the policy's "blocked" reports of the inert parse are tolerated.
    const blocked = /violates the following Content Security Policy directive.*(blocked|refused)/is;
    for (let i = consoleErrors.length - 1; i >= 0; i--) {
      if (blocked.test(consoleErrors[i]!)) consoleErrors.splice(i, 1);
    }
  });
});
