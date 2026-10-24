import { Button, ProgressBar } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { OcrJobState } from './store';

/** The line under the bar: queued, page X of N, saving. */
export function ocrProgressText(s: OcrJobState): string {
  switch (s.phase) {
    case 'queued':
      return t('ocr.queued');
    case 'running':
      return s.total > 0 ? t('ocr.page', { n: Math.min(s.total, s.done + 1), total: s.total }) : t('ocr.starting');
    case 'writing':
      return t('ocr.writing');
    default:
      return t('ocr.starting');
  }
}

/** A running OCR job: what it is doing, a bar and "Cancelar" (not while the new version is being written). */
export function OcrProgress({
  state,
  title,
  onCancel,
  className,
}: {
  state: OcrJobState;
  /** Book title, for the cancel button's accessible name. */
  title: string;
  onCancel: () => void;
  className?: string;
}) {
  const determinate = state.phase === 'running' && state.total > 0;
  const cancellable = !!state.jobId && (state.phase === 'queued' || state.phase === 'running');
  return (
    <div data-testid="ocr-progress" data-phase={state.phase} className={cn('flex min-w-0 flex-col gap-1', className)}>
      <ProgressBar label={t('ocr.progressLabel')} {...(determinate ? { value: state.done, max: state.total } : {})} />
      <div className="flex min-h-7 items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted tabular"
          aria-live="polite"
          title={state.phase === 'queued' ? t('ocr.queuedHint') : undefined}
        >
          {ocrProgressText(state)}
        </span>
        {cancellable && (
          <Button
            size="sm"
            variant="ghost"
            className="-mr-1.5 shrink-0 text-muted hover:text-fg"
            aria-label={t('ocr.cancelLabel', { titulo: title })}
            onClick={onCancel}
          >
            {t('ocr.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
