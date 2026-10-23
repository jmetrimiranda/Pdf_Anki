import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/ui';
import { core } from '../../lib/core/client';
import type { AnkiSyncStatus } from '../../lib/core/types';
import { errorMessage } from '../anki/decks/DeckDialogs';

/** Not under ['anki']: refreshing the Anki tab must not refetch (or reset) the sync status. */
export const syncStatusKey = ['sync', 'status'] as const;

export const syncStatusQuery = () =>
  queryOptions({ queryKey: syncStatusKey, queryFn: () => core.ankiSyncStatus(), staleTime: Infinity });

/** The core's sync status (seeded by `ankiSyncStatus`, then kept current by the `anki://sync` events). */
export function useSyncStatus(): AnkiSyncStatus | undefined {
  return useQuery(syncStatusQuery()).data;
}

export function setSyncStatus(queryClient: QueryClient, status: AnkiSyncStatus): void {
  queryClient.setQueryData(syncStatusKey, status);
}

/** Subscribes the status query to `anki://sync` (mounted once, by SyncProvider). */
export function useSyncEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => core.onAnkiSync((s) => setSyncStatus(queryClient, s)), [queryClient]);
}

/** "Sincronizar agora": a normal sync; failures arrive in the status (offline, error), call errors as a toast. */
export function useSyncNow() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => core.ankiSync(),
    onSuccess: (s) => setSyncStatus(queryClient, s),
    onError: (err) => toast.show(errorMessage(err), { tone: 'error' }),
  });
}

/**
 * The current time for relative texts like "há 2 min": read at every render (so a new status never shows a stale
 * age) and re-rendered every `intervalMs`.
 */
export function useNow(intervalMs = 30_000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return Date.now();
}
