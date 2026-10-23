import { describe, expect, it } from 'vitest';
import type { VocabRow } from '../../lib/core/types';
import { DEFAULT_FILTERS, filterRows, formatPct, formatPct0, goalSelection, pageCount, tableItems } from './model';

function row(lemma: string, patch: Partial<VocabRow> = {}): VocabRow {
  return {
    lemma,
    form: lemma,
    pos: 'n',
    group: 'main',
    status: 'unknown',
    statusSource: null,
    occurrences: 3,
    firstPage: 0,
    pages: [0],
    zipf: 4,
    rare: false,
    example: null,
    exampleSpan: null,
    examplePage: null,
    base: null,
    family: null,
    existingNoteId: null,
    defaultSelected: true,
    chapter: 1,
    position: 0,
    ...patch,
  };
}

describe('report model', () => {
  it('formats percentages and pages in pt-BR', () => {
    expect(formatPct(0.9412)).toBe('94,1%');
    expect(formatPct(0.95349)).toBe('95,3%');
    expect(formatPct(1)).toBe('100,0%');
    expect(formatPct0(0.957)).toBe('95%');
    expect(
      pageCount([
        [20, 44],
        [59, 59],
      ]),
    ).toBe(26);
  });

  it('selects exactly N for 98%, most frequent first, skipping words of earlier scans', () => {
    const rows = [
      row('a', { occurrences: 9 }),
      row('b', { occurrences: 7, existingNoteId: 5 }),
      row('c', { occurrences: 7, firstPage: 2 }),
      row('d', { occurrences: 7, firstPage: 1 }),
      row('e', { occurrences: 1 }),
      row('f', { occurrences: 50, status: 'known' }),
      row('g', { occurrences: 50, group: 'forms', status: 'known' }),
    ];
    const metrics = { wordsTo98: 3 } as Parameters<typeof goalSelection>[0]['metrics'];
    expect(goalSelection({ rows, metrics })).toEqual(['a', 'd', 'c']);
  });

  it('filters the main group by status and splits the sections', () => {
    const rows = [
      row('x', { occurrences: 5 }),
      row('y', { occurrences: 1 }),
      row('z', { status: 'learning' }),
      row('napoleon', { group: 'proper', status: 'proper', form: 'Napoleon' }),
      row('learning', { group: 'forms', status: 'known', base: { lemma: 'learn', status: 'known' } }),
      row('rare', { rare: true }),
    ];
    expect(filterRows(rows, 'main', DEFAULT_FILTERS).map((r) => r.lemma)).toEqual(['x', 'rare']);
    expect(filterRows(rows, 'main', { ...DEFAULT_FILTERS, hideRare: true }).map((r) => r.lemma)).toEqual(['x']);
    expect(filterRows(rows, 'main', { ...DEFAULT_FILTERS, status: 'learning' }).map((r) => r.lemma)).toEqual(['z']);
    // A search finds a word whatever the other filters say.
    expect(filterRows(rows, 'main', { ...DEFAULT_FILTERS, query: 'Y' }).map((r) => r.lemma)).toEqual(['y']);
    const items = tableItems(rows, DEFAULT_FILTERS);
    expect(items.map((i) => (i.kind === 'row' ? i.row.lemma : `#${i.group}`))).toEqual([
      'x',
      'rare',
      '#proper',
      'napoleon',
      '#forms',
      'learning',
    ]);
  });
});
