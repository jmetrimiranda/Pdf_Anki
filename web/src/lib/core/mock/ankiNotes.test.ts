import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient, mockHandle } from '../mock';
import { mockRow, mockSearch, sanitizeMediaName } from './ankiNotes';

beforeEach(() => mockHandle.reset());

const fronts = (ids: number[]) => ids.map((id) => mockRow(id)!.sortField);
const deckId = async (name: string) => (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;
const ntid = async (name: string) => (await mockClient.ankiNotetypes()).find((n) => n.name === name)!.id;

describe('mock search (subset of Anki syntax)', () => {
  it('decks with children, the current deck, words, negation, OR and groups', () => {
    expect(mockSearch('deck:Oxford', null)).toHaveLength(3);
    expect(mockSearch('deck:"Oxford::Oxford 3000"', null)).toHaveLength(3);
    expect(mockSearch('deck:current', null)).toHaveLength(7);
    expect(fronts(mockSearch('kitch*', null))).toEqual(['kitchen']);
    expect(mockSearch('deck:Oxford -abandon', null)).toHaveLength(2);
    expect(mockSearch('abandon OR able', null)).toHaveLength(2);
    expect(mockSearch('(abandon OR able) deck:Oxford*', null)).toHaveLength(2);
    expect(mockSearch('', null).length).toBeGreaterThan(15);
  });

  it('is:, note:, card:, field: and tag:', async () => {
    expect(mockSearch('is:new deck:Oxford', null)).toHaveLength(3);
    expect(mockSearch('is:due', null).length).toBeGreaterThan(0);
    expect(mockSearch('note:"Código · Comando"', null)).toHaveLength(2);
    expect(mockSearch('note:Omissão* card:2', null)).toHaveLength(1);
    expect(fronts(mockSearch('frente:door', null))).toEqual(['door']);
    const nids = mockSearch('deck:Oxford', null).map((id) => mockRow(id)!.noteId);
    await mockClient.ankiNotesTags(nids.slice(0, 2), 'lote::a', '');
    expect(mockSearch('tag:lote', null)).toHaveLength(2);
    expect(mockSearch('tag:lote::a', null)).toHaveLength(2);
    expect(mockSearch('tag:outra', null)).toHaveLength(0);
  });

  it('rejects broken syntax like the core', () => {
    expect(() => mockSearch('deck:"sem fim', null)).toThrow(/Pesquisa inválida/);
    expect(() => mockSearch('(casa', null)).toThrow(/Pesquisa inválida/);
    expect(() => mockSearch('is:nada', null)).toThrow(/Pesquisa inválida/);
  });

  it('sorts by the browser columns', () => {
    expect(fronts(mockSearch('deck:Oxford', { column: 'sortField', reverse: false }))).toEqual([
      'abandon',
      'ability',
      'able',
    ]);
    expect(fronts(mockSearch('deck:Oxford', { column: 'sortField', reverse: true }))).toEqual([
      'able',
      'ability',
      'abandon',
    ]);
    const byDeck = mockSearch('', { column: 'deck', reverse: false }).map((id) => mockRow(id)!.deck.toLowerCase());
    expect(byDeck).toEqual([...byDeck].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  });
});

describe('mock notes', () => {
  it('adds, checks and updates notes like the core', async () => {
    const basic = await ntid('Básico');
    const deck = await deckId('Oxford::Oxford 3000');
    expect(await mockClient.ankiNoteCheck(basic, ['kitchen', ''])).toBe('duplicate');
    expect(await mockClient.ankiNoteCheck(basic, ['', 'x'])).toBe('empty');
    expect(await mockClient.ankiNoteCheck(basic, ['{{c1::x}}', ''])).toBe('notetypeNotCloze');
    await expect(
      mockClient.ankiNoteAdd({ notetypeId: basic, deckId: deck, fields: ['', 'x'], tags: [] }),
    ).rejects.toThrow(/primeiro campo/);
    await expect(mockClient.ankiNoteAdd({ notetypeId: basic, deckId: deck, fields: ['x'], tags: [] })).rejects.toThrow(
      /2 campos/,
    );
    const added = await mockClient.ankiNoteAdd({
      notetypeId: basic,
      deckId: deck,
      fields: ['sun', 'sol'],
      tags: ['a b', 'A'],
    });
    expect(added.cardCount).toBe(1);
    const note = await mockClient.ankiNoteGet(added.noteId);
    expect(note.tags).toEqual(['a', 'b']);
    expect(note.deckId).toBe(deck);
    await mockClient.ankiNoteUpdate(added.noteId, ['sun', 'sol!'], ['c']);
    expect((await mockClient.ankiNoteGet(added.noteId)).fields).toEqual(['sun', 'sol!']);

    const cloze = await ntid('Omissão de palavras');
    const c = await mockClient.ankiNoteAdd({
      notetypeId: cloze,
      deckId: deck,
      fields: ['{{c1::a}} {{c3::b}}', ''],
      tags: [],
    });
    expect(c.cardCount).toBe(2);
  });

  it('bulk operations and the common notetype', async () => {
    const ids = mockSearch('deck:Oxford', null);
    await mockClient.ankiCardsSuspend(ids.slice(0, 1), true);
    expect(mockSearch('is:suspended', null)).toEqual(ids.slice(0, 1));
    const target = await deckId('Oxford::Oxford 5000');
    expect(await mockClient.ankiCardsSetDeck(ids, target)).toBe(3);
    expect(mockSearch('deck:"Oxford::Oxford 5000"', null)).toHaveLength(3);
    const nids = ids.map((id) => mockRow(id)!.noteId);
    expect(await mockClient.ankiChangeNotetypePrepare(nids)).toEqual({ notetypeId: await ntid('Básico') });
    const clozeNote = mockRow(mockSearch('note:Omissão*', null)[0]!)!.noteId;
    await expect(mockClient.ankiChangeNotetypePrepare([nids[0]!, clozeNote])).rejects.toThrow(/diferentes/);
    expect(await mockClient.ankiNotesDelete(nids.slice(0, 2))).toBe(2);
    expect(mockSearch('deck:Oxford', null)).toHaveLength(1);
    expect(mockHandle.anki.logs.map((l) => l.kind)).toEqual(
      expect.arrayContaining(['suspend', 'setDeck', 'deleteNotes']),
    );
  });

  it('media: images only, basename, renamed on conflict', async () => {
    expect(sanitizeMediaName('../../x.png')).toBe('x.png');
    expect(sanitizeMediaName('')).toBe('imagem.png');
    const a = await mockClient.ankiMediaAdd('foto.png', new Uint8Array([1]));
    const b = await mockClient.ankiMediaAdd('foto.png', new Uint8Array([2]));
    expect(a).toBe('foto.png');
    expect(b).not.toBe('foto.png');
    expect(await mockClient.ankiMediaAdd('foto.png', new Uint8Array([1]))).toBe('foto.png');
    await expect(mockClient.ankiMediaAdd('x.exe', new Uint8Array([1]))).rejects.toThrow(/só imagens/);
  });
});
