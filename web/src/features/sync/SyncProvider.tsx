import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FullSyncChoice, SyncState } from '../../lib/core/types';
import { FullSyncDialog } from './FullSyncDialog';
import { SyncTriggers } from './SyncTriggers';
import { useSyncEvents, useSyncStatus } from './useSyncStatus';

interface SyncUi {
  /** Reopens the full sync dialog (pill, Decks button) while the core waits for the choice. */
  openFullSync: () => void;
}

const SyncUiContext = createContext<SyncUi>({ openFullSync: () => {} });

export function useSyncUi(): SyncUi {
  return useContext(SyncUiContext);
}

const ANY_DIRECTION: FullSyncChoice = { uploadOk: true, downloadOk: true };

/**
 * The app-wide sync UI (mounted once by AppShell): keeps the status query current, reports UI events to the core's
 * scheduler and shows the full sync dialog once each time the core starts waiting for a choice.
 */
export function SyncProvider({ children }: { children: ReactNode }) {
  useSyncEvents();
  const status = useSyncStatus();
  const [dialog, setDialog] = useState<FullSyncChoice | null>(null);
  const prev = useRef<SyncState | undefined>(undefined);
  const required = status?.state === 'fullSyncRequired';
  const choice = status?.fullSync ?? null;

  useEffect(() => {
    if (required && prev.current !== 'fullSyncRequired') setDialog(choice ?? ANY_DIRECTION);
    prev.current = status?.state;
  }, [required, choice, status?.state]);

  const openFullSync = useCallback(() => {
    if (required) setDialog(choice ?? ANY_DIRECTION);
  }, [required, choice]);
  const api = useMemo(() => ({ openFullSync }), [openFullSync]);

  return (
    <SyncUiContext.Provider value={api}>
      {children}
      <SyncTriggers />
      {dialog && <FullSyncDialog choice={dialog} onClose={() => setDialog(null)} />}
    </SyncUiContext.Provider>
  );
}
