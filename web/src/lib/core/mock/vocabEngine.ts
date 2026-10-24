// The mock core's vocabulary engine (spec 12.3/12.4): a small TypeScript version of `core-vocab`, good enough for the
// e2e suite. Pure functions only; mock/vocab.ts keeps the state. Same rules as the Rust engine: cleanup, Unicode
// words, morphy with exceptions, proper nouns, the per-page table (F), comparison (G), forms and families (I),
// phrasal verbs (H), metrics restricted to a range, ranges (pages and outline) and the deck/tag naming (12.6).
import type {
  ResolvedRange,
  VocabChapter,
  VocabConfig,
  VocabDeckNaming,
  VocabLemmaRef,
  VocabMetrics,
  VocabOutlineItem,
  VocabOverride,
  VocabPos,
  VocabRangeSpec,
  VocabRow,
  VocabStatus,
  VocabStatusSource,
} from '../types';
import { DERIVATIONS, EXCEPTIONS, FUNCTION_WORDS, LEXICON, PARTICLES, PHRASAL_VERBS } from './vocabLexicon';

// ---------------------------------------------------------------- lemmatization (D)

type Rule = [suffix: string, replacement: string];

/** WordNet's morphy detachment rules, per part of speech. */
const RULES: Record<'n' | 'v' | 'a', Rule[]> = {
  n: [
    ['s', ''],
    ['ses', 's'],
    ['xes', 'x'],
    ['zes', 'z'],
    ['ches', 'ch'],
    ['shes', 'sh'],
    ['men', 'man'],
    ['ies', 'y'],
  ],
  v: [
    ['s', ''],
    ['ies', 'y'],
    ['es', 'e'],
    ['es', ''],
    ['ed', 'e'],
    ['ed', ''],
    ['ing', 'e'],
    ['ing', ''],
  ],
  a: [
    ['er', ''],
    ['est', ''],
    ['er', 'e'],
    ['est', 'e'],
  ],
};

/** Candidates of `form` by the rules of `pos` (doubled final consonants undone too: stopped → stop). */
function ruleCandidates(form: string, pos: 'n' | 'v' | 'a'): string[] {
  const out: string[] = [];
  for (const [suffix, rep] of RULES[pos]) {
    if (!form.endsWith(suffix) || form.length <= suffix.length + 1) continue;
    const stem = form.slice(0, -suffix.length);
    out.push(stem + rep);
    if (!rep && /([b-df-hj-np-tv-z])\1$/.test(stem)) out.push(stem.slice(0, -1));
  }
  return out;
}

export function lexHas(lemma: string, pos?: VocabPos): boolean {
  const e = LEXICON.get(lemma);
  return !!e && (pos === undefined || e.pos.includes(pos));
}

export function zipfOf(lemma: string): number | null {
  return LEXICON.get(lemma)?.zipf ?? null;
}

export function posOf(lemma: string): VocabPos | null {
  return LEXICON.get(lemma)?.pos[0] ?? null;
}

export function definitionOf(lemma: string): string | null {
  return LEXICON.get(lemma)?.definition ?? null;
}

/**
 * Lemma of a lowercase form (spec 12.3 D): the exception lists, else the morphy candidates that exist in the lexicon
 * or in the user's index; the one in the index wins, else the most frequent, else the form itself.
 */
export function lemmatize(form: string, inIndex: (w: string) => boolean = () => false): string {
  const w = form.toLowerCase();
  if (inIndex(w)) return w;
  const exc = EXCEPTIONS[w];
  if (exc) return exc;
  const candidates = new Set<string>();
  if (LEXICON.has(w)) candidates.add(w);
  for (const pos of ['n', 'v', 'a'] as const)
    for (const c of ruleCandidates(w, pos))
      // Index words the lexicon does not know count too; a lexicon word only with the rule's part of speech
      // (learner is not an inflection of learn).
      if (lexHas(c, pos) || (inIndex(c) && !LEXICON.has(c))) candidates.add(c);
  if (!candidates.size) return w;
  const list = [...candidates];
  const indexed = list.find((c) => c !== w && inIndex(c));
  if (indexed) return indexed;
  return list.sort((a, b) => (zipfOf(b) ?? 0) - (zipfOf(a) ?? 0))[0]!;
}

/**
 * Verb/adjective bases of an inflected form (learning → learn, interesting → interest, cleverest → clever): the lemmas
 * the form inflects, by the exception lists and the verb/adjective rules only.
 */
export function inflectionBases(form: string): string[] {
  const w = form.toLowerCase();
  const out = new Set<string>();
  const exc = EXCEPTIONS[w];
  if (exc && exc !== w) out.add(exc);
  for (const pos of ['v', 'a'] as const) for (const c of ruleCandidates(w, pos)) if (lexHas(c, pos)) out.add(c);
  out.delete(w);
  return [...out];
}

/** A form that is a noun or adjective lemma of its own (learning, meaning, building, interesting). */
export function ownNounOrAdjective(form: string): boolean {
  const e = LEXICON.get(form.toLowerCase());
  return !!e && (e.pos.includes('n') || e.pos.includes('a'));
}

// ---------------------------------------------------------------- known vocabulary (A)

/** Cleans a note field into the words it holds (spec 12.3 A). Multi-word entries stay as phrases. */
export function cleanField(html: string): string[] {
  const text = html
    .replace(/\[sound:[^\]]*\]/gi, ' ')
    .replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[’‘]/g, "'");
  return text
    .split(/[/,;]|\s+or\s+/i)
    .map((v) => v.replace(/\s+/g, ' ').trim().toLowerCase())
    .map((v) => v.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((v) => v && /\p{L}/u.test(v));
}

/** Anki-side status of a word, best first. */
export type DeckStatus = 'known' | 'learning' | 'new' | 'suspended';
export const DECK_RANK: Record<DeckStatus, number> = { known: 4, learning: 3, new: 2, suspended: 1 };

export function better(a: DeckStatus | undefined, b: DeckStatus): DeckStatus {
  return a && DECK_RANK[a] >= DECK_RANK[b] ? a : b;
}

/** The user's known vocabulary: lemma → best status, original entry → best status, phrases. */
export interface KnownIndex {
  lemmas: Map<string, DeckStatus>;
  forms: Map<string, DeckStatus>;
  phrases: Map<string, DeckStatus>;
}

export function emptyIndex(): KnownIndex {
  return { lemmas: new Map(), forms: new Map(), phrases: new Map() };
}

export function addToIndex(index: KnownIndex, entries: string[], status: DeckStatus): void {
  for (const entry of entries) {
    if (/\s/.test(entry)) {
      // A phrase: verbs inside phrasal verbs are lemmatized ("gave in" → "give in").
      const [verb, ...rest] = entry.split(' ');
      const key = [lemmatize(verb!), ...rest].join(' ');
      index.phrases.set(entry, better(index.phrases.get(entry), status));
      index.phrases.set(key, better(index.phrases.get(key), status));
      continue;
    }
    index.forms.set(entry, better(index.forms.get(entry), status));
    const lemma = lemmatize(entry);
    index.lemmas.set(lemma, better(index.lemmas.get(lemma), status));
  }
}

// ---------------------------------------------------------------- text (B, C) and the per-page table (F)

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' });
const CONTRACTION = /^(.+?)(?:n't|'s|'ll|'re|'ve|'d|'m)$/i;
const SPECIAL_NT: Record<string, string> = { "can't": 'can', "won't": 'will', "shan't": 'shall' };
const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|vs|etc)\.$/;

/** Unicode words of `text` (UAX #29), apostrophes normalized, contraction pieces dropped, words without letters out. */
export function words(text: string): { form: string; start: number; end: number }[] {
  const out: { form: string; start: number; end: number }[] = [];
  for (const seg of SEGMENTER.segment(text)) {
    if (!seg.isWordLike) continue;
    let form = seg.segment.replace(/[’‘]/g, "'");
    if (!/\p{L}/u.test(form)) continue;
    const special = SPECIAL_NT[form.toLowerCase()];
    if (special) form = form.slice(0, special.length);
    else {
      const m = CONTRACTION.exec(form);
      if (m && /\p{L}/u.test(m[1]!)) form = m[1]!;
    }
    out.push({ form, start: seg.index, end: seg.index + form.length });
  }
  return out;
}

/** Splits text into sentences (spec 12.3 C), keeping "Mr." and similar abbreviations inside. */
export function sentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  const re = /[.!?]+["”’')\]]*\s+(?=["“‘'(\[]*[\p{Lu}\p{N}])/gu;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].trimEnd().length;
    const piece = text.slice(start, end);
    if (ABBREVIATIONS.test(piece)) continue;
    if (piece.trim()) out.push({ text: piece.trim(), start: start + (piece.length - piece.trimStart().length) });
    start = m.index + m[0].length;
  }
  const rest = text.slice(start);
  if (rest.trim()) out.push({ text: rest.trim(), start: start + (rest.length - rest.trimStart().length) });
  return out;
}

/**
 * Cleans the pages' text (spec 12.3 B): repeated headers/footers (a page's first or last line seen on more than 30%
 * of the pages, digits normalized), page numbers, URLs, e-mails, and words hyphenated across lines.
 */
export function cleanPages(pages: string[]): string[] {
  const lineSets = pages.map((p) => p.split('\n'));
  const norm = (l: string) => l.trim().replace(/\d+/g, '#');
  const edges = new Map<string, number>();
  for (const lines of lineSets) {
    const nonEmpty = lines.filter((l) => l.trim());
    const seen = new Set([nonEmpty[0], nonEmpty[nonEmpty.length - 1]].filter((l): l is string => !!l).map(norm));
    for (const k of seen) edges.set(k, (edges.get(k) ?? 0) + 1);
  }
  // Like core_vocab (books of 5+ pages, lines up to 120 characters); the mock only looks at each page's first and
  // last line, because its books repeat whole paragraphs on every page.
  const repeated = new Set(
    [...edges].filter(([k, n]) => pages.length >= 5 && k.length <= 120 && n > pages.length * 0.3).map(([k]) => k),
  );
  return lineSets.map((lines) => {
    const nonEmpty = lines.filter((l) => l.trim());
    const first = nonEmpty[0];
    const last = nonEmpty[nonEmpty.length - 1];
    const kept = lines.filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if ((l === first || l === last) && repeated.has(norm(l))) return false;
      return !/^\d+$/.test(t);
    });
    let text = '';
    for (const l of kept) {
      const t = l.trim();
      if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(t)) text = text.slice(0, -1) + t;
      else text += (text ? ' ' : '') + t;
    }
    return text
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ')
      .replace(/ {2,}/g, ' ');
  });
}

/** One form (lowercase) on one page of the table. */
export interface TableForm {
  count: number;
  /** Original spellings and their counts. */
  spellings: Record<string, number>;
  /** Occurrences with a capital letter not at a sentence start / all lowercase. */
  capNonInitial: number;
  lower: number;
  example: string | null;
  span: [number, number] | null;
  /** Index of the first occurrence among the page's words. */
  position: number;
}

/** Verb + particle pairs on a page ("gave in"). */
export interface TablePair {
  verb: string;
  particle: string;
  count: number;
  example: string;
  span: [number, number];
  position: number;
}

export interface TablePage {
  forms: Record<string, TableForm>;
  pairs: Record<string, TablePair>;
}

/** The per-page table of a book version (spec 12.3 F, `book_lemma_page`), independent of the user's decks. */
export interface BookTable {
  textVersion: string;
  pages: TablePage[];
}

function sentenceWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Builds the table from the pages' raw text. */
export function buildTable(rawPages: string[], textVersion: string): BookTable {
  const cleaned = cleanPages(rawPages);
  const pages: TablePage[] = cleaned.map((text) => {
    const forms: Record<string, TableForm> = {};
    const pairs: Record<string, TablePair> = {};
    let position = 0;
    for (const sentence of sentences(text)) {
      const ws = words(sentence.text);
      const good = sentenceWords(sentence.text) >= 8 && sentenceWords(sentence.text) <= 30;
      ws.forEach((w, i) => {
        const key = w.form.toLowerCase();
        const f = (forms[key] ??= {
          count: 0,
          spellings: {},
          capNonInitial: 0,
          lower: 0,
          example: null,
          span: null,
          position: position + i,
        });
        f.count++;
        f.spellings[w.form] = (f.spellings[w.form] ?? 0) + 1;
        if (w.form === key) f.lower++;
        else if (i > 0 && /^\p{Lu}/u.test(w.form)) f.capNonInitial++;
        if (good && f.example === null) {
          f.example = sentence.text;
          f.span = [w.start, w.end];
        }
        const next = ws[i + 1];
        if (next && PARTICLES.has(next.form.toLowerCase())) {
          const pk = `${key} ${next.form.toLowerCase()}`;
          const p = (pairs[pk] ??= {
            verb: key,
            particle: next.form.toLowerCase(),
            count: 0,
            example: sentence.text,
            span: [w.start, next.end],
            position: position + i,
          });
          p.count++;
        }
      });
      position += ws.length;
      // Sentences outside 8–30 words still give an example when there is no better one on the page.
      if (!good)
        for (const w of ws) {
          const f = forms[w.form.toLowerCase()]!;
          if (f.example === null) {
            f.example = sentence.text.length > 240 ? `${sentence.text.slice(0, 239)}…` : sentence.text;
            f.span = w.end <= f.example.length ? [w.start, w.end] : null;
          }
        }
    }
    return { forms, pairs };
  });
  return { textVersion, pages };
}

// ---------------------------------------------------------------- ranges (spec 12.1 step 2)
// Same rules, messages and names as `core_vocab::ranges` and `core_vocab::naming`.

export const MAX_RANGE_ITEMS = 100;
const LABEL_MAX_CHARS = 60;
const SLUG_MAX = 40;

/** pt-BR messages of `core_vocab::RangeError` (copied; shown under the field). */
export const RANGE_MESSAGES = {
  empty: () => 'Digite uma página, um intervalo ou uma lista, como 37, 21-45 ou 21-45, 60, 72-80.',
  notANumber: (part: string) => `“${part}” não é uma página válida. Use números, como 37, 21-45 ou 21-45, 60, 72-80.`,
  zero: () => 'As páginas começam em 1.',
  reversed: (from: number, to: number) => `O intervalo ${from}-${to} está invertido. Use ${to}-${from}.`,
  openEnded: (part: string) => `O intervalo “${part}” está incompleto. Informe o início e o fim, como 21-45.`,
  beyondEnd: (page: number, count: number) =>
    `A página ${page} não existe (o livro tem ${count} ${count === 1 ? 'página' : 'páginas'}).`,
  tooMany: (n: number) => `Use no máximo ${n} páginas ou intervalos.`,
  emptyBook: () => 'O livro não tem páginas.',
  noItems: () => 'Marque pelo menos um item do sumário.',
  unknownItem: () => 'Um item marcado não existe mais no sumário. Volte e marque de novo.',
  itemWithoutPage: (title: string) => `“${title}” não aponta para uma página do livro.`,
};

/**
 * What the numbers of a range count: PDF pages, or EPUB chapters (spine sections, 1-based in the UI, spec 12 for
 * EPUB). Same messages as `core_vocab::RangeError` with the chapter wording.
 */
export type RangeUnit = 'page' | 'chapter';

export const CHAPTER_RANGE_MESSAGES: typeof RANGE_MESSAGES = {
  empty: () => 'Digite um capítulo, um intervalo ou uma lista, como 3, 2-4 ou 2-4, 7.',
  notANumber: (part: string) => `“${part}” não é um capítulo válido. Use números, como 3, 2-4 ou 2-4, 7.`,
  zero: () => 'Os capítulos começam em 1.',
  reversed: RANGE_MESSAGES.reversed,
  openEnded: (part: string) => `O intervalo “${part}” está incompleto. Informe o início e o fim, como 2-4.`,
  beyondEnd: (n: number, count: number) =>
    `O capítulo ${n} não existe (o livro tem ${count} ${count === 1 ? 'capítulo' : 'capítulos'}).`,
  tooMany: (n: number) => `Use no máximo ${n} capítulos ou intervalos.`,
  emptyBook: () => 'O livro não tem capítulos.',
  noItems: RANGE_MESSAGES.noItems,
  unknownItem: RANGE_MESSAGES.unknownItem,
  itemWithoutPage: (title: string) => `“${title}” não aponta para um capítulo do livro.`,
};

function messagesFor(unit: RangeUnit): typeof RANGE_MESSAGES {
  return unit === 'chapter' ? CHAPTER_RANGE_MESSAGES : RANGE_MESSAGES;
}

/** The short prefix of a unit: `p.` or `cap.`. */
export function unitPrefix(unit: RangeUnit): string {
  return unit === 'chapter' ? 'cap.' : 'p.';
}

export class VocabRangeError extends Error {
  readonly code = 'vocab_range_invalid';
}

/** Sorted, merged 0-based inclusive intervals. */
export function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function parsePage(s: string, M: typeof RANGE_MESSAGES): number {
  const t = s.trim();
  if (!t || !/^\d+$/.test(t)) throw new VocabRangeError(M.notANumber(t));
  const n = Number(t);
  if (n > 0xffff_ffff) throw new VocabRangeError(M.notANumber(t));
  if (n === 0) throw new VocabRangeError(M.zero());
  return n;
}

/**
 * Parses `37`, `21-45`, `21-45, 60, 72-80` (1-based, inclusive) into merged 0-based intervals; `unit` 'chapter' for an
 * EPUB's chapters (same syntax, chapter wording in the messages).
 */
export function parsePages(text: string, pageCount: number, unit: RangeUnit = 'page'): [number, number][] {
  const RANGE_MESSAGES = messagesFor(unit);
  if (pageCount <= 0) throw new VocabRangeError(RANGE_MESSAGES.emptyBook());
  const norm = text.replace(/[–—−‐‑]/g, '-').replace(/;/g, ',');
  const items = norm
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!items.length) throw new VocabRangeError(RANGE_MESSAGES.empty());
  if (items.length > MAX_RANGE_ITEMS) throw new VocabRangeError(RANGE_MESSAGES.tooMany(MAX_RANGE_ITEMS));
  const out: [number, number][] = [];
  for (const item of items) {
    let a: number;
    let b: number;
    const dash = item.indexOf('-');
    if (dash < 0) a = b = parsePage(item, RANGE_MESSAGES);
    else {
      const left = item.slice(0, dash);
      const right = item.slice(dash + 1);
      if (!left.trim() || !right.trim()) {
        if (right.includes('-')) throw new VocabRangeError(RANGE_MESSAGES.notANumber(item));
        throw new VocabRangeError(RANGE_MESSAGES.openEnded(item));
      }
      if (right.includes('-')) throw new VocabRangeError(RANGE_MESSAGES.notANumber(item));
      a = parsePage(left, RANGE_MESSAGES);
      b = parsePage(right, RANGE_MESSAGES);
      if (a > b) throw new VocabRangeError(RANGE_MESSAGES.reversed(a, b));
    }
    for (const p of [a, b]) if (p > pageCount) throw new VocabRangeError(RANGE_MESSAGES.beyondEnd(p, pageCount));
    out.push([a - 1, b - 1]);
  }
  return mergeIntervals(out);
}

function pagesWith(pages: [number, number][], dash: string): string {
  return pages.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}${dash}${b + 1}`)).join(', ');
}

/** `21-45, 60, 72-80` (hyphens, for deck names and tags). */
export function pagesText(pages: [number, number][]): string {
  return pagesWith(pages, '-');
}

/** `p. 21–45, 60, 72–80` (en dashes, for people); `cap. 2–4` for chapters. */
export function pagesDisplay(pages: [number, number][], unit: RangeUnit = 'page'): string {
  return `${unitPrefix(unit)} ${pagesWith(pages, '–')}`;
}

export function pageCountOf(pages: [number, number][]): number {
  return pages.reduce((n, [a, b]) => n + b - a + 1, 0);
}

/** A tag slug: lowercase, accents folded, anything else a single `-`, at most 40 characters (`cap-3`, `p-21-45`). */
export function slugify(s: string): string {
  const folded = s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  let out = '';
  for (const c of folded) {
    if (/[a-z0-9]/.test(c)) out += c;
    else if (out && !out.endsWith('-')) out += '-';
  }
  return out.slice(0, SLUG_MAX).replace(/-+$/, '');
}

function slugOr(s: string, fallback: string): string {
  return slugify(s) || fallback;
}

/** A raw outline item (title + 0-based page, `null` without destination). */
export interface RawOutlineItem {
  title: string;
  page?: number | null;
  children?: RawOutlineItem[];
}

function cleanTitle(t: string): string {
  const s = t
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  return s || '(sem título)';
}

interface FlatItem {
  id: string;
  depth: number;
  node: RawOutlineItem;
}

function flattenOutline(nodes: RawOutlineItem[], prefix = '', depth = 0, out: FlatItem[] = []): FlatItem[] {
  nodes.forEach((n, i) => {
    const id = prefix ? `${prefix}.${i}` : `${i}`;
    out.push({ id, depth, node: n });
    if (depth < 64) flattenOutline(n.children ?? [], id, depth + 1, out);
  });
  return out;
}

/**
 * Each item goes from its page to the page before the first following item of the same level or above whose page is
 * after it; the last one goes to the end of the book. Only the very next such item ends it on its own page; later
 * items with the same or an earlier page are skipped (PdfCraft appends new bookmarks at the end of the root level).
 */
function flatRanges(flat: FlatItem[], pageCount: number): ([number, number] | null)[] {
  const last = pageCount - 1;
  return flat.map((f, i) => {
    const start = f.node.page;
    if (start === undefined || start === null || pageCount <= 0 || start > last || start < 0) return null;
    let end = last;
    let first = true;
    for (const g of flat.slice(i + 1)) {
      if (g.depth > f.depth) continue;
      const p = g.node.page;
      if (p !== undefined && p !== null) {
        if (p > start && p <= last) {
          end = p - 1;
          break;
        }
        if (p === start && first) {
          end = start;
          break;
        }
      }
      first = false;
    }
    return [start, end];
  });
}

/** The outline with ids (`0`, `1.0`…) and each item's range (spec 12.1 step 2). */
export function outlineWithRanges(items: RawOutlineItem[], pageCount: number): VocabOutlineItem[] {
  const flat = flattenOutline(items);
  const ranges = flatRanges(flat, pageCount);
  let at = 0;
  const build = (depth: number): VocabOutlineItem[] => {
    const out: VocabOutlineItem[] = [];
    while (at < flat.length && flat[at]!.depth >= depth) {
      const f = flat[at]!;
      const r = ranges[at]!;
      at++;
      const page = f.node.page ?? null;
      out.push({
        id: f.id,
        title: cleanTitle(f.node.title),
        page,
        startPage: r?.[0] ?? null,
        endPage: r?.[1] ?? null,
        children: build(f.depth + 1),
      });
    }
    return out;
  };
  return build(0);
}

function cut(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

function subdeckOf(label: string): string {
  return label.replace(/::/g, ':').trim();
}

/** Resolves a range against the book (spec 12.1 step 2, 12.6 naming), like `core_vocab::resolve_range`. */
export function resolveRange(
  spec: VocabRangeSpec,
  outline: RawOutlineItem[],
  pageCount: number,
  unit: RangeUnit = 'page',
): ResolvedRange {
  const RANGE_MESSAGES = messagesFor(unit);
  if (pageCount <= 0) throw new VocabRangeError(RANGE_MESSAGES.emptyBook());
  if (spec.kind === 'all') {
    return {
      kind: 'all',
      pages: [[0, pageCount - 1]],
      label: null,
      display: 'Livro inteiro',
      slug: null,
      subdeck: null,
      items: [],
      text: null,
    };
  }
  if (spec.kind === 'pages') {
    const pages = parsePages(spec.text, pageCount, unit);
    const norm = pagesText(pages);
    const label = `${unitPrefix(unit)} ${norm}`;
    return {
      kind: 'pages',
      pages,
      label,
      display: pagesDisplay(pages, unit),
      slug: slugify(label),
      subdeck: subdeckOf(label),
      items: [],
      text: norm,
    };
  }
  if (!spec.ids.length) throw new VocabRangeError(RANGE_MESSAGES.noItems());
  if (spec.ids.length > MAX_RANGE_ITEMS * 10) throw new VocabRangeError(RANGE_MESSAGES.tooMany(MAX_RANGE_ITEMS * 10));
  const flat = flattenOutline(outline);
  const ranges = flatRanges(flat, pageCount);
  const chosen: number[] = [];
  for (const id of spec.ids) {
    const i = flat.findIndex((f) => f.id === id);
    if (i < 0) throw new VocabRangeError(RANGE_MESSAGES.unknownItem());
    if (!ranges[i]) throw new VocabRangeError(RANGE_MESSAGES.itemWithoutPage(cleanTitle(flat[i]!.node.title)));
    if (!chosen.includes(i)) chosen.push(i);
  }
  chosen.sort((a, b) => a - b);
  const pages = mergeIntervals(chosen.map((i) => [...ranges[i]!] as [number, number]));
  // Titles of the selected items whose ancestors are not selected (children are inside them).
  const titles = chosen
    .filter((i) => {
      const id = flat[i]!.id;
      return !chosen.some((j) => flat[j]!.id !== id && id.startsWith(`${flat[j]!.id}.`));
    })
    .map((i) => cleanTitle(flat[i]!.node.title));
  const label = cut(titles.join(' + '), LABEL_MAX_CHARS);
  return {
    kind: 'outline',
    pages,
    label,
    display: `${label} (${pagesDisplay(pages, unit)})`,
    slug: slugify(label),
    subdeck: subdeckOf(label),
    items: chosen.map((i) => flat[i]!.id),
    text: null,
  };
}

export function inRange(pages: [number, number][], page: number): boolean {
  return pages.some(([a, b]) => page >= a && page <= b);
}

/** `Cap 03` (per-chapter subdecks; `n` is the 1-based chapter index). */
export function chapterDeckName(n: number): string {
  return `Cap ${String(n).padStart(2, '0')}`;
}

/** `cap::03`. */
export function chapterTag(n: number): string {
  return `cap::${String(n).padStart(2, '0')}`;
}

function deckPart(s: string): string {
  return s
    .replace(/::/g, ':')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(/^:+|:+$/g, '')
    .trim();
}

/** `<pasta>::Livros::<Título>`, the range subdeck and the tags (spec 12.6, `core_vocab::vocab_deck_names`). */
export function deckNaming(rootName: string | null, title: string, range: ResolvedRange): VocabDeckNaming {
  const bookTitle = deckPart(title) || 'Sem título';
  const root = rootName?.trim();
  const baseName = root ? `${root}::Livros::${bookTitle}` : `Livros::${bookTitle}`;
  const sub = range.subdeck ? deckPart(range.subdeck) : '';
  const tagSource = range.slug ?? range.label;
  return {
    baseName,
    subdeck: sub || null,
    fullName: sub ? `${baseName}::${sub}` : baseName,
    rangeTag: tagSource ? `trecho::${slugOr(tagSource, 'trecho')}` : null,
    bookTag: `livro::${slugOr(title, 'sem-titulo')}`,
  };
}

/** A chapter's place in the book (`core_vocab::Chapter`). */
export type ChapterRange = Pick<VocabChapter, 'index' | 'label' | 'startPage' | 'endPage'>;

/**
 * Chapters (spec 12.4): the outline's top-level items with a page (1-based index), in document order, each one after
 * the previous chapter (user bookmarks appended at the end of the root level are skipped); else blocks of 20 pages.
 */
export function bookChapters(outline: RawOutlineItem[], pageCount: number, unit: RangeUnit = 'page'): ChapterRange[] {
  if (pageCount <= 0) return [];
  const last = pageCount - 1;
  const tops: { title: string; page: number }[] = [];
  for (const n of outline) {
    if (n.page === undefined || n.page === null || n.page < 0 || n.page > last) continue;
    const prev = tops[tops.length - 1];
    if (!prev || n.page > prev.page) tops.push({ title: cleanTitle(n.title), page: n.page });
  }
  if (!tops.length) {
    const out: ChapterRange[] = [];
    for (let start = 0, index = 1; start <= last; start += 20, index++) {
      const end = Math.min(last, start + 19);
      out.push({ index, label: `${unitPrefix(unit)} ${start + 1}–${end + 1}`, startPage: start, endPage: end });
    }
    return out;
  }
  return tops.map((t, i) => ({
    index: i + 1,
    label: t.title,
    startPage: t.page,
    endPage: i + 1 < tops.length ? tops[i + 1]!.page - 1 : last,
  }));
}

// ---------------------------------------------------------------- comparison (G, I, H) and metrics (12.4)
// Same semantics as `core_vocab::compare`.

export interface CompareInput {
  table: BookTable;
  range: ResolvedRange;
  index: KnownIndex;
  overrides: Record<string, VocabOverride>;
  config: VocabConfig;
  chapters: ChapterRange[];
  /** Lemma → note id of notes made by earlier scans of this book. */
  bookNotes: Map<string, number>;
}

export interface CompareOutput {
  rows: VocabRow[];
  metrics: VocabMetrics;
  chapters: VocabChapter[];
  /** Lowercase form → row lemma (for the reading marks). */
  formToLemma: Record<string, string>;
}

const RARE_ZIPF = 2.5;
const CURVE_POINTS = 200;

const countsAsKnown = (s: VocabStatus) => s === 'known';
const countsAsLearning = (s: VocabStatus) => s === 'learning' || s === 'new';
const countsAsUnknown = (s: VocabStatus) => s === 'unknown' || s === 'suspended';
const inMetrics = (r: Pick<VocabRow, 'group' | 'status'>) =>
  (r.group === 'main' || r.group === 'forms') && r.status !== 'ignored' && r.status !== 'proper';

function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

interface Acc {
  lemma: string;
  group: VocabRow['group'];
  base: string | null;
  spellings: Map<string, number>;
  occurrences: number;
  pages: Set<number>;
  first: { page: number; position: number; example: string | null; span: [number, number] | null };
  perPage: Map<number, number>;
  formsSeen: Set<string>;
}

function topSpelling(m: Map<string, number>): string {
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

/** The comparison of spec 12.3 G with the forms/families rules of I, the phrasal verbs of H and the metrics of 12.4. */
export function compare(input: CompareInput): CompareOutput {
  const { table, range, index, overrides, config, chapters, bookNotes } = input;
  const inIndex = (w: string) => index.lemmas.has(w) || index.forms.has(w);
  const deckStatusOf = (w: string): DeckStatus | undefined => {
    const st = index.lemmas.get(w) ?? index.forms.get(w);
    if (st === 'suspended' && config.suspendedPolicy === 'known') return 'known';
    if (st === 'learning' && config.countYoung) return 'known';
    return st;
  };
  const isKnownLemma = (w: string) => deckStatusOf(w) === 'known';

  // Book-level spelling statistics: proper nouns are decided on the whole book (spec 12.3 E).
  const book = new Map<string, { count: number; lower: number; capNonInitial: number }>();
  for (const page of table.pages)
    for (const [k, f] of Object.entries(page.forms)) {
      const b = book.get(k) ?? { count: 0, lower: 0, capNonInitial: 0 };
      b.count += f.count;
      b.lower += f.lower;
      b.capNonInitial += f.capNonInitial;
      book.set(k, b);
    }
  const isProper = (form: string) => {
    const b = book.get(form);
    if (!b || b.capNonInitial === 0 || b.lower >= b.count * 0.1) return false;
    if (FUNCTION_WORDS.has(form)) return false;
    const z = zipfOf(form);
    return z === null || z < 4.5;
  };

  const resolve = (form: string): { lemma: string; group: VocabRow['group']; base: string | null } => {
    if (isProper(form)) return { lemma: form, group: 'proper', base: null };
    const lemma = lemmatize(form, inIndex);
    // I: an inflection of a known lemma that is also a noun/adjective lemma of its own goes to "forms".
    if (lemma !== form && isKnownLemma(lemma) && ownNounOrAdjective(form) && !inIndex(form)) {
      return { lemma: form, group: 'forms', base: lemma };
    }
    if (!inIndex(lemma) && ownNounOrAdjective(lemma)) {
      const base = inflectionBases(lemma).find(isKnownLemma);
      if (base) return { lemma, group: 'forms', base };
    }
    return { lemma, group: 'main', base: null };
  };

  const accs = new Map<string, Acc>();
  const formToLemma: Record<string, string> = {};
  const add = (
    key: string,
    group: VocabRow['group'],
    base: string | null,
    page: number,
    count: number,
    spellings: Record<string, number>,
    first: Acc['first'],
    form: string,
  ) => {
    let acc = accs.get(key);
    if (!acc) {
      acc = {
        lemma: key,
        group,
        base,
        spellings: new Map(),
        occurrences: 0,
        pages: new Set(),
        first,
        perPage: new Map(),
        formsSeen: new Set(),
      };
      accs.set(key, acc);
    }
    acc.occurrences += count;
    acc.pages.add(page);
    acc.perPage.set(page, (acc.perPage.get(page) ?? 0) + count);
    acc.formsSeen.add(form);
    for (const [sp, n] of Object.entries(spellings)) acc.spellings.set(sp, (acc.spellings.get(sp) ?? 0) + n);
    if (first.page < acc.first.page || (first.page === acc.first.page && first.position < acc.first.position)) {
      acc.first = first;
    }
  };

  for (let p = 0; p < table.pages.length; p++) {
    if (!inRange(range.pages, p)) continue;
    const page = table.pages[p]!;
    for (const [form, f] of Object.entries(page.forms)) {
      const r = resolve(form);
      formToLemma[form] = r.lemma;
      add(
        r.lemma,
        r.group,
        r.base,
        p,
        f.count,
        f.spellings,
        {
          page: p,
          position: f.position,
          example: f.example,
          span: f.span,
        },
        form,
      );
    }
    // H: phrasal verbs (verb + particle) of the lexicon, compared with the phrases of the decks.
    for (const pair of Object.values(page.pairs)) {
      const key = `${lemmatize(pair.verb, inIndex)} ${pair.particle}`;
      if (!PHRASAL_VERBS.has(key)) continue;
      const spelled = pair.example.slice(pair.span[0], pair.span[1]);
      add(
        key,
        'phrasal',
        null,
        p,
        pair.count,
        { [spelled]: pair.count },
        {
          page: p,
          position: pair.position,
          example: pair.example,
          span: pair.span,
        },
        key,
      );
    }
  }

  const chapterOf = (page: number) => chapters.find((c) => page >= c.startPage && page <= c.endPage)?.index ?? null;
  const chapterTokens = new Map<number, [number, number, number]>();
  const rows: VocabRow[] = [];
  for (const acc of accs.values()) {
    const key = acc.lemma;
    const override = overrides[key];
    let status: VocabStatus;
    let source: VocabStatusSource | null = null;
    let family: VocabLemmaRef | null = null;
    let group = acc.group;
    if (override) {
      status = override;
      source = 'override';
      if (override === 'proper' && group === 'main') group = 'proper';
    } else if (group === 'proper') {
      status = 'proper';
    } else if (group === 'forms') {
      status = 'known';
      source = 'form';
    } else if (group === 'phrasal') {
      const deck = index.phrases.get(key);
      status = deck ?? 'unknown';
      source = deck ? 'deck' : null;
    } else {
      const own = deckStatusOf(key);
      const viaForm = own ? undefined : [...acc.formsSeen].map(deckStatusOf).find((x) => x !== undefined);
      const deck = own ?? viaForm;
      if (deck) {
        status = deck;
        source = own ? 'deck' : 'form';
      } else if (FUNCTION_WORDS.has(key) && config.functionWordsKnown) {
        status = 'known';
        source = 'function';
      } else {
        status = 'unknown';
      }
      const fam = DERIVATIONS[key];
      if (status === 'unknown' && fam && isKnownLemma(fam)) {
        family = { lemma: fam, status: 'known' };
        if (config.derivedPolicy === 'known') {
          status = 'known';
          source = 'family';
        }
      }
    }
    const zipf = group === 'proper' || key.includes(' ') ? null : zipfOf(key);
    const existing = bookNotes.get(key) ?? null;
    const row: VocabRow = {
      lemma: key,
      form: topSpelling(acc.spellings) || key,
      pos: group === 'phrasal' ? 'v' : posOf(key),
      group,
      status,
      statusSource: source,
      occurrences: acc.occurrences,
      firstPage: acc.first.page,
      pages: [...acc.pages].sort((a, b) => a - b),
      zipf,
      rare: zipf === null || zipf < RARE_ZIPF,
      example: acc.first.example,
      exampleSpan: acc.first.span,
      examplePage: acc.first.example !== null ? acc.first.page : null,
      base: acc.base && group === 'forms' ? { lemma: acc.base, status: 'known' } : null,
      family,
      existingNoteId: existing,
      defaultSelected: status === 'unknown' && group === 'main' && existing === null,
      chapter: chapterOf(acc.first.page),
      position: acc.first.position,
    };
    if (inMetrics(row)) {
      for (const [unit, n] of acc.perPage) {
        const ch = chapterOf(unit);
        if (ch === null) continue;
        const e = chapterTokens.get(ch) ?? [0, 0, 0];
        e[0] += n;
        if (countsAsKnown(row.status)) e[1] += n;
        else if (countsAsLearning(row.status)) e[2] += n;
        chapterTokens.set(ch, e);
      }
    }
    rows.push(row);
  }
  rows.sort(byReadingOrder);

  // Metrics of the range.
  let total = 0;
  let known = 0;
  let learning = 0;
  let properLemmas = 0;
  let formsLemmas = 0;
  const unknownOcc: number[] = [];
  for (const r of rows) {
    if (r.group === 'proper') properLemmas++;
    else if (r.group === 'forms') formsLemmas++;
    if (!inMetrics(r)) continue;
    total += r.occurrences;
    if (countsAsKnown(r.status)) known += r.occurrences;
    else if (countsAsLearning(r.status)) learning += r.occurrences;
    else if (countsAsUnknown(r.status) && r.group === 'main') unknownOcc.push(r.occurrences);
  }
  unknownOcc.sort((a, b) => b - a);
  let cum = known + learning;
  const coverages = [ratio(cum, total)];
  for (const n of unknownOcc) {
    cum += n;
    coverages.push(ratio(cum, total));
  }
  const wordsTo = (target: number) => {
    if (total === 0) return 0;
    const i = coverages.findIndex((c) => c + 1e-12 >= target);
    return i >= 0 ? i : coverages.length - 1;
  };
  const step = Math.max(1, Math.ceil(coverages.length / CURVE_POINTS));
  const metrics: VocabMetrics = {
    totalTokens: total,
    knownTokens: known,
    learningTokens: learning,
    coverageKnown: ratio(known, total),
    coverageWithLearning: ratio(known + learning, total),
    unknownLemmas: unknownOcc.length,
    unknownLemmasRepeated: unknownOcc.filter((n) => n >= 2).length,
    wordsTo95: wordsTo(0.95),
    wordsTo98: wordsTo(0.98),
    curve:
      total === 0
        ? []
        : coverages
            .map((coverage, n) => ({ n, coverage }))
            .filter((_, i) => i % step === 0 || i === coverages.length - 1),
    properLemmas,
    formsLemmas,
  };

  const chapterOut: VocabChapter[] = chapters
    .filter((c) => range.pages.some(([a, b]) => c.startPage <= b && a <= c.endPage))
    .map((c) => {
      const [t, k, l] = chapterTokens.get(c.index) ?? [0, 0, 0];
      return {
        ...c,
        totalTokens: t,
        knownTokens: k,
        coverageKnown: ratio(k, t),
        coverageWithLearning: ratio(k + l, t),
      };
    });

  return { rows, metrics, chapters: chapterOut, formToLemma };
}

/** Reading order: first page, then the position on the page (`RowOrder::Reading`). */
export function byReadingOrder(a: VocabRow, b: VocabRow): number {
  return a.firstPage - b.firstPage || a.position - b.position || (a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0);
}

/** Frequency order (`RowOrder::Frequency`), also the order of the coverage curve and of "Selecionar as N para 98%". */
export function byCurveOrder(a: VocabRow, b: VocabRow): number {
  return (
    b.occurrences - a.occurrences ||
    a.firstPage - b.firstPage ||
    a.position - b.position ||
    (a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0)
  );
}
