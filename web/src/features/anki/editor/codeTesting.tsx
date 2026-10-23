// Test doubles of the code authoring tests (Vitest only): a plain textarea for CodeEditor (CodeMirror is covered by
// Playwright) and CodeOutcome builders for a mocked `runCodeCheck`.
import type { CodeOutcome, Verdict } from '../../code-review/run';

export const fakeCodeEditorModule = {
  CodeEditor: ({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel: string }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  loadCodeMirror: () => Promise.resolve(),
};

export function outcome(verdict: Verdict, patch: Partial<CodeOutcome> = {}): CodeOutcome {
  return {
    verdict,
    notice: null,
    command: null,
    tests: null,
    output: null,
    structure: null,
    compile: null,
    stderr: '',
    timedOut: false,
    durationMs: 1,
    modeUsed: 'testes',
    ...patch,
  };
}

/** What `runCodeCheck` gives for C++ without a compiler nor a runner (the `estrutura` fallback). */
export function cppUnavailableOutcome(): CodeOutcome {
  return outcome('equivalent', {
    modeUsed: 'estrutura',
    notice: 'Não há compilador de C++ neste computador.',
    structure: { expected: 'int f();', got: 'int f();' },
  });
}
