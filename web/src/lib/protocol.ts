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
