// History of the answers typed in code cards (spec 11.2: "um campo de uma linha com histórico (↑)"), per role, in
// localStorage 'leitor.code.history': the last 100, oldest first, consecutive duplicates removed.

export const HISTORY_KEY = 'leitor.code.history';
export const HISTORY_MAX = 100;

export type HistoryRole = 'command' | 'program';

type Store = Partial<Record<HistoryRole, string[]>>;

function read(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const role of ['command', 'program'] as const) {
      const list = (parsed as Record<string, unknown>)[role];
      if (Array.isArray(list)) out[role] = list.filter((x): x is string => typeof x === 'string').slice(-HISTORY_MAX);
    }
    return out;
  } catch {
    return {};
  }
}

export function historyOf(role: HistoryRole): string[] {
  return read()[role] ?? [];
}

/** Appends an entry (ignored when empty or equal to the last one). */
export function pushHistory(role: HistoryRole, entry: string): string[] {
  const store = read();
  const list = store[role] ?? [];
  if (entry.trim() === '' || list[list.length - 1] === entry) return list;
  const next = [...list, entry].slice(-HISTORY_MAX);
  store[role] = next;
  try {
    globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable: the history is a convenience.
  }
  return next;
}
