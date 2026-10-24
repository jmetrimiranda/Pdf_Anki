// The mock's EPUB side (spec 7.1, 14, 15): the sample book in the library, imports, positions with a CFI,
// annotations with tombstones that survive a restart, and the vocabulary scan by chapters / EPUB TOC with its marks.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_EPUB_CHAPTERS } from '../../epub/build';
import { mockClient, mockHandle } from '../mock';
import type { EpubAnnotationInput, JobProgress, LibraryEntry, VocabConfig } from '../types';
import { epubOutline, isEpubBytes, isValidCfi } from './epub';
import { DEFAULT_VOCAB_CONFIG } from './vocab';

beforeEach(() => mockHandle.reset());

async function timeMachine(): Promise<LibraryEntry> {
  const b = (await mockClient.libraryList()).find((x) => x.title === 'The Time Machine');
  if (!b) throw new Error('no EPUB');
  return b;
}

const CFI = 'epubcfi(/6/8!/4/2/4,/1:0,/1:24)';

function input(bookUid: string, patch: Partial<EpubAnnotationInput> = {}): EpubAnnotationInput {
  return {
    uid: 'ann-1',
    bookUid,
    kind: 'highlight',
    cfi: CFI,
    text: 'The Time Traveller',
    color: '#fff000',
    comment: null,
    ...patch,
  };
}

async function finish(jobId: string): Promise<JobProgress[]> {
  const seen: JobProgress[] = [];
  await new Promise<void>((resolve) => {
    const stop = mockClient.onJobProgress(jobId, (p) => {
      seen.push(p);
      if (['done', 'failed', 'cancelled'].includes(p.stage)) {
        stop();
        resolve();
      }
    });
  });
  return seen;
}

describe('mock EPUB books', () => {
  it('seeds "The Time Machine" as an EPUB whose bytes are a real EPUB', async () => {
    const book = await timeMachine();
    expect(book).toMatchObject({ format: 'epub', pages: SAMPLE_EPUB_CHAPTERS.length, hasText: true });
    const bytes = new Uint8Array(await mockClient.bookBytes(book.bookUid));
    expect(isEpubBytes(bytes)).toBe(true);
    const open = await mockClient.bookOpen(book.bookUid);
    expect(open).toMatchObject({ format: 'epub', cfi: null, page: 0 });
    await expect(mockClient.docWords(book.bookUid, 0)).rejects.toMatchObject({ code: 'not_pdf' });
    await expect(mockClient.vocabEpubMarks(book.bookUid, [1])).rejects.toMatchObject({ code: 'vocab_not_scanned' });
  });

  it('imports .epub paths and rejects corrupt and DRM ones with pt-BR errors', async () => {
    const added = await mockClient.libraryAdd('/home/jorge/Livros/Hábitos.epub');
    expect(added).toMatchObject({ outcome: 'created', book: { format: 'epub', title: 'Hábitos', pages: 3 } });
    expect(added.book.fileName).toBe('Hábitos.epub');
    expect((await mockClient.libraryAdd('/home/jorge/Livros/Hábitos.epub')).outcome).toBe('existing');
    await expect(mockClient.libraryAdd('/tmp/corrompido.epub')).rejects.toMatchObject({ code: 'epub_invalid' });
    await expect(mockClient.libraryAdd('/tmp/com drm.epub')).rejects.toMatchObject({ code: 'epub_drm' });
    await expect(mockClient.libraryAdd('/tmp/x.mobi')).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  it('keeps the position with its CFI (only for EPUBs) and opens there', async () => {
    const book = await timeMachine();
    await mockClient.positionSet(book.bookUid, 3, 0.45, CFI);
    expect(await mockClient.positionGet(book.bookUid)).toMatchObject({ page: 3, cfi: CFI, progress: 0.45 });
    expect(await mockClient.bookOpen(book.bookUid)).toMatchObject({ page: 3, cfi: CFI, format: 'epub' });
    const pdf = (await mockClient.libraryList()).find((b) => b.title === 'Animal Farm')!;
    await mockClient.positionSet(pdf.bookUid, 2, 0.1, CFI);
    expect((await mockClient.positionGet(pdf.bookUid))?.cfi).toBeNull();
    expect((await mockClient.bookOpen(pdf.bookUid)).cfi).toBeNull();
  });

  it('builds the TOC outline with nested chapters', () => {
    const outline = epubOutline('sample');
    expect(outline.map((o) => [o.title, o.page])).toEqual([
      ['Part I', 0],
      ['Part II', 4],
    ]);
    expect(outline[0]!.children!.map((c) => c.page)).toEqual([1, 2, 3]);
  });
});

describe('mock EPUB annotations', () => {
  it('creates, updates, lists and tombstones annotations', async () => {
    const uid = (await timeMachine()).bookUid;
    const created = await mockClient.epubAnnotationUpsert(input(uid));
    expect(created).toMatchObject({
      uid: 'ann-1',
      bookUid: uid,
      kind: 'highlight',
      cfi: CFI,
      section: 3,
      color: '#fff000',
    });
    const updated = await mockClient.epubAnnotationUpsert(input(uid, { kind: 'note', comment: 'Filby duvida.' }));
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    await mockClient.epubAnnotationUpsert(input(uid, { uid: 'bm-1', kind: 'bookmark', color: null, text: null }));
    expect((await mockClient.epubAnnotationList(uid)).map((a) => [a.uid, a.kind]).sort()).toEqual([
      ['ann-1', 'note'],
      ['bm-1', 'bookmark'],
    ]);

    await mockClient.epubAnnotationDelete('ann-1');
    await mockClient.epubAnnotationDelete('ann-1'); // a no-op the second time
    expect((await mockClient.epubAnnotationList(uid)).map((a) => a.uid)).toEqual(['bm-1']);
    const rows = mockHandle.epub.annotations;
    expect(rows.find((a) => a.uid === 'ann-1')).toMatchObject({ deleted: true });
    expect(Object.keys((await mockClient.epubAnnotationList(uid))[0]!).sort()).toEqual([
      'bookUid',
      'cfi',
      'color',
      'comment',
      'kind',
      'section',
      'text',
      'uid',
      'updatedAt',
    ]);
  });

  it('validates the input and the book like the core', async () => {
    const uid = (await timeMachine()).bookUid;
    const pdf = (await mockClient.libraryList()).find((b) => b.format === 'pdf')!;
    await expect(mockClient.epubAnnotationUpsert(input(uid, { cfi: 'not a cfi' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(mockClient.epubAnnotationUpsert(input(uid, { uid: '' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(mockClient.epubAnnotationUpsert(input(pdf.bookUid))).rejects.toMatchObject({ code: 'not_epub' });
    // Unknown keys are refused (`deny_unknown_fields`); a missing uid gets a new one.
    await expect(
      mockClient.epubAnnotationUpsert({ ...input(uid), extra: 1 } as unknown as EpubAnnotationInput),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const fresh = await mockClient.epubAnnotationUpsert({ ...input(uid), uid: null });
    expect(fresh.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.section).toBe(3);
    await expect(mockClient.epubAnnotationList('0'.repeat(64))).rejects.toMatchObject({ code: 'book_not_found' });
    expect(isValidCfi(CFI)).toBe(true);
    expect(isValidCfi('epubcfi()')).toBe(false);
  });

  it('survives a restart (module re-import) and is tombstoned with the book', async () => {
    const uid = (await timeMachine()).bookUid;
    await mockClient.epubAnnotationUpsert(input(uid));
    vi.resetModules();
    const fresh = await import('../mock');
    expect((await fresh.mockClient.epubAnnotationList(uid)).map((a) => a.uid)).toEqual(['ann-1']);
    await fresh.mockClient.libraryRemove(uid);
    expect(fresh.mockHandle.epub.annotations.every((a) => a.deleted)).toBe(true);
  });
});

describe('mock EPUB vocabulary', () => {
  const config: VocabConfig = DEFAULT_VOCAB_CONFIG;

  async function root(): Promise<number> {
    return (await mockClient.ankiDeckNames()).find((d) => d.name === 'Vocabulário')!.id;
  }

  it('resolves ranges by chapters and by the EPUB TOC, with chapter wording', async () => {
    const uid = (await timeMachine()).bookUid;
    const outline = await mockClient.vocabOutline(uid);
    expect(outline.pageCount).toBe(8);
    expect(outline.items[0]).toMatchObject({ title: 'Part I', startPage: 0, endPage: 3 });
    expect(outline.items[0]!.children.map((c) => c.title)).toEqual([
      'Chapter I. Introduction',
      'Chapter II. The Machine',
      'Chapter III. The Time Traveller Returns',
    ]);
    const third = outline.items[0]!.children[2]!;
    expect(await mockClient.vocabRangeCheck(uid, { kind: 'outline', ids: [third.id] })).toMatchObject({
      pages: [[3, 3]],
      display: 'Chapter III. The Time Traveller Returns (cap. 4)',
    });
    expect(await mockClient.vocabRangeCheck(uid, { kind: 'pages', text: '2-4' })).toMatchObject({
      pages: [[1, 3]],
      label: 'cap. 2-4',
      display: 'cap. 2–4',
    });
    await expect(mockClient.vocabRangeCheck(uid, { kind: 'pages', text: '9' })).rejects.toMatchObject({
      code: 'vocab_range_invalid',
      message: 'O capítulo 9 não existe (o livro tem 8 capítulos).',
    });
  });

  it('scans a TOC range, reports chapters and serves section marks with text offsets', async () => {
    const uid = (await timeMachine()).bookUid;
    const job = await mockClient.vocabScanStart(uid, await root(), [], { kind: 'outline', ids: ['0'] }, config);
    const seen = await finish(job.jobId);
    expect(seen.at(-1)?.stage).toBe('done');
    const report = (await mockClient.vocabReport(uid))!;
    expect(report.range).toMatchObject({ label: 'Part I', pages: [[0, 3]] });
    expect(report.rows.every((r) => r.firstPage >= 0 && r.firstPage <= 3)).toBe(true);
    const [s1, s99] = await mockClient.vocabEpubMarks(uid, [1, 99]);
    expect(s1!.section).toBe(1);
    expect(s1!.words.length).toBeGreaterThan(0);
    const text = SAMPLE_EPUB_CHAPTERS[1]!.text.toLowerCase();
    for (const w of s1!.words) {
      expect(text).toContain(w.form);
      expect(w.form).toBe(w.form.toLowerCase());
      expect(w.color).toBe(w.status === 'learning' || w.status === 'new' ? '#ba7517' : '#d85a30');
    }
    // Sorted and unique.
    expect(s1!.words.map((w) => w.form)).toEqual([...new Set(s1!.words.map((w) => w.form))].sort());
    // A section the book doesn't have: nothing to color.
    expect(s99).toEqual({ section: 99, words: [] });
    await expect(mockClient.vocabEpubMarks(uid, [0, 1, 2, 3, 4, 5])).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(mockClient.vocabMarks(uid, [1])).rejects.toMatchObject({ code: 'not_pdf' });
    const pdf = (await mockClient.libraryList()).find((b) => b.title === 'Animal Farm')!;
    await expect(mockClient.vocabEpubMarks(pdf.bookUid, [1])).rejects.toMatchObject({ code: 'not_epub' });
  });

  it('writes chapter Fonte links in the generated notes', async () => {
    const uid = (await timeMachine()).bookUid;
    const job = await mockClient.vocabScanStart(uid, await root(), [], { kind: 'pages', text: '2' }, config);
    await finish(job.jobId);
    const report = (await mockClient.vocabReport(uid))!;
    const lemma = report.rows.find((r) => r.defaultSelected)!.lemma;
    const res = await mockClient.vocabGenerateDeck(uid, report.scanUid, [lemma], {
      order: 'reading',
      perChapter: false,
      card2: false,
      enrich: 'wordnet',
    });
    const fonte = mockHandle.anki.noteFields(res.noteIds[0]!).Fonte!;
    expect(fonte).toMatch(
      new RegExp(`^<a href="leitor://livro/${uid}\\?cap=2&amp;q=[^"]+">The Time Machine, cap\\. 2</a>$`),
    );
  });
});
