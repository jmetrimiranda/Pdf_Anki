// Text helpers of the card form (spec 10.2): PDF selections come with line breaks, hyphenation and odd spacing.
import type { PageWords, Rect } from '../../lib/core/types';
import { escapeHtml } from './fonte';

/** Prose: joins words hyphenated across lines ("wind-\nmill" → "windmill") and collapses whitespace to spaces. */
export function proseText(raw: string): string {
  return raw
    .replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Code: keeps the line breaks (normalized to \n), drops trailing spaces and blank lines at the edges. */
export function codeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Plain text typed in the form → field HTML (escaped, line breaks as <br>). */
export function proseToHtml(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}

const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const WORD = /^[\p{L}\p{M}\p{N}]+(?:['’‐‑-][\p{L}\p{M}\p{N}]+)*$/u;
/** Longest "word" accepted for Vocabulário and Definir palavra (core-vocab `MAX_WORD_CHARS`). */
export const MAX_WORD = 64;

/**
 * The selection as one word (anything but letters and digits trimmed from the edges), or null when it is not a
 * single word with at least one letter ("don't", "well-known" and "Napoleon's" are words; "1984" is not). Mirrors
 * core-vocab `single_word`.
 */
export function singleWord(text: string): string | null {
  const w = text.replace(EDGES, '');
  if (!w || Array.from(w).length > MAX_WORD || !/\p{L}/u.test(w) || !WORD.test(w)) return null;
  return w;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)/gu;
/** Longest example sentence (characters); longer ones are cut around the word. */
export const MAX_EXAMPLE = 320;

/**
 * The sentence around `word` on the page (plain text, whitespace collapsed). The occurrence is the page word
 * overlapping the selection rects (else the first one with the same text); null when the word is not on the page.
 */
export function exampleText(page: PageWords | null, word: string, selection: readonly Rect[]): string | null {
  if (!page || !page.words.length) return null;
  const same = (t: string) => t.replace(EDGES, '').toLowerCase() === word.toLowerCase();
  const candidates = page.words.filter((w) => same(w.text));
  const hit =
    candidates.find((w) => w.rects.some((r) => selection.some((s) => overlaps(r, s)))) ?? candidates[0] ?? null;
  if (!hit) return null;
  const text = page.text;
  // Word bounds without its punctuation.
  const raw = text.slice(hit.start, hit.end);
  const lead = raw.length - raw.replace(/^[^\p{L}]+/u, '').length;
  const trail = raw.length - raw.replace(/[^\p{L}]+$/u, '').length;
  const ws = hit.start + lead;
  const we = hit.end - trail;
  if (we <= ws) return null;

  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(SENTENCE_END)) {
    const after = (m.index ?? 0) + m[0].length;
    if (after <= ws) start = after;
    else if ((m.index ?? 0) >= we) {
      end = after;
      break;
    }
  }
  let before = text.slice(start, ws).replace(/\s+/g, ' ').trimStart();
  let after = text.slice(we, end).replace(/\s+/g, ' ').trimEnd();
  // Very long "sentences" (no punctuation on the page): keep a window around the word.
  const room = Math.max(0, MAX_EXAMPLE - (we - ws));
  if (before.length + after.length > room) {
    const half = Math.floor(room / 2);
    const keepBefore = Math.min(before.length, Math.max(half, room - after.length));
    const keepAfter = Math.min(after.length, room - keepBefore);
    before = cutStart(before, keepBefore);
    after = cutEnd(after, keepAfter);
  }
  return `${before}${text.slice(ws, we)}${after}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Example text → field HTML: escaped, with the first whole-word occurrence of `word` in <b>. */
export function exampleHtml(text: string, word: string): string {
  const w = word.trim();
  if (!w) return escapeHtml(text);
  const re = new RegExp(`(^|[^\\p{L}])(${escapeRegExp(w)})(?![\\p{L}])`, 'iu');
  const m = re.exec(text);
  if (!m) return escapeHtml(text);
  const at = m.index + m[1]!.length;
  const hit = m[2]!;
  return `${escapeHtml(text.slice(0, at))}<b>${escapeHtml(hit)}</b>${escapeHtml(text.slice(at + hit.length))}`;
}

/** The sentence around `word` as field HTML with the word in <b>; falls back to `<b>word</b>`. */
export function exampleSentence(page: PageWords | null, word: string, selection: readonly Rect[]): string {
  return exampleHtml(exampleText(page, word, selection) ?? word, word);
}

function cutStart(s: string, keep: number): string {
  if (s.length <= keep) return s;
  const tail = s.slice(s.length - keep);
  const sp = tail.indexOf(' ');
  return `…${sp >= 0 ? tail.slice(sp + 1) : tail}`;
}

function cutEnd(s: string, keep: number): string {
  if (s.length <= keep) return s;
  const head = s.slice(0, keep);
  const sp = head.lastIndexOf(' ');
  return `${sp > 0 ? head.slice(0, sp) : head}…`;
}

/** One line of preview text: whitespace collapsed, cut to `max` characters with an ellipsis. */
export function previewLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length <= max
    ? s
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}
