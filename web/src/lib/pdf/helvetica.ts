// Helvetica glyph widths (Adobe's standard 14 AFM, 1/1000 em) for the WinAnsi characters `makePdf` writes, so the mock
// core's word rects line up with what a PDF renderer (PdfCraft) draws for the test PDFs.

// Widths of the printable ASCII characters 0x20..0x7e, in order.
const ASCII: readonly number[] = [
  278,
  278,
  355,
  556,
  556,
  889,
  667,
  191,
  333,
  333,
  389,
  584,
  278,
  333,
  278,
  278, // space ! " # $ % & ' ( ) * + , - . /
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  556,
  278,
  278,
  584,
  584,
  584,
  556, // 0-9 : ; < = > ?
  1015,
  667,
  667,
  722,
  722,
  667,
  611,
  778,
  722,
  278,
  500,
  667,
  556,
  833,
  722,
  778, // @ A-O
  667,
  778,
  722,
  667,
  611,
  722,
  667,
  944,
  667,
  667,
  611,
  278,
  278,
  278,
  469,
  556, // P-Z [ \ ] ^ _
  333,
  556,
  556,
  500,
  556,
  556,
  278,
  556,
  556,
  222,
  222,
  500,
  222,
  833,
  556,
  556, // ` a-o
  556,
  556,
  333,
  500,
  278,
  556,
  500,
  722,
  500,
  500,
  500,
  334,
  260,
  334,
  584, // p-z { | } ~
];

/** Latin-1 letters with marks share the width of their base letter (á → a, Ç → C…). */
function baseWidth(ch: string): number | undefined {
  const base = ch.normalize('NFD')[0];
  if (!base || base === ch) return undefined;
  const c = base.charCodeAt(0);
  return c >= 0x20 && c <= 0x7e ? ASCII[c - 0x20] : undefined;
}

/** Width of one character in 1/1000 em, as `makePdf` writes it (non-Latin-1 characters become `?`). */
export function helveticaWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0x3f;
  if (c >= 0x20 && c <= 0x7e) return ASCII[c - 0x20]!;
  if (c > 0xff) return ASCII[0x3f - 0x20]!;
  if (c === 0xa0) return 278;
  return baseWidth(ch) ?? 556;
}

/** Advance of `text` in points at `size`. */
export function helveticaAdvance(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += helveticaWidth(ch);
  return (w * size) / 1000;
}

/** Ascender and descender of Helvetica (AFM), in em. */
export const HELVETICA_ASCENT = 0.718;
export const HELVETICA_DESCENT = 0.207;
