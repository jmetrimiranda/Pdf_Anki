// Mock of the notes, notetypes, browser search/rows, bulk operations and media commands, over the shared mock
// collection (mock/ankiData.ts). The search understands a SUBSET of Anki's syntax, enough for the UI and the e2e
// tests: words (substring of any field, `*` wildcard), "quoted phrases", `-` negation, `OR`, parentheses,
// `deck:` (with subdecks, `deck:current`), `tag:` (with child tags), `note:`, `card:` (ordinal), `flag:N`,
// `is:due|new|learn|review|suspended|buried|marked`, `nid:`/`cid:` lists and `field:value`. Anything else Anki
// accepts may behave differently here; the real core runs rslib's own parser.
import { CoreError, type BrowseOrder, type BrowseRow, type CoreClient, type NoteCheck } from '../types';
import {
  ankiState,
  DAY_MS,
  DEFAULT_DECK_ID,
  deckById,
  later,
  logAnki,
  newId,
  NT_BASIC,
  persistAnki,
  subtree,
  today,
  type AnkiNotesMockKeys,
  type MockCard,
  type MockNote,
  type MockNotetype,
} from './ankiData';

export const MOCK_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'];
export const DEFAULT_IMAGE_PICK = '/home/jorge/Imagens/diagrama-ros2.png';

// ---------------------------------------------------------------- helpers

function stripHtml(html: string): string {
  return html
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<br\s*\/?>|<\/?(div|p|li)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function notetype(id: number): MockNotetype {
  const nt = ankiState().notetypes.find((n) => n.id === id);
  if (!nt) throw new CoreError('anki_not_found', 'Não encontrado: tipo de nota.');
  return nt;
}

function note(id: number): MockNote {
  const n = ankiState().notes.find((x) => x.id === id);
  if (!n) throw new CoreError('anki_not_found', `Não encontrado: nota ${id}`);
  return n;
}

function clozeNumbers(fields: string[]): number[] {
  const set = new Set<number>();
  for (const f of fields) for (const m of f.matchAll(/\{\{c(\d+)::/g)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

function hasCloze(s: string): boolean {
  return /\{\{c\d+::/.test(s);
}

/** Port of rslib's `note_fields_check`. */
function checkFields(nt: MockNotetype, fields: string[], noteId = 0): NoteCheck {
  // Cloze notetypes: only the first field holds clozes (the stock cloze field).
  for (let i = 0; i < fields.length; i++) {
    if (!hasCloze(fields[i]!)) continue;
    if (nt.kind !== 'cloze') return 'notetypeNotCloze';
    if (i !== 0) return 'fieldNotCloze';
  }
  const first = stripHtml(fields[0] ?? '');
  if (!first) return 'empty';
  if (nt.kind === 'cloze' && !hasCloze(fields[0] ?? '')) return 'missingCloze';
  const dupe = ankiState().notes.some(
    (n) => n.id !== noteId && n.notetypeId === nt.id && stripHtml(n.fields[0] ?? '') === first,
  );
  return dupe ? 'duplicate' : 'normal';
}

const BLOCKING: Partial<Record<NoteCheck, string>> = {
  empty: 'Nota inválida: o primeiro campo está vazio.',
  missingCloze: 'Nota inválida: não há nenhuma lacuna ({{c1::…}}) num tipo de nota Cloze.',
  notetypeNotCloze: 'Nota inválida: lacunas ({{c1::…}}) só funcionam em tipos de nota Cloze.',
  fieldNotCloze: 'Nota inválida: lacunas ({{c1::…}}) só funcionam no campo de texto do Cloze.',
};

function validateFieldCount(nt: MockNotetype, fields: string[]): void {
  if (fields.length !== nt.fields.length)
    throw new CoreError(
      'anki_note_invalid',
      `Nota inválida: o tipo de nota tem ${nt.fields.length} campos, mas vieram ${fields.length}.`,
    );
}

function canonicalTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags.flatMap((x) => x.split(/\s+/)).filter(Boolean))
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

function nextNewPosition(): number {
  return ankiState().cards.reduce((m, c) => (c.queue === 'new' ? Math.max(m, c.due) : m), 0) + 1;
}

function newCard(noteId: number, deckId: number, ord: number): MockCard {
  return {
    id: newId(),
    noteId,
    deckId,
    ord,
    queue: 'new',
    due: nextNewPosition(),
    ivl: 0,
    ease: 0,
    reps: 0,
    lapses: 0,
    flag: 0,
  };
}

/** Card ordinals a note should have: one per template, or one per cloze number. */
function wantedOrds(nt: MockNotetype, fields: string[]): number[] {
  if (nt.kind === 'cloze') return clozeNumbers(fields).map((n) => n - 1);
  return nt.templates
    .map((_, i) => i)
    .filter((i) => {
      const field = nt.templateRequires?.[i];
      if (field === undefined) return true;
      return stripHtml(fields[nt.fields.indexOf(field)] ?? '') !== '';
    });
}

function isMarked(n: MockNote): boolean {
  return n.tags.some((t) => t.toLowerCase() === 'marked');
}

// ---------------------------------------------------------------- search (subset of Anki's syntax)

type Pred = (c: MockCard, n: MockNote, nt: MockNotetype) => boolean;

function searchError(reason: string): CoreError {
  return new CoreError('anki_backend', `Pesquisa inválida: ${reason}`);
}

function tokenize(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push(ch);
      i++;
      continue;
    }
    let tok = '';
    while (i < q.length && !/\s/.test(q[i]!) && q[i] !== '(' && q[i] !== ')') {
      if (q[i] === '"') {
        const end = q.indexOf('"', i + 1);
        if (end < 0) throw searchError('falta fechar as aspas (").');
        tok += q.slice(i, end + 1);
        i = end + 1;
      } else tok += q[i++];
    }
    out.push(tok);
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/"/g, '');
}

/** Anki-style wildcard match (`*` any run, `_` one char), case-insensitive, whole string. */
function globRe(pattern: string, whole = true): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '_' ? '.' : ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(whole ? `^${body}$` : body, 'i');
}

function deckMatcher(name: string): (deckId: number) => boolean {
  const s = ankiState();
  if (name.toLowerCase() === 'current') {
    const ids = new Set(subtree(s.currentDeckId).map((d) => d.id));
    return (id) => ids.has(id);
  }
  const re = globRe(name);
  const roots = s.decks.filter((d) => re.test(d.name));
  const ids = new Set(roots.flatMap((d) => subtree(d.id).map((x) => x.id)));
  return (id) => ids.has(id);
}

function termPred(raw: string): Pred {
  const colon = raw.indexOf(':');
  const key = colon > 0 && !raw.startsWith('"') ? raw.slice(0, colon).toLowerCase() : '';
  const value = colon > 0 ? unquote(raw.slice(colon + 1)) : unquote(raw);
  if (key && !value && key !== 'tag') throw searchError(`"${raw}" precisa de um valor depois de ":".`);
  switch (key) {
    case '': {
      const re = globRe(value, false);
      return (_c, n) => n.fields.some((f) => re.test(stripHtml(f)));
    }
    case 'deck': {
      const m = deckMatcher(value);
      return (c) => m(c.deckId);
    }
    case 'tag': {
      if (!value) return (_c, n) => n.tags.length === 0;
      const re = globRe(value);
      const child = globRe(`${value}::*`);
      return (_c, n) => n.tags.some((t) => re.test(t) || child.test(t));
    }
    case 'note': {
      const re = globRe(value);
      return (_c, _n, nt) => re.test(nt.name);
    }
    case 'card': {
      const ord = Number(value);
      if (Number.isInteger(ord)) return (c) => c.ord === ord - 1;
      const re = globRe(value);
      return (c, _n, nt) => re.test(nt.templates[nt.kind === 'cloze' ? 0 : c.ord] ?? '');
    }
    case 'flag': {
      const f = Number(value);
      if (!Number.isInteger(f) || f < 0 || f > 7) throw searchError('flag: aceita só números de 0 a 7.');
      return (c) => c.flag === f;
    }
    case 'is': {
      const t = today();
      switch (value.toLowerCase()) {
        case 'due':
          return (c) => (c.queue === 'review' && c.due <= t) || c.queue === 'learn';
        case 'new':
          return (c) => c.queue === 'new';
        case 'learn':
          return (c) => c.queue === 'learn';
        case 'review':
          return (c) => c.queue === 'review' || (c.queue !== 'new' && c.ivl > 0);
        case 'suspended':
          return (c) => c.queue === 'suspended';
        case 'buried':
          return (c) => c.queue === 'buried';
        case 'marked':
          return (_c, n) => isMarked(n);
        default:
          throw searchError(`"is:${value}" não é reconhecido.`);
      }
    }
    case 'nid':
    case 'cid': {
      const ids = new Set(value.split(',').map(Number));
      if ([...ids].some((x) => !Number.isFinite(x))) throw searchError(`"${raw}" precisa de números.`);
      return key === 'nid' ? (_c, n) => ids.has(n.id) : (c) => ids.has(c.id);
    }
    default: {
      // field:value — whole-field match on the field's text.
      const re = globRe(value);
      return (_c, n, nt) => {
        const idx = nt.fields.findIndex((f) => f.toLowerCase() === key);
        return idx >= 0 && re.test(stripHtml(n.fields[idx] ?? ''));
      };
    }
  }
}

function parse(tokens: string[]): Pred {
  let i = 0;
  const peek = () => tokens[i];
  function expr(): Pred {
    const ors: Pred[] = [and()];
    while (peek()?.toUpperCase() === 'OR') {
      i++;
      ors.push(and());
    }
    return ors.length === 1 ? ors[0]! : (c, n, nt) => ors.some((p) => p(c, n, nt));
  }
  function and(): Pred {
    const parts: Pred[] = [];
    while (i < tokens.length && peek() !== ')' && peek()?.toUpperCase() !== 'OR') {
      if (peek()?.toUpperCase() === 'AND') {
        i++;
        continue;
      }
      parts.push(unary());
    }
    if (!parts.length) throw searchError('falta um termo de busca.');
    return (c, n, nt) => parts.every((p) => p(c, n, nt));
  }
  function unary(): Pred {
    const tok = tokens[i++]!;
    if (tok === '(') {
      const inner = expr();
      if (tokens[i++] !== ')') throw searchError('falta fechar o parêntese.');
      return inner;
    }
    if (tok === '-' && peek() === '(') {
      const inner = unary();
      return (c, n, nt) => !inner(c, n, nt);
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const inner = termPred(tok.slice(1));
      return (c, n, nt) => !inner(c, n, nt);
    }
    return termPred(tok);
  }
  if (!tokens.length) return () => true;
  const p = expr();
  if (i < tokens.length) throw searchError('há um parêntese sem par.');
  return p;
}

/** Card ids matching `query`, like the core's `browse::search`. */
export function mockSearch(query: string, order: BrowseOrder | null): number[] {
  const s = ankiState();
  const pred = parse(tokenize(query.trim()));
  const notes = new Map(s.notes.map((n) => [n.id, n]));
  const types = new Map(s.notetypes.map((n) => [n.id, n]));
  const hits: { c: MockCard; n: MockNote; nt: MockNotetype }[] = [];
  for (const c of s.cards) {
    const n = notes.get(c.noteId);
    const nt = n && types.get(n.notetypeId);
    if (n && nt && pred(c, n, nt)) hits.push({ c, n, nt });
  }
  if (order) {
    const key = sortKey(order.column);
    hits.sort((a, b) => {
      const ka = key(a.c, a.n, a.nt);
      const kb = key(b.c, b.n, b.nt);
      const cmp =
        typeof ka === 'number' && typeof kb === 'number'
          ? ka - kb
          : String(ka).localeCompare(String(kb), 'pt-BR', { sensitivity: 'base' });
      return (order.reverse ? -cmp : cmp) || a.c.id - b.c.id;
    });
  } else hits.sort((a, b) => a.c.id - b.c.id);
  return hits.map((h) => h.c.id);
}

function dueSortValue(c: MockCard): number {
  // New cards first by position, then learning, then reviews by day (like Anki's due column).
  if (c.queue === 'new') return c.due - 1e12;
  if (c.queue === 'learn') return c.due / DAY_MS - 1e9;
  return c.due;
}

function sortKey(column: BrowseOrder['column']): (c: MockCard, n: MockNote, nt: MockNotetype) => string | number {
  switch (column) {
    case 'sortField':
      return (_c, n) => stripHtml(n.fields[0] ?? '');
    case 'template':
      return (c, _n, nt) => templateName(c, nt);
    case 'deck':
      return (c) => deckById(c.deckId)?.name ?? '';
    case 'cardDue':
      return dueSortValue;
    case 'cardIvl':
      return (c) => c.ivl;
    case 'cardEase':
      return (c) => c.ease;
    case 'noteCrt':
      return (_c, n) => n.id;
    case 'noteMod':
      return (_c, n) => n.mtime;
  }
}

function templateName(c: MockCard, nt: MockNotetype): string {
  return nt.kind === 'cloze' ? `${nt.templates[0] ?? 'Cloze'} ${c.ord + 1}` : (nt.templates[c.ord] ?? '');
}

/** `YYYY-MM-DD` in local time, like rslib's `TimestampSecs::date_string` (the browser "Due" column). */
function isoDate(d: Date, utc = false): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const [y, m, day] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]
    : [d.getFullYear(), d.getMonth(), d.getDate()];
  return `${y}-${pad(m + 1)}-${pad(day)}`;
}

/** The "Due" cell of rslib's `card_due_str`: "Novo #N", a date, in parentheses when suspended/buried. */
function dueText(c: MockCard): string {
  let text: string;
  if (c.queue === 'new' || (c.queue !== 'review' && c.queue !== 'learn' && c.ivl === 0 && c.reps === 0))
    text = `Novo #\u2068${c.due}\u2069`; // Fluent's isolation marks, as in the core's string
  else if (c.queue === 'learn') text = isoDate(new Date(c.due));
  else text = isoDate(new Date(c.due * DAY_MS), true); // mock review days are UTC days
  return c.queue === 'suspended' || c.queue === 'buried' ? `(${text})` : text;
}

/** A browser row, like the core's `browse::rows` (cells are plain text). */
export function mockRow(cardId: number): BrowseRow | null {
  const s = ankiState();
  const c = s.cards.find((x) => x.id === cardId);
  if (!c) return null;
  const n = s.notes.find((x) => x.id === c.noteId);
  const nt = n && s.notetypes.find((x) => x.id === n.notetypeId);
  if (!n || !nt) return null;
  return {
    cardId: c.id,
    noteId: n.id,
    sortField: stripHtml(n.fields[0] ?? ''),
    template: templateName(c, nt),
    deck: deckById(c.deckId)?.name ?? '',
    due: dueText(c),
    flag: c.flag,
    marked: isMarked(n),
    suspended: c.queue === 'suspended',
    buried: c.queue === 'buried',
  };
}

// ---------------------------------------------------------------- media

const mediaHashes = new Map<string, string>();

function quickHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return (h ^ bytes.length).toString(16).padStart(8, '0');
}

export function sanitizeMediaName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return base || 'imagem.png';
}

function addMedia(name: string, bytes: Uint8Array): string {
  if (bytes.byteLength > MOCK_MAX_MEDIA_BYTES) throw new CoreError('anki_too_large', 'O arquivo é grande demais.');
  const clean = sanitizeMediaName(name);
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
  if (!IMAGE_EXTENSIONS.includes(ext))
    throw new CoreError(
      'invalid_input',
      `Entrada inválida: só imagens podem ser coladas no editor (PNG, JPG, GIF, WebP, AVIF ou SVG), não “.${ext}”.`,
    );
  const s = ankiState();
  const hash = quickHash(bytes);
  let final = clean;
  if (s.media.includes(clean) && mediaHashes.get(clean) !== hash) {
    // Anki appends the content hash when another file already has the name.
    final = `${clean.slice(0, dot)}-${hash}.${clean.slice(dot + 1)}`;
  }
  if (!s.media.includes(final)) s.media.push(final);
  mediaHashes.set(final, hash);
  logAnki('mediaAdd', { name: final, size: bytes.byteLength });
  return final;
}

// ---------------------------------------------------------------- the mock

function cardsOfNotes(noteIds: number[]): MockCard[] {
  const set = new Set(noteIds);
  return ankiState().cards.filter((c) => set.has(c.noteId));
}

function liveCards(cardIds: number[]): MockCard[] {
  const set = new Set(cardIds);
  return ankiState().cards.filter((c) => set.has(c.id));
}

function touch(n: MockNote): void {
  n.mtime = Date.now();
}

export const ankiNotesMock: Pick<CoreClient, AnkiNotesMockKeys> = {
  ankiNotetypes: () =>
    later(() => {
      const s = ankiState();
      return [...s.notetypes]
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }))
        .map((nt) => ({
          id: nt.id,
          name: nt.name,
          kind: nt.kind,
          fields: nt.fields.map((name) => ({ name, fontName: 'Arial', fontSize: 20, rtl: false, plainText: false })),
          templates: [...nt.templates],
          appType: nt.appType,
          noteCount: s.notes.filter((n) => n.notetypeId === nt.id).length,
        }));
    }),

  ankiAddDefaults: (deckId) =>
    later(() => {
      const s = ankiState();
      const usable = (id: number | null | undefined) => {
        const d = id == null ? undefined : deckById(id);
        return d && !d.filtered ? d.id : undefined;
      };
      const did = usable(deckId) ?? usable(s.currentDeckId) ?? DEFAULT_DECK_ID;
      // The notetype last used in that deck (Anki remembers it per deck), else Basic.
      const deckCards = s.cards.filter((c) => c.deckId === did).sort((a, b) => b.id - a.id);
      const lastNote = deckCards.length ? s.notes.find((n) => n.id === deckCards[0]!.noteId) : undefined;
      const ntid = lastNote?.notetypeId ?? (s.notetypes.some((n) => n.id === NT_BASIC) ? NT_BASIC : s.notetypes[0]!.id);
      return { notetypeId: ntid, deckId: did };
    }),

  ankiNoteGet: (noteId) =>
    later(() => {
      const n = note(noteId);
      const cards = ankiState()
        .cards.filter((c) => c.noteId === noteId)
        .sort((a, b) => a.id - b.id);
      return {
        id: n.id,
        notetypeId: n.notetypeId,
        fields: [...n.fields],
        tags: [...n.tags],
        cardIds: cards.map((c) => c.id),
        deckId: cards[0]?.deckId ?? 0,
        mtime: Math.floor(n.mtime / 1000),
      };
    }),

  ankiNoteCheck: (notetypeId, fields) =>
    later(() => {
      const nt = notetype(notetypeId);
      validateFieldCount(nt, fields);
      return checkFields(nt, fields);
    }),

  ankiNoteAdd: (input) =>
    later(() => {
      const s = ankiState();
      const nt = notetype(input.notetypeId);
      validateFieldCount(nt, input.fields);
      const state = checkFields(nt, input.fields);
      const blocking = BLOCKING[state];
      if (blocking) throw new CoreError('anki_note_invalid', blocking);
      const deck = deckById(input.deckId);
      if (!deck) throw new CoreError('anki_not_found', 'Não encontrado: baralho.');
      if (deck.filtered)
        throw new CoreError('invalid_input', 'Entrada inválida: não é possível adicionar notas a um baralho filtrado.');
      const n: MockNote = {
        id: newId(),
        notetypeId: nt.id,
        fields: [...input.fields],
        tags: canonicalTags(input.tags),
        mtime: Date.now(),
      };
      s.notes.push(n);
      const ords = wantedOrds(nt, n.fields);
      for (const ord of ords) s.cards.push(newCard(n.id, deck.id, ord));
      logAnki('addNote', { noteId: n.id, notetypeId: nt.id, deckId: deck.id, fields: n.fields, tags: n.tags });
      persistAnki();
      return { noteId: n.id, cardCount: ords.length };
    }),

  ankiNoteUpdate: (noteId, fields, tags) =>
    later(() => {
      const s = ankiState();
      const n = note(noteId);
      const nt = notetype(n.notetypeId);
      validateFieldCount(nt, fields);
      const nextTags = canonicalTags(tags);
      const same =
        fields.every((f, i) => f === n.fields[i]) &&
        nextTags.length === n.tags.length &&
        nextTags.every((t, i) => t === n.tags[i]);
      if (same) return;
      n.fields = [...fields];
      n.tags = nextTags;
      touch(n);
      // A cloze note gets the cards of new cloze numbers (Anki never deletes cards on edit).
      const have = new Set(s.cards.filter((c) => c.noteId === n.id).map((c) => c.ord));
      const deckId = s.cards.find((c) => c.noteId === n.id)?.deckId ?? DEFAULT_DECK_ID;
      for (const ord of wantedOrds(nt, n.fields)) if (!have.has(ord)) s.cards.push(newCard(n.id, deckId, ord));
      logAnki('updateNote', { noteId, fields: n.fields, tags: n.tags });
      persistAnki();
    }),

  ankiMediaAdd: (name, bytes) =>
    later(() => addMedia(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))),

  ankiTagsAll: () =>
    later(() => {
      const set = new Map<string, string>();
      for (const n of ankiState().notes) for (const t of n.tags) set.set(t.toLowerCase(), t);
      return [...set.values()].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    }),

  ankiSearch: (query, order) => later(() => mockSearch(query, order)),

  ankiBrowseRows: (cardIds) =>
    later(() => {
      if (cardIds.length > 500) throw new CoreError('invalid_input', 'Entrada inválida: no máximo 500 cards por vez.');
      return cardIds.map(mockRow).filter((r): r is BrowseRow => r !== null);
    }),

  ankiCardsSetDeck: (cardIds, deckId) =>
    later(() => {
      const deck = deckById(deckId);
      if (!deck) throw new CoreError('anki_not_found', 'Não encontrado: baralho.');
      if (deck.filtered)
        throw new CoreError('anki_backend', 'Não é possível mover cards para dentro de um baralho filtrado.');
      let changed = 0;
      for (const c of liveCards(cardIds))
        if (c.deckId !== deckId) {
          c.deckId = deckId;
          changed++;
        }
      logAnki('setDeck', { cardIds, deckId, changed });
      persistAnki();
      return changed;
    }),

  ankiNotesTags: (noteIds, add, remove) =>
    later(() => {
      const addTags = add.split(/\s+/).filter(Boolean);
      const removeTags = remove
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.toLowerCase());
      for (const n of ankiState().notes.filter((x) => noteIds.includes(x.id))) {
        const before = n.tags.join(' ');
        n.tags = canonicalTags([...n.tags.filter((t) => !removeTags.includes(t.toLowerCase())), ...addTags]);
        if (n.tags.join(' ') !== before) touch(n);
      }
      logAnki('notesTags', { noteIds, add, remove });
      persistAnki();
    }),

  ankiCardsSuspend: (cardIds, suspended) =>
    later(() => {
      for (const c of liveCards(cardIds)) {
        if (suspended) c.queue = 'suspended';
        else if (c.queue === 'suspended' || c.queue === 'buried')
          c.queue = c.reps === 0 ? 'new' : c.ivl > 0 ? 'review' : 'learn';
      }
      logAnki('suspend', { cardIds, suspended });
      persistAnki();
    }),

  ankiCardsForget: (cardIds, opts) =>
    later(() => {
      let pos = nextNewPosition();
      for (const c of liveCards(cardIds)) {
        c.queue = 'new';
        c.due = pos++;
        c.ivl = 0;
        c.ease = 0;
        if (opts.resetCounts) {
          c.reps = 0;
          c.lapses = 0;
        }
      }
      logAnki('forget', { cardIds, ...opts });
      persistAnki();
    }),

  ankiNotesDelete: (noteIds) =>
    later(() => {
      const s = ankiState();
      const set = new Set(noteIds);
      const before = s.notes.length;
      s.notes = s.notes.filter((n) => !set.has(n.id));
      s.cards = s.cards.filter((c) => !set.has(c.noteId));
      const deleted = before - s.notes.length;
      logAnki('deleteNotes', { noteIds, deleted });
      persistAnki();
      return deleted;
    }),

  ankiChangeNotetypePrepare: (noteIds) =>
    later(() => {
      if (!noteIds.length) throw new CoreError('invalid_input', 'Entrada inválida: nenhuma nota selecionada.');
      const types = new Set(noteIds.map((id) => note(id).notetypeId));
      if (types.size !== 1)
        throw new CoreError('invalid_input', 'Entrada inválida: as notas selecionadas têm tipos de nota diferentes.');
      const notetypeId = [...types][0]!;
      logAnki('changeNotetypePrepare', { noteIds, notetypeId });
      return { notetypeId };
    }),

  pickImageFile: () =>
    later(() => {
      const s = ankiState();
      const next = s.nextImageFile;
      if (next !== undefined) {
        delete s.nextImageFile;
        persistAnki();
      }
      return next === undefined ? DEFAULT_IMAGE_PICK : next;
    }),
};

/** Cards of the given notes (bulk tests). */
export function mockCardsOfNotes(noteIds: number[]): number[] {
  return cardsOfNotes(noteIds).map((c) => c.id);
}
