// The test handles the app installs in mock mode (src/lib/core/mock.ts, src/features/leitor/instance.ts), as seen
// from the e2e code (which doesn't compile the app sources).
export {};

interface MockBook {
  bookUid: string;
  title: string;
  pages: number;
  fileVersion: number;
  fileHash: string;
}

declare global {
  interface Window {
    __leitorMock?: {
      readonly books: MockBook[];
      readonly savedVersions: {
        uid: string;
        fileVersion: number;
        fileHash: string;
        size: number;
        hasBookUid: boolean;
      }[];
      readonly sessions: {
        kind: 'start' | 'heartbeat' | 'stop';
        uid: string | null;
        page: number | null;
        reason: string | null;
        at: number;
      }[];
      readonly positions: Record<string, { page: number; progress: number }>;
      readonly openedExternally: string[];
      readonly files: string[];
      reset(): void;
      openPaths(paths: string[]): void;
      setNextExportPath(path: string | null): void;
      /** Simulates the OS opening a `leitor://` URL while the app runs. */
      deepLink(url: string): void;
      setPendingDeepLinks(urls: string[]): void;
      readonly anki: { readonly logs: ({ kind: string; at: number } & Record<string, unknown>)[] };
    };
    /** src/features/leitor/timings.ts (every mode). */
    readonly __leitorTimings?: {
      kind: 'first' | 'again';
      ms: number;
      frameStartMs?: number | null;
      wasmFetchedMs?: number | null;
    }[];
    __leitor?: {
      openBook(uid: string, opts?: { page?: number; find?: string | null }): Promise<boolean>;
      togglePanel(open?: boolean): void;
      flushSaves(reason?: string): Promise<boolean>;
      requestCardFromSelection(via?: 'shortcut' | 'button'): void;
      setReviewing(on: boolean): void;
      state(): {
        activeId: string | null;
        panelOpen: boolean;
        status: string;
        unsavedIds: string[];
        page: number;
        pageCount: number;
        selection: { id: string; page: number; text: string; rects: [number, number, number, number][] } | null;
        found: { id: string; page: number; query: string; found: boolean } | null;
        menuShown: { id: string | null; items: { key: string; rect: [number, number, number, number] }[] } | null;
      };
    };
  }
}
