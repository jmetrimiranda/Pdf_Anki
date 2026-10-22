import { invoke } from '@tauri-apps/api/core';
import { pdfRenderUrl } from '../protocol';
import { CoreError, type CoreClient } from './types';

function toCoreError(err: unknown): CoreError {
  if (err instanceof CoreError) return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { code?: unknown; message?: unknown };
    return new CoreError(typeof e.code === 'string' ? e.code : 'unknown', String(e.message));
  }
  if (typeof err === 'string') return new CoreError('unknown', err);
  return new CoreError('unknown', 'Erro inesperado no núcleo do app.');
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toCoreError(err);
  }
}

export const tauriClient: CoreClient = {
  kind: 'tauri',
  ankiDeckTree: () => call('anki_deck_tree'),
  docOpenPath: (path) => call('doc_open_path', { path }),
  docInfo: (docId) => call('doc_info', { docId }),
  docOutline: (docId) => call('doc_outline', { docId }),
  docWords: (docId, page) => call('doc_words', { docId, page }),
  docSearch: (docId, q) => call('doc_search', { docId, q }),
  docClose: (docId) => call('doc_close', { docId }),
  devSmoke: () => call('dev_smoke'),
  pageImageUrl: (docId, page, opts) => pdfRenderUrl(docId, page, opts),
};

export { toCoreError };
