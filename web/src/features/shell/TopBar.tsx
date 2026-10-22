import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Blocks,
  ChevronDown,
  CloudOff,
  FileText,
  FlaskConical,
  FolderOpen,
  Keyboard,
  Library,
  Moon,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';
import { IconButton, Menu, Tooltip, type MenuEntry } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import { closeDocTab, moveDocTab, useDocTabs, type DocTab } from '../../lib/tabs';
import { useTheme } from '../../lib/theme';
import { useNarrow } from '../../lib/useMediaQuery';
import { useShell } from './context';
import { devRoutesEnabled } from './devRoutes';

export type ActiveTab = { kind: 'library' } | { kind: 'anki' } | { kind: 'doc'; docId: string } | { kind: 'other' };

export function activeTabFromPath(pathname: string): ActiveTab {
  if (pathname.startsWith('/biblioteca')) return { kind: 'library' };
  if (pathname.startsWith('/anki')) return { kind: 'anki' };
  const m = /^\/doc\/([^/]+)/.exec(pathname);
  if (m?.[1]) return { kind: 'doc', docId: decodeURIComponent(m[1]) };
  return { kind: 'other' };
}

export function useActiveTab(): ActiveTab {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return activeTabFromPath(pathname);
}

/**
 * Closes a document tab, moves to its neighbour (or the library) when it was active, and releases the
 * document in the core (spec 6.2: bounded memory) once the reader no longer shows it.
 */
export function useCloseTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = useActiveTab();
  return (docId: string) => {
    const next = closeDocTab(docId);
    const release = () => {
      queryClient.removeQueries({ queryKey: ['doc', docId] });
      // The core may have dropped it already (e.g. after a restart); nothing else to free then.
      core.docClose(docId).catch(() => undefined);
    };
    if (active.kind === 'doc' && active.docId === docId) {
      const nav = next
        ? navigate({ to: '/doc/$docId', params: { docId: next.docId } })
        : navigate({ to: '/biblioteca' });
      void nav.finally(release);
    } else {
      release();
    }
  };
}

const tabClass = (active: boolean) =>
  cn(
    'group relative flex h-full shrink-0 items-center gap-2 border-b-2 px-3 text-base whitespace-nowrap transition-colors coarse:px-4',
    active ? 'border-lime font-semibold text-lime-dark' : 'border-transparent text-muted hover:text-fg',
  );

function FixedTab({
  to,
  icon: Icon,
  label,
  active,
}: {
  to: '/biblioteca' | '/anki';
  icon: typeof Library;
  label: string;
  active: boolean;
}) {
  return (
    <Link to={to} className={tabClass(active)} aria-current={active ? 'page' : undefined}>
      <Icon size={16} aria-hidden />
      {label}
    </Link>
  );
}

function DocTabLink({
  tab,
  index,
  active,
  onClose,
  dragIndex,
  setDragIndex,
}: {
  tab: DocTab;
  index: number;
  active: boolean;
  onClose: () => void;
  dragIndex: number | null;
  setDragIndex: (i: number | null) => void;
}) {
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null);

  function onDragOver(e: DragEvent) {
    if (dragIndex === null) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setDropSide(e.clientX < box.left + box.width / 2 ? 'left' : 'right');
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    if (dragIndex !== null && dropSide) {
      let to = dropSide === 'left' ? index : index + 1;
      if (dragIndex < to) to -= 1;
      moveDocTab(dragIndex, to);
    }
    setDropSide(null);
    setDragIndex(null);
  }

  return (
    <div
      className={cn('group/tab relative flex h-full shrink-0', dragIndex === index && 'opacity-50')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.docId);
        setDragIndex(index);
      }}
      onDragEnd={() => setDragIndex(null)}
      onDragOver={onDragOver}
      onDragLeave={() => setDropSide(null)}
      onDrop={onDrop}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onMouseDown={(e) => {
        // Stops Linux middle-click autoscroll/paste on the tab.
        if (e.button === 1) e.preventDefault();
      }}
    >
      {dropSide && (
        <span
          aria-hidden
          className={cn('absolute inset-y-2 w-0.5 rounded-full bg-lime', dropSide === 'left' ? 'left-0' : 'right-0')}
        />
      )}
      <Link
        to="/doc/$docId"
        params={{ docId: tab.docId }}
        className={cn(tabClass(active), 'max-w-56 pr-8')}
        aria-current={active ? 'page' : undefined}
        title={tab.title}
        draggable={false}
      >
        <FileText size={15} aria-hidden className="shrink-0" />
        <span className="truncate">{tab.title}</span>
      </Link>
      <button
        type="button"
        aria-label={t('tabs.close', { title: tab.title })}
        onClick={onClose}
        className={cn(
          'absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-[4px] text-muted hover:bg-active hover:text-fg coarse:size-8',
          !active && 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 coarse:opacity-100',
        )}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}

function TabsStrip() {
  const tabs = useDocTabs();
  const active = useActiveTab();
  const close = useCloseTab();
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  return (
    <nav aria-label={t('tabs.label')} className="flex h-full min-w-0 flex-1 items-stretch">
      <FixedTab to="/biblioteca" icon={Library} label={t('tabs.library')} active={active.kind === 'library'} />
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab, i) => (
          <DocTabLink
            key={tab.docId}
            tab={tab}
            index={i}
            active={active.kind === 'doc' && active.docId === tab.docId}
            onClose={() => close(tab.docId)}
            dragIndex={dragIndex}
            setDragIndex={setDragIndex}
          />
        ))}
      </div>
      <FixedTab to="/anki" icon={Blocks} label={t('tabs.anki')} active={active.kind === 'anki'} />
    </nav>
  );
}

/** Narrow screens: the tabs become a single menu button (spec 5.1). */
function TabsMenu() {
  const tabs = useDocTabs();
  const active = useActiveTab();
  const navigate = useNavigate();
  const close = useCloseTab();
  const current =
    active.kind === 'library'
      ? t('tabs.library')
      : active.kind === 'anki'
        ? t('tabs.anki')
        : active.kind === 'doc'
          ? (tabs.find((x) => x.docId === active.docId)?.title ?? t('tabs.document'))
          : t('app.name');

  const items: MenuEntry[] = [
    {
      label: t('tabs.library'),
      icon: Library,
      checked: active.kind === 'library',
      onSelect: () => void navigate({ to: '/biblioteca' }),
    },
    ...(tabs.length ? [{ kind: 'separator' as const }, { kind: 'label' as const, label: t('tabs.openDocs') }] : []),
    ...tabs.map((tab) => ({
      label: tab.title,
      icon: FileText,
      checked: active.kind === 'doc' && active.docId === tab.docId,
      onSelect: () => void navigate({ to: '/doc/$docId', params: { docId: tab.docId } }),
    })),
    ...(active.kind === 'doc' ? [{ label: t('tabs.closeCurrent'), icon: X, onSelect: () => close(active.docId) }] : []),
    { kind: 'separator' },
    {
      label: t('tabs.anki'),
      icon: Blocks,
      checked: active.kind === 'anki',
      onSelect: () => void navigate({ to: '/anki' }),
    },
  ];

  return (
    <Menu
      align="start"
      label={t('tabs.label')}
      items={items}
      trigger={
        <button
          type="button"
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-ctl px-2 text-base font-semibold hover:bg-hover coarse:h-11"
        >
          <span className="truncate">{current}</span>
          <ChevronDown size={15} aria-hidden className="shrink-0 text-muted" />
        </button>
      }
    />
  );
}

function SyncPill() {
  return (
    <Tooltip content={t('sync.offHint')}>
      <span
        tabIndex={0}
        className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs text-muted"
      >
        <CloudOff size={13} aria-hidden />
        <span className="max-sm:sr-only">{t('sync.off')}</span>
      </span>
    </Tooltip>
  );
}

function SettingsMenu() {
  const [theme, setTheme] = useTheme();
  const shell = useShell();
  const navigate = useNavigate();
  const items: MenuEntry[] = [
    { kind: 'label', label: t('theme.label') },
    { label: t('theme.light'), icon: Sun, checked: theme === 'light', onSelect: () => setTheme('light') },
    { label: t('theme.dark'), icon: Moon, checked: theme === 'dark', onSelect: () => setTheme('dark') },
    { kind: 'separator' },
    { label: t('library.openFile'), icon: FolderOpen, shortcut: 'Ctrl+O', onSelect: shell.openFile },
    { label: t('shortcuts.title'), icon: Keyboard, shortcut: '?', onSelect: shell.showShortcuts },
  ];
  if (devRoutesEnabled) {
    items.push(
      { kind: 'separator' },
      { kind: 'label', label: t('dev.section') },
      { label: t('dev.ui.title'), icon: Blocks, onSelect: () => void navigate({ to: '/dev/ui' }) },
      { label: t('dev.smoke.title'), icon: FlaskConical, onSelect: () => void navigate({ to: '/dev/smoke' }) },
    );
  }
  return (
    <Menu
      label={t('settings.label')}
      items={items}
      trigger={<IconButton icon={Settings} label={t('settings.label')} />}
    />
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  const narrow = useNarrow();
  return (
    <header className="flex h-11 shrink-0 items-stretch gap-2 border-b border-line bg-bg pr-2 pl-1 coarse:h-14">
      {narrow ? (
        <div className="flex min-w-0 flex-1 items-center pl-1">
          <TabsMenu />
        </div>
      ) : (
        <TabsStrip />
      )}
      <div className="flex shrink-0 items-center gap-1 border-l border-line pl-2">
        <SyncPill />
        <SettingsMenu />
        {children}
      </div>
    </header>
  );
}
