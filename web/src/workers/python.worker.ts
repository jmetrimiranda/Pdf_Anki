// Python of the code cards (spec 11.4): Pyodide in a module worker, loaded lazily from /pyodide/ on the same origin
// (bundled with the app by vite-plugin-pyodide: offline, no download on desktop). The main thread enforces the time
// limit by terminating this worker (features/code-review/run/python.ts).
import harness from './harness.py?raw';
import type { MainToPython, PythonRunResult, PythonToMain } from './pythonProtocol';

interface Pyodide {
  runPython(code: string): unknown;
  globals: { get(name: string): unknown };
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
}

type LoadPyodide = (opts: { indexURL: string; fullStdLib?: boolean }) => Promise<Pyodide>;

const PYODIDE_BASE = '/pyodide/';

/** The worker scope (typed by hand: the app's TS config has the DOM lib, not the webworker one). */
interface WorkerScope {
  postMessage(m: PythonToMain): void;
  onmessage: ((e: MessageEvent<MainToPython>) => void) | null;
  location: { href: string };
}
const scope = self as unknown as WorkerScope;

let runner: Promise<(request: string) => string> | null = null;

function post(m: PythonToMain) {
  scope.postMessage(m);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function load(): Promise<(request: string) => string> {
  const base = new URL(PYODIDE_BASE, scope.location.href).href;
  const mod = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as { loadPyodide: LoadPyodide };
  const py = await mod.loadPyodide({ indexURL: base });
  // Nothing reaches the console: the harness captures what the card prints.
  py.setStdout({ batched: () => undefined });
  py.setStderr({ batched: () => undefined });
  py.runPython(harness);
  const fn = py.globals.get('leitor_run') as ((request: string) => string) & { destroy?: () => void };
  return (request: string) => fn(request);
}

function ensureLoaded(): Promise<(request: string) => string> {
  if (!runner) {
    runner = load();
    runner.then(
      () => post({ type: 'ready' }),
      (e: unknown) => post({ type: 'loadError', message: errorText(e) }),
    );
  }
  return runner;
}

scope.onmessage = (e: MessageEvent<MainToPython>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'preload') {
    void ensureLoaded();
    return;
  }
  if (m.type !== 'run') return;
  void ensureLoaded().then(
    (run) => {
      try {
        const result = JSON.parse(
          run(
            JSON.stringify({
              mode: m.mode,
              code: m.code,
              setup: m.setup,
              tests: m.tests,
              stdin: m.stdin,
              expected: m.expected ?? '',
            }),
          ),
        ) as PythonRunResult;
        post({ type: 'result', id: m.id, result });
      } catch (err) {
        post({ type: 'runError', id: m.id, message: errorText(err) });
      }
    },
    () => undefined,
  );
};
