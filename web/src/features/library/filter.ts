import type { LibraryEntry } from '../../lib/core/client';

/** Lowercase, without accents, single spaces: "Inglês  Básico" → "ingles basico". */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
}

/** `null` = every collection. */
export type CollectionFilter = string | null;

/** Title/author search (accent- and case-insensitive, every term must match) and collection filter. */
export function filterBooks(books: LibraryEntry[], query: string, collection: CollectionFilter): LibraryEntry[] {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  return books.filter((b) => {
    if (collection !== null && b.collectionFolder !== collection) return false;
    if (!terms.length) return true;
    const hay = normalizeText(`${b.title} ${b.author ?? ''}`);
    return terms.every((term) => hay.includes(term));
  });
}

/** Distinct collection names, sorted the pt-BR way. */
export function collectionsOf(books: LibraryEntry[]): string[] {
  const names = new Set<string>();
  for (const b of books) if (b.collectionFolder) names.add(b.collectionFolder);
  return [...names].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
}

/** Most recently read (or added) first. */
export function sortBooks(books: LibraryEntry[]): LibraryEntry[] {
  const key = (b: LibraryEntry) => Math.max(b.position?.updatedAt ?? 0, b.addedAt);
  return [...books].sort((a, b) => key(b) - key(a) || a.title.localeCompare(b.title, 'pt-BR'));
}

/** "p. N de M" values, or null when the book was never opened. */
export function progressOf(b: LibraryEntry): { page: number; total: number; percent: number } | null {
  if (!b.position) return null;
  const total = Math.max(1, b.pages);
  const page = Math.min(total, b.position.page + 1);
  const percent = Math.round(Math.max(0, Math.min(1, b.position.progress)) * 100);
  return { page, total, percent };
}
