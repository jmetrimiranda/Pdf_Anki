import { useSyncExternalStore } from 'react';

/** An open document tab (spec 5.1). Persisted so tabs survive a reload. */
export interface DocTab {
  docId: string;
  title: string;
}

const KEY = 'leitor.tabs';
const listeners = new Set<() => void>();
let tabs: DocTab[] = load();

function load(): DocTab[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is DocTab => !!x && typeof x === 'object' && typeof x.docId === 'string' && typeof x.title === 'string',
    );
  } catch {
    return [];
  }
}

function commit(next: DocTab[]) {
  tabs = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not persisted; fine for this session.
  }
  for (const l of listeners) l();
}

export function getDocTabs(): DocTab[] {
  return tabs;
}

export function openDocTab(tab: DocTab): void {
  if (tabs.some((t) => t.docId === tab.docId)) {
    commit(tabs.map((t) => (t.docId === tab.docId ? tab : t)));
  } else {
    commit([...tabs, tab]);
  }
}

/** Removes a tab and returns the tab that should take focus (its right neighbour, else left). */
export function closeDocTab(docId: string): DocTab | undefined {
  const i = tabs.findIndex((t) => t.docId === docId);
  if (i < 0) return undefined;
  const next = tabs.filter((t) => t.docId !== docId);
  commit(next);
  return next[i] ?? next[i - 1];
}

export function moveDocTab(from: number, to: number): void {
  if (from === to || from < 0 || from >= tabs.length) return;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  if (!moved) return;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  commit(next);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useDocTabs(): DocTab[] {
  return useSyncExternalStore(subscribe, getDocTabs, getDocTabs);
}
