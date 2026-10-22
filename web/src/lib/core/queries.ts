import { queryOptions } from '@tanstack/react-query';
import { core } from './client';

// Query keys and fetchers shared by the routes.
export const q = {
  deckTree: () => queryOptions({ queryKey: ['anki', 'deckTree'], queryFn: () => core.ankiDeckTree() }),
  docInfo: (docId: string) => queryOptions({ queryKey: ['doc', docId, 'info'], queryFn: () => core.docInfo(docId) }),
  docOutline: (docId: string) =>
    queryOptions({ queryKey: ['doc', docId, 'outline'], queryFn: () => core.docOutline(docId) }),
  docWords: (docId: string, page: number) =>
    queryOptions({ queryKey: ['doc', docId, 'words', page], queryFn: () => core.docWords(docId, page) }),
  smoke: () => queryOptions({ queryKey: ['dev', 'smoke'], queryFn: () => core.devSmoke(), staleTime: Infinity }),
};
