import { useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';

/** Navigates to an app path that is not a typed route of this screen (Anki pages, card info). Outside a router
 *  (component tests) it falls back to the history API. */
export function useGo(): (href: string) => void {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  return useCallback(
    (href: string) => {
      if (router) void router.navigate({ href });
      else window.history.pushState(null, '', href);
    },
    [router],
  );
}
