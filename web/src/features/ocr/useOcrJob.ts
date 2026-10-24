import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useToast } from '../../components/ui';
import { t } from '../../i18n';
import { core, type LibraryEntry } from '../../lib/core/client';
import { leitor } from '../leitor/instance';
import { IDLE, ocrStore, type OcrJobState, type OcrOutcome } from './store';

export const ocrInfoKey = (uid: string) => ['ocr', 'info', uid] as const;

/** Text recognition makes sense for a PDF without text, one whose last run failed, or one being recognised. */
export function ocrEligible(book: Pick<LibraryEntry, 'format' | 'hasText' | 'ocrStatus'> | null | undefined): boolean {
  if (!book || book.format !== 'pdf') return false;
  return !book.hasText || book.ocrStatus === 'failed' || book.ocrStatus === 'running';
}

/** The phase means a job is (or is about to be) running. */
export const ocrBusy = (s: OcrJobState) =>
  s.phase === 'starting' || s.phase === 'queued' || s.phase === 'running' || s.phase === 'writing';

/**
 * Handles job ends while a view is mounted: refreshes the library, the book panel and the vocabulary queries and
 * tells the user. The store keeps ends that happen with no view mounted for the next one.
 */
function useOcrEffects() {
  const queryClient = useQueryClient();
  const toast = useToast();
  useEffect(
    () =>
      ocrStore.registerEffects((uid: string, outcome: OcrOutcome, state: OcrJobState) => {
        void queryClient.invalidateQueries({ queryKey: ocrInfoKey(uid) });
        if (outcome === 'done') {
          void queryClient.invalidateQueries({ queryKey: ['library'] });
          void queryClient.invalidateQueries({ queryKey: ['bookPanel', uid] });
          void queryClient.invalidateQueries({ queryKey: ['vocab'] });
          leitor.refreshVocab(uid);
          toast.show(t('ocr.done'), { tone: 'success', durationMs: 8000 });
        } else if (outcome === 'failed') {
          void queryClient.invalidateQueries({ queryKey: ['library'] });
          toast.show(state.error ? t('ocr.failed', { mensagem: state.error }) : t('ocr.failedShort'), {
            tone: 'error',
            onRetry: () => void ocrStore.start(uid),
          });
        } else {
          void queryClient.invalidateQueries({ queryKey: ['library'] });
          ocrStore.dismiss(uid);
          toast.show(t('ocr.cancelled'));
        }
      }),
    [queryClient, toast],
  );
}

export interface OcrJob {
  state: OcrJobState;
  /** `ocr_info.available`: a PDF and the OCR models are installed. Only fetched when `enabled`; `true` until known. */
  available: boolean;
  infoLoading: boolean;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  dismiss: () => void;
}

/**
 * One book's text recognition (spec 7.2): its state, start/cancel, and on mount the job that may already be running
 * in the core (after a reload or from another view). `enabled: false` (books that can't use OCR) skips `ocr_info`.
 */
export function useOcrJob(uid: string | null, opts: { enabled?: boolean } = {}): OcrJob {
  const enabled = !!uid && opts.enabled !== false;
  useOcrEffects();
  const state = useSyncExternalStore(
    ocrStore.subscribe,
    () => (uid ? ocrStore.get(uid) : IDLE),
    () => IDLE,
  );
  const info = useQuery({
    queryKey: ocrInfoKey(uid ?? ''),
    queryFn: () => core.ocrInfo(uid!),
    enabled,
    staleTime: 0,
  });

  // Resume: the core already runs (or queued) a job for this book.
  // `job` may also be the book's last finished job of this run: only a live one is followed.
  const job = info.data?.job;
  const runningJobId =
    job && job.kind === 'ocr' && !['done', 'failed', 'cancelled'].includes(job.stage) ? job.jobId : null;
  useEffect(() => {
    if (!uid || !runningJobId) return;
    const s = ocrStore.get(uid);
    if (s.jobId !== runningJobId && !ocrBusy(s)) ocrStore.attach(uid, runningJobId);
  }, [uid, runningJobId]);

  const start = useCallback(async () => {
    if (uid) await ocrStore.start(uid);
  }, [uid]);
  const cancel = useCallback(async () => {
    if (uid) await ocrStore.cancel(uid);
  }, [uid]);
  const dismiss = useCallback(() => {
    if (uid) ocrStore.dismiss(uid);
  }, [uid]);

  return {
    state,
    available: info.data ? info.data.available : true,
    infoLoading: enabled && info.isPending,
    start,
    cancel,
    dismiss,
  };
}
