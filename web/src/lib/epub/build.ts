// A tiny EPUB writer for tests, the mock core and the sample book (spec 20: fixtures are generated in code, never
// committed as large files). The zip is STORE-only (no compression) with CRC32, `mimetype` first and uncompressed,
// as OCF requires. EPUB 2 books get an NCX, EPUB 3 books a nav document; nested chapters become a nested TOC.
import { TIME_MACHINE_CHAPTERS } from './timeMachine';

export interface EpubChapterSpec {
  title: string;
  /** XHTML body content (well-formed). Images live at `../images/figure.png` (imagePng) from a chapter. */
  html: string;
  children?: EpubChapterSpec[];
}

export interface EpubSpec {
  title: string;
  author: string;
  language: string;
  version: 2 | 3;
  chapters: EpubChapterSpec[];
  coverPng?: Uint8Array;
  imagePng?: Uint8Array;
  /**
   * Extra (X)HTML documents, by path inside OEBPS (e.g. `text/raw.xhtml`), written verbatim and added to the manifest
   * and to the spine *before* the chapters (so they show first).
   */
  extraHtml?: Record<string, string>;
  /** Manifest media type of an `extraHtml` document, by path (default: by extension), e.g. a non-canonical one. */
  extraHtmlTypes?: Record<string, string>;
  /** Extra raw files, by path inside OEBPS, added to the manifest with their media type (e.g. a script). */
  extraFiles?: Record<string, { data: Uint8Array | string; mediaType: string }>;
  /** Leave out the NCX/nav (a book without a table of contents). */
  omitToc?: boolean;
  identifier?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Zip (STORE)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A STORE-only zip of the given entries, in order. */
export function zipStore(entries: { name: string; data: Uint8Array | string }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 1980-01-01 00:00 in DOS time/date.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = utf8(entry.name);
    const data = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 10, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // STORE
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 10, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// PNG (stored deflate), for the cover and the figure of the test books

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const chunk = raw.subarray(at, Math.min(raw.length, at + 65535));
    const last = at + 65535 >= raw.length;
    const head = new Uint8Array(5);
    head[0] = last ? 1 : 0;
    head[1] = chunk.length & 0xff;
    head[2] = chunk.length >>> 8;
    head[3] = ~chunk.length & 0xff;
    head[4] = (~chunk.length >>> 8) & 0xff;
    blocks.push(head, chunk);
    if (last) break;
  }
  const tail = new DataView(new ArrayBuffer(4));
  tail.setUint32(0, adler32(raw));
  blocks.push(new Uint8Array(tail.buffer));
  return concat(blocks);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const head = new DataView(new ArrayBuffer(8));
  head.setUint32(0, data.length);
  const typeBytes = utf8(type);
  new Uint8Array(head.buffer).set(typeBytes, 4);
  const crc = new DataView(new ArrayBuffer(4));
  crc.setUint32(0, crc32(concat([typeBytes, data])));
  return concat([new Uint8Array(head.buffer), data, new Uint8Array(crc.buffer)]);
}

/** A small RGB PNG: a vertical gradient from `top` to `bottom` (enough to tell an image apart from a blank box). */
export function makePng(
  width: number,
  height: number,
  top: [number, number, number],
  bottom: [number, number, number] = top,
): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(top[c]! + (bottom[c]! - top[c]!) * t);
    }
  }
  const ihdr = new DataView(new ArrayBuffer(13));
  ihdr.setUint32(0, width);
  ihdr.setUint32(4, height);
  ihdr.setUint8(8, 8); // bit depth
  ihdr.setUint8(9, 2); // RGB
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concat([
    signature,
    pngChunk('IHDR', new Uint8Array(ihdr.buffer)),
    pngChunk('IDAT', zlibStored(raw)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// EPUB

export function escapeXml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
}

interface FlatChapter {
  id: string;
  href: string;
  title: string;
  html: string;
  children: FlatChapter[];
}

function flatten(chapters: EpubChapterSpec[], out: FlatChapter[]): FlatChapter[] {
  const level: FlatChapter[] = [];
  for (const ch of chapters) {
    const n = out.length + 1;
    const id = `ch${String(n).padStart(2, '0')}`;
    const node: FlatChapter = { id, href: `text/${id}.xhtml`, title: ch.title, html: ch.html, children: [] };
    out.push(node);
    level.push(node);
    if (ch.children?.length) node.children = flatten(ch.children, out);
  }
  return level;
}

function chapterDocument(title: string, html: string, lang: string, version: 2 | 3): string {
  const doctype =
    version === 2
      ? '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n'
      : '<!DOCTYPE html>\n';
  const epubNs = version === 3 ? ' xmlns:epub="http://www.idpf.org/2007/ops"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
${doctype}<html xmlns="http://www.w3.org/1999/xhtml"${epubNs} xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head>
<body>
<section>
<h1>${escapeXml(title)}</h1>
${html}
</section>
</body>
</html>
`;
}

const BOOK_CSS = `body { font-family: serif; line-height: 1.5; }
h1 { font-size: 1.6em; margin: 1.2em 0 0.8em; }
p { margin: 0 0 0.8em; text-align: justify; }
figure { margin: 1em 0; text-align: center; }
img { max-width: 100%; }
`;

function navList(nodes: FlatChapter[], indent: string): string {
  const items = nodes.map((n) => {
    const sub = n.children.length ? `\n${navList(n.children, indent + '    ')}\n${indent}  ` : '';
    return `${indent}  <li><a href="${n.href}">${escapeXml(n.title)}</a>${sub}</li>`;
  });
  return `${indent}<ol>\n${items.join('\n')}\n${indent}</ol>`;
}

function ncxPoints(nodes: FlatChapter[], counter: { n: number }, indent: string): string {
  return nodes
    .map((n) => {
      const order = ++counter.n;
      const sub = n.children.length ? `\n${ncxPoints(n.children, counter, indent + '  ')}` : '';
      return `${indent}<navPoint id="np${order}" playOrder="${order}"><navLabel><text>${escapeXml(n.title)}</text></navLabel><content src="${n.href}"/>${sub}\n${indent}</navPoint>`;
    })
    .join('\n');
}

/** Builds an EPUB 2 or 3 file in memory. */
export function buildEpub(spec: EpubSpec): Uint8Array {
  const flat: FlatChapter[] = [];
  const tree = flatten(spec.chapters, flat);
  const uid = spec.identifier ?? `urn:uuid:leitor-test-${crc32(utf8(spec.title + spec.author)).toString(16)}`;
  const lang = spec.language;
  const files: { name: string; data: Uint8Array | string }[] = [
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
    },
    { name: 'OEBPS/styles/book.css', data: BOOK_CSS },
  ];
  const manifest: string[] = ['<item id="css" href="styles/book.css" media-type="text/css"/>'];
  const spine: string[] = [];

  const extra = Object.entries(spec.extraHtml ?? {});
  extra.forEach(([path, content], i) => {
    files.push({ name: `OEBPS/${path}`, data: content });
    const type = spec.extraHtmlTypes?.[path] ?? (/\.html?$/i.test(path) ? 'text/html' : 'application/xhtml+xml');
    manifest.push(`<item id="extra${i}" href="${escapeXml(path)}" media-type="${escapeXml(type)}"/>`);
    spine.push(`<itemref idref="extra${i}"/>`);
  });
  Object.entries(spec.extraFiles ?? {}).forEach(([path, file], i) => {
    files.push({ name: `OEBPS/${path}`, data: file.data });
    manifest.push(`<item id="file${i}" href="${escapeXml(path)}" media-type="${escapeXml(file.mediaType)}"/>`);
  });
  for (const ch of flat) {
    files.push({ name: `OEBPS/${ch.href}`, data: chapterDocument(ch.title, ch.html, lang, spec.version) });
    manifest.push(`<item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${ch.id}"/>`);
  }
  if (spec.coverPng) {
    files.push({ name: 'OEBPS/images/cover.png', data: spec.coverPng });
    const props = spec.version === 3 ? ' properties="cover-image"' : '';
    manifest.push(`<item id="cover" href="images/cover.png" media-type="image/png"${props}/>`);
  }
  if (spec.imagePng) {
    files.push({ name: 'OEBPS/images/figure.png', data: spec.imagePng });
    manifest.push('<item id="figure" href="images/figure.png" media-type="image/png"/>');
  }

  let spineAttr = '';
  if (!spec.omitToc) {
    if (spec.version === 3) {
      files.push({
        name: 'OEBPS/nav.xhtml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head><meta charset="UTF-8"/><title>${escapeXml(spec.title)}</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
${navList(tree, '')}
</nav>
</body>
</html>
`,
      });
      manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    } else {
      files.push({
        name: 'OEBPS/toc.ncx',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(uid)}"/><meta name="dtb:depth" content="2"/></head>
<docTitle><text>${escapeXml(spec.title)}</text></docTitle>
<navMap>
${ncxPoints(tree, { n: 0 }, '  ')}
</navMap>
</ncx>
`,
      });
      manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
      spineAttr = ' toc="ncx"';
    }
  }

  const coverMeta = spec.coverPng && spec.version === 2 ? '\n    <meta name="cover" content="cover"/>' : '';
  const modified = spec.version === 3 ? '\n    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>' : '';
  files.push({
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${spec.version === 3 ? '3.0' : '2.0'}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">${escapeXml(uid)}</dc:identifier>
    <dc:title>${escapeXml(spec.title)}</dc:title>
    <dc:creator>${escapeXml(spec.author)}</dc:creator>
    <dc:language>${escapeXml(lang)}</dc:language>${coverMeta}${modified}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine${spineAttr}>
    ${spine.join('\n    ')}
  </spine>
</package>
`,
  });
  return zipStore(files);
}

// ---------------------------------------------------------------------------------------------------------------
// Sample books

export interface SampleEpubChapter {
  /** Spine index (the EPUB "unit" of the vocabulary and of `book_text`). */
  section: number;
  title: string;
  /** 0 = a part, 1 = a chapter inside it. */
  depth: number;
  /** Plain text: the heading, then the paragraphs separated by blank lines. */
  text: string;
}

const PART_INTROS = [
  'In which the Time Traveller explains his theory to his guests, shows them a model of his machine, and comes back from his first journey.',
  'In which the Time Traveller tells his friends what he saw in the year Eight Hundred and Two Thousand Seven Hundred and One.',
];

function chapterTitle(roman: string, title: string): string {
  return `Chapter ${roman}. ${title}`;
}

const paragraphsHtml = (paragraphs: readonly string[]) => paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('\n');

/** The sample book's chapters, in spine order, as plain text (the mock core's `book_text`/vocabulary use them). */
export const SAMPLE_EPUB_CHAPTERS: readonly SampleEpubChapter[] = (() => {
  const out: SampleEpubChapter[] = [];
  for (let part = 0; part < 2; part++) {
    out.push({
      section: out.length,
      title: `Part ${part === 0 ? 'I' : 'II'}`,
      depth: 0,
      text: `Part ${part === 0 ? 'I' : 'II'}\n\n${PART_INTROS[part]}`,
    });
    for (const ch of TIME_MACHINE_CHAPTERS.slice(part * 3, part * 3 + 3)) {
      const title = chapterTitle(ch.roman, ch.title);
      out.push({ section: out.length, title, depth: 1, text: [title, ...ch.paragraphs].join('\n\n') });
    }
  }
  return out;
})();

export const SAMPLE_EPUB_TITLE = 'The Time Machine';
export const SAMPLE_EPUB_AUTHOR = 'H. G. Wells';

/** The figure of chapter I (alt text, so tests can find it). */
export const SAMPLE_FIGURE_ALT = 'The Time Machine model';

/**
 * "The Time Machine" (public domain): EPUB 3, nested TOC (Part I > Chapters I–III, Part II > Chapters IV–VI),
 * a cover, a figure in chapter I and about 4,500 words.
 */
export function sampleEpub(version: 2 | 3 = 3): Uint8Array {
  const chapters = TIME_MACHINE_CHAPTERS;
  const part = (n: 0 | 1): EpubChapterSpec => ({
    title: `Part ${n === 0 ? 'I' : 'II'}`,
    html: `<p><em>${escapeXml(PART_INTROS[n]!)}</em></p>`,
    children: chapters.slice(n * 3, n * 3 + 3).map((ch, i) => ({
      title: chapterTitle(ch.roman, ch.title),
      html:
        n === 0 && i === 0
          ? `${paragraphsHtml(ch.paragraphs.slice(0, 2))}
<figure><img src="../images/figure.png" alt="${SAMPLE_FIGURE_ALT}" width="240" height="120"/><figcaption>${SAMPLE_FIGURE_ALT}</figcaption></figure>
${paragraphsHtml(ch.paragraphs.slice(2))}`
          : paragraphsHtml(ch.paragraphs),
    })),
  });
  return buildEpub({
    title: SAMPLE_EPUB_TITLE,
    author: SAMPLE_EPUB_AUTHOR,
    language: 'en',
    version,
    chapters: [part(0), part(1)],
    coverPng: makePng(60, 90, [40, 52, 70], [190, 160, 90]),
    imagePng: makePng(48, 24, [200, 190, 160], [90, 80, 60]),
    identifier: 'urn:uuid:9e5c1f3a-6b1d-4c1e-9a55-time-machine',
  });
}

/** The marker the security tests look for: an EPUB that tries every way to run script in the app. */
export const PWNED_FLAG = '__pwned';

/**
 * A hostile EPUB (spec 18): inline and external scripts, `onerror`/`onload` handlers, a `javascript:` link, an SVG
 * script, an iframe with `srcdoc`, `<object>`, `<embed>`, `<meta http-equiv=refresh>`, `<base>`, an SVG `<set>` that
 * rewrites an href, a remote image and a remote stylesheet. None of it may set `window.__pwned` or reach the network.
 */
export function scriptEpub(): Uint8Array {
  const raw = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:xlink="http://www.w3.org/1999/xlink" lang="en">
<head>
<meta charset="UTF-8"/>
<title>Hostile chapter</title>
<base href="http://evil.invalid/"/>
<meta http-equiv="refresh" content="0;url=javascript:parent.${PWNED_FLAG}='meta'"/>
<link rel="stylesheet" href="http://evil.invalid/track.css"/>
<link rel="prefetch" href="http://evil.invalid/prefetch"/>
<script>parent.${PWNED_FLAG} = 'script'; top.${PWNED_FLAG} = 'script';</script>
<script src="../scripts/evil.js"></script>
<style>body { background-image: url("http://evil.invalid/bg.png"); }</style>
</head>
<body onload="parent.${PWNED_FLAG}='onload'">
<h1 onclick="parent.${PWNED_FLAG}='onclick'">A perfectly ordinary chapter</h1>
<p id="hostile-text">The quick brown fox jumps over the lazy dog.</p>
<p><img src="missing.png" alt="broken" onerror="parent.${PWNED_FLAG}='onerror'"/></p>
<p><img src="http://evil.invalid/pixel.png" alt="remote"/></p>
<p><a id="js-link" href="javascript:parent.${PWNED_FLAG}='link'">a javascript link</a></p>
<p><a id="external-link" href="https://example.org/">an external link</a></p>
<iframe srcdoc="&lt;script&gt;parent.parent.${PWNED_FLAG}='srcdoc'&lt;/script&gt;"></iframe>
<object data="data:text/html,&lt;script&gt;parent.parent.${PWNED_FLAG}='object'&lt;/script&gt;"></object>
<embed src="data:text/html,&lt;script&gt;parent.parent.${PWNED_FLAG}='embed'&lt;/script&gt;"/>
<form action="javascript:parent.${PWNED_FLAG}='form'"><button id="form-button" formaction="javascript:parent.${PWNED_FLAG}='formaction'">go</button></form>
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="parent.${PWNED_FLAG}='svgonload'">
  <script>parent.${PWNED_FLAG} = 'svgscript';</script>
  <a xlink:href="javascript:parent.${PWNED_FLAG}='svglink'"><rect width="20" height="20"/>
    <set attributeName="href" to="javascript:parent.${PWNED_FLAG}='set'"/>
    <animate attributeName="xlink:href" values="javascript:parent.${PWNED_FLAG}='animate'"/>
  </a>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><script>parent.${PWNED_FLAG}='foreign'</script></div></foreignObject>
</svg>
</body>
</html>
`;
  return buildEpub({
    title: 'Hostile Book',
    author: 'Nobody',
    language: 'en',
    version: 3,
    extraHtml: { 'text/hostile.xhtml': raw },
    extraFiles: {
      'scripts/evil.js': { data: `parent.${PWNED_FLAG} = 'external';`, mediaType: 'application/javascript' },
    },
    chapters: [{ title: 'After', html: '<p>The rest of the book.</p>' }],
    identifier: 'urn:uuid:hostile',
  });
}

/**
 * Hostile sections declared with non-canonical media types (`application/XHTML+xml`, a `charset` parameter,
 * `text/xml`, an unknown `+xml` type and no usable type at all): each one tries to set `window.__pwned` with an inline
 * script and handlers, and shows a marker paragraph (`MEDIA_TYPE_SECTIONS`). The sanitizer must still clean them.
 */
export const MEDIA_TYPE_SECTIONS: { path: string; type: string; marker: string }[] = [
  { path: 'text/upper.xhtml', type: 'application/XHTML+xml', marker: 'Upper case media type.' },
  { path: 'text/param.xhtml', type: 'application/xhtml+xml; charset=utf-8', marker: 'Media type with a parameter.' },
  { path: 'text/textxml.xml', type: 'text/xml', marker: 'Plain XML media type.' },
  { path: 'text/dtbook.xml', type: 'application/x-dtbook+xml', marker: 'Another XML media type.' },
  { path: 'text/unknown.xhtml', type: 'application/x-unknown', marker: 'Unknown media type.' },
];

export function mediaTypeEpub(): Uint8Array {
  const doc = (marker: string, flag: string) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>${escapeXml(marker)}</title><script>parent.${PWNED_FLAG} = '${flag}'; window.${PWNED_FLAG} = '${flag}';</script></head>
<body onload="parent.${PWNED_FLAG}='${flag}-onload'">
<p class="marker">${escapeXml(marker)}</p>
<p><img src="missing.png" alt="broken" onerror="parent.${PWNED_FLAG}='${flag}-onerror'"/></p>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="parent.${PWNED_FLAG}='${flag}-svg'"/>
</body>
</html>
`;
  return buildEpub({
    title: 'Media Types',
    author: 'Nobody',
    language: 'en',
    version: 3,
    extraHtml: Object.fromEntries(MEDIA_TYPE_SECTIONS.map((s, i) => [s.path, doc(s.marker, `mt${i}`)])),
    extraHtmlTypes: Object.fromEntries(MEDIA_TYPE_SECTIONS.map((s) => [s.path, s.type])),
    chapters: [{ title: 'After', html: '<p>The rest of the book.</p>' }],
    identifier: 'urn:uuid:media-types',
  });
}
