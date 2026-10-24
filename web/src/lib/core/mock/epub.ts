// Mock of the EPUB side of the core (spec 7.1, 14, 15): the sample book "The Time Machine" (lib/epub/build.ts) and
// imported `.epub` files, their per-section text (`book_text`) and table of contents, the annotations
// (`epub_annotation_list/upsert/delete`, tombstones, persisted in sessionStorage 'leitor.mock.epub' like the rest of
// the mock) and the vocabulary marks of sections (`vocab_epub_marks`). Same rules as `app/src/epub.rs`.
import {
  buildEpub,
  SAMPLE_EPUB_AUTHOR,
  SAMPLE_EPUB_CHAPTERS,
  SAMPLE_EPUB_TITLE,
  sampleEpub,
  type EpubChapterSpec,
} from '../../epub/build';
import {
  CoreError,
  type CoreClient,
  type EpubAnnotation,
  type EpubAnnotationInput,
  type EpubAnnotationKind,
} from '../types';
import { later } from './ankiData';
import type { RawOutlineItem } from './vocabEngine';

// ---------------------------------------------------------------- books

/** Which EPUB a mock book is: the sample, or a small generated one for an imported path. */
export type EpubVariant = 'sample' | 'generic';

export interface EpubSection {
  /** 0-based spine index. */
  section: number;
  title: string;
  /** 0 = top level of the TOC. */
  depth: number;
  /** Plain text (paragraphs separated by blank lines), like `book_text`. */
  text: string;
}

const GENERIC_CHAPTERS: readonly { title: string; paragraphs: string[] }[] = [
  {
    title: 'Chapter 1. A New Habit',
    paragraphs: [
      'Reading a little every day builds a large vocabulary over time. New words become familiar when they appear again and again.',
      'A notebook by the bed keeps the strange words of the evening, and the morning review turns them into friends.',
    ],
  },
  {
    title: 'Chapter 2. The Routine',
    paragraphs: [
      'A good study routine mixes reading, reviewing and writing. Short sessions repeated often beat long sessions done rarely.',
      'The cards that come back each day are small, but together they carry a whole library of meanings.',
    ],
  },
  {
    title: 'Chapter 3. Looking Back',
    paragraphs: [
      'After a year the reader opened the first book again and was surprised by how easy the pages had become.',
    ],
  },
];

export function epubSections(variant: EpubVariant): EpubSection[] {
  if (variant === 'sample') return SAMPLE_EPUB_CHAPTERS.map((c) => ({ ...c }));
  return GENERIC_CHAPTERS.map((c, section) => ({
    section,
    title: c.title,
    depth: 0,
    text: [c.title, ...c.paragraphs].join('\n\n'),
  }));
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** The original bytes of a mock EPUB. */
let sampleCache: Uint8Array | null = null;

export function epubBytes(variant: EpubVariant, title: string, marker: string): Uint8Array {
  if (variant === 'sample') return (sampleCache ??= sampleEpub(3)).slice();
  const chapters: EpubChapterSpec[] = GENERIC_CHAPTERS.map((c) => ({
    title: c.title,
    html: c.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('\n'),
  }));
  return buildEpub({
    title,
    author: 'Leitor',
    language: 'en',
    version: 3,
    chapters,
    // Makes the file (and so the book uid) unique per imported path.
    identifier: `urn:leitor:mock:${marker}`,
  });
}

export const SAMPLE_EPUB = { title: SAMPLE_EPUB_TITLE, author: SAMPLE_EPUB_AUTHOR } as const;

/** The TOC as the vocabulary engine's outline: each item points at its spine section; nesting follows `depth`. */
export function epubOutline(variant: EpubVariant): RawOutlineItem[] {
  const root: RawOutlineItem[] = [];
  const stack: { depth: number; children: RawOutlineItem[] }[] = [{ depth: -1, children: root }];
  for (const s of epubSections(variant)) {
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= s.depth) stack.pop();
    const item: RawOutlineItem = { title: s.title, page: s.section, children: [] };
    stack[stack.length - 1]!.children.push(item);
    stack.push({ depth: s.depth, children: item.children! });
  }
  return root;
}

/** The TOC label of a section (the item pointing at it), else `null`. */
export function epubSectionLabel(variant: EpubVariant, section: number): string | null {
  return epubSections(variant).find((s) => s.section === section)?.title ?? null;
}

/** `PK\x03\x04` + a first entry `mimetype` holding `application/epub+zip` (OCF), like `core_epub::sniff`. */
export function isEpubBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 58) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return false;
  const nameLen = bytes[26]! | (bytes[27]! << 8);
  const extraLen = bytes[28]! | (bytes[29]! << 8);
  const name = String.fromCharCode(...bytes.subarray(30, 30 + nameLen));
  if (name !== 'mimetype') return false;
  const at = 30 + nameLen + extraLen;
  return String.fromCharCode(...bytes.subarray(at, at + 20)) === 'application/epub+zip';
}

/** The `dc:title` of an EPUB written by `buildEpub` (STORE zip: the OPF is plain text inside). */
export function epubTitleOf(bytes: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const m = /<dc:title>([^<]*)<\/dc:title>/.exec(text);
  return m ? m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() || null : null;
}

// ---------------------------------------------------------------- annotations

interface StoredAnnotation extends EpubAnnotation {
  deleted: boolean;
}

interface EpubState {
  annotations: StoredAnnotation[];
}

const STORAGE_KEY = 'leitor.mock.epub';
const KINDS: readonly EpubAnnotationKind[] = ['highlight', 'underline', 'note', 'bookmark'];
const CFI_MAX_BYTES = 4096;
const TEXT_MAX_CHARS = 20_000;

function initial(): EpubState {
  return { annotations: [] };
}

function load(): EpubState {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as EpubState;
      if (parsed && Array.isArray(parsed.annotations)) return parsed;
    }
  } catch {
    // Corrupt storage: start over.
  }
  return initial();
}

let state: EpubState = load();

function persist(): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Keep the in-memory state only.
  }
}

const invalid = (message: string) => new CoreError('invalid_input', message);

/** The 0-based spine section a CFI points into (`/6/N!` → N/2 − 1), like `core_epub`. */
export function cfiSection(cfi: string): number {
  const m = /^epubcfi\(\/6\/(\d+)/.exec(cfi.trim());
  const n = m ? Number(m[1]) : 2;
  return Math.max(0, Math.floor(n / 2) - 1);
}

function newUid(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** `epubcfi(/6/4!/4/2,/1:0,/1:12)` and the like: the syntax the reader writes (a light check, like the core's). */
export function isValidCfi(cfi: string): boolean {
  return /^epubcfi\(\/\d+[^()]*\)$/.test(cfi.trim()) && new TextEncoder().encode(cfi).length <= CFI_MAX_BYTES;
}

function publicOf(a: StoredAnnotation): EpubAnnotation {
  const { deleted: _deleted, ...rest } = a;
  return structuredClone(rest);
}

/** What the EPUB mock needs from the mock library (mock.ts). */
export interface EpubDeps {
  /** The live EPUB book (throws `book_not_found`; `not_epub` for a PDF). */
  epub(uid: string): { variant: EpubVariant };
}

const INPUT_KEYS = new Set(['uid', 'bookUid', 'kind', 'cfi', 'text', 'color', 'comment']);

function upsert(deps: EpubDeps, input: EpubAnnotationInput): EpubAnnotation {
  // The core deserializes with `deny_unknown_fields`.
  const extra = Object.keys(input).find((k) => !INPUT_KEYS.has(k));
  if (extra) throw invalid(`Campo desconhecido: ${extra}.`);
  deps.epub(input.bookUid);
  const uid = input.uid == null ? newUid() : input.uid;
  if (typeof uid !== 'string' || !uid.trim() || uid.length > 64) {
    throw invalid('Identificador de anotação inválido.');
  }
  if (!KINDS.includes(input.kind)) throw invalid('Tipo de anotação desconhecido.');
  if (typeof input.cfi !== 'string' || !isValidCfi(input.cfi)) throw invalid('Posição (CFI) da anotação inválida.');
  for (const v of [input.text, input.comment]) {
    if (v != null && Array.from(v).length > TEXT_MAX_CHARS) throw invalid('Texto longo demais.');
  }
  if (input.color != null && (!input.color || input.color.length > 32)) throw invalid('Cor da anotação inválida.');
  const now = Date.now();
  const existing = state.annotations.find((a) => a.uid === uid);
  if (existing && existing.bookUid !== input.bookUid) throw invalid('A anotação é de outro livro.');
  const row: StoredAnnotation = {
    uid,
    bookUid: input.bookUid,
    kind: input.kind,
    cfi: input.cfi.trim(),
    section: cfiSection(input.cfi),
    text: input.text ?? null,
    color: input.color ?? null,
    comment: input.comment ?? null,
    // Strictly increasing per row, like the core's `updated_at` bump.
    updatedAt: existing ? Math.max(now, existing.updatedAt + 1) : now,
    deleted: false,
  };
  if (existing) Object.assign(existing, row);
  else state.annotations.push(row);
  persist();
  return publicOf(row);
}

function remove(annotationUid: string): void {
  const a = state.annotations.find((x) => x.uid === annotationUid);
  if (!a || a.deleted) return;
  a.deleted = true;
  a.updatedAt = Math.max(Date.now(), a.updatedAt + 1);
  persist();
}

export type EpubMockKeys = 'epubAnnotationList' | 'epubAnnotationUpsert' | 'epubAnnotationDelete';

export function createEpubMock(deps: EpubDeps): Pick<CoreClient, EpubMockKeys> {
  return {
    epubAnnotationList: (uid) =>
      later(() => {
        deps.epub(uid);
        return state.annotations.filter((a) => a.bookUid === uid && !a.deleted).map(publicOf);
      }),
    epubAnnotationUpsert: (input) => later(() => upsert(deps, input)),
    epubAnnotationDelete: (annotationUid) => later(() => remove(annotationUid)),
  };
}

/** Tombstones every annotation of a removed book (like `remove_book`). */
export function tombstoneEpubBook(uid: string): void {
  let changed = false;
  for (const a of state.annotations) {
    if (a.bookUid === uid && !a.deleted) {
      a.deleted = true;
      a.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) persist();
}

/** `window.__leitorMock.epub`. */
export interface MockEpubHandle {
  /** Every row, tombstones included (to check the sync conventions). */
  readonly annotations: (EpubAnnotation & { deleted: boolean })[];
}

export const mockEpubHandle: MockEpubHandle = {
  get annotations() {
    return structuredClone(state.annotations);
  },
};

export function resetEpub(): void {
  state = initial();
  persist();
}
