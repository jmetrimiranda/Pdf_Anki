// EPUB annotations (spec 7.1, 14: `epub_annotation`, CFI ranges): ordering in reading order and the small helpers
// the reader and the "Anotações" drawer share. Stored through the core (`epub_annotation_list/upsert/delete`).
import { compare } from '@foliate/epubcfi.js';
import type { EpubAnnotation, EpubAnnotationKind } from '../../lib/core/types';

/** CFI order (foliate's `CFI.compare`); a malformed CFI goes last, by text. */
export function compareCfi(a: string, b: string): number {
  const okA = CFI_SHAPE.test(a);
  const okB = CFI_SHAPE.test(b);
  if (okA && okB) {
    try {
      return compare(a, b);
    } catch {
      // Unparsable: by text below.
    }
  } else if (okA !== okB) return okA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const CFI_SHAPE = /^epubcfi\(\/\d.*\)$/;

export function isCfi(s: string): boolean {
  if (!CFI_SHAPE.test(s)) return false;
  try {
    compare(s, s);
    return true;
  } catch {
    return false;
  }
}

/** Annotations in reading order (then bookmarks before passages at the same place, then by uid). */
export function sortAnnotations<T extends Pick<EpubAnnotation, 'cfi' | 'kind' | 'uid'>>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      compareCfi(a.cfi, b.cfi) ||
      Number(b.kind === 'bookmark') - Number(a.kind === 'bookmark') ||
      (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0),
  );
}

/** Drawn on the page (bookmarks are a ribbon in the reader's corner instead). */
export function isDrawn(kind: EpubAnnotationKind): boolean {
  return kind !== 'bookmark';
}

/** Short excerpt for lists. */
export function excerpt(text: string | null | undefined, max = 140): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A new annotation uid (UUID v4). */
export function newAnnotationUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
