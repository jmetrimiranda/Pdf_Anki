// The generated test books must be real EPUBs: foliate's EPUB class (with its vendored zip.js) opens them.
import { describe, expect, it } from 'vitest';
import { EpubOpenError, openEpubBook } from '../../features/epub/loader';
import { buildEpub, crc32, makePng, PWNED_FLAG, SAMPLE_EPUB_CHAPTERS, sampleEpub, scriptEpub, zipStore } from './build';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data as BlobPart).body!.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Rewrites a STORE zip with every entry but `mimetype` deflated (what real EPUBs look like). */
async function deflateZip(zip: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: { name: string; data: Uint8Array }[] = [];
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = text(zip.subarray(at + 30, at + 30 + nameLen));
    entries.push({ name, data: zip.slice(at + 30 + nameLen, at + 30 + nameLen + size) });
    at += 30 + nameLen + size;
  }
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const stored = e.name === 'mimetype';
    const body = stored ? e.data : await deflateRaw(e.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(8, stored ? 0 : 8, true);
    h.setUint32(14, crc32(e.data), true);
    h.setUint32(18, body.length, true);
    h.setUint32(22, e.data.length, true);
    h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, body);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, stored ? 0 : 8, true);
    c.setUint32(16, crc32(e.data), true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('buildEpub', () => {
  it('writes an OCF zip: mimetype first, stored, CRC32', () => {
    const zip = sampleEpub();
    expect(Array.from(zip.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(text(zip.subarray(30, 38))).toBe('mimetype');
    expect(text(zip.subarray(38, 58))).toBe('application/epub+zip');
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(zip.length).toBeLessThan(200_000);
  });

  it('makes valid PNGs', () => {
    const png = makePng(4, 3, [255, 0, 0], [0, 0, 255]);
    expect(Array.from(png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
  });

  it('opens with foliate: metadata, nested TOC (EPUB 3 nav), sections and text', async () => {
    const book = await openEpubBook(sampleEpub(3));
    expect(book.metadata?.title).toBe('The Time Machine');
    expect(book.sections).toHaveLength(SAMPLE_EPUB_CHAPTERS.length);
    expect(book.toc?.map((i) => i.label.trim())).toEqual(['Part I', 'Part II']);
    expect(book.toc?.[1]?.subitems?.map((i) => i.label.trim())).toEqual([
      'Chapter IV. Time Travelling',
      'Chapter V. In the Golden Age',
      'Chapter VI. The Sunset of Mankind',
    ]);
    const doc = await book.sections[1]!.createDocument();
    expect(doc.querySelector('h1')?.textContent).toBe('Chapter I. Introduction');
    expect(doc.body.textContent).toContain('The Time Traveller (for so it will be convenient');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('../images/figure.png');
    const cover = await book.getCover();
    expect(cover?.type).toBe('image/png');
  });

  it('EPUB 2 gets an NCX TOC with the same nesting', async () => {
    const book = await openEpubBook(sampleEpub(2));
    expect(book.toc?.[0]?.subitems).toHaveLength(3);
    expect(book.sections).toHaveLength(8);
  });

  it('a deflated EPUB (like real ones) opens too', async () => {
    const book = await openEpubBook(await deflateZip(sampleEpub(3)));
    const doc = await book.sections[2]!.createDocument();
    expect(doc.querySelector('h1')?.textContent).toBe('Chapter II. The Machine');
  });

  it('a book without a TOC opens with an empty TOC', async () => {
    const book = await openEpubBook(
      buildEpub({
        title: 'x',
        author: 'y',
        language: 'en',
        version: 3,
        omitToc: true,
        chapters: [{ title: 'One', html: '<p>one</p>' }],
      }),
    );
    expect(book.toc ?? []).toEqual([]);
    expect(book.sections).toHaveLength(1);
  });

  it('the sample chapters text matches the book (for the mock core)', () => {
    expect(SAMPLE_EPUB_CHAPTERS.map((c) => [c.section, c.depth])).toEqual([
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 0],
      [5, 1],
      [6, 1],
      [7, 1],
    ]);
    const words = SAMPLE_EPUB_CHAPTERS.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
    expect(words).toBeGreaterThan(3000);
  });

  it('scriptEpub carries the hostile content (the loader sanitizes it later)', () => {
    const raw = text(scriptEpub());
    expect(raw).toContain(`parent.${PWNED_FLAG}`);
    expect(raw).toContain('onerror=');
  });
});

describe('opening untrusted bytes', () => {
  const kind = async (bytes: Uint8Array) => {
    try {
      await openEpubBook(bytes);
      return 'ok';
    } catch (e) {
      return e instanceof EpubOpenError ? e.kind : `unexpected: ${String(e)}`;
    }
  };

  it('garbage, empty zips and zips without an OPF are errors, never crashes', async () => {
    expect(await kind(new Uint8Array())).toBe('invalid');
    expect(await kind(new TextEncoder().encode('not a zip at all, just text'))).toBe('invalid');
    expect(
      await kind(
        new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
      ),
    ).toBe('invalid');
    expect(await kind(zipStore([{ name: 'mimetype', data: 'application/epub+zip' }]))).toBe('invalid');
    expect(
      await kind(
        zipStore([
          { name: 'mimetype', data: 'application/epub+zip' },
          { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="x.opf"' },
        ]),
      ),
    ).toBe('invalid');
    const truncated = sampleEpub().slice(0, 5000);
    expect(await kind(truncated)).toBe('invalid');
  });

  it('DRM (real encryption or Adobe rights.xml) is refused; font obfuscation is not DRM', async () => {
    const drm = zipStore([
      { name: 'mimetype', data: 'application/epub+zip' },
      {
        name: 'META-INF/encryption.xml',
        data: '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>',
      },
    ]);
    expect(await kind(drm)).toBe('drm');
    expect(
      await kind(
        zipStore([
          { name: 'mimetype', data: 'application/epub+zip' },
          { name: 'META-INF/rights.xml', data: '<rights/>' },
        ]),
      ),
    ).toBe('drm');
  });
});
