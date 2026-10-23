import { useQueryClient } from '@tanstack/react-query';
import { FileKey, Layers, LogIn, LogOut, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Card, Dialog, Field, Input, Notice, Skeleton, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { core, CoreError } from '../../lib/core/client';
import type { AnkiSyncStatus } from '../../lib/core/types';
import { formatSyncedAgo } from '../../lib/format';
import { useNarrow } from '../../lib/useMediaQuery';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { useSyncUi } from '../sync/SyncProvider';
import { needsLoginAgain } from '../sync/SyncPill';
import { setSyncStatus, useNow, useSyncNow, useSyncStatus } from '../sync/useSyncStatus';

/** Bigger files are not a certificate (and are never read). */
export const MAX_CERTIFICATE_BYTES = 64 * 1024;

export function readTextFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

type FieldName = 'url' | 'user' | 'password' | 'certificate' | 'general';
type Errors = Partial<Record<FieldName, string>>;

/** Which field a core error belongs to (the rest show above the button). */
function fieldOf(code: string): FieldName {
  if (code === 'anki_sync_invalid_url' || code === 'anki_sync_anki_web_refused') return 'url';
  if (code === 'anki_sync_auth_failed') return 'password';
  if (code === 'anki_sync_invalid_certificate' || code === 'anki_sync_tls_untrusted') return 'certificate';
  return 'general';
}

function coreErrors(err: unknown): Errors {
  const code = err instanceof CoreError ? err.code : 'unknown';
  return { [fieldOf(code)]: errorMessage(err) };
}

export const isPlainHttp = (url: string) => /^\s*http:\/\//i.test(url);

/** "Certificado do servidor (opcional)": a PEM file read in the page (no path permission), or removed. */
function CertificateSection({
  status,
  error,
  onError,
  onPem,
}: {
  status: AnkiSyncStatus;
  error: string | undefined;
  onError: (message: string | undefined) => void;
  /** The PEM chosen now (passed again at login, so it applies whatever the stored state). */
  onPem: (pem: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  async function apply(pem: string | null) {
    setBusy(true);
    onError(undefined);
    try {
      const next = await core.ankiSyncSetCertificate(pem);
      setSyncStatus(queryClient, next);
      onPem(pem);
      toast.show(t(pem === null ? 'settings.anki.cert.removed' : 'settings.anki.cert.saved'), { tone: 'success' });
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_CERTIFICATE_BYTES) {
      onError(t('settings.anki.cert.tooLarge'));
      return;
    }
    let pem: string;
    try {
      pem = await readTextFile(file);
    } catch {
      onError(t('settings.anki.cert.readFailed'));
      return;
    }
    await apply(pem);
  }

  const fingerprint = status.certificateFingerprint;
  return (
    <section aria-labelledby="sync-cert-title" className="flex flex-col gap-2">
      <h3 id="sync-cert-title" className="text-base font-semibold">
        {t('settings.anki.cert.title')}
      </h3>
      <p className="text-xs text-muted">{t('settings.anki.cert.hint')}</p>
      <p className="text-xs" data-testid="sync-cert-fingerprint">
        {fingerprint ? (
          <span className="font-mono break-all">{t('settings.anki.cert.fingerprint', { valor: fingerprint })}</span>
        ) : (
          <span className="text-muted">{t('settings.anki.cert.none')}</span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".pem,.crt,.cer"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-testid="sync-cert-input"
          onChange={(e) => void onFile(e)}
        />
        <Button size="sm" icon={FileKey} loading={busy} onClick={() => input.current?.click()}>
          {t('settings.anki.cert.choose')}
        </Button>
        {fingerprint && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply(null)}>
            {t('settings.anki.cert.remove')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </section>
  );
}

function LogoutDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const narrow = useNarrow();

  async function logout() {
    setBusy(true);
    try {
      setSyncStatus(queryClient, await core.ankiSyncLogout());
      toast.show(t('settings.anki.loggedOut'), { tone: 'success' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      variant={narrow ? 'sheet' : 'center'}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={t('settings.anki.logoutTitle')}
      description={t('settings.anki.logoutBody')}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" icon={LogOut} loading={busy} onClick={() => void logout()}>
            {t('settings.anki.logout')}
          </Button>
        </>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

function LoggedIn({ status }: { status: AnkiSyncStatus }) {
  const now = useNow(30_000);
  const syncNow = useSyncNow();
  const ui = useSyncUi();
  const [logout, setLogout] = useState(false);
  const full = status.state === 'fullSyncRequired';
  const syncing = status.state === 'syncing' || syncNow.isPending;
  const lastLine =
    status.state === 'syncing'
      ? t('sync.syncing')
      : full
        ? t('sync.fullRequired')
        : status.lastSyncAt != null
          ? formatSyncedAgo(status.lastSyncAt, now)
          : t('sync.never');
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-base" data-testid="sync-connected">
          {t('sync.connectedAs', { user: status.user ?? '', url: status.url ?? '' })}
        </p>
        <p className="text-xs text-muted" data-testid="sync-last">
          {lastLine}
        </p>
      </div>
      {(status.state === 'error' || status.state === 'offline') && status.lastError && (
        <Notice tone="error">{status.lastError.message}</Notice>
      )}
      {full && <Notice tone="error">{t('sync.fullRequiredHint')}</Notice>}
      {status.mediaError && <Notice tone="error">{t('sync.mediaError', { mensagem: status.mediaError })}</Notice>}
      <div className="flex flex-wrap items-center gap-2">
        {full ? (
          // The core waits for the user's choice: reopen the full sync dialog (never decided here).
          <Button variant="primary" icon={Layers} onClick={() => ui.openFullSync()}>
            {t('sync.chooseCopy')}
          </Button>
        ) : (
          <Button variant="primary" icon={RefreshCw} loading={syncing} onClick={() => syncNow.mutate()}>
            {t('sync.now')}
          </Button>
        )}
        <Button variant="ghost" icon={LogOut} onClick={() => setLogout(true)}>
          {t('settings.anki.logout')}
        </Button>
      </div>
      {logout && <LogoutDialog onClose={() => setLogout(false)} />}
    </div>
  );
}

function LoginForm({ status, pem }: { status: AnkiSyncStatus; pem: string | null }) {
  const [url, setUrl] = useState(status.url ?? '');
  const [user, setUser] = useState(status.user ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const missing: Errors = {};
    if (!url.trim()) missing.url = t('settings.anki.urlEmpty');
    if (!user.trim()) missing.user = t('settings.anki.userEmpty');
    if (!password) missing.password = t('settings.anki.passwordEmpty');
    setErrors(missing);
    if (Object.keys(missing).length) return;
    setBusy(true);
    try {
      const next = await core.ankiSyncLogin(url.trim(), user.trim(), password, pem);
      setSyncStatus(queryClient, next);
      toast.show(t('settings.anki.loginDone'));
    } catch (err) {
      setErrors(coreErrors(err));
    } finally {
      // The password lives only in this field, and only until it is sent.
      setPassword('');
      setBusy(false);
    }
  }

  const clear = (name: FieldName) => setErrors(({ [name]: _, ...rest }) => rest);

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3"
      aria-label={t('settings.anki.server')}
    >
      {needsLoginAgain(status) && (
        <Notice tone="error">{t('sync.loggedOutBy', { mensagem: status.lastError!.message })}</Notice>
      )}
      <Field
        label={t('settings.anki.url')}
        error={errors.url}
        hint={
          isPlainHttp(url) ? (
            <span className="inline-flex items-center gap-1.5 text-fg" data-testid="sync-http-warning">
              <TriangleAlert size={13} aria-hidden className="shrink-0 text-error" />
              {t('settings.anki.urlHttp')}
            </span>
          ) : undefined
        }
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder={t('settings.anki.urlPlaceholder')}
            value={url}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              setUrl(e.target.value);
              clear('url');
            }}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('settings.anki.user')} error={errors.user}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="none"
              value={user}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                setUser(e.target.value);
                clear('user');
              }}
            />
          )}
        </Field>
        <Field label={t('settings.anki.password')} error={errors.password}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              value={password}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                setPassword(e.target.value);
                clear('password');
              }}
            />
          )}
        </Field>
      </div>
      {(errors.general ?? errors.certificate) && <Notice tone="error">{errors.general ?? errors.certificate}</Notice>}
      <Notice>{t('settings.anki.firstSync')}</Notice>
      <div>
        <Button type="submit" variant="primary" icon={LogIn} loading={busy}>
          {t('settings.anki.login')}
        </Button>
      </div>
    </form>
  );
}

/** Configurações → Anki e sincronização (spec 9, 18): server, login/logout, the server's certificate. */
export function AnkiSyncSettings() {
  const status = useSyncStatus();
  const [certError, setCertError] = useState<string | undefined>();
  const [pem, setPem] = useState<string | null>(null);
  // A certificate chosen while logged in is not re-sent at the next login once removed.
  useEffect(() => {
    if (!status?.certificateFingerprint) setPem(null);
  }, [status?.certificateFingerprint]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">{t('settings.section.anki')}</h2>
        <p className="text-base text-muted">{t('settings.anki.serverHint')}</p>
      </header>
      <Card title={t('settings.anki.server')}>
        {!status ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : status.loggedIn ? (
          <LoggedIn status={status} />
        ) : (
          <LoginForm key={`${status.url ?? ''}|${status.user ?? ''}`} status={status} pem={pem} />
        )}
      </Card>
      {status && (
        <Card>
          <CertificateSection status={status} error={certError} onError={setCertError} onPem={setPem} />
        </Card>
      )}
      <p className="text-xs text-muted">{t('settings.anki.help')}</p>
    </div>
  );
}
