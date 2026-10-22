import { mockClient } from './mock';
import { tauriClient } from './tauri';
import type { CoreClient } from './types';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function useMockCore(): boolean {
  return import.meta.env.VITE_MOCK === '1' || !isTauri();
}

/** The core client for this runtime: the Tauri commands, or the in-browser mock. */
export const core: CoreClient = useMockCore() ? mockClient : tauriClient;

export * from './types';
