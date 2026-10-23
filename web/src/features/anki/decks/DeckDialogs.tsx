import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, Checkbox, Dialog, Field, Input, Notice, Skeleton } from '../../../components/ui';
import { t } from '../../../i18n';
import { CoreError } from '../../../lib/core/client';
import { q } from '../../../lib/core/queries';
import type { BackupInfo, DeckNode, ExportOptions } from '../../../lib/core/types';
import { formatNumber } from '../../../lib/format';
import { DeckPicker } from '../shared/DeckPicker';

export function errorMessage(err: unknown): string {
  return err instanceof CoreError || err instanceof Error ? err.message : t('errors.unexpected');
}

/** Error of a deck name (`::` separated, every part non-empty), or null when valid. */
export function deckNameError(name: string): string | null {
  if (!name.trim()) return t('anki.deck.nameEmpty');
  if (name.split('::').some((p) => !p.trim())) return t('anki.deck.namePartEmpty');
  return null;
}

/** `Pai::Filho` from the parent's full name and what the user typed (trimmed parts). */
export function subdeckName(parentFullName: string, typed: string): string {
  return `${parentFullName}::${typed
    .split('::')
    .map((p) => p.trim())
    .join('::')}`;
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

/** "Criar deck", "Criar subdeck" and "Renomear": one name field with validation. */
export function DeckNameDialog({
  open,
  onOpenChange,
  title,
  description,
  initial = '',
  confirmLabel,
  hint,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  initial?: string;
  confirmLabel: string;
  hint?: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);
  const { busy, error, run } = useBusy();
  const invalid = deckNameError(name);
  const shownError = (touched && invalid) || error;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    void run(() => onSubmit(name.trim()));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="deck-name-form"
            loading={busy}
            disabled={!!(touched && invalid)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id="deck-name-form" onSubmit={submit} className="pb-1">
        <Field label={t('anki.deck.nameLabel')} hint={hint} error={shownError || undefined}>
          {({ id, describedBy, invalid: inv }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={inv || undefined}
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setTouched(true);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

/** Parent of a deck in the picker's terms (null = top level), found among the tree's decks. */
export function parentIdOf(deck: DeckNode, all: DeckNode[]): number | null {
  const parentName = deck.fullName.split('::').slice(0, -1).join('::');
  if (!parentName) return null;
  let found: number | null = null;
  const walk = (ds: DeckNode[]) =>
    ds.forEach((d) => {
      if (d.fullName === parentName) found = d.id;
      walk(d.children);
    });
  walk(all);
  return found;
}

export function MoveDeckDialog({
  deck,
  initialParent,
  onOpenChange,
  onSubmit,
}: {
  deck: DeckNode;
  initialParent: number | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (parentId: number | null) => Promise<void>;
}) {
  const [parent, setParent] = useState<number | null>(initialParent);
  const { busy, error, run } = useBusy();
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={t('anki.deck.moveTitle', { name: deck.name })}
      description={t('anki.deck.moveDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={parent === initialParent}
            onClick={() => void run(() => onSubmit(parent))}
          >
            {t('anki.deck.moveConfirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-1">
        <DeckPicker
          label={t('anki.deck.moveTo')}
          value={parent}
          onChange={setParent}
          exclude={[deck.id]}
          allowTopLevel
        />
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}

export function ExportDeckDialog({
  deck,
  onOpenChange,
  onSubmit,
}: {
  deck: DeckNode;
  onOpenChange: (open: boolean) => void;
  onSubmit: (opts: ExportOptions) => Promise<void>;
}) {
  const [opts, setOpts] = useState<ExportOptions>({ withScheduling: true, withMedia: true });
  const { busy, error, run } = useBusy();
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={t('anki.export.title', { name: deck.name })}
      description={t('anki.export.description')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run(() => onSubmit(opts))}>
            {t('anki.export.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5 pb-1">
        <Checkbox
          label={t('anki.export.withScheduling')}
          checked={opts.withScheduling}
          onChange={(e) => setOpts((o) => ({ ...o, withScheduling: e.target.checked }))}
        />
        <Checkbox
          label={t('anki.export.withMedia')}
          checked={opts.withMedia}
          onChange={(e) => setOpts((o) => ({ ...o, withMedia: e.target.checked }))}
        />
        {error && (
          <Notice tone="error" className="mt-2">
            {error}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

export function DeleteDeckDialog({
  deck,
  onOpenChange,
  onConfirm,
}: {
  deck: DeckNode;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const { busy, error, run } = useBusy();
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={
        deck.total === 1
          ? t('anki.deck.deleteTitleOne', { name: deck.name })
          : t('anki.deck.deleteTitle', { name: deck.name, n: formatNumber(deck.total, 0) })
      }
      description={deck.children.length ? t('anki.deck.deleteBodySubdecks') : t('anki.deck.deleteBody')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void run(onConfirm)}>
            {t('anki.delete')}
          </Button>
        </>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

const BACKUP_KIND = {
  daily: 'anki.backups.kind.daily',
  preImport: 'anki.backups.kind.preImport',
  manual: 'anki.backups.kind.manual',
} as const;

/** "2,4 MB" (decimal units, like file managers). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${formatNumber(n, 0)} B`;
  if (n < 1_000_000) return `${formatNumber(n / 1000, 0)} kB`;
  if (n < 1_000_000_000) return `${formatNumber(Math.round(n / 100_000) / 10)} MB`;
  return `${formatNumber(Math.round(n / 100_000_000) / 10)} GB`;
}

function backupDate(ms: number): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
}

export function BackupsDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const backups = useQuery(q.backups());
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={t('anki.backups.title')}
      description={t('anki.backups.description')}
      className="w-[min(560px,calc(100vw-32px))]"
    >
      <div className="pb-2">
        {backups.isPending ? (
          <div className="flex flex-col gap-2 py-1" aria-busy="true">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : backups.isError ? (
          <Notice tone="error" onRetry={() => void backups.refetch()}>
            {errorMessage(backups.error)}
          </Notice>
        ) : !backups.data?.length ? (
          <p className="py-3 text-base text-muted">{t('anki.backups.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line" aria-label={t('anki.backups.title')}>
            {backups.data.map((b: BackupInfo) => (
              <li key={b.path} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 py-2 text-base">
                <span className="min-w-0">
                  <span className="block">{backupDate(b.createdAt)}</span>
                  <span className="block truncate text-xs text-muted" title={b.path}>
                    {b.fileName}
                  </span>
                </span>
                <span className="text-muted">{t(BACKUP_KIND[b.kind])}</span>
                <span className="w-20 text-right text-muted tabular-nums">{formatBytes(b.size)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
