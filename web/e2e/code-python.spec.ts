// Python code cards with the REAL Pyodide (spec 11.4, 21 Phase 5), served at /pyodide/ by vite-plugin-pyodide from
// src-tauri/resources/pyodide (scripts/fetch-pyodide.sh): the "Programação" deck's soma_pares card passes its two
// tests; `while True: pass` is interrupted after 5 s (the worker is terminated) and the next run works on a new
// worker; the same flow under the app's Tauri CSP (as a response header) and with every request outside
// localhost blocked (offline).
import type { Page } from '@playwright/test';
import { dropDevWebsocketErrors, withCsp } from './csp';
import { expect, stubPdfcraft, test } from './fixtures';

const SOMA = 'def soma_pares(xs):\n    return sum(x for x in xs if x % 2 == 0)';
const LOOP = 'while True:\n    pass';

const studyUrl = '/anki/estudar?nome=' + encodeURIComponent('Programação');
const panel = (page: Page) => page.getByTestId('code-panel');
const verdict = (page: Page) => page.getByTestId('code-verdict');

async function typeCode(page: Page, code: string) {
  const editor = panel(page).getByTestId('code-editor');
  await expect(editor).toHaveAttribute('data-state', 'ready');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(code);
}

/** Clicks Verificar and returns the ms until the verdict shows (measured in the page). */
async function verifyTimed(page: Page): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __vStart?: number; __vEnd?: number };
    w.__vStart = undefined;
    w.__vEnd = undefined;
    document.addEventListener('click', () => (w.__vStart = performance.now()), { capture: true, once: true });
    const obs = new MutationObserver(() => {
      if (document.querySelector('[data-testid="code-verdict"]')) {
        w.__vEnd = performance.now();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { subtree: true, childList: true });
  });
  await panel(page).getByRole('button', { name: 'Verificar' }).click();
  await expect(verdict(page)).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => {
    const w = window as unknown as { __vStart?: number; __vEnd?: number };
    return (w.__vEnd ?? 0) - (w.__vStart ?? 0);
  });
}

async function flow(page: Page) {
  await page.goto(studyUrl);
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-shown', 'question');
  await expect(panel(page).getByTestId('code-editor')).toHaveAttribute('data-language', 'python');

  // soma_pares: the reference solution passes the card's two asserts. The first run waits for Pyodide to load.
  await typeCode(page, SOMA);
  await panel(page).getByRole('button', { name: 'Verificar' }).click();
  await expect(verdict(page)).toHaveText('Correto', { timeout: 60_000 });
  await expect(page.getByTestId('code-tests-summary')).toHaveText('2 de 2 testes passaram');
  await expect(page.getByRole('button', { name: /^Bom/ })).toHaveAttribute('data-suggested', 'true');
  // The verdict shows a moment before the answer side and the focus on the suggested button: rating keys typed while
  // the focus is still in the editor belong to the editor.
  await expect(page.getByRole('button', { name: /^Bom/ })).toBeFocused();
  await page.keyboard.press('3');

  // Next card (saida): an infinite loop is interrupted after 5 s (the worker is ready, so the 5 s start at the click).
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-shown', 'question');
  await expect(panel(page).getByTestId('code-editor')).toHaveAttribute('data-language', 'python');
  await typeCode(page, LOOP);
  const ms = await verifyTimed(page);
  await expect(verdict(page)).toHaveText('Errado');
  await expect(page.getByTestId('code-notice')).toHaveText('Tempo esgotado (5 s)');
  expect(ms).toBeGreaterThanOrEqual(5_000);
  expect(ms).toBeLessThan(7_500);
  await expect(page.getByRole('button', { name: /^De novo/ })).toBeFocused();
  await page.keyboard.press('1');

  // Next card (estrutura, rclpy): runs on the NEW worker (the old one was terminated).
  await expect(page.getByTestId('study-page')).toHaveAttribute('data-shown', 'question');
  await typeCode(
    page,
    'import rclpy\nfrom rclpy.node import Node\n\n\nclass Minimo(Node):\n    """Nó mínimo."""\n    def __init__(self):\n        super().__init__("minimo")  # nome\n\n\ndef main():\n    rclpy.init()\n    rclpy.spin(Minimo())\n    rclpy.shutdown()',
  );
  await panel(page).getByRole('button', { name: 'Verificar' }).click();
  await expect(verdict(page)).toHaveText('Equivalente', { timeout: 60_000 });
}

test.describe('Python with the real Pyodide', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async ({ page }) => {
    await stubPdfcraft(page);
  });

  test('soma_pares passes; an infinite loop is interrupted in 5 s; the next run works', async ({ page }) => {
    await flow(page);
  });

  test('under the Tauri CSP (as a response header): no violation, no extra permission', async ({
    page,
    consoleErrors,
  }) => {
    const violations: string[] = [];
    const withPolicy: string[] = [];
    await withCsp(page, violations, withPolicy);
    await flow(page);
    expect(violations).toEqual([]);
    // The policy was on the page and on the worker script (a worker gets its own policy from its response).
    expect(withPolicy.some((u) => u.includes('/anki/estudar'))).toBe(true);
    expect(withPolicy.some((u) => u.includes('python.worker'))).toBe(true);
    expect(withPolicy.some((u) => u.includes('/pyodide/pyodide.asm.wasm'))).toBe(true);
    dropDevWebsocketErrors(consoleErrors);
  });

  test('offline: every request outside localhost is blocked and Python still runs', async ({ page }) => {
    const external: string[] = [];
    await page.context().route(
      (url) => !/^(localhost|127\.0\.0\.1)$/.test(url.hostname) && /^https?:$/.test(url.protocol),
      (route) => {
        external.push(route.request().url());
        return route.abort('internetdisconnected');
      },
    );
    await flow(page);
    expect(external).toEqual([]);
  });
});
