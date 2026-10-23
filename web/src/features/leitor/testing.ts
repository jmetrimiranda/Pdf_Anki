// Test doubles for the Leitor (Vitest only).
import { vi } from 'vitest';
import type { Timers } from './autosave';
import type { LeitorCore } from './controller';

export const ORIGIN = 'http://localhost:5173';
export const UID_A = 'a'.repeat(64);
export const UID_B = 'b'.repeat(64);

/** The iframe's window: records what the app posts. */
export function fakeFrame() {
  const posted: { msg: Record<string, unknown>; opts: unknown }[] = [];
  const win = {
    postMessage: vi.fn((msg: unknown, opts: unknown) => {
      posted.push({ msg: msg as Record<string, unknown>, opts });
    }),
  };
  return { win, posted };
}

/** The parent window: an EventTarget where tests deliver `message` events. */
export function fakeHost() {
  const target = new EventTarget();
  const deliver = (data: unknown, source: unknown, origin = ORIGIN) => {
    const ev = new Event('message');
    Object.defineProperties(ev, {
      data: { value: data },
      source: { value: source },
      origin: { value: origin },
    });
    target.dispatchEvent(ev);
  };
  return { host: target as unknown as Window, deliver };
}

/** Timers driven by vi.useFakeTimers (so `vi.advanceTimersByTimeAsync` moves them). */
export const viTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function fakeCore(overrides: Partial<LeitorCore> = {}): LeitorCore & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    <A extends unknown[]>(name: string, ret?: unknown) =>
    (...args: A) => {
      calls.push(`${name}(${args.map((a) => (a instanceof Uint8Array ? `bytes:${a.length}` : String(a))).join(',')})`);
      return Promise.resolve(ret) as Promise<never>;
    };
  return {
    calls,
    openInfo: vi.fn(async (uid: string) => {
      calls.push(`openInfo(${uid.slice(0, 1)})`);
      return { name: `${uid.slice(0, 1)}.pdf`, title: `Livro ${uid.slice(0, 1)}`, page: 4, pages: 12, fileVersion: 1 };
    }),
    bytes: vi.fn(async () => new Uint8Array([37, 80, 68, 70, 45]).buffer),
    saveVersion: vi.fn(rec('saveVersion', { fileVersion: 2, keptNewer: false })),
    pickExportPath: vi.fn(async (name: string) => `/tmp/${name}`),
    exportBook: vi.fn(rec('exportBook')),
    exportBytes: vi.fn(rec('exportBytes')),
    openExternal: vi.fn(rec('openExternal')),
    positionSet: vi.fn(rec('positionSet')),
    setPages: vi.fn(rec('setPages')),
    sessionStart: vi.fn(rec('start')),
    sessionHeartbeat: vi.fn(rec('heartbeat')),
    sessionStop: vi.fn(rec('stop')),
    log: vi.fn(),
    ...overrides,
  };
}
