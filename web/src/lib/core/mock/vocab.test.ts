// The mock vocabulary engine and commands (spec 12): the range/outline/naming rules copied from the Rust tests
// (core_vocab::ranges, core_vocab::naming), lemmas, forms and families, proper nouns, coverage and the curve, the
// per-page table reuse, the dedupe across scans of the same book, the deck/subdeck/tag naming and the reading marks.
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient, mockHandle } from '../mock';
import type { JobProgress, LibraryEntry, VocabConfig, VocabJob, VocabReport } from '../types';
import {
  addToIndex,
  bookChapters,
  buildTable,
  compare,
  deckNaming,
  emptyIndex,
  lemmatize,
  outlineWithRanges,
  parsePages,
  resolveRange,
  slugify,
  type RawOutlineItem,
} from './vocabEngine';
import { DEFAULT_VOCAB_CONFIG } from './vocab';

beforeEach(() => mockHandle.reset());

function rangeMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
}

const node = (title: string, page: number | null, children: RawOutlineItem[] = []): RawOutlineItem => ({
  title,
  page,
  children,
});

/** `sample_outline()` of core_vocab::ranges tests. */
const SAMPLE: RawOutlineItem[] = [
  node('Chapter One', 0),
  node('Chapter Two', 10, [node('Part A', 10), node('Part B', 14)]),
  node('Chapter Three', 20, [node('Lost', null)]),
  node('Chapter Four', 30),
];

describe('ranges (parity with core_vocab::ranges)', () => {
  it('parses pages', () => {
    expect(parsePages('37', 300)).toEqual([[36, 36]]);
    expect(parsePages('21-45', 300)).toEqual([[20, 44]]);
    expect(parsePages('21-45, 60, 72-80', 300)).toEqual([
      [20, 44],
      [59, 59],
      [71, 79],
    ]);
    expect(parsePages(' 72 – 80 ,21—45;60 ', 300)).toEqual([
      [20, 44],
      [59, 59],
      [71, 79],
    ]);
    expect(parsePages('10-20, 15-30, 31', 300)).toEqual([[9, 30]]);
    expect(parsePages('5, 5, 5', 300)).toEqual([[4, 4]]);
    expect(parsePages('300', 300)).toEqual([[299, 299]]);
  });

  it('rejects bad pages with the same pt-BR messages', () => {
    const ex = 'como 37, 21-45 ou 21-45, 60, 72-80.';
    expect(rangeMessage(() => parsePages('', 300))).toBe(`Digite uma página, um intervalo ou uma lista, ${ex}`);
    expect(rangeMessage(() => parsePages(' , ,', 300))).toBe(`Digite uma página, um intervalo ou uma lista, ${ex}`);
    expect(rangeMessage(() => parsePages('abc', 300))).toBe(`“abc” não é uma página válida. Use números, ${ex}`);
    expect(rangeMessage(() => parsePages('1.5', 300))).toBe(`“1.5” não é uma página válida. Use números, ${ex}`);
    expect(rangeMessage(() => parsePages('0', 300))).toBe('As páginas começam em 1.');
    expect(rangeMessage(() => parsePages('0-5', 300))).toBe('As páginas começam em 1.');
    expect(rangeMessage(() => parsePages('45-21', 300))).toBe('O intervalo 45-21 está invertido. Use 21-45.');
    expect(rangeMessage(() => parsePages('21-', 300))).toBe(
      'O intervalo “21-” está incompleto. Informe o início e o fim, como 21-45.',
    );
    expect(rangeMessage(() => parsePages('-21', 300))).toContain('“-21” está incompleto');
    expect(rangeMessage(() => parsePages('1-2-3', 300))).toContain('“1-2-3” não é uma página válida');
    expect(rangeMessage(() => parsePages('99999999999999', 300))).toContain('“99999999999999” não é uma página');
    expect(rangeMessage(() => parsePages('400', 300))).toBe('A página 400 não existe (o livro tem 300 páginas).');
    expect(rangeMessage(() => parsePages('2', 1))).toBe('A página 2 não existe (o livro tem 1 página).');
    const many = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    expect(rangeMessage(() => parsePages(many, 300))).toBe('Use no máximo 100 páginas ou intervalos.');
    expect(rangeMessage(() => parsePages('1', 0))).toBe('O livro não tem páginas.');
  });

  it('applies the outline rule (siblings or ancestors end an item; children are inside)', () => {
    const items = outlineWithRanges(SAMPLE, 40);
    const r = (it: { id: string; startPage: number | null; endPage: number | null }) => [
      it.id,
      it.startPage,
      it.endPage,
    ];
    expect(r(items[0]!)).toEqual(['0', 0, 9]);
    expect(r(items[1]!)).toEqual(['1', 10, 19]);
    expect(r(items[1]!.children[0]!)).toEqual(['1.0', 10, 13]);
    expect(r(items[1]!.children[1]!)).toEqual(['1.1', 14, 19]);
    expect(r(items[2]!.children[0]!)).toEqual(['2.0', null, null]);
    expect(r(items[3]!)).toEqual(['3', 30, 39]);
  });

  it('handles the outline edge cases', () => {
    const items = outlineWithRanges([node('A', 5), node('B', 5), node('C', 30), node('D', 12), node('E', 2)], 50);
    expect(items.map((i) => [i.startPage, i.endPage])).toEqual([
      [5, 5],
      [5, 29],
      [30, 49],
      [12, 49],
      [2, 49],
    ]);
    expect(outlineWithRanges([node('X', 99)], 10)[0]!.startPage).toBeNull();
    expect(outlineWithRanges([], 10)).toEqual([]);
  });

  it('keeps chapters whole when the user appends bookmarks (PdfCraft adds them at the end of the root level)', () => {
    const withMarks = [...SAMPLE, node('Minha nota', 20), node('Meio do cap. 2', 15)];
    const items = outlineWithRanges(withMarks, 40);
    expect(items.map((i) => [i.title, i.startPage, i.endPage])).toEqual([
      ['Chapter One', 0, 9],
      ['Chapter Two', 10, 19],
      ['Chapter Three', 20, 29],
      ['Chapter Four', 30, 39],
      ['Minha nota', 20, 39],
      ['Meio do cap. 2', 15, 39],
    ]);
    expect(bookChapters(withMarks, 40)).toEqual(bookChapters(SAMPLE, 40));
    const late = bookChapters([...SAMPLE, node('Epílogo', 35)], 40);
    expect(late.map((c) => [c.index, c.startPage, c.endPage])).toEqual([
      [1, 0, 9],
      [2, 10, 19],
      [3, 20, 29],
      [4, 30, 34],
      [5, 35, 39],
    ]);
  });

  it('resolves ranges with labels, displays, slugs and subdecks', () => {
    const all = resolveRange({ kind: 'all' }, SAMPLE, 40);
    expect(all.pages).toEqual([[0, 39]]);
    expect(all.display).toBe('Livro inteiro');
    expect(all.slug).toBeNull();

    const ch = resolveRange({ kind: 'outline', ids: ['1', '1.1'] }, SAMPLE, 40);
    expect(ch.pages).toEqual([[10, 19]]);
    expect(ch.label).toBe('Chapter Two');
    expect(ch.display).toBe('Chapter Two (p. 11–20)');
    expect(ch.slug).toBe('chapter-two');
    expect(ch.items).toEqual(['1', '1.1']);

    const two = resolveRange({ kind: 'outline', ids: ['3', '0'] }, SAMPLE, 40);
    expect(two.pages).toEqual([
      [0, 9],
      [30, 39],
    ]);
    expect(two.label).toBe('Chapter One + Chapter Four');
    expect(two.display).toBe('Chapter One + Chapter Four (p. 1–10, 31–40)');

    const p = resolveRange({ kind: 'pages', text: '72-80,21–45, 60' }, SAMPLE, 300);
    expect(p.label).toBe('p. 21-45, 60, 72-80');
    expect(p.display).toBe('p. 21–45, 60, 72–80');
    expect(p.slug).toBe('p-21-45-60-72-80');
    expect(p.subdeck).toBe('p. 21-45, 60, 72-80');
    expect(p.text).toBe('21-45, 60, 72-80');

    expect(rangeMessage(() => resolveRange({ kind: 'outline', ids: [] }, SAMPLE, 40))).toBe(
      'Marque pelo menos um item do sumário.',
    );
    expect(rangeMessage(() => resolveRange({ kind: 'outline', ids: ['9'] }, SAMPLE, 40))).toContain('não existe mais');
    expect(rangeMessage(() => resolveRange({ kind: 'outline', ids: ['2.0'] }, SAMPLE, 40))).toBe(
      '“Lost” não aponta para uma página do livro.',
    );
    const long = [node('Very long chapter title '.repeat(5), 0), node('::x', 3)];
    const r = resolveRange({ kind: 'outline', ids: ['0', '1'] }, long, 10);
    expect(Array.from(r.label!)).toHaveLength(60);
    expect(r.label!.endsWith('…')).toBe(true);
    expect(r.subdeck).not.toContain('::');
  });

  it('splits chapters by the outline, else in blocks of 20 pages', () => {
    const c = bookChapters(SAMPLE, 40);
    expect(c).toHaveLength(4);
    expect([c[1]!.index, c[1]!.startPage, c[1]!.endPage]).toEqual([2, 10, 19]);
    expect(c[3]!.endPage).toBe(39);
    const blocks = bookChapters([], 45);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.label).toBe('p. 1–20');
    expect(blocks[2]!.label).toBe('p. 41–45');
  });

  it('names decks and tags like core_vocab::naming', () => {
    expect(slugify('Animal Farm')).toBe('animal-farm');
    expect(slugify('  A Revolução dos Bichos! ')).toBe('a-revolucao-dos-bichos');
    expect(slugify('p. 21-45, 60, 72-80')).toBe('p-21-45-60-72-80');
    expect(slugify('Cap 3')).toBe('cap-3');
    expect(slugify('::')).toBe('');
    const cap3 = resolveRange({ kind: 'outline', ids: ['0'] }, [node('Cap 3', 0)], 10);
    expect(deckNaming('Vocabulário', 'Animal Farm', cap3)).toEqual({
      baseName: 'Vocabulário::Livros::Animal Farm',
      subdeck: 'Cap 3',
      fullName: 'Vocabulário::Livros::Animal Farm::Cap 3',
      rangeTag: 'trecho::cap-3',
      bookTag: 'livro::animal-farm',
    });
    const pages = resolveRange({ kind: 'pages', text: '21-45' }, [], 60);
    expect(deckNaming(null, 'Animal Farm', pages).fullName).toBe('Livros::Animal Farm::p. 21-45');
    expect(deckNaming(null, 'Animal Farm', pages).rangeTag).toBe('trecho::p-21-45');
    expect(deckNaming('V', 'a::b', resolveRange({ kind: 'all' }, [], 3))).toMatchObject({
      fullName: 'V::Livros::a:b',
      rangeTag: null,
    });
  });
});

const CONFIG: VocabConfig = DEFAULT_VOCAB_CONFIG;

function report(text: string[], known: string[], config: VocabConfig = CONFIG) {
  const index = emptyIndex();
  addToIndex(index, known, 'known');
  const table = buildTable(text, 'v1');
  return compare({
    table,
    range: resolveRange({ kind: 'all' }, [], text.length),
    index,
    overrides: {},
    config,
    chapters: bookChapters([], text.length),
    bookNotes: new Map(),
  });
}

describe('lemmas, forms and families (spec 12.3 D, I)', () => {
  it('lemmatizes irregular and regular forms', () => {
    expect(lemmatize('went')).toBe('go');
    expect(lemmatize('children')).toBe('child');
    expect(lemmatize('ran')).toBe('run');
    expect(lemmatize('animals')).toBe('animal');
    expect(lemmatize('stopped')).toBe('stop');
    expect(lemmatize('windmills')).toBe('windmill');
    expect(lemmatize('tried')).toBe('try');
    // A word of the user's index wins over the lexicon's choice.
    expect(lemmatize('meaning', (w) => w === 'mean')).toBe('mean');
  });

  it('puts inflections that are lemmas of their own in "forms" and derivatives in the family', () => {
    const r = report(
      [
        'The learning of the pigs was quick and the learner did not unlearn anything at all here.',
        'Their happiness came quickly, and the meaning of every feeling was clear to the old animals.',
        'The buildings were interesting, and he learned the words while he learns more every day.',
      ],
      ['learn', 'happy', 'quick', 'mean', 'feel', 'build', 'interest'],
    );
    const row = (lemma: string) => r.rows.find((x) => x.lemma === lemma)!;
    for (const [form, base] of [
      ['learning', 'learn'],
      ['meaning', 'mean'],
      ['feeling', 'feel'],
      ['building', 'build'],
      ['interesting', 'interest'],
    ] as const) {
      expect(row(form), form).toMatchObject({
        group: 'forms',
        status: 'known',
        base: { lemma: base, status: 'known' },
      });
      expect(row(form).defaultSelected).toBe(false);
    }
    for (const [lemma, fam] of [
      ['learner', 'learn'],
      ['unlearn', 'learn'],
      ['happiness', 'happy'],
      ['quickly', 'quick'],
    ] as const) {
      expect(row(lemma), lemma).toMatchObject({ group: 'main', status: 'unknown', family: { lemma: fam } });
      expect(row(lemma).defaultSelected).toBe(true);
    }
    // Plain inflections are just the known lemma.
    expect(row('learn')).toMatchObject({ status: 'known', statusSource: 'deck' });
    expect(r.rows.find((x) => x.lemma === 'learned')).toBeUndefined();

    const known = report(
      ['The learner did not unlearn anything, and the happiness came quickly to them all here.'],
      ['learn', 'happy', 'quick'],
      { ...CONFIG, derivedPolicy: 'known' },
    );
    expect(known.rows.find((x) => x.lemma === 'learner')).toMatchObject({ status: 'known', statusSource: 'family' });
  });

  it('keeps proper nouns apart and out of the metrics', () => {
    const r = report(
      [
        'The animals listened when Napoleon spoke to them in the barn.',
        'Later that night Napoleon walked around the farm with the dogs.',
      ],
      ['animal', 'listen', 'speak', 'barn', 'night', 'walk', 'farm', 'dog', 'later'],
    );
    const nap = r.rows.find((x) => x.lemma === 'napoleon')!;
    expect(nap).toMatchObject({ group: 'proper', status: 'proper', form: 'Napoleon', occurrences: 2 });
    expect(r.metrics.properLemmas).toBe(1);
    expect(r.metrics.totalTokens).toBe(
      r.rows.filter((x) => x.group === 'main' || x.group === 'forms').reduce((n, x) => n + x.occurrences, 0),
    );
  });

  it('computes coverage and the 95/98 curve', () => {
    // 100 tokens: "the" ×90 (function word, known), "windmill" ×6, "knoll" ×3, "harrow" ×1.
    const words = [...Array(90).fill('the'), ...Array(6).fill('windmill'), ...Array(3).fill('knoll'), 'harrow'];
    const r = report([words.join(' ')], []);
    expect(r.metrics.totalTokens).toBe(100);
    expect(r.metrics.coverageKnown).toBeCloseTo(0.9);
    expect(r.metrics.unknownLemmas).toBe(3);
    expect(r.metrics.unknownLemmasRepeated).toBe(2);
    expect(r.metrics.wordsTo95).toBe(1);
    expect(r.metrics.wordsTo98).toBe(2);
    expect(r.metrics.curve.map((c) => c.n)).toEqual([0, 1, 2, 3]);
    expect(r.metrics.curve[3]!.coverage).toBe(1);
    const fw = report([words.join(' ')], [], { ...CONFIG, functionWordsKnown: false });
    expect(fw.metrics.coverageKnown).toBe(0);
  });
});

// ---------------------------------------------------------------- the commands, on the mock library

async function farm(): Promise<LibraryEntry> {
  return (await mockClient.libraryList()).find((b) => b.title === 'Animal Farm')!;
}

async function deckId(name: string): Promise<number> {
  return (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;
}

async function finish(job: VocabJob): Promise<JobProgress[]> {
  const seen: JobProgress[] = [];
  await new Promise<void>((resolve) => {
    const stop = mockClient.onJobProgress(job.jobId, (p) => {
      seen.push(p);
      if (['done', 'failed', 'cancelled'].includes(p.stage)) {
        stop();
        resolve();
      }
    });
  });
  return seen;
}

async function scan(range: Parameters<typeof mockClient.vocabScanStart>[3]): Promise<VocabReport> {
  const book = await farm();
  const job = await mockClient.vocabScanStart(book.bookUid, await deckId('Vocabulário'), [], range, CONFIG);
  const seen = await finish(job);
  expect(seen.at(-1)!.stage).toBe('done');
  return (await mockClient.vocabReport(book.bookUid))!;
}

describe('vocabulary commands', () => {
  it('lists the folder with every subdeck, its notetypes, suggestions and samples', async () => {
    const folder = await mockClient.vocabFolder(await deckId('Vocabulário'));
    expect(folder.decks.map((d) => [d.name, d.depth])).toEqual([
      ['Vocabulário', 0],
      ['Vocabulário::Inglês básico', 1],
      ['Vocabulário::Livros', 1],
      ['Vocabulário::Livros::Teste', 2],
      ['Vocabulário::Oxford', 1],
    ]);
    const word = folder.notetypes.find((n) => n.name === 'Vocab (Word)')!;
    expect(word).toMatchObject({ mappedField: null, suggestedField: 'Word' });
    expect(word.samples).toEqual(['learn', 'happy', 'quick', 'mean', 'feel']);
    const front = folder.notetypes.find((n) => n.name === 'Oxford (Front/Back)')!;
    expect(front.suggestedField).toBe('Front');
    const excluded = [await deckId('Vocabulário::Oxford')];
    expect(await mockClient.vocabMappingSamples(folder.root.deckId, excluded, front.notetypeId, 'Front')).toEqual([]);
    expect(await mockClient.vocabMappingSamples(folder.root.deckId, [], front.notetypeId, 'Back')).toEqual([
      'abandonar',
      'habilidade',
      'pronto',
      'ordem',
      'logo',
    ]);
    await mockClient.vocabMappingSet(front.notetypeId, 'Front');
    expect(await mockClient.vocabMappingGet()).toEqual([{ notetypeId: front.notetypeId, field: 'Front' }]);
  });

  it('reads the mock book outline, with the range rule', async () => {
    const outline = await mockClient.vocabOutline((await farm()).bookUid);
    expect(outline.pageCount).toBe(60);
    expect(outline.items[2]).toMatchObject({ title: 'Cap 3', startPage: 12, endPage: 17 });
    expect(outline.items[1]!.children.map((c) => [c.title, c.startPage, c.endPage])).toEqual([
      ['A morte do Major', 6, 8],
      ['As reuniões no celeiro', 9, 11],
    ]);
    expect(outline.items.at(-1)).toMatchObject({ title: 'Notas do editor', startPage: null });
    await expect(
      mockClient.vocabRangeCheck((await farm()).bookUid, { kind: 'pages', text: '400' }),
    ).rejects.toMatchObject({
      code: 'vocab_range_invalid',
      message: 'A página 400 não existe (o livro tem 60 páginas).',
    });
  });

  it('scans with job progress, then a second range reuses the table without reading the text again', async () => {
    const book = await farm();
    const job = await mockClient.vocabScanStart(book.bookUid, await deckId('Vocabulário'), [], { kind: 'all' }, CONFIG);
    const first = await finish(job);
    expect(first.map((p) => p.stage)).toEqual(expect.arrayContaining(['text', 'lemmas', 'known', 'compare', 'done']));
    expect(first.at(-1)!.reused).toBe(false);
    expect(mockHandle.vocab.textReads).toBe(1);
    const r = await scan({ kind: 'pages', text: '21-45' });
    expect(mockHandle.vocab.textReads).toBe(1);
    expect(r.range.display).toBe('p. 21–45');
    expect(r.deck.fullName).toBe('Vocabulário::Livros::Animal Farm::p. 21-45');
    expect(Math.min(...r.rows.map((x) => x.firstPage))).toBeGreaterThanOrEqual(20);
    expect(Math.max(...r.rows.flatMap((x) => x.pages))).toBeLessThanOrEqual(44);
    expect(r.chapters.map((c) => c.label)).toEqual(['Cap 4', 'Cap 5', 'Cap 6', 'Cap 7', 'Cap 8']);
    const settings = await mockClient.vocabSettingsGet();
    expect(settings.rootName).toBe('Vocabulário');
  });

  it('generates the range subdeck with tags and the Família field, and never re-adds words of earlier scans', async () => {
    const book = await farm();
    const cap3 = await scan({ kind: 'outline', ids: ['2'] });
    expect(cap3.range.display).toBe('Cap 3 (p. 13–18)');
    const words = cap3.rows.filter((r) => r.defaultSelected).map((r) => r.lemma);
    expect(words.length).toBeGreaterThan(5);
    const res = await mockClient.vocabGenerateDeck(book.bookUid, cap3.scanUid, words, {
      order: 'reading',
      perChapter: false,
      card2: false,
      enrich: 'wordnet',
    });
    expect(res.deckName).toBe('Vocabulário::Livros::Animal Farm::Cap 3');
    expect(res.created).toBe(words.length);
    expect(mockHandle.anki.deckNames).toContain('Vocabulário::Livros::Animal Farm::Cap 3');
    const fields = mockHandle.anki.noteFields(res.noteIds[0]!);
    expect(fields.Fonte).toContain(`leitor://livro/${book.bookUid}?pagina=`);
    expect(Object.keys(fields)).toContain('Família');
    const tags = (await mockClient.ankiNoteGet(res.noteIds[0]!)).tags;
    expect(tags).toEqual(expect.arrayContaining(['livro::animal-farm', 'trecho::cap-3', 'cap::03']));

    // The report follows the collection; another range of the same book never offers them again.
    const after = (await mockClient.vocabReport(book.bookUid))!;
    expect(after.rows.filter((r) => words.includes(r.lemma)).every((r) => r.existingNoteId !== null)).toBe(true);
    const wider = await scan({ kind: 'pages', text: '13-30' });
    const again = wider.rows.filter((r) => words.includes(r.lemma));
    expect(again.length).toBe(words.length);
    expect(again.every((r) => r.existingNoteId !== null && !r.defaultSelected)).toBe(true);
    const twice = await mockClient.vocabGenerateDeck(book.bookUid, wider.scanUid, words, {
      order: 'frequency',
      perChapter: false,
      card2: false,
      enrich: 'wordnet',
    });
    expect(twice.created).toBe(0);
    expect(twice.skippedPrevious.sort()).toEqual([...words].sort());
  });

  it('puts per-chapter subdecks under the book deck and fills Família for derivatives', async () => {
    const book = await farm();
    const r = await scan({ kind: 'all' });
    const quickly = r.rows.find((x) => x.lemma === 'quickly')!;
    expect(quickly.family).toEqual({ lemma: 'quick', status: 'known' });
    const res = await mockClient.vocabGenerateDeck(book.bookUid, r.scanUid, ['quickly', 'windmill'], {
      order: 'reading',
      perChapter: true,
      card2: true,
      enrich: 'wordnet',
    });
    expect(res.decks).toEqual(['Vocabulário::Livros::Animal Farm::Cap 01', 'Vocabulário::Livros::Animal Farm::Cap 05']);
    const fam = Object.values(res.noteIds).map((id) => mockHandle.anki.noteFields(id));
    expect(fam.find((f) => f.Lema === 'quickly')!.Família).toBe('quick');
    expect(fam.find((f) => f.Lema === 'windmill')!['Card 2']).toBe('1');
    await expect(
      mockClient.vocabGenerateDeck(book.bookUid, r.scanUid, ['knoll'], {
        order: 'reading',
        perChapter: false,
        card2: false,
        enrich: 'ai',
      }),
    ).rejects.toMatchObject({ code: 'vocab_ai_unavailable' });
  });

  it('applies "Já sei" on the next scan, in seconds (the table is reused)', async () => {
    const book = await farm();
    const r = await scan({ kind: 'all' });
    expect(r.rows.find((x) => x.lemma === 'windmill')!.status).toBe('unknown');
    await mockClient.vocabOverrideSet(['windmill'], 'known');
    const progress = await finish(await mockClient.vocabRescan(book.bookUid));
    expect(progress.at(-1)).toMatchObject({ stage: 'done', reused: true });
    const after = (await mockClient.vocabReport(book.bookUid))!;
    expect(after.rows.find((x) => x.lemma === 'windmill')).toMatchObject({ status: 'known', statusSource: 'override' });
    expect(after.metrics.coverageKnown).toBeGreaterThan(r.metrics.coverageKnown);
  });

  it('marks unknown and learning words with the page word rects', async () => {
    const book = await farm();
    await scan({ kind: 'all' });
    const [page] = await mockClient.vocabMarks(book.bookUid, [24]);
    const words = await mockClient.docWords(book.bookUid, 24);
    const windmill = page!.marks.filter((m) => m.lemma === 'windmill');
    expect(windmill.length).toBeGreaterThan(0);
    for (const m of page!.marks) {
      const w = words.words.find((x) => JSON.stringify(x.rects) === JSON.stringify(m.rects))!;
      expect(w.text).toBe(m.form);
      expect(['unknown', 'learning']).toContain(m.status);
    }
    expect(page!.marks.some((m) => m.lemma === 'drunk' && m.status === 'learning')).toBe(true);
    expect(page!.marks.some((m) => m.lemma === 'farm')).toBe(false);
    const added = await mockClient.vocabAddWord(book.bookUid, 'windmill', 24, 'windmill');
    expect(added.deckName).toBe('Vocabulário::Livros::Animal Farm');
    const [again] = await mockClient.vocabMarks(book.bookUid, [24]);
    expect(again!.marks.filter((m) => m.lemma === 'windmill').every((m) => m.status === 'learning')).toBe(true);
    const panel = await mockClient.bookPanelInfo(book.bookUid, 24);
    expect(panel.vocab).toMatchObject({ rangeLabel: null });
  });

  it('refuses scanned books and missing data with pt-BR errors', async () => {
    const scanned = (await mockClient.libraryList()).find((b) => !b.hasText)!;
    const root = await deckId('Vocabulário');
    await expect(mockClient.vocabScanStart(scanned.bookUid, root, [], { kind: 'all' }, CONFIG)).rejects.toMatchObject({
      code: 'vocab_needs_ocr',
      message: 'Este livro parece escaneado: reconheça o texto (OCR) antes de escanear o vocabulário.',
    });
    mockHandle.vocab.setDataAvailable(false);
    await expect(
      mockClient.vocabScanStart((await farm()).bookUid, root, [], { kind: 'all' }, CONFIG),
    ).rejects.toMatchObject({ code: 'vocab_data_missing' });
    expect((await mockClient.vocabDataInfo()).available).toBe(false);
    expect(await mockClient.vocabReport((await farm()).bookUid)).toBeNull();
    expect(await mockClient.jobStatus('nope')).toBeNull();
  });

  it('cancels a running scan', async () => {
    mockHandle.vocab.setJobDelay(5);
    const book = await farm();
    const job = await mockClient.vocabScanStart(book.bookUid, await deckId('Vocabulário'), [], { kind: 'all' }, CONFIG);
    await mockClient.jobCancel(job.jobId);
    const seen = await finish(job);
    expect(seen.at(-1)!.stage).toBe('cancelled');
    expect(await mockClient.vocabReport(book.bookUid)).toBeNull();
  });

  it('returns the same running scan, but replaces it when another range is asked for', async () => {
    mockHandle.vocab.setJobDelay(5);
    const book = await farm();
    const root = await deckId('Vocabulário');
    const first = await mockClient.vocabScanStart(book.bookUid, root, [], { kind: 'all' }, CONFIG);
    const again = await mockClient.vocabScanStart(book.bookUid, root, [], { kind: 'all' }, CONFIG);
    expect(again.jobId).toBe(first.jobId);
    const other = await mockClient.vocabScanStart(book.bookUid, root, [], { kind: 'pages', text: '2-3' }, CONFIG);
    expect(other.jobId).not.toBe(first.jobId);
    const [a, b] = await Promise.all([finish(first), finish(other)]);
    expect(a.at(-1)!.stage).toBe('cancelled');
    expect(b.at(-1)!.stage).toBe('done');
    expect((await mockClient.vocabReport(book.bookUid))!.range.text).toBe('2-3');
  });
});
