// Messages between the main thread (features/code-review/run/python.ts) and python.worker.ts, and the result
// harness.py returns (JSON). Spec 11.4.

export type PythonMode = 'testes' | 'saida' | 'estrutura';

export interface PythonRunRequest {
  type: 'run';
  id: number;
  mode: PythonMode;
  /** The user's answer. */
  code: string;
  setup: string;
  tests: string;
  /** stdin (mode saida). */
  stdin: string;
  /** The reference answer (estrutura, and the fallback of an ImportError). */
  expected?: string;
}

export type MainToPython = PythonRunRequest | { type: 'preload' };

/** One test of mode `testes`: a `test_*` function or a top-level `assert`. */
export interface PythonTest {
  name: string;
  ok: boolean;
  line: number | null;
  /** The exception (traceback limited to the card's files) or the assert message. */
  error: string | null;
  /** For a failing `assert a == b`: `repr(a)` and `repr(b)`. */
  got: string | null;
  expected: string | null;
}

export interface PythonStructure {
  same: boolean;
  /** `ast.dump` without docstrings ('' when the program does not parse). */
  expectedDump: string;
  gotDump: string;
  /** `ast.unparse` of each program (or the SyntaxError when it does not parse). */
  expected: string;
  got: string;
  expectedParses: boolean;
  gotParses: boolean;
}

export interface PythonRunResult {
  mode: PythonMode;
  tests: PythonTest[] | null;
  stdout: string;
  stderr: string;
  /** An uncaught exception of the Setup / the answer / the Tests (traceback limited to the card's files). */
  error: string | null;
  errorStage: 'setup.py' | 'resposta.py' | 'testes.py' | null;
  structure: PythonStructure | null;
  /** An ImportError while running: the structure was compared instead (spec 11.4). */
  fallback: 'estrutura' | null;
  importError: string | null;
  /** stdout/stderr were cut at 64 KiB. */
  truncated: boolean;
}

export type PythonToMain =
  | { type: 'ready' }
  | { type: 'loadError'; message: string }
  | { type: 'result'; id: number; result: PythonRunResult }
  | { type: 'runError'; id: number; message: string };
