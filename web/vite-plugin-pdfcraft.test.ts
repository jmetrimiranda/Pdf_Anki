// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, preview } from 'vite';
import pdfcraft, { BUILD_MISSING_HTML, mimeType, resolveStatic } from './vite-plugin-pdfcraft';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pdfcraft-web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>PdfCraft</title>');
  writeFileSync(path.join(dir, 'pdfcraft-web-abc_bg.wasm'), Buffer.from([0, 97, 115, 109]));
  writeFileSync(path.join(dir, 'pdfcraft-web-abc.js'), 'export {}');
  writeFileSync(path.join(dir, '.build-stamp'), 'commit=x');
  mkdirSync(path.join(dir, 'sub'));
  mkdirSync(path.join(dir, 'empty-dist'));
  writeFileSync(path.join(dir, 'empty-dist', 'index.html'), '<!doctype html><title>app</title>');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveStatic', () => {
  it('maps the base to index.html and files inside the root', () => {
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/')).toBe(path.join(dir, 'index.html'));
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/pdfcraft-web-abc_bg.wasm')).toBe(
      path.join(dir, 'pdfcraft-web-abc_bg.wasm'),
    );
  });

  it('never escapes the root or serves directories', () => {
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/../package.json')).toBeNull();
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/sub')).toBeNull();
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/%E0%A4%A')).toBeNull();
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/missing.js')).toBeNull();
    expect(resolveStatic(dir, '/pdfcraft/', '/pdfcraft/.build-stamp')).toBeNull();
  });
});

describe('mimeType', () => {
  it('serves wasm as application/wasm (needed by instantiateStreaming)', () => {
    expect(mimeType('x_bg.wasm')).toBe('application/wasm');
    expect(mimeType('x.js')).toMatch(/^text\/javascript/);
    expect(mimeType('index.html')).toMatch(/^text\/html/);
  });
});

async function serve(pdfcraftDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await preview({
    root: path.resolve(__dirname),
    configFile: false,
    logLevel: 'silent',
    plugins: [pdfcraft({ dir: pdfcraftDir })],
    build: { outDir: path.join(dir, 'empty-dist') },
    preview: { port: 0, host: '127.0.0.1' },
  });
  const addr = (server.httpServer as Server).address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe('middleware', () => {
  it('serves the build with the right types and no SPA fallback', async () => {
    const s = await serve(dir);
    try {
      const index = await fetch(`${s.url}/pdfcraft/index.html?host=parent`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<title>PdfCraft</title>');
      const root = await fetch(`${s.url}/pdfcraft/`);
      expect(await root.text()).toContain('PdfCraft');
      const wasm = await fetch(`${s.url}/pdfcraft/pdfcraft-web-abc_bg.wasm`);
      expect(wasm.headers.get('content-type')).toBe('application/wasm');
      expect(wasm.headers.get('cache-control')).toContain('immutable');
      const missing = await fetch(`${s.url}/pdfcraft/nope.js`);
      expect(missing.status).toBe(404);
      const bare = await fetch(`${s.url}/pdfcraft?host=parent`, { redirect: 'manual' });
      expect(bare.status).toBe(301);
      expect(bare.headers.get('location')).toBe('/pdfcraft/?host=parent');
    } finally {
      await s.close();
    }
  });

  it('answers with the build-missing page when there is no build', async () => {
    const s = await serve(path.join(dir, 'does-not-exist'));
    try {
      const res = await fetch(`${s.url}/pdfcraft/index.html?host=parent`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(BUILD_MISSING_HTML);
    } finally {
      await s.close();
    }
  });
});

describe('build', () => {
  async function buildWith(pdfcraftDir: string, mode: string) {
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
    const outDir = path.join(root, 'dist');
    await build({
      root,
      mode,
      configFile: false,
      logLevel: 'silent',
      plugins: [pdfcraft({ dir: pdfcraftDir })],
      build: { outDir },
    });
    return outDir;
  }

  it('copies the PdfCraft build into dist/pdfcraft (no dotfiles)', async () => {
    const out = await buildWith(dir, 'production');
    expect(existsSync(path.join(out, 'pdfcraft', 'index.html'))).toBe(true);
    expect(existsSync(path.join(out, 'pdfcraft', 'pdfcraft-web-abc_bg.wasm'))).toBe(true);
    expect(existsSync(path.join(out, 'pdfcraft', '.build-stamp'))).toBe(false);
  });

  it('fails a production build without the PdfCraft build, and only warns in mock mode', async () => {
    await expect(buildWith(path.join(dir, 'missing'), 'production')).rejects.toThrow(/build-pdfcraft-web\.sh/);
    const out = await buildWith(path.join(dir, 'missing'), 'mock');
    expect(existsSync(path.join(out, 'pdfcraft'))).toBe(false);
  });
});
