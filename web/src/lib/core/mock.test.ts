import { describe, expect, it } from 'vitest';
import { MOCK_DOC_ID, mockClient } from './mock';
import { CoreError, type DeckNode } from './types';

function walk(nodes: DeckNode[], fn: (n: DeckNode) => void) {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

describe('mock core client', () => {
  it('returns a deck tree shaped like the contract', async () => {
    const tree = await mockClient.ankiDeckTree();
    const names: string[] = [];
    walk(tree.decks, (n) => {
      names.push(n.fullName);
      expect(Number.isInteger(n.id)).toBe(true);
      expect(n.fullName.split('::').length).toBe(n.level);
      expect(n.fullName.endsWith(n.name)).toBe(true);
      for (const c of [n.newCount, n.learnCount, n.reviewCount]) expect(c).toBeGreaterThanOrEqual(0);
    });
    expect(names).toEqual(
      expect.arrayContaining(['5000 palavras', 'Oxford', 'ROS 2 — Revisão', 'Vocabulário::Livros::Teste']),
    );
    expect(tree.studiedToday).toEqual({ cards: expect.any(Number), seconds: expect.any(Number) });
  });

  it('opens documents and returns page sizes', async () => {
    const info = await mockClient.docOpenPath('/tmp/Livro.pdf');
    expect(info.title).toBe('Livro');
    expect(info.pages).toHaveLength(info.pageCount);
    expect(info.pages[0]).toEqual({ width: 612, height: 792 });
    await mockClient.docClose(info.docId);
    await expect(mockClient.docInfo(info.docId)).rejects.toBeInstanceOf(CoreError);
  });

  it('rejects unsupported and broken files with typed errors', async () => {
    await expect(mockClient.docOpenPath('/tmp/a.txt')).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(mockClient.docOpenPath('/tmp/corrompido.pdf')).rejects.toMatchObject({ code: 'pdf_invalid' });
  });

  it('returns words whose offsets index the page text', async () => {
    const words = await mockClient.docWords(MOCK_DOC_ID, 0);
    expect(words.words.length).toBeGreaterThan(100);
    for (const w of words.words) {
      expect(words.text.slice(w.start, w.end)).toBe(w.text);
      expect(w.rects.length).toBeGreaterThan(0);
      for (const [x, y, rw, rh] of w.rects) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + rw).toBeLessThanOrEqual(words.width);
        expect(y + rh).toBeLessThanOrEqual(words.height);
      }
    }
    await expect(mockClient.docWords(MOCK_DOC_ID, 999)).rejects.toMatchObject({ code: 'page_out_of_range' });
  });

  it('searches, outlines and builds page images', async () => {
    const hits = await mockClient.docSearch(MOCK_DOC_ID, 'node');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.context.toLowerCase()).toContain('node');
    const outline = await mockClient.docOutline(MOCK_DOC_ID);
    expect(outline[0]?.page).toBe(0);
    expect(mockClient.pageImageUrl(MOCK_DOC_ID, 0, { scale: 1 })).toMatch(/^data:image\/svg\+xml/);
    const smoke = await mockClient.devSmoke();
    expect(smoke.doc.docId).toBe(MOCK_DOC_ID);
    expect(smoke.words).toBeGreaterThan(0);
  });
});
