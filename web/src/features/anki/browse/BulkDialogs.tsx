import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Checkbox, Dialog } from '../../../components/ui';
import { t } from '../../../i18n';
import { q } from '../../../lib/core/queries';
import type { ForgetOptions } from '../../../lib/core/types';
import { TagsInput } from '../editor/TagsInput';
import { DeckPicker } from '../shared/DeckPicker';

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/** "Mover para outro deck". */
export function MoveDialog({
  open,
  onOpenChange,
  count,
  onMove,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count: number;
  onMove: (deckId: number) => Promise<unknown>;
}) {
  const [deckId, setDeckId] = useState<number | null>(null);
  const [busy, run] = useBusy();
  useEffect(() => {
    if (open) setDeckId(null);
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('anki.browse.moveTitle')}
      description={t(count === 1 ? 'anki.browse.moveDescriptionOne' : 'anki.browse.moveDescription', { n: count })}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={deckId === null}
            onClick={() => deckId !== null && void run(() => onMove(deckId))}
          >
            {t('anki.browse.move')}
          </Button>
        </>
      }
    >
      <DeckPicker value={deckId} onChange={setDeckId} label={t('anki.browse.moveTo')} />
    </Dialog>
  );
}

/** "Tags": add and remove tags on the selected notes. */
export function TagsDialog({
  open,
  onOpenChange,
  count,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count: number;
  onApply: (add: string[], remove: string[]) => Promise<unknown>;
}) {
  const tags = useQuery(q.tagsAll());
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [busy, run] = useBusy();
  useEffect(() => {
    if (open) {
      setAdd([]);
      setRemove([]);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('anki.browse.tagsTitle')}
      description={t(count === 1 ? 'anki.browse.tagsDescriptionOne' : 'anki.browse.tagsDescription', { n: count })}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!add.length && !remove.length}
            onClick={() => void run(() => onApply(add, remove))}
          >
            {t('anki.browse.tagsApply')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('anki.browse.tagsAdd')}</span>
          <TagsInput value={add} onChange={setAdd} suggestions={tags.data ?? []} label={t('anki.browse.tagsAdd')} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('anki.browse.tagsRemove')}</span>
          <TagsInput
            value={remove}
            onChange={setRemove}
            suggestions={tags.data ?? []}
            label={t('anki.browse.tagsRemove')}
          />
        </div>
      </div>
    </Dialog>
  );
}

/** "Esquecer": reset to new, with Anki's two options. */
export function ForgetDialog({
  open,
  onOpenChange,
  count,
  onForget,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count: number;
  onForget: (opts: ForgetOptions) => Promise<unknown>;
}) {
  const [opts, setOpts] = useState<ForgetOptions>({ restorePosition: true, resetCounts: false });
  const [busy, run] = useBusy();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('anki.browse.forgetTitle')}
      description={t(count === 1 ? 'anki.browse.forgetDescriptionOne' : 'anki.browse.forgetDescription', { n: count })}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void run(() => onForget(opts))}>
            {t('anki.browse.forget')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <Checkbox
          label={t('anki.browse.forgetRestorePosition')}
          checked={opts.restorePosition}
          onChange={(e) => setOpts((o) => ({ ...o, restorePosition: e.target.checked }))}
        />
        <Checkbox
          label={t('anki.browse.forgetResetCounts')}
          checked={opts.resetCounts}
          onChange={(e) => setOpts((o) => ({ ...o, resetCounts: e.target.checked }))}
        />
      </div>
    </Dialog>
  );
}

/** A yes/no confirmation (delete, change notetype). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const [busy, run] = useBusy();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={() => void run(onConfirm)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
