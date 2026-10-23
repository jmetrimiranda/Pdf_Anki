import { describe, expect, it } from 'vitest';
import type { LibraryEntry } from '../../lib/core/client';
import { collectionsOf, filterBooks, normalizeText, progressOf, sortBooks } from './filter';

function book(title: string, extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    bookUid: title.padEnd(64, '0'),
    title,
    author: null,
    language: 'en',
    format: 'pdf',
    fileName: `${title}.pdf`,
    pages: 10,
    hasText: true,
    ocrStatus: 'none',
    fileHash: 'h',
    fileVersion: 1,
    contentDeckId: null,
    collectionFolder: null,
    addedAt: 0,
    updatedAt: 0,
    localPath: null,
    localHash: null,
    downloaded: true,
    position: null,
    vocabScanned: false,
    ...extra,
  };
}

const books = [
  book('Gramática Básica', { author: 'Ana Ávila', collectionFolder: 'Português', addedAt: 1 }),
  book('Animal Farm', { author: 'George Orwell', collectionFolder: 'Inglês', addedAt: 2 }),
  book('ROS 2 na prática', { author: 'Jorge Metri', addedAt: 3 }),
];

describe('library filters', () => {
  it('normalizes accents, case and spaces', () => {
    expect(normalizeText('  Inglês   BÁSICO ')).toBe('ingles basico');
  });

  it('searches title and author ignoring accents and case; every term must match', () => {
    expect(filterBooks(books, 'gramatica', null).map((b) => b.title)).toEqual(['Gramática Básica']);
    expect(filterBooks(books, 'AVILA', null).map((b) => b.title)).toEqual(['Gramática Básica']);
    expect(filterBooks(books, 'orwell farm', null).map((b) => b.title)).toEqual(['Animal Farm']);
    expect(filterBooks(books, 'orwell ros', null)).toEqual([]);
    expect(filterBooks(books, '   ', null)).toHaveLength(3);
  });

  it('filters by collection and combines with the search', () => {
    expect(filterBooks(books, '', 'Inglês').map((b) => b.title)).toEqual(['Animal Farm']);
    expect(filterBooks(books, 'ros', 'Inglês')).toEqual([]);
    expect(collectionsOf(books)).toEqual(['Inglês', 'Português']);
  });

  it('sorts by last reading, then by date added', () => {
    const read = book('Lido', { addedAt: 0, position: { page: 0, offset: 0, cfi: null, progress: 0, updatedAt: 10 } });
    expect(sortBooks([...books, read]).map((b) => b.title)).toEqual([
      'Lido',
      'ROS 2 na prática',
      'Animal Farm',
      'Gramática Básica',
    ]);
  });

  it('computes "p. N de M" values', () => {
    expect(progressOf(books[0]!)).toBeNull();
    const b = book('X', { pages: 12, position: { page: 4, offset: 0, cfi: null, progress: 5 / 12, updatedAt: 1 } });
    expect(progressOf(b)).toEqual({ page: 5, total: 12, percent: 42 });
  });
});
