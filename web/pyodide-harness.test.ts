// @vitest-environment node
// src/workers/harness.py with the REAL vendored Pyodide (scripts/fetch-pyodide.sh), in Node: the same interpreter and harness the
// worker runs in the app (spec 11.4).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PythonRunRequest, PythonRunResult } from './src/workers/pythonProtocol';

const PYODIDE_DIR = path.resolve(__dirname, '../src-tauri/resources/pyodide');

interface Py {
  runPython(code: string): unknown;
  globals: { get(name: string): unknown };
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
}

let run: (req: Omit<PythonRunRequest, 'type' | 'id'>) => PythonRunResult;

beforeAll(async () => {
  if (!existsSync(path.join(PYODIDE_DIR, 'pyodide.mjs'))) {
    throw new Error(`Pyodide is missing in ${PYODIDE_DIR}: run scripts/fetch-pyodide.sh`);
  }
  const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(PYODIDE_DIR, 'pyodide.mjs')).href)) as {
    loadPyodide: (o: { indexURL: string }) => Promise<Py>;
  };
  const py = await mod.loadPyodide({ indexURL: PYODIDE_DIR + path.sep });
  py.setStdout({ batched: () => undefined });
  py.setStderr({ batched: () => undefined });
  py.runPython(readFileSync(path.join(__dirname, 'src/workers/harness.py'), 'utf8'));
  const fn = py.globals.get('leitor_run') as (s: string) => string;
  run = (req) => JSON.parse(fn(JSON.stringify(req))) as PythonRunResult;
}, 60_000);

const SOMA = 'def soma_pares(xs):\n    return sum(x for x in xs if x % 2 == 0)\n';
const base = { setup: '', tests: '', stdin: '', expected: '' };

describe('harness.py · testes', () => {
  it('runs top-level asserts as tests, in order', () => {
    const r = run({
      ...base,
      mode: 'testes',
      code: SOMA,
      tests: 'assert soma_pares([1, 2, 3, 4]) == 6\nassert soma_pares([]) == 0\n',
    });
    expect(r.error).toBeNull();
    expect(r.tests).toEqual([
      expect.objectContaining({ name: 'assert soma_pares([1, 2, 3, 4]) == 6', ok: true, line: 1 }),
      expect.objectContaining({ name: 'assert soma_pares([]) == 0', ok: true, line: 2 }),
    ]);
  });

  it('runs and reports every assert; a failing one with its line and both values', () => {
    const r = run({
      ...base,
      mode: 'testes',
      code: 'def soma_pares(xs):\n    return sum(xs)\n',
      tests: 'x = 1\nassert soma_pares([2]) == 2\nassert soma_pares([1, 2, 3, 4]) == 6\nassert soma_pares([]) == 0\n',
    });
    expect(r.tests).toHaveLength(3);
    expect(r.tests![0]!.ok).toBe(true);
    expect(r.tests![1]).toMatchObject({ ok: false, line: 3, got: '10', expected: '6' });
    expect(r.tests![2]).toMatchObject({ ok: true, line: 4 });
  });

  it('calls test_* functions and reports each one', () => {
    const r = run({
      ...base,
      mode: 'testes',
      setup: 'FATOR = 2',
      code: 'def dobro(x):\n    return x * FATOR\n',
      tests: [
        'def test_um():',
        '    assert dobro(1) == 2',
        'def test_falha():',
        '    assert dobro(2) == 5, "dobro(2) deveria ser 5"',
        'def test_erro():',
        '    return 1 / 0',
        'def ajuda():',
        '    pass',
      ].join('\n'),
    });
    expect(r.tests!.map((t) => [t.name, t.ok])).toEqual([
      ['test_um', true],
      ['test_falha', false],
      ['test_erro', false],
    ]);
    expect(r.tests![1]!.error).toContain('dobro(2) deveria ser 5');
    expect(r.tests![1]!.line).toBe(4);
    expect(r.tests![2]!.error).toContain('ZeroDivisionError');
    expect(r.tests![2]!.error).not.toContain('harness');
  });

  it('reports an error of the answer with its own traceback only', () => {
    const r = run({ ...base, mode: 'testes', code: 'def f(:\n  pass', tests: 'assert True' });
    expect(r.error).toContain('SyntaxError');
    expect(r.errorStage).toBe('resposta.py');
    expect(r.tests).toBeNull();
    const r2 = run({ ...base, mode: 'testes', code: 'raise ValueError("ruim")', tests: 'assert True' });
    expect(r2.error).toContain('resposta.py');
    expect(r2.error).toContain('ValueError: ruim');
  });

  it('runs each request in a fresh namespace and captures prints', () => {
    run({ ...base, mode: 'testes', code: 'segredo = 42', tests: '' });
    const r = run({ ...base, mode: 'testes', code: 'print("oi")', tests: 'assert "segredo" not in globals()' });
    expect(r.tests).toEqual([expect.objectContaining({ ok: true })]);
    expect(r.stdout).toBe('oi\n');
  });
});

describe('harness.py · saida', () => {
  it('feeds the Entrada as stdin and captures stdout (trailing whitespace kept for the TS comparison)', () => {
    const r = run({
      ...base,
      mode: 'saida',
      code: 'n = int(input())\nfor i in range(n):\n    print(i, end="  \\n")\nimport sys\nprint(sys.stdin.read().strip())',
      stdin: '3\nresto\n',
    });
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('0  \n1  \n2  \nresto\n');
  });

  it('treats sys.exit as a normal end and keeps stderr apart', () => {
    const r = run({
      ...base,
      mode: 'saida',
      code: 'import sys\nprint("a")\nprint("b", file=sys.stderr)\nsys.exit(0)\nprint("c")',
    });
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('a\n');
    expect(r.stderr).toBe('b\n');
  });

  it('cuts a huge output', () => {
    const r = run({ ...base, mode: 'saida', code: 'for i in range(100000):\n    print("x" * 10)' });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(64 * 1024);
  });
});

describe('harness.py · estrutura', () => {
  it('ignores docstrings, comments and formatting', () => {
    const r = run({
      ...base,
      mode: 'estrutura',
      expected: SOMA,
      code: 'def soma_pares( xs ):\n    """Soma os pares."""\n    # comentário\n    return sum(x for x in xs if x % 2 == 0)\n',
    });
    expect(r.structure!.same).toBe(true);
    expect(r.structure!.got).toBe(r.structure!.expected);
  });

  it('shows both programs when they differ, and never runs them', () => {
    const r = run({
      ...base,
      mode: 'estrutura',
      expected: SOMA,
      code: 'print("rodou")\ndef soma_pares(xs):\n    return 0',
    });
    expect(r.structure!.same).toBe(false);
    expect(r.structure!.got).toContain("print('rodou')");
    expect(r.stdout).toBe('');
  });

  it('reports a program that does not parse', () => {
    const r = run({ ...base, mode: 'estrutura', expected: SOMA, code: 'def (' });
    expect(r.structure).toMatchObject({ same: false, gotParses: false, expectedParses: true });
    expect(r.structure!.got).toContain('SyntaxError');
  });
});

describe('harness.py · imports unavailable', () => {
  it('falls back to estrutura on an ImportError (spec 11.4)', () => {
    const code = 'import rclpy\nfrom rclpy.node import Node\n\nclass No(Node):\n    pass\n';
    const r = run({ ...base, mode: 'testes', code, expected: code, tests: 'assert True' });
    expect(r.fallback).toBe('estrutura');
    expect(r.importError).toContain('rclpy');
    expect(r.structure!.same).toBe(true);
    expect(r.error).toBeNull();
    const r2 = run({ ...base, mode: 'saida', code: 'from inexistente import x', expected: 'print(1)' });
    expect(r2.fallback).toBe('estrutura');
    expect(r2.structure!.same).toBe(false);
  });
});
