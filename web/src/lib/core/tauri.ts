import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { t } from '../../i18n';
import { protocolUrl } from '../protocol';
import {
  CoreError,
  type AnkiChanged,
  type AnkiPageEvent,
  type AnkiSyncStatus,
  type CoreClient,
  type Unlisten,
} from './types';

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
const IMAGE_FILTER = [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }];

function toBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export const tauriClient: CoreClient = {
  kind: 'tauri',
  ankiDeckTree: () => call('anki_deck_tree'),
  ankiDeckNames: () => call('anki_deck_names'),
  ankiDeckCreate: (name) => call('anki_deck_create', { name }),
  ankiDeckRename: (deckId, name) => call('anki_deck_rename', { deckId, name }),
  ankiDeckMove: (deckIds, parentId) => call('anki_deck_move', { deckIds, parentId }),
  ankiDeckDelete: (deckId) => call('anki_deck_delete', { deckId }),
  ankiDeckSetCollapsed: (deckId, collapsed) => call('anki_deck_set_collapsed', { deckId, collapsed }),
  ankiSetCurrentDeck: (deckId) => call('anki_set_current_deck', { deckId }),
  ankiPrepareCollection: () => call('anki_prepare_collection'),

  ankiStudyNext: (deckId) => call('anki_study_next', { deckId }),
  ankiShowAnswer: (cardId, typed) => call('anki_show_answer', { cardId, typed }),
  ankiAnswer: (cardId, rating, ms) => call('anki_answer', { cardId, rating, ms: Math.max(0, Math.round(ms)) }),
  ankiUndo: () => call('anki_undo'),
  ankiCardAction: (cardId, action, flag) =>
    call('anki_card_action', { cardId, action, ...(flag !== undefined ? { flag } : {}) }),
  ankiStudyClose: () => call('anki_study_close'),

  ankiNotetypes: () => call('anki_notetypes'),
  ankiAddDefaults: (deckId) => call('anki_add_defaults', { deckId }),
  ankiNoteGet: (noteId) => call('anki_note_get', { noteId }),
  ankiNoteCheck: (notetypeId, fields) => call('anki_note_check', { notetypeId, fields }),
  ankiNoteAdd: (note) => call('anki_note_add', { note }),
  ankiNoteUpdate: (noteId, fields, tags) => call('anki_note_update', { noteId, fields, tags }),
  // Raw request body (no JSON array of numbers); the file name travels percent-encoded in a header.
  ankiMediaAdd: (name, bytes) =>
    call('anki_media_add', toBytes(bytes), { headers: { 'x-file-name': encodeURIComponent(name) } }),
  ankiTagsAll: () => call('anki_tags_all'),

  ankiSearch: (query, order) => call('anki_search', { query, order }),
  ankiBrowseRows: (cardIds) => call('anki_browse_rows', { cardIds }),
  ankiCardsSetDeck: (cardIds, deckId) => call('anki_cards_set_deck', { cardIds, deckId }),
  ankiNotesTags: (noteIds, add, remove) => call('anki_notes_tags', { noteIds, add, remove }),
  ankiCardsSuspend: (cardIds, suspended) => call('anki_cards_suspend', { cardIds, suspended }),
  ankiCardsForget: (cardIds, opts) => call('anki_cards_forget', { cardIds, opts }),
  ankiNotesDelete: (noteIds) => call('anki_notes_delete', { noteIds }),
  ankiChangeNotetypePrepare: (noteIds) => call('anki_change_notetype_prepare', { noteIds }),

  // The core opens the dialog and grants reading the chosen package for a while (spec 18).
  ankiPickPackage: () => call('anki_pick_package'),
  ankiImport: (path) => call('anki_import', { path }),
  ankiImportColpkg: (path) => call('anki_import_colpkg', { path }),
  ankiExport: (deckId, path, opts) => call('anki_export', { deckId, path, opts }),
  ankiBackupNow: () => call('anki_backup_now'),
  ankiBackups: () => call('anki_backups'),

  ankiPageUrl: (route, night) => protocolUrl('anki', route) + (night ? '#night' : ''),
  cardFrameUrl: () => protocolUrl('card', '_leitor/reviewer.html'),
  cardMediaUrl: (name) => protocolUrl('card', encodeURIComponent(name)),
  onAnkiChanged: (cb) =>
    subscription(() =>
      listen<AnkiChanged>('anki://changed', (e) => {
        if (e.payload && typeof e.payload === 'object') cb(e.payload);
      }),
    ),
  onAnkiPageEvent: (cb) =>
    subscription(() =>
      listen<AnkiPageEvent>('anki://page', (e) => {
        if (e.payload && typeof e.payload === 'object' && typeof e.payload.kind === 'string') cb(e.payload);
      }),
    ),

  ankiSyncStatus: () => call('anki_sync_status'),
  ankiSyncLogin: (url, user, password, certificatePem) =>
    call('anki_sync_login', { url, user, password, certificatePem }),
  ankiSyncLogout: () => call('anki_sync_logout'),
  ankiSyncSetCertificate: (pem) => call('anki_sync_set_certificate', { pem }),
  ankiSync: () => call('anki_sync'),
  ankiSyncFull: (direction) => call('anki_sync_full', { direction }),
  ankiSyncNotify: (event) => call<void>('anki_sync_notify', { event }),
  onAnkiSync: (cb) =>
    subscription(() =>
      listen<AnkiSyncStatus>('anki://sync', (e) => {
        if (e.payload && typeof e.payload === 'object' && typeof e.payload.state === 'string') cb(e.payload);
      }),
    ),

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
  pickExportPath: (defaultName, kind) =>
    call<string | null>('export_pick_path', {
      defaultName,
      title: kind === 'apkg' ? t('anki.exportTitle') : t('reader.exportTitle'),
      kind: kind ?? 'pdf',
    }),
  pickImageFile: async () => {
    const picked = await openDialog({ multiple: false, directory: false, filters: IMAGE_FILTER });
    if (!picked) return null;
    return Array.isArray(picked) ? (picked[0] ?? null) : picked;
  },

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
