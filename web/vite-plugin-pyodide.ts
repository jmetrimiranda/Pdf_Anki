// Serves the vendored Pyodide (scripts/fetch-pyodide.sh → src-tauri/resources/pyodide/) at /pyodide/ on the same
// origin as the UI, for the Python worker of the code cards (spec 11.4). Dev/preview: middleware over that dir.
// Build: copied into dist/pyodide/, which Tauri embeds with the rest of the frontend (offline: no download on
// desktop). A production build without it fails; dev answers 404 with the hint.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin, ResolvedConfig } from 'vite';
import { mimeType as baseMimeType, resolveStatic } from './vite-plugin-pdfcraft';

export interface PyodidePluginOptions {
  /** Default: env LEITOR_PYODIDE_DIR or ../src-tauri/resources/pyodide. */
  dir?: string;
}

export const PYODIDE_BASE = '/pyodide/';
export const PYODIDE_MISSING_HINT = 'Pyodide missing: run scripts/fetch-pyodide.sh';
/** The files the worker loads (scripts/fetch-pyodide.sh extracts exactly these). */
export const PYODIDE_FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
] as const;

export function pyodideMimeType(file: string): string {
  if (file.toLowerCase().endsWith('.zip')) return 'application/zip';
  return baseMimeType(file);
}

export function pyodideDir(opts: PyodidePluginOptions = {}, webRoot = process.cwd()): string {
  return path.resolve(
    webRoot,
    opts.dir ?? process.env.LEITOR_PYODIDE_DIR ?? path.join('..', 'src-tauri', 'resources', 'pyodide'),
  );
}

/** Every file the worker needs is there. */
export function hasPyodide(dir: string): boolean {
  return PYODIDE_FILES.every((f) => existsSync(path.join(dir, f)));
}

function middleware(root: () => string, warn: (msg: string) => void): Connect.NextHandleFunction {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    if (!pathname.startsWith(PYODIDE_BASE)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const dir = root();
    // No index: only files.
    const file = pathname === PYODIDE_BASE ? null : resolveStatic(dir, PYODIDE_BASE, pathname);
    if (!file) {
      const missing = !hasPyodide(dir);
      if (missing) warn(`[pyodide] ${PYODIDE_MISSING_HINT} (${dir})`);
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(missing ? PYODIDE_MISSING_HINT : 'not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', pyodideMimeType(file));
    res.setHeader('Content-Length', String(statSync(file).size));
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };
}

export default function pyodide(opts: PyodidePluginOptions = {}): Plugin {
  let config: ResolvedConfig;
  const dir = () => pyodideDir(opts, config?.root ?? process.cwd());
  const warn = (msg: string) => config.logger.warn(msg, { timestamp: true });

  return {
    name: 'leitor-pyodide',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use(middleware(dir, warn));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(dir, warn));
    },
    async closeBundle() {
      if (config.command !== 'build') return;
      const src = dir();
      if (!hasPyodide(src)) {
        throw new Error(`Pyodide ausente em ${src}: rode scripts/fetch-pyodide.sh (os cards de Python precisam dele)`);
      }
      const out = path.resolve(config.root, config.build.outDir, 'pyodide');
      // Dotfiles (.version) stay out.
      await cp(src, out, {
        recursive: true,
        force: true,
        filter: (from) => !path.basename(from).startsWith('.') || from === src,
      });
      config.logger.info(`[pyodide] copied ${src} -> ${out}`);
    },
  };
}
