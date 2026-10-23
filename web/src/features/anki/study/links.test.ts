import { describe, expect, it } from 'vitest';
import { parseLeitorLink } from './links';

const UID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('parseLeitorLink', () => {
  it('reads the book, the page and the search', () => {
    expect(parseLeitorLink(`leitor://livro/${UID}?pagina=37&amp;q=the%20windmill`, 'Animal Farm, p. 37')).toEqual({
      bookUid: UID,
      page: 37,
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
});
