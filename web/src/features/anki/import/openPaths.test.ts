import { describe, expect, it } from 'vitest';
import { importSummaryText } from './ImportDialogs';
import { extensionOf, splitOpenPaths } from './AnkiImportProvider';

describe('open-with routing', () => {
  it('reads extensions case-insensitively, from the file name only', () => {
    expect(extensionOf('/a/b/Livro.PDF')).toBe('pdf');
    expect(extensionOf('C:\\\\Users\\\\x\\\\Coleção.colpkg')).toBe('colpkg');
    expect(extensionOf('/a.b/semext')).toBe('');
  });

  it('routes by extension: pdf, apkg, colpkg', () => {
    expect(splitOpenPaths(['/x/a.pdf'])).toEqual([{ kind: 'books', paths: ['/x/a.pdf'] }]);
    expect(splitOpenPaths(['/x/a.apkg'])).toEqual([{ kind: 'apkg', path: '/x/a.apkg' }]);
    expect(splitOpenPaths(['/x/a.COLPKG'])).toEqual([{ kind: 'colpkg', path: '/x/a.COLPKG' }]);
  });

  it('keeps mixed lists in order, grouping consecutive books', () => {
    expect(splitOpenPaths(['/1.pdf', '/2.pdf', '/a.apkg', '/3.epub', '/c.colpkg', '/4.pdf'])).toEqual([
      { kind: 'books', paths: ['/1.pdf', '/2.pdf'] },
      { kind: 'apkg', path: '/a.apkg' },
      { kind: 'books', paths: ['/3.epub'] },
      { kind: 'colpkg', path: '/c.colpkg' },
      { kind: 'books', paths: ['/4.pdf'] },
    ]);
  });

  it('summarizes an import in pt-BR', () => {
    expect(importSummaryText({ added: 1, updated: 2, duplicates: 0, conflicts: 0, skipped: 0 })).toBe(
      '1 nota adicionada, 2 atualizadas',
    );
    expect(importSummaryText({ added: 3, updated: 1, duplicates: 2, conflicts: 1, skipped: 0 })).toBe(
      '3 notas adicionadas, 1 atualizada, 2 repetidas, 1 em conflito',
    );
  });
});
