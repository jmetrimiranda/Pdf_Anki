import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { core } from '../../lib/core/client';
import { AnkiImportProvider, useAnkiImport } from '../anki/import/AnkiImportProvider';
import { useNarrow } from '../../lib/useMediaQuery';
import { leitor, LeitorHost } from '../leitor';
import { ReplaceVersionDialog } from '../library/BookDialogs';
import { useBookImport } from '../library/useBookImport';
import { SyncProvider } from '../sync/SyncProvider';
import { ShellContext, type ShellApi } from './context';
import { shellActionFor } from './shortcuts';
import { ShortcutsDialog } from './ShortcutsDialog';
import { TopBar } from './TopBar';

const isLeitorPath = (p: string) => p === '/leitor' || p.startsWith('/leitor/');

export function AppShell() {
  return (
    <AnkiImportProvider>
      <Shell />
    </AnkiImportProvider>
  );
}

function Shell() {
  const narrow = useNarrow();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [shortcuts, setShortcuts] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { importPaths: importBooks, addBooks, replacePrompt } = useBookImport();
  const ankiImport = useAnkiImport();
  const queryClient = useQueryClient();

  // Opened or dropped files (spec 8.5): PDFs go to the library, .apkg/.colpkg to the Anki import flows, in order.
  const importPaths = useCallback(
    (paths: string[], opts?: { openLast?: boolean }) =>
      ankiImport.openPaths(paths, (books) => importBooks(books, opts)),
    [ankiImport, importBooks],
  );

  // The collection changed outside the UI's own calls (import, Anki page, backup, sync): refresh the Anki tab.
  useEffect(() => core.onAnkiChanged(() => void queryClient.invalidateQueries({ queryKey: ['anki'] })), [queryClient]);

  const api = useMemo<ShellApi>(
    () => ({
      addBooks: () => void addBooks(),
      importPaths,
      showShortcuts: () => setShortcuts(true),
      dragging,
    }),
    [addBooks, importPaths, dragging],
  );

  // Spec 5.1 shortcuts. Keys typed inside the PdfCraft iframe never reach this document, except the
  // ones the reader forwards (Alt+1/2/3, Ctrl+Shift+P), so PdfCraft keeps all of its own shortcuts.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const action = shellActionFor(e);
      if (!action) return;
      e.preventDefault();
      switch (action.kind) {
        case 'tab':
          void navigate({ to: action.to });
          break;
        case 'togglePanel':
          leitor.togglePanel();
          break;
        case 'addBooks':
          void addBooks();
          break;
        case 'help':
          setShortcuts(true);
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, addBooks]);

  // Files dropped on the window: imported; when the Leitor is showing, the last one opens there.
  const onLeitor = useRef(isLeitorPath(pathname));
  onLeitor.current = isLeitorPath(pathname);
  useEffect(
    () =>
      core.onDragDropPaths(
        (paths) => void importPaths(paths, { openLast: onLeitor.current }),
        (hovering) => setDragging(hovering),
      ),
    [importPaths],
  );

  // "Abrir com": files given at launch (consumed once, so never dropped by a StrictMode remount), then the
  // ones forwarded by later launches.
  const launchPathsTaken = useRef(false);
  useEffect(() => {
    if (!launchPathsTaken.current) {
      launchPathsTaken.current = true;
      core
        .pendingOpenPaths()
        .then((paths) => {
          if (paths.length) void importPaths(paths, { openLast: true });
        })
        .catch(() => undefined);
    }
    return core.onOpenPaths((paths) => void importPaths(paths, { openLast: true }));
  }, [importPaths]);

  // Saving on tab switch and on window close belongs to the reader (LeitorHost handles both).
  return (
    <ShellContext.Provider value={api}>
      <SyncProvider>
        <div className="flex h-full flex-col bg-bg text-fg">
          <TopBar />
          <main className="relative min-h-0 flex-1 overflow-hidden">
            {/* Mounted once for the whole app session, so PdfCraft keeps its tabs and state. */}
            <LeitorHost />
            <Outlet />
          </main>
        </div>
      </SyncProvider>
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} sheet={narrow} />
      {replacePrompt && (
        <ReplaceVersionDialog book={replacePrompt.book} sheet={narrow} onAnswer={replacePrompt.answer} />
      )}
    </ShellContext.Provider>
  );
}
