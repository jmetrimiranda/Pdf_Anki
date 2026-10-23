import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { core } from '../../lib/core/client';
import type { SyncNotifyEvent } from '../../lib/core/types';

const isAnkiPath = (p: string) => p === '/anki' || p.startsWith('/anki/');

function notify(event: SyncNotifyEvent): void {
  void core.ankiSyncNotify(event).catch(() => undefined);
}

/**
 * Tells the core's sync scheduler what happens in the UI (spec 9): entering the Anki tab, the network coming and
 * going, the window becoming visible. The timers and the rules (2 min, 5 min, 60 s after the last answer, 15 min)
 * live in the core; this component has none.
 */
export function SyncTriggers(): null {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inAnki = isAnkiPath(pathname);
  const wasInAnki = useRef<boolean | null>(null);

  // Only when the route enters /anki from another tab: moving between Anki's own screens is not "entering".
  useEffect(() => {
    if (inAnki && wasInAnki.current === false) notify('tabEntered');
    wasInAnki.current = inAnki;
  }, [inAnki]);

  useEffect(() => {
    const online = () => notify('online');
    const offline = () => notify('offline');
    const visible = () => {
      if (document.visibilityState === 'visible') notify('visible');
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  return null;
}
