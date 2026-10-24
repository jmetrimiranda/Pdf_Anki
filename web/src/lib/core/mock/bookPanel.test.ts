// The mock's book panel, study ownership and deep links follow the core's rules (app/tests/book_panel.rs,
// app/tests/anki.rs, app/src/deep_link.rs).
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient, mockHandle } from '../mock';
import type { StudyNext, StudyOwnerChange } from '../types';

const deckId = async (name: string) => (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;
const farmBook = async () => (await mockClient.libraryList()).find((b) => b.title === 'Animal Farm')!;
const canUndo = (n: StudyNext) => (n.kind === 'card' ? n.card.canUndo : n.canUndo);

beforeEach(() => mockHandle.reset());

describe('study ownership (spec 10.1)', () => {
  it('the mini-review preempts the tab, clears undo and restores the deck on close', async () => {
    const changes: StudyOwnerChange[] = [];
    const stop = mockClient.onStudyOwner((c) => changes.push(c));
    const words = await deckId('5000 palavras');
    const farm = await deckId('Livros::Animal Farm');
    const first = await mockClient.ankiStudyNext(words);
    expect(first.kind).toBe('card');
    const after = await mockClient.ankiAnswer(first.kind === 'card' ? first.card.cardId : 0, 3, 1000);
    expect(canUndo(after)).toBe(true);
    expect(mockHandle.anki.studyOwner).toBe('tab');

    const opened = await mockClient.ankiMiniReviewOpen(farm);
    expect(opened.previousDeckId).toBe(words);
    expect(opened.preempted).toBe('tab');
    expect(canUndo(opened.next)).toBe(false);
    await expect(mockClient.ankiUndo()).rejects.toBeTruthy();
    expect(mockHandle.anki.currentDeckId).toBe(farm);
    expect(mockHandle.anki.studyOwner).toBe('panel');

    // The tab's screen closing does not end the panel's session.
    await mockClient.ankiStudyClose();
    expect(mockHandle.anki.studyOwner).toBe('panel');

    expect(await mockClient.ankiMiniReviewClose()).toEqual({ restoredDeckId: words });
    expect(mockHandle.anki.currentDeckId).toBe(words);
    expect(mockHandle.anki.studyOwner).toBeNull();
    expect(changes).toEqual([
      { owner: 'tab', preempted: null },
      { owner: 'panel', preempted: 'tab' },
      { owner: null, preempted: null },
    ]);
    expect(await mockClient.ankiMiniReviewClose()).toEqual({ restoredDeckId: null });
    expect(changes).toHaveLength(3);
    const kinds = mockHandle.anki.logs.map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(['studyOwner', 'miniReviewOpen', 'miniReviewClose']));
    stop();
  });

  it('after a tab preemption the tab keeps its deck', async () => {
    const changes: StudyOwnerChange[] = [];
    const stop = mockClient.onStudyOwner((c) => changes.push(c));
    const words = await deckId('5000 palavras');
    const math = await deckId('Matemática');
    await mockClient.ankiSetCurrentDeck(words);
    await mockClient.ankiMiniReviewOpen(await deckId('Livros::Animal Farm'));
    await mockClient.ankiStudyNext(math, 'tab');
    expect(changes.at(-1)).toEqual({ owner: 'tab', preempted: 'panel' });
    await mockClient.ankiStudyClose('panel');
    expect(await mockClient.ankiMiniReviewClose()).toEqual({ restoredDeckId: null });
    expect(mockHandle.anki.currentDeckId).toBe(math);
    expect(mockHandle.anki.studyOwner).toBe('tab');
    expect(changes).toHaveLength(2);
    stop();
  });
});

describe('book panel', () => {
  it('falls back to Livros::<Título> and follows the vocabulary folder', async () => {
    const book = await farmBook();
    const info = await mockClient.bookPanelInfo(book.bookUid);
    expect(info.vocabDeck).toMatchObject({ role: 'vocab', name: 'Livros::Animal Farm', exists: true });
    expect(info.vocabDeck.counts).not.toBeNull();
    expect(info.contentDeck).toBeNull();
    const oxford = await deckId('Oxford');
    mockHandle.setVocabRoot(oxford);
    const rooted = await mockClient.bookPanelInfo(book.bookUid);
    expect(rooted.vocabRootName).toBe('Oxford');
    expect(rooted.vocabDeck).toEqual({
      role: 'vocab',
      deckId: null,
      name: 'Oxford::Livros::Animal Farm',
      exists: false,
      counts: null,
    });
    await expect(mockClient.bookPanelInfo('f'.repeat(64))).rejects.toMatchObject({ code: 'book_not_found' });
  });

  it('sets the content deck and the preferences; refuses missing decks', async () => {
    const book = await farmBook();
    const math = await deckId('Matemática');
    const farm = await deckId('Livros::Animal Farm');
    const info = await mockClient.bookPanelSet(book.bookUid, {
      contentDeckId: math,
      lastDeckId: farm,
      lastKind: 'cloze',
      reviewDeckId: math,
    });
    expect(info.contentDeck).toMatchObject({ deckId: math, name: 'Matemática', exists: true });
    expect([info.lastDeckId, info.lastKind, info.reviewDeckId]).toEqual([farm, 'cloze', math]);
    expect(mockHandle.books.find((b) => b.bookUid === book.bookUid)?.contentDeckId).toBe(math);
    const cleared = await mockClient.bookPanelSet(book.bookUid, { contentDeckId: null, lastKind: null });
    expect(cleared.contentDeck).toBeNull();
    expect(cleared.lastKind).toBeNull();
    expect(cleared.lastDeckId).toBe(farm);
    await expect(mockClient.bookPanelSet(book.bookUid, { reviewDeckId: 424242 })).rejects.toMatchObject({
      code: 'deck_not_found',
    });
    await mockClient.ankiDeckDelete(math);
    expect((await mockClient.bookPanelInfo(book.bookUid)).reviewDeckId).toBeNull();
  });

  it('lists the cards of the book by page, with one on page 1', async () => {
    const book = await farmBook();
    const cards = await mockClient.ankiBookCards(book.bookUid);
    expect(cards.map((c) => c.page)).toEqual([1, 37]);
    expect(cards[0]).toMatchObject({ query: 'Manor Farm', notetype: 'Básico (Leitor)' });
    await expect(mockClient.ankiBookCards('ABC')).rejects.toMatchObject({ code: 'anki_invalid_input' });
  });

  it('defines one word: lemma, and the note under the vocabulary folder', async () => {
    await expect(mockClient.vocabDefine('two words', null)).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Selecione uma só palavra.',
    });
    expect(await mockClient.vocabDefine(' Animals, ', null)).toMatchObject({
      word: 'Animals',
      lemma: 'animal',
      note: null,
    });
    expect((await mockClient.vocabDefine('ran', null)).lemma).toBe('run');
    mockHandle.setVocabRoot(await deckId('5000 palavras'));
    const def = await mockClient.vocabDefine('windmills', null);
    expect(def.lemma).toBe('windmill');
    expect(def.note).toMatchObject({ deckName: '5000 palavras', notetype: 'Vocabulário · Livro' });
    expect(def.note?.definition).toBeTruthy();
  });

  it('without a vocabulary folder, finds the note in the book deck Livros::<Título>', async () => {
    const book = await farmBook();
    const farm = await deckId('Livros::Animal Farm');
    const nt = (await mockClient.ankiNotetypes()).find((n) => n.name === 'Vocabulário · Livro')!;
    const fields = nt.fields.map((f) =>
      f.name === 'Palavra' ? 'barns' : f.name === 'Lema' ? 'barn' : f.name === 'Definição' ? 'a farm building' : '',
    );
    const added = await mockClient.ankiNoteAdd({ notetypeId: nt.id, deckId: farm, fields, tags: [] });
    const def = await mockClient.vocabDefine('barn', book.bookUid);
    expect(def.vocabRootDeckId).toBeNull();
    expect(def.note).toMatchObject({
      noteId: added.noteId,
      deckName: 'Livros::Animal Farm',
      definition: 'a farm building',
    });
    expect((await mockClient.vocabDefine('barn', null)).note).toBeNull();
    expect((await mockClient.vocabDefine('barn', 'f'.repeat(64))).note).toBeNull();
    // A chosen folder wins over the book's deck.
    mockHandle.setVocabRoot(await deckId('5000 palavras'));
    expect((await mockClient.vocabDefine('barn', book.bookUid)).note).toBeNull();
  });
});

describe('deep links', () => {
  const uid = 'a'.repeat(64);

  it('emits valid links once and ignores invalid ones', () => {
    const got: unknown[] = [];
    const stop = mockClient.onDeepLink((l) => got.push(l));
    mockHandle.deepLink(`leitor://livro/${uid}?pagina=3&q=the%20windmill`);
    mockHandle.deepLink(`LEITOR://Livro/${uid}?pagina=4`);
    // EPUB (spec 7.1): a chapter with its CFI; a malformed CFI is dropped, the link still opens the chapter.
    mockHandle.deepLink(`leitor://livro/${uid}?cap=3&cfi=${encodeURIComponent('epubcfi(/6/8!/4/2/1:0)')}&q=Filby`);
    mockHandle.deepLink(`leitor://livro/${uid}?cap=2&cfi=nonsense`);
    for (const bad of [
      `leitor://livro/${uid.toUpperCase()}?pagina=1`,
      `leitor://livro/${uid}?pagina=0`,
      `leitor://livro/${uid}`,
      `leitor://outro/${uid}?pagina=1`,
      `https://livro/${uid}?pagina=1`,
      `leitor://livro/${uid}?pagina=1&q=${'x'.repeat(5000)}`,
    ])
      mockHandle.deepLink(bad);
    stop();
    expect(got).toEqual([
      { bookUid: uid, page: 3, unit: 'page', cfi: null, query: 'the windmill' },
      { bookUid: uid, page: 4, unit: 'page', cfi: null, query: null },
      { bookUid: uid, page: 3, unit: 'chapter', cfi: 'epubcfi(/6/8!/4/2/1:0)', query: 'Filby' },
      { bookUid: uid, page: 2, unit: 'chapter', cfi: null, query: null },
    ]);
  });

  it('hands the launch links over once', async () => {
    mockHandle.setPendingDeepLinks([`leitor://livro/${uid}?pagina=2`, 'leitor://nada']);
    expect(await mockClient.pendingDeepLinks()).toEqual([
      { bookUid: uid, page: 2, unit: 'page', cfi: null, query: null },
    ]);
    expect(await mockClient.pendingDeepLinks()).toEqual([]);
  });
});
