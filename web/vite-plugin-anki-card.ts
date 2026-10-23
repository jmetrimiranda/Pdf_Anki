// Dev/mock stand-in for the `card` protocol (spec 8.4), so the study screen runs in `vite dev`, Vitest and the mock
// Playwright tests without the Rust core. Never part of the build output (configureServer/configurePreviewServer
// only).
//
//   /__card/_leitor/reviewer.html   src-tauri/app/assets/card/reviewer.html, rebased on /__card/
//   /__card/_leitor/card-bridge.js  the real shim
//   /__card/_anki/**, /_anki/**     src-tauri/resources/anki-web (env LEITOR_ANKI_WEB_DIR); minimal stubs of
//                                   reviewer.js/css and webview.js/css when the assets were not fetched
//   /__card/fixture-image.png|svg, /__card/fixture-audio.wav   generated media of the mock collection
//   POST /__card/_anki/<m>, /_anki/<m>   403 unless <m> is one of the 4 methods a card may call (like the app)
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { Connect, Plugin } from 'vite';

export const CARD_BASE = '/__card/';
const ANKI_BASE = '/_anki/';

/** The only `/_anki/` methods a card may POST (the `card` protocol answers 403 to anything else). */
export const CARD_METHODS = [
  'getSchedulingStatesWithContext',
  'setSchedulingStates',
  'i18nResources',
  'congratsInfo',
] as const;

export interface AnkiCardPluginOptions {
  /** Anki web assets (scripts/fetch-anki-web.sh). Default: env LEITOR_ANKI_WEB_DIR or ../src-tauri/resources/anki-web. */
  ankiWebDir?: string;
  /** reviewer.html + card-bridge.js. Default: ../src-tauri/app/assets/card. */
  cardAssetsDir?: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function defaultAnkiWebDir(): string {
  return process.env.LEITOR_ANKI_WEB_DIR || path.resolve(HERE, '../src-tauri/resources/anki-web');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export function cardMime(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** `rel` (already URL-decoded, relative) inside `root`, or null when it escapes it or is not a file. */
export function safeJoin(root: string, rel: string): string | null {
  if (rel === '' || rel.includes('\0')) return null;
  if (rel.split(/[\\/]/).some((seg) => seg === '..' || (seg.startsWith('.') && seg !== '.'))) return null;
  const rootAbs = path.resolve(root);
  const file = path.resolve(rootAbs, rel);
  if (!file.startsWith(rootAbs + path.sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** reviewer.html rebased on /__card/ (its absolute /_anki/ and /_leitor/ URLs and the `<base>`). */
export function rebaseReviewerHtml(html: string): string {
  return html
    .replace('<base href="/">', `<base href="${CARD_BASE}">`)
    .replace(/(href|src)="\/(_anki|_leitor)\//g, `$1="${CARD_BASE}$2/`);
}

// ------------------------------------------------------------------ generated media

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A 96×64 RGB picture of a little house (the mock's `fixture-image.png`), encoded here so nothing binary is committed. */
export function fixturePng(): Buffer {
  const w = 96;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let rgb: [number, number, number] = y > 52 ? [120, 180, 90] : [205, 228, 247];
      const inWall = x >= 30 && x < 66 && y >= 30 && y <= 52;
      const inRoof = y >= 12 && y < 30 && Math.abs(x - 48) <= (y - 12) * 1.15;
      const inDoor = x >= 43 && x < 53 && y >= 38 && y <= 52;
      const inWindow = x >= 34 && x < 41 && y >= 35 && y < 42;
      if (inRoof) rgb = [196, 72, 56];
      if (inWall) rgb = [242, 236, 222];
      if (inDoor) rgb = [126, 86, 56];
      if (inWindow) rgb = [92, 150, 214];
      raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export const FIXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64">
<rect width="96" height="64" fill="#cde4f7"/><rect y="52" width="96" height="12" fill="#78b45a"/>
<polygon points="48,12 70,30 26,30" fill="#c44838"/><rect x="30" y="30" width="36" height="22" fill="#f2ecde"/>
<rect x="43" y="38" width="10" height="14" fill="#7e5638"/><rect x="34" y="35" width="7" height="7" fill="#5c96d6"/></svg>`;

/** 0.2 s of a 440 Hz tone, 8 kHz mono 8-bit PCM. */
export function fixtureWav(): Buffer {
  const rate = 8000;
  const n = rate / 5;
  const out = Buffer.alloc(44 + n);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + n, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) out[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return out;
}

const MEDIA: Record<string, () => Buffer | string> = {
  'fixture-image.png': fixturePng,
  'fixture-image.svg': () => FIXTURE_SVG,
  'fixture-audio.wav': fixtureWav,
};

// ------------------------------------------------------------------ stubs when anki-web is missing

/** Enough of reviewer.js for the mock: the functions the shim calls, `onShownHook`, `updateToolbar`. No MathJax. */
export const STUB_REVIEWER_JS = `(function () {
  var typeans = null;
  var queue = Promise.resolve();
  window.onUpdateHook = [];
  window.onShownHook = [];
  function run(hooks) { hooks.slice().forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); }
  function update(html, onupdate, onshown) {
    queue = queue.then(function () {
      window.onUpdateHook.length = 0; window.onUpdateHook.push(onupdate);
      window.onShownHook.length = 0; window.onShownHook.push(onshown);
      var qa = document.getElementById('qa');
      qa.innerHTML = html;
      Array.prototype.forEach.call(qa.querySelectorAll('script'), function (old) {
        var s = document.createElement('script'); s.textContent = old.textContent; old.replaceWith(s);
      });
      run(window.onUpdateHook);
      window.bridgeCommand('updateToolbar');
      run(window.onShownHook);
    });
  }
  window._showQuestion = function (q, a, bodyclass) {
    update(q, function () { window.scrollTo(0, 0); document.body.className = bodyclass; },
      function () { typeans = document.getElementById('typeans'); if (typeans) typeans.focus(); });
  };
  window._showAnswer = function (a, bodyclass) {
    update(a, function () { if (bodyclass) document.body.className = bodyclass;
      var ans = document.getElementById('answer'); if (ans && ans.scrollIntoView) ans.scrollIntoView(); }, function () {});
  };
  window._drawFlag = function (flag) { var e = document.getElementById('_flag'); e.toggleAttribute('hidden', flag === 0);
    e.style.color = 'var(--flag-' + flag + ')'; };
  window._drawMark = function (mark) { document.getElementById('_mark').toggleAttribute('hidden', !mark); };
  window.getTypedAnswer = function () { return typeans ? typeans.value : null; };
  window._typeAnsPress = function () { if (window.event && window.event.key === 'Enter') window.bridgeCommand('ans'); };
  window.anki = window.anki || {};
})();
`;

export const STUB_WEBVIEW_CSS = `:root { --canvas: #f5f5f5; --fg: #020202; --flag-1: #ff9b9b; --flag-2: #ffb347; --flag-3: #93e066;
  --flag-4: #85c1ff; --flag-5: #f097e4; --flag-6: #5ccfca; --flag-7: #9f63d3; }
:root[class*=night-mode] { --canvas: #2c2c2c; --fg: #fcfcfc; }
body { color: var(--fg); }`;

export const STUB_REVIEWER_CSS = `hr { background-color: #737373; margin: 1em 0; border: none; height: 1px }
body { margin: 20px; overflow-wrap: break-word }
img { max-width: 100%; max-height: 95vh }
#_mark, #_flag { position: fixed; right: 10px; top: 0; font-size: 30px }
#_mark { color: #ff0; -webkit-text-stroke: 1px black } #_flag { right: 32px }
#typeans { width: 100%; box-sizing: border-box; line-height: 1.75 }
code#typeans { white-space: pre-wrap; font-family: monospace }
.typeGood { background: #afa; color: black } .typeBad { color: black; background: #faa } .typeMissed { color: black; background: #ccc }
.replay-button { text-decoration: none; display: inline-flex; vertical-align: middle; margin: 3px }
.replay-button svg { width: 40px; height: 40px }
.replay-button svg circle { fill: #fff; stroke: #414141 } .replay-button svg path { fill: #414141 }
.nightMode .replay-button svg circle { fill: #363636; stroke: #a0a0a0 } .nightMode .replay-button svg path { fill: #fff }
.card { font-family: arial; font-size: 20px; text-align: center }`;

const STUBS: Record<string, string> = {
  'js/reviewer.js': STUB_REVIEWER_JS,
  'js/webview.js': '',
  'js/mathjax.js': '',
  'css/webview.css': STUB_WEBVIEW_CSS,
  'css/reviewer.css': STUB_REVIEWER_CSS,
};

// ------------------------------------------------------------------ routing

export type CardResponse =
  | { status: 200; mime: string; file: string }
  | { status: 200; mime: string; body: string | Buffer }
  | { status: 204 | 403 | 404 | 405; mime?: undefined };

/** What the stand-in answers to `method url` (pure; the middleware only writes it). */
export function routeCardRequest(
  method: string,
  url: string,
  dirs: { ankiWeb: string; cardAssets: string },
): CardResponse | null {
  const pathname = url.split(/[?#]/)[0] ?? '';
  let rest: string;
  if (pathname.startsWith(CARD_BASE)) rest = pathname.slice(CARD_BASE.length);
  else if (pathname.startsWith(ANKI_BASE)) rest = pathname.slice(1);
  else return null;
  let rel: string;
  try {
    rel = decodeURIComponent(rest);
  } catch {
    return { status: 404 };
  }

  if (rel.startsWith('_anki/') && (method === 'POST' || method === 'OPTIONS')) {
    const m = rel.slice('_anki/'.length);
    if (!(CARD_METHODS as readonly string[]).includes(m)) return { status: 403 };
    if (method === 'OPTIONS') return { status: 204 };
    // No backend behind the mock: an empty protobuf message.
    return { status: 200, mime: 'application/binary', body: Buffer.alloc(0) };
  }
  if (method !== 'GET' && method !== 'HEAD') return { status: 405 };

  if (rel === '_leitor/reviewer.html') {
    const file = safeJoin(dirs.cardAssets, 'reviewer.html');
    if (!file) return { status: 404 };
    return { status: 200, mime: MIME['.html']!, body: rebaseReviewerHtml(readFileSync(file, 'utf8')) };
  }
  if (rel === '_leitor/card-bridge.js') {
    const file = safeJoin(dirs.cardAssets, 'card-bridge.js');
    return file ? { status: 200, mime: MIME['.js']!, file } : { status: 404 };
  }
  if (rel.startsWith('_anki/')) {
    const inner = rel.slice('_anki/'.length);
    const file = safeJoin(dirs.ankiWeb, inner);
    if (file) return { status: 200, mime: cardMime(file), file };
    const stub = STUBS[inner];
    if (stub !== undefined && !rel.includes('..')) return { status: 200, mime: cardMime(inner), body: stub };
    return { status: 404 };
  }
  if (pathname.startsWith(CARD_BASE)) {
    const media = MEDIA[rel];
    if (media) return { status: 200, mime: cardMime(rel), body: media() };
  }
  return { status: 404 };
}

function middleware(opts: AnkiCardPluginOptions): Connect.NextHandleFunction {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const dirs = {
      ankiWeb: opts.ankiWebDir ?? defaultAnkiWebDir(),
      cardAssets: opts.cardAssetsDir ?? path.resolve(HERE, '../src-tauri/app/assets/card'),
    };
    const r = routeCardRequest(req.method ?? 'GET', req.url ?? '', dirs);
    if (!r) return next();
    // The sandboxed frame has an opaque origin ("null"): its fetches are cross-origin, like on the card protocol.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, anki-op-changes');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = r.status;
    if (r.status !== 200) {
      res.end();
      return;
    }
    res.setHeader('Content-Type', r.mime);
    if ('file' in r) res.end(readFileSync(r.file));
    else res.end(r.body);
  };
}

export default function ankiCard(opts: AnkiCardPluginOptions = {}): Plugin {
  return {
    name: 'leitor-anki-card',
    configureServer: (server) => void server.middlewares.use(middleware(opts)),
    configurePreviewServer: (server) => void server.middlewares.use(middleware(opts)),
  };
}
