import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** Below this width tabs become a menu and side panels become bottom sheets (spec 5.1). */
export const useNarrow = () => useMediaQuery('(max-width: 767px)');
