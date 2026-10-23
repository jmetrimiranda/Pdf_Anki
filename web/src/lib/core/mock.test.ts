import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePdf, pdfBytesToLatin1 } from '../pdf/minimalPdf';
import { findLeitorBookUid, mockClient, mockHandle } from './mock';
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
    expect(await mockClient.positionGet(farm.bookUid)).toMatchObject({ page: 9, progress: 1 });
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
