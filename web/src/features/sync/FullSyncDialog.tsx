import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { Button, Dialog, Notice, Spinner, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import type { FullSyncChoice, FullSyncDirection } from '../../lib/core/types';
import { useNarrow } from '../../lib/useMediaQuery';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { setSyncStatus } from './useSyncStatus';

/** A full-width choice with a wrapping label (the download label is long, and must stay whole). */
function Choice({
  ref,
  icon: Icon,
  primary,
  disabled,
  reason,
  onClick,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  icon: LucideIcon;
  primary?: boolean;
  disabled: boolean;
  reason: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  const reasonId = useId();
  return (
    <div className="flex flex-col gap-1">
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-describedby={reason ? reasonId : undefined}
        onClick={onClick}
        className={cn(
          'flex min-h-10 w-full items-center gap-2.5 rounded-ctl border px-3 py-2 text-left text-base transition-colors disabled:pointer-events-none disabled:opacity-50 coarse:min-h-11',
          primary
            ? 'border-lime-dark bg-lime font-semibold text-on-lime hover:bg-lime-dark'
            : 'border-line bg-neutral text-fg hover:bg-active',
        )}
      >
        <Icon size={16} aria-hidden className="shrink-0" />
        <span className="min-w-0">{children}</span>
      </button>
      {reason && (
        <p id={reasonId} className="pl-1 text-xs text-muted">
          {reason}
        </p>
      )}
    </div>
  );
}

type Step = 'choose' | 'confirmUpload' | 'running';

/**
 * "Sincronização completa necessária" (spec 9). The user picks which copy stays; download is the recommended one and
 * has the initial focus; upload needs a second confirmation. Enter and Esc never upload: Esc closes ("Agora não", the
 * status stays), and the upload confirmation starts on "Cancelar" (Esc there goes back). The core makes a backup
 * before either direction.
 */
export function FullSyncDialog({ choice, onClose }: { choice: FullSyncChoice; onClose: () => void }) {
  const [step, setStep] = useState<Step>('choose');
  const [error, setError] = useState<string | null>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const narrow = useNarrow();

  // One dialog, two steps: moving between them moves the focus (never onto the upload confirmation).
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    if (step === 'confirmUpload') cancelRef.current?.focus();
    else if (step === 'choose') (uploadRef.current?.disabled ? laterRef : uploadRef).current?.focus();
  }, [step]);

  async function run(direction: FullSyncDirection) {
    setStep('running');
    setError(null);
    try {
      const result = await core.ankiSyncFull(direction);
      setSyncStatus(queryClient, result.status);
      void queryClient.invalidateQueries({ queryKey: ['anki'] });
      toast.show(t('sync.full.done', { nome: result.backup.fileName }), { tone: 'success', durationMs: 8000 });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setStep('choose');
    }
  }

  const confirming = step === 'confirmUpload';
  const busy = step === 'running';
  return (
    <Dialog
      open
      variant={narrow ? 'sheet' : 'center'}
      onOpenChange={(o) => {
        if (o || busy) return;
        if (confirming) setStep('choose');
        else onClose();
      }}
      title={confirming ? t('sync.full.confirmTitle') : t('sync.full.title')}
      description={confirming ? t('sync.full.confirmBody') : t('sync.full.body')}
      initialFocus={choice.downloadOk ? downloadRef : laterRef}
      footer={
        confirming ? (
          <>
            <Button ref={cancelRef} variant="ghost" onClick={() => setStep('choose')}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" icon={Upload} onClick={() => void run('upload')}>
              {t('sync.full.upload')}
            </Button>
          </>
        ) : (
          <Button ref={laterRef} variant="ghost" disabled={busy} onClick={onClose}>
            {t('sync.full.later')}
          </Button>
        )
      }
    >
      {!confirming && (
        <div className="flex flex-col gap-3 pb-1">
          <Choice
            ref={downloadRef}
            icon={Download}
            primary
            disabled={busy || !choice.downloadOk}
            reason={choice.downloadOk ? null : t('sync.full.noDownload')}
            onClick={() => void run('download')}
          >
            {t('sync.full.download')}
          </Choice>
          <Choice
            ref={uploadRef}
            icon={Upload}
            disabled={busy || !choice.uploadOk}
            reason={choice.uploadOk ? null : t('sync.full.noUpload')}
            onClick={() => setStep('confirmUpload')}
          >
            {t('sync.full.upload')}
          </Choice>
          {busy && (
            <p className="flex items-center gap-2 text-base text-muted" aria-live="polite">
              <Spinner label={t('sync.full.running')} />
              {t('sync.full.running')}
            </p>
          )}
          {error && <Notice tone="error">{t('sync.full.failed', { mensagem: error })}</Notice>}
        </div>
      )}
    </Dialog>
  );
}
