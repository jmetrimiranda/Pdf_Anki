import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  BookOpen,
  Blocks,
  ChevronDown,
  CloudOff,
  FlaskConical,
  Keyboard,
  Library,
  Moon,
  Plus,
  Settings,
  Sun,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton, Menu, Tooltip, type MenuEntry } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { useTheme } from '../../lib/theme';
import { useNarrow } from '../../lib/useMediaQuery';
import { useShell } from './context';
import { devRoutesEnabled } from './devRoutes';
import type { TabPath } from './shortcuts';

export type ActiveTab = 'library' | 'leitor' | 'anki' | 'other';

export function activeTabFromPath(pathname: string): ActiveTab {
  if (pathname.startsWith('/biblioteca')) return 'library';
  if (pathname === '/leitor' || pathname.startsWith('/leitor/')) return 'leitor';
  if (pathname.startsWith('/anki')) return 'anki';
  return 'other';
}

export function useActiveTab(): ActiveTab {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return activeTabFromPath(pathname);
}

/** The three app tabs of spec 5.1 (documents are tabs inside PdfCraft, not here). */
const APP_TABS: { to: TabPath; tab: ActiveTab; icon: typeof Library; label: () => string; shortcut: string }[] = [
  { to: '/biblioteca', tab: 'library', icon: Library, label: () => t('tabs.library'), shortcut: 'Ctrl+1' },
  { to: '/leitor', tab: 'leitor', icon: BookOpen, label: () => t('reader.tab'), shortcut: 'Ctrl+2' },
  { to: '/anki', tab: 'anki', icon: Blocks, label: () => t('tabs.anki'), shortcut: 'Ctrl+3' },
];

const tabClass = (active: boolean) =>
  cn(
    'group relative flex h-full shrink-0 items-center gap-2 border-b-2 px-3 text-base whitespace-nowrap transition-colors coarse:px-4',
    active ? 'border-lime font-semibold text-lime-dark' : 'border-transparent text-muted hover:text-fg',
  );

function TabsStrip() {
  const active = useActiveTab();
  return (
    <nav aria-label={t('tabs.label')} className="flex h-full min-w-0 flex-1 items-stretch">
      {APP_TABS.map(({ to, tab, icon: Icon, label }) => (
        <Link key={to} to={to} className={tabClass(active === tab)} aria-current={active === tab ? 'page' : undefined}>
          <Icon size={16} aria-hidden />
          {label()}
        </Link>
      ))}
    </nav>
  );
}

/** Narrow screens: the tabs become a single menu button (spec 5.1). */
function TabsMenu() {
  const active = useActiveTab();
  const navigate = useNavigate();
  const current = APP_TABS.find((x) => x.tab === active)?.label() ?? t('app.name');
  const items: MenuEntry[] = APP_TABS.map(({ to, tab, icon, label, shortcut }) => ({
    label: label(),
    icon,
    shortcut,
    checked: active === tab,
    onSelect: () => void navigate({ to }),
  }));
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
    { label: t('library.add'), icon: Plus, shortcut: 'Ctrl+O', onSelect: shell.addBooks },
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
