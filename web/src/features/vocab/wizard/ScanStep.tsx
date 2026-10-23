// Step 5 "Escanear" (spec 12.1): starts the background scan and follows its `job://` progress with the stage labels;
// "Cancelar" stops it. When it ends, the report opens.
import { Ban, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Notice, ProgressBar } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import type { JobProgress, VocabJob } from '../../../lib/core/types';
import { errorMessage } from '../../anki/decks/DeckDialogs';
import { followJob } from '../queries';

/** Overall progress of a scan (0–100) from its stage: reading the text is most of the work. */
export function scanPercent(p: JobProgress): number {
  const frac = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  const spans: Record<JobProgress['stage'], [number, number]> = p.reused
    ? {
        queued: [0, 5],
        text: [5, 5],
        lemmas: [5, 5],
        known: [5, 55],
        compare: [55, 100],
        done: [100, 100],
        failed: [0, 0],
        cancelled: [0, 0],
      }
    : {
        queued: [0, 2],
        text: [2, 60],
        lemmas: [60, 75],
        known: [75, 85],
        compare: [85, 100],
        done: [100, 100],
        failed: [0, 0],
        cancelled: [0, 0],
      };
  const [a, b] = spans[p.stage];
  return Math.round(a + (b - a) * frac);
}

type ScanState =
  | { kind: 'starting' }
  | { kind: 'running'; job: VocabJob; progress: JobProgress | null }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

export function ScanStep({
  start,
  onDone,
  onBack,
  onBusy,
}: {
  /** Starts the scan (`vocab_scan_start`). */
  start: () => Promise<VocabJob>;
  onDone: (p: JobProgress) => void;
  onBack: () => void;
  /** The scan is running (the wizard locks its steps). */
  onBusy: (busy: boolean) => void;
}) {
  const [state, setState] = useState<ScanState>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);
  const mounted = useRef(true);
  const callbacks = useRef({ start, onDone, onBusy });
  callbacks.current = { start, onDone, onBusy };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Once per attempt, also under StrictMode's double effects (the first run's promise keeps going).
    if (started.current === attempt) return;
    started.current = attempt;
    const live = () => mounted.current && started.current === attempt;
    callbacks.current.onBusy(true);
    setState({ kind: 'starting' });
    callbacks.current
      .start()
      .then((job) => {
        if (!live()) return undefined;
        setState({ kind: 'running', job, progress: null });
        return followJob(job, (p) => {
          if (live()) setState({ kind: 'running', job, progress: p });
        });
      })
      .then((end) => {
        if (!live() || !end) return;
        callbacks.current.onBusy(false);
        if (end.stage === 'done') callbacks.current.onDone(end);
        else if (end.stage === 'cancelled') setState({ kind: 'cancelled' });
        else setState({ kind: 'failed', message: end.error?.message ?? t('vocab.scan.failed') });
      })
      .catch((e: unknown) => {
        if (!live()) return;
        callbacks.current.onBusy(false);
        setState({ kind: 'failed', message: t('vocab.scan.startFailed', { erro: errorMessage(e) }) });
      });
  }, [attempt]);

  const progress = state.kind === 'running' ? state.progress : null;
  const stage = progress?.stage ?? 'queued';
  const pct = progress ? scanPercent(progress) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-md font-semibold">{t('vocab.scan.title')}</h2>
        <p className="mt-0.5 flex items-center gap-1.5 text-base text-muted">
          <WifiOff size={14} aria-hidden />
          {t('vocab.scan.offline')}
        </p>
      </div>

      {(state.kind === 'starting' || state.kind === 'running') && (
        <div
          className="flex flex-col gap-3 rounded-box border border-line bg-card p-4"
          data-testid="vocab-scan-progress"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-base font-semibold" aria-live="polite">
              {t(`vocab.scan.stage.${stage === 'failed' || stage === 'cancelled' ? 'queued' : stage}`)}
            </p>
            {progress?.stage === 'text' && progress.total > 0 && (
              <span className="text-xs text-muted tabular">
                {t('vocab.scan.pages', { feito: progress.done, total: progress.total })}
              </span>
            )}
          </div>
          <ProgressBar value={pct} label={t('vocab.scan.progress')} />
          {progress?.reused && <p className="text-xs text-muted">{t('vocab.scan.reused')}</p>}
          <div className="flex justify-end">
            <Button
              size="sm"
              icon={Ban}
              disabled={state.kind !== 'running'}
              onClick={() => {
                if (state.kind === 'running') void core.jobCancel(state.job.jobId).catch(() => undefined);
              }}
            >
              {t('vocab.wizard.cancel')}
            </Button>
          </div>
        </div>
      )}

      {state.kind === 'cancelled' && <Notice>{t('vocab.scan.cancelled')}</Notice>}
      {state.kind === 'failed' && <Notice tone="error">{state.message}</Notice>}
      {(state.kind === 'cancelled' || state.kind === 'failed') && (
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" onClick={onBack}>
            {t('vocab.back')}
          </Button>
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            {t('vocab.scan.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
