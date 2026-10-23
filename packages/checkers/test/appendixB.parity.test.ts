import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APPENDIX_B } from './appendixB.data';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, '../../../docs/PROJETO.md');

/** Splits a Markdown table row on unescaped `|`; `\|` becomes `|`. */
function cells(line: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === '\\' && line.charAt(i + 1) === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  // Leading and trailing pipes leave empty cells at both ends.
  return parts.slice(1, -1);
}

/** Cell text without Markdown backticks; a whole-cell code span keeps its inner spaces. */
function plain(cell: string): string {
  const t = cell.trim();
  const code = /^`([^`]*)`$/.exec(t);
  return code ? (code[1] ?? '') : t.replace(/`/g, '');
}

function docTable(): string[][] {
  const text = readFileSync(SPEC, 'utf8');
  const start = text.indexOf('## Apêndice B');
  expect(start).toBeGreaterThan(0);
  const lines = text.slice(start).split('\n');
  const end = lines.findIndex((l, k) => k > 0 && l.startsWith('## '));
  const section = end > 0 ? lines.slice(0, end) : lines;
  return section.filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => cells(l).map(plain));
}

describe('Apêndice B: doc ⇔ encoded table', () => {
  const doc = docTable();

  it('has the same number of rows', () => {
    expect(doc.length).toBe(APPENDIX_B.length);
  });

  APPENDIX_B.forEach((row, k) => {
    it(`row ${row.n} matches docs/PROJETO.md`, () => {
      const strip = (s: string): string => s.replace(/`/g, '');
      expect(doc[k]).toEqual([String(row.n), strip(row.canonical), strip(row.answer), row.expected, strip(row.why)]);
    });
  });
});
