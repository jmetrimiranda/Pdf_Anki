// Serves the PdfCraft web build at /pdfcraft/ on the SAME origin as the UI (spec 6.1: the bridge only talks to
// a same-origin parent). Dev/preview: middleware over the build dir. Build: copied into dist/pdfcraft/, which
// Tauri embeds with the rest of the frontend (`frontendDist`).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin, ResolvedConfig } from 'vite';

export interface PdfcraftPluginOptions {
  /** The trunk output (scripts/build-pdfcraft-web.sh). Default: env LEITOR_PDFCRAFT_DIR or ../src-tauri/resources/pdfcraft-web. */
  dir?: string;
  /** Dev-only directory served at /__e2e__/ (generated PDFs for the perf/visual tests). */
  e2eDir?: string;
}

export const PDFCRAFT_BASE = '/pdfcraft/';
const E2E_BASE = '/__e2e__/';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Stand-in page when the build is missing (dev only): tells the parent so the UI can say "run the build script"
 * instead of waiting for a `ready` that never comes.
 */
export const BUILD_MISSING_HTML = `<!doctype html><meta charset="utf-8"><title>PdfCraft</title>
<script>
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'pdfcraft:failed', error: 'build-missing' }, location.origin);
  }
</script>
<body style="font: 14px system-ui; padding: 24px">PdfCraft web build missing: run scripts/build-pdfcraft-web.sh</body>`;

/**
 * Maps a request path under `base` to a file inside `root`, or null if it escapes `root` or is not a file.
 * `base` itself maps to index.html.
 */
export function resolveStatic(root: string, base: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.slice(base.length));
  } catch {
    return null;
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (rel.includes('\0')) return null;
  // No dotfiles (.build-stamp, .trunk-lock): bookkeeping, not part of the site.
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) return null;
  const rootAbs = path.resolve(root);
  const file = path.resolve(rootAbs, rel);
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function sendFile(res: ServerResponse, file: string, immutable: boolean) {
  const size = statSync(file).size;
  res.statusCode = 200;
  res.setHeader('Content-Type', mimeType(file));
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  createReadStream(file).pipe(res);
}

function staticMiddleware(
  root: () => string,
  base: string,
  onMissingIndex?: (res: ServerResponse) => void,
): Connect.NextHandleFunction {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? '';
    if (pathname === base.slice(0, -1)) {
      res.statusCode = 301;
      res.setHeader('Location', base + url.slice(pathname.length));
      res.end();
      return;
    }
    if (!pathname.startsWith(base)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const dir = root();
    const file = resolveStatic(dir, base, pathname);
    if (file) {
      // trunk hashes the wasm/js names (filehash = true); index.html must always be revalidated.
      sendFile(res, file, !file.endsWith('.html'));
      return;
    }
    const wantsIndex = pathname === base || pathname === `${base}index.html`;
    if (wantsIndex && onMissingIndex) {
      onMissingIndex(res);
      return;
    }
    // No SPA fallback: a missing asset is a 404, never the app's index.html.
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  };
}

export function pdfcraftDir(opts: PdfcraftPluginOptions = {}, webRoot = process.cwd()): string {
  return path.resolve(
    webRoot,
    opts.dir ?? process.env.LEITOR_PDFCRAFT_DIR ?? path.join('..', 'src-tauri', 'resources', 'pdfcraft-web'),
  );
}

export function hasPdfcraftBuild(dir: string): boolean {
  return existsSync(path.join(dir, 'index.html'));
}

export default function pdfcraft(opts: PdfcraftPluginOptions = {}): Plugin {
  let config: ResolvedConfig;
  const dir = () => pdfcraftDir(opts, config?.root ?? process.cwd());
  const e2eDir = () =>
    path.resolve(config?.root ?? process.cwd(), opts.e2eDir ?? path.join('test-results', 'e2e-fixtures'));

  const missing = (res: ServerResponse) => {
    config.logger.warn(`[pdfcraft] build missing in ${dir()}: run scripts/build-pdfcraft-web.sh`, { timestamp: true });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(BUILD_MISSING_HTML);
  };

  const install = (middlewares: Connect.Server) => {
    middlewares.use(staticMiddleware(dir, PDFCRAFT_BASE, missing));
    middlewares.use(staticMiddleware(e2eDir, E2E_BASE));
  };

  return {
    name: 'leitor-pdfcraft',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
    async closeBundle() {
      if (config.command !== 'build') return;
      const src = dir();
      const out = path.resolve(config.root, config.build.outDir, 'pdfcraft');
      if (!hasPdfcraftBuild(src)) {
        const msg = `PdfCraft web build missing in ${src}: rode scripts/build-pdfcraft-web.sh`;
        // Mock builds, and checks of the bundle itself (CI's foliate check) that opt out explicitly.
        if (config.mode === 'mock' || config.env.VITE_MOCK === '1' || process.env.LEITOR_PDFCRAFT_OPTIONAL === '1') {
          config.logger.warn(`[pdfcraft] ${msg} (skipped: mock build or LEITOR_PDFCRAFT_OPTIONAL=1)`);
          return;
        }
        throw new Error(msg);
      }
      // Dotfiles are left out here too.
      await cp(src, out, {
        recursive: true,
        force: true,
        filter: (from) => !path.basename(from).startsWith('.') || from === src,
      });
      config.logger.info(`[pdfcraft] copied ${src} -> ${out}`);
    },
  };
}
