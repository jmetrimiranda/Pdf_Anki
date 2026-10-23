/**
 * A tiny, dependency-free writer of valid PDF 1.7 files (classic xref table, Helvetica text).
 * Used by the mock core and by the e2e/perf suites to build test PDFs on the fly, so no binary
 * fixture has to be committed. Fast enough for a 500-page file.
 */

export interface MakePdfOptions {
  pages: number;
  title?: string;
  author?: string;
  /** Text of page `i` (0-based). Lines are wrapped at ~90 characters; `\n` starts a new line. */
  textPerPage?: (i: number) => string;
  /** One outline (bookmark) entry per page, up to 50 entries. */
  outline?: boolean;
  /** Adds a yellow Highlight annotation over the first text line of page 1. */
  highlight?: boolean;
  /** Written as `/LeitorBookUid` in the Info dictionary, like the bridge does at save time. */
  leitorBookUid?: string;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const FONT_SIZE = 11;
const LEADING = 15;
const WRAP = 90;
const MAX_LINES = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
const MAX_OUTLINE = 50;

/** Default page text: a heading and a short paragraph, so text extraction finds real words. */
export function defaultPageText(i: number): string {
  return (
    `Page ${i + 1}\n` +
    'The quick brown fox jumps over the lazy dog while the reader studies new words every day. ' +
    'Reading a little every day builds a large vocabulary over time.'
  );
}

/** Latin-1 only (one byte per char); anything else becomes `?` so byte offsets equal string offsets. */
function latin1(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 63;
    out += c < 256 ? ch : '?';
  }
  return out;
}

/** PDF literal string `( … )` with escapes, Latin-1 only. */
function literal(s: string): string {
  return `(${latin1(s)
    .replace(/[\\()]/g, (c) => `\\${c}`)
    .replace(/\r/g, '\\r')})`;
}

/** PDF text string for the Info dict / outline: literal when ASCII, UTF-16BE hex with BOM otherwise. */
function textString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return literal(s);
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function wrap(text: string): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= WRAP) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.slice(0, MAX_LINES);
}

/** One laid-out text line of a page written by [`makePdf`], in page view space (y down, points). */
export interface PdfTextLine {
  text: string;
  x: number;
  /** Baseline, from the top of the page. */
  baseline: number;
  size: number;
}

export const PDF_PAGE_SIZE = { width: PAGE_W, height: PAGE_H } as const;

/** The lines `makePdf` draws for `text`, where it draws them. */
export function layoutPageText(text: string): PdfTextLine[] {
  return wrap(text).map((line, i) => ({ text: line, x: MARGIN, baseline: MARGIN + i * LEADING, size: FONT_SIZE }));
}

function contentStream(text: string): string {
  const lines = wrap(text);
  if (lines.every((l) => !l)) return '';
  let s = `BT\n/F1 ${FONT_SIZE} Tf\n${LEADING} TL\n${MARGIN} ${PAGE_H - MARGIN} Td\n`;
  for (const line of lines) s += `${literal(line)} Tj\nT*\n`;
  return `${s}ET\n`;
}

export function makePdf(opts: MakePdfOptions): Uint8Array {
  const pageCount = Math.max(1, Math.floor(opts.pages));
  const textOf = opts.textPerPage ?? defaultPageText;

  // Object numbers: 1 catalog, 2 pages, 3 font, 4 info, 5 outlines root (always reserved),
  // then per page: page, contents; then outline items; then the highlight annotation.
  const CATALOG = 1;
  const PAGES = 2;
  const FONT = 3;
  const INFO = 4;
  const OUTLINES = 5;
  const pageObj = (i: number) => 6 + 2 * i;
  const contentObj = (i: number) => 7 + 2 * i;
  const firstOutlineItem = 6 + 2 * pageCount;
  const outlineCount = opts.outline ? Math.min(pageCount, MAX_OUTLINE) : 0;
  const highlightObj = firstOutlineItem + outlineCount;
  const total = highlightObj + (opts.highlight ? 1 : 0) - 1;

  const bodies: string[] = new Array<string>(total + 1);
  bodies[CATALOG] =
    `<< /Type /Catalog /Pages ${PAGES} 0 R` +
    (outlineCount ? ` /Outlines ${OUTLINES} 0 R /PageMode /UseOutlines` : '') +
    ' >>';
  bodies[PAGES] =
    `<< /Type /Pages /Count ${pageCount} /Kids [` +
    Array.from({ length: pageCount }, (_, i) => `${pageObj(i)} 0 R`).join(' ') +
    '] >>';
  bodies[FONT] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  const info: string[] = ['/Producer (Leitor de Estudos test writer)'];
  if (opts.title !== undefined) info.push(`/Title ${textString(opts.title)}`);
  if (opts.author !== undefined) info.push(`/Author ${textString(opts.author)}`);
  if (opts.leitorBookUid !== undefined) info.push(`/LeitorBookUid ${textString(opts.leitorBookUid)}`);
  bodies[INFO] = `<< ${info.join(' ')} >>`;

  bodies[OUTLINES] = outlineCount
    ? `<< /Type /Outlines /First ${firstOutlineItem} 0 R /Last ${firstOutlineItem + outlineCount - 1} 0 R /Count ${outlineCount} >>`
    : '<< /Type /Outlines /Count 0 >>';

  for (let i = 0; i < pageCount; i++) {
    const annots = opts.highlight && i === 0 ? ` /Annots [${highlightObj} 0 R]` : '';
    bodies[pageObj(i)] =
      `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}]` +
      ` /Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${contentObj(i)} 0 R${annots} >>`;
    const stream = contentStream(textOf(i));
    bodies[contentObj(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  }

  for (let k = 0; k < outlineCount; k++) {
    const n = firstOutlineItem + k;
    const links = (k > 0 ? ` /Prev ${n - 1} 0 R` : '') + (k < outlineCount - 1 ? ` /Next ${n + 1} 0 R` : '');
    bodies[n] =
      `<< /Title ${textString(`Chapter ${k + 1}`)} /Parent ${OUTLINES} 0 R${links}` +
      ` /Dest [${pageObj(k)} 0 R /XYZ 0 ${PAGE_H} null] >>`;
  }

  if (opts.highlight) {
    const top = PAGE_H - MARGIN + FONT_SIZE;
    const bottom = PAGE_H - MARGIN - 3;
    const right = MARGIN + 200;
    bodies[highlightObj] =
      `<< /Type /Annot /Subtype /Highlight /Rect [${MARGIN} ${bottom} ${right} ${top}]` +
      ` /QuadPoints [${MARGIN} ${top} ${right} ${top} ${MARGIN} ${bottom} ${right} ${bottom}]` +
      ` /C [1 0.9 0.2] /CA 0.5 /F 4 /P ${pageObj(0)} 0 R /Contents (Test highlight) >>`;
  }

  // Header with a binary comment line so tools treat the file as binary.
  const chunks: string[] = ['%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'];
  let offset = chunks[0]!.length;
  const offsets = new Array<number>(total + 1).fill(0);
  for (let n = 1; n <= total; n++) {
    offsets[n] = offset;
    const obj = `${n} 0 obj\n${bodies[n]}\nendobj\n`;
    chunks.push(obj);
    offset += obj.length;
  }
  const xrefAt = offset;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  chunks.push(xref);
  chunks.push(
    `trailer\n<< /Size ${total + 1} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );

  const text = chunks.join('');
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Latin-1 view of PDF bytes, for byte searches in tests (`%PDF-`, `/LeitorBookUid`). */
export function pdfBytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}
