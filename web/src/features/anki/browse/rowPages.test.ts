import { describe, expect, it, vi } from 'vitest';
import type { BrowseRow } from '../../../lib/core/types';
import { RowPages } from './rowPages';

function row(cardId: number): BrowseRow {
  return {
    cardId,
    noteId: cardId * 10,
    sortField: `card ${cardId}`,
    template: 'Cartão 1',
    deck: 'Deck',
    due: '01/01/2027',
    flag: 0,
    marked: false,
    suspended: false,
    buried: false,
  };
}

const ids = Array.from({ length: 250 }, (_, i) => 1000 + i);

describe('lazy browser rows', () => {
  it('fetches only the pages in view, 100 rows per call, once', async () => {
    const fetch = vi.fn(async (batch: number[]) => batch.map(row));
    const onChange = vi.fn();
    const pages = new RowPages(ids, fetch, onChange);
    expect(pages.row(0)).toBeUndefined();

    await pages.ensure(0, 30);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toHaveLength(100);
    expect(pages.row(0)?.sortField).toBe('card 1000');
    expect(pages.row(99)?.cardId).toBe(1099);
    expect(pages.row(100)).toBeUndefined();

    await pages.ensure(10, 40);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Scrolling across a page boundary loads the next page; the last page is short.
    await pages.ensure(95, 260);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]![0]).toHaveLength(50);
    expect(pages.row(249)?.cardId).toBe(1249);
    expect(onChange).toHaveBeenCalled();
  });

  it('does not load a page twice while it is in flight', async () => {
    let resolve: (rows: BrowseRow[]) => void = () => {};
    const fetch = vi.fn(() => new Promise<BrowseRow[]>((r) => (resolve = r)));
    const pages = new RowPages(ids, fetch, () => {});
    const a = pages.ensure(0, 10);
    const b = pages.ensure(0, 10);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(ids.slice(0, 100).map(row));
    await Promise.all([a, b]);
    expect(pages.row(5)?.cardId).toBe(1005);
  });

  it('a new search drops the old rows and late answers', async () => {
    let resolve: (rows: BrowseRow[]) => void = () => {};
    const fetch = vi.fn((batch: number[]) =>
      batch[0] === 1000 ? new Promise<BrowseRow[]>((r) => (resolve = r)) : Promise.resolve(batch.map(row)),
    );
    const pages = new RowPages(ids, fetch, () => {});
    const late = pages.ensure(0, 0);
    pages.reset([5, 6]);
    resolve(ids.slice(0, 100).map(row));
    await late;
    expect(pages.count).toBe(2);
    expect(pages.row(0)).toBeUndefined();
    await pages.ensure(0, 1);
    expect(pages.row(1)?.cardId).toBe(6);
  });

  it('a failed page is reported and retried on demand', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockImplementation(async (b: number[]) => b.map(row));
    const pages = new RowPages(ids.slice(0, 10), fetch, () => {});
    await pages.ensure(0, 5);
    expect(pages.failedAt(3)).toBe(true);
    await pages.ensure(0, 5);
    expect(fetch).toHaveBeenCalledTimes(1);
    pages.retryFailed();
    await pages.ensure(0, 5);
    expect(pages.row(3)?.cardId).toBe(1003);
  });
});
