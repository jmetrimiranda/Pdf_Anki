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

type Rect4 = [number, number, number, number];

/** The few mock core calls the bridge suites make (src/lib/core/types.ts has the full contract). */
interface MockCore {
  ankiDeckNames(): Promise<{ id: number; name: string }[]>;
  vocabSettingsSet(patch: { rootDeckId?: number | null }): Promise<{ config: unknown }>;
  vocabScanStart(
    uid: string,
    rootDeckId: number,
    excludedDeckIds: number[],
    range: { kind: 'all' },
    config: unknown,
  ): Promise<{ jobId: string; scanUid: string }>;
  onJobProgress(jobId: string, cb: (p: { stage: string }) => void): () => void;
  docWords(
    uid: string,
    page: number,
  ): Promise<{ page: number; width: number; height: number; words: { text: string; rects: Rect4[] }[] }>;
  vocabMarks(
    uid: string,
    pages: number[],
  ): Promise<{ page: number; marks: { lemma: string; form: string; status: string; rects: Rect4[] }[] }[]>;
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
      readonly listeningToOpenPaths: boolean;
      setNextExportPath(path: string | null): void;
      /** Simulates the OS opening a `leitor://` URL while the app runs. */
      deepLink(url: string): void;
      setPendingDeepLinks(urls: string[]): void;
      readonly anki: { readonly logs: ({ kind: string; at: number } & Record<string, unknown>)[] };
      readonly vocab: { readonly overrides: Record<string, string>; readonly textReads: number };
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
      setHighlight(uid: string, on: boolean): void;
      refreshVocab(uid?: string): void;
      vocab(): { on: readonly string[]; notScanned: readonly string[] };
      /** The mock core (only what the suites use). */
      core: MockCore;
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
