import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import ankiCard from './vite-plugin-anki-card';
import pdfcraft from './vite-plugin-pdfcraft';
import pyodide from './vite-plugin-pyodide';

const PAGE_BRIDGE = fileURLToPath(new URL('../src-tauri/app/assets/anki-page/page-bridge.js', import.meta.url));
const MOCK_ANKI_PAGE = '/__mock-anki-page/';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/**
 * Stand-in for an Anki SvelteKit page in the mock core (`core.ankiPageUrl` → /__mock-anki-page/<route>): the real
 * page-bridge.js plus buttons that make the page do what the real ones do (bridgeCommand, core events), so the
 * e2e tests can drive AnkiWebPage without the Rust core.
 */
export function mockAnkiPageHtml(route: string, bridgeJs: string): string {
  const deckOptions = route.startsWith('deck-options/');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Anki (simulado)</title>
<script>${bridgeJs}</script>
<style>
  body { margin: 0; padding: 24px; color: #1f1f1f; background: #fff; font-size: 14px }
  html.night-mode body { color: #eee; background: #2c2c2c }
  h1 { font-size: 18px; margin: 0 0 4px } p { color: #777; margin: 0 0 16px }
  button { margin: 0 8px 8px 0; padding: 6px 12px; border-radius: 6px; border: 1px solid #ccc; background: transparent; color: inherit }
</style></head>
<body>
<h1 data-testid="mock-anki-route">${escapeHtml(route)}</h1>
<p>Página do Anki simulada (núcleo simulado).</p>
<button id="search" onclick="bridgeCommand('browserSearch: deck:current is:review')">Buscar no Navegar</button>
<button id="unbury" onclick="bridgeCommand('unbury')">Desenterrar</button>
<button id="core-close" onclick="fire({ kind: 'close' })">Fechar pelo núcleo</button>
<button id="import-done" onclick="fire({ kind: 'importDone' })">Importação concluída</button>
<button id="changed" onclick="fire({ kind: 'changed' })">Coleção alterada</button>
<script>
  function fire(e) { try { parent.__leitorMock && parent.__leitorMock.anki.firePageEvent(e); } catch (err) {} }
  ${
    deckOptions
      ? `window.anki = window.anki || {};
  window.anki.deckOptionsPendingChanges = function () { document.body.dataset.pendingChanges = '1'; fire({ kind: 'close' }); };`
      : ''
  }
  addEventListener('load', function () { setTimeout(function () { fire({ kind: 'ready' }); }, 30); });
</script>
</body></html>`;
}

function mockAnkiPages(): Plugin {
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    if (!url.startsWith(MOCK_ANKI_PAGE)) return next();
    let route = '';
    try {
      route = decodeURIComponent(url.slice(MOCK_ANKI_PAGE.length).split(/[?#]/)[0] ?? '');
    } catch {
      route = '';
    }
    let bridge = '';
    try {
      bridge = readFileSync(PAGE_BRIDGE, 'utf8');
    } catch {
      bridge = '';
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(mockAnkiPageHtml(route, bridge.replace(/<\/script/gi, '<\\/script')));
  };
  return {
    name: 'leitor-mock-anki-pages',
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}

// foliate-js, the EPUB reader (web/vendor/foliate-js, pinned and unmodified: scripts/fetch-foliate.sh,
// docs/tecnico/foliate.md). `@foliate/<file>.js` imports the vendored subset. view.js also imports, on demand, the
// formats we don't ship (PDF with its 13 MB pdf.js, MOBI, FB2, CBZ) and TTS: those specifiers resolve to a stub that
// throws, so the build neither fails on the missing files nor bundles them.
const FOLIATE_DIR = fileURLToPath(new URL('./vendor/foliate-js/', import.meta.url));
const FOLIATE_UNSUPPORTED = new Set(['./pdf.js', './mobi.js', './fb2.js', './comic-book.js', './tts.js']);
const FOLIATE_STUB = '\0leitor-foliate-unsupported';

export function foliate(): Plugin {
  return {
    name: 'leitor-foliate',
    enforce: 'pre',
    config: () => ({ resolve: { alias: { '@foliate': FOLIATE_DIR.replace(/\/$/, '') } } }),
    resolveId(source, importer) {
      if (importer && importer.startsWith(FOLIATE_DIR) && FOLIATE_UNSUPPORTED.has(source)) return FOLIATE_STUB;
      return null;
    },
    load(id) {
      if (id !== FOLIATE_STUB) return null;
      return "throw new Error('unsupported format');\nexport {};\n";
    },
  };
}

// Tauri expects a fixed dev port and exposes TAURI_* env vars to the frontend.
export default defineConfig({
  // pdfcraft(): PdfCraft web at /pdfcraft/ on the same origin (spec 6.1).
  // pyodide(): the vendored Pyodide at /pyodide/ for the Python code cards' worker (spec 11.4).
  // ankiCard(): the card frame for the study screen in dev/mock; mockAnkiPages(): Anki pages of the mock core.
  // foliate(): the vendored foliate-js (EPUB reader) without the formats we don't ship.
  plugins: [react(), tailwindcss(), pdfcraft(), pyodide(), ankiCard(), mockAnkiPages(), foliate()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    port: 5173,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    watch: { ignored: ['**/src-tauri/**'] },
    // Performance runs (LEITOR_PERF=1): a hot update would remount the Leitor mid-measurement.
    hmr: process.env.LEITOR_PERF !== '1',
  },
  // The Python worker is a module worker (it imports Pyodide's pyodide.mjs at run time).
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Served from disk by Tauri, so one ~500 kB entry chunk is fine.
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.test.{ts,tsx}',
      'vite-plugin-pdfcraft.test.ts',
      'vite-plugin-anki-card.test.ts',
      'vite-plugin-pyodide.test.ts',
      'pyodide-harness.test.ts',
    ],
    setupFiles: ['src/test/setup.ts'],
    css: false,
    // The vendored Pyodide (harness.test.ts) is loaded by Node itself, not transformed.
    server: { deps: { external: [/resources\/pyodide\//] } },
  },
});
