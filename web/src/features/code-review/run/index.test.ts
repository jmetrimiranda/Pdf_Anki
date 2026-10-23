import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { core } from '../../../lib/core/client';
import { mockHandle } from '../../../lib/core/mock';
import { CoreError, type CodeCard, type CppRunResult } from '../../../lib/core/types';
import type { MainToPython, PythonRunResult, PythonToMain } from '../../../workers/pythonProtocol';
import { codeToHtml } from '../../anki/editor/codeField';
import { cppTestFiles, cppTestRows, isAbort, referenceFromCard, runCodeCheck, type CodeReference } from './index';
import { PythonManager, setPythonManager, type WorkerLike } from './python';

const OPTS = { outputExact: false };

function card(over: Partial<CodeCard['fields']> & { role?: CodeCard['role'] }): CodeCard {
  const { role = 'program', ...fields } = over;
  return {
    role,
    notetypeId: 1,
    appType: true,
    acceptedField: true,
    answerShowsNotes: true,
    answerShowsAnswer: true,
    fields: {
      answer: '',
      accepted: '',
      requires: '',
      notes: '',
      language: '',
      mode: '',
      initial: '',
      setup: '',
      tests: '',
      input: '',
      expectedOutput: '',
      ...fields,
    },
  };
}

function ref(over: Partial<CodeReference>): CodeReference {
  return {
    role: 'program',
    answer: '',
    accepted: [],
    requires: [],
    language: 'cpp',
    mode: 'testes',
    setup: '',
    tests: '',
    input: '',
    expectedOutput: '',
    ...over,
  };
}

beforeEach(() => mockHandle.reset());
afterEach(() => {
  vi.restoreAllMocks();
  setPythonManager(null);
});

describe('referenceFromCard', () => {
  it('decodes every field and merges Aceitas/Exige with the note extra', () => {
    const r = referenceFromCard(
      card({
        role: 'command',
        answer: codeToHtml('ros2 topic echo /chatter | grep "a<b"'),
        accepted: 'ros2 topic echo /chatter<br><br>  ros2 topic echo chatter  ',
        requires: 'sudo',
      }),
      { noteId: 1, accepted: ['ros2 topic echo /chatter', 'echo x'], requires: ['-y'] },
    );
    expect(r.answer).toBe('ros2 topic echo /chatter | grep "a<b"');
    expect(r.accepted).toEqual(['ros2 topic echo /chatter', 'ros2 topic echo chatter', 'echo x']);
    expect(r.requires).toEqual(['sudo', '-y']);
    expect(r.language).toBeNull();
  });

  it('reads the Programa fields; an empty Modo is estrutura', () => {
    const r = referenceFromCard(
      card({ language: 'Python', mode: '', answer: 'def f():<br>&nbsp; &nbsp; return 1', tests: 'assert f() == 1' }),
      null,
    );
    expect(r).toMatchObject({ language: 'python', mode: 'estrutura', answer: 'def f():\n    return 1' });
    expect(referenceFromCard(card({ language: 'c++', mode: 'saída' }), null)).toMatchObject({
      language: 'cpp',
      mode: 'saida',
    });
    expect(referenceFromCard(card({ language: 'rust', mode: 'testes' }), null).language).toBeNull();
  });
});

describe('runCodeCheck · command', () => {
  const r = ref({ role: 'command', language: null, answer: 'ros2 run tf2_ros tf2_echo world turtle1' });

  it('uses the command checker', async () => {
    expect((await runCodeCheck(r, 'ros2 run tf2_ros tf2_echo world turtle1', OPTS)).verdict).toBe('correct');
    const typo = await runCodeCheck(r, 'ros2 run tf2_ros tf2_eco world turtle1', OPTS);
    expect(typo).toMatchObject({ verdict: 'almost', modeUsed: 'command' });
    expect(typo.command?.diffs.some((d) => d.kind === 'typo')).toBe(true);
    expect((await runCodeCheck(r, 'ros2 run tf2_ros tf2_echo turtle1 world', OPTS)).verdict).toBe('wrong');
  });

  it('accepts the Aceitas', async () => {
    const out = await runCodeCheck(
      { ...r, accepted: ['ros2 run tf2_ros tf2_monitor'] },
      'ros2 run tf2_ros tf2_monitor',
      OPTS,
    );
    expect(out.verdict).toBe('correct');
    expect(out.command?.matchedVariant).toBe(1);
  });
});

function cppResult(over: Partial<CppRunResult['run']> & { compileOk?: boolean; stderr?: string } = {}): CppRunResult {
  const { compileOk = true, stderr = '', ...run } = over;
  return {
    backend: 'local',
    compiler: 'g++',
    compile: { ok: compileOk, stderr, timeMs: 100 },
    run: compileOk
      ? { exitCode: 0, signal: null, stdout: '', stderr: '', timeMs: 2, timedOut: false, truncated: false, ...run }
      : null,
  };
}

describe('runCodeCheck · C++', () => {
  it('assembles main.cpp of mode testes with check.hpp and #line markers', () => {
    const files = cppTestFiles(
      ref({ setup: '#include <vector>', tests: 'int main() { CHECK(f() == 1); }' }),
      'int f() { return 1; }',
    );
    expect(files).toEqual({
      'main.cpp':
        '#include "check.hpp"\n#line 1 "setup.cpp"\n#include <vector>\n#line 1 "resposta.cpp"\nint f() { return 1; }\n#line 1 "testes.cpp"\nint main() { CHECK(f() == 1); }',
    });
  });

  it('parses PASS/FAIL lines', () => {
    expect(cppTestRows('PASS f() == 1\nlixo\nFAIL g() == 2 (testes.cpp:3)\n')).toEqual([
      { name: 'f() == 1', ok: true, message: '' },
      { name: 'g() == 2', ok: false, message: 'testes.cpp:3' },
    ]);
  });

  it('mode testes: correct iff it compiles, ≥1 PASS, 0 FAIL, exit 0, no timeout', async () => {
    const spy = vi.spyOn(core, 'codeRunCpp');
    const r = ref({ tests: 'int main() { CHECK(f() == 1); }' });
    spy.mockResolvedValueOnce(cppResult({ stdout: 'PASS f() == 1\n' }));
    expect((await runCodeCheck(r, 'int f() { return 1; }', OPTS)).verdict).toBe('correct');
    expect(spy).toHaveBeenCalledWith(cppTestFiles(r, 'int f() { return 1; }'), '');

    spy.mockResolvedValueOnce(cppResult({ stdout: 'PASS a\nFAIL b (testes.cpp:2)\n', exitCode: 1 }));
    const failed = await runCodeCheck(r, 'x', OPTS);
    expect(failed.verdict).toBe('wrong');
    expect(failed.tests).toHaveLength(2);

    spy.mockResolvedValueOnce(cppResult({ stdout: '' }));
    expect((await runCodeCheck(r, 'x', OPTS)).verdict).toBe('wrong');

    spy.mockResolvedValueOnce(cppResult({ stdout: 'PASS a\n', exitCode: 3 }));
    const exit = await runCodeCheck(r, 'x', OPTS);
    expect(exit.verdict).toBe('wrong');
    expect(exit.notice).toContain('código 3');

    spy.mockResolvedValueOnce(
      cppResult({ stdout: 'PASS a\n', exitCode: null, signal: 'SIGKILL', timedOut: true, timeMs: 10_000 }),
    );
    const slow = await runCodeCheck(r, 'x', OPTS);
    expect(slow).toMatchObject({ verdict: 'wrong', timedOut: true });
    expect(slow.notice).toBe('Tempo esgotado (10 s)');

    spy.mockResolvedValueOnce(cppResult({ compileOk: false, stderr: "main.cpp:1: error: expected ';'" }));
    const broken = await runCodeCheck(r, 'x', OPTS);
    expect(broken).toMatchObject({
      verdict: 'wrong',
      compile: { ok: false, stderr: "main.cpp:1: error: expected ';'" },
    });
  });

  it('mode saida: Setup + answer, the Entrada as stdin, the output compared', async () => {
    const spy = vi.spyOn(core, 'codeRunCpp').mockResolvedValue(cppResult({ stdout: '5  \n\n' }));
    const r = ref({ mode: 'saida', setup: '#include <cstdio>\n', input: '2 3\n', expectedOutput: '5\n' });
    const out = await runCodeCheck(r, 'int main() {}', OPTS);
    expect(spy).toHaveBeenCalledWith(
      { 'main.cpp': '#line 1 "setup.cpp"\n#include <cstdio>\n\n#line 1 "resposta.cpp"\nint main() {}' },
      '2 3\n',
    );
    expect(out.verdict).toBe('correct');
    expect((await runCodeCheck(r, 'int main() {}', { outputExact: true })).verdict).not.toBe('correct');
    spy.mockResolvedValue(cppResult({ stdout: '6\n' }));
    const wrong = await runCodeCheck(r, 'int main() {}', OPTS);
    expect(wrong.verdict).toBe('wrong');
    expect(wrong.output?.diff.some((d) => d.op !== 'equal')).toBe(true);
  });

  it('mode saida: a Setup without a trailing newline stays on its own line (no Setup → the answer alone)', async () => {
    const spy = vi.spyOn(core, 'codeRunCpp').mockResolvedValue(cppResult({ stdout: '5\n' }));
    const r = ref({ mode: 'saida', setup: '#include <iostream>', input: '', expectedOutput: '5\n' });
    await runCodeCheck(r, 'int main() { std::cout << 5; }', OPTS);
    const src = spy.mock.calls[0]![0]['main.cpp']!;
    expect(src.split('\n')).toContain('#include <iostream>');
    expect(src).not.toContain('<iostream>int');
    expect(src.endsWith('#line 1 "resposta.cpp"\nint main() { std::cout << 5; }')).toBe(true);
    await runCodeCheck(ref({ mode: 'saida', setup: '  \n', expectedOutput: '5\n' }), 'int main() {}', OPTS);
    expect(spy.mock.calls[1]![0]).toEqual({ 'main.cpp': 'int main() {}' });
  });

  it('mode estrutura: the same tokens → equivalent, else unverifiable side by side', async () => {
    const r = ref({ mode: 'estrutura', answer: 'int f(int x) { return x * x; }' });
    const same = await runCodeCheck(r, 'int f(int x)\n{\n  // quadrado\n  return x*x;\n}', OPTS);
    expect(same.verdict).toBe('equivalent');
    const fmt = vi.spyOn(core, 'codeFormatCpp');
    const other = await runCodeCheck(r, 'int f(int x) { return x + x; }', OPTS);
    expect(other).toMatchObject({ verdict: 'unverifiable', modeUsed: 'estrutura' });
    expect(other.structure?.got).toContain('x + x');
    expect(fmt).toHaveBeenCalledTimes(2);
  });

  it('without a compiler, falls back to estrutura with a notice', async () => {
    vi.spyOn(core, 'codeRunCpp').mockRejectedValue(new CoreError('code_cpp_unavailable', 'sem compilador'));
    const r = ref({ answer: 'int f() { return 1; }' });
    const out = await runCodeCheck(r, 'int f() {return 1;}', OPTS);
    expect(out).toMatchObject({ verdict: 'equivalent', modeUsed: 'estrutura' });
    expect(out.notice).toBe('Sem compilador de C++ neste computador: comparando a estrutura.');
  });

  it('other core errors are unverifiable', async () => {
    vi.spyOn(core, 'codeRunCpp').mockRejectedValue(new CoreError('code_runner_busy', 'O runner está ocupado.'));
    const out = await runCodeCheck(ref({}), 'x', OPTS);
    expect(out.verdict).toBe('unverifiable');
    expect(out.notice).toContain('O runner está ocupado.');
  });

  it('an unknown language or mode is unverifiable', async () => {
    expect((await runCodeCheck(ref({ language: null }), 'x', OPTS)).verdict).toBe('unverifiable');
    expect((await runCodeCheck(ref({ mode: 'foo' as never }), 'x', OPTS)).verdict).toBe('unverifiable');
  });
});

// ---------------------------------------------------------------- Python through a fake worker

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<PythonToMain>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor(private readonly answer: (m: Extract<MainToPython, { type: 'run' }>) => PythonRunResult | null) {}
  postMessage(m: MainToPython) {
    queueMicrotask(() => {
      if (m.type === 'preload') this.onmessage?.({ data: { type: 'ready' } } as MessageEvent<PythonToMain>);
      else {
        const result = this.answer(m);
        if (result) this.onmessage?.({ data: { type: 'result', id: m.id, result } } as MessageEvent<PythonToMain>);
      }
    });
  }
  terminate() {}
}

function pyResult(over: Partial<PythonRunResult>): PythonRunResult {
  return {
    mode: 'testes',
    tests: null,
    stdout: '',
    stderr: '',
    error: null,
    errorStage: null,
    structure: null,
    fallback: null,
    importError: null,
    truncated: false,
    ...over,
  };
}

function usePython(answer: (m: Extract<MainToPython, { type: 'run' }>) => PythonRunResult | null) {
  const seen: Extract<MainToPython, { type: 'run' }>[] = [];
  setPythonManager(new PythonManager(() => new FakeWorker((m) => (seen.push(m), answer(m))), 100));
  return seen;
}

describe('runCodeCheck · Python', () => {
  const r = ref({ language: 'python', answer: 'def f():\n    return 1', tests: 'assert f() == 1', setup: 'X = 1' });

  it('sends the request and maps the tests', async () => {
    const seen = usePython(() =>
      pyResult({
        tests: [
          { name: 'assert f() == 1', ok: true, line: 1, error: null, got: null, expected: null },
          { name: 'assert f() == 2', ok: false, line: 2, error: null, got: '1', expected: '2' },
        ],
      }),
    );
    const out = await runCodeCheck(r, 'def f(): return 1', OPTS);
    expect(seen[0]).toMatchObject({
      mode: 'testes',
      code: 'def f(): return 1',
      setup: 'X = 1',
      tests: 'assert f() == 1',
      expected: r.answer,
    });
    expect(out.verdict).toBe('wrong');
    expect(out.tests).toEqual([
      { name: 'assert f() == 1', ok: true, message: '' },
      { name: 'assert f() == 2', ok: false, message: 'linha 2 · obtido 1, esperado 2' },
    ]);
  });

  it('correct when every test passes; an error is wrong; no tests is unverifiable', async () => {
    usePython(() => pyResult({ tests: [{ name: 't', ok: true, line: 1, error: null, got: null, expected: null }] }));
    expect((await runCodeCheck(r, 'x', OPTS)).verdict).toBe('correct');
    usePython(() => pyResult({ error: 'NameError: y', errorStage: 'resposta.py' }));
    expect(await runCodeCheck(r, 'x', OPTS)).toMatchObject({ verdict: 'wrong', stderr: 'NameError: y' });
    usePython(() => pyResult({ tests: [] }));
    expect((await runCodeCheck(r, 'x', OPTS)).verdict).toBe('unverifiable');
  });

  it('saida compares stdout; estrutura and the ImportError fallback compare the AST', async () => {
    usePython(() => pyResult({ mode: 'saida', stdout: '5 \n' }));
    expect((await runCodeCheck({ ...r, mode: 'saida', expectedOutput: '5\n' }, 'x', OPTS)).verdict).toBe('correct');
    const structure = {
      same: true,
      expectedDump: 'd',
      gotDump: 'd',
      expected: 'a',
      got: 'a',
      expectedParses: true,
      gotParses: true,
    };
    usePython(() => pyResult({ mode: 'estrutura', structure }));
    expect((await runCodeCheck({ ...r, mode: 'estrutura' }, 'x', OPTS)).verdict).toBe('equivalent');
    usePython(() =>
      pyResult({
        fallback: 'estrutura',
        importError: "No module named 'rclpy'",
        structure: { ...structure, same: false },
      }),
    );
    const fb = await runCodeCheck(r, 'import rclpy', OPTS);
    expect(fb).toMatchObject({
      verdict: 'unverifiable',
      modeUsed: 'estrutura',
      structure: { expected: 'a', got: 'a' },
    });
    expect(fb.notice).toContain("No module named 'rclpy'");
  });

  it('a timeout is wrong with "Tempo esgotado (5 s)"', async () => {
    usePython(() => null);
    const out = await runCodeCheck(r, 'while True: pass', OPTS);
    expect(out).toMatchObject({ verdict: 'wrong', timedOut: true, notice: 'Tempo esgotado (5 s)' });
  });

  it('a cancel rejects with an AbortError', async () => {
    usePython(() => null);
    const ctl = new AbortController();
    const p = runCodeCheck(r, 'while True: pass', { ...OPTS, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toSatisfy(isAbort);
  });
});
