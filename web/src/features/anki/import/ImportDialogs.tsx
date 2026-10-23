import { useState } from 'react';
import { Button, Checkbox, Dialog, Notice, Spinner, useToast } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import type { ImportSummary } from '../../../lib/core/types';
import { errorMessage } from '../decks/DeckDialogs';

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** "N notas adicionadas, M atualizadas" (+ duplicates/conflicts when there are any). */
export function importSummaryText(s: ImportSummary): string {
  const parts = [
    s.added === 1 ? t('anki.import.addedOne') : t('anki.import.added', { n: s.added }),
    s.updated === 1 ? t('anki.import.updatedOne') : t('anki.import.updated', { n: s.updated }),
  ];
  if (s.duplicates) parts.push(t('anki.import.duplicates', { n: s.duplicates }));
  if (s.conflicts) parts.push(t('anki.import.conflicts', { n: s.conflicts }));
  return parts.join(', ');
}

/** Blocking overlay while the core works (backup + import cannot be interrupted). */
export function BlockingProgress({ label }: { label: string }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={label}
      aria-busy="true"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay anim-fade"
    >
      <div className="flex items-center gap-3 rounded-box border border-line bg-card px-5 py-4 text-base shadow-popover">
        <Spinner label={label} />
        <span>{label}</span>
      </div>
    </div>
  );
}

/** A .apkg opened with the app (or dropped): confirm, import directly, show the summary. */
export function ApkgConfirmDialog({ path, onFinished }: { path: string; onFinished: (imported: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const summary = await core.ankiImport(path);
      toast.show(t('anki.import.done', { resumo: importSummaryText(summary) }), { tone: 'success' });
      onFinished(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onFinished(false);
      }}
      title={t('anki.import.apkgTitle', { nome: fileName(path) })}
      description={t('anki.import.apkgBody')}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onFinished(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>
            {t('anki.import.apkgConfirm')}
          </Button>
        </>
      }
    >
      {error && <Notice tone="error">{t('anki.import.failed', { mensagem: error })}</Notice>}
    </Dialog>
  );
}

type ColpkgStep = 'confirm' | 'sure' | 'running' | 'failed';

/**
 * Replacing the whole collection with a .colpkg (spec 8.5): "Substituir a coleção inteira?" → "Tem certeza?" with a
 * checkbox that enables "Substituir coleção" → blocking progress (the core makes a backup first) → toast with
 * the backup's file name, or the error.
 */
export function ColpkgFlow({ path, onFinished }: { path: string; onFinished: (imported: boolean) => void }) {
  const [step, setStep] = useState<ColpkgStep>('confirm');
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function run() {
    setStep('running');
    try {
      const backup = await core.ankiImportColpkg(path);
      toast.show(t('anki.colpkg.done', { arquivo: backup.fileName }), { tone: 'success', durationMs: 8000 });
      onFinished(true);
    } catch (err) {
      setError(errorMessage(err));
      setStep('failed');
    }
  }

  const cancel = (o: boolean) => {
    if (!o) onFinished(false);
  };

  if (step === 'running') return <BlockingProgress label={t('anki.colpkg.running')} />;

  if (step === 'failed') {
    return (
      <Dialog
        open
        onOpenChange={cancel}
        title={t('anki.colpkg.failedTitle')}
        footer={
          <Button variant="primary" onClick={() => onFinished(false)}>
            {t('common.close')}
          </Button>
        }
      >
        <Notice tone="error">{error}</Notice>
        <p className="mt-3 text-base text-muted">{t('anki.colpkg.failedHint')}</p>
      </Dialog>
    );
  }

  if (step === 'confirm') {
    return (
      <Dialog
        open
        onOpenChange={cancel}
        title={t('anki.colpkg.title')}
        description={t('anki.colpkg.file', { nome: fileName(path) })}
        footer={
          <>
            <Button variant="ghost" onClick={() => onFinished(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => setStep('sure')}>
              {t('anki.colpkg.continue')}
            </Button>
          </>
        }
      >
        <p className="pb-1 text-base">{t('anki.colpkg.body')}</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={cancel}
      title={t('anki.colpkg.sureTitle')}
      description={t('anki.colpkg.sureBody')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onFinished(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={!understood} onClick={() => void run()}>
            {t('anki.colpkg.confirm')}
          </Button>
        </>
      }
    >
      <Checkbox
        className="pb-1"
        label={t('anki.colpkg.understand')}
        checked={understood}
        onChange={(e) => setUnderstood(e.target.checked)}
      />
    </Dialog>
  );
}
