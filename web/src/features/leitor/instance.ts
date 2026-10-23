// The single LeitorController of the app, wired to the real (or mock) core.
import { useSyncExternalStore } from 'react';
import { core, type CoreClient } from '../../lib/core/client';
import type { FlushReason } from './autosave';
import { LeitorController, type LeitorCore, type LeitorSnapshot } from './controller';
import type { LeitorTiming } from './timings';

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/** Adapts the app's `CoreClient` to what the controller needs. */
export function leitorCore(c: CoreClient): LeitorCore {
  // Session commands are fired without awaiting and each Tauri command runs on its own blocking
  // task, so they are chained here to reach the core in the order the controller sent them.
  let sessionChain: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(call: () => Promise<T>): Promise<T> => {
    const next = sessionChain.then(call);
    sessionChain = next.catch(() => undefined);
    return next;
  };
  return {
    openInfo: async (uid) => {
      const { book, page } = await c.bookOpen(uid);
      return { name: book.fileName, title: book.title, page, pages: book.pages, fileVersion: book.fileVersion };
    },
    bytes: (uid) => c.bookBytes(uid),
    saveVersion: async (uid, bytes, baseVersion) => {
      const saved = await c.bookSaveVersion(uid, exactBuffer(bytes), baseVersion);
      return { fileVersion: saved.fileVersion, keptNewer: saved.keptNewer };
    },
    pickExportPath: (name) => c.pickExportPath(name),
    exportBook: (uid, path) => c.bookExport(uid, path),
    exportBytes: (path, bytes) => c.exportBytes(path, exactBuffer(bytes)),
    openExternal: (uid) => c.bookOpenExternal(uid),
    positionSet: (uid, page, progress) => c.positionSet(uid, page, progress),
    setPages: async (uid, pages) => {
      await c.libraryUpdate(uid, { pages });
    },
    sessionStart: (uid, page) => inOrder(() => c.readingSessionStart(uid, page)),
    sessionHeartbeat: (uid, page) => inOrder(() => c.readingSessionHeartbeat(uid, page)),
    sessionStop: (uid, reason) => inOrder(() => c.readingSessionStop(uid, reason)),
    log: (level, message) => {
      if (import.meta.env.DEV && level !== 'info') console.warn(message);
      void c.devLog(level, message).catch(() => {});
    },
  };
}

const controller = new LeitorController({ core: leitorCore(core) });

/** For LeitorHost and tests; the shell uses `leitor`. */
export function leitorController(): LeitorController {
  return controller;
}

export const leitor = {
  openBook: (uid: string): Promise<boolean> => controller.openBook(uid),
  togglePanel: (open?: boolean): void => controller.togglePanel(open),
  flushSaves: (reason: FlushReason = 'manual'): Promise<boolean> => controller.flushSaves(reason),
};

export function useLeitorState(): LeitorSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
}

declare global {
  interface Window {
    /** Mock mode only: lets Playwright drive the Leitor (flushSaves, state). */
    __leitor?: typeof leitor & { state: () => LeitorSnapshot };
    /** Every mode: how long the Leitor tab took to show up (read-only copy; e2e specs and the real-app probe). */
    readonly __leitorTimings?: LeitorTiming[];
  }
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__leitorTimings', { get: () => controller.timings.entries(), configurable: true });
}

if (core.kind === 'mock' && typeof window !== 'undefined') {
  window.__leitor = { ...leitor, state: controller.snapshot };
}
