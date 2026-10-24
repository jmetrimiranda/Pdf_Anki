import { describe, expect, it } from 'vitest';
import { compareCfi, excerpt, isCfi, newAnnotationUid, sortAnnotations } from './annotations';

const a = (uid: string, cfi: string, kind: 'highlight' | 'bookmark' = 'highlight') => ({ uid, cfi, kind });

describe('EPUB annotation ordering', () => {
  it('orders by CFI (foliate CFI.compare), not by text', () => {
    const list = [
      a('c', 'epubcfi(/6/10!/4/2/10,/1:0,/1:5)'),
      a('a', 'epubcfi(/6/4!/4/2/2,/1:10,/1:20)'),
      a('b', 'epubcfi(/6/4!/4/2/2,/1:2,/1:8)'),
      a('d', 'epubcfi(/6/4!/4/2/12,/1:0,/1:4)'),
    ];
    // Text order would put /6/10 before /6/4 and /2/12 before /2/2.
    expect(sortAnnotations(list).map((x) => x.uid)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('puts a bookmark before a passage at the same place, malformed CFIs last', () => {
    const list = [
      a('h', 'epubcfi(/6/4!/4/2/2/1:0)'),
      a('x', 'garbage'),
      a('m', 'epubcfi(/6/4!/4/2/2/1:0)', 'bookmark'),
    ];
    expect(sortAnnotations(list).map((x) => x.uid)).toEqual(['m', 'h', 'x']);
  });

  it('compares ranges by start then end', () => {
    expect(compareCfi('epubcfi(/6/4!/4/2,/1:0,/1:5)', 'epubcfi(/6/4!/4/2,/1:0,/1:9)')).toBe(-1);
    expect(compareCfi('epubcfi(/6/4!/4/2,/1:3,/1:5)', 'epubcfi(/6/4!/4/2,/1:0,/1:9)')).toBe(1);
    expect(isCfi('epubcfi(/6/4!/4/2,/1:0,/1:5)')).toBe(true);
    expect(isCfi('nope')).toBe(false);
  });

  it('makes excerpts and uids', () => {
    expect(excerpt('  a\n b  ')).toBe('a b');
    expect(excerpt('x'.repeat(200), 10)).toHaveLength(10);
    expect(newAnnotationUid()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
