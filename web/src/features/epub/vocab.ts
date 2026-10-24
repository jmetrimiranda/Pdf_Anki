// Vocabulary underline in the EPUB reader (spec 12.7): finds the occurrences of the given word forms in a section
// document, word by word (Intl.Segmenter, English), so the session can draw 2 px underlines through foliate's
// Overlayer — never a background fill (spec 4).
import type { VocabStatus } from '../../lib/core/types';

export interface EpubVocabWord {
  form: string;
  lemma: string;
  status: VocabStatus;
  color: string;
}

/** At most this many marks per section. */
export const MAX_MARKS_PER_SECTION = 4000;

/** Lowercase, NFC, typographic apostrophes as `'`. */
export function normalizeWord(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[‘’ʼ′`´＇]/g, "'")
    .toLowerCase();
}

export interface WordSpan {
  start: number;
  end: number;
  word: string;
}

let segmenter: Intl.Segmenter | null = null;

/** The words of `text` with their UTF-16 offsets. */
export function wordSpans(text: string): WordSpan[] {
  const out: WordSpan[] = [];
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    segmenter ??= new Intl.Segmenter('en', { granularity: 'word' });
    for (const s of segmenter.segment(text)) {
      if (s.isWordLike) out.push({ start: s.index, end: s.index + s.segment.length, word: s.segment });
    }
    return out;
  }
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)) {
    out.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  }
  return out;
}

export interface WordMatch<W> {
  start: number;
  end: number;
  word: W;
}

/**
 * Matches the words of `text` against `forms` (keys already normalized). A possessive (`Traveller's`) or an elided
 * ending matches its stem when the whole word isn't a form, and only the stem is marked.
 */
export function matchWords<W>(text: string, forms: ReadonlyMap<string, W>, limit = Infinity): WordMatch<W>[] {
  const out: WordMatch<W>[] = [];
  for (const span of wordSpans(text)) {
    if (out.length >= limit) break;
    const norm = normalizeWord(span.word);
    const hit = forms.get(norm);
    if (hit !== undefined) {
      out.push({ start: span.start, end: span.end, word: hit });
      continue;
    }
    const m = /^(.+?)'(?:s|d|ll|re|ve|m|t)?$/.exec(norm);
    if (m) {
      const stem = forms.get(m[1]!);
      if (stem !== undefined) out.push({ start: span.start, end: span.start + m[1]!.length, word: stem });
    }
  }
  return out;
}

/** Map of normalized form → word (first wins). */
export function formIndex(words: readonly EpubVocabWord[]): Map<string, EpubVocabWord> {
  const map = new Map<string, EpubVocabWord>();
  for (const w of words) {
    const key = normalizeWord(w.form.trim());
    if (key && !map.has(key)) map.set(key, w);
  }
  return map;
}

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'math', 'rt', 'rp', 'head', 'title']);

/** Every occurrence of the words in the section's body, as DOM ranges (at most `limit`). */
export function findVocabRanges(
  doc: Document,
  words: readonly EpubVocabWord[],
  limit = MAX_MARKS_PER_SECTION,
): { range: Range; word: EpubVocabWord }[] {
  const forms = formIndex(words);
  const out: { range: Range; word: EpubVocabWord }[] = [];
  const body = doc.body ?? doc.documentElement;
  if (!body || !forms.size) return out;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== body; el = el.parentElement) {
        if (SKIP.has(el.localName.toLowerCase())) return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue && /\S/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node && out.length < limit; node = walker.nextNode()) {
    for (const m of matchWords(node.nodeValue ?? '', forms, limit - out.length)) {
      const range = doc.createRange();
      range.setStart(node, m.start);
      range.setEnd(node, m.end);
      out.push({ range, word: m.word });
    }
  }
  return out;
}
