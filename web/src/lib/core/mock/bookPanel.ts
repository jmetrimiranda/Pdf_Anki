// Mock of the book panel commands (spec 10, 12.7, 10.2): the book's decks with their counts, per-book preferences,
// the notes whose Fonte links to the book ("Cards desta página"), "Definir palavra" and the `leitor://` deep links.
// Same rules as `app/src/book_panel.rs` and `app/src/deep_link.rs` in the core.
import {
  CoreError,
  type BookCard,
  type BookCardKind,
  type BookDeckInfo,
  type BookPanelInfo,
  type BookPanelPatch,
  type CoreClient,
  type BookPanelVocab,
  type DeepLink,
  type WordDefinition,
} from '../types';
import {
  ankiState,
  deckById,
  deckByName,
  deckCounts,
  later,
  listenTo,
  logAnki,
  type BookPanelMockKeys,
} from './ankiData';
import { parseDeepLink, parseSourceLink } from './ankiStudy';

/** What the panel needs from the mock library (mock.ts). */
export interface BookPanelDeps {
  /** The live book's title and content deck; throws `book_not_found` like the core. */
  book(uid: string): { title: string; contentDeckId: number | null };
  setContentDeckId(uid: string, deckId: number | null): void;
}

interface BookPrefs {
  lastDeckId: number | null;
  lastKind: BookCardKind | null;
  reviewDeckId: number | null;
}

interface PanelState {
  /** Setting `vocab_root_deck_id` (chosen in Phase 6; `__leitorMock.setVocabRoot` in tests). */
  vocabRootDeckId: number | null;
  prefs: Record<string, BookPrefs>;
  pendingDeepLinks: DeepLink[];
}

const STORAGE_KEY = 'leitor.mock.bookPanel';
const KINDS: readonly BookCardKind[] = ['basic', 'cloze', 'codeCommand', 'codeProgram', 'vocab'];
const MAX_WORD_CHARS = 64;
const PREVIEW_CHARS = 120;

function initial(): PanelState {
  return { vocabRootDeckId: null, prefs: {}, pendingDeepLinks: [] };
}

function load(): PanelState {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PanelState;
      if (parsed && typeof parsed.prefs === 'object' && Array.isArray(parsed.pendingDeepLinks)) return parsed;
    }
  } catch {
    // Corrupt storage: start over.
  }
  return initial();
}

let state: PanelState = load();

function persist(): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Keep the in-memory state only.
  }
}

const deepLinkListeners = new Set<(l: DeepLink) => void>();

/** What the panel and "Definir palavra" take from the vocabulary mock (mock/vocab.ts registers it). */
export interface VocabBridge {
  panel(uid: string, page: number | undefined): { vocab: BookPanelVocab | null; chapterDeck: BookDeckInfo | null };
  define(
    lemma: string,
    bookUid: string | null,
  ): Pick<WordDefinition, 'pos' | 'status' | 'family' | 'wordnetDefinition'>;
  lemma(word: string): string;
}

let vocabBridge: VocabBridge | null = null;

export function setVocabBridge(bridge: VocabBridge): void {
  vocabBridge = bridge;
}

// ---------------------------------------------------------------- helpers

function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function preview(html: string): string {
  const text = plain(html);
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

function deckNotFound(): CoreError {
  return new CoreError('deck_not_found', 'O deck escolhido não existe mais.');
}

function liveDeckId(id: number | null | undefined): number | null {
  return id != null && deckById(id) ? id : null;
}

function deckInfo(role: BookDeckInfo['role'], name: string, deckId: number | null): BookDeckInfo {
  const deck = deckId !== null ? deckById(deckId) : deckByName(name);
  if (!deck) return { role, deckId, name, exists: false, counts: null };
  return { role, deckId: deck.id, name: deck.name, exists: true, counts: deckCounts(deck.id) };
}

function vocabRoot(): { id: number; name: string } | null {
  const d = state.vocabRootDeckId !== null ? deckById(state.vocabRootDeckId) : undefined;
  return d ? { id: d.id, name: d.name } : null;
}

function prefsOf(uid: string): BookPrefs {
  return state.prefs[uid] ?? { lastDeckId: null, lastKind: null, reviewDeckId: null };
}

function info(deps: BookPanelDeps, uid: string, page?: number): BookPanelInfo {
  const book = deps.book(uid);
  const root = vocabRoot();
  const vocabName = root ? `${root.name}::Livros::${book.title}` : `Livros::${book.title}`;
  const prefs = prefsOf(uid);
  return {
    bookUid: uid,
    title: book.title,
    vocabRootDeckId: root?.id ?? null,
    vocabRootName: root?.name ?? null,
    vocabDeck: deckInfo('vocab', vocabName, null),
    contentDeck:
      book.contentDeckId === null
        ? null
        : deckById(book.contentDeckId)
          ? deckInfo('content', '', book.contentDeckId)
          : { role: 'content', deckId: book.contentDeckId, name: '', exists: false, counts: null },
    lastDeckId: liveDeckId(prefs.lastDeckId),
    lastKind: prefs.lastKind,
    reviewDeckId: liveDeckId(prefs.reviewDeckId),
    ...(vocabBridge?.panel(uid, page) ?? { vocab: null, chapterDeck: null }),
  };
}

function checkDeck(id: number | null | undefined): void {
  if (id != null && !deckById(id)) throw deckNotFound();
}

function setPanel(deps: BookPanelDeps, uid: string, patch: BookPanelPatch): BookPanelInfo {
  deps.book(uid);
  checkDeck(patch.contentDeckId);
  checkDeck(patch.lastDeckId);
  checkDeck(patch.reviewDeckId);
  if (patch.lastKind != null && !KINDS.includes(patch.lastKind)) {
    throw new CoreError('invalid_input', 'Tipo de card desconhecido.');
  }
  if (patch.contentDeckId !== undefined) deps.setContentDeckId(uid, patch.contentDeckId);
  const prefs = { ...prefsOf(uid) };
  if (patch.lastDeckId !== undefined) prefs.lastDeckId = patch.lastDeckId;
  if (patch.lastKind !== undefined) prefs.lastKind = patch.lastKind;
  if (patch.reviewDeckId !== undefined) prefs.reviewDeckId = patch.reviewDeckId;
  state.prefs[uid] = prefs;
  persist();
  logAnki('bookPanelSet', { uid, patch: { ...patch } });
  return info(deps, uid);
}

function fieldIndex(fields: string[], name: string): number {
  return fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
}

/** Notes whose Fonte links to `uid`, by page then note id (like `core_anki::book::book_cards`). */
function bookCards(uid: string): BookCard[] {
  if (!/^[0-9a-f]{64}$/.test(uid))
    throw new CoreError('anki_invalid_input', 'Entrada inválida: identificador de livro inválido.');
  const s = ankiState();
  const out: BookCard[] = [];
  for (const note of s.notes) {
    const nt = s.notetypes.find((t) => t.id === note.notetypeId);
    if (!nt) continue;
    const fi = fieldIndex(nt.fields, 'Fonte');
    if (fi < 0) continue;
    const link = parseSourceLink(note.fields[fi] ?? '');
    if (!link || link.bookUid !== uid) continue;
    const cards = s.cards.filter((c) => c.noteId === note.id).sort((a, b) => a.ord - b.ord);
    if (!cards.length) continue;
    out.push({
      noteId: note.id,
      cardIds: cards.map((c) => c.id),
      deckId: cards[0]!.deckId,
      notetype: nt.name,
      page: link.page,
      query: link.query,
      preview: preview(note.fields[0] ?? ''),
    });
  }
  return out.sort((a, b) => a.page - b.page || a.noteId - b.noteId);
}

// ---------------------------------------------------------------- "Definir palavra"

/** The mock engine's lemma (mock/vocabEngine.ts), like `core_vocab::lemma`. */
export function mockLemma(word: string): string {
  const w = word.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/'s$/, '');
  return vocabBridge ? vocabBridge.lemma(w) : w;
}

/** Like `core_vocab::single_word`: the selection trimmed of surrounding punctuation, if it is exactly one word. */
export function mockSingleWord(text: string): string | null {
  const t = text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!t || t.length > MAX_WORD_CHARS) return null;
  if (!/\p{L}/u.test(t)) return null;
  return /^[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*$/u.test(t) ? t : null;
}

function bookTitle(deps: BookPanelDeps, uid: string | null): string | null {
  if (uid === null) return null;
  try {
    return deps.book(uid).title;
  } catch {
    return null; // An unknown book only loses the fallback, like the core.
  }
}

function define(deps: BookPanelDeps, word: string, bookUid: string | null): WordDefinition {
  const trimmed = word.trim();
  const single = trimmed.length <= MAX_WORD_CHARS ? mockSingleWord(trimmed) : null;
  if (!single) throw new CoreError('invalid_input', 'Selecione uma só palavra.');
  const lemma = mockLemma(single);
  const root = vocabRoot();
  // Until the folder is chosen (Phase 6): the book's own vocabulary deck `Livros::<Título>` (book_panel.rs).
  const title = root ? null : bookTitle(deps, bookUid);
  const search = root ?? (title !== null ? (deckByName(`Livros::${title}`) ?? null) : null);
  let note: WordDefinition['note'] = null;
  if (search) {
    const s = ankiState();
    const prefix = `${search.name}::`;
    const under = new Set(s.decks.filter((d) => d.id === search.id || d.name.startsWith(prefix)).map((d) => d.id));
    const keys = new Set([lemma, single.toLowerCase()]);
    // The first note (by id) under the searched deck whose Lema/Palavra field matches (`core_anki::book::vocab_lookup`).
    for (const n of [...s.notes].sort((a, b) => a.id - b.id)) {
      const nt = s.notetypes.find((t) => t.id === n.notetypeId);
      const card = s.cards.find((c) => c.noteId === n.id && under.has(c.deckId));
      if (!nt || !card) continue;
      const idx = ['Lema', 'Palavra', 'Lemma', 'Word'].map((f) => fieldIndex(nt.fields, f)).filter((i) => i >= 0);
      // Types without those fields: the sort field (the first one in the mock).
      const words = (idx.length ? idx : [0]).map((i) => plain(n.fields[i] ?? '').toLowerCase());
      if (!words.some((w) => keys.has(w))) continue;
      const di = fieldIndex(nt.fields, 'Definição');
      const definition = di >= 0 ? plain(n.fields[di] ?? '') || null : null;
      const cardDeck = s.cards.filter((c) => c.noteId === n.id).sort((a, b) => a.id - b.id)[0]?.deckId ?? card.deckId;
      note = {
        noteId: n.id,
        deckName: deckById(cardDeck)?.name ?? '',
        notetype: nt.name,
        definition,
        preview: preview(n.fields[0] ?? ''),
      };
      break;
    }
  }
  const extras = vocabBridge?.define(lemma, bookUid) ?? {
    pos: null,
    status: null,
    family: null,
    wordnetDefinition: null,
  };
  return {
    word: single,
    lemma,
    ...extras,
    definitionSource: note?.definition ? 'note' : extras.wordnetDefinition ? 'wordnet' : null,
    vocabRootDeckId: root?.id ?? null,
    vocabRootName: root?.name ?? null,
    note,
  };
}

// ---------------------------------------------------------------- client

export function createBookPanelMock(deps: BookPanelDeps): Pick<CoreClient, BookPanelMockKeys> {
  return {
    bookPanelInfo: (uid, page) => later(() => info(deps, uid, page)),
    bookPanelSet: (uid, patch) => later(() => setPanel(deps, uid, patch)),
    ankiBookCards: (uid) => later(() => bookCards(uid)),
    vocabDefine: (word, bookUid) => later(() => define(deps, word, bookUid)),
    pendingDeepLinks: () =>
      later(() => {
        const links = state.pendingDeepLinks;
        state.pendingDeepLinks = [];
        persist();
        return links;
      }),
    onDeepLink: (cb) => listenTo(deepLinkListeners, cb),
  };
}

// ---------------------------------------------------------------- test hooks

/** Setting `vocab_root_deck_id` (shared with the vocabulary mock). */
export function mockVocabRootId(): number | null {
  return state.vocabRootDeckId;
}

export function mockSetVocabRoot(deckId: number | null): void {
  state.vocabRootDeckId = deckId;
  persist();
}

/** Simulates the OS opening a `leitor://` URL while the app runs (ignored when invalid, like the core). */
export function mockDeepLink(url: string): void {
  const link = parseDeepLink(url);
  logAnki('deepLink', { url, valid: link !== null });
  if (!link) return;
  for (const cb of [...deepLinkListeners]) cb(link);
}

/** URLs the app was "launched with" (`pendingDeepLinks()`); invalid ones are dropped. */
export function mockSetPendingDeepLinks(urls: string[]): void {
  state.pendingDeepLinks = urls.map(parseDeepLink).filter((l): l is DeepLink => l !== null);
  persist();
}

export function resetBookPanel(): void {
  state = initial();
  persist();
}
