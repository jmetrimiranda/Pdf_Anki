// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, preview } from 'vite';
import ankiCard, {
  CARD_METHODS,
  fixturePng,
  fixtureWav,
  rebaseReviewerHtml,
  routeCardRequest,
  safeJoin,
} from './vite-plugin-anki-card';

let dir: string;
let ankiWeb: string;
let cardAssets: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'anki-card-'));
  ankiWeb = path.join(dir, 'anki-web');
  cardAssets = path.join(dir, 'card');
  mkdirSync(path.join(ankiWeb, 'js'), { recursive: true });
  mkdirSync(path.join(ankiWeb, 'css'), { recursive: true });
  mkdirSync(cardAssets);
  writeFileSync(path.join(ankiWeb, 'js', 'reviewer.js'), '/* real reviewer */');
  writeFileSync(path.join(ankiWeb, '.version'), 'x');
  writeFileSync(path.join(dir, 'secret.txt'), 'secret');
  writeFileSync(
    path.join(cardAssets, 'reviewer.html'),
    '<head><base href="/"><link href="/_anki/css/webview.css"><script src="/_leitor/card-bridge.js"></script></head>',
  );
  writeFileSync(path.join(cardAssets, 'card-bridge.js'), '/* shim */');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dirs = () => ({ ankiWeb, cardAssets });

describe('safeJoin', () => {
  it('stays inside the root', () => {
    expect(safeJoin(ankiWeb, 'js/reviewer.js')).toBe(path.join(ankiWeb, 'js', 'reviewer.js'));
    expect(safeJoin(ankiWeb, '../secret.txt')).toBeNull();
    expect(safeJoin(ankiWeb, 'js/../../secret.txt')).toBeNull();
    expect(safeJoin(ankiWeb, '/etc/passwd')).toBeNull();
    expect(safeJoin(ankiWeb, '.version')).toBeNull();
    expect(safeJoin(ankiWeb, 'js')).toBeNull();
    expect(safeJoin(ankiWeb, 'a\0b')).toBeNull();
    expect(safeJoin(ankiWeb, '')).toBeNull();
  });
});

describe('routeCardRequest', () => {
  it('serves the reviewer page rebased on /__card/ and the shim', () => {
    const page = routeCardRequest('GET', '/__card/_leitor/reviewer.html', dirs());
    expect(page).toMatchObject({ status: 200 });
    const body = String((page as { body: string }).body);
    expect(body).toContain('<base href="/__card/">');
    expect(body).toContain('href="/__card/_anki/css/webview.css"');
    expect(body).toContain('src="/__card/_leitor/card-bridge.js"');
    expect(routeCardRequest('GET', '/__card/_leitor/card-bridge.js', dirs())).toMatchObject({
      status: 200,
      file: path.join(cardAssets, 'card-bridge.js'),
    });
    expect(routeCardRequest('GET', '/__card/_leitor/other.js', dirs())).toEqual({ status: 404 });
  });

  it('serves anki-web at /__card/_anki/ and /_anki/, with stubs for missing files', () => {
    for (const base of ['/__card/_anki/', '/_anki/']) {
      expect(routeCardRequest('GET', `${base}js/reviewer.js`, dirs())).toMatchObject({
        file: path.join(ankiWeb, 'js', 'reviewer.js'),
      });
      const css = routeCardRequest('GET', `${base}css/reviewer.css`, dirs());
      expect(css).toMatchObject({ status: 200, mime: 'text/css; charset=utf-8' });
      expect(String((css as { body: string }).body)).toContain('replay-button');
    }
    expect(routeCardRequest('GET', '/_anki/../secret.txt', dirs())).toEqual({ status: 404 });
    expect(routeCardRequest('GET', '/__card/_anki/%2e%2e/secret.txt', dirs())).toEqual({ status: 404 });
    expect(routeCardRequest('GET', '/__card/_anki/%E0%A4%A', dirs())).toEqual({ status: 404 });
    expect(routeCardRequest('GET', '/__card/_anki/.version', dirs())).toEqual({ status: 404 });
  });

  it('answers 403 to every POST except the four card methods', () => {
    for (const m of CARD_METHODS) {
      expect(routeCardRequest('POST', `/__card/_anki/${m}`, dirs())).toMatchObject({ status: 200 });
      expect(routeCardRequest('POST', `/_anki/${m}`, dirs())).toMatchObject({ status: 200 });
      expect(routeCardRequest('OPTIONS', `/__card/_anki/${m}`, dirs())).toEqual({ status: 204 });
    }
    for (const m of ['addNote', 'importAnkiPackage', 'getDeckNames', 'setWantsAbort', 'congratsinfo', '']) {
      expect(routeCardRequest('POST', `/__card/_anki/${m}`, dirs())).toEqual({ status: 403 });
      expect(routeCardRequest('POST', `/_anki/${m}`, dirs())).toEqual({ status: 403 });
    }
    expect(routeCardRequest('PUT', '/__card/fixture-image.png', dirs())).toEqual({ status: 405 });
  });

  it('serves the generated media and nothing else at the root', () => {
    expect(routeCardRequest('GET', '/__card/fixture-image.png', dirs())).toMatchObject({ mime: 'image/png' });
    expect(routeCardRequest('GET', '/__card/fixture-image.svg', dirs())).toMatchObject({ mime: 'image/svg+xml' });
    expect(routeCardRequest('GET', '/__card/fixture-audio.wav', dirs())).toMatchObject({ mime: 'audio/wav' });
    expect(routeCardRequest('GET', '/__card/other.png', dirs())).toEqual({ status: 404 });
    expect(routeCardRequest('GET', '/__card/../package.json', dirs())).toEqual({ status: 404 });
    expect(routeCardRequest('GET', '/elsewhere', dirs())).toBeNull();
  });

  it('generates valid media', () => {
    const png = fixturePng();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(96);
    const wav = fixtureWav();
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  });

  it('rebases only the reviewer URLs', () => {
    expect(rebaseReviewerHtml('<base href="/"><img src="/x.png">')).toBe('<base href="/__card/"><img src="/x.png">');
  });
});

async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const out = path.join(dir, 'dist');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'index.html'), '<!doctype html><title>app</title>');
  const server = await preview({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    plugins: [ankiCard({ ankiWebDir: ankiWeb, cardAssetsDir: cardAssets })],
    build: { outDir: out },
    preview: { port: 0, host: '127.0.0.1' },
  });
  const addr = (server.httpServer as Server).address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe('middleware', () => {
  it('serves the card origin stand-in over HTTP', async () => {
    const s = await serve();
    try {
      const page = await fetch(`${s.url}/__card/_leitor/reviewer.html`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(await page.text()).toContain('/__card/_leitor/card-bridge.js');
      const denied = await fetch(`${s.url}/__card/_anki/addNote`, { method: 'POST', body: new Uint8Array() });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`${s.url}/__card/_anki/i18nResources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/binary' },
        body: new Uint8Array(),
      });
      expect(allowed.status).toBe(200);
      const png = await fetch(`${s.url}/__card/fixture-image.png`);
      expect(png.headers.get('content-type')).toBe('image/png');
    } finally {
      await s.close();
    }
  });

  it('adds nothing to a production build', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
    const outDir = path.join(root, 'dist');
    await build({ root, configFile: false, logLevel: 'silent', plugins: [ankiCard()], build: { outDir } });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(outDir).sort()).toEqual(['index.html']);
    rmSync(root, { recursive: true, force: true });
  });
});
