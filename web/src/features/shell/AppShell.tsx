import { Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { getDocTabs } from '../../lib/tabs';
import { useNarrow } from '../../lib/useMediaQuery';
import { ShellContext, type ShellApi } from './context';
import { OpenFileDialog } from './OpenFileDialog';
import { isTypingTarget } from './shortcuts';
import { ShortcutsDialog } from './ShortcutsDialog';
import { activeTabFromPath, TopBar, useCloseTab } from './TopBar';

type TabTarget = { to: '/biblioteca' } | { to: '/anki' } | { to: '/doc/$docId'; params: { docId: string } };

function tabOrder(): TabTarget[] {
  return [
    { to: '/biblioteca' },
    ...getDocTabs().map((tab) => ({ to: '/doc/$docId' as const, params: { docId: tab.docId } })),
    { to: '/anki' },
  ];
}

export function AppShell() {
  const narrow = useNarrow();
  const navigate = useNavigate();
  const closeTab = useCloseTab();
  const [openFile, setOpenFile] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);

  const api = useMemo<ShellApi>(
    () => ({ openFile: () => setOpenFile(true), showShortcuts: () => setShortcuts(true) }),
    [],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const active = activeTabFromPath(window.location.pathname);
      if (ctrl && e.key === 'Tab') {
        e.preventDefault();
        const order = tabOrder();
        const current = order.findIndex((x) =>
          x.to === '/doc/$docId'
            ? active.kind === 'doc' && active.docId === x.params.docId
            : x.to === `/${active.kind === 'library' ? 'biblioteca' : active.kind}`,
        );
        const next = order[(Math.max(current, 0) + (e.shiftKey ? -1 : 1) + order.length) % order.length];
        if (next) void navigate(next);
      } else if (ctrl && !e.shiftKey && key === 'w') {
        if (active.kind === 'doc') {
          e.preventDefault();
          closeTab(active.docId);
        }
      } else if (ctrl && e.shiftKey && key === 'a') {
        e.preventDefault();
        void navigate({ to: '/anki' });
      } else if (ctrl && !e.shiftKey && key === 'o') {
        e.preventDefault();
        setOpenFile(true);
      } else if (e.key === '?' && !ctrl && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setShortcuts(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, closeTab]);

  return (
    <ShellContext.Provider value={api}>
      <div className="flex h-full flex-col bg-bg text-fg">
        <TopBar />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <OpenFileDialog open={openFile} onOpenChange={setOpenFile} sheet={narrow} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} sheet={narrow} />
    </ShellContext.Provider>
  );
}
