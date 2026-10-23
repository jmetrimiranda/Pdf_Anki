import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { t } from '../../i18n';
import { protocolUrl } from '../protocol';
import { CoreError, type CoreClient, type Unlisten } from './types';

function toCoreError(err: unknown): CoreError {
  if (err instanceof CoreError) return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { code?: unknown; message?: unknown };
    return new CoreError(typeof e.code === 'string' ? e.code : 'unknown', String(e.message));
  }
  if (typeof err === 'string') return new CoreError('unknown', err);
  return new CoreError('unknown', 'Erro inesperado no núcleo do app.');
}

async function call<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await invoke<T>(cmd, args, options);
  } catch (err) {
    throw toCoreError(err);
  }
}

/** Wraps Tauri's async `listen`-style subscriptions into a synchronous unsubscribe. */
function subscription(start: () => Promise<() => void>): Unlisten {
  let stopped = false;
  let stop: (() => void) | undefined;
  start()
    .then((fn) => {
      if (stopped) fn();
      else stop = fn;
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop?.();
  };
}

const PDF_FILTER = [{ name: 'PDF', extensions: ['pdf'] }];

export const tauriClient: CoreClient = {
  kind: 'tauri',
  ankiDeckTree: () => call('anki_deck_tree'),

  libraryList: () => call('library_list'),
  libraryAdd: (path, opts) => call('library_add', { path, replace: !!opts?.replace }),
  libraryRemove: (uid) => call('library_remove', { uid }),
  libraryUpdate: (uid, patch) => call('library_update', { uid, patch }),
  bookOpen: (uid) => call('book_open', { uid }),

  // `book_bytes` answers with a raw `tauri::ipc::Response`, which arrives as an ArrayBuffer.
  bookBytes: (uid) => call<ArrayBuffer>('book_bytes', { uid }),
  // Raw request body (no JSON array of numbers); the uid travels in a header.
  bookSaveVersion: (uid, bytes, baseVersion) =>
    call('book_save_version', new Uint8Array(bytes), {
      headers: { 'x-book-uid': uid, ...(baseVersion !== undefined ? { 'x-base-version': String(baseVersion) } : {}) },
    }),
  bookExport: (uid, path) => call('book_export', { uid, path }),
  exportBytes: (path, bytes) =>
    call('export_bytes', new Uint8Array(bytes), { headers: { 'x-path': encodeURIComponent(path) } }),
  bookOpenExternal: (uid) => call('book_open_external', { uid }),
  docWords: (uid, page) => call('doc_words', { uid, page }),

  positionGet: (uid) => call('position_get', { uid }),
  positionSet: (uid, page, progress) => call('position_set', { uid, page, progress }),
  readingSessionStart: (uid, page) => call('reading_session_start', { uid, page }),
  readingSessionHeartbeat: (uid, page) => call('reading_session_heartbeat', { uid, page }),
  readingSessionStop: (uid, reason) => call('reading_session_stop', { uid, reason }),

  pendingOpenPaths: () => call('pending_open_paths'),
  devSmoke: () => call('dev_smoke'),
  devLog: (level, message) => call<void>('dev_log', { level, message }).catch(() => undefined),
  coverUrl: (uid, fileVersion) => protocolUrl('pdf', `cover/${encodeURIComponent(uid)}?v=${fileVersion}`),

  pickBookFiles: async () => {
    const picked = await openDialog({ multiple: true, directory: false, filters: PDF_FILTER });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  // The core opens the dialog and grants the chosen path to one export (spec 18).
  pickExportPath: (defaultName) =>
    call<string | null>('export_pick_path', { defaultName, title: t('reader.exportTitle') }),

  onOpenPaths: (cb) =>
    subscription(() =>
      listen<string[]>('leitor://open-paths', (e) => {
        if (Array.isArray(e.payload) && e.payload.length) cb(e.payload);
      }),
    ),
  onDragDropPaths: (cb, onHover) =>
    subscription(() =>
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'enter') onHover?.(true);
        else if (p.type === 'leave') onHover?.(false);
        else if (p.type === 'drop') {
          onHover?.(false);
          if (p.paths.length) cb(p.paths);
        }
      }),
    ),
  onWindowCloseRequested: (handler) =>
    subscription(() =>
      getCurrentWindow().onCloseRequested(async (event) => {
        // Tauri awaits this handler and destroys the window unless the default is prevented.
        const ok = await handler().catch(() => true);
        if (!ok) event.preventDefault();
      }),
    ),
};

export { toCoreError };
