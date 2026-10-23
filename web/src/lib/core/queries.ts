import { queryOptions } from '@tanstack/react-query';
import { core } from './client';

// Query keys and fetchers shared by the routes. Every Anki query lives under ['anki', …], so one
// `invalidateQueries({ queryKey: ['anki'] })` refreshes the whole tab after an import or a page change.
export const q = {
  deckTree: () => queryOptions({ queryKey: ['anki', 'deckTree'], queryFn: () => core.ankiDeckTree() }),
  deckNames: () => queryOptions({ queryKey: ['anki', 'deckNames'], queryFn: () => core.ankiDeckNames() }),
  notetypes: () => queryOptions({ queryKey: ['anki', 'notetypes'], queryFn: () => core.ankiNotetypes() }),
  tagsAll: () => queryOptions({ queryKey: ['anki', 'tags'], queryFn: () => core.ankiTagsAll() }),
  backups: () => queryOptions({ queryKey: ['anki', 'backups'], queryFn: () => core.ankiBackups(), staleTime: 0 }),
  library: () => queryOptions({ queryKey: ['library'], queryFn: () => core.libraryList() }),
  smoke: () => queryOptions({ queryKey: ['dev', 'smoke'], queryFn: () => core.devSmoke(), staleTime: Infinity }),
};
