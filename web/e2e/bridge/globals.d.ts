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
    };
    /** src/features/leitor/timings.ts (every mode). */
    readonly __leitorTimings?: {
      kind: 'first' | 'again';
      ms: number;
      frameStartMs?: number | null;
      wasmFetchedMs?: number | null;
    }[];
    __leitor?: {
      openBook(uid: string): Promise<boolean>;
      togglePanel(open?: boolean): void;
      flushSaves(reason?: string): Promise<boolean>;
      state(): {
        activeId: string | null;
        panelOpen: boolean;
        status: string;
        unsavedIds: string[];
        page: number;
        pageCount: number;
      };
    };
  }
}
