import { queryOptions } from '@tanstack/react-query';
import { core } from './client';

// Query keys and fetchers shared by the routes.
export const q = {
  deckTree: () => queryOptions({ queryKey: ['anki', 'deckTree'], queryFn: () => core.ankiDeckTree() }),
  library: () => queryOptions({ queryKey: ['library'], queryFn: () => core.libraryList() }),
  smoke: () => queryOptions({ queryKey: ['dev', 'smoke'], queryFn: () => core.devSmoke(), staleTime: Infinity }),
};
