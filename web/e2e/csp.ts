// The desktop app's Content-Security-Policy (src-tauri/app/tauri.conf.json `app.security.csp`) served as a response
// header by the dev server, so e2e specs run under the policy the app ships with (spec 18, 20). Used by the Python
// code cards (code-python.spec.ts) and the EPUB reader (epub-reader.spec.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { expect } from './fixtures';

/** The production CSP of the desktop app. */
export function tauriCsp(): Record<string, string> {
  const conf = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../src-tauri/app/tauri.conf.json', import.meta.url)), 'utf8'),
  ) as {
    app: { security: { csp: Record<string, string> } };
  };
  return conf.app.security.csp;
}

/** sha256 CSP sources of the inline `<script>` elements of an HTML document (Vite's React refresh preamble). */
function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]!)) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2]!, 'utf8').digest('base64')}'`);
  }
  return out;
}

/**
 * The app's CSP for a response of the dev server. Only what Vite's dev server itself needs is added: its HMR
 * websocket, and its inline React refresh preamble — either as 'unsafe-inline' or (`strictInline`) as the exact
 * hashes of the inline scripts of that document, so any other inline script (e.g. one from a book) stays refused.
 * Nothing is added for the app's own features.
 */
export function devServedCsp(html: string | null, strictInline: boolean): string {
  const csp = { ...tauriCsp() };
  expect(csp['script-src']).not.toContain("'unsafe-eval'");
  expect(csp['script-src']).not.toContain("'unsafe-inline'");
  const extra = strictInline ? inlineScriptHashes(html ?? '') : ["'unsafe-inline'"];
  if (extra.length) csp['script-src'] = `${csp['script-src']} ${extra.join(' ')}`;
  csp['connect-src'] = `${csp['connect-src']} ws://localhost:* http://localhost:*`;
  return Object.entries(csp)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
}

/**
 * `route.fetch()` that retries a dropped connection: under load the dev server sometimes resets a kept-alive socket
 * (`read ECONNRESET`), a test-harness artifact (the app reads its files from the bundle, not over HTTP).
 */
async function fetchWithRetry(route: Route) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await route.fetch();
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up|EPIPE/.test(String(e))) throw e;
    }
  }
}

/**
 * Serves every dev-server response with the app's CSP. `violations` collects the console reports of refused
 * loads/scripts, `withPolicy` the URLs that got the header.
 */
export async function withCsp(
  page: Page,
  violations: string[],
  withPolicy: string[],
  opts: { strictInline?: boolean } = {},
) {
  await page.context().route(/^http:\/\/localhost:\d+\//, async (route) => {
    if (route.request().url().includes('/@vite/client') || route.request().resourceType() === 'websocket') {
      return route.continue();
    }
    const res = await fetchWithRetry(route);
    const isHtml = (res.headers()['content-type'] ?? '').includes('text/html');
    const body = isHtml ? await res.text() : null;
    withPolicy.push(route.request().url());
    await route.fulfill({
      response: res,
      ...(body !== null ? { body } : {}),
      headers: { ...res.headers(), 'content-security-policy': devServedCsp(body, opts.strictInline ?? false) },
    });
  });
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
}

/**
 * Chromium refuses Vite's HMR websocket for a document fulfilled by the route (local network access checks): a
 * dev-server artifact, not the app's (the app has no websocket). Drops those from the console errors.
 */
export function dropDevWebsocketErrors(consoleErrors: string[]) {
  for (let i = consoleErrors.length - 1; i >= 0; i--) {
    if (/WebSocket connection to 'ws:\/\/localhost|\[vite\] failed to connect to websocket/.test(consoleErrors[i]!))
      consoleErrors.splice(i, 1);
  }
}
