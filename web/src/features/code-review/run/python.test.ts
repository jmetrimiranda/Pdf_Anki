import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToPython, PythonRunResult, PythonToMain } from '../../../workers/pythonProtocol';
import { DEFAULT_PYTHON_TIMEOUT_MS, PythonManager, type WorkerLike } from './python';

/** A fake worker driven by the test: it answers `ready` when told to, and the runs it is given. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<PythonToMain>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: MainToPython[] = [];
  terminated = false;
  postMessage(m: MainToPython) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(m: PythonToMain) {
    this.onmessage?.({ data: m } as MessageEvent<PythonToMain>);
  }
  lastRunId(): number {
    const runs = this.posted.filter((m) => m.type === 'run');
    const last = runs[runs.length - 1];
    if (!last || last.type !== 'run') throw new Error('no run');
    return last.id;
  }
}

const RESULT: PythonRunResult = {
  mode: 'testes',
  tests: [{ name: 'test_a', ok: true, line: 1, error: null, got: null, expected: null }],
  stdout: '',
  stderr: '',
  error: null,
  errorStage: null,
  structure: null,
  fallback: null,
  importError: null,
  truncated: false,
};

const REQ = { mode: 'testes' as const, code: 'x = 1', setup: '', tests: 'assert x == 1', stdin: '' };

let workers: FakeWorker[];
let manager: PythonManager;

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  manager = new PythonManager(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
});

afterEach(() => {
  manager.dispose();
  vi.useRealTimers();
});

describe('PythonManager', () => {
  it('preloads once (no worker before the first Python card)', () => {
    expect(workers).toHaveLength(0);
    manager.preload();
    manager.preload();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual([{ type: 'preload' }]);
  });

  it('posts the run only to a READY worker and returns its result', async () => {
    const p = manager.run(REQ);
    await vi.advanceTimersByTimeAsync(10_000);
    // Still loading: the 5 s have not started.
    expect(workers[0]!.posted.some((m) => m.type === 'run')).toBe(false);
    workers[0]!.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    const id = workers[0]!.lastRunId();
    workers[0]!.emit({ type: 'result', id, result: RESULT });
    await expect(p).resolves.toMatchObject({ kind: 'result', result: RESULT });
    expect(workers[0]!.terminated).toBe(false);
  });

  it('terminates the worker after 5 s and creates (and preloads) a new one for the next run', async () => {
    manager.preload();
    workers[0]!.emit({ type: 'ready' });
    const p = manager.run({ ...REQ, code: 'while True: pass' });
    await vi.advanceTimersByTimeAsync(DEFAULT_PYTHON_TIMEOUT_MS - 1);
    expect(workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ kind: 'timeout' });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toEqual([{ type: 'preload' }]);
    expect(manager.created).toBe(2);

    // The next run goes to the new worker.
    const next = manager.run(REQ);
    workers[1]!.emit({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    workers[1]!.emit({ type: 'result', id: workers[1]!.lastRunId(), result: RESULT });
    await expect(next).resolves.toMatchObject({ kind: 'result' });
  });

  it('ignores a late result of a terminated run', async () => {
    manager.preload();
    const old = workers[0]!;
    old.emit({ type: 'ready' });
    const p = manager.run(REQ);
    await vi.advanceTimersByTimeAsync(0);
    const id = old.lastRunId();
    await vi.advanceTimersByTimeAsync(DEFAULT_PYTHON_TIMEOUT_MS);
    await expect(p).resolves.toMatchObject({ kind: 'timeout' });
    old.emit({ type: 'result', id, result: RESULT });
    expect(old.onmessage).toBeNull();
  });

  it('cancels a run: terminate + recreate', async () => {
    manager.preload();
    workers[0]!.emit({ type: 'ready' });
    const ctl = new AbortController();
    const p = manager.run(REQ, ctl.signal);
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();
    await expect(p).resolves.toEqual({ kind: 'cancelled' });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it('reports a load failure and retries with a new worker next time', async () => {
    const p = manager.run(REQ);
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.emit({ type: 'loadError', message: 'CSP' });
    await expect(p).resolves.toEqual({ kind: 'loadError', message: 'CSP' });
    expect(workers[0]!.terminated).toBe(true);
    const again = manager.run(REQ);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1]!.onerror?.({ message: 'not found', preventDefault: () => undefined } as ErrorEvent);
    await expect(again).resolves.toMatchObject({ kind: 'loadError', message: 'not found' });
  });

  it('runs one request at a time', async () => {
    manager.preload();
    workers[0]!.emit({ type: 'ready' });
    const a = manager.run(REQ);
    const b = manager.run({ ...REQ, code: 'y = 2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0]!.posted.filter((m) => m.type === 'run')).toHaveLength(1);
    workers[0]!.emit({ type: 'result', id: workers[0]!.lastRunId(), result: RESULT });
    await a;
    await vi.advanceTimersByTimeAsync(0);
    const runs = workers[0]!.posted.filter((m) => m.type === 'run');
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ code: 'y = 2' });
    workers[0]!.emit({ type: 'result', id: workers[0]!.lastRunId(), result: RESULT });
    await expect(b).resolves.toMatchObject({ kind: 'result' });
  });
});
