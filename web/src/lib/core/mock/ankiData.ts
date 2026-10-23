// The in-memory Anki collection of the mock core, shared by mock/ankiDecks.ts, mock/ankiStudy.ts and
// mock/ankiNotes.ts. It mirrors the core's test fixture (docs: contract §F) on top of a deck tree shaped like the
// user's real collection (docs/referencia/capturas/10-anki-lista-de-decks.png), and is persisted in sessionStorage
// ('leitor.mock.anki'), so reloading the page simulates restarting the app.
import type {
  AnkiChanged,
  AnkiPageEvent,
  BackupInfo,
  CoreClient,
  DeckNode,
  DeckTree,
  QueueCounts,
  Unlisten,
} from '../types';

// ---------------------------------------------------------------- runtime helpers shared by the mock files

/** Simulated latency so loading states are visible; 0 in unit tests. */
let latencyMs = import.meta.env.MODE === 'test' ? 0 : 120;

export function setMockLatency(ms: number): void {
  latencyMs = ms;
}

export function mockLatency(): number {
  return latencyMs;
}

/** Runs `fn` after the simulated latency, as a promise (errors thrown by `fn` reject it). */
export function later<T>(fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    }, latencyMs);
  });
}

export function listenTo<T>(set: Set<T>, cb: T): Unlisten {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ---------------------------------------------------------------- which mock file implements which methods

type AnkiMethods = Extract<keyof CoreClient, `anki${string}`>;

/** Implemented by mock/ankiStudy.ts (study package). */
export type AnkiStudyMockKeys =
  | 'ankiStudyNext'
  | 'ankiShowAnswer'
  | 'ankiAnswer'
  | 'ankiUndo'
  | 'ankiCardAction'
  | 'ankiStudyClose'
  | 'ankiMiniReviewOpen'
  | 'ankiMiniReviewClose'
  | 'onStudyOwner'
  | 'cardFrameUrl'
  | 'cardMediaUrl';

/** Implemented by mock/bookPanel.ts (book panel, "Definir palavra", deep links). */
export type BookPanelMockKeys =
  'bookPanelInfo' | 'bookPanelSet' | 'ankiBookCards' | 'vocabDefine' | 'pendingDeepLinks' | 'onDeepLink';

/** Implemented by mock/ankiNotes.ts (notes/browse/editor package). */
export type AnkiNotesMockKeys =
  | 'ankiNotetypes'
  | 'ankiAddDefaults'
  | 'ankiNoteGet'
  | 'ankiNoteCheck'
  | 'ankiNoteAdd'
  | 'ankiNoteUpdate'
  | 'ankiMediaAdd'
  | 'ankiTagsAll'
  | 'ankiSearch'
  | 'ankiBrowseRows'
  | 'ankiCardsSetDeck'
  | 'ankiNotesTags'
  | 'ankiCardsSuspend'
  | 'ankiCardsForget'
  | 'ankiNotesDelete'
  | 'ankiChangeNotetypePrepare'
  | 'pickImageFile';

/** Implemented by mock/ankiSync.ts (sync package). */
export type AnkiSyncMockKeys =
  | 'ankiSyncStatus'
  | 'ankiSyncLogin'
  | 'ankiSyncLogout'
  | 'ankiSyncSetCertificate'
  | 'ankiSync'
  | 'ankiSyncFull'
  | 'ankiSyncNotify'
  | 'onAnkiSync';

/** Implemented by mock/ankiDecks.ts (this shell): every other `anki*` method, the page URL and the events. */
export type AnkiDecksMockKeys =
  | Exclude<AnkiMethods, AnkiStudyMockKeys | AnkiNotesMockKeys | AnkiSyncMockKeys | BookPanelMockKeys>
  | 'onAnkiChanged'
  | 'onAnkiPageEvent';

// ---------------------------------------------------------------- model

export interface MockDeck {
  id: number;
  /** Full name with `::`. */
  name: string;
  collapsed: boolean;
  filtered: boolean;
  /**
   * Counts shown in the deck list (already including subdecks), like the user's real collection; `null` = computed
   * from the mock cards. Study screens may decrement them.
   */
  display: [number, number, number] | null;
  /** Cards the deck pretends to hold besides the mock cards (the big decks of the real collection). */
  extraCards: number;
}

export interface MockNotetype {
  id: number;
  name: string;
  kind: 'normal' | 'cloze';
  fields: string[];
  templates: string[];
  /** Template ordinal → field that must be non-empty for the card to exist (Anki's conditional fronts). */
  templateRequires?: Record<number, string>;
  /** Name of the app type (`Básico (Leitor)`…) or null. */
  appType: string | null;
}

export interface MockNote {
  id: number;
  notetypeId: number;
  fields: string[];
  tags: string[];
  /** Epoch ms. */
  mtime: number;
}

export type MockCardQueue = 'new' | 'learn' | 'review' | 'suspended' | 'buried';

export interface MockCard {
  id: number;
  noteId: number;
  deckId: number;
  /** Template / cloze ordinal (0-based). */
  ord: number;
  queue: MockCardQueue;
  /** Review: day number (`today()`-relative scale); learning: epoch ms; new: position. */
  due: number;
  /** Interval in days (0 for new/learning). */
  ivl: number;
  /** Ease factor in permille (2500 = 250%). */
  ease: number;
  reps: number;
  lapses: number;
  flag: number;
}

/** Something the mock did that the e2e tests can assert (answers, imports, exports, deletes…). */
export interface MockAnkiLog {
  kind: string;
  at: number;
  [key: string]: unknown;
}

export interface AnkiState {
  decks: MockDeck[];
  notetypes: MockNotetype[];
  notes: MockNote[];
  cards: MockCard[];
  currentDeckId: number;
  studiedToday: { cards: number; seconds: number };
  backups: BackupInfo[];
  /** Media file names in the collection. */
  media: string[];
  logs: MockAnkiLog[];
  nextId: number;
  /** `undefined`: the default package; `null`: the user cancels the open dialog. */
  nextPackagePick?: string | null;
  /** `undefined`: the default image; `null`: cancelled. */
  nextImageFile?: string | null;
  /** Which dataset the collection holds: the seed or a replaced `.colpkg`. */
  dataset: 'seed' | 'colpkg';
}

export const DEFAULT_DECK_ID = 1;
export const DAY_MS = 86_400_000;
export const MOCK_ANKI_DIR = '/home/jorge/.local/share/dev.jmetri.leitor-estudos/anki';
export const MOCK_BACKUPS_DIR = `${MOCK_ANKI_DIR}/backups`;

/** Anki's notion of "today" (day number since the epoch, local midnight ignored in the mock). */
export function today(): number {
  return Math.floor(Date.now() / DAY_MS);
}

// ---------------------------------------------------------------- notetypes

export const NT_BASIC = 1_600_000_000_001;
export const NT_BASIC_TYPE = 1_600_000_000_002;
export const NT_CLOZE = 1_600_000_000_003;
export const NT_BASIC_LEITOR = 1_600_000_000_101;
export const NT_CLOZE_LEITOR = 1_600_000_000_102;
export const NT_CODE_COMMAND = 1_600_000_000_103;
export const NT_CODE_PROGRAM = 1_600_000_000_104;
export const NT_VOCAB_BOOK = 1_600_000_000_105;

export const APP_NOTETYPE_NAMES = [
  'Básico (Leitor)',
  'Cloze (Leitor)',
  'Código · Comando',
  'Código · Programa',
  'Vocabulário · Livro',
] as const;

/** The five app notetypes with complete fields from the start (spec 9, 10.2, 11.1, 12.6). */
export const APP_NOTETYPES: MockNotetype[] = [
  {
    id: NT_BASIC_LEITOR,
    name: 'Básico (Leitor)',
    kind: 'normal',
    fields: ['Frente', 'Verso', 'Fonte'],
    templates: ['Cartão 1'],
    appType: 'Básico (Leitor)',
  },
  {
    id: NT_CLOZE_LEITOR,
    name: 'Cloze (Leitor)',
    kind: 'cloze',
    fields: ['Texto', 'Verso extra', 'Fonte'],
    templates: ['Cloze'],
    appType: 'Cloze (Leitor)',
  },
  {
    id: NT_CODE_COMMAND,
    name: 'Código · Comando',
    kind: 'normal',
    fields: ['Pergunta', 'Resposta', 'Aceitas', 'Exige', 'Observação', 'Fonte'],
    templates: ['Cartão 1'],
    appType: 'Código · Comando',
  },
  {
    id: NT_CODE_PROGRAM,
    name: 'Código · Programa',
    kind: 'normal',
    fields: [
      'Pergunta',
      'Linguagem',
      'Modo',
      'Resposta',
      'Inicial',
      'Setup',
      'Testes',
      'Entrada',
      'SaidaEsperada',
      'Observação',
      'Fonte',
    ],
    templates: ['Cartão 1'],
    appType: 'Código · Programa',
  },
  {
    id: NT_VOCAB_BOOK,
    name: 'Vocabulário · Livro',
    kind: 'normal',
    fields: ['Palavra', 'Lema', 'Classe', 'Definição', 'Tradução', 'Exemplo', 'Fonte', 'Frequência', 'Card 2'],
    templates: ['Inglês → Português', 'Português → Inglês'],
    templateRequires: { 1: 'Card 2' },
    appType: 'Vocabulário · Livro',
  },
];

function stockNotetypes(): MockNotetype[] {
  return [
    {
      id: NT_BASIC,
      name: 'Básico',
      kind: 'normal',
      fields: ['Frente', 'Verso'],
      templates: ['Cartão 1'],
      appType: null,
    },
    {
      id: NT_BASIC_TYPE,
      name: 'Básico (digite a resposta)',
      kind: 'normal',
      fields: ['Frente', 'Verso'],
      templates: ['Cartão 1'],
      appType: null,
    },
    {
      id: NT_CLOZE,
      name: 'Omissão de palavras',
      kind: 'cloze',
      fields: ['Texto', 'Verso extra'],
      templates: ['Omissão de palavras'],
      appType: null,
    },
  ];
}

// ---------------------------------------------------------------- media

/** 96×64 PNG drawn for the fixture (a little house). */
export const FIXTURE_IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABwCAYAAACZ8XsCAAACyklEQVR4nO3dMWoUURzH8Y3kBFOKheAcwCNYeAora/EAOYIHEGsrC89g4RGsrCJYiFhtbSEoCoIECcnuvP29/3ufTxt282bmy//tJENy/vHb9587CLmT+sYgQOJMQKIESJQAiRIgUQIkSoBECZAoARIlQKIEyB/r58e7hDMPI8xpvUFwl/ffNV+HACezHjDpWoZoC57IeuA223J7FuAk1iMjahWhAIkS4ATWjaZXiykoQKIESJQAiRLgkfZPH+16tm78uW3r9xPgBvH1HOHlxj9E3vr9BHigq9H1HGHPztMLqOa60P5+bXn9/oQrqs0EvIWbTjnT8OY8jNA4qF6m4brBzUOLhxJMwMbTzDS8ngBPEE8PEV4eOb1aPZJlCz5xMOktee3seUABBqZVOsLfPBHdmcQ2uXQQ4r9BnuIR/KtMwPBntKWjCBOmvwlJ3yDsO7hBSZp2AvZ44ZcJp+GUE7DH+HpeV0tTTcBKF3iZZBpOMwErxVdxvYeaIsCqF3NfdN23MfQWPNIFXAbdkoedgCPFN+LxDDsBR71Qo07DoSbgDPGNdpzDBDjSRZnpeMtvwaNciFm35NITUHz1z0PJCVj5hLe2FJuG5Sag+MY6P6UCrHZyU/aFzlOJLbjSCe3N0vmW3P0EFN/Y56/EBPyfuz8+pJfQla/nD3cVdT8BGZsAiRIgUQIkSoBECZAoARI13J/offPlwUGve3Lv0+6UqqyzNROQKAESJUCiBEiUAIka7i54ay+ePzvq9RcvX222lhGZgEQJkCgBEiVAogRI1HB3wVV+V1plna2ZgEQJkCgBEiVAogRIlACJEiBRAiRKgEQJkCgBEiVAogRIlACJEiBRAiRKgEQJkCgBEnV28fZJyf8TwhhMQKIESJQAiRIgUQIkSoBECZAoARIlQKIESJQAiRIgUQIkSoBECZAoARIlQKIESJQA2SX9Aru3zZB/zYMEAAAAAElFTkSuQmCC';

/** 0.2 s of a 440 Hz tone, 8 kHz mono 8-bit PCM WAV (like the core fixture's hand-written WAV). */
export function fixtureWavBytes(): Uint8Array {
  const rate = 8000;
  const n = rate / 5;
  const out = new Uint8Array(44 + n);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, n, true);
  for (let i = 0; i < n; i++) out[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return out;
}

/** A data URL for a fixture media file (the mock has no `card` protocol), or null when unknown. */
export function mockMediaDataUrl(name: string): string | null {
  if (name === 'fixture-image.png') return `data:image/png;base64,${FIXTURE_IMAGE_PNG_BASE64}`;
  if (name === 'fixture-audio.wav') {
    let s = '';
    for (const b of fixtureWavBytes()) s += String.fromCharCode(b);
    return `data:audio/wav;base64,${btoa(s)}`;
  }
  return null;
}

// ---------------------------------------------------------------- seed

/** Provider of library book uids by title (mock.ts registers it; the Fonte links point at the mock library). */
let bookUidByTitle: (title: string) => string | null = () => null;

export function setMockBookUidProvider(fn: (title: string) => string | null): void {
  bookUidByTitle = fn;
}

const ANIMAL_FARM_FALLBACK_UID = 'a'.repeat(64);

export function animalFarmUid(): string {
  return bookUidByTitle('Animal Farm') ?? ANIMAL_FARM_FALLBACK_UID;
}

/** Builds a collection: decks first, then notes and cards through the small builder below. */
class Builder {
  readonly state: AnkiState;
  private deckId = 1_700_000_000_000;
  private noteId = 1_650_000_000_000;
  private cardId = 1_660_000_000_000;
  private newPos = 1;

  constructor(dataset: AnkiState['dataset'], notetypes: MockNotetype[]) {
    this.state = {
      decks: [
        { id: DEFAULT_DECK_ID, name: 'Default', collapsed: false, filtered: false, display: null, extraCards: 0 },
      ],
      notetypes,
      notes: [],
      cards: [],
      currentDeckId: DEFAULT_DECK_ID,
      studiedToday: { cards: 0, seconds: 0 },
      backups: [],
      media: [],
      logs: [],
      nextId: 1_690_000_000_000,
      dataset,
    };
  }

  deck(name: string, display: [number, number, number] | null = null, opts: Partial<MockDeck> = {}): number {
    const id = this.deckId++;
    const extraCards = display ? display[0] + display[1] + display[2] + 40 : 0;
    this.state.decks.push({ id, name, collapsed: false, filtered: false, display, extraCards, ...opts });
    return id;
  }

  /** A note with one card per entry of `cards` (ordinal = index), each with its scheduling. */
  note(
    deckId: number,
    notetypeId: number,
    fields: string[],
    cards: Partial<MockCard>[] = [{}],
    tags: string[] = [],
  ): number {
    const id = this.noteId++;
    this.state.notes.push({ id, notetypeId, fields, tags, mtime: Date.now() - 5 * DAY_MS });
    cards.forEach((c, ord) => {
      const queue = c.queue ?? 'new';
      this.state.cards.push({
        id: this.cardId++,
        noteId: id,
        deckId,
        ord,
        queue,
        due: queue === 'new' ? this.newPos++ : today(),
        ivl: 0,
        ease: queue === 'new' ? 0 : 2500,
        reps: queue === 'new' ? 0 : 3,
        lapses: 0,
        flag: 0,
        ...c,
      });
    });
    return id;
  }

  find(name: string): number {
    const d = this.state.decks.find((x) => x.name === name);
    if (!d) throw new Error(`no deck ${name}`);
    return d.id;
  }
}

const review = (ivl: number, dueIn = 0): Partial<MockCard> => ({ queue: 'review', ivl, due: today() + dueIn });
const learning = (): Partial<MockCard> => ({ queue: 'learn', due: Date.now() - 60_000, reps: 1 });

/** The default mock collection: the user-like deck list plus the fixture decks and notes (contract §F). */
export function seedAnki(): AnkiState {
  const notetypes = [
    ...stockNotetypes(),
    // The fixture already uses three app types (as if an earlier "Preparar coleção" made them).
    ...APP_NOTETYPES.filter((nt) => [NT_BASIC_LEITOR, NT_CODE_COMMAND, NT_VOCAB_BOOK].includes(nt.id)),
  ];
  const b = new Builder('seed', notetypes);
  const s = b.state;
  s.media = ['fixture-image.png', 'fixture-audio.wav'];

  const words = b.deck('5000 palavras', [0, 17, 1002]);
  b.deck('Grammar A1', [36, 10, 88], { collapsed: true });
  b.deck('Grammar A1::Unidade 1', [20, 6, 50]);
  b.deck('Grammar A1::Unidade 2', [16, 4, 38]);
  b.deck('Gramática', null);
  const cloze = b.deck('Gramática::Cloze', null);
  b.deck('Leitura de Livros A1', [40, 0, 21], { collapsed: true });
  b.deck('Leitura de Livros A1::Animal Farm', [40, 0, 21]);
  b.deck('Livros', null);
  const farm = b.deck('Livros::Animal Farm', null);
  const math = b.deck('Matemática', null);
  b.deck('On Palestine — Noam Chomsky', [40, 21, 24]);
  b.deck('Oxford', [40, 35, 96]);
  const ox3000 = b.deck('Oxford::Oxford 3000', [40, 35, 96]);
  b.deck('Oxford::Oxford 5000', [0, 0, 0], { extraCards: 0 });
  b.deck('RimA Summer School — Go2 Prep', [40, 8, 0]);
  const ros = b.deck('ROS 2 — Revisão', [40, 23, 26], { collapsed: true });
  b.deck('ROS 2 — Revisão::Comandos', [20, 15, 18]);
  b.deck('ROS 2 — Revisão::Conceitos', [20, 8, 8]);
  b.deck('Verbos Irregulares (Inglês)', [30, 10, 0]);
  b.deck('Vocabulário', [10, 2, 14]);
  b.deck('Vocabulário::Livros', [10, 2, 14]);
  b.deck('Vocabulário::Livros::Teste', [10, 2, 14]);

  // 5000 palavras: image + audio, three reviews with different intervals, one learning card, new cards, and TTS.
  const img = '<img src="fixture-image.png">';
  const snd = '[sound:fixture-audio.wav]';
  b.note(words, NT_BASIC, [`${img}<br>house`, `casa ${snd}`], [review(3)]);
  b.note(words, NT_BASIC, [`${img}<br>home`, `lar ${snd}`], [review(12)]);
  b.note(words, NT_BASIC, ['window', `janela ${snd}`], [review(45, -2)]);
  b.note(words, NT_BASIC, ['door', 'porta'], [learning()]);
  b.note(words, NT_BASIC, ['garden', 'jardim']);
  b.note(words, NT_BASIC, ['kitchen', 'cozinha']);
  b.note(words, NT_VOCAB_BOOK, [
    'windmill',
    'windmill',
    'substantivo',
    'A building with sails that turn in the wind.',
    'moinho de vento',
    'The <b>windmill</b> was built on the knoll.',
    '',
    '12',
  ]);

  // Oxford 3000: new cards only.
  const oxford: [string, string][] = [
    ['abandon', 'abandonar'],
    ['ability', 'habilidade'],
    ['able', 'capaz'],
  ];
  for (const [en, pt] of oxford) b.note(ox3000, NT_BASIC, [en, pt]);

  // ROS 2 — Revisão: code commands (type-in answer).
  b.note(
    ros,
    NT_CODE_COMMAND,
    [
      'Ver a transformação entre os frames world e turtle1',
      'ros2 run tf2_ros tf2_echo world turtle1',
      '',
      '',
      'Imprime Translation e Rotation (quaternion) a cada atualização.',
      '',
    ],
    [review(4)],
  );
  b.note(ros, NT_CODE_COMMAND, ['Listar os tópicos ativos', 'ros2 topic list', '', '', '', '']);

  // Matemática: MathJax inline and display.
  b.note(math, NT_BASIC, ['Quanto vale \\(\\frac{a}{b}\\) com a = 6 e b = 3?', '2'], [review(2)]);
  b.note(math, NT_BASIC, ['Derivada de \\[x^2\\]', '\\(2x\\)']);

  // Gramática::Cloze: one note, two cloze cards.
  b.note(
    cloze,
    NT_CLOZE,
    ['O {{c1::Present Perfect}} usa o verbo {{c2::have}} como auxiliar.', 'Ex.: I have read the book.'],
    [{}, {}],
  );

  // Livros::Animal Farm: Fonte links back to the book (p. 37 like the core's fixture; p. 1 so the mock book's first
  // page has a card in "Cards desta página").
  const uid = animalFarmUid();
  b.note(farm, NT_BASIC_LEITOR, [
    'What did the animals build on the knoll?',
    'A windmill',
    `<a href="leitor://livro/${uid}?pagina=37&amp;q=windmill">Animal Farm, p. 37</a>`,
  ]);
  b.note(farm, NT_BASIC_LEITOR, [
    'Where does the story of Animal Farm begin?',
    'At Manor Farm',
    `<a href="leitor://livro/${uid}?pagina=1&amp;q=Manor%20Farm">Animal Farm, p. 1</a>`,
  ]);

  s.currentDeckId = words;
  s.studiedToday = { cards: 5, seconds: 170 };
  const now = Date.now();
  s.backups = [2, 1].map((daysAgo) => backupInfo('daily', now - daysAgo * DAY_MS, 2_400_000 + daysAgo * 1000));
  return s;
}

/** The collection after "Importar coleção" (.colpkg) in the mock: the user's main decks. */
export function colpkgAnki(): AnkiState {
  const b = new Builder('colpkg', stockNotetypes());
  const words = b.deck('5000 palavras', [0, 17, 1002]);
  b.deck('Oxford', [40, 35, 96]);
  const ox = b.deck('Oxford::Oxford 3000', [40, 35, 96]);
  b.deck('Oxford::Oxford 5000', [0, 0, 0], { extraCards: 0 });
  const ros = b.deck('ROS 2 — Revisão', [40, 23, 26]);
  b.note(words, NT_BASIC, ['house', 'casa'], [review(3)]);
  b.note(words, NT_BASIC, ['window', 'janela'], [review(20)]);
  b.note(ox, NT_BASIC, ['abandon', 'abandonar']);
  b.note(ros, NT_BASIC_TYPE, ['Listar os nós', 'ros2 node list'], [review(5)]);
  b.state.currentDeckId = words;
  return b.state;
}

const BACKUP_PREFIX: Record<BackupInfo['kind'], string> = {
  daily: 'diario',
  preImport: 'antes-de-importar',
  manual: 'manual',
  preSync: 'antes-da-sincronizacao',
};

export function backupInfo(kind: BackupInfo['kind'], createdAt: number, size: number): BackupInfo {
  const d = new Date(createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const prefix = BACKUP_PREFIX[kind];
  const fileName = `backup-${prefix}-${stamp}.colpkg`;
  return { path: `${MOCK_BACKUPS_DIR}/${fileName}`, fileName, kind, createdAt, size };
}

// ---------------------------------------------------------------- state and persistence

const STORAGE_KEY = 'leitor.mock.anki';

let state: AnkiState | null = null;

function load(): AnkiState {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AnkiState;
      if (Array.isArray(parsed.decks) && Array.isArray(parsed.cards) && Array.isArray(parsed.notes)) return parsed;
    }
  } catch {
    // Corrupt or unavailable storage: start over.
  }
  return seedAnki();
}

/** The live mock collection (mutate it, then call `persistAnki()`). */
export function ankiState(): AnkiState {
  state ??= load();
  return state;
}

export function persistAnki(): void {
  try {
    if (state) globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded: keep the in-memory state only.
  }
}

/** Replaces the whole collection (reset, or a mock `.colpkg` import). */
export function replaceAnki(next: AnkiState): void {
  state = next;
  persistAnki();
}

export function resetAnki(): void {
  replaceAnki(seedAnki());
}

export function newId(): number {
  const s = ankiState();
  s.nextId += 1;
  return s.nextId;
}

export function logAnki(kind: string, detail: Record<string, unknown> = {}): void {
  ankiState().logs.push({ kind, at: Date.now(), ...detail });
  persistAnki();
}

// ---------------------------------------------------------------- queries shared by the mock files

export function deckById(id: number): MockDeck | undefined {
  return ankiState().decks.find((d) => d.id === id);
}

export function deckByName(name: string): MockDeck | undefined {
  const key = name.toLowerCase();
  return ankiState().decks.find((d) => d.name.toLowerCase() === key);
}

/** The deck and every deck under it. */
export function subtree(id: number): MockDeck[] {
  const root = deckById(id);
  if (!root) return [];
  const prefix = `${root.name}::`;
  return ankiState().decks.filter((d) => d.id === id || d.name.startsWith(prefix));
}

function directChildren(name: string): MockDeck[] {
  const depth = name.split('::').length + 1;
  return ankiState()
    .decks.filter((d) => d.name.startsWith(`${name}::`) && d.name.split('::').length === depth)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
}

/** Due counts of the deck's own mock cards (not subdecks). */
export function ownCounts(deckId: number): QueueCounts {
  const t = today();
  const now = Date.now();
  const c = { new: 0, learn: 0, review: 0 };
  for (const card of ankiState().cards) {
    if (card.deckId !== deckId) continue;
    if (card.queue === 'new') c.new++;
    else if (card.queue === 'learn' && card.due <= now + 20 * 60_000) c.learn++;
    else if (card.queue === 'review' && card.due <= t) c.review++;
  }
  return c;
}

/** Counts shown for a deck in the list: its `display` numbers, or its cards plus its subdecks'. */
export function deckCounts(deckId: number): QueueCounts {
  const d = deckById(deckId);
  if (!d) return { new: 0, learn: 0, review: 0 };
  if (d.display) return { new: d.display[0], learn: d.display[1], review: d.display[2] };
  const c = ownCounts(deckId);
  for (const child of directChildren(d.name)) {
    const cc = deckCounts(child.id);
    c.new += cc.new;
    c.learn += cc.learn;
    c.review += cc.review;
  }
  return c;
}

/** Cards in the deck and its subdecks (mock cards plus the pretend ones). */
export function deckTotal(deckId: number): number {
  const ids = new Set(subtree(deckId).map((d) => d.id));
  const extra = subtree(deckId).reduce((n, d) => n + d.extraCards, 0);
  return ankiState().cards.filter((c) => ids.has(c.deckId)).length + extra;
}

function node(d: MockDeck): DeckNode {
  const parts = d.name.split('::');
  const counts = deckCounts(d.id);
  return {
    id: d.id,
    name: parts[parts.length - 1] ?? d.name,
    fullName: d.name,
    level: parts.length,
    newCount: counts.new,
    learnCount: counts.learn,
    reviewCount: counts.review,
    collapsed: d.collapsed,
    filtered: d.filtered,
    total: deckTotal(d.id),
    children: directChildren(d.name).map(node),
  };
}

/** The deck list like the core's `deck_tree` (the empty Default deck is hidden, as in Anki). */
export function buildDeckTree(): DeckTree {
  const s = ankiState();
  const tops = s.decks
    .filter((d) => !d.name.includes('::'))
    .filter((d) => d.id !== DEFAULT_DECK_ID || deckTotal(d.id) > 0 || directChildren(d.name).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
  return {
    decks: tops.map(node),
    studiedToday: { ...s.studiedToday },
    currentDeckId: s.currentDeckId,
  };
}

// ---------------------------------------------------------------- events

export const ankiChangedListeners = new Set<(e: AnkiChanged) => void>();
export const ankiPageListeners = new Set<(e: AnkiPageEvent) => void>();

export function emitAnkiChanged(e: AnkiChanged): void {
  for (const cb of [...ankiChangedListeners]) cb(e);
}

export function emitAnkiPageEvent(e: AnkiPageEvent): void {
  for (const cb of [...ankiPageListeners]) cb(e);
}
