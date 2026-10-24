// Opens an EPUB from its bytes without foliate's `makeBook` (which would pull in the other formats): our own zip
// loader on foliate's vendored zip.js (no workers), with size guards, a DRM check, and the sanitizer hooked into the
// book's `transformTarget` before anything is loaded (sanitize.ts). Untrusted input: every failure is an
// `EpubOpenError`, never an unhandled exception.
import type { EPUB, EpubLoader, TransformDataDetail, TransformLoadDetail } from '@foliate/epub.js';
import { isScriptType, sanitizeMarkup } from './sanitize';

export type EpubOpenErrorKind = 'invalid' | 'drm' | 'too-large';

export class EpubOpenError extends Error {
  constructor(
    readonly kind: EpubOpenErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'EpubOpenError';
  }
}

/** Largest resource we decompress (declared size): a zip bomb can't take the window down. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 20_000;

/** Font obfuscation algorithms foliate undoes; anything else in encryption.xml is DRM. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

/** Canonical types sanitized (as themselves) before foliate makes a blob: URL of them. */
const SANITIZED_TYPES = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml', 'text/css']);

/** Types that are never rendered as a document (images, fonts, media): they pass through as they are. */
const PASSIVE_TYPE =
  /^(?:(?:image|font|audio|video)\/[\w.+-]+|application\/(?:x-)?font-[\w.+-]+|application\/vnd\.ms-opentype|application\/octet-stream)$/;

/** The essence of a media type: no parameters, lower case (`Application/XHTML+xml; charset=x` → `application/xhtml+xml`). */
export function mediaTypeEssence(type: unknown): string {
  return String(type ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
}

/** XML other than XHTML/SVG: `application/xml`, `text/xml`, `application/x-dtbook+xml`… */
function isOtherXml(essence: string): boolean {
  return (
    (essence === 'application/xml' || essence === 'text/xml' || essence.endsWith('+xml')) &&
    essence !== 'application/xhtml+xml' &&
    essence !== 'image/svg+xml'
  );
}

/**
 * What the `data` hook does with a resource of the manifest type `type`. The OPF's media-type is untrusted: whatever it
 * says, the blob foliate makes gets a type we chose, and anything a browser could render as a document is sanitized
 * for exactly that type.
 * - `script`: emptied (never loaded anyway, see the `load` hook);
 * - `sanitize`: (X)HTML/SVG/CSS, and any other XML (`application/xml`, `text/xml`, `*+xml`) as XHTML;
 * - `passive`: images, fonts, media, kept as they are (with the canonical type);
 * - `text`: anything else (unknown, empty, `text/plain`…) becomes `text/plain`, so it can't be sniffed into HTML.
 */
export function classifyMediaType(type: unknown): { action: 'script' | 'sanitize' | 'passive' | 'text'; type: string } {
  const essence = mediaTypeEssence(type);
  if (isScriptType(essence) || isScriptType(String(type ?? ''))) return { action: 'script', type: 'text/plain' };
  if (SANITIZED_TYPES.has(essence)) return { action: 'sanitize', type: essence };
  // Shown as XHTML: as plain XML a browser would use its XML tree viewer (its own inline script) or render nothing.
  if (isOtherXml(essence)) return { action: 'sanitize', type: 'application/xhtml+xml' };
  if (PASSIVE_TYPE.test(essence) && essence !== 'image/svg+xml') return { action: 'passive', type: essence };
  return { action: 'text', type: 'text/plain' };
}

interface ZipLike {
  loader: EpubLoader;
  names: Set<string>;
}

async function openZip(bytes: Uint8Array): Promise<ZipLike> {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new EpubOpenError('invalid', 'not a zip file');
  const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } = await import('@foliate/vendor/zip.js');
  configure({ useWebWorkers: false });
  const reader = new ZipReader(new BlobReader(new Blob([bytes as BlobPart])));
  let entries;
  try {
    entries = await reader.getEntries();
  } catch (e) {
    throw new EpubOpenError('invalid', `unreadable zip: ${String(e)}`);
  }
  if (!entries.length) throw new EpubOpenError('invalid', 'empty zip');
  if (entries.length > MAX_ENTRIES) throw new EpubOpenError('too-large', 'too many entries');
  const map = new Map(entries.filter((e) => !e.directory).map((e) => [e.filename, e]));
  const usable = (name: string) => {
    const entry = map.get(name);
    if (!entry) return null;
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      console.warn(`epub: ${name} is too large (${entry.uncompressedSize} bytes), skipped`);
      return null;
    }
    return entry;
  };
  const loader: EpubLoader = {
    loadText: async (name) => {
      const entry = usable(name);
      if (!entry) return null;
      return entry.getData(new TextWriter());
    },
    loadBlob: async (name, type) => {
      const entry = usable(name);
      if (!entry) return null;
      return entry.getData(new BlobWriter(type));
    },
    getSize: (name) => map.get(name)?.uncompressedSize ?? 0,
  };
  return { loader, names: new Set(map.keys()) };
}

/** Throws `drm` when the book is encrypted with anything other than font obfuscation (or has Adobe rights). */
async function checkDrm(zip: ZipLike): Promise<void> {
  if (zip.names.has('META-INF/rights.xml')) throw new EpubOpenError('drm', 'rights.xml present');
  if (!zip.names.has('META-INF/encryption.xml')) return;
  const xml = (await zip.loader.loadText('META-INF/encryption.xml')) ?? '';
  const algorithms = Array.from(xml.matchAll(/Algorithm\s*=\s*["']([^"']+)["']/g), (m) => m[1]!);
  // EncryptionMethod of each EncryptedData; ds:/KeyInfo algorithms (RSA…) only come with real encryption anyway.
  if (algorithms.some((a) => !FONT_OBFUSCATION.has(a))) throw new EpubOpenError('drm', 'encrypted content');
}

/**
 * The hooks that make the book safe to show: scripts are never loaded, and every (X)HTML/SVG/CSS resource is
 * sanitized. Must be attached before foliate loads any section (i.e. before `view.open(book)`).
 */
export function attachSanitizer(book: EPUB): void {
  const target = book.transformTarget;
  target.addEventListener('load', (e) => {
    const detail = (e as CustomEvent<TransformLoadDetail>).detail;
    if (detail.isScript || classifyMediaType(detail.type).action === 'script') detail.allow = false;
  });
  target.addEventListener('data', (e) => {
    const detail = (e as CustomEvent<TransformDataDetail>).detail;
    const { action, type } = classifyMediaType(detail.type);
    // foliate makes the blob with this type: never the raw (untrusted) one from the OPF.
    detail.type = type;
    if (action === 'script') {
      detail.data = '';
      return;
    }
    if (action !== 'sanitize') return;
    detail.data = Promise.resolve(detail.data).then(
      async (data: unknown) => {
        return sanitizeMarkup(await resourceText(data), type);
      },
      () => sanitizeMarkup('', type),
    );
  });
}

/** The text of a resource foliate hands to the `data` hook (string, Blob — maybe of another realm — or bytes). */
async function resourceText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  const blob = data as { text?: () => Promise<string> } | null;
  if (blob && typeof blob.text === 'function') return String(await blob.text());
  return '';
}

/**
 * Canonical manifest media types (essence, lower case; spine documents declared as other XML become XHTML), so
 * foliate's own exact-match checks (resource rewriting, `parseFromString` for search/text) see the types the
 * sanitizer uses. The `data` hook doesn't rely on it.
 */
function normalizeManifest(book: EPUB): void {
  type Item = { id?: string; mediaType?: unknown };
  const resources = (book as unknown as { resources?: { manifest?: Item[]; spine?: { idref?: string }[] } }).resources;
  const manifest = resources?.manifest;
  if (!Array.isArray(manifest)) return;
  const inSpine = new Set((resources?.spine ?? []).map((s) => s?.idref));
  for (const item of manifest) {
    if (!item || typeof item !== 'object') continue;
    const essence = mediaTypeEssence(item.mediaType);
    item.mediaType = inSpine.has(item.id) && isOtherXml(essence) ? 'application/xhtml+xml' : essence;
  }
}

/** Parses the EPUB (container, OPF, TOC) and returns foliate's book, sanitizer attached. */
export async function openEpubBook(bytes: Uint8Array): Promise<EPUB> {
  const zip = await openZip(bytes);
  await checkDrm(zip);
  const { EPUB } = await import('@foliate/epub.js');
  let book: EPUB;
  try {
    book = await new EPUB(zip.loader).init();
  } catch (e) {
    throw new EpubOpenError('invalid', `not an EPUB: ${String(e)}`);
  }
  if (!book.sections?.length) throw new EpubOpenError('invalid', 'no sections in the spine');
  normalizeManifest(book);
  attachSanitizer(book);
  return book;
}
