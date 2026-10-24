// Mock of the vocabulary scan commands (spec 12, 14, 15): settings, the folder and its field mapping, the outline and
// ranges, background scans with `job://` progress through the mock event bus, the report, manual adjustments, deck
// generation in the mock collection, the reading marks and "Adicionar ao deck do livro". The engine itself is
// mock/vocabEngine.ts; the state is persisted in sessionStorage ('leitor.mock.vocab') like the rest of the mock.
import {
  CoreError,
  type BookDeckInfo,
  type BookPanelVocab,
  type CoreClient,
  type EpubSectionMarks,
  type PageWords,
  type VocabConfig,
  type VocabDataInfo,
  type VocabDeckOptions,
  type VocabDeckResult,
  type VocabFolder,
  type VocabFolderNotetype,
  type VocabMapping,
  type VocabOutline,
  type VocabOverride,
  type VocabPageMarks,
  type VocabRangeSpec,
  type VocabReport,
  type VocabRow,
  type VocabSettings,
  type VocabStatus,
  type VocabWordAdded,
  type WordDefinition,
} from '../types';
import {
  ankiState,
  deckById,
  deckCounts,
  later,
  logAnki,
  mockLatency,
  newId,
  persistAnki,
  subtree,
  type MockCard,
  type MockNotetype,
} from './ankiData';
import { createDeck } from './ankiDecks';
import { addJob, clearJobs, createJobsMock, emitJob, runningJob, type JobMockKeys, type MockJob } from './jobs';
import { parseSourceLink } from './ankiStudy';
import { mockSetVocabRoot, mockVocabRootId, setVocabBridge } from './bookPanel';
import {
  addToIndex,
  bookChapters,
  buildTable,
  byCurveOrder,
  byReadingOrder,
  chapterDeckName,
  chapterTag,
  cleanField,
  compare,
  deckNaming,
  definitionOf,
  emptyIndex,
  lemmatize,
  outlineWithRanges,
  posOf,
  resolveRange,
  slugify,
  VocabRangeError,
  words as wordsOf,
  type BookTable,
  type DeckStatus,
  type KnownIndex,
  type RangeUnit,
  type RawOutlineItem,
} from './vocabEngine';

/** What the vocabulary mock needs from the mock library (mock.ts). */
export interface VocabBookSource {
  /** Throws `book_not_found` like the core. */
  book(uid: string): {
    title: string;
    author: string | null;
    pages: number;
    hasText: boolean;
    /** Text version: changes when the file changes. */
    fileHash: string;
    /** `chapter` for an EPUB: its units are spine sections (`pages` counts them, `pageText` is a section's text). */
    unit: RangeUnit;
  };
  /** Raw text of a page (its lines, `\n`-separated). */
  pageText(uid: string, page: number): string;
  pageWords(uid: string, page: number): PageWords;
  /** The outline of the current version. */
  outline(uid: string): RawOutlineItem[];
}

interface StoredScan {
  scanUid: string;
  rootDeckId: number;
  excludedDeckIds: number[];
  range: VocabRangeSpec;
  config: VocabConfig;
  report: VocabReport;
  formToLemma: Record<string, string>;
}

interface VocabState {
  excludedDeckIds: number[];
  config: VocabConfig;
  mappings: Record<string, string>;
  overrides: Record<string, VocabOverride>;
  scans: Record<string, StoredScan>;
  tables: Record<string, BookTable>;
  dataAvailable: boolean;
  /** How many times a book's text was read to build a table (e2e/unit: a second range must not read it). */
  textReads: number;
  nextJob: number;
}

export const DEFAULT_VOCAB_CONFIG: VocabConfig = {
  knownIvlDays: 21,
  countYoung: false,
  suspendedPolicy: 'ignore',
  functionWordsKnown: true,
  derivedPolicy: 'card',
};

const STORAGE_KEY = 'leitor.mock.vocab';
const APP_VOCAB_TYPE = 'Vocabulário · Livro';
/** Field names suggested for the word, in order (spec 12.1 step 3). */
const SUGGESTED = ['word', 'palavra', 'english', 'ingles', 'front', 'frente', 'expression', 'vocab', 'term'];

function initial(): VocabState {
  return {
    excludedDeckIds: [],
    config: { ...DEFAULT_VOCAB_CONFIG },
    mappings: {},
    overrides: {},
    scans: {},
    tables: {},
    dataAvailable: true,
    textReads: 0,
    nextJob: 1,
  };
}

function load(): VocabState {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as VocabState;
      if (parsed && typeof parsed.scans === 'object' && typeof parsed.tables === 'object') return parsed;
    }
  } catch {
    // Corrupt storage: start over.
  }
  return initial();
}

let state: VocabState = load();

function persist(): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Keep the in-memory state only.
  }
}

// ---------------------------------------------------------------- errors

const err = {
  dataMissing: () =>
    new CoreError(
      'vocab_data_missing',
      'Os dados de vocabulário não estão instalados. Reinstale o app ou rode scripts/build-wordnet.sh.',
    ),
  needsOcr: () =>
    new CoreError(
      'vocab_needs_ocr',
      'Este livro parece escaneado: reconheça o texto (OCR) antes de escanear o vocabulário.',
    ),
  notPdf: () => new CoreError('not_pdf', 'Este livro é um EPUB: essa ação vale só para PDF.'),
  notEpub: () => new CoreError('not_epub', 'Este livro não é um EPUB.'),
  noScan: () => new CoreError('vocab_no_scan', 'Este livro ainda não foi escaneado.'),
  notScanned: () => new CoreError('vocab_not_scanned', 'Escaneie o vocabulário deste livro primeiro.'),
  stale: () =>
    new CoreError('vocab_scan_stale', 'O relatório mudou. Abra o relatório de novo e gere o deck outra vez.'),
  prepare: () =>
    new CoreError(
      'vocab_prepare_needed',
      'O tipo de nota “Vocabulário · Livro” ainda não existe nesta coleção. Use “Preparar coleção”.',
    ),
  ai: () => new CoreError('vocab_ai_unavailable', 'O enriquecimento com IA chega numa próxima versão.'),
  deck: () => new CoreError('deck_not_found', 'O deck escolhido não existe mais.'),
  invalid: (message: string) => new CoreError('invalid_input', message),
};

function rangeError(e: unknown): never {
  if (e instanceof VocabRangeError) throw new CoreError('vocab_range_invalid', e.message);
  throw e;
}

// ---------------------------------------------------------------- settings, folder and mapping

function rootDeck(): { id: number; name: string } | null {
  const id = mockVocabRootId();
  const d = id !== null ? deckById(id) : undefined;
  return d ? { id: d.id, name: d.name } : null;
}

function settings(): VocabSettings {
  const root = rootDeck();
  return {
    rootDeckId: root?.id ?? null,
    rootName: root?.name ?? null,
    excludedDeckIds: state.excludedDeckIds.filter((id) => !!deckById(id)),
    config: { ...state.config },
  };
}

function checkConfig(config: VocabConfig): VocabConfig {
  const days = config.knownIvlDays;
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw err.invalid('O intervalo de “madura” deve ficar entre 1 e 3650 dias.');
  if (!['ignore', 'known'].includes(config.suspendedPolicy) || !['card', 'known'].includes(config.derivedPolicy))
    throw err.invalid('Critério de “eu sei” inválido.');
  return {
    knownIvlDays: days,
    countYoung: !!config.countYoung,
    suspendedPolicy: config.suspendedPolicy,
    functionWordsKnown: !!config.functionWordsKnown,
    derivedPolicy: config.derivedPolicy,
  };
}

function plainKey(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** By the field name (Word, Palavra, English, Inglês, Front, Frente, Expression, Vocab, Term), else the first field. */
export function suggestField(fields: string[]): string {
  for (const want of SUGGESTED) {
    const hit = fields.find((f) => plainKey(f) === want);
    if (hit) return hit;
  }
  return fields[0] ?? '';
}

function fieldFor(nt: MockNotetype): string {
  const mapped = state.mappings[String(nt.id)];
  if (mapped && nt.fields.includes(mapped)) return mapped;
  if (nt.name === APP_VOCAB_TYPE) return 'Lema';
  return suggestField(nt.fields);
}

function mappedField(nt: MockNotetype): string | null {
  const mapped = state.mappings[String(nt.id)];
  if (mapped && nt.fields.includes(mapped)) return mapped;
  return nt.name === APP_VOCAB_TYPE ? 'Lema' : null;
}

/** Deck ids of the folder: the root's subtree minus the excluded decks. */
function folderDecks(rootDeckId: number, excluded: number[]): Set<number> {
  const out = new Set(subtree(rootDeckId).map((d) => d.id));
  for (const id of excluded) if (id !== rootDeckId) out.delete(id);
  return out;
}

function liveRoot(rootDeckId: number): { id: number; name: string } {
  const d = deckById(rootDeckId);
  if (!d) throw err.deck();
  return { id: d.id, name: d.name };
}

function samples(nt: MockNotetype, field: string, decks: Set<number>): string[] {
  const s = ankiState();
  const fi = nt.fields.indexOf(field);
  if (fi < 0) return [];
  const noteIds = new Set(s.cards.filter((c) => decks.has(c.deckId)).map((c) => c.noteId));
  const out: string[] = [];
  for (const n of [...s.notes].sort((a, b) => a.id - b.id)) {
    if (n.notetypeId !== nt.id || !noteIds.has(n.id)) continue;
    const first = cleanField(n.fields[fi] ?? '')[0];
    if (first && !out.includes(first)) out.push(first);
    if (out.length >= 5) break;
  }
  return out;
}

function folder(rootDeckId: number): VocabFolder {
  const root = liveRoot(rootDeckId);
  const s = ankiState();
  const rootDepth = root.name.split('::').length;
  const decks = subtree(root.id).sort((a, b) => {
    const pa = a.name.split('::');
    const pb = b.name.split('::');
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = pa[i]!.localeCompare(pb[i]!, 'pt-BR', { sensitivity: 'base' });
      if (c) return c;
    }
    return pa.length - pb.length;
  });
  const all = new Set(decks.map((d) => d.id));
  const notetypes = new Map<number, Set<number>>();
  for (const c of s.cards) {
    if (!all.has(c.deckId)) continue;
    const n = s.notes.find((x) => x.id === c.noteId);
    if (!n) continue;
    const set = notetypes.get(n.notetypeId) ?? new Set<number>();
    set.add(n.id);
    notetypes.set(n.notetypeId, set);
  }
  const nts: VocabFolderNotetype[] = [];
  for (const [ntId, notes] of notetypes) {
    const nt = s.notetypes.find((x) => x.id === ntId);
    if (!nt) continue;
    const suggested = nt.name === APP_VOCAB_TYPE ? 'Lema' : suggestField(nt.fields);
    nts.push({
      notetypeId: nt.id,
      name: nt.name,
      fields: [...nt.fields],
      noteCount: notes.size,
      mappedField: mappedField(nt),
      suggestedField: suggested,
      samples: samples(nt, mappedField(nt) ?? suggested, all),
    });
  }
  nts.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return {
    root: { deckId: root.id, name: root.name },
    decks: decks.map((d) => {
      const own = s.cards.filter((c) => c.deckId === d.id);
      return {
        deckId: d.id,
        name: d.name,
        depth: d.name.split('::').length - rootDepth,
        cardCount: own.length + d.extraCards,
        noteCount: new Set(own.map((c) => c.noteId)).size + d.extraCards,
      };
    }),
    notetypes: nts,
  };
}

function mappings(): VocabMapping[] {
  return Object.entries(state.mappings)
    .map(([id, field]) => ({ notetypeId: Number(id), field }))
    .filter((m) => ankiState().notetypes.some((n) => n.id === m.notetypeId))
    .sort((a, b) => a.notetypeId - b.notetypeId);
}

function setMapping(notetypeId: number, field: string): VocabMapping[] {
  const nt = ankiState().notetypes.find((n) => n.id === notetypeId);
  if (!nt) throw new CoreError('anki_not_found', 'Tipo de nota não encontrado.');
  if (!nt.fields.includes(field)) throw err.invalid(`O tipo de nota “${nt.name}” não tem o campo “${field}”.`);
  state.mappings[String(notetypeId)] = field;
  persist();
  return mappings();
}

// ---------------------------------------------------------------- known vocabulary (spec 12.3 A)

function cardStatus(c: MockCard, config: VocabConfig): DeckStatus {
  if (c.queue === 'suspended') return 'suspended';
  if (c.queue === 'new' || (c.queue === 'buried' && c.reps === 0 && c.ivl === 0)) return 'new';
  if (c.queue === 'learn') return config.countYoung ? 'known' : 'learning';
  if (c.ivl >= config.knownIvlDays) return 'known';
  return config.countYoung ? 'known' : 'learning';
}

function readIndex(rootDeckId: number, excluded: number[], config: VocabConfig): KnownIndex {
  const s = ankiState();
  const decks = folderDecks(rootDeckId, excluded);
  const best = new Map<number, DeckStatus>();
  for (const c of s.cards) {
    if (!decks.has(c.deckId)) continue;
    const st = cardStatus(c, config);
    const prev = best.get(c.noteId);
    const rank = { known: 4, learning: 3, new: 2, suspended: 1 } as const;
    if (!prev || rank[st] > rank[prev]) best.set(c.noteId, st);
  }
  const index = emptyIndex();
  for (const [noteId, status] of best) {
    const n = s.notes.find((x) => x.id === noteId);
    const nt = n && s.notetypes.find((x) => x.id === n.notetypeId);
    if (!n || !nt) continue;
    const fi = nt.fields.indexOf(fieldFor(nt));
    if (fi < 0) continue;
    addToIndex(index, cleanField(n.fields[fi] ?? ''), status);
  }
  return index;
}

/** Notes of "Vocabulário · Livro" made for this book (Fonte link), anywhere in the collection: lemma → note id. */
function bookNotes(uid: string): Map<string, number> {
  const s = ankiState();
  const out = new Map<string, number>();
  const nt = s.notetypes.find((x) => x.name === APP_VOCAB_TYPE);
  if (!nt) return out;
  const fonte = nt.fields.indexOf('Fonte');
  const lema = nt.fields.indexOf('Lema');
  const palavra = nt.fields.indexOf('Palavra');
  for (const n of s.notes) {
    if (n.notetypeId !== nt.id) continue;
    if (parseSourceLink(n.fields[fonte] ?? '')?.bookUid !== uid) continue;
    const key = cleanField(n.fields[lema] ?? '')[0] ?? cleanField(n.fields[palavra] ?? '')[0];
    if (key && !out.has(key)) out.set(key, n.id);
  }
  return out;
}

// ---------------------------------------------------------------- outline, ranges, table and report

function outline(deps: VocabBookSource, uid: string): VocabOutline {
  const book = deps.book(uid);
  return { pageCount: book.pages, items: outlineWithRanges(deps.outline(uid), book.pages) };
}

function tableFor(deps: VocabBookSource, uid: string): BookTable | null {
  const book = deps.book(uid);
  const t = state.tables[uid];
  return t && t.textVersion === book.fileHash && t.pages.length === book.pages ? t : null;
}

function readTable(deps: VocabBookSource, uid: string): BookTable {
  const book = deps.book(uid);
  const pages = Array.from({ length: book.pages }, (_, p) => deps.pageText(uid, p));
  state.textReads += 1;
  const table = buildTable(pages, book.fileHash);
  state.tables[uid] = table;
  persist();
  return table;
}

function computeReport(
  deps: VocabBookSource,
  uid: string,
  scanUid: string,
  table: BookTable,
  rootDeckId: number,
  excluded: number[],
  rangeSpec: VocabRangeSpec,
  config: VocabConfig,
): StoredScan {
  const book = deps.book(uid);
  const root = liveRoot(rootDeckId);
  const raw = deps.outline(uid);
  let range;
  try {
    range = resolveRange(rangeSpec, raw, book.pages, book.unit);
  } catch (e) {
    rangeError(e);
  }
  const chapters = bookChapters(raw, book.pages, book.unit);
  const result = compare({
    table,
    range,
    index: readIndex(root.id, excluded, config),
    overrides: state.overrides,
    config,
    chapters,
    bookNotes: bookNotes(uid),
  });
  const report: VocabReport = {
    scanUid,
    bookUid: uid,
    title: book.title,
    author: book.author,
    scannedAt: Date.now(),
    folder: { rootDeckId: root.id, rootName: root.name, deckCount: folderDecks(root.id, excluded).size },
    range,
    config: { ...config },
    metrics: result.metrics,
    chapters: result.chapters,
    rows: result.rows,
    deck: deckNaming(root.name, book.title, range),
  };
  return {
    scanUid,
    rootDeckId: root.id,
    excludedDeckIds: [...excluded],
    range: rangeSpec,
    config: { ...config },
    report,
    formToLemma: result.formToLemma,
  };
}

// ---------------------------------------------------------------- jobs (spec 15: `job://<id>`)

let jobDelayMs: number | null = null;

const emit = emitJob;

function tick(): Promise<void> {
  const ms = jobDelayMs ?? Math.round(mockLatency() / 2);
  return new Promise((r) => setTimeout(r, ms));
}

function uuid(): string {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

async function runScan(
  deps: VocabBookSource,
  job: MockJob,
  uid: string,
  rootDeckId: number,
  excluded: number[],
  range: VocabRangeSpec,
  config: VocabConfig,
): Promise<void> {
  const fail = (e: unknown) => {
    const error =
      e instanceof CoreError
        ? { code: e.code, message: e.message }
        : { code: 'unknown', message: 'Não foi possível escanear o vocabulário.' };
    emit(job, { stage: 'failed', error });
  };
  try {
    await tick();
    if (job.cancelled) return emit(job, { stage: 'cancelled' });
    let table = tableFor(deps, uid);
    const pages = deps.book(uid).pages;
    if (table) {
      emit(job, { reused: true });
    } else {
      emit(job, { stage: 'text', done: 0, total: pages });
      const step = Math.max(10, Math.ceil(pages / 4));
      for (let done = step; done < pages; done += step) {
        await tick();
        if (job.cancelled) return emit(job, { stage: 'cancelled' });
        emit(job, { done });
      }
      table = readTable(deps, uid);
      emit(job, { done: pages });
      await tick();
      emit(job, { stage: 'lemmas', done: 0, total: pages });
      await tick();
      if (job.cancelled) return emit(job, { stage: 'cancelled' });
      emit(job, { done: pages });
    }
    emit(job, { stage: 'known', done: 0, total: 1 });
    await tick();
    if (job.cancelled) return emit(job, { stage: 'cancelled' });
    emit(job, { stage: 'compare', done: 0, total: 1 });
    await tick();
    if (job.cancelled) return emit(job, { stage: 'cancelled' });
    const scan = computeReport(deps, uid, job.progress.scanUid, table, rootDeckId, excluded, range, config);
    state.scans[uid] = scan;
    persist();
    emit(job, { stage: 'done', done: 1, total: 1 });
  } catch (e) {
    fail(e);
  }
}

function startScan(
  deps: VocabBookSource,
  uid: string,
  rootDeckId: number,
  excluded: number[],
  range: VocabRangeSpec,
  config: VocabConfig,
): { jobId: string; scanUid: string } {
  if (!state.dataAvailable) throw err.dataMissing();
  const book = deps.book(uid);
  liveRoot(rootDeckId);
  const cfg = checkConfig(config);
  try {
    resolveRange(range, deps.outline(uid), book.pages, book.unit);
  } catch (e) {
    rangeError(e);
  }
  if (!book.hasText) throw err.needsOcr();
  const params = JSON.stringify([rootDeckId, [...excluded].sort((a, b) => a - b), range, cfg]);
  const running = runningJob('vocabScan', uid);
  // The same scan already running is returned; a different one (another range, folder or criterion) replaces it.
  if (running && running.params === params) {
    return { jobId: running.progress.jobId, scanUid: running.progress.scanUid };
  }
  if (running) running.cancelled = true;
  // The folder and the criterion become the defaults (spec 12.1).
  mockSetVocabRoot(rootDeckId);
  state.excludedDeckIds = [...excluded];
  state.config = cfg;
  const jobId = `vocab-${state.nextJob++}`;
  persist();
  const job: MockJob = {
    progress: {
      jobId,
      kind: 'vocabScan',
      bookUid: uid,
      scanUid: uuid(),
      stage: 'queued',
      done: 0,
      total: 0,
      reused: false,
      error: null,
    },
    cancelled: false,
    params,
  };
  addJob(job);
  void runScan(deps, job, uid, rootDeckId, [...excluded], range, cfg);
  return { jobId, scanUid: job.progress.scanUid };
}

// ---------------------------------------------------------------- deck generation (spec 12.6)

const POS_PT: Record<string, string> = { n: 'substantivo', v: 'verbo', a: 'adjetivo', r: 'advérbio' };

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Like `core_anki::study::source::source_html` (features/book-panel/fonte.ts). */
function fonteHtml(uid: string, title: string, page1: number, query: string): string {
  const s = query.replace(/\s+/g, ' ').trim().slice(0, 80);
  const q = s ? `&amp;q=${encodeURIComponent(s)}` : '';
  return `<a href="leitor://livro/${uid}?pagina=${page1}${q}">${escapeHtml(title)}, p. ${page1}</a>`;
}

/** Like `core_anki::study::source::source_html_section` (EPUB, no CFI): `?cap=N&q=…`, label `cap. N`. */
function fonteHtmlSection(uid: string, title: string, section1: number, query: string): string {
  const s = query.replace(/\s+/g, ' ').trim().slice(0, 80);
  const q = s ? `&amp;q=${encodeURIComponent(s)}` : '';
  return `<a href="leitor://livro/${uid}?cap=${section1}${q}">${escapeHtml(title)}, cap. ${section1}</a>`;
}

/** The example with the form in bold. */
function exampleHtml(row: Pick<VocabRow, 'example' | 'exampleSpan'>): string {
  if (!row.example) return '';
  const span = row.exampleSpan;
  if (!span) return escapeHtml(row.example);
  return (
    escapeHtml(row.example.slice(0, span[0])) +
    `<b>${escapeHtml(row.example.slice(span[0], span[1]))}</b>` +
    escapeHtml(row.example.slice(span[1]))
  );
}

function vocabNotetype(): MockNotetype {
  const nt = ankiState().notetypes.find((n) => n.name === APP_VOCAB_TYPE);
  if (!nt) throw err.prepare();
  return nt;
}

function nextNewPosition(): number {
  return ankiState().cards.reduce((m, c) => (c.queue === 'new' ? Math.max(m, c.due) : m), 0) + 1;
}

function addVocabNote(
  nt: MockNotetype,
  deckId: number,
  values: Record<string, string>,
  tags: string[],
  due: number,
): number {
  const s = ankiState();
  const fields = nt.fields.map((f) => values[f] ?? '');
  const id = newId();
  s.notes.push({ id, notetypeId: nt.id, fields, tags, mtime: Date.now() });
  nt.templates.forEach((_, ord) => {
    const need = nt.templateRequires?.[ord];
    if (need !== undefined && !values[need]) return;
    s.cards.push({
      id: newId(),
      noteId: id,
      deckId,
      ord,
      queue: 'new',
      due,
      ivl: 0,
      ease: 0,
      reps: 0,
      lapses: 0,
      flag: 0,
    });
  });
  return id;
}

function noteValues(
  uid: string,
  title: string,
  row: VocabRow,
  card2: boolean,
  unit: RangeUnit = 'page',
): Record<string, string> {
  const at = (row.examplePage ?? row.firstPage) + 1;
  return {
    Palavra: row.group === 'proper' ? row.form : row.lemma,
    Lema: row.lemma.toLowerCase(),
    Classe: row.pos ? (POS_PT[row.pos] ?? '') : '',
    Definição: escapeHtml(definitionOf(row.lemma.toLowerCase()) ?? ''),
    Tradução: '',
    Exemplo: exampleHtml(row),
    Fonte: unit === 'chapter' ? fonteHtmlSection(uid, title, at, row.form) : fonteHtml(uid, title, at, row.form),
    Frequência: String(row.occurrences),
    Família: row.family?.lemma ?? '',
    'Card 2': card2 ? '1' : '',
  };
}

function generate(
  deps: VocabBookSource,
  uid: string,
  scanUid: string,
  lemmas: string[],
  options: VocabDeckOptions,
): VocabDeckResult {
  const book = deps.book(uid);
  const scan = state.scans[uid];
  if (!scan) throw err.noScan();
  if (scan.scanUid !== scanUid) throw err.stale();
  if (options.enrich === 'ai') throw err.ai();
  const nt = vocabNotetype();
  const report = scan.report;
  const wanted = new Set(lemmas);
  const rows = report.rows.filter((r) => wanted.has(r.lemma));
  const previous = bookNotes(uid);
  const index = readIndex(scan.rootDeckId, scan.excludedDeckIds, scan.config);
  const skippedPrevious: string[] = [];
  const skippedExisting: string[] = [];
  const todo: VocabRow[] = [];
  for (const r of rows) {
    const key = r.lemma.toLowerCase();
    if (r.existingNoteId !== null || previous.has(key)) skippedPrevious.push(r.lemma);
    else if (index.lemmas.has(key) || index.forms.has(key) || index.phrases.has(key)) skippedExisting.push(r.lemma);
    else todo.push(r);
  }
  todo.sort(options.order === 'frequency' ? byCurveOrder : byReadingOrder);
  const naming = report.deck;
  const mainName = options.perChapter ? naming.baseName : naming.fullName;
  const mainId = createDeck(mainName);
  const decks = new Set<string>();
  const noteIds: number[] = [];
  let due = nextNewPosition();
  for (const r of todo) {
    // Like `VocabDeckNames::deck_for`: per-chapter subdecks live under the book deck.
    const deckName =
      options.perChapter && r.chapter !== null ? `${naming.baseName}::${chapterDeckName(r.chapter)}` : mainName;
    const deckId = deckName === mainName ? mainId : createDeck(deckName);
    decks.add(deckName);
    const tags = [naming.bookTag];
    if (naming.rangeTag) tags.push(naming.rangeTag);
    if (r.chapter !== null) tags.push(chapterTag(r.chapter));
    noteIds.push(addVocabNote(nt, deckId, noteValues(uid, book.title, r, options.card2, book.unit), tags, due++));
  }
  if (!decks.size) decks.add(mainName);
  persistAnki();
  logAnki('vocabGenerate', { uid, deck: mainName, created: noteIds.length, options: { ...options } });
  // The report's statuses follow the collection right away (spec 12.6 "atualizar os status do relatório").
  const table = tableFor(deps, uid);
  if (table) {
    state.scans[uid] = {
      ...computeReport(deps, uid, scanUid, table, scan.rootDeckId, scan.excludedDeckIds, scan.range, scan.config),
      scanUid,
    };
    persist();
  }
  return {
    deckId: mainId,
    deckName: mainName,
    decks: [...decks].sort(),
    created: noteIds.length,
    noteIds,
    skippedExisting,
    skippedPrevious,
  };
}

// ---------------------------------------------------------------- reading (spec 12.7)

function liveStatus(scan: StoredScan, lemma: string): VocabStatus | null {
  const o = state.overrides[lemma.toLowerCase()];
  if (o) return o;
  return scan.report.rows.find((r) => r.lemma === lemma)?.status ?? null;
}

/** Coral (unknown, suspended) and amber (learning, new), like `MARK_*_COLOR` in the core. */
const MARK_UNKNOWN_COLOR = '#d85a30';
const MARK_LEARNING_COLOR = '#ba7517';

/** EPUB sections at most per `vocab_epub_marks` call (`MAX_EPUB_MARK_SECTIONS`). */
const MAX_MARK_UNITS = 5;

/**
 * `vocab_epub_marks`: for each section, the word forms the reader colors (lowercase, unique, sorted): forms whose
 * lemma is unknown/suspended (coral) or learning/new (amber); proper nouns, ignored and known words get no color.
 */
function epubMarks(deps: VocabBookSource, uid: string, sections: number[]): EpubSectionMarks[] {
  if (sections.length > MAX_MARK_UNITS) throw err.invalid(`Peça no máximo ${MAX_MARK_UNITS} capítulos de cada vez.`);
  const book = deps.book(uid);
  if (book.unit !== 'chapter') throw err.notEpub();
  const scan = state.scans[uid];
  if (!scan) throw err.notScanned();
  const out: EpubSectionMarks[] = [];
  for (const section of sections) {
    const words: EpubSectionMarks['words'] = [];
    if (Number.isInteger(section) && section >= 0 && section < book.pages) {
      const seen = new Set<string>();
      for (const w of wordsOf(deps.pageText(uid, section))) {
        const form = w.form.toLowerCase().replace(/[’‘]/g, "'");
        if (seen.has(form)) continue;
        seen.add(form);
        const lemma = scan.formToLemma[form];
        if (!lemma) continue;
        const status = liveStatus(scan, lemma);
        if (status !== 'unknown' && status !== 'suspended' && status !== 'learning' && status !== 'new') continue;
        const color = status === 'learning' || status === 'new' ? MARK_LEARNING_COLOR : MARK_UNKNOWN_COLOR;
        words.push({ form, lemma, status, color });
      }
    }
    words.sort((a, b) => (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
    out.push({ section, words });
  }
  return out;
}

function marks(deps: VocabBookSource, uid: string, pages: number[]): VocabPageMarks[] {
  const book = deps.book(uid);
  if (book.unit !== 'page') throw err.notPdf();
  const scan = state.scans[uid];
  const out: VocabPageMarks[] = [];
  for (const page of [...new Set(pages)].sort((a, b) => a - b)) {
    if (!Number.isInteger(page) || page < 0 || page >= book.pages) continue;
    if (!scan) {
      out.push({ page, marks: [] });
      continue;
    }
    const words = deps.pageWords(uid, page);
    const list: VocabPageMarks['marks'] = [];
    for (const w of words.words) {
      const piece = wordsOf(w.text)[0];
      if (!piece) continue;
      const lemma = scan.formToLemma[piece.form.toLowerCase()];
      if (!lemma) continue;
      const status = liveStatus(scan, lemma);
      const kind = status === 'unknown' ? 'unknown' : status === 'learning' || status === 'new' ? 'learning' : null;
      if (!kind) continue;
      list.push({ lemma, form: w.text, status: kind, rects: w.rects.map((r) => [...r] as typeof r) });
    }
    out.push({ page, marks: list });
  }
  return out;
}

function addWord(deps: VocabBookSource, uid: string, lemma: string, page: number, form: string): VocabWordAdded {
  const book = deps.book(uid);
  const nt = vocabNotetype();
  const scan = state.scans[uid];
  const key = lemma.trim().toLowerCase();
  if (!key) throw err.invalid('Escolha uma palavra.');
  const root = rootDeck();
  const deckName =
    scan?.report.deck.baseName ?? (root ? `${root.name}::Livros::${book.title}` : `Livros::${book.title}`);
  const deckId = createDeck(deckName);
  const row: VocabRow = scan?.report.rows.find((r) => r.lemma.toLowerCase() === key) ?? {
    lemma: key,
    form,
    pos: posOf(key),
    group: 'main',
    status: 'unknown',
    statusSource: null,
    occurrences: 1,
    firstPage: page,
    pages: [page],
    zipf: null,
    rare: false,
    example: null,
    exampleSpan: null,
    examplePage: page,
    base: null,
    family: null,
    existingNoteId: null,
    defaultSelected: false,
    chapter: null,
    position: 0,
  };
  const values = noteValues(uid, book.title, { ...row, form: form || row.form, examplePage: page }, false, book.unit);
  const tags = [scan?.report.deck.bookTag ?? `livro::${slugify(book.title) || 'livro'}`];
  const noteId = addVocabNote(nt, deckId, values, tags, nextNewPosition());
  persistAnki();
  logAnki('vocabAddWord', { uid, lemma: key, noteId, deckId });
  if (scan) {
    for (const r of scan.report.rows)
      if (r.lemma.toLowerCase() === key) {
        r.status = 'new';
        r.statusSource = 'deck';
        r.existingNoteId = noteId;
        r.defaultSelected = false;
      }
    persist();
  }
  return { noteId, deckId, deckName: deckById(deckId)?.name ?? deckName };
}

const DATA_INFO: VocabDataInfo = {
  available: true,
  // The pinned sources of scripts/build-wordnet.sh (data/README.md).
  wordnet: {
    name: 'Open English WordNet',
    version: '2025',
    license: 'CC-BY-4.0',
    url: 'https://github.com/globalwordnet/english-wordnet',
  },
  frequency: {
    name: 'wordfreq (large_en, 100 mil palavras mais frequentes)',
    version: '3.1.1',
    license: 'CC-BY-SA-4.0',
    url: 'https://github.com/rspeer/wordfreq',
  },
  stopwords: {
    name: 'Snowball English stop word list',
    version: 'dc14fb462784e5bdf90f3210022b0f91d3881ffd',
    license: 'BSD-3-Clause',
    url: 'https://snowballstem.org/algorithms/english/stop.txt',
  },
  schemaVersion: 1,
};

// ---------------------------------------------------------------- client

export type VocabMockKeys =
  | 'vocabSettingsGet'
  | 'vocabSettingsSet'
  | 'vocabFolder'
  | 'vocabMappingSamples'
  | 'vocabMappingGet'
  | 'vocabMappingSet'
  | 'vocabOutline'
  | 'vocabRangeCheck'
  | 'vocabScanStart'
  | 'vocabRescan'
  | 'vocabReport'
  | 'vocabOverrideSet'
  | 'vocabGenerateDeck'
  | 'vocabMarks'
  | 'vocabAddWord'
  | 'vocabDataInfo'
  | 'vocabEpubMarks'
  | JobMockKeys;

export function createVocabMock(deps: VocabBookSource): Pick<CoreClient, VocabMockKeys> {
  setVocabBridge({
    panel: (uid, page) => panelVocab(deps, uid, page),
    define: (lemma, bookUid) => defineExtras(lemma, bookUid),
    lemma: (word) => lemmatize(word),
  });
  return {
    vocabSettingsGet: () => later(settings),
    vocabSettingsSet: (patch) =>
      later(() => {
        if (patch.rootDeckId !== undefined) {
          if (patch.rootDeckId !== null) liveRoot(patch.rootDeckId);
          mockSetVocabRoot(patch.rootDeckId);
        }
        if (patch.excludedDeckIds !== undefined) state.excludedDeckIds = [...patch.excludedDeckIds];
        if (patch.config !== undefined) state.config = checkConfig(patch.config);
        persist();
        return settings();
      }),
    vocabFolder: (rootDeckId) => later(() => folder(rootDeckId)),
    vocabMappingSamples: (rootDeckId, excludedDeckIds, notetypeId, field) =>
      later(() => {
        liveRoot(rootDeckId);
        const nt = ankiState().notetypes.find((n) => n.id === notetypeId);
        if (!nt) throw new CoreError('anki_not_found', 'Tipo de nota não encontrado.');
        return samples(nt, field, folderDecks(rootDeckId, excludedDeckIds));
      }),
    vocabMappingGet: () => later(mappings),
    vocabMappingSet: (notetypeId, field) => later(() => setMapping(notetypeId, field)),
    vocabOutline: (uid) => later(() => outline(deps, uid)),
    vocabRangeCheck: (uid, range) =>
      later(() => {
        const book = deps.book(uid);
        try {
          return resolveRange(range, deps.outline(uid), book.pages, book.unit);
        } catch (e) {
          return rangeError(e);
        }
      }),
    vocabScanStart: (uid, rootDeckId, excludedDeckIds, range, config) =>
      later(() => startScan(deps, uid, rootDeckId, excludedDeckIds, range, config)),
    vocabRescan: (uid) =>
      later(() => {
        const scan = state.scans[uid];
        if (!scan) throw err.noScan();
        const s = settings();
        const root = s.rootDeckId ?? scan.rootDeckId;
        const excluded = s.rootDeckId === scan.rootDeckId ? s.excludedDeckIds : scan.excludedDeckIds;
        return startScan(deps, uid, root, excluded, scan.range, s.config);
      }),
    vocabReport: (uid) =>
      later(() => {
        deps.book(uid);
        const scan = state.scans[uid];
        return scan ? structuredClone(scan.report) : null;
      }),
    vocabOverrideSet: (lemmas, status) =>
      later(() => {
        for (const raw of lemmas) {
          const key = raw.trim().toLowerCase();
          if (!key) continue;
          if (status === null) delete state.overrides[key];
          else state.overrides[key] = status;
        }
        persist();
      }),
    vocabGenerateDeck: (uid, scanUid, lemmas, options) => later(() => generate(deps, uid, scanUid, lemmas, options)),
    vocabMarks: (uid, pages) => later(() => marks(deps, uid, pages)),
    vocabAddWord: (uid, lemma, page, form) => later(() => addWord(deps, uid, lemma, page, form)),
    vocabEpubMarks: (uid, sections) => later(() => epubMarks(deps, uid, sections)),
    vocabDataInfo: () =>
      later(() =>
        state.dataAvailable
          ? structuredClone(DATA_INFO)
          : { available: false, wordnet: null, frequency: null, stopwords: null, schemaVersion: null },
      ),
    ...createJobsMock(later),
  };
}

// ---------------------------------------------------------------- book panel and "Definir palavra" (spec 10.1, 12.7)

function panelVocab(
  deps: VocabBookSource,
  uid: string,
  page: number | undefined,
): { vocab: BookPanelVocab | null; chapterDeck: BookDeckInfo | null } {
  const scan = state.scans[uid];
  if (!scan) return { vocab: null, chapterDeck: null };
  const r = scan.report;
  const vocab: BookPanelVocab = {
    scanUid: r.scanUid,
    coverageKnown: r.metrics.coverageKnown,
    coverageWithLearning: r.metrics.coverageWithLearning,
    rangeLabel: r.range.label,
    scannedAt: r.scannedAt,
  };
  let chapterDeck: BookDeckInfo | null = null;
  if (page !== undefined && page !== null) {
    const book = deps.book(uid);
    const chapter = bookChapters(deps.outline(uid), book.pages, book.unit).find(
      (c) => page >= c.startPage && page <= c.endPage,
    );
    if (chapter) {
      const suffix = `::${chapterDeckName(chapter.index)}`;
      const base = r.deck.baseName.toLowerCase();
      const deck = ankiState()
        .decks.filter((d) => d.name.toLowerCase().startsWith(`${base}::`) && d.name.endsWith(suffix))
        .sort((a, b) => a.name.length - b.name.length)[0];
      if (deck) {
        chapterDeck = { role: 'vocab', deckId: deck.id, name: deck.name, exists: true, counts: deckCounts(deck.id) };
      }
    }
  }
  return { vocab, chapterDeck };
}

function defineExtras(
  lemma: string,
  bookUid: string | null,
): Pick<WordDefinition, 'pos' | 'status' | 'family' | 'wordnetDefinition'> {
  const key = lemma.toLowerCase();
  const scan = bookUid ? state.scans[bookUid] : undefined;
  const row = scan?.report.rows.find((r) => r.lemma.toLowerCase() === key);
  return {
    pos: posOf(key),
    status: scan ? (liveStatus(scan, row?.lemma ?? key) ?? null) : null,
    family: row?.family ?? null,
    wordnetDefinition: state.dataAvailable ? definitionOf(key) : null,
  };
}

// ---------------------------------------------------------------- test hooks

/** `window.__leitorMock.vocab`. */
export interface MockVocabHandle {
  /** Times a book's text was read to build its per-page table. */
  readonly textReads: number;
  readonly overrides: Record<string, VocabOverride>;
  /** `false`: the vocabulary data is not installed (`vocab_data_missing`). */
  setDataAvailable(available: boolean): void;
  /** Delay of each scan step (ms); `null` restores the default (half the mock latency). */
  setJobDelay(ms: number | null): void;
  /** Saves a field mapping without the UI. */
  setMapping(notetypeName: string, field: string): void;
}

export const mockVocabHandle: MockVocabHandle = {
  get textReads() {
    return state.textReads;
  },
  get overrides() {
    return { ...state.overrides };
  },
  setDataAvailable(available) {
    state.dataAvailable = available;
    persist();
  },
  setJobDelay(ms) {
    jobDelayMs = ms;
  },
  setMapping(notetypeName, field) {
    const nt = ankiState().notetypes.find((n) => n.name === notetypeName);
    if (!nt) throw new Error(`no notetype ${notetypeName}`);
    setMapping(nt.id, field);
  },
};

/** Whether the book has a finished scan (`LibraryEntry.vocabScanned`). */
export function vocabScanned(uid: string): boolean {
  return state.scans[uid] !== undefined;
}

export function resetVocab(): void {
  state = initial();
  clearJobs();
  jobDelayMs = null;
  persist();
}
