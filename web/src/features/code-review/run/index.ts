// Check orchestration of the code review (spec 11.2–11.5): one entry point for every kind of code card.
// - Comando → the command checker of packages/checkers (offline, in the webview);
// - Programa · Python → Pyodide in a worker (./python.ts), 5 s limit;
// - Programa · C++ → the core (`code_run_cpp`: the local compiler on desktop, else the runner); without a compiler
//   it falls back to `estrutura`.
// Also used by "Testar resposta de referência" (spec 11.7, features/code-import and the editor).
import {
  checkCommand,
  compareOutput,
  parseCheckLines as parseCheckOutput,
  sameCppStructure,
  type CheckResult,
  type DiffOp,
  type Verdict,
} from '@leitor/checkers';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { CoreError, type CodeCard, type CodeNoteExtra, type CppRunResult } from '../../../lib/core/types';
import { htmlToCode } from '../../anki/editor/codeField';
import type { PythonTest } from '../../../workers/pythonProtocol';
import { DEFAULT_PYTHON_TIMEOUT_MS, pythonManager } from './python';

export type { DiffOp, Verdict } from '@leitor/checkers';

export type CodeMode = 'testes' | 'saida' | 'estrutura';
export type CodeLanguageName = 'python' | 'cpp';

export interface CodeReference {
  role: 'command' | 'program';
  answer: string;
  accepted: string[];
  requires: string[];
  language: CodeLanguageName | null;
  mode: CodeMode;
  setup: string;
  tests: string;
  input: string;
  expectedOutput: string;
}

export interface CodeTestRow {
  name: string;
  ok: boolean;
  message: string;
}

export interface CodeOutcome {
  verdict: Verdict;
  notice: string | null;
  command: CheckResult | null;
  tests: CodeTestRow[] | null;
  output: { expected: string; got: string; diff: DiffOp[] } | null;
  structure: { expected: string; got: string } | null;
  compile: { ok: boolean; stderr: string } | null;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  modeUsed: 'command' | 'testes' | 'saida' | 'estrutura';
}

/** One entry per non-empty line. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** `python`/`py` and `cpp`/`c++`; anything else is unknown (`null`). */
export function languageOf(raw: string): CodeLanguageName | null {
  const v = raw.trim().toLowerCase();
  if (v === 'python' || v === 'py' || v === 'python3') return 'python';
  if (v === 'cpp' || v === 'c++' || v === 'cxx') return 'cpp';
  return null;
}

function modeOf(raw: string): CodeMode | null {
  const v = raw.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (v === 'testes' || v === 'saida' || v === 'estrutura') return v;
  return null;
}

/**
 * The reference of a code card: every field decoded with `htmlToCode` (spec 11.1); Aceitas/Exige are one per line,
 * plus the note's `code_note_extra` lists.
 */
export function referenceFromCard(code: CodeCard, extra: CodeNoteExtra | null): CodeReference {
  const f = code.fields;
  const mode = modeOf(htmlToCode(f.mode));
  return {
    role: code.role,
    answer: htmlToCode(f.answer),
    accepted: unique([...lines(htmlToCode(f.accepted)), ...(extra?.accepted ?? []).map((a) => a.trim())]).filter(
      (a) => a !== '',
    ),
    requires: unique([...lines(htmlToCode(f.requires)), ...(extra?.requires ?? []).map((a) => a.trim())]).filter(
      (a) => a !== '',
    ),
    language: code.role === 'program' ? languageOf(htmlToCode(f.language)) : null,
    // An empty Modo is `estrutura` (spec 11.7: no tests/output → structure); an unknown one is kept unknown.
    mode: mode ?? (htmlToCode(f.mode).trim() === '' ? 'estrutura' : (htmlToCode(f.mode).trim() as CodeMode)),
    setup: htmlToCode(f.setup),
    tests: htmlToCode(f.tests),
    input: htmlToCode(f.input),
    expectedOutput: htmlToCode(f.expectedOutput),
  };
}

function base(modeUsed: CodeOutcome['modeUsed']): CodeOutcome {
  return {
    verdict: 'unverifiable',
    notice: null,
    command: null,
    tests: null,
    output: null,
    structure: null,
    compile: null,
    stderr: '',
    timedOut: false,
    durationMs: 0,
    modeUsed,
  };
}

function abortError(): Error {
  return new DOMException(t('codeReview.cancelled'), 'AbortError');
}

/** The run was cancelled ("Cancelar" during a Python run). */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------- command

function runCommand(ref: CodeReference, answer: string): CodeOutcome {
  const started = performance.now();
  const result = checkCommand({
    expected: ref.answer,
    accepted: ref.accepted,
    requires: ref.requires,
    answer,
  });
  return {
    ...base('command'),
    verdict: result.verdict,
    command: result,
    durationMs: Math.round(performance.now() - started),
  };
}

// ---------------------------------------------------------------- python

function pythonTests(rows: PythonTest[]): CodeTestRow[] {
  return rows.map((r) => {
    const parts: string[] = [];
    if (r.line !== null && !r.ok) parts.push(t('codeReview.tests.line', { linha: r.line }));
    if (r.got !== null && r.expected !== null)
      parts.push(t('codeReview.tests.gotExpected', { obtido: r.got, esperado: r.expected }));
    if (r.error) parts.push(r.error);
    return { name: r.name, ok: r.ok, message: parts.join(' · ') };
  });
}

function structureOutcome(out: CodeOutcome, same: boolean, expected: string, got: string): CodeOutcome {
  return {
    ...out,
    modeUsed: 'estrutura',
    verdict: same ? 'equivalent' : 'unverifiable',
    structure: { expected, got },
    notice: out.notice ?? (same ? null : t('codeReview.notice.structureDiffers')),
  };
}

async function runPython(ref: CodeReference, answer: string, opts: RunOptions): Promise<CodeOutcome> {
  const mode = ref.mode;
  const outcome = await pythonManager().run(
    {
      mode,
      code: answer,
      setup: ref.setup,
      tests: ref.tests,
      stdin: ref.input,
      expected: ref.answer,
    },
    opts.signal,
  );
  const out = base(mode);
  switch (outcome.kind) {
    case 'cancelled':
      throw abortError();
    case 'timeout':
      return {
        ...out,
        verdict: 'wrong',
        timedOut: true,
        durationMs: outcome.durationMs,
        notice: t('codeReview.notice.timeout', { s: Math.round(DEFAULT_PYTHON_TIMEOUT_MS / 1000) }),
      };
    case 'loadError':
      return { ...out, notice: t('codeReview.notice.pythonLoad', { erro: outcome.message }) };
    case 'runError':
      return { ...out, notice: t('codeReview.notice.runError', { erro: outcome.message }) };
    case 'result':
      break;
  }
  const r = outcome.result;
  const res: CodeOutcome = { ...out, durationMs: outcome.durationMs, stderr: r.error ?? r.stderr };
  if (r.truncated) res.notice = t('codeReview.notice.truncated');
  if (r.fallback === 'estrutura' && r.structure) {
    return structureOutcome(
      { ...res, notice: t('codeReview.notice.importFallback', { erro: r.importError ?? '' }) },
      r.structure.same,
      r.structure.expected,
      r.structure.got,
    );
  }
  if (mode === 'estrutura') {
    const s = r.structure;
    if (!s) return res;
    return {
      ...structureOutcome(res, s.same, s.expected, s.got),
      notice: s.same ? t('codeReview.notice.structureSame') : t('codeReview.notice.structureDiffers'),
    };
  }
  if (mode === 'saida') {
    const cmp = compareOutput(ref.expectedOutput, r.stdout, { exact: opts.outputExact });
    return {
      ...res,
      verdict: r.error === null ? cmp.verdict : 'wrong',
      output: { expected: ref.expectedOutput, got: r.stdout, diff: cmp.diff },
    };
  }
  // testes
  const tests = r.tests ? pythonTests(r.tests) : null;
  if (r.error !== null) return { ...res, verdict: 'wrong', tests };
  if (!tests || tests.length === 0) {
    return { ...res, tests, verdict: 'unverifiable', notice: t('codeReview.notice.noTests') };
  }
  return { ...res, tests, verdict: tests.every((x) => x.ok) ? 'correct' : 'wrong' };
}

// ---------------------------------------------------------------- C++

/** `main.cpp` of mode `testes` (spec 11.5): check.hpp, then the Setup, the answer and the Tests with their own names. */
export function cppTestFiles(ref: CodeReference, answer: string): Record<string, string> {
  return {
    'main.cpp':
      '#include "check.hpp"\n#line 1 "setup.cpp"\n' +
      ref.setup +
      '\n#line 1 "resposta.cpp"\n' +
      answer +
      '\n#line 1 "testes.cpp"\n' +
      ref.tests,
  };
}

/**
 * `saida` mode: the Setup and the answer in one translation unit. Setup fields are saved without a
 * trailing newline (editor and Markdown import), so they are joined by a line break — a `#line`
 * directive, which also makes compiler errors point at the answer's own line numbers.
 */
export function cppOutputFiles(ref: CodeReference, answer: string): Record<string, string> {
  if (!ref.setup.trim()) return { 'main.cpp': answer };
  return { 'main.cpp': '#line 1 "setup.cpp"\n' + ref.setup + '\n#line 1 "resposta.cpp"\n' + answer };
}

/** The PASS/FAIL lines printed by check.hpp, as test rows (`FAIL expr (file:line)` → message `file:line`). */
export function cppTestRows(stdout: string): CodeTestRow[] {
  return parseCheckOutput(stdout).lines.map((l) => {
    const loc = l.ok ? null : /^(.*) \(([^()]*):(\d+)\)$/.exec(l.text);
    return loc ? { name: loc[1]!, ok: false, message: `${loc[2]}:${loc[3]}` } : { name: l.text, ok: l.ok, message: '' };
  });
}

function runNotice(run: NonNullable<CppRunResult['run']>): string | null {
  if (run.timedOut) return t('codeReview.notice.timeout', { s: Math.round(run.timeMs / 1000) || 10 });
  if (run.signal) return t('codeReview.notice.killed', { sinal: run.signal });
  if (run.truncated) return t('codeReview.notice.truncated');
  return null;
}

async function cppStructure(ref: CodeReference, answer: string, notice: string | null): Promise<CodeOutcome> {
  const out = { ...base('estrutura'), notice };
  if (sameCppStructure(ref.answer, answer)) {
    return { ...out, verdict: 'equivalent', structure: { expected: ref.answer, got: answer } };
  }
  // Side by side, both formatted the same way (clang-format when installed).
  const [a, b] = await Promise.all([
    core.codeFormatCpp(ref.answer).then(
      (r) => r.formatted,
      () => ref.answer,
    ),
    core.codeFormatCpp(answer).then(
      (r) => r.formatted,
      () => answer,
    ),
  ]);
  return {
    ...out,
    verdict: 'unverifiable',
    structure: { expected: a, got: b },
    notice: notice ?? t('codeReview.notice.structureDiffers'),
  };
}

async function runCpp(ref: CodeReference, answer: string, opts: RunOptions): Promise<CodeOutcome> {
  if (ref.mode === 'estrutura') return cppStructure(ref, answer, null);
  const files = ref.mode === 'testes' ? cppTestFiles(ref, answer) : cppOutputFiles(ref, answer);
  let result: CppRunResult;
  try {
    result = await core.codeRunCpp(files, ref.mode === 'saida' ? ref.input : '');
  } catch (e) {
    if (e instanceof CoreError && e.code === 'code_cpp_unavailable') {
      return cppStructure(ref, answer, t('codeReview.notice.cppUnavailable'));
    }
    return { ...base(ref.mode), notice: t('codeReview.notice.cppFailed', { erro: errorText(e) }) };
  }
  if (opts.signal?.aborted) throw abortError();
  const out: CodeOutcome = {
    ...base(ref.mode),
    compile: { ok: result.compile.ok, stderr: result.compile.stderr },
    durationMs: result.compile.timeMs + (result.run?.timeMs ?? 0),
  };
  const run = result.run;
  if (!result.compile.ok || !run) return { ...out, verdict: 'wrong', notice: t('codeReview.compile.failed') };
  out.stderr = run.stderr;
  out.timedOut = run.timedOut;
  out.notice = runNotice(run);
  if (ref.mode === 'testes') {
    const tests = cppTestRows(run.stdout);
    const passed = tests.filter((x) => x.ok).length;
    const failed = tests.length - passed;
    const ok = passed >= 1 && failed === 0 && run.exitCode === 0 && !run.timedOut;
    if (!ok && !out.notice && run.exitCode !== 0 && failed === 0 && run.exitCode !== null) {
      out.notice = t('codeReview.notice.exitCode', { codigo: run.exitCode });
    }
    return { ...out, tests, verdict: ok ? 'correct' : 'wrong' };
  }
  const cmp = compareOutput(ref.expectedOutput, run.stdout, { exact: opts.outputExact });
  return {
    ...out,
    verdict: run.timedOut ? 'wrong' : cmp.verdict,
    output: { expected: ref.expectedOutput, got: run.stdout, diff: cmp.diff },
  };
}

// ---------------------------------------------------------------- entry point

export interface RunOptions {
  /** Mode `saida`: compare the output exactly (setting `code_output_exact`). */
  outputExact: boolean;
  /** Cancels a Python run (the worker is terminated and recreated). */
  signal?: AbortSignal;
}

/** Checks `answer` against the card's reference. Rejects with an AbortError when cancelled. */
export async function runCodeCheck(ref: CodeReference, answer: string, opts: RunOptions): Promise<CodeOutcome> {
  if (opts.signal?.aborted) throw abortError();
  if (ref.role === 'command') return runCommand(ref, answer);
  if (ref.language === null) {
    return { ...base(ref.mode), notice: t('codeReview.notice.unknownLanguage') };
  }
  if (!['testes', 'saida', 'estrutura'].includes(ref.mode)) {
    return { ...base('estrutura'), notice: t('codeReview.notice.unknownMode', { modo: ref.mode }) };
  }
  return ref.language === 'python' ? runPython(ref, answer, opts) : runCpp(ref, answer, opts);
}
