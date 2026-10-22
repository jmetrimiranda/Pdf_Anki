/**
 * Builds URLs for the app's custom protocols (`pdf`, `anki`, `card`).
 *
 * Tauri serves custom protocols as `scheme://localhost/...` on Linux, macOS and iOS, but as
 * `http://scheme.localhost/...` on Windows and Android (WebView2 and Android WebView cannot
 * register arbitrary schemes). Never build these URLs by hand.
 */
export type ProtocolScheme = 'pdf' | 'anki' | 'card';

export type UrlStyle = 'scheme' | 'http';

export function detectUrlStyle(userAgent: string = globalThis.navigator?.userAgent ?? ''): UrlStyle {
  return /Windows|Android/i.test(userAgent) ? 'http' : 'scheme';
}

export function protocolUrl(scheme: ProtocolScheme, path: string, style: UrlStyle = detectUrlStyle()): string {
  const clean = path.replace(/^\/+/, '');
  return style === 'http' ? `http://${scheme}.localhost/${clean}` : `${scheme}://localhost/${clean}`;
}

export type ReadingTheme = 'claro' | 'sepia' | 'escuro';

export interface RenderParams {
  scale: number;
  /** Tile in view-space points: [x, y, w, h]. */
  tile?: readonly [number, number, number, number];
  theme?: ReadingTheme;
  /** Low-detail render for thumbnails (PdfCraft's preview mode skips tiny images). */
  preview?: boolean;
}

/** `pdf` protocol route of spec 6.2 (0-based page index). */
export function pdfRenderUrl(docId: string, page: number, params: RenderParams, style?: UrlStyle): string {
  const q = new URLSearchParams({ escala: String(roundScale(params.scale)) });
  if (params.tile) q.set('bloco', params.tile.map((n) => String(Math.round(n * 100) / 100)).join(','));
  if (params.theme) q.set('tema', params.theme);
  if (params.preview) q.set('previa', '1');
  // URLSearchParams encodes commas; the core accepts both, but keep the URL readable.
  const query = q.toString().replace(/%2C/g, ',');
  return protocolUrl('pdf', `render/${encodeURIComponent(docId)}/${page}?${query}`, style);
}

function roundScale(s: number): number {
  return Math.round(s * 1000) / 1000;
}
