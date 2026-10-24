// Configurações → Anki e sincronização → "Biblioteca entre aparelhos" (spec 16, Fase 9a): connect this device to the
// library server (the password only goes to the server; the device token stays in the keychain), the last sync, its
// progress and errors, the conflict copies, "Sincronizar agora" and "Desconectar".
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Field, Input, Notice, ProgressBar, Skeleton, useToast } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { core } from '../../lib/core/client';
import type { LibrarySyncStatus } from '../../lib/core/types';
import { formatSyncedAgo } from '../../lib/format';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { useNow } from '../sync/useSyncStatus';

export const librarySyncQ = {
  queryKey: ['librarySync'] as const,
  queryFn: () => core.librarySyncStatus(),
};

/** The status, kept fresh by `library://sync`; the library list refreshes when a run ends. */
export function useLibrarySyncStatus(): LibrarySyncStatus | undefined {
  const qc = useQueryClient();
  const q = useQuery(librarySyncQ);
  useEffect(
    () =>
      core.onLibrarySync((s) => {
        const before = qc.getQueryData<LibrarySyncStatus>(librarySyncQ.queryKey);
        qc.setQueryData(librarySyncQ.queryKey, s);
        if (!s.running && s.lastSyncAt !== before?.lastSyncAt) void qc.invalidateQueries({ queryKey: ['library'] });
      }),
    [qc],
  );
  return q.data;
}

const DEFAULT_URL = 'https://leitor-sync.jmetrimirandai.com';

function ConnectForm({ status }: { status: LibrarySyncStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState(status.url ?? DEFAULT_URL);
  const [user, setUser] = useState(status.user ?? '');
  const [password, setPassword] = useState('');
  const [device, setDevice] = useState(status.device);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || !user.trim() || !password) {
      setError(t('librarySync.empty'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(librarySyncQ.queryKey, await core.librarySyncLogin(url.trim(), user.trim(), password, device));
      toast.show(t('librarySync.connected'), { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      // The password lives only in this field, and only until it is sent.
      setPassword('');
      setBusy(false);
    }
  }

  const field = (label: MessageKey, value: string, set: (v: string) => void, extra: Record<string, unknown> = {}) => (
    <Field label={t(label)} hint={label === 'librarySync.device' ? t('librarySync.deviceHint') : undefined}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          spellCheck={false}
          value={value}
          onChange={(e) => set(e.target.value)}
          {...extra}
        />
      )}
    </Field>
  );

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" aria-label={t('librarySync.title')}>
      {field('librarySync.url', url, setUrl, { type: 'url', inputMode: 'url', placeholder: t('librarySync.urlPlaceholder') })}
      {field('librarySync.user', user, setUser, { autoComplete: 'username' })}
      {field('librarySync.password', password, setPassword, { type: 'password', autoComplete: 'current-password' })}
      {field('librarySync.device', device, setDevice)}
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" icon={LogIn} loading={busy} className="self-start">
        {t('librarySync.connect')}
      </Button>
    </form>
  );
}

function Connected({ status }: { status: LibrarySyncStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<'now' | 'out' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'now' | 'out') {
    setBusy(kind);
    setError(null);
    try {
      const next = kind === 'now' ? await core.librarySyncNow() : await core.librarySyncLogout();
      qc.setQueryData(librarySyncQ.queryKey, next);
      if (kind === 'now') void qc.invalidateQueries({ queryKey: ['library'] });
      toast.show(t(kind === 'now' ? 'librarySync.done' : 'librarySync.disconnected'), { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const p = status.progress;
  return (
    <div className="flex flex-col gap-3" data-testid="library-sync">
      <p className="text-base break-words">
        {t('librarySync.as', { usuario: status.user ?? '', servidor: status.url ?? '', aparelho: status.device })}
      </p>
      <p className="text-xs text-muted" data-testid="library-sync-last">
        {status.running
          ? t('librarySync.running')
          : status.lastSyncAt != null
            ? formatSyncedAgo(status.lastSyncAt, now)
            : t('librarySync.never')}
      </p>
      {p && (
        <div className="flex flex-col gap-1">
          <p className="text-xs">{t(`librarySync.stage.${p.stage}` as MessageKey)}</p>
          <ProgressBar label={t(`librarySync.stage.${p.stage}` as MessageKey)} value={p.done} max={p.total || 1} />
        </div>
      )}
      {status.lastError && <Notice tone="error">{status.lastError.message}</Notice>}
      {status.conflicts.length > 0 && (
        <Notice
          tone="info"
          onDismiss={() =>
            void core.librarySyncClearConflicts().then((next) => qc.setQueryData(librarySyncQ.queryKey, next))
          }
        >
          <span className="flex flex-col gap-1" data-testid="library-sync-conflicts">
            <span>{t('librarySync.conflicts')}</span>
            {status.conflicts.map((c) => (
              <span key={c} className="font-semibold">
                {c}
              </span>
            ))}
          </span>
        </Notice>
      )}
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={RefreshCw}
          loading={busy === 'now' || status.running}
          disabled={busy !== null || status.running}
          onClick={() => void run('now')}
        >
          {t('librarySync.now')}
        </Button>
        <Button variant="ghost" icon={LogOut} loading={busy === 'out'} disabled={busy !== null} onClick={() => void run('out')}>
          {t('librarySync.disconnect')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('librarySync.when')}</p>
    </div>
  );
}

export function LibrarySyncSettings() {
  const status = useLibrarySyncStatus();
  return (
    <Card title={t('librarySync.title')}>
      <p className="mb-3 text-xs text-muted">{t('librarySync.hint')}</p>
      {!status ? (
        <Skeleton className="h-24" />
      ) : status.loggedIn ? (
        <Connected status={status} />
      ) : (
        <ConnectForm key={`${status.url ?? ''}|${status.user ?? ''}`} status={status} />
      )}
    </Card>
  );
}
