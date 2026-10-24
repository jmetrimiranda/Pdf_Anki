import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/ui';
import type { JobProgress, OcrInfo } from '../../lib/core/types';

// A fake core: the test drives the job's events by hand.
const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  return {
    listeners,
    calls: [] as string[],
    info: null as unknown,
    startResult: null as unknown,
    startError: null as unknown,
    emit(jobId: string, p: unknown) {
      for (const cb of [...(listeners.get(jobId) ?? [])]) cb(p);
    },
  };
});

vi.mock('../../lib/core/client', async () => {
  const types = await vi.importActual<typeof import('../../lib/core/types')>('../../lib/core/types');
  return {
    ...types,
    core: {
      kind: 'mock',
      ocrInfo: vi.fn(async () => {
        fake.calls.push('info');
        return fake.info;
      }),
      ocrStart: vi.fn(async (uid: string) => {
        fake.calls.push(`start:${uid}`);
        if (fake.startError) throw fake.startError;
        return fake.startResult;
      }),
      ocrCancel: vi.fn(async (uid: string) => {
        fake.calls.push(`cancel:${uid}`);
      }),
      onJobProgress: vi.fn((jobId: string, cb: (p: unknown) => void) => {
        fake.calls.push(`listen:${jobId}`);
        const set = fake.listeners.get(jobId) ?? new Set();
        fake.listeners.set(jobId, set);
        set.add(cb);
        return () => set.delete(cb);
      }),
    },
  };
});

const leitorFake = vi.hoisted(() => ({
  flushSaves: vi.fn(async () => {
    fake.calls.push('flush');
    return true;
  }),
  reloadPdfcraftBook: vi.fn(async (uid: string) => {
    fake.calls.push(`reload:${uid}`);
  }),
  refreshVocab: vi.fn(),
}));
vi.mock('../leitor/instance', () => ({
  leitorController: () => leitorFake,
  leitor: { refreshVocab: leitorFake.refreshVocab, flushSaves: leitorFake.flushSaves },
}));

const { ocrStore, estimateMinutes, msPerPage, DEFAULT_MS_PER_PAGE } = await import('./store');
const { useOcrJob, ocrEligible } = await import('./useOcrJob');
const { CoreError } = await import('../../lib/core/types');

const UID = 'b'.repeat(64);

function progress(p: Partial<JobProgress>): JobProgress {
  return {
    jobId: 'ocr-1',
    kind: 'ocr',
    bookUid: UID,
    scanUid: '',
    stage: 'ocr',
    done: 0,
    total: 4,
    reused: false,
    error: null,
    ...p,
  };
}

function info(p: Partial<OcrInfo> = {}): OcrInfo {
  return { available: true, status: 'none', hasText: false, pages: 4, job: null, lastError: null, ...p };
}

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fake.calls.length = 0;
  fake.listeners.clear();
  fake.info = info();
  fake.startResult = { jobId: 'ocr-1', alreadyRunning: false };
  fake.startError = null;
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => ocrStore.reset());

describe('useOcrJob', () => {
  it('flushes PdfCraft saves before starting, follows the events and reloads the book when done', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useOcrJob(UID), { wrapper });
    await waitFor(() => expect(result.current.infoLoading).toBe(false));
    expect(result.current.available).toBe(true);

    await act(() => result.current.start());
    expect(fake.calls).toEqual(['info', 'flush', `start:${UID}`, 'listen:ocr-1']);
    expect(result.current.state).toMatchObject({ phase: 'queued', jobId: 'ocr-1' });

    act(() => fake.emit('ocr-1', progress({ stage: 'ocr', done: 1 })));
    expect(result.current.state).toMatchObject({ phase: 'running', done: 1, total: 4 });
    act(() => fake.emit('ocr-1', progress({ stage: 'writing', done: 4 })));
    expect(result.current.state.phase).toBe('writing');
    act(() =>
      fake.emit(
        'ocr-1',
        progress({
          stage: 'done',
          done: 4,
          ocr: { words: 40, pagesRead: 4, pagesSkipped: 0, fileVersion: 2, msPerPage: 2500 },
        }),
      ),
    );
    expect(result.current.state.phase).toBe('done');
    await waitFor(() => expect(leitorFake.reloadPdfcraftBook).toHaveBeenCalledWith(UID));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['library'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bookPanel', UID] });
    expect(leitorFake.refreshVocab).toHaveBeenCalledWith(UID);
    // The measured speed is kept for the next estimate.
    expect(msPerPage()).toBe(2500);
    // Events after the end are ignored (unsubscribed).
    expect(fake.listeners.get('ocr-1')?.size ?? 0).toBe(0);
  });

  it('resumes the job the core already runs for the book', async () => {
    fake.info = info({ status: 'running', job: progress({ jobId: 'ocr-7', stage: 'ocr', done: 2 }) });
    const { result } = renderHook(() => useOcrJob(UID), { wrapper });
    await waitFor(() => expect(fake.calls).toContain('listen:ocr-7'));
    expect(fake.calls).not.toContain(`start:${UID}`);
    act(() => fake.emit('ocr-7', progress({ jobId: 'ocr-7', stage: 'ocr', done: 3 })));
    expect(result.current.state).toMatchObject({ phase: 'running', jobId: 'ocr-7', done: 3 });
  });

  it('shares one subscription between views of the same book', async () => {
    const a = renderHook(() => useOcrJob(UID), { wrapper });
    const b = renderHook(() => useOcrJob(UID), { wrapper });
    await act(() => a.result.current.start());
    act(() => fake.emit('ocr-1', progress({ stage: 'ocr', done: 2 })));
    expect(b.result.current.state).toMatchObject({ phase: 'running', done: 2 });
    expect(fake.calls.filter((c) => c.startsWith('listen:'))).toHaveLength(1);
  });

  it('cancels through the core and goes back to the offer', async () => {
    const { result } = renderHook(() => useOcrJob(UID), { wrapper });
    await act(() => result.current.start());
    act(() => fake.emit('ocr-1', progress({ stage: 'ocr', done: 1 })));
    await act(() => result.current.cancel());
    expect(fake.calls).toContain(`cancel:${UID}`);
    act(() => fake.emit('ocr-1', progress({ stage: 'cancelled', done: 1 })));
    // A quiet toast; the item offers "Reconhecer texto" again.
    expect(result.current.state.phase).toBe('idle');
    expect(leitorFake.reloadPdfcraftBook).not.toHaveBeenCalled();
  });

  it('reports a failed run with its message, and can try again', async () => {
    const { result } = renderHook(() => useOcrJob(UID), { wrapper });
    await act(() => result.current.start());
    act(() =>
      fake.emit(
        'ocr-1',
        progress({ stage: 'failed', error: { code: 'ocr_failed', message: 'a página 2 não pôde ser lida.' } }),
      ),
    );
    expect(result.current.state).toMatchObject({ phase: 'failed', error: 'a página 2 não pôde ser lida.' });
    fake.startResult = { jobId: 'ocr-2', alreadyRunning: false };
    await act(() => result.current.start());
    expect(result.current.state).toMatchObject({ phase: 'queued', jobId: 'ocr-2' });
  });

  it('a start error (models missing) becomes a failed state, never an exception', async () => {
    fake.startError = new CoreError('ocr_models_missing', 'Os modelos não estão instalados.');
    const { result } = renderHook(() => useOcrJob(UID), { wrapper });
    await act(() => result.current.start());
    expect(result.current.state).toMatchObject({ phase: 'failed', error: 'Os modelos não estão instalados.' });
  });

  it('attaches to the running job when the core says it is already running', async () => {
    fake.startError = new CoreError('ocr_already_running', 'já em andamento');
    fake.info = info({ job: null });
    const { result } = renderHook(() => useOcrJob(UID, { enabled: false }), { wrapper });
    fake.info = info({ job: progress({ jobId: 'ocr-9' }) });
    await act(() => result.current.start());
    expect(fake.calls).toContain('listen:ocr-9');
    expect(result.current.state.jobId).toBe('ocr-9');
  });

  it('does not follow the last finished job that ocr_info may report', async () => {
    fake.info = info({ status: 'done', job: progress({ jobId: 'ocr-5', stage: 'done', done: 4 }) });
    const { result } = renderHook(() => useOcrJob(UID), { wrapper });
    await waitFor(() => expect(result.current.infoLoading).toBe(false));
    expect(fake.calls).not.toContain('listen:ocr-5');
    expect(result.current.state.phase).toBe('idle');
  });

  it('knows when the models are missing', async () => {
    fake.info = info({ available: false });
    const { result } = renderHook(() => useOcrJob(UID), { wrapper });
    await waitFor(() => expect(result.current.available).toBe(false));
  });

  it('does not ask the core about books that cannot use OCR', () => {
    renderHook(() => useOcrJob(UID, { enabled: false }), { wrapper });
    renderHook(() => useOcrJob(null), { wrapper });
    expect(fake.calls).toEqual([]);
  });
});

describe('OCR helpers', () => {
  it('estimates whole minutes from the measured speed', () => {
    expect(DEFAULT_MS_PER_PAGE).toBe(4000);
    expect(estimateMinutes(10)).toBe(0);
    expect(estimateMinutes(15)).toBe(1);
    expect(estimateMinutes(200)).toBe(14);
    expect(estimateMinutes(200, 1000)).toBe(4);
    localStorage.setItem('leitor.ocr.msPerPage', 'garbage');
    expect(msPerPage()).toBe(4000);
  });

  it('offers OCR for PDFs without text or whose last run failed, never for EPUBs', () => {
    expect(ocrEligible({ format: 'pdf', hasText: false, ocrStatus: 'none' })).toBe(true);
    expect(ocrEligible({ format: 'pdf', hasText: true, ocrStatus: 'failed' })).toBe(true);
    expect(ocrEligible({ format: 'pdf', hasText: true, ocrStatus: 'done' })).toBe(false);
    expect(ocrEligible({ format: 'epub', hasText: false, ocrStatus: 'none' })).toBe(false);
    expect(ocrEligible(null)).toBe(false);
  });
});
