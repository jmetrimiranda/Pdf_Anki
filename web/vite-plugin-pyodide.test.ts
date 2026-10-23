// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, preview } from 'vite';
import pyodide, { hasPyodide, PYODIDE_FILES, PYODIDE_MISSING_HINT, pyodideMimeType } from './vite-plugin-pyodide';

let dir: string;
let work: string;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'pyodide-plugin-'));
  dir = path.join(work, 'pyodide');
  mkdirSync(dir);
  for (const f of PYODIDE_FILES)
    writeFileSync(path.join(dir, f), f.endsWith('.wasm') ? Buffer.from([0, 97, 115, 109]) : f);
  writeFileSync(path.join(dir, '.version'), 'pyodide-core==test');
  mkdirSync(path.join(work, 'empty-dist'));
  writeFileSync(path.join(work, 'empty-dist', 'index.html'), '<!doctype html><title>app</title>');
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('pyodideMimeType', () => {
  it('serves the interpreter with the types the worker needs', () => {
    expect(pyodideMimeType('pyodide.asm.wasm')).toBe('application/wasm');
    expect(pyodideMimeType('python_stdlib.zip')).toBe('application/zip');
    expect(pyodideMimeType('pyodide.mjs')).toMatch(/^text\/javascript/);
    expect(pyodideMimeType('pyodide.asm.mjs')).toMatch(/^text\/javascript/);
    expect(pyodideMimeType('pyodide-lock.json')).toMatch(/^application\/json/);
  });

  it('knows when the vendored files are complete', () => {
    expect(hasPyodide(dir)).toBe(true);
    expect(hasPyodide(path.join(work, 'nope'))).toBe(false);
  });
});

async function serve(pyodideDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await preview({
    root: path.resolve(__dirname),
    configFile: false,
    logLevel: 'silent',
    plugins: [pyodide({ dir: pyodideDir })],
    build: { outDir: path.join(work, 'empty-dist') },
    preview: { port: 0, host: '127.0.0.1' },
  });
  const addr = (server.httpServer as Server).address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe('middleware', () => {
  it('serves /pyodide/* from the vendored dir, never dotfiles or paths outside it', async () => {
    const s = await serve(dir);
    try {
      const wasm = await fetch(`${s.url}/pyodide/pyodide.asm.wasm`);
      expect(wasm.status).toBe(200);
      expect(wasm.headers.get('content-type')).toBe('application/wasm');
      const zip = await fetch(`${s.url}/pyodide/python_stdlib.zip`);
      expect(zip.headers.get('content-type')).toBe('application/zip');
      const mjs = await fetch(`${s.url}/pyodide/pyodide.mjs?v=1`);
      expect(mjs.headers.get('content-type')).toMatch(/^text\/javascript/);
      expect(await mjs.text()).toBe('pyodide.mjs');
      expect((await fetch(`${s.url}/pyodide/.version`)).status).toBe(404);
      expect((await fetch(`${s.url}/pyodide/..%2Fvite.config.ts`)).status).toBe(404);
      expect((await fetch(`${s.url}/pyodide/`)).status).toBe(404);
      expect((await fetch(`${s.url}/pyodide/pyodide.mjs`, { method: 'POST' })).status).toBe(405);
    } finally {
      await s.close();
    }
  });

  it('answers 404 with the fetch hint when Pyodide is missing', async () => {
    const s = await serve(path.join(work, 'missing'));
    try {
      const res = await fetch(`${s.url}/pyodide/pyodide.mjs`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(PYODIDE_MISSING_HINT);
      expect(PYODIDE_MISSING_HINT).toContain('scripts/fetch-pyodide.sh');
    } finally {
      await s.close();
    }
  });
});

describe('build', () => {
  async function buildWith(pyodideDir: string, mode: string) {
    const root = mkdtempSync(path.join(work, 'app-'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
    const outDir = path.join(root, 'dist');
    await build({
      root,
      mode,
      configFile: false,
      logLevel: 'silent',
      plugins: [pyodide({ dir: pyodideDir })],
      build: { outDir },
    });
    return outDir;
  }

  it('copies Pyodide into dist/pyodide (no dotfiles), so the app embeds it', async () => {
    const out = await buildWith(dir, 'production');
    for (const f of PYODIDE_FILES) expect(existsSync(path.join(out, 'pyodide', f)), f).toBe(true);
    expect(existsSync(path.join(out, 'pyodide', '.version'))).toBe(false);
  });

  it('fails the build with a clear message when Pyodide is missing (never a silent omission)', async () => {
    await expect(buildWith(path.join(work, 'missing'), 'production')).rejects.toThrow(/fetch-pyodide\.sh/);
  });
});
