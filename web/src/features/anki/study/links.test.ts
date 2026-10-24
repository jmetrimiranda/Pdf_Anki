import { describe, expect, it } from 'vitest';
import { leitorSearch, openOptions, parseLeitorLink } from './links';

const UID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('parseLeitorLink', () => {
  it('reads the book, the page and the search', () => {
    expect(parseLeitorLink(`leitor://livro/${UID}?pagina=37&amp;q=the%20windmill`, 'Animal Farm, p. 37')).toEqual({
      bookUid: UID,
      page: 37,
      unit: 'page',
      cfi: null,
      query: 'the windmill',
      label: 'Animal Farm, p. 37',
    });
    expect(parseLeitorLink(`leitor://livro/${UID}?pagina=5`)).toMatchObject({ page: 5, query: null, label: 'p. 5' });
  });

  it('rejects malformed links', () => {
    expect(parseLeitorLink(`leitor://livro/${UID.slice(1)}?pagina=1`)).toBeNull();
    expect(parseLeitorLink(`leitor://livro/${UID.toUpperCase()}?pagina=1`)).toBeNull();
    expect(parseLeitorLink(`leitor://livro/${UID}?q=x`)).toBeNull();
    expect(parseLeitorLink(`leitor://livro/${UID}?pagina=0`)).toBeNull();
    expect(parseLeitorLink(`https://example.com/?pagina=1`)).toBeNull();
  });

  it('reads EPUB chapter links with their CFI (core-anki chapter_links_parse)', () => {
    const cfi = encodeURIComponent('epubcfi(/6/8!/4/2/1:0)');
    const link = parseLeitorLink(`leitor://livro/${UID}?cap=3&amp;cfi=${cfi}&amp;q=the%20windmill`)!;
    expect(link).toEqual({
      bookUid: UID,
      page: 3,
      unit: 'chapter',
      cfi: 'epubcfi(/6/8!/4/2/1:0)',
      query: 'the windmill',
      label: 'cap. 3',
    });
    expect(parseLeitorLink(`leitor://livro/${UID}?cap=7`)).toMatchObject({
      unit: 'chapter',
      cfi: null,
      label: 'cap. 7',
    });
    // pagina wins over cap; a cfi means nothing for a page.
    expect(
      parseLeitorLink(`leitor://livro/${UID}?cap=7&pagina=2&cfi=epubcfi(%2F6%2F4!%2F4%2F2%2F1%3A0)`),
    ).toMatchObject({ page: 2, unit: 'page', cfi: null, label: 'p. 2' });
    // An invalid cfi is dropped, the link stays.
    for (const bad of ['garbage', 'epubcfi(', '%ZZ', 'epubcfi(/6/4!/4/2/1:0)%3Cscript%3E']) {
      expect(parseLeitorLink(`leitor://livro/${UID}?cap=2&cfi=${bad}`), bad).toMatchObject({ page: 2, cfi: null });
    }
    expect(parseLeitorLink(`leitor://livro/${UID}?cap=0`)).toBeNull();
    expect(parseLeitorLink(`leitor://livro/${UID}?cap=x`)).toBeNull();
    expect(parseLeitorLink(`leitor://livro/${UID}?cfi=epubcfi(%2F6%2F4)`)).toBeNull();
  });

  it('turns a link into the Leitor route and the open options', () => {
    const chapter = parseLeitorLink(`leitor://livro/${UID}?cap=4&cfi=epubcfi(%2F6%2F10!%2F4)&q=Filby`)!;
    expect(leitorSearch(chapter)).toEqual({ livro: UID, cap: 4, cfi: 'epubcfi(/6/10!/4)', q: 'Filby' });
    expect(openOptions(chapter)).toEqual({ page: 3, find: 'Filby', cfi: 'epubcfi(/6/10!/4)' });
    const page = parseLeitorLink(`leitor://livro/${UID}?pagina=37`)!;
    expect(leitorSearch(page)).toEqual({ livro: UID, pagina: 37 });
    expect(openOptions(page)).toEqual({ page: 36 });
  });
});
