import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePdf, pdfBytesToLatin1 } from '../pdf/minimalPdf';
import { findLeitorBookUid, mockClient, mockHandle } from './mock';
import { tauriClient } from './tauri';
import { CoreError, type DeckNode, type LibraryEntry } from './types';

function walk(nodes: DeckNode[], fn: (n: DeckNode) => void) {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

async function bookByTitle(title: string): Promise<LibraryEntry> {
  const book = (await mockClient.libraryList()).find((b) => b.title === title);
  if (!book) throw new Error(`no book ${title}`);
  return book;
}

function stamp(bytes: ArrayBuffer, uid: string): ArrayBuffer {
  // What the bridge does at save time: same document, LeitorBookUid in the Info dict.
  const s = pdfBytesToLatin1(new Uint8Array(bytes));
  const title = /\/Title \(([^)]*)\)/.exec(s)?.[1] ?? 'x';
  return makePdf({ pages: 3, title, leitorBookUid: uid, highlight: true }).buffer as ArrayBuffer;
}

beforeEach(() => mockHandle.reset());

describe('mock core client', () => {
  it('returns a deck tree shaped like the contract', async () => {
    const tree = await mockClient.ankiDeckTree();
    const names: string[] = [];
    walk(tree.decks, (n) => {
      names.push(n.fullName);
      expect(n.fullName.split('::').length).toBe(n.level);
    });
    expect(names).toEqual(expect.arrayContaining(['5000 palavras', 'Oxford', 'Vocabulário::Livros::Teste']));
    expect(tree.studiedToday).toEqual({ cards: expect.any(Number), seconds: expect.any(Number) });
    expect(names).toEqual(expect.arrayContaining(['Matemática', 'Gramática::Cloze', 'Livros::Animal Farm']));
    // The empty Default deck is hidden, like Anki; the current deck is a real one.
    expect(names).not.toContain('Default');
    const words = tree.decks.find((d) => d.name === '5000 palavras')!;
    expect([words.newCount, words.learnCount, words.reviewCount]).toEqual([0, 17, 1002]);
    expect(words.filtered).toBe(false);
    expect(words.total).toBeGreaterThan(1002);
    expect(tree.currentDeckId).toBe(words.id);
  });

  it('seeds three books: text, scanned and one in a collection', async () => {
    const books = await mockClient.libraryList();
    expect(books.map((b) => b.title).sort()).toEqual(['Animal Farm', 'Apostila digitalizada', 'ROS 2 na prática']);
    for (const b of books) {
      expect(b.bookUid).toMatch(/^[0-9a-f]{64}$/);
      expect(b.fileHash).toBe(b.bookUid);
      expect(b.fileVersion).toBe(1);
      expect(b.format).toBe('pdf');
    }
    expect((await bookByTitle('ROS 2 na prática')).pages).toBe(12);
    expect((await bookByTitle('Apostila digitalizada')).hasText).toBe(false);
    expect((await bookByTitle('Animal Farm')).collectionFolder).toBe('Inglês');
    expect((await bookByTitle('ROS 2 na prática')).position?.page).toBe(4);
  });

  it('adds, detects duplicates, updates and removes/restores books', async () => {
    const added = await mockClient.libraryAdd('/tmp/Novo livro.pdf');
    expect(added.outcome).toBe('created');
    expect(added.book.title).toBe('Novo livro');
    expect(added.book.fileName).toBe('Novo livro.pdf');
    expect((await mockClient.libraryAdd('/tmp/Novo livro.pdf')).outcome).toBe('existing');

    const renamed = await mockClient.libraryUpdate(added.book.bookUid, {
      title: ' Outro ',
      collectionFolder: 'Robótica',
    });
    expect(renamed.title).toBe('Outro');
    expect(renamed.collectionFolder).toBe('Robótica');
    expect(
      (await mockClient.libraryUpdate(added.book.bookUid, { collectionFolder: null })).collectionFolder,
    ).toBeNull();
    expect((await mockClient.libraryUpdate(added.book.bookUid, { pages: 9 })).pages).toBe(9);
    await expect(mockClient.libraryUpdate(added.book.bookUid, { title: '  ' })).rejects.toMatchObject({
      code: 'invalid_input',
    });

    await mockClient.libraryRemove(added.book.bookUid);
    expect((await mockClient.libraryList()).some((b) => b.bookUid === added.book.bookUid)).toBe(false);
    await expect(mockClient.bookOpen(added.book.bookUid)).rejects.toBeInstanceOf(CoreError);
    expect((await mockClient.libraryAdd('/tmp/Novo livro.pdf')).outcome).toBe('restored');
  });

  it('rejects corrupted and unsupported files with typed pt-BR errors', async () => {
    await expect(mockClient.libraryAdd('/tmp/corrompido.pdf')).rejects.toMatchObject({
      name: 'CoreError',
      code: 'pdf_invalid',
      message: expect.stringMatching(/corrompido/),
    });
    await expect(mockClient.libraryAdd('/tmp/notas.txt')).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(mockClient.libraryRemove('f'.repeat(64))).rejects.toMatchObject({ code: 'book_not_found' });
    await expect(mockClient.bookBytes('nope')).rejects.toMatchObject({ code: 'book_not_found' });
  });

  it('opens a book at its last page and serves real PDF bytes', async () => {
    const ros = await bookByTitle('ROS 2 na prática');
    const opened = await mockClient.bookOpen(ros.bookUid);
    expect(opened.page).toBe(4);
    expect(opened.book.bookUid).toBe(ros.bookUid);
    const bytes = await mockClient.bookBytes(ros.bookUid);
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    const s = pdfBytesToLatin1(new Uint8Array(bytes));
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s.match(/\/Type \/Page(?![s\w])/g)).toHaveLength(12);
    expect((await mockClient.bookOpen((await bookByTitle('Apostila digitalizada')).bookUid)).page).toBe(0);
  });

  it('stores saved versions only with a PDF header and the right LeitorBookUid', async () => {
    const ros = await bookByTitle('ROS 2 na prática');
    const original = await mockClient.bookBytes(ros.bookUid);
    await expect(
      mockClient.bookSaveVersion(ros.bookUid, new TextEncoder().encode('nope').buffer as ArrayBuffer),
    ).rejects.toMatchObject({
      code: 'pdf_invalid',
    });
    await expect(mockClient.bookSaveVersion(ros.bookUid, original)).rejects.toMatchObject({ code: 'book_uid_missing' });
    await expect(mockClient.bookSaveVersion(ros.bookUid, stamp(original, 'b'.repeat(64)))).rejects.toMatchObject({
      code: 'book_uid_missing',
    });

    const v2 = stamp(original, ros.bookUid);
    const saved = await mockClient.bookSaveVersion(ros.bookUid, v2);
    expect(saved).toMatchObject({ fileVersion: 2, changed: true });
    expect(await mockClient.bookSaveVersion(ros.bookUid, v2)).toMatchObject({ fileVersion: 2, changed: false });
    const after = await bookByTitle('ROS 2 na prática');
    expect(after.bookUid).toBe(ros.bookUid);
    expect(after.fileHash).toBe(saved.fileHash);
    expect(after.fileVersion).toBe(2);
    expect(after.pages).toBe(3);
    expect(findLeitorBookUid(new Uint8Array(await mockClient.bookBytes(ros.bookUid)))).toBe(ros.bookUid);
    expect(mockHandle.savedVersions).toEqual([
      expect.objectContaining({ uid: ros.bookUid, fileVersion: 2, hasBookUid: true }),
    ]);
    expect(mockClient.coverUrl(ros.bookUid, 2)).toMatch(/^data:image\/svg\+xml/);
  });

  it('recognizes an exported annotated copy as a new version of the same book', async () => {
    const farm = await bookByTitle('Animal Farm');
    const annotated = stamp(await mockClient.bookBytes(farm.bookUid), farm.bookUid);
    mockHandle.setNextExportPath('/tmp/Animal Farm (anotado).pdf');
    expect(await mockClient.pickExportPath('Animal Farm.pdf')).toBe('/tmp/Animal Farm (anotado).pdf');
    await mockClient.exportBytes('/tmp/Animal Farm (anotado).pdf', annotated);
    // A different version of a library book: nothing changes until the user confirms.
    const asked = await mockClient.libraryAdd('/tmp/Animal Farm (anotado).pdf');
    expect(asked.outcome).toBe('otherVersion');
    expect(asked.book.fileVersion).toBe(1);
    const again = await mockClient.libraryAdd('/tmp/Animal Farm (anotado).pdf', { replace: true });
    expect(again.outcome).toBe('newVersion');
    expect(again.book.bookUid).toBe(farm.bookUid);
    expect(again.book.fileVersion).toBe(2);

    mockHandle.setNextExportPath('/tmp/copia.pdf');
    await mockClient.pickExportPath('copia.pdf');
    await mockClient.bookExport(farm.bookUid, '/tmp/copia.pdf');
    expect(mockHandle.files).toContain('/tmp/copia.pdf');
    expect((await mockClient.libraryAdd('/tmp/copia.pdf')).outcome).toBe('existing');
  });

  it('only exports to the path just chosen in the save dialog, once', async () => {
    const farm = await bookByTitle('Animal Farm');
    await expect(mockClient.bookExport(farm.bookUid, '/home/jorge/tese.pdf')).rejects.toMatchObject({
      code: 'export_not_granted',
    });
    await expect(mockClient.exportBytes('/home/jorge/tese.pdf', new ArrayBuffer(4))).rejects.toMatchObject({
      code: 'export_not_granted',
    });
    const path = await mockClient.pickExportPath('Animal Farm.pdf');
    await mockClient.bookExport(farm.bookUid, path!);
    await expect(mockClient.bookExport(farm.bookUid, path!)).rejects.toMatchObject({ code: 'export_not_granted' });
    expect(mockHandle.files).not.toContain('/home/jorge/tese.pdf');
  });

  it('keeps positions and logs reading sessions', async () => {
    const farm = await bookByTitle('Animal Farm');
    expect((await mockClient.positionGet(farm.bookUid))?.page).toBe(1);
    await mockClient.positionSet(farm.bookUid, 7, 0.8);
    expect(await mockClient.positionGet(farm.bookUid)).toMatchObject({ page: 7, progress: 0.8 });
    await mockClient.positionSet(farm.bookUid, 99, 5);
    expect(await mockClient.positionGet(farm.bookUid)).toMatchObject({ page: farm.pages - 1, progress: 1 });
    expect(await mockClient.positionGet((await bookByTitle('Apostila digitalizada')).bookUid)).toBeNull();

    await mockClient.readingSessionStart(farm.bookUid, 7);
    await mockClient.readingSessionHeartbeat(farm.bookUid, 8);
    await mockClient.readingSessionStop(farm.bookUid, 'tab');
    expect(mockHandle.sessions.map((e) => [e.kind, e.page, e.reason])).toEqual([
      ['start', 7, null],
      ['heartbeat', 8, null],
      ['stop', null, 'tab'],
    ]);
  });

  it('lays words out with Helvetica’s widths, from the file’s own text when it was imported', async () => {
    const bytes = makePdf({
      pages: 2,
      title: 'Importado',
      textPerPage: (i) => `Page ${i + 1}\nThe windmill was WIDE.`,
    });
    const path = '/tmp/importado.pdf';
    mockHandle.setNextExportPath(path);
    expect(await mockClient.pickExportPath('importado.pdf')).toBe(path);
    await mockClient.exportBytes(path, bytes.buffer as ArrayBuffer);
    const added = await mockClient.libraryAdd(path);
    const words = await mockClient.docWords(added.book.bookUid, 1);
    expect(words.text).toBe('Page 2\nThe windmill was WIDE.\n');
    const wide = words.words.find((w) => w.text === 'WIDE')!;
    const the = words.words.find((w) => w.text === 'The')!;
    // T 611 + h 556 + e 556 = 1723/1000 em at 11 pt.
    expect(the.rects[0]![2]).toBeCloseTo(1.723 * 11, 5);
    expect(the.rects[0]![0]).toBe(72);
    // W 944 + I 278 + D 722 + E 667.
    expect(wide.rects[0]![2]).toBeCloseTo(2.611 * 11, 5);
  });

  it('returns words whose offsets index the page text; none for a scanned book', async () => {
    const ros = await bookByTitle('ROS 2 na prática');
    const words = await mockClient.docWords(ros.bookUid, 0);
    expect(words.words.length).toBeGreaterThan(50);
    for (const w of words.words) {
      expect(words.text.slice(w.start, w.end)).toBe(w.text);
      const [x, y, rw, rh] = w.rects[0]!;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + rw).toBeLessThanOrEqual(words.width);
      expect(y + rh).toBeLessThanOrEqual(words.height);
    }
    await expect(mockClient.docWords(ros.bookUid, 99)).rejects.toMatchObject({ code: 'page_out_of_range' });
    expect((await mockClient.docWords((await bookByTitle('Apostila digitalizada')).bookUid, 0)).words).toEqual([]);
  });

  it('drives the platform helpers through the test handle', async () => {
    mockHandle.setNextPick(['/a/um.pdf', '/a/dois.pdf']);
    expect(await mockClient.pickBookFiles()).toEqual(['/a/um.pdf', '/a/dois.pdf']);
    expect((await mockClient.pickBookFiles()).length).toBe(1);
    expect(await mockClient.pickExportPath('Livro.pdf')).toBe('/home/jorge/Exportados/Livro.pdf');
    mockHandle.setNextExportPath(null);
    expect(await mockClient.pickExportPath('Livro.pdf')).toBeNull();

    mockHandle.setPendingOpen(['/x/aberto.pdf']);
    expect(await mockClient.pendingOpenPaths()).toEqual(['/x/aberto.pdf']);
    expect(await mockClient.pendingOpenPaths()).toEqual([]);

    const opened: string[][] = [];
    const dropped: string[][] = [];
    const stopOpen = mockClient.onOpenPaths((p) => opened.push(p));
    const stopDrop = mockClient.onDragDropPaths((p) => dropped.push(p));
    mockHandle.openPaths(['/o.pdf']);
    mockHandle.dropPaths(['/d.pdf']);
    stopOpen();
    stopDrop();
    mockHandle.openPaths(['/ignored.pdf']);
    expect(opened).toEqual([['/o.pdf']]);
    expect(dropped).toEqual([['/d.pdf']]);
    expect(typeof mockClient.onWindowCloseRequested(async () => true)).toBe('function');

    const farm = await bookByTitle('Animal Farm');
    await mockClient.bookOpenExternal(farm.bookUid);
    expect(mockHandle.openedExternally).toEqual([farm.bookUid]);
    await expect(mockClient.devLog('info', 'x')).resolves.toBeUndefined();

    const smoke = await mockClient.devSmoke();
    expect(smoke.doc.pageCount).toBe(12);
    expect(smoke.page1DataUrl).toMatch(/^data:image\//);
    expect(smoke.words).toBeGreaterThan(0);
    expect(Object.keys(smoke.millis).sort()).toEqual(['anki', 'cover', 'pdfOpen', 'pdfText']);
  });

  it('persists its state in sessionStorage across a module re-import (app restart)', async () => {
    const added = await mockClient.libraryAdd('/tmp/Persistente.pdf');
    await mockClient.positionSet(added.book.bookUid, 3, 0.5);
    expect(sessionStorage.getItem('leitor.mock')).toContain('Persistente');

    vi.resetModules();
    const fresh = await import('./mock');
    const books = await fresh.mockClient.libraryList();
    const again = books.find((b) => b.bookUid === added.book.bookUid);
    expect(again?.title).toBe('Persistente');
    expect(again?.position?.page).toBe(3);

    // Corrupt storage falls back to the seed.
    sessionStorage.setItem('leitor.mock', '{not json');
    vi.resetModules();
    const seeded = await import('./mock');
    expect(await seeded.mockClient.libraryList()).toHaveLength(3);
  });
});

describe('mock core parity', () => {
  it('implements every command of the Tauri client, as functions', () => {
    expect(Object.keys(mockClient).sort()).toEqual(Object.keys(tauriClient).sort());
    for (const [key, value] of Object.entries(mockClient)) {
      if (key === 'kind') continue;
      expect(typeof value, key).toBe('function');
    }
  });
});

describe('mock Anki decks', () => {
  const find = async (name: string) => (await mockClient.ankiDeckNames()).find((d) => d.name === name);

  it('creates decks with missing parents and validates names', async () => {
    const id = await mockClient.ankiDeckCreate(' Novo :: Sub ');
    expect((await find('Novo::Sub'))?.id).toBe(id);
    expect(await find('Novo')).toBeTruthy();
    expect(await mockClient.ankiDeckCreate('Novo::Sub')).toBe(id);
    await expect(mockClient.ankiDeckCreate('A::  ::B')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('renames and moves a deck with its subdecks; never into itself', async () => {
    const ros = (await find('ROS 2 — Revisão'))!;
    await mockClient.ankiDeckRename(ros.id, 'Robótica::ROS 2');
    expect(await find('Robótica::ROS 2::Comandos')).toBeTruthy();
    await mockClient.ankiDeckMove([ros.id], null);
    expect(await find('ROS 2::Comandos')).toBeTruthy();
    const child = (await find('ROS 2::Comandos'))!;
    await mockClient.ankiDeckMove([ros.id], child.id);
    expect(await find('ROS 2::Comandos')).toBeTruthy();
    const oxford = (await find('Oxford'))!;
    await mockClient.ankiDeckMove([ros.id], oxford.id);
    expect(await find('Oxford::ROS 2::Conceitos')).toBeTruthy();
  });

  it('deletes a deck and its cards, persists collapse and the current deck', async () => {
    const math = (await find('Matemática'))!;
    const before = (await mockClient.ankiDeckTree()).decks.find((d) => d.id === math.id)!;
    expect(before.total).toBe(2);
    expect(await mockClient.ankiDeckDelete(math.id)).toEqual({ cardsDeleted: 2 });
    expect(await find('Matemática')).toBeUndefined();
    expect(mockHandle.anki.logs.at(-1)).toMatchObject({ kind: 'deleteDeck', cardsDeleted: 2 });

    const oxford = (await find('Oxford'))!;
    await mockClient.ankiDeckSetCollapsed(oxford.id, true);
    await mockClient.ankiSetCurrentDeck(oxford.id);
    vi.resetModules();
    const fresh = await import('./mock');
    const tree = await fresh.mockClient.ankiDeckTree();
    expect(tree.decks.find((d) => d.id === oxford.id)?.collapsed).toBe(true);
    expect(tree.currentDeckId).toBe(oxford.id);
  });

  it('prepares the collection idempotently', async () => {
    const first = await mockClient.ankiPrepareCollection();
    expect(first.created.sort()).toEqual(['Cloze (Leitor)']);
    expect(first.existing.sort()).toEqual([
      'Básico (Leitor)',
      'Código · Comando',
      'Código · Programa',
      'Vocabulário · Livro',
    ]);
    const second = await mockClient.ankiPrepareCollection();
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(5);
  });

  it('picks, imports, exports and backs up', async () => {
    expect(await mockClient.ankiPickPackage()).toMatch(/\.apkg$/);
    mockHandle.anki.setNextPackagePick(null);
    expect(await mockClient.ankiPickPackage()).toBeNull();

    const changed = vi.fn();
    const stop = mockClient.onAnkiChanged(changed);
    const summary = await mockClient.ankiImport('/tmp/Fazenda.apkg');
    expect(summary).toEqual({ added: 3, updated: 0, duplicates: 0, conflicts: 0, skipped: 0 });
    expect((await mockClient.ankiImport('/tmp/Fazenda.apkg')).duplicates).toBe(3);
    expect(changed).toHaveBeenCalledWith({ reason: 'import' });
    stop();
    await expect(mockClient.ankiImport('/tmp/corrompido.apkg')).rejects.toMatchObject({
      code: 'anki_invalid_package',
    });

    const words = (await find('5000 palavras'))!;
    await expect(
      mockClient.ankiExport(words.id, '/tmp/x.apkg', { withScheduling: true, withMedia: true }),
    ).rejects.toMatchObject({
      code: 'export_not_granted',
    });
    const path = await mockClient.pickExportPath('5000 palavras.apkg', 'apkg');
    expect(path).toBe('/home/jorge/Exportados/5000 palavras.apkg');
    const result = await mockClient.ankiExport(words.id, path!, { withScheduling: false, withMedia: true });
    expect(result.notes).toBe(7);
    expect(mockHandle.anki.logs.at(-1)).toMatchObject({ kind: 'export', path, withScheduling: false, withMedia: true });

    const before = (await mockClient.ankiBackups()).length;
    const manual = await mockClient.ankiBackupNow();
    expect(manual.kind).toBe('manual');
    expect(manual.fileName).toMatch(/\.colpkg$/);
    expect(await mockClient.ankiBackups()).toHaveLength(before + 1);
  });

  it('replaces the collection with a .colpkg after a pre-import backup', async () => {
    const backup = await mockClient.ankiImportColpkg('/tmp/colecao.colpkg');
    expect(backup.kind).toBe('preImport');
    const names = (await mockClient.ankiDeckTree()).decks.map((d) => d.name);
    expect(names).toEqual(['5000 palavras', 'Oxford', 'ROS 2 — Revisão']);
    expect((await mockClient.ankiBackups()).some((b) => b.path === backup.path)).toBe(true);
    await expect(mockClient.ankiImportColpkg('/tmp/x.apkg')).rejects.toMatchObject({ code: 'anki_invalid_package' });
  });

  it('keeps only the last 7 daily backups', async () => {
    const realNow = Date.now;
    let now = realNow();
    try {
      Date.now = () => now;
      for (let i = 0; i < 10; i++) {
        now += 86_400_000 + 1000;
        mockHandle.anki.dailyBackup();
      }
      expect(mockHandle.anki.dailyBackup()).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(mockHandle.anki.backups.filter((b) => b.kind === 'daily')).toHaveLength(7);
  });

  it('points Anki pages at the mock page server and fires page events', () => {
    expect(mockClient.ankiPageUrl('deck-options/5', true)).toMatch(/\/__mock-anki-page\/deck-options\/5#night$/);
    const seen = vi.fn();
    const stop = mockClient.onAnkiPageEvent(seen);
    mockHandle.anki.firePageEvent({ kind: 'close' });
    stop();
    mockHandle.anki.firePageEvent({ kind: 'ready' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('links the Fonte field of the Animal Farm note to the mock library book', async () => {
    const farm = await bookByTitle('Animal Farm');
    const raw = sessionStorage.getItem('leitor.mock.anki') ?? '';
    expect(raw).toContain(`leitor://livro/${farm.bookUid}?pagina=37`);
  });
});
