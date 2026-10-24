// The sanitizer hooks of the EPUB loader must not depend on the OPF declaring canonical media types: whatever the
// manifest says, every section foliate turns into a blob: URL is sanitized and gets a type we chose.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_TYPE_SECTIONS, mediaTypeEpub, PWNED_FLAG } from '../../lib/epub/build';
import { classifyMediaType, mediaTypeEssence, openEpubBook } from './loader';

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });
}

describe('EPUB loader media types', () => {
  afterEach(() => vi.restoreAllMocks());

  it('classifies by the essence of the type, never the raw string', () => {
    expect(mediaTypeEssence(' Application/XHTML+xml ; charset=utf-8')).toBe('application/xhtml+xml');
    expect(mediaTypeEssence(undefined)).toBe('');
    expect(classifyMediaType('application/XHTML+xml')).toEqual({ action: 'sanitize', type: 'application/xhtml+xml' });
    expect(classifyMediaType('application/xhtml+xml; charset=utf-8')).toEqual({
      action: 'sanitize',
      type: 'application/xhtml+xml',
    });
    expect(classifyMediaType('TEXT/HTML')).toEqual({ action: 'sanitize', type: 'text/html' });
    expect(classifyMediaType('Image/SVG+XML')).toEqual({ action: 'sanitize', type: 'image/svg+xml' });
    expect(classifyMediaType('text/css;charset=utf-8')).toEqual({ action: 'sanitize', type: 'text/css' });
    for (const t of ['text/xml', 'application/xml', 'application/x-dtbook+xml', 'application/smil+xml'])
      expect(classifyMediaType(t)).toEqual({ action: 'sanitize', type: 'application/xhtml+xml' });
    expect(classifyMediaType('Image/PNG')).toEqual({ action: 'passive', type: 'image/png' });
    expect(classifyMediaType('font/woff2')).toEqual({ action: 'passive', type: 'font/woff2' });
    expect(classifyMediaType('application/vnd.ms-opentype').action).toBe('passive');
    for (const t of ['application/JavaScript', 'text/javascript; charset=utf-8', 'application/wasm'])
      expect(classifyMediaType(t).action).toBe('script');
    // Unknown or missing types can't be sniffed into HTML.
    for (const t of ['', undefined, 'application/x-unknown', 'text/plain', 'multipart/related'])
      expect(classifyMediaType(t)).toEqual({ action: 'text', type: 'text/plain' });
  });

  it('sections with non-canonical media types are sanitized and served with a safe type', async () => {
    const blobs: Blob[] = [];
    let n = 0;
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return `blob:test/${n++}`;
    });
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });

    const book = await openEpubBook(mediaTypeEpub());
    expect(book.sections.length).toBe(MEDIA_TYPE_SECTIONS.length + 1);
    // Only the unknown type ends up as text: every XML/HTML-like one is sanitized and shown.
    expect(MEDIA_TYPE_SECTIONS.filter((s) => classifyMediaType(s.type).type === 'text/plain')).toHaveLength(1);
    const allowed = new Set(['application/xhtml+xml', 'text/html', 'text/plain']);
    for (let i = 0; i < MEDIA_TYPE_SECTIONS.length; i++) {
      const spec = MEDIA_TYPE_SECTIONS[i]!;
      const before = blobs.length;
      const url = await book.sections[i]!.load();
      expect(url, spec.type).toMatch(/^blob:/);
      const blob = blobs[blobs.length - 1]!;
      expect(blobs.length).toBeGreaterThan(before);
      expect(allowed.has(blob.type), `${spec.type} → ${blob.type}`).toBe(true);
      // Shown as text, nothing in it can run (its bytes pass through untouched; jsdom can't read a nested Blob).
      if (blob.type === 'text/plain') continue;
      const text = await blobText(blob);
      expect(text, spec.type).toContain(spec.marker);
      expect(text, spec.type).not.toMatch(/<script/i);
      expect(text, spec.type).not.toMatch(/\son(?:load|error)\s*=/i);
      expect(text, spec.type).not.toContain(`parent.${PWNED_FLAG}`);
    }
  });
});
