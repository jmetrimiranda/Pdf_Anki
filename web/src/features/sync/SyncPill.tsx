import { Link } from '@tanstack/react-router';
import {
  CloudAlert,
  CloudCheck,
  CloudOff,
  RefreshCw,
  Settings,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { forwardRef, useState, type ButtonHTMLAttributes } from 'react';
import { Button, Popover, Spinner, Tooltip } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { AnkiSyncStatus, SyncState } from '../../lib/core/types';
import { formatClock, formatSyncedAgo } from '../../lib/format';
import { useSyncUi } from './SyncProvider';
import { useNow, useSyncNow, useSyncStatus } from './useSyncStatus';

/**
 * Logged out by the core, not by the user: the server refused the stored key (or the keychain could not be read).
 * The status keeps the reason in `lastError` so the pill and the settings ask to log in again.
 */
export function needsLoginAgain(s: AnkiSyncStatus | undefined): boolean {
  return s?.state === 'off' && !!s.lastError;
}

/** What the pill says for a status at `now` (pure; the pill re-renders every 30 s). */
export function syncPillText(s: AnkiSyncStatus | undefined, now: number): string {
  switch (s?.state ?? 'off') {
    case 'off':
      return needsLoginAgain(s) ? t('sync.loginAgain') : t('sync.off');
    case 'syncing':
      return t('sync.syncing');
    case 'offline':
      return t('sync.offline');
    case 'error':
      return t('sync.error');
    case 'fullSyncRequired':
      return t('sync.fullRequired');
    case 'idle':
      return s?.lastSyncAt != null ? formatSyncedAgo(s.lastSyncAt, now) : t('sync.never');
  }
}

/** The pill's tooltip, when it has one. */
export function syncPillHint(s: AnkiSyncStatus | undefined): string | null {
  const state = s?.state ?? 'off';
  if (state === 'off') return needsLoginAgain(s) ? s!.lastError!.message : t('sync.offHint');
  if (state === 'offline')
    return s?.nextRetryAt != null ? t('sync.retryAt', { hora: formatClock(s.nextRetryAt) }) : t('sync.retryOnline');
  if (state === 'fullSyncRequired') return t('sync.fullRequiredHint');
  return null;
}

const ICONS: Record<Exclude<SyncState, 'syncing'>, LucideIcon> = {
  off: CloudOff,
  idle: CloudCheck,
  offline: WifiOff,
  error: TriangleAlert,
  fullSyncRequired: CloudAlert,
};

const PillButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { state: SyncState; text: string; hint: string | null; alert: boolean }
>(function PillButton({ state, text, hint, alert, className, ...rest }, ref) {
  const Icon = state === 'syncing' ? null : ICONS[state];
  const button = (
    <button
      ref={ref}
      type="button"
      data-testid="sync-pill"
      data-sync-state={state}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors hover:bg-hover coarse:h-11 max-sm:px-2',
        alert ? 'border-[color-mix(in_srgb,var(--error)_35%,var(--border))] text-error' : 'border-line text-muted',
        className,
      )}
      {...rest}
    >
      {Icon ? (
        <Icon size={13} aria-hidden className={state === 'idle' ? 'text-lime-dark' : undefined} />
      ) : (
        <Spinner className="size-3" label={text} />
      )}
      <span className="max-sm:sr-only">{text}</span>
    </button>
  );
  return hint ? <Tooltip content={hint}>{button}</Tooltip> : button;
});

/** The popover's body: status, errors, "Sincronizar agora" and the link to the settings. */
function SyncPopoverBody({
  status,
  now,
  onDone,
}: {
  status: AnkiSyncStatus | undefined;
  now: number;
  onDone: () => void;
}) {
  const syncNow = useSyncNow();
  const state = status?.state ?? 'off';
  const loggedIn = !!status?.loggedIn;
  const syncing = state === 'syncing' || syncNow.isPending;
  const loginAgain = needsLoginAgain(status);
  const showError = (state === 'error' || state === 'offline' || loginAgain) && status?.lastError;
  return (
    <div className="flex flex-col gap-2.5 text-base">
      <div>
        <p className="font-semibold">{syncPillText(status, now)}</p>
        {loggedIn && status?.user && status.url && (
          <p className="truncate text-xs text-muted" title={status.url}>
            {t('sync.connectedAs', { user: status.user, url: status.url })}
          </p>
        )}
        {!loggedIn && !loginAgain && <p className="text-xs text-muted">{t('sync.offHint')}</p>}
      </div>
      {state === 'offline' && <p className="text-xs text-muted">{syncPillHint(status)}</p>}
      {showError && (
        <p className="text-xs text-error">
          {loginAgain ? t('sync.loggedOutBy', { mensagem: status.lastError!.message }) : status.lastError!.message}
        </p>
      )}
      {status?.mediaSyncing && <p className="text-xs text-muted">{t('sync.mediaSyncing')}</p>}
      {status?.mediaError && (
        <p className="text-xs text-error">{t('sync.mediaError', { mensagem: status.mediaError })}</p>
      )}
      {status?.serverMessage && (
        <p className="text-xs text-muted">{t('sync.serverMessage', { mensagem: status.serverMessage })}</p>
      )}
      {loggedIn && (
        <Button
          size="sm"
          variant="primary"
          icon={RefreshCw}
          className="w-full"
          loading={syncing}
          disabled={state === 'fullSyncRequired'}
          onClick={() => syncNow.mutate()}
        >
          {t('sync.now')}
        </Button>
      )}
      <Link
        to="/configuracoes/anki"
        onClick={onDone}
        className="inline-flex items-center gap-1.5 self-start text-xs text-link hover:underline coarse:min-h-11"
      >
        <Settings size={13} aria-hidden />
        {t('sync.settingsLink')}
      </Link>
    </div>
  );
}

/**
 * The sync status in the top bar (spec 9): "Sincronizado há 2 min", "Sem conexão"… Click: a popover with the details
 * and "Sincronizar agora"; while a full sync is required it reopens the choice dialog instead. Narrow screens show
 * only the icon (the text stays for screen readers).
 */
export function SyncPill() {
  const status = useSyncStatus();
  const now = useNow(30_000);
  const ui = useSyncUi();
  const [open, setOpen] = useState(false);
  const state = status?.state ?? 'off';
  const text = syncPillText(status, now);
  const hint = syncPillHint(status);
  const alert = state === 'error' || state === 'fullSyncRequired' || needsLoginAgain(status);

  if (state === 'fullSyncRequired') {
    return (
      <PillButton
        state={state}
        text={text}
        hint={hint}
        alert={alert}
        aria-haspopup="dialog"
        aria-label={`${t('sync.pillLabel')}: ${text}`}
        onClick={() => ui.openFullSync()}
      />
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={
        <PillButton
          state={state}
          text={text}
          hint={hint}
          alert={alert}
          aria-label={`${t('sync.pillLabel')}: ${text}`}
        />
      }
    >
      <SyncPopoverBody status={status} now={now} onDone={() => setOpen(false)} />
    </Popover>
  );
}
