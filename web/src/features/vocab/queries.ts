// Query keys of the vocabulary screens. Everything lives under ['vocab', …]; the report also depends on the Anki
// collection (statuses), so a deck generation invalidates both.
import { queryOptions } from '@tanstack/react-query';
import { core } from '../../lib/core/client';
import type { JobProgress, VocabJob } from '../../lib/core/types';

export const vocabQ = {
  settings: () =>
    queryOptions({ queryKey: ['vocab', 'settings'], queryFn: () => core.vocabSettingsGet(), staleTime: 0 }),
  folder: (rootDeckId: number) =>
    queryOptions({
      queryKey: ['vocab', 'folder', rootDeckId],
      queryFn: () => core.vocabFolder(rootDeckId),
      staleTime: 0,
    }),
  outline: (uid: string) =>
    queryOptions({ queryKey: ['vocab', 'outline', uid], queryFn: () => core.vocabOutline(uid), staleTime: 0 }),
  report: (uid: string) =>
    queryOptions({ queryKey: ['vocab', 'report', uid], queryFn: () => core.vocabReport(uid), staleTime: 0 }),
  dataInfo: () => queryOptions({ queryKey: ['vocab', 'dataInfo'], queryFn: () => core.vocabDataInfo() }),
};

const TERMINAL = new Set<JobProgress['stage']>(['done', 'failed', 'cancelled']);

export function isTerminal(p: JobProgress): boolean {
  return TERMINAL.has(p.stage);
}

/**
 * Follows a scan job (`job://<id>`) until it ends: resolves with the last progress (`done`, `failed` or
 * `cancelled`); `onProgress` sees every update.
 */
export function followJob(job: VocabJob, onProgress?: (p: JobProgress) => void): Promise<JobProgress> {
  return new Promise((resolve) => {
    let stop: (() => void) | null = null;
    let finished = false;
    stop = core.onJobProgress(job.jobId, (p) => {
      if (finished) return;
      onProgress?.(p);
      if (isTerminal(p)) {
        finished = true;
        stop?.();
        resolve(p);
      }
    });
    if (finished) stop();
  });
}
