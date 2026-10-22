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
