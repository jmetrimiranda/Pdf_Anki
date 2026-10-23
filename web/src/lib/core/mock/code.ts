// Code cards in the mock core (spec 11, 14, 15): which notetypes are code types (the app's by name, a user type
// after `codeMappingSet`), the StudyCard.code the Rust core builds, `code_note_extra`, "Contestar", the code
// settings, a deterministic stand-in for `code_run_cpp` (so every UI path is reachable in e2e) and a port of the
// Markdown importer's rules (core-code `markdown.rs`).
import { sameCppStructure } from '@leitor/checkers';
import {
  CoreError,
  type CodeCard,
  type CodeCardFields,
  type CodeMapping,
  type CodeSettings,
  type CoreClient,
  type CppRunResult,
  type ImportItem,
  type ImportPreview,
  type ProgramMode,
} from '../types';
import {
  APP_NOTETYPE_NAMES,
  ankiState,
  deckById,
  emitAnkiChanged,
  fixtureCodeToHtml,
  later,
  logAnki,
  mockLatency,
  persistAnki,
  type MockNote,
  type MockNotetype,
} from './ankiData';
import { ankiNotesMock } from './ankiNotes';

export type CodeMockKeys = Extract<keyof CoreClient, `code${string}`>;

export const CODE_COMMAND = 'Código · Comando';
export const CODE_PROGRAM = 'Código · Programa';

// ---------------------------------------------------------------- HTML of code fields (codeField.ts rules)

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Field HTML → plain text (a small version of the editor's `htmlToCode`: <br>/<div> → newlines, tags dropped). */
export function mockHtmlToCode(html: string): string {
  const s = html
    .replace(/\r\n?/g, '\n')
    .replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<\/div>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^\n/, '');
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

function fieldLines(html: string): string[] {
  return mockHtmlToCode(html)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

const squash = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');

// ---------------------------------------------------------------- code types

export interface MockCodeType {
  role: 'command' | 'program';
  appType: boolean;
  question: string;
  answer: string;
  notes: string | null;
}

function hasField(nt: MockNotetype, name: string): boolean {
  return nt.fields.includes(name);
}

/** Like core_anki::code::code_type: the app types by name, a mapped user type while it has every mapped field. */
export function mockCodeType(nt: MockNotetype): MockCodeType | null {
  if (nt.name === CODE_COMMAND || nt.name === CODE_PROGRAM) {
    if (!hasField(nt, 'Pergunta') || !hasField(nt, 'Resposta')) return null;
    return {
      role: nt.name === CODE_COMMAND ? 'command' : 'program',
      appType: true,
      question: 'Pergunta',
      answer: 'Resposta',
      notes: hasField(nt, 'Observação') ? 'Observação' : null,
    };
  }
  const m = (ankiState().codeMappings ?? []).find((x) => x.notetypeId === nt.id);
  if (!m || nt.kind === 'cloze') return null;
  const names = [m.fields.question, m.fields.answer, m.fields.notes].filter((x): x is string => !!x);
  if (!names.every((n) => hasField(nt, n))) return null;
  return {
    role: 'command',
    appType: false,
    question: m.fields.question,
    answer: m.fields.answer,
    notes: m.fields.notes,
  };
}

/** The answer template of a mock notetype references `field` (`answerShowsNotes`). */
function answerShowsField(nt: MockNotetype, field: string): boolean {
  // App types: `{{#Observação}}<blockquote>…`; the user type's back: `{{#Explicação}}<blockquote>…`.
  if (nt.name === CODE_COMMAND || nt.name === CODE_PROGRAM) return field === 'Observação';
  return field === 'Explicação' || field === 'Comando' || field === 'Frente';
}

/**
 * The answer template of a mock notetype prints the answer field (`answerShowsAnswer`): "Código · Programa" prints
 * `{{Resposta}}`, "Código · Comando" only has the stripped `{{type:Resposta}}`; the user type's back prints
 * `{{Comando}}`.
 */
function answerDisplaysField(nt: MockNotetype, field: string): boolean {
  if (nt.name === CODE_PROGRAM) return field === 'Resposta';
  if (nt.name === CODE_COMMAND) return false;
  return field === 'Comando' || field === 'Frente';
}

/** StudyCard.code exactly as the Rust core builds it (`code_card`). */
export function mockCodeCard(note: MockNote, nt: MockNotetype): CodeCard | null {
  const code = mockCodeType(nt);
  if (!code) return null;
  const value = (name: string | null) => {
    if (!name) return '';
    const i = nt.fields.indexOf(name);
    return i >= 0 ? (note.fields[i] ?? '') : '';
  };
  const program = code.role === 'program';
  const pf = (name: string) => (program ? value(name) : '');
  const fields: CodeCardFields = {
    answer: value(code.answer),
    accepted: hasField(nt, 'Aceitas') ? value('Aceitas') : '',
    requires: hasField(nt, 'Exige') ? value('Exige') : '',
    notes: value(code.notes),
    language: pf('Linguagem'),
    mode: pf('Modo'),
    initial: pf('Inicial'),
    setup: pf('Setup'),
    tests: pf('Testes'),
    input: pf('Entrada'),
    expectedOutput: pf('SaidaEsperada'),
  };
  return {
    role: code.role,
    notetypeId: nt.id,
    appType: code.appType,
    acceptedField: hasField(nt, 'Aceitas'),
    answerShowsNotes: code.notes !== null && answerShowsField(nt, code.notes),
    answerShowsAnswer: answerDisplaysField(nt, code.answer),
    fields,
  };
}

// ---------------------------------------------------------------- C++ simulation

/** The simulated toolchain (persisted with the collection, so it survives a reload in e2e). */
const cpp = {
  get available(): boolean {
    return ankiState().cppAvailable ?? true;
  },
  clangFormat: false,
};

/** e2e/tests: no local compiler and no runner (`code_cpp_unavailable` → the cards fall back to `estrutura`). */
export function mockSetCppAvailable(available: boolean): void {
  ankiState().cppAvailable = available;
  persistAnki();
}

export const MOCK_COMPILER = 'g++ (simulado) 13.2.0';

function unescapeCpp(s: string): string {
  return s.replace(/\\(n|t|"|\\)/g, (_m, c: string) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c] ?? c);
}

/** The reference answer of the Programa note whose Testes end `main.cpp` (to make a wrong answer fail). */
function referenceFor(source: string): string | null {
  const s = ankiState();
  for (const note of s.notes) {
    const nt = s.notetypes.find((x) => x.id === note.notetypeId);
    if (!nt || nt.name !== CODE_PROGRAM) continue;
    const tests = mockHtmlToCode(note.fields[nt.fields.indexOf('Testes')] ?? '');
    if (tests.trim() && source.trimEnd().endsWith(tests.trimEnd())) {
      return mockHtmlToCode(note.fields[nt.fields.indexOf('Resposta')] ?? '');
    }
  }
  return null;
}

function balanced(source: string): boolean {
  let depth = 0;
  for (const c of source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')) {
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic stand-in for compiling and running C++: `SYNTAX_ERROR`, unbalanced braces or code glued after an
 * `#include` → a compile error;
 * `while(true)`/`for(;;)` → a timeout after 200 ms; tests → one PASS per CHECK (FAIL when the source has
 * `FAIL_ME` or the answer's tokens differ from the card's reference); `cout << "…"` → that text on stdout.
 */
async function runCpp(files: Record<string, string>, stdin: string): Promise<CppRunResult> {
  await delay(mockLatency());
  if (!cpp.available) {
    throw new CoreError(
      'code_cpp_unavailable',
      'Nenhum compilador de C++ encontrado (g++ ou clang++) e nenhum runner configurado.',
    );
  }
  const names = Object.keys(files);
  if (names.length === 0 || !names.some((n) => n.endsWith('.cpp'))) {
    throw new CoreError('code_invalid_input', 'Envie ao menos um arquivo .cpp.');
  }
  const source = names.map((n) => files[n] ?? '').join('\n');
  logAnki('codeRunCpp', { files: names, stdin });
  const base = { backend: 'local' as const, compiler: MOCK_COMPILER };
  // Like g++: code after `#include <…>` on the same line breaks the build.
  const glued = source.split('\n').findIndex((l) => /^\s*#\s*include\s*(<[^>]*>|"[^"]*")\s*(?!\/[/*])\S/.test(l)) + 1;
  if (glued > 0) {
    return {
      ...base,
      compile: { ok: false, stderr: `main.cpp:${glued}:1: error: extra tokens at end of #include directive`, timeMs: 180 },
      run: null,
    };
  }
  if (source.includes('SYNTAX_ERROR') || !balanced(source)) {
    const line = source.split('\n').findIndex((l) => l.includes('SYNTAX_ERROR')) + 1 || 1;
    return {
      ...base,
      compile: { ok: false, stderr: `main.cpp:${line}:1: error: expected ';' before '}' token`, timeMs: 180 },
      run: null,
    };
  }
  const compile = { ok: true, stderr: '', timeMs: 180 };
  if (/while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/.test(source)) {
    await delay(200);
    return {
      ...base,
      compile,
      run: {
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        timeMs: 10_000,
        timedOut: true,
        truncated: false,
      },
    };
  }
  if (source.includes('#include "check.hpp"')) {
    const marker = '#line 1 "resposta.cpp"\n';
    const at = source.indexOf(marker);
    const end = source.indexOf('\n#line 1 "testes.cpp"');
    const answer = at >= 0 && end > at ? source.slice(at + marker.length, end) : '';
    const ref = referenceFor(source);
    const fail = source.includes('FAIL_ME') || (ref !== null && !sameCppStructure(ref, answer));
    const tests = source.slice(end >= 0 ? end : 0);
    const checks = [...tests.matchAll(/CHECK\((.*)\);/g)].map((m) => m[1]!.trim());
    const stdout = checks.map((c, i) => (fail ? `FAIL ${c} (testes.cpp:${i + 2})` : `PASS ${c}`)).join('\n');
    return {
      ...base,
      compile,
      run: {
        exitCode: fail ? 1 : 0,
        signal: null,
        stdout: stdout ? `${stdout}\n` : '',
        stderr: '',
        timeMs: 4,
        timedOut: false,
        truncated: false,
      },
    };
  }
  let stdout = '';
  if (source.includes('#include <iostream>') && source.includes('cout')) {
    for (const m of source.matchAll(/<<\s*"((?:\\.|[^"\\])*)"/g)) stdout += unescapeCpp(m[1]!);
    if (/<<\s*(std::)?endl/.test(source)) stdout += '\n';
  }
  return {
    ...base,
    compile,
    run: { exitCode: 0, signal: null, stdout, stderr: '', timeMs: 3, timedOut: false, truncated: false },
  };
}

// ---------------------------------------------------------------- Markdown import (core-code markdown.rs)

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const COMMAND_LANGS = ['bash', 'sh', 'ros2'];
const EXTRAS: Record<string, string> = {
  tests: 'Testes',
  output: 'SaidaEsperada',
  input: 'Entrada',
  setup: 'Setup',
  start: 'Inicial',
};

interface Fence {
  info: string;
  content: string;
  line: number;
  unclosed: boolean;
}

function heading(line: string): { level: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
  if (!m) return null;
  let text = (m[2] ?? '').trim();
  const closed = /^(.*?)(?:^|[ \t]+)#+$/.exec(text);
  if (closed) text = closed[1]!.trim();
  return { level: m[1]!.length, text };
}

/** Parses the import text into a preview (the same rules and pt-BR messages as the core). */
export function mockParseMarkdown(raw: string): ImportPreview {
  const preview: ImportPreview = { items: [], warnings: [], errors: [] };
  if (raw.length > 1024 * 1024) {
    preview.errors.push('O texto é grande demais para importar de uma vez (máximo de 1 MiB).');
    return preview;
  }
  const lines = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  interface Builder {
    line: number;
    title: string;
    answer: { lang: string; content: string } | null;
    kind: ImportItem['kind'];
    language: string | null;
    extras: [string, string][];
    notes: string[];
    accepted: string[];
    requires: string[];
    tags: string[];
    errors: string[];
    warnings: string[];
  }
  const items: Builder[] = [];
  let cur: Builder | null = null;
  let ignoredBefore = false;
  const add = (list: string[], m: string) => {
    if (!list.includes(m)) list.push(m);
  };
  const isItemStart = (j: number) =>
    heading(lines[j]!)?.level === 3 &&
    (() => {
      const next = lines.slice(j + 1).find((l) => l.trim() !== '');
      const f = next ? FENCE.exec(next) : null;
      return !!f && f[2]!.trim() !== '';
    })();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = FENCE.exec(line);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      const ch = open[1]![0]!;
      const len = open[1]!.length;
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.replace(/^ {0,3}/, '').trimEnd();
        if (t.length >= len && [...t].every((c) => c === ch)) {
          close = j;
          break;
        }
      }
      const limit = close >= 0 ? close : lines.length;
      let itemStart = -1;
      for (let j = i + 1; j < limit; j++)
        if (isItemStart(j)) {
          itemStart = j;
          break;
        }
      let end: number;
      let next: number;
      let unclosed: boolean;
      if (itemStart >= 0) [end, next, unclosed] = [itemStart, itemStart, true];
      else if (close >= 0) [end, next, unclosed] = [close, close + 1, false];
      else {
        let h = lines.length;
        for (let j = i + 1; j < lines.length; j++)
          if (heading(lines[j]!)?.level === 3) {
            h = j;
            break;
          }
        [end, next, unclosed] = [h, h, true];
      }
      let content = lines.slice(i + 1, end).join('\n');
      if (unclosed) content = content.replace(/\n+$/, '');
      const fence: Fence = { info: open[2]!.trim(), content, line: i + 1, unclosed };
      if (cur) pushFence(cur, fence);
      else if (!items.length) ignoredBefore = true;
      i = next - 1;
      continue;
    }
    const h = heading(line);
    if (h) {
      if (h.level === 3) {
        if (cur) items.push(cur);
        cur = {
          line: i + 1,
          title: h.text,
          answer: null,
          kind: null,
          language: null,
          extras: [],
          notes: [],
          accepted: [],
          requires: [],
          tags: [],
          errors: [],
          warnings: [],
        };
      } else if (h.level < 3) {
        if (cur) items.push(cur);
        cur = null;
      } else if (cur) add(cur.warnings, `Título da linha ${i + 1} ignorado (use ### para perguntas).`);
      else if (!items.length) ignoredBefore = true;
      continue;
    }
    if (line.trim() === '') continue;
    if (!cur) {
      if (!items.length) ignoredBefore = true;
      continue;
    }
    const q = /^ {0,3}>/.exec(line);
    if (q) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^ {0,3}> ?/, '').trimEnd());
        i++;
      }
      i--;
      cur.notes.push(quote.join('\n'));
      continue;
    }
    const kv = /^\s*(aceitas|exige|tags)\s*:(.*)$/i.exec(line);
    if (kv) {
      const key = kv[1]!.toLowerCase();
      const v = kv[2]!.trim();
      if (key === 'aceitas' && v) cur.accepted.push(v);
      else if (key === 'exige' && v) cur.requires.push(v);
      else if (key === 'tags') for (const tag of v.split(/\s+/).filter(Boolean)) add(cur.tags, tag);
      continue;
    }
    const t = line.trim();
    add(cur.warnings, `Linha ${i + 1} ignorada: ${t.length > 40 ? `${[...t].slice(0, 40).join('')}…` : t}`);
  }
  if (cur) items.push(cur);
  if (items.length > 500) {
    preview.errors.push('O texto tem mais de 500 perguntas; divida a importação em partes menores.');
    return preview;
  }
  if (ignoredBefore) preview.warnings.push('O texto antes do primeiro ### foi ignorado.');
  if (!items.length && raw.trim()) {
    preview.warnings.push('Nenhuma pergunta encontrada: cada pergunta começa com uma linha ### .');
  }

  function pushFence(b: Builder, f: Fence) {
    if (f.unclosed) add(b.errors, `Bloco de código sem fechamento (linha ${f.line}): feche-o com \`\`\`.`);
    const lang = (f.info.split(/\s+/)[0] ?? '').toLowerCase();
    if (!b.answer) {
      if (COMMAND_LANGS.includes(lang)) [b.kind, b.language] = ['command', lang];
      else if (lang === 'python' || lang === 'py') [b.kind, b.language] = ['program', 'python'];
      else if (lang === 'cpp' || lang === 'c++') [b.kind, b.language] = ['program', 'cpp'];
      else if (lang === '')
        add(b.errors, 'Linguagem do bloco desconhecida: (sem linguagem). Use bash, sh, ros2, python ou cpp.');
      else if (EXTRAS[lang]) add(b.errors, `O primeiro bloco é a resposta, mas é um bloco \`\`\`${lang}.`);
      else add(b.errors, `Linguagem do bloco desconhecida: ${lang}. Use bash, sh, ros2, python ou cpp.`);
      b.answer = { lang, content: f.content };
      return;
    }
    if (!EXTRAS[lang]) {
      add(
        b.errors,
        `Bloco desconhecido depois da resposta: ${lang || '(sem nome)'}. Use tests, input, output, setup ou start.`,
      );
      return;
    }
    if (b.extras.some(([e]) => e === lang)) {
      add(b.errors, `O bloco \`\`\`${lang} aparece mais de uma vez.`);
      return;
    }
    b.extras.push([lang, f.content]);
  }

  preview.items = items.map((b, index): ImportItem => {
    const fields: Record<string, string> = {};
    if (!b.title.trim()) add(b.errors, 'A pergunta (o texto depois do ###) está vazia.');
    fields['Pergunta'] = b.title.trim();
    if (!b.answer) add(b.errors, 'Falta o bloco de código com a resposta (```bash, ```python…).');
    else {
      if (!b.answer.content.trim()) add(b.errors, 'A resposta está vazia.');
      fields['Resposta'] = b.answer.content;
    }
    let mode: ProgramMode | null = null;
    const has = (e: string) => b.extras.some(([x]) => x === e);
    if (b.kind === 'command') {
      if (b.extras.length)
        add(b.errors, `Blocos ${b.extras.map(([e]) => e).join(', ')} só valem para Python e C++, não para comandos.`);
      if (b.accepted.length) fields['Aceitas'] = b.accepted.join('\n');
      if (b.requires.length) fields['Exige'] = b.requires.join('\n');
    } else if (b.kind === 'program') {
      if (has('tests') && has('output')) add(b.errors, 'Use ```tests ou ```output, não os dois no mesmo item.');
      if (has('input') && !has('output')) add(b.errors, 'O bloco ```input precisa de um bloco ```output.');
      if (b.accepted.length || b.requires.length)
        add(b.warnings, 'aceitas: e exige: valem só para comandos e foram ignoradas.');
      mode = has('tests') ? 'testes' : has('output') ? 'saida' : 'estrutura';
      if (b.language) fields['Linguagem'] = b.language;
      fields['Modo'] = mode;
      for (const [e, content] of b.extras) fields[EXTRAS[e]!] = content;
    }
    const notes = b.notes.join('\n').replace(/^\n+|\n+$/g, '');
    if (notes.trim()) fields['Observação'] = notes;
    return {
      index,
      line: b.line,
      title: b.title.trim(),
      kind: b.kind,
      language: b.language,
      mode,
      fields,
      tags: b.tags,
      errors: b.errors,
      warnings: b.warnings,
    };
  });
  return preview;
}

function importNotetypeName(kind: 'command' | 'program'): string {
  return kind === 'command' ? CODE_COMMAND : CODE_PROGRAM;
}

/** The collection's checks (core `check_import_items`): a missing app type, a field the type lacks. */
function checkImportItems(preview: ImportPreview): void {
  const notetypes = ankiState().notetypes;
  for (const item of preview.items) {
    if (!item.kind) continue;
    const name = importNotetypeName(item.kind);
    const nt = notetypes.find((n) => n.name === name);
    if (!nt) {
      item.errors.push('Prepare a coleção primeiro (Anki → Preparar coleção).');
      continue;
    }
    for (const field of Object.keys(item.fields)) {
      if (!nt.fields.includes(field)) item.errors.push(`O tipo de nota "${name}" não tem o campo "${field}".`);
    }
  }
}

function proseToHtml(text: string): string {
  return fixtureCodeToHtml(text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, ''));
}

// ---------------------------------------------------------------- settings

export const DEFAULT_MOCK_CODE_SETTINGS: CodeSettings = {
  suggestEasy: false,
  suggestEasySecs: 10,
  outputExact: false,
  cppBackend: 'auto',
  runnerUrl: null,
  runnerTokenSet: false,
};

function settings(): CodeSettings {
  const s = ankiState();
  s.codeSettings ??= { ...DEFAULT_MOCK_CODE_SETTINGS };
  return s.codeSettings;
}

function normalizeRunnerUrl(raw: string): string {
  const v = raw.trim();
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new CoreError('invalid_input', 'Endereço do runner inválido (use https://…).');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CoreError('invalid_input', 'Endereço do runner inválido (use https://…).');
  }
  const local = url.hostname === 'localhost' || !url.hostname.includes('.') || /^127\.|^\[?::1\]?$/.test(url.hostname);
  if (url.protocol === 'http:' && !local) {
    throw new CoreError('invalid_input', 'Use https:// para um runner fora desta rede local.');
  }
  return `${url.origin}${url.pathname.replace(/\/*$/, '/')}`;
}

// ---------------------------------------------------------------- mappings

function mappingList(): CodeMapping[] {
  const s = ankiState();
  return (s.codeMappings ?? []).flatMap((m): CodeMapping[] => {
    const nt = s.notetypes.find((n) => n.id === m.notetypeId);
    if (!nt) return [];
    const missingFields = [m.fields.question, m.fields.answer, m.fields.notes].filter(
      (f): f is string => !!f && !nt.fields.includes(f),
    );
    return [
      {
        notetypeId: m.notetypeId,
        notetypeName: nt.name,
        role: 'code_command',
        fields: { ...m.fields },
        noteCount: s.notes.filter((n) => n.notetypeId === nt.id).length,
        missingFields,
        updatedAt: m.updatedAt,
      },
    ];
  });
}

function nextUpdatedAt(previous: number | undefined): number {
  const now = Date.now();
  return previous !== undefined && previous >= now ? previous + 1 : now;
}

function noteAndType(noteId: number): { note: MockNote; nt: MockNotetype } {
  const s = ankiState();
  const note = s.notes.find((n) => n.id === noteId);
  const nt = note && s.notetypes.find((x) => x.id === note.notetypeId);
  if (!note || !nt) throw new CoreError('anki_not_found', 'Não encontrado: nota.');
  return { note, nt };
}

/** `code_note_extra` rules of core-store: trimmed, empty and duplicate entries dropped, ≤ 50 × 2000 chars. */
function normalizeList(label: string, list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length > 50) throw new CoreError('invalid_input', `${label}: no máximo 50 entradas.`);
  if (out.some((v) => [...v].length > 2000)) {
    throw new CoreError('invalid_input', `${label}: cada entrada tem no máximo 2000 caracteres.`);
  }
  return out;
}

function extraOf(noteId: number) {
  return ankiState().codeExtras?.[String(noteId)] ?? { accepted: [], requires: [] };
}

function setExtra(noteId: number, accepted: string[], requires: string[]) {
  const a = normalizeList('Aceitas', accepted);
  const r = normalizeList('Exige', requires);
  const s = ankiState();
  s.codeExtras ??= {};
  if (a.length === 0 && r.length === 0) delete s.codeExtras[String(noteId)];
  else s.codeExtras[String(noteId)] = { accepted: a, requires: r };
  persistAnki();
  return { noteId, accepted: a, requires: r };
}

// ---------------------------------------------------------------- commands

export const codeMock: Pick<CoreClient, CodeMockKeys> = {
  codeMappingList: () => later(mappingList),

  codeMappingSet: (notetypeId, fields) =>
    later(() => {
      const s = ankiState();
      const list = (s.codeMappings ??= []);
      const prev = list.find((m) => m.notetypeId === notetypeId);
      if (fields === null) {
        s.codeMappings = list.filter((m) => m.notetypeId !== notetypeId);
      } else {
        const nt = s.notetypes.find((n) => n.id === notetypeId);
        if (!nt) throw new CoreError('not_found', 'Tipo de nota não encontrado.');
        if ((APP_NOTETYPE_NAMES as readonly string[]).includes(nt.name)) {
          throw new CoreError(
            'code_mapping_app_type',
            `"${nt.name}" é um tipo de nota do app; escolha um tipo de nota seu.`,
          );
        }
        if (nt.kind === 'cloze') {
          throw new CoreError(
            'code_mapping_cloze',
            'Um tipo de nota de omissão de palavras (cloze) não pode ter o papel Comando.',
          );
        }
        const question = fields.question.trim();
        const answer = fields.answer.trim();
        const notes = fields.notes?.trim() || null;
        for (const [label, name] of [
          ['Pergunta', question],
          ['Resposta', answer],
          ['Observação', notes],
        ] as const) {
          if (name === null) continue;
          if (!name) throw new CoreError('invalid_input', `Escolha o campo da ${label}.`);
          if (!nt.fields.includes(name)) {
            throw new CoreError('invalid_input', `O tipo de nota "${nt.name}" não tem o campo "${name}".`);
          }
        }
        if (question === answer || (notes !== null && (notes === question || notes === answer))) {
          throw new CoreError('invalid_input', 'A Pergunta, a Resposta e a Observação precisam ser campos diferentes.');
        }
        const row = { notetypeId, fields: { question, answer, notes }, updatedAt: nextUpdatedAt(prev?.updatedAt) };
        s.codeMappings = [...list.filter((m) => m.notetypeId !== notetypeId), row];
      }
      logAnki('codeMappingSet', { notetypeId, fields });
      persistAnki();
      return mappingList();
    }),

  codeNoteExtraGet: (noteId) =>
    later(() => {
      const e = extraOf(noteId);
      return { noteId, accepted: [...e.accepted], requires: [...e.requires] };
    }),

  codeNoteExtraSet: (noteId, accepted, requires) => later(() => setExtra(noteId, accepted, requires)),

  codeAcceptAnswer: (noteId, raw) =>
    later(() => {
      const answer = raw.trim();
      if (!answer) throw new CoreError('invalid_input', 'A resposta está vazia.');
      if ([...answer].length > 2000) throw new CoreError('invalid_input', 'A resposta passa de 2000 caracteres.');
      const { note, nt } = noteAndType(noteId);
      const code = mockCodeType(nt);
      if (!code) throw new CoreError('code_not_code_note', 'Esta nota não é de um card de código.');
      const value = (name: string) => note.fields[nt.fields.indexOf(name)] ?? '';
      const reference = mockHtmlToCode(value(code.answer));
      const extra = extraOf(noteId);
      const acceptedIdx = nt.fields.indexOf('Aceitas');
      const fieldAccepted = acceptedIdx >= 0 ? fieldLines(value('Aceitas')) : [];
      const wanted = squash(answer);
      const merged = (field: string[], ex: string[]) => [...field, ...ex.filter((a) => !field.includes(a))];
      if (squash(reference) === wanted || [...fieldAccepted, ...extra.accepted].some((a) => squash(a) === wanted)) {
        return { target: 'already' as const, accepted: merged(fieldAccepted, extra.accepted) };
      }
      if (acceptedIdx >= 0) {
        const text = mockHtmlToCode(value('Aceitas')).replace(/[\n \t]+$/, '');
        const next = text.trim() ? `${text}\n${answer}` : answer;
        note.fields[acceptedIdx] = fixtureCodeToHtml(next);
        note.mtime = Date.now();
        logAnki('codeAcceptAnswer', { noteId, answer, target: 'field' });
        persistAnki();
        return {
          target: 'field' as const,
          accepted: merged(
            next
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean),
            extra.accepted,
          ),
        };
      }
      const row = setExtra(noteId, [...extra.accepted, answer], extra.requires);
      logAnki('codeAcceptAnswer', { noteId, answer, target: 'extra' });
      return { target: 'extra' as const, accepted: row.accepted };
    }),

  codeRunCpp: (files, stdin) => runCpp(files, stdin),

  codeFormatCpp: (code) =>
    later(() => ({ formatted: code, formatter: cpp.clangFormat ? ('clang-format' as const) : null })),

  codeStatus: () =>
    later(() => {
      const st = settings();
      const remoteOk = !!st.runnerUrl && st.runnerTokenSet;
      return {
        cpp: {
          local: { compiler: cpp.available ? MOCK_COMPILER : null, clangFormat: cpp.clangFormat },
          remote: { url: st.runnerUrl, tokenSet: st.runnerTokenSet },
        },
        cppBackend:
          st.cppBackend === 'remote'
            ? remoteOk
              ? ('remote' as const)
              : ('none' as const)
            : cpp.available
              ? ('local' as const)
              : st.cppBackend === 'auto' && remoteOk
                ? ('remote' as const)
                : ('none' as const),
      };
    }),

  codeSettingsGet: () => later(() => ({ ...settings() })),

  codeSettingsSet: (patch) =>
    later(() => {
      const st = settings();
      const next = { ...st };
      if (patch.suggestEasy !== undefined) next.suggestEasy = !!patch.suggestEasy;
      if (patch.suggestEasySecs !== undefined) {
        const v = patch.suggestEasySecs;
        if (!Number.isInteger(v) || v < 1 || v > 600) {
          throw new CoreError('invalid_input', 'O limite de tempo deve ficar entre 1 e 600 segundos.');
        }
        next.suggestEasySecs = v;
      }
      if (patch.outputExact !== undefined) next.outputExact = !!patch.outputExact;
      if (patch.cppBackend !== undefined) {
        if (!['auto', 'local', 'remote'].includes(patch.cppBackend)) {
          throw new CoreError('invalid_input', 'Opção de C++ inválida.');
        }
        next.cppBackend = patch.cppBackend;
      }
      if (patch.runnerUrl !== undefined) {
        next.runnerUrl =
          patch.runnerUrl === null || patch.runnerUrl.trim() === '' ? null : normalizeRunnerUrl(patch.runnerUrl);
        // The token belongs to the runner address.
        if (next.runnerUrl !== st.runnerUrl) next.runnerTokenSet = false;
      }
      if (patch.runnerToken !== undefined) {
        if (patch.runnerToken !== null && patch.runnerToken.trim() !== '' && !next.runnerUrl) {
          throw new CoreError('invalid_input', 'Informe o endereço do runner antes do token.');
        }
        next.runnerTokenSet = patch.runnerToken !== null && patch.runnerToken.trim() !== '';
      }
      ankiState().codeSettings = next;
      persistAnki();
      return { ...next };
    }),

  codeRunnerTest: () =>
    later(() => {
      const st = settings();
      if (!st.runnerUrl) return { ok: false, message: 'Nenhum runner configurado.' };
      if (!st.runnerTokenSet) return { ok: false, message: 'O runner recusou o token (configure o token).' };
      return { ok: true, message: `O runner respondeu e compilou um programa de teste (${MOCK_COMPILER}).` };
    }),

  codeImportMarkdown: (text) =>
    later(() => {
      const preview = mockParseMarkdown(text);
      checkImportItems(preview);
      return preview;
    }),

  codeImportCommit: async (text, deckId, include) => {
    const preview = await later(() => mockParseMarkdown(text));
    if (preview.errors[0]) throw new CoreError('invalid_input', preview.errors[0]);
    if (!deckById(deckId)) throw new CoreError('anki_not_found', 'Não encontrado: baralho.');
    const notetypes = ankiState().notetypes;
    let skipped = 0;
    const included: number[] = [];
    for (const i of [...new Set(include)]) {
      if (Number.isInteger(i) && i >= 0 && i < preview.items.length) included.push(i);
      else skipped++;
    }
    const missing = included.some((i) => {
      const k = preview.items[i]!.kind;
      return k !== null && !notetypes.some((n) => n.name === importNotetypeName(k));
    });
    if (missing) {
      throw new CoreError(
        'code_notetypes_missing',
        'Os tipos de nota de código não existem nesta coleção: use Anki → Preparar coleção primeiro.',
      );
    }
    checkImportItems(preview);
    const noteIds: number[] = [];
    for (const i of included) {
      const item = preview.items[i]!;
      const nt = item.kind ? notetypes.find((n) => n.name === importNotetypeName(item.kind!)) : undefined;
      if (!item.kind || item.errors.length || !nt) {
        skipped++;
        continue;
      }
      const fields = nt.fields.map((f) => {
        const v = item.fields[f];
        if (v === undefined) return '';
        return f === 'Pergunta' || f === 'Observação' ? proseToHtml(v) : fixtureCodeToHtml(v);
      });
      const added = await ankiNotesMock.ankiNoteAdd({ notetypeId: nt.id, deckId, fields, tags: item.tags });
      noteIds.push(added.noteId);
    }
    if (noteIds.length) emitAnkiChanged({ reason: 'import' });
    return { added: noteIds.length, noteIds, skipped };
  },
};

/** Back to the defaults (mockHandle.reset). */
export function resetCodeMock(): void {
  cpp.clangFormat = false;
}
