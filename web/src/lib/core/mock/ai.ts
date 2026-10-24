// The mock core's AI (spec 13, docs/planos/fase-8.md): a simulated provider with the same rules as `app/src/ai*.rs`
// — consent per activation, key in the "keychain" (only the last 4 characters come back), caps, the confirmation
// above the threshold, the enrichment cache, the deck job and the background queue. Prices come from the repository's
// `model-prices.toml`, like the core's. Nothing leaves the browser.
import pricesToml from '../../../../../src-tauri/crates/core-ai/model-prices.toml?raw';
import {
  CoreError,
  type AiBudgetState,
  type AiCardKind,
  type AiCardProposal,
  type AiEffort,
  type AiEstimate,
  type AiFunctionSettings,
  type AiJudgeRequest,
  type AiJudgeResult,
  type AiModelPrice,
  type AiProvider,
  type AiQueueInfo,
  type AiQueueItem,
  type AiRates,
  type AiSettings,
  type AiUsage,
  type AiUsageTotal,
  type AiWordSense,
  type CoreClient,
  type JobProgress,
  type Unlisten,
  type VocabPos,
} from '../types';
import { ankiState, later, listenTo, logAnki, persistAnki } from './ankiData';
import { addJob, emitJob, type MockJob } from './jobs';

export type AiMockKeys = Extract<keyof CoreClient, `ai${string}`> | 'onAiQueue';

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'GPT (OpenAI)' },
  { id: 'gemini', label: 'Gemini (Google)' },
  { id: 'deepseek', label: 'DeepSeek' },
];
/** Providers with an adapter in this version (like `core_ai::provider_for`). */
const AVAILABLE: AiProvider[] = ['anthropic', 'openai'];

// ---------------------------------------------------------------- price table (model-prices.toml)

interface TomlModel {
  provider: string;
  id: string;
  role_default?: string;
  checked_at: string;
  source?: string;
  input: number;
  cached_input?: number;
  output: number;
  tiers: number;
}

/** The subset of TOML `model-prices.toml` uses: `[[model]]`, `[[model.tier]]`, `key = value`. */
export function parsePrices(text: string): TomlModel[] {
  const models: TomlModel[] = [];
  let current: Record<string, unknown> | null = null;
  let inTier = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[model]]') {
      current = { tiers: 0 };
      models.push(current as unknown as TomlModel);
      inTier = false;
    } else if (line === '[[model.tier]]') {
      if (current) current.tiers = (current.tiers as number) + 1;
      inTier = true;
    } else if (current && !inTier) {
      const m = /^(\w+)\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m as unknown as [string, string, string];
      if (value.startsWith('"')) current[key] = value.slice(1, value.lastIndexOf('"'));
      else if (/^-?[\d.]+$/.test(value)) current[key] = Number(value);
    }
  }
  return models;
}

const BUILT_IN = parsePrices(pricesToml);

// ---------------------------------------------------------------- state

interface FunctionState {
  provider: AiProvider | null;
  model: string | null;
  effort: AiEffort;
  maxOutputTokens: number;
}

interface WordAnswer {
  class: string;
  definition: string;
  translation: string;
}

interface MockAiState {
  enrich: FunctionState;
  judge: FunctionState;
  limitDayUsd: number;
  limitMonthUsd: number;
  confirmAboveUsd: number;
  backgroundEnrich: boolean;
  backgroundPaused: boolean;
  consent: Record<string, number>;
  /** Provider → the key's last 4 characters (the mock keeps no key). */
  keys: Record<string, string>;
  priceEdits: Record<string, AiRates & { editedAt: string }>;
  usage: { at: number; feature: string; provider: string; model: string; costUsd: number }[];
  cache: Record<string, WordAnswer>;
  queue: AiQueueItem[];
  status: string | null;
  /** e2e: the next call fails with this error. */
  nextError: { code: string; message: string } | null;
}

function fresh(): MockAiState {
  return {
    enrich: { provider: null, model: null, effort: 'minimum', maxOutputTokens: 4000 },
    judge: { provider: null, model: null, effort: 'low', maxOutputTokens: 2000 },
    limitDayUsd: 1,
    limitMonthUsd: 5,
    confirmAboveUsd: 0.05,
    backgroundEnrich: false,
    backgroundPaused: false,
    consent: {},
    keys: {},
    priceEdits: {},
    usage: [],
    cache: {},
    queue: [],
    status: null,
    nextError: null,
  };
}

function st(): MockAiState {
  const s = ankiState() as ReturnType<typeof ankiState> & { ai?: MockAiState };
  s.ai ??= fresh();
  return s.ai;
}

function save(): void {
  persistAnki();
}

const queueListeners = new Set<(q: AiQueueInfo) => void>();

// ---------------------------------------------------------------- errors (same codes and texts as core-ai)

const label = (p: AiProvider) => PROVIDERS.find((x) => x.id === p)?.label ?? p;
const err = {
  invalid: (m: string) => new CoreError('invalid_input', m),
  disabled: () => new CoreError('ai_disabled', 'IA desligada: escolha um provedor em Configurações → IA.'),
  noKey: (p: AiProvider) =>
    new CoreError('ai_no_key', `Falta a chave do provedor ${label(p)}. Adicione-a em Configurações → IA.`),
  unavailable: (p: AiProvider) =>
    new CoreError('ai_provider_unavailable', `${label(p)} chega numa próxima versão do app.`),
  consent: (p: AiProvider) =>
    new CoreError('ai_consent_required', `Confirme o que será enviado para ${label(p)} antes de ativá-lo.`),
  unpriced: (m: string) =>
    new CoreError(
      'ai_model_unpriced',
      `O modelo "${m}" não tem preço na tabela. Informe o preço em Configurações → IA antes de usá-lo.`,
    ),
  confirm: (usd: number) =>
    new CoreError('ai_needs_confirmation', `Esta chamada pode custar até US$ ${usd.toFixed(4)}. Confirme para enviar.`),
  limit: (spent: number, cap: number, when: string, next: string) =>
    new CoreError(
      'ai_limit_reached',
      `Limite de IA atingido: US$ ${spent.toFixed(2)} de US$ ${cap.toFixed(2)} ${when}. ` +
        `As funções de IA voltam ${next}, ou aumente o limite em Configurações → IA.`,
    ),
  setting: (m: string) => new CoreError('invalid_setting', m),
};

// ---------------------------------------------------------------- prices, usage, budget

function table(): AiModelPrice[] {
  const s = st();
  const rows: AiModelPrice[] = BUILT_IN.map((m) => {
    const edit = s.priceEdits[`${m.provider}/${m.id}`];
    return {
      provider: m.provider,
      model: m.id,
      roleDefault: m.role_default ?? null,
      checkedAt: edit?.editedAt ?? m.checked_at,
      source: edit ? null : (m.source ?? null),
      input: edit?.input ?? m.input,
      cachedInput: edit ? (edit.cachedInput ?? null) : (m.cached_input ?? null),
      output: edit?.output ?? m.output,
      hasTiers: !edit && m.tiers > 0,
      edited: !!edit,
      stale: false,
    };
  });
  for (const [key, edit] of Object.entries(s.priceEdits)) {
    const [provider, model] = key.split('/') as [string, string];
    if (rows.some((r) => r.provider === provider && r.model === model)) continue;
    rows.push({
      provider,
      model,
      roleDefault: null,
      checkedAt: edit.editedAt,
      source: null,
      input: edit.input,
      cachedInput: edit.cachedInput ?? null,
      output: edit.output,
      hasTiers: false,
      edited: true,
      stale: false,
    });
  }
  return rows;
}

function price(provider: AiProvider, model: string): AiModelPrice {
  const p = table().find((r) => r.provider === provider && r.model === model);
  if (!p) throw err.unpriced(model);
  return p;
}

function defaultModel(provider: AiProvider, role: 'enrich' | 'judge'): string | null {
  return BUILT_IN.find((m) => m.provider === provider && m.role_default === role)?.id ?? null;
}

function fnSettings(f: 'enrich' | 'judge'): AiFunctionSettings {
  const s = st()[f];
  return {
    ...s,
    effectiveModel: s.provider ? (s.model ?? defaultModel(s.provider, f)) : null,
  };
}

function startOfDay(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfMonth(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function spent(): { day: number; month: number } {
  const day0 = startOfDay();
  const month0 = startOfMonth();
  let day = 0;
  let month = 0;
  for (const u of st().usage) {
    if (u.at >= day0) day += u.costUsd;
    if (u.at >= month0) month += u.costUsd;
  }
  return { day, month };
}

function budgetState(extra = 0): AiBudgetState {
  const s = st();
  const { day, month } = spent();
  const d = day + extra;
  const m = month + extra;
  if (d >= s.limitDayUsd || m >= s.limitMonthUsd) return 'blocked';
  if (d >= s.limitDayUsd * 0.8 || m >= s.limitMonthUsd * 0.8) return 'warning';
  return 'ok';
}

function totals(since: number): AiUsageTotal[] {
  const map = new Map<string, AiUsageTotal>();
  for (const u of st().usage) {
    if (u.at < since) continue;
    const key = `${u.provider}/${u.feature}`;
    const t = map.get(key) ?? { provider: u.provider, feature: u.feature, calls: 0, costUsd: 0 };
    t.calls += 1;
    t.costUsd += u.costUsd;
    map.set(key, t);
  }
  return [...map.values()].sort((a, b) =>
    a.provider === b.provider ? a.feature.localeCompare(b.feature) : a.provider.localeCompare(b.provider),
  );
}

interface Target {
  provider: AiProvider;
  model: string;
  price: AiModelPrice;
  maxOutputTokens: number;
  effort: AiEffort;
}

/** Like `AppState::ai_target`: off, missing adapter, missing key or price stop here (no "connection"). */
function target(f: 'enrich' | 'judge'): Target {
  const fs = fnSettings(f);
  if (!fs.provider || !fs.effectiveModel) throw err.disabled();
  if (!AVAILABLE.includes(fs.provider)) throw err.unavailable(fs.provider);
  const p = price(fs.provider, fs.effectiveModel);
  if (!st().keys[fs.provider]) throw err.noKey(fs.provider);
  return {
    provider: fs.provider,
    model: fs.effectiveModel,
    price: p,
    maxOutputTokens: fs.maxOutputTokens,
    effort: fs.effort,
  };
}

/** The prompt template's size, roughly, plus the data (characters ÷ 3, like `estimate_input_tokens`). */
const PROMPT_CHARS = 1500;

function worstCase(t: Target, dataChars: number): number {
  const input = Math.ceil((PROMPT_CHARS + dataChars) / 3);
  return (input * t.price.input + t.maxOutputTokens * t.price.output) / 1e6;
}

/** Caps and confirmation (like `Budget::reserve`). */
function reserve(worst: number, confirmed: boolean | 'background'): void {
  const s = st();
  const { day, month } = spent();
  if (day + worst > s.limitDayUsd) throw err.limit(day, s.limitDayUsd, 'hoje', 'amanhã');
  if (month + worst > s.limitMonthUsd) throw err.limit(month, s.limitMonthUsd, 'neste mês', 'no dia 1º');
  if (worst > s.confirmAboveUsd && confirmed !== true) throw err.confirm(worst);
}

/** One simulated call: the scripted failure, else the billed usage (about a third of the worst case). */
function bill(t: Target, feature: string, worst: number): void {
  const s = st();
  if (s.nextError) {
    const e = s.nextError;
    s.nextError = null;
    save();
    throw new CoreError(e.code, e.message);
  }
  s.usage.push({ at: Date.now(), feature, provider: t.provider, model: t.model, costUsd: worst / 3 });
  logAnki('aiCall', { feature, provider: t.provider, model: t.model });
  save();
}

function call(t: Target, feature: string, dataChars: number, confirmed: boolean | 'background'): void {
  const worst = worstCase(t, dataChars);
  reserve(worst, confirmed);
  bill(t, feature, worst);
}

// ---------------------------------------------------------------- simulated answers

const WORDS: Record<string, [string, string, string]> = {
  pig: ['noun', 'a farm animal kept for its meat', 'porco'],
  windmill: ['noun', 'a building that uses wind power to grind grain', 'moinho de vento'],
  harvest: ['noun', 'the gathering of crops', 'colheita'],
  pasture: ['noun', 'land covered with grass for animals', 'pasto'],
  learner: ['noun', 'a person who is learning', 'aprendiz'],
};

function answerFor(lemma: string, pos: string): WordAnswer {
  const known = WORDS[lemma];
  if (known) return { class: known[0], definition: known[1], translation: known[2] };
  const cls = ({ n: 'noun', v: 'verb', a: 'adj', r: 'adv' } as Record<string, string>)[pos] ?? 'noun';
  return { class: cls, definition: `the meaning of ${lemma} in the sentence`, translation: `${lemma} (pt)` };
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 600);
}

function cacheKey(lemma: string, sentence: string): string {
  return `${lemma}\u0000${squash(sentence)}`;
}

/** The cached answer of a word in a sentence (`Gerar deck` with AI reads it). */
export function mockAiCached(lemma: string, sentence: string): WordAnswer | null {
  return st().cache[cacheKey(lemma, sentence)] ?? null;
}

const CLASS_PT: Record<string, string> = {
  noun: 'substantivo',
  verb: 'verbo',
  adj: 'adjetivo',
  adv: 'advérbio',
  prep: 'preposição',
  conj: 'conjunção',
  pron: 'pronome',
  det: 'determinante',
  interj: 'interjeição',
  phrase: 'expressão',
};

export function mockAiClassPt(cls: string): string | null {
  return CLASS_PT[cls] ?? null;
}

function judgeAnswer(req: AiJudgeRequest): AiJudgeResult {
  switch (req.autoVerdict) {
    case 'wrong':
      return { veredito: 'errado', explicacao: 'Simulado: a resposta faz outra coisa.', notaSugerida: 1 };
    case 'unverifiable':
      return {
        veredito: 'equivalente',
        explicacao: 'Simulado: faz o mesmo que a referência por outro caminho.',
        notaSugerida: 3,
      };
    default:
      return { veredito: 'quase', explicacao: 'Simulado: falta um detalhe da referência.', notaSugerida: 2 };
  }
}

const CARD_FIELDS: Record<AiCardKind, string[]> = {
  basico: ['frente', 'verso'],
  cloze: ['texto'],
  comando: ['pergunta', 'resposta', 'observacao'],
  programa: ['pergunta', 'linguagem', 'resposta'],
};

function cardsAnswer(text: string, kind: AiCardKind, n: number): AiCardProposal[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const count = Math.max(1, Math.min(n, sentences.length));
  return Array.from({ length: count }, (_, i) => {
    const s = sentences[i] ?? text.trim();
    const firstWord = s.split(/\s+/).find((w) => w.length > 3) ?? s.split(/\s+/)[0] ?? '';
    const fields: Record<string, string> = {
      basico: { frente: `O que diz o trecho sobre "${firstWord}"?`, verso: s },
      cloze: { texto: s.replace(firstWord, `{{c1::${firstWord}}}`) },
      comando: { pergunta: `Qual comando faz: ${s}`, resposta: 'echo simulado', observacao: '' },
      programa: { pergunta: s, linguagem: 'python', resposta: 'print("simulado")' },
    }[kind];
    return { fields, tags: ['ia'] };
  }).map((c) => ({ ...c, fields: Object.fromEntries(CARD_FIELDS[kind].map((f) => [f, c.fields[f] ?? ''])) }));
}

// ---------------------------------------------------------------- deck job and queue

export interface AiVocabBridge {
  /** The rows of a report the deck would create (lemma, WordNet pos, example sentence). */
  rows(bookUid: string, scanUid: string, lemmas: string[]): { lemma: string; pos: string; example: string }[];
  /** The example of `lemma` on `page` of the book's latest scan (empty when none). */
  sentence(bookUid: string, lemma: string, page: number): string;
}

let vocabBridge: AiVocabBridge | null = null;

export function setAiVocabBridge(bridge: AiVocabBridge): void {
  vocabBridge = bridge;
}

function deckItems(bookUid: string, scanUid: string, lemmas: string[]) {
  if (!vocabBridge) throw new CoreError('vocab_not_scanned', 'Este livro ainda não foi analisado.');
  return vocabBridge.rows(bookUid, scanUid, lemmas);
}

function enrichCalls(t: Target, items: { lemma: string; example: string }[]): number[] {
  const batch = Math.max(1, Math.min(40, Math.floor((t.maxOutputTokens - 100) / 60)));
  const worsts: number[] = [];
  for (let i = 0; i < items.length; i += batch) {
    const chunk = items.slice(i, i + batch);
    worsts.push(worstCase(t, chunk.reduce((n, x) => n + x.lemma.length + x.example.length + 40, 0)));
  }
  return worsts;
}

let jobSeq = 0;

function startDeckJob(bookUid: string, scanUid: string, items: { lemma: string; pos: string; example: string }[]) {
  const t = target('enrich');
  const id = `mock-ai-${++jobSeq}`;
  const job: MockJob = {
    progress: {
      jobId: id,
      kind: 'aiEnrich',
      bookUid,
      scanUid,
      stage: 'queued',
      done: 0,
      total: items.length,
      reused: false,
      error: null,
    } satisfies JobProgress,
    cancelled: false,
    params: scanUid,
  };
  addJob(job);
  const batch = Math.max(1, Math.min(40, Math.floor((t.maxOutputTokens - 100) / 60)));
  let done = 0;
  const step = () => {
    if (job.cancelled) {
      emitJob(job, { stage: 'cancelled' });
      return;
    }
    if (done >= items.length) {
      emitJob(job, { stage: 'done', done: items.length });
      return;
    }
    const chunk = items.slice(done, done + batch);
    try {
      bill(t, 'enrich', worstCase(t, chunk.reduce((n, x) => n + x.lemma.length + x.example.length + 40, 0)));
    } catch (e) {
      const ce = e instanceof CoreError ? e : new CoreError('ai_internal', String(e));
      emitJob(job, { stage: 'failed', error: { code: ce.code, message: ce.message } });
      return;
    }
    for (const it of chunk) st().cache[cacheKey(it.lemma, it.example)] = answerFor(it.lemma, it.pos);
    save();
    done += chunk.length;
    emitJob(job, { stage: 'ai', done, total: items.length });
    setTimeout(step, 30);
  };
  setTimeout(() => {
    emitJob(job, { stage: 'ai', done: 0, total: items.length });
    step();
  }, 0);
  return id;
}

function queueInfo(): AiQueueInfo {
  const s = st();
  const failed = s.queue.filter((i) => i.state === 'failed').length;
  return structuredClone({
    enabled: s.backgroundEnrich,
    paused: s.backgroundPaused,
    pending: s.queue.length - failed,
    failed,
    status: s.status,
    items: [...s.queue].sort((a, b) => Number(a.state === 'failed') - Number(b.state === 'failed')),
  });
}

function emitQueue(): void {
  const q = queueInfo();
  for (const cb of [...queueListeners]) cb(structuredClone(q));
}

function noteFieldMap(noteId: number): Record<string, string> | null {
  const a = ankiState();
  const note = a.notes.find((n) => n.id === noteId);
  const nt = note && a.notetypes.find((t) => t.id === note.notetypeId);
  if (!note || !nt) return null;
  return Object.fromEntries(nt.fields.map((f, i) => [f, note.fields[i] ?? '']));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Fills Definição/Tradução only where the field still holds what the app wrote. */
function applyAnswer(item: AiQueueItem, a: WordAnswer): void {
  const st0 = ankiState();
  const note = st0.notes.find((n) => n.id === item.noteId);
  const nt = note && st0.notetypes.find((t) => t.id === note.notetypeId);
  if (!note || !nt) return;
  const left = JSON.parse(item.leftFields) as { definicao: string; traducao: string };
  for (const [name, expected, value] of [
    ['Definição', left.definicao, escapeHtml(a.definition)],
    ['Tradução', left.traducao, escapeHtml(a.translation)],
  ] as const) {
    const i = nt.fields.indexOf(name);
    if (i >= 0 && note.fields[i] === expected) note.fields[i] = value;
  }
  note.mtime = Date.now();
}

let queueTimer: ReturnType<typeof setTimeout> | null = null;

/** The worker: one batch per tick while on, not paused and not empty. */
function kickQueue(): void {
  emitQueue();
  if (queueTimer) return;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    queueStep();
  }, 50);
}

/** One step of the simulated worker (exported for unit tests). */
export function mockAiQueueStep(): 'idle' | 'worked' | 'wait' {
  const r = queueStep();
  return r;
}

function queueStep(): 'idle' | 'worked' | 'wait' {
  const s = st();
  if (!s.backgroundEnrich || s.backgroundPaused) return 'idle';
  let t: Target;
  try {
    t = target('enrich');
  } catch (e) {
    s.status = (e as CoreError).message;
    save();
    emitQueue();
    return 'idle';
  }
  const pending = s.queue.filter((i) => i.state === 'pending');
  if (!pending.length) {
    s.status = null;
    save();
    emitQueue();
    return 'idle';
  }
  const batch = pending.slice(0, Math.max(1, Math.min(40, Math.floor((t.maxOutputTokens - 100) / 60))));
  const worst = worstCase(t, batch.reduce((n, x) => n + x.lemma.length + x.sentence.length + 40, 0));
  if (worst > s.confirmAboveUsd) {
    s.backgroundPaused = true;
    s.status =
      `Fila pausada: o próximo lote pode custar até US$ ${worst.toFixed(4)}, acima do limite de confirmação ` +
      `(US$ ${s.confirmAboveUsd.toFixed(2)}). Retome a fila para enviar.`;
    save();
    emitQueue();
    return 'idle';
  }
  try {
    reserve(worst, 'background');
    bill(t, 'enrich', worst);
  } catch (e) {
    s.status = (e as CoreError).message;
    save();
    emitQueue();
    return 'wait';
  }
  for (const item of batch) {
    const a = answerFor(item.lemma, item.pos);
    s.cache[cacheKey(item.lemma, item.sentence)] = a;
    applyAnswer(item, a);
  }
  s.queue = s.queue.filter((i) => !batch.includes(i));
  s.status = null;
  save();
  emitQueue();
  kickQueue();
  return 'worked';
}

/** Queues a vocabulary note (when the background enrichment is on); `vocabAddWord` and `aiQueueAddNote` call it. */
export function mockAiEnqueue(noteId: number, lemma: string | null, pos: string, sentence: string): boolean {
  const s = st();
  if (!s.backgroundEnrich) return false;
  const fields = noteFieldMap(noteId);
  if (!fields) throw new CoreError('not_found', 'A nota não existe mais.');
  if (fields['Definição'] === undefined || fields['Tradução'] === undefined)
    throw err.invalid('Só notas de Vocabulário (com Definição e Tradução) entram na fila da IA.');
  const word = (lemma ?? (fields.Lema || fields.Palavra || '').replace(/<[^>]*>/g, '')).trim().toLowerCase();
  if (!word || s.queue.some((i) => i.noteId === noteId)) return false;
  s.queue.push({
    uid: `q-${noteId}`,
    noteId,
    lemma: word,
    pos,
    sentence: squash(sentence),
    leftFields: JSON.stringify({ definicao: fields['Definição'], traducao: fields['Tradução'] }),
    createdAt: Date.now(),
    state: 'pending',
    attempts: 0,
    error: null,
  });
  save();
  kickQueue();
  return true;
}

// ---------------------------------------------------------------- client

function checkKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw err.invalid('Cole a chave do provedor.');
  if (key.length > 512 || /\s/.test(key)) throw err.invalid('A chave tem caracteres inválidos (espaços ou quebras de linha).');
  return key;
}

function settings(): AiSettings {
  const s = st();
  return structuredClone({
    enrich: fnSettings('enrich'),
    judge: fnSettings('judge'),
    limitDayUsd: s.limitDayUsd,
    limitMonthUsd: s.limitMonthUsd,
    confirmAboveUsd: s.confirmAboveUsd,
    backgroundEnrich: s.backgroundEnrich,
    backgroundPaused: s.backgroundPaused,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      available: AVAILABLE.includes(p.id),
      hasKey: !!s.keys[p.id],
      keySuffix: s.keys[p.id] ?? null,
    })),
    keychainAvailable: true,
  });
}

const POS_CLASS: Record<string, string> = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' };

export function createAiMock(): Pick<CoreClient, AiMockKeys> {
  return {
    aiSettingsGet: () => later(settings),
    aiSettingsSet: (patch) =>
      later(() => {
        const s = st();
        const next = structuredClone(s);
        for (const f of ['enrich', 'judge'] as const) {
          const p = patch[f];
          if (!p) continue;
          const cur = s[f];
          const provider = p.provider !== undefined ? p.provider : cur.provider;
          const changed = provider !== cur.provider;
          if (provider && changed) {
            if (!AVAILABLE.includes(provider)) throw err.unavailable(provider);
            if (!patch.consent?.includes(provider)) throw err.consent(provider);
          }
          const model =
            p.model !== undefined ? (p.model?.trim() || null) : changed ? null : cur.model;
          if (provider && model) price(provider, model);
          const max = p.maxOutputTokens ?? cur.maxOutputTokens;
          const cap = f === 'enrich' ? 4000 : 2000;
          if (max < 500 || max > cap) throw err.setting(`Valor inválido: o máximo é ${cap}.`);
          next[f] = { provider, model, effort: p.effort ?? cur.effort, maxOutputTokens: max };
        }
        for (const k of ['limitDayUsd', 'limitMonthUsd', 'confirmAboveUsd'] as const) {
          const v = patch[k];
          if (v === undefined) continue;
          if (!Number.isFinite(v) || v < 0) throw err.setting('Valor inválido: o mínimo é 0.');
          next[k] = v;
        }
        if (patch.backgroundEnrich !== undefined) next.backgroundEnrich = patch.backgroundEnrich;
        if (patch.backgroundPaused !== undefined) next.backgroundPaused = patch.backgroundPaused;
        for (const p of patch.consent ?? []) next.consent[p] = Date.now();
        Object.assign(s, next);
        save();
        kickQueue();
        return settings();
      }),
    aiKeySet: (provider, key) =>
      later(() => {
        st().keys[provider] = checkKey(key).slice(-4);
        save();
        kickQueue();
        return settings();
      }),
    aiKeyDelete: (provider) =>
      later(() => {
        delete st().keys[provider];
        save();
        return settings();
      }),
    aiKeyTest: (provider) =>
      later(() => {
        if (!AVAILABLE.includes(provider)) throw err.unavailable(provider);
        const suffix = st().keys[provider];
        if (!suffix) throw err.noKey(provider);
        const fs = (['enrich', 'judge'] as const).map(fnSettings).find((f) => f.provider === provider);
        const model = fs?.effectiveModel ?? defaultModel(provider, 'enrich') ?? '';
        // e2e: a key ending in "0000" is refused.
        if (suffix === '0000')
          return {
            ok: false,
            code: 'ai_auth',
            message: `A chave do provedor ${label(provider)} foi recusada. Confira-a em Configurações → IA.`,
            model,
          };
        return { ok: true, code: null, message: `Chave válida (modelo ${model}).`, model };
      }),
    aiPricesGet: () => later(() => structuredClone(table())),
    aiPricesSet: (provider, model, rates) =>
      later(() => {
        const m = model.trim();
        if (!m || m.length > 100 || m.includes('/')) throw err.invalid('Nome de modelo inválido.');
        const key = `${provider}/${m}`;
        if (rates) {
          const ok = (x: number | null | undefined) => x == null || (Number.isFinite(x) && x >= 0 && x <= 10_000);
          if (!ok(rates.input) || !ok(rates.output) || !ok(rates.cachedInput) || !ok(rates.cacheWrite))
            throw err.invalid('Preço inválido: use valores em US$ por milhão de tokens, de 0 a 10 000.');
          st().priceEdits[key] = { ...rates, editedAt: new Date().toISOString().slice(0, 10) };
        } else delete st().priceEdits[key];
        save();
        return structuredClone(table());
      }),
    aiUsage: () =>
      later((): AiUsage => {
        const s = st();
        const { day, month } = spent();
        return {
          dayUsd: day,
          monthUsd: month,
          limitDayUsd: s.limitDayUsd,
          limitMonthUsd: s.limitMonthUsd,
          state: budgetState(),
          day: totals(startOfDay()),
          month: totals(startOfMonth()),
        };
      }),
    aiEstimate: (request) =>
      later((): AiEstimate => {
        let t: Target;
        let worsts: number[];
        let cached = 0;
        let toSend = 0;
        if (request.feature === 'cards') {
          if (request.n < 1 || request.n > 10) throw err.invalid('Peça de 1 a 10 cards.');
          if (!request.text.trim()) throw err.invalid('Selecione um trecho do livro.');
          t = target('enrich');
          worsts = [worstCase(t, request.text.length)];
        } else {
          const items = deckItems(request.bookUid, request.scanUid, request.lemmas);
          const send = items.filter((i) => !mockAiCached(i.lemma, i.example));
          cached = items.length - send.length;
          toSend = send.length;
          t = target('enrich');
          worsts = enrichCalls(t, send);
        }
        const worst = worsts.reduce((a, b) => a + b, 0);
        return {
          worstUsd: worst,
          calls: worsts.length,
          cached,
          toSend,
          needsConfirmation: worst > st().confirmAboveUsd,
          state: budgetState(worst),
          provider: t.provider,
          model: t.model,
        };
      }),
    aiJudgeCode: (request, confirmed) =>
      later(() => {
        const t = target('judge');
        call(t, 'judge', request.question.length + request.answer.length + request.userAnswer.length, confirmed);
        return judgeAnswer(request);
      }),
    aiCardsFromText: (text, kind, n, confirmed) =>
      later(() => {
        if (n < 1 || n > 10) throw err.invalid('Peça de 1 a 10 cards.');
        if (!text.trim()) throw err.invalid('Selecione um trecho do livro.');
        const t = target('enrich');
        call(t, 'cards', text.length, confirmed);
        return cardsAnswer(text, kind, n);
      }),
    aiDefineWord: (lemma, pos, given, confirmed, at) =>
      later((): AiWordSense => {
        const word = lemma.trim().toLowerCase();
        if (!word || word.length > 64) throw err.invalid('Selecione uma só palavra.');
        const sentence = !given.trim() && at ? (vocabBridge?.sentence(at.bookUid, word, at.page) ?? '') : given;
        const hit = mockAiCached(word, sentence);
        if (hit) return { lemma: word, ...hit, cached: true };
        const t = target('enrich');
        call(t, 'define', word.length + sentence.length, confirmed);
        const a = answerFor(word, (pos as VocabPos | null) ?? '');
        st().cache[cacheKey(word, sentence)] = a;
        save();
        return { lemma: word, ...a, cached: false };
      }),
    aiEnrichStart: (bookUid, scanUid, lemmas, confirmed) =>
      later(() => {
        const items = deckItems(bookUid, scanUid, lemmas);
        const send = items.filter((i) => !mockAiCached(i.lemma, i.example));
        const cached = items.length - send.length;
        if (!send.length) return { jobId: null, alreadyRunning: false, cached, toSend: 0 };
        const t = target('enrich');
        const worst = enrichCalls(t, send).reduce((a, b) => a + b, 0);
        if (worst > st().confirmAboveUsd && !confirmed) throw err.confirm(worst);
        return { jobId: startDeckJob(bookUid, scanUid, send), alreadyRunning: false, cached, toSend: send.length };
      }),
    aiQueueGet: () => later(queueInfo),
    aiQueueSetPaused: (paused) =>
      later(() => {
        const s = st();
        s.backgroundPaused = paused;
        if (!paused) s.status = null;
        save();
        kickQueue();
        return queueInfo();
      }),
    aiQueueRemove: (uid) =>
      later(() => {
        const s = st();
        s.queue = s.queue.filter((i) => i.uid !== uid);
        save();
        emitQueue();
        return queueInfo();
      }),
    aiQueueRetry: () =>
      later(() => {
        for (const i of st().queue)
          if (i.state === 'failed') Object.assign(i, { state: 'pending', attempts: 0, error: null });
        save();
        kickQueue();
        return queueInfo();
      }),
    aiQueueAddNote: (noteId, sentence) =>
      later(() => {
        mockAiEnqueue(noteId, null, '', sentence);
        return queueInfo();
      }),
    onAiQueue: (cb): Unlisten => listenTo(queueListeners, cb),
  };
}

/** Class of a WordNet letter, as sent to the AI. */
export function mockAiClassOf(pos: string | null): string {
  return (pos && POS_CLASS[pos]) || '';
}

/** e2e: make the next AI call fail (`ai_offline`, `ai_rate_limited`…). */
export function mockAiFailNext(code: string, message: string): void {
  st().nextError = { code, message };
  save();
}

export function resetAiMock(): void {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = null;
  jobSeq = 0;
}
