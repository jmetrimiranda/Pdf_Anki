import { describe, expect, it } from 'vitest';
import { layoutPageText, makePdf, pdfBytesToLatin1 } from './minimalPdf';

function parse(bytes: Uint8Array) {
  const s = pdfBytesToLatin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)?.[1]);
  const xref = s.slice(startxref);
  const header = /^xref\n0 (\d+)\n/.exec(xref);
  const size = Number(header?.[1]);
  const entries = xref
    .slice(header?.[0].length)
    .split('\n')
    .slice(0, size)
    .map((line) => ({ offset: Number(line.slice(0, 10)), used: line.slice(17, 18) === 'n' }));
  return { s, startxref, size, entries };
}

describe('makePdf', () => {
  it('writes a header, a valid xref table and a trailer', () => {
    const bytes = makePdf({ pages: 3, title: 'Teste' });
    const { s, startxref, size, entries } = parse(bytes);
    expect(s.startsWith('%PDF-1.7\n')).toBe(true);
    expect(s.slice(startxref, startxref + 4)).toBe('xref');
    expect(entries).toHaveLength(size);
    expect(entries[0]?.used).toBe(false);
    // Every in-use entry points at "<n> 0 obj".
    entries.forEach((e, n) => {
      if (n === 0) return;
      expect(e.used).toBe(true);
      expect(s.slice(e.offset, e.offset + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    });
    expect(s).toMatch(new RegExp(`trailer\\n<< /Size ${size} /Root 1 0 R /Info 4 0 R >>`));
  });

  it('has the requested page count and stream lengths that match', () => {
    const { s } = parse(makePdf({ pages: 7 }));
    expect(s.match(/\/Type \/Page(?![s\w])/g)).toHaveLength(7);
    expect(s).toContain('/Count 7');
    for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = m.index + m[0].length;
      expect(s.slice(start + Number(m[1]), start + Number(m[1]) + 'endstream'.length)).toBe('endstream');
    }
  });

  it('writes Info metadata, LeitorBookUid, outline and highlight on request', () => {
    const uid = 'a'.repeat(64);
    const s = pdfBytesToLatin1(
      makePdf({ pages: 2, title: 'Livro', author: 'Autora', leitorBookUid: uid, outline: true, highlight: true }),
    );
    expect(s).toContain('/Title (Livro)');
    expect(s).toContain('/Author (Autora)');
    expect(s).toContain(`/LeitorBookUid (${uid})`);
    expect(s).toContain('/Outlines 5 0 R');
    expect(s.match(/\/Title \(Chapter \d\)/g)).toHaveLength(2);
    expect(s).toContain('/Subtype /Highlight');
    const plain = pdfBytesToLatin1(makePdf({ pages: 1 }));
    expect(plain).not.toContain('LeitorBookUid');
    expect(plain).not.toContain('/Highlight');
  });

  it('encodes non-ASCII metadata as UTF-16 and escapes text', () => {
    const s = pdfBytesToLatin1(makePdf({ pages: 1, title: 'Inglês', textPerPage: () => 'a (b) c\\d' }));
    expect(s).toContain('/Title <FEFF0049006E0067006C00EA0073>');
    expect(s).toContain('(a \\(b\\) c\\\\d) Tj');
  });

  it('is fast enough for 500 pages', () => {
    const t0 = performance.now();
    const bytes = makePdf({ pages: 500, outline: true });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(pdfBytesToLatin1(bytes).match(/\/Type \/Page(?![s\w])/g)).toHaveLength(500);
  });

  it('lays out text where it draws it', () => {
    const lines = layoutPageText('one\ntwo');
    expect(lines.map((l) => l.text)).toEqual(['one', 'two']);
    expect(lines[1]!.baseline).toBeGreaterThan(lines[0]!.baseline);
  });
});
