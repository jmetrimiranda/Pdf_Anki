import { useSyncExternalStore } from 'react';

export type AppTheme = 'light' | 'dark';

const KEY = 'leitor.theme';
const listeners = new Set<() => void>();

function systemTheme(): AppTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getTheme(): AppTheme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be unavailable (private mode); fall back to the system theme.
  }
  return systemTheme();
}

export function setTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not persisted; the theme still applies for this session.
  }
  for (const l of listeners) l();
}

export function initTheme(): void {
  document.documentElement.dataset.theme = getTheme();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme(): [AppTheme, (t: AppTheme) => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'light' as const);
  return [theme, setTheme];
}
