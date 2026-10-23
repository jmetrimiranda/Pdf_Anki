// Mock of the study commands (spec 8.2 "Estudar") over the shared mock collection (mock/ankiData.ts). It renders the
// cards like the core's reviewer port would for the fixture notetypes (image + audio, TTS, MathJax, cloze,
// type-in-the-answer with a simple comparison, Fonte link), with Anki's default labels for new cards and plausible
// ones for learning/review cards. Answers are logged as `{ kind: 'answer', cardId, rating, ms }`.
import {
  CoreError,
  type AnswerSide,
  type AvTag,
  type CardAction,
  type CardActionResult,
  type CoreClient,
  type QueueCounts,
  type SourceLink,
  type StudyCard,
  type StudyNext,
  type StudyQueue,
} from '../types';
import {
  ankiState,
  DAY_MS,
  deckById,
  later,
  logAnki,
  NT_BASIC_TYPE,
  NT_CLOZE,
  NT_CLOZE_LEITOR,
  NT_CODE_COMMAND,
  NT_VOCAB_BOOK,
  persistAnki,
  subtree,
  today,
  type AnkiStudyMockKeys,
  type MockCard,
  type MockDeck,
  type MockNote,
  type MockNotetype,
} from './ankiData';

/** The card protocol stand-in of vite-plugin-anki-card.ts. */
export const MOCK_CARD_BASE = '/__card/';
/** Anki's learn-ahead limit (20 min): learning cards due within it are shown when nothing else is due. */
const LEARN_AHEAD_MS = 20 * 60_000;
/** Anki's default labels for a new card (steps 1m 10m, graduating 1d, easy 4d). */
export const NEW_CARD_LABELS: [string, string, string, string] = [
  '<\u20681\u2069min(s)',
  '<\u20686\u2069min(s)',
  '<\u206810\u2069min(s)',
  '\u20684\u2069dia(s)',
];
const DEFAULT_CSS =
  '.card {\n    font-family: arial;\n    font-size: 20px;\n    line-height: 1.5;\n    text-align: center;\n    color: black;\n    background-color: white;\n}\n';
const CLOZE_CSS =
  '.cloze {\n    font-weight: bold;\n    color: blue;\n}\n.nightMode .cloze {\n    color: lightblue;\n}\n';
const SOURCE_CSS = '.fonte { margin-top: 1.5em; font-size: 14px; opacity: .7 }\n';

// ---------------------------------------------------------------- session

interface Current {
  cardId: number;
  typeCorrect: string | null;
  answerHtml: string;
  answerAv: AvTag[];
}

interface UndoEntry {
  card: MockCard;
  deck: { id: number; display: [number, number, number] | null }[];
  studiedToday: { cards: number; seconds: number };
}

interface Session {
  deckId: number;
  current: Current | null;
  /** Set by an answer, cleared by any other operation (Ctrl+Z only undoes answers, spec 10.1). */
  undo: UndoEntry | null;
}

let session: Session | null = null;

function requireSession(): Session {
  if (!session) throw new CoreError('anki.noStudySession', 'Nenhuma sessão de estudo aberta.');
  return session;
}

function requireCurrent(cardId: number): Current {
  const s = requireSession();
  if (!s.current || s.current.cardId !== cardId)
    throw new CoreError('anki.notCurrentCard', 'Este card não é o que está na tela.');
  return s.current;
}

// ---------------------------------------------------------------- queue

function deckIdsUnder(deckId: number): Set<number> {
  return new Set(subtree(deckId).map((d) => d.id));
}

function isDue(c: MockCard, now: number, ahead: number): boolean {
  if (c.queue === 'new') return true;
  if (c.queue === 'learn') return c.due <= now + ahead;
  if (c.queue === 'review') return c.due <= today();
  return false;
}

/** Counts of the session's queue, like `QueuedCards` (learning within the learn-ahead limit). */
function queueCounts(deckId: number): QueueCounts {
  const ids = deckIdsUnder(deckId);
  const now = Date.now();
  const c = { new: 0, learn: 0, review: 0 };
  for (const card of ankiState().cards) {
    if (!ids.has(card.deckId) || !isDue(card, now, LEARN_AHEAD_MS)) continue;
    if (card.queue === 'new') c.new++;
    else if (card.queue === 'learn') c.learn++;
    else if (card.queue === 'review') c.review++;
  }
  return c;
}

/** Learning due now, then reviews, then new cards, then learning within the learn-ahead limit. */
function topCard(deckId: number): MockCard | null {
  const ids = deckIdsUnder(deckId);
  const now = Date.now();
  const cards = ankiState().cards.filter((c) => ids.has(c.deckId));
  const by = (f: (c: MockCard) => boolean, key: (c: MockCard) => number) =>
    cards.filter(f).sort((a, b) => key(a) - key(b) || a.id - b.id)[0] ?? null;
  return (
    by(
      (c) => c.queue === 'learn' && c.due <= now,
      (c) => c.due,
    ) ??
    by(
      (c) => c.queue === 'review' && c.due <= today(),
      (c) => c.due,
    ) ??
    by(
      (c) => c.queue === 'new',
      (c) => c.due,
    ) ??
    by(
      (c) => c.queue === 'learn' && c.due <= now + LEARN_AHEAD_MS,
      (c) => c.due,
    )
  );
}

// ---------------------------------------------------------------- labels

const SPAN_MINUTE = 60;
const SPAN_HOUR = 3600;
const SPAN_DAY = 86_400;
const SPAN_YEAR = 365 * SPAN_DAY;
const SPAN_MONTH = SPAN_YEAR / 12;

/** pt-BR answer-button units of Anki's `scheduling-answer-button-time-*` strings. */
const SPAN_UNITS = ['s', 'min(s)', 'h', 'dia(s)', 'mês(es)', 'a'] as const;

/**
 * Anki's short interval text in pt-BR, as rslib's `answer_button_time(_collapsible)` renders it
 * ("<10min(s)", "4dia(s)", "1,2mês(es)", "2,1a"): natural unit, seconds/minutes/days rounded,
 * hours/months/years with one decimal and a comma as the decimal separator. Like Fluent, the number is wrapped
 * in Unicode isolation marks (U+2068 … U+2069), invisible but part of the core's strings.
 */
export function intervalLabel(seconds: number, learnAhead = false): string {
  const secs = Math.abs(seconds);
  const unit =
    secs < SPAN_MINUTE
      ? 0
      : secs < SPAN_HOUR
        ? 1
        : secs < SPAN_DAY
          ? 2
          : secs < SPAN_MONTH
            ? 3
            : secs < SPAN_YEAR
              ? 4
              : 5;
  const size = [1, SPAN_MINUTE, SPAN_HOUR, SPAN_DAY, SPAN_MONTH, SPAN_YEAR][unit]!;
  const value = seconds / size;
  const amount = unit === 0 || unit === 1 || unit === 3 ? Math.round(value) : Math.round(value * 10) / 10;
  const text = `\u2068${String(amount).replace('.', ',')}\u2069${SPAN_UNITS[unit]}`;
  return learnAhead ? `<${text}` : text;
}

interface Outcome {
  queue: MockCard['queue'];
  /** Seconds until due. */
  secs: number;
  ivl: number;
}

function outcomes(card: MockCard): [Outcome, Outcome, Outcome, Outcome] {
  const m = 60;
  const d = 86_400;
  if (card.queue === 'review') {
    const ivl = Math.max(1, card.ivl);
    const hard = Math.max(ivl + 1, Math.round(ivl * 1.2));
    const good = Math.max(hard + 1, Math.round(ivl * 2.5));
    const easy = Math.max(good + 1, Math.round(ivl * 2.5 * 1.3));
    return [
      { queue: 'learn', secs: 10 * m, ivl: 1 },
      { queue: 'review', secs: hard * d, ivl: hard },
      { queue: 'review', secs: good * d, ivl: good },
      { queue: 'review', secs: easy * d, ivl: easy },
    ];
  }
  if (card.queue === 'learn') {
    return [
      { queue: 'learn', secs: m, ivl: 0 },
      { queue: 'learn', secs: 10 * m, ivl: 0 },
      { queue: 'review', secs: d, ivl: 1 },
      { queue: 'review', secs: 4 * d, ivl: 4 },
    ];
  }
  return [
    { queue: 'learn', secs: m, ivl: 0 },
    { queue: 'learn', secs: 6 * m, ivl: 0 },
    { queue: 'learn', secs: 10 * m, ivl: 0 },
    { queue: 'review', secs: 4 * d, ivl: 4 },
  ];
}

function labels(card: MockCard): [string, string, string, string] {
  if (card.queue === 'new') return [...NEW_CARD_LABELS];
  const o = outcomes(card);
  return [0, 1, 2, 3].map((i) => intervalLabel(o[i]!.secs, o[i]!.secs < LEARN_AHEAD_MS / 1000)) as [
    string,
    string,
    string,
    string,
  ];
}

// ---------------------------------------------------------------- rendering

const PLAY_BUTTON = (cmd: string) =>
  `\n<a class="replay-button soundLink" href=# onclick="pycmd('${cmd}'); return false;" draggable="false">\n    <svg class="playImage" viewBox="0 0 64 64" version="1.1">\n        <circle cx="32" cy="32" r="29" />\n        <path d="M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z" />\n    </svg>\n</a>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

/** `[sound:x]` and `{{tts}}` markers → play buttons (`play:q|a:N`) and the side's AV list. */
function extractAv(html: string, side: 'q' | 'a', tts: AvTag[] = []): { html: string; av: AvTag[] } {
  const av: AvTag[] = [];
  let out = html.replace(/\[sound:([^\]]+)\]/g, (_m, file: string) => {
    av.push({ kind: 'sound', file: file.split(/[\\/]/).pop() ?? '' });
    return PLAY_BUTTON(`play:${side}:${av.length - 1}`);
  });
  out = out.replace(/\[\[tts:(\d+)\]\]/g, (_m, i: string) => {
    const tag = tts[Number(i)];
    if (!tag) return '';
    av.push(tag);
    return PLAY_BUTTON(`play:${side}:${av.length - 1}`);
  });
  return { html: out, av };
}

function renderCloze(text: string, ord: number, answer: boolean): string {
  return text.replace(/\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g, (_m, n: string, body: string, hint?: string) => {
    if (Number(n) !== ord + 1) return `<span class="cloze-inactive" data-ordinal="${n}">${body}</span>`;
    if (answer) return `<span class="cloze" data-ordinal="${n}">${body}</span>`;
    return `<span class="cloze" data-cloze="${escapeHtml(body)}" data-ordinal="${n}">[${hint ?? '...'}]</span>`;
  });
}

const TYPE_INPUT = (font = 'Arial', size = 20) =>
  `\n<center>\n<input type=text id=typeans onkeypress="_typeAnsPress();"\n   style="font-family: '${font}'; font-size: ${size}px;">\n</center>\n`;

/** A small stand-in for rslib's `compare_answer` (same classes and layout). */
export function mockCompareAnswer(expectedHtml: string, typed: string): string {
  const expected = stripHtml(expectedHtml);
  const provided = typed.trim();
  if (provided === '') return `<code id=typeans>${escapeHtml(expected)}</code>`;
  if (provided === expected) return `<code id=typeans><span class=typeGood>${escapeHtml(expected)}</span></code>`;
  const typedSpans: string[] = [];
  for (let i = 0; i < provided.length; i++) {
    const ok = provided[i] === expected[i];
    typedSpans.push(`<span class=${ok ? 'typeGood' : 'typeBad'}>${escapeHtml(provided[i]!)}</span>`);
  }
  const expectedSpans: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    const ok = provided[i] === expected[i];
    expectedSpans.push(`<span class=${ok ? 'typeGood' : 'typeMissed'}>${escapeHtml(expected[i]!)}</span>`);
  }
  return `<code id=typeans>${typedSpans.join('')}<br><span id=typearrow>&darr;</span><br>${expectedSpans.join('')}</code>`;
}

function field(note: MockNote, nt: MockNotetype, name: string): string {
  const i = nt.fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
  return i >= 0 ? (note.fields[i] ?? '') : '';
}

function sourceBlock(note: MockNote, nt: MockNotetype): string {
  const fonte = field(note, nt, 'Fonte');
  return fonte ? `<div class="fonte">${fonte}</div>` : '';
}

/** `leitor://livro/<64 hex>?pagina=N[&q=…]` in the Fonte field (the same rules as the core's parser). */
export function parseSourceLink(html: string): SourceLink | null {
  const anchors = [
    ...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi),
  ];
  for (const m of anchors) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
    const link = parseLink(href, m[4] ?? '');
    if (link) return link;
  }
  return null;
}

function parseLink(url: string, labelHtml: string): SourceLink | null {
  const m = /^leitor:\/\/livro\/([0-9a-f]{64})(?:\?([^#]*))?(?:#.*)?$/.exec(url);
  if (!m) return null;
  let page: number | null = null;
  let query: string | null = null;
  for (const pair of (m[2] ?? '').split('&')) {
    const [k, v = ''] = pair.split('=');
    if (k === 'pagina' && page === null) {
      if (!/^\d+$/.test(v) || Number(v) < 1) return null;
      page = Number(v);
    } else if (k === 'q' && query === null) {
      try {
        query = decodeURIComponent(v.replace(/\+/g, ' ')).trim().slice(0, 500) || null;
      } catch {
        query = null;
      }
    }
  }
  if (page === null) return null;
  const label = stripHtml(labelHtml).replace(/\s+/g, ' ');
  return { bookUid: m[1]!, page, query, label: label || `p. ${page}` };
}

interface Rendered {
  q: string;
  a: string;
  qAv: AvTag[];
  aAv: AvTag[];
  typeCorrect: string | null;
  css: string;
}

function render(card: MockCard, note: MockNote, nt: MockNotetype): Rendered {
  const f = (i: number) => note.fields[i] ?? '';
  let css = DEFAULT_CSS;
  let front: string;
  let back: (frontSide: string) => string;
  let typeCorrect: string | null = null;
  const tts: AvTag[] = [];
  if (nt.kind === 'cloze' || nt.id === NT_CLOZE || nt.id === NT_CLOZE_LEITOR) {
    css += CLOZE_CSS;
    front = renderCloze(f(0), card.ord, false);
    const extra = f(1);
    back = () => `${renderCloze(f(0), card.ord, true)}<br>\n${extra}${sourceBlock(note, nt)}`;
  } else if (nt.id === NT_CODE_COMMAND || nt.id === NT_BASIC_TYPE) {
    const answerField = nt.id === NT_CODE_COMMAND ? field(note, nt, 'Resposta') : f(1);
    typeCorrect = answerField;
    front = `${f(0)}\n\n[[type]]`;
    const obs = nt.id === NT_CODE_COMMAND ? field(note, nt, 'Observação') : '';
    back = (fs) => `${fs}<hr id=answer>${obs ? `<blockquote>${obs}</blockquote>` : ''}${sourceBlock(note, nt)}`;
  } else if (nt.id === NT_VOCAB_BOOK && card.ord === 1) {
    // "Português → Inglês" (only exists when the "Card 2" field is filled).
    front = field(note, nt, 'Tradução');
    back = (fs) => `${fs}<hr id=answer>${field(note, nt, 'Palavra')}${sourceBlock(note, nt)}`;
  } else if (nt.id === NT_VOCAB_BOOK) {
    const word = field(note, nt, 'Palavra');
    tts.push({ kind: 'tts', text: stripHtml(word), lang: 'en_US', voices: [], speed: 1 });
    front = `<div class="palavra">${word}</div>[[tts:0]]<div class="exemplo">${field(note, nt, 'Exemplo')}</div>`;
    back = (fs) =>
      `${fs}<hr id=answer><div>${field(note, nt, 'Definição')}</div><div>${field(note, nt, 'Tradução')}</div>${sourceBlock(note, nt)}`;
  } else {
    front = f(0);
    back = (fs) => `${fs}\n\n<hr id=answer>\n\n${f(1)}${sourceBlock(note, nt)}`;
  }
  if (nt.fields.some((x) => x.toLowerCase() === 'fonte')) css += SOURCE_CSS;
  const q = extractAv(front, 'q', tts);
  // {{FrontSide}} = the question AFTER the AV extraction (its buttons keep `play:q:N`).
  const a = extractAv(back(q.html), 'a');
  return { q: q.html, a: a.html, qAv: q.av, aAv: a.av, typeCorrect, css };
}

function questionHtml(r: Rendered): string {
  const body = r.q.replace(/\[\[type\]\]/g, r.typeCorrect ? TYPE_INPUT() : '');
  return `<style>${r.css}</style>${body}`;
}

function answerHtml(r: Rendered, typed: string | null): string {
  let body = r.a;
  if (r.typeCorrect) {
    const cmp = `\n<div style="font-family: 'Arial'; font-size: 20px">${mockCompareAnswer(r.typeCorrect, typed ?? '')}</div>`;
    body = body.includes('[[type]]')
      ? body.replace('<hr id=answer>', '').replace(/\[\[type\]\]/g, `<hr id=answer>${cmp}`)
      : body;
  } else body = body.replace(/\[\[type\]\]/g, '');
  return `<style>${r.css}</style>${body}`;
}

// ---------------------------------------------------------------- answering helpers

function noteOf(card: MockCard): { note: MockNote; nt: MockNotetype } {
  const s = ankiState();
  const note = s.notes.find((n) => n.id === card.noteId);
  const nt = note && s.notetypes.find((t) => t.id === note.notetypeId);
  if (!note || !nt) throw new CoreError('anki.notFound', 'Nota não encontrada.');
  return { note, nt };
}

function ancestors(deck: MockDeck): MockDeck[] {
  const parts = deck.name.split('::');
  const names = parts.map((_, i) => parts.slice(0, i + 1).join('::'));
  return ankiState().decks.filter((d) => names.includes(d.name));
}

const COUNT_INDEX: Partial<Record<MockCard['queue'], number>> = { new: 0, learn: 1, review: 2 };

/** Keeps the deck list's fixed numbers (`display`) in step with an answer. */
function moveDisplayed(card: MockCard, from: MockCard['queue'], to: MockCard['queue'], stillDue: boolean) {
  const deck = deckById(card.deckId);
  if (!deck) return;
  for (const d of ancestors(deck)) {
    if (!d.display) continue;
    const next: [number, number, number] = [...d.display];
    const fi = COUNT_INDEX[from];
    if (fi !== undefined) next[fi] = Math.max(0, next[fi]! - 1);
    const ti = COUNT_INDEX[to];
    if (stillDue && ti !== undefined) next[ti] = next[ti]! + 1;
    d.display = next;
  }
}

function queueKind(card: MockCard): StudyQueue {
  return card.queue === 'learn' ? 'learn' : card.queue === 'review' ? 'review' : 'new';
}

function deckName(id: number): string {
  return deckById(id)?.name ?? '';
}

/** The top of the queue (or `forced`: the card an undo put back in front). */
function nextFor(s: Session, forced?: MockCard): StudyNext {
  s.current = null;
  const counts = queueCounts(s.deckId);
  const card = forced ?? topCard(s.deckId);
  if (!card) {
    return { kind: 'done', deckId: s.deckId, deckName: deckName(s.deckId), counts, canUndo: s.undo !== null };
  }
  const { note, nt } = noteOf(card);
  const r = render(card, note, nt);
  s.current = { cardId: card.id, typeCorrect: r.typeCorrect, answerHtml: r.a, answerAv: r.aAv };
  const study: StudyCard = {
    cardId: card.id,
    noteId: note.id,
    deckId: card.deckId,
    deckName: deckName(card.deckId),
    questionHtml: questionHtml(r),
    answerPreloadHtml: `<style>${r.css}</style>${r.a}`,
    bodyClass: `card card${card.ord + 1}`,
    questionAv: r.qAv,
    answerAv: r.aAv,
    autoplay: true,
    replayQuestionOnAnswer: true,
    queue: queueKind(card),
    counts,
    showCounts: true,
    buttons: labels(card),
    showIntervals: true,
    flag: card.flag,
    marked: note.tags.some((t) => t.toLowerCase() === 'marked'),
    typeAnswer: !!r.typeCorrect,
    stateMutation: null,
    source: parseSourceLink(field(note, nt, 'Fonte')),
    canUndo: s.undo !== null,
    showTimer: false,
    timerMaxSecs: 60,
  };
  return { kind: 'card', card: study };
}

function cardById(id: number): MockCard {
  const c = ankiState().cards.find((x) => x.id === id);
  if (!c) throw new CoreError('anki.notFound', 'Card não encontrado.');
  return c;
}

// ---------------------------------------------------------------- commands

export const ankiStudyMock: Pick<CoreClient, AnkiStudyMockKeys> = {
  ankiStudyNext: (deckId) =>
    later(() => {
      if (!deckById(deckId)) throw new CoreError('anki.notFound', 'Deck não encontrado.');
      if (!session) session = { deckId, current: null, undo: null };
      else if (session.deckId !== deckId) session = { deckId, current: null, undo: null };
      const st = ankiState();
      st.currentDeckId = deckId;
      persistAnki();
      return nextFor(session);
    }),

  ankiShowAnswer: (cardId, typed) =>
    later((): AnswerSide => {
      const cur = requireCurrent(cardId);
      const card = cardById(cardId);
      const { note, nt } = noteOf(card);
      const r = render(card, note, nt);
      return { html: answerHtml(r, typed), av: cur.answerAv, buttons: labels(card) };
    }),

  ankiAnswer: (cardId, rating, ms) =>
    later(() => {
      const s = requireSession();
      requireCurrent(cardId);
      if (!Number.isInteger(rating) || rating < 1 || rating > 4)
        throw new CoreError('anki.invalidInput', `Resposta ${rating} (use 1 a 4).`);
      const st = ankiState();
      const card = cardById(cardId);
      const deck = deckById(card.deckId);
      const undo: UndoEntry = {
        card: structuredClone(card),
        deck: deck ? ancestors(deck).map((d) => ({ id: d.id, display: d.display ? [...d.display] : null })) : [],
        studiedToday: { ...st.studiedToday },
      };
      const o = outcomes(card)[rating - 1]!;
      const from = card.queue;
      card.queue = o.queue;
      card.ivl = o.ivl;
      card.reps += 1;
      if (rating === 1 && from === 'review') card.lapses += 1;
      card.due = o.queue === 'learn' ? Date.now() + o.secs * 1000 : today() + Math.round(o.secs / (DAY_MS / 1000));
      if (card.ease === 0 && o.queue === 'review') card.ease = 2500;
      moveDisplayed(card, from, card.queue, o.queue === 'learn');
      // The deck preset caps the time stored (60 s by default), like rslib.
      st.studiedToday.cards += 1;
      st.studiedToday.seconds += Math.min(60, Math.round(Math.max(0, ms) / 1000));
      s.undo = undo;
      logAnki('answer', { cardId, rating, ms });
      persistAnki();
      return nextFor(s);
    }),

  ankiUndo: () =>
    later(() => {
      const s = requireSession();
      if (!s.undo) throw new CoreError('anki.undoUnavailable', 'Não há resposta para desfazer.');
      const st = ankiState();
      const i = st.cards.findIndex((c) => c.id === s.undo!.card.id);
      if (i >= 0) st.cards[i] = s.undo.card;
      for (const d of s.undo.deck) {
        const deck = deckById(d.id);
        if (deck) deck.display = d.display;
      }
      st.studiedToday = s.undo.studiedToday;
      s.undo = null;
      logAnki('undo', { cardId: i >= 0 ? st.cards[i]!.id : null });
      persistAnki();
      // Undo puts the card back at the top of the queue (rslib restores its queue entry).
      return nextFor(s, i >= 0 ? st.cards[i] : undefined);
    }),

  ankiCardAction: (cardId, action: CardAction, flag?: number) =>
    later((): CardActionResult => {
      const s = requireSession();
      requireCurrent(cardId);
      const st = ankiState();
      const card = cardById(cardId);
      const { note } = noteOf(card);
      s.undo = null;
      const noteCards = st.cards.filter((c) => c.noteId === note.id);
      const marked = () => note.tags.some((t) => t.toLowerCase() === 'marked');
      switch (action) {
        case 'bury':
        case 'buryNote':
        case 'suspend':
        case 'suspendNote': {
          const targets = action === 'bury' || action === 'suspend' ? [card] : noteCards;
          for (const c of targets) c.queue = action.startsWith('bury') ? 'buried' : 'suspended';
          logAnki(action, { cardId });
          persistAnki();
          return { flag: card.flag, marked: marked(), next: nextFor(s) };
        }
        case 'flag': {
          const wanted = flag ?? 0;
          if (!Number.isInteger(wanted) || wanted < 0 || wanted > 7)
            throw new CoreError('anki.invalidInput', `Bandeira ${wanted} (use 0 a 7).`);
          card.flag = wanted === card.flag ? 0 : wanted;
          logAnki('flag', { cardId, flag: card.flag });
          persistAnki();
          return { flag: card.flag, marked: marked(), next: null };
        }
        case 'mark': {
          note.tags = marked() ? note.tags.filter((t) => t.toLowerCase() !== 'marked') : [...note.tags, 'marked'];
          logAnki('mark', { cardId, marked: marked() });
          persistAnki();
          return { flag: card.flag, marked: marked(), next: null };
        }
        default:
          throw new CoreError('anki.invalidInput', `Ação desconhecida: ${String(action)}.`);
      }
    }),

  ankiStudyClose: () =>
    later(() => {
      session = null;
    }),

  cardFrameUrl: () => `${MOCK_CARD_BASE}_leitor/reviewer.html`,
  cardMediaUrl: (name) => `${MOCK_CARD_BASE}${encodeURIComponent(name)}`,
};

/** Tests: forget the session (the mock collection is reset separately). */
export function resetStudyMock(): void {
  session = null;
}
