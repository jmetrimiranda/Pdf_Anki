// The mock's "Reconhecer texto" (spec 7.2, 15): per-page progress through `job://`, at most 10 events per second, a
// new version with text (same book uid, LeitorBookUid kept), cancel, failure and the "models missing" error.
import { beforeEach, describe, expect, it } from 'vitest';
import { pdfBytesToLatin1 } from '../../pdf/minimalPdf';
import { findLeitorBookUid, mockClient, mockHandle } from '../mock';
import type { JobProgress, LibraryEntry } from '../types';
import { setMockLatency } from './ankiData';

beforeEach(() => {
  mockHandle.reset();
  setMockLatency(0);
});

async function scanned(): Promise<LibraryEntry> {
  return (await mockClient.libraryList()).find((b) => !b.hasText)!;
}

function follow(jobId: string): Promise<JobProgress[]> {
  const seen: JobProgress[] = [];
  return new Promise((resolve) => {
    const stop = mockClient.onJobProgress(jobId, (p) => {
      seen.push(p);
      if (['done', 'failed', 'cancelled'].includes(p.stage)) {
        stop();
        resolve(seen);
      }
    });
  });
}

describe('mock OCR', () => {
  it('reports a scanned book and recognizes it into a new searchable version', async () => {
    const book = await scanned();
    expect(await mockClient.ocrInfo(book.bookUid)).toEqual({
      available: true,
      status: 'none',
      hasText: false,
      pages: book.pages,
      job: null,
      lastError: null,
    });
    const started = await mockClient.ocrStart(book.bookUid);
    expect(started.alreadyRunning).toBe(false);
    // A second start returns the running job.
    expect(await mockClient.ocrStart(book.bookUid)).toEqual({ jobId: started.jobId, alreadyRunning: true });
    expect((await mockClient.ocrInfo(book.bookUid)).job?.jobId).toBe(started.jobId);
    const t0 = Date.now();
    const seen = await follow(started.jobId);
    const elapsed = Date.now() - t0;
    const stages = [...new Set(seen.map((p) => p.stage))];
    expect(stages).toEqual(['queued', 'ocr', 'writing', 'done']);
    const pages = seen.filter((p) => p.stage === 'ocr').map((p) => p.done);
    expect(Math.max(...pages)).toBe(book.pages);
    expect(seen.every((p) => p.kind === 'ocr' && p.scanUid === '')).toBe(true);
    // What was done arrives with the end only.
    expect(seen.filter((p) => p.ocr !== undefined).map((p) => p.stage)).toEqual(['done']);
    // ≤ 10 events per second.
    expect(seen.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2);
    const last = seen.at(-1)!;
    expect(last.ocr).toMatchObject({ fileVersion: 2, pagesRead: book.pages, pagesSkipped: 0 });
    expect(last.ocr?.msPerPage).toBeGreaterThan(0);
    expect(last.ocr?.words).toBeGreaterThan(0);

    const after = (await mockClient.libraryList()).find((b) => b.bookUid === book.bookUid)!;
    expect(after).toMatchObject({ hasText: true, ocrStatus: 'done', fileVersion: 2 });
    expect(after.fileHash).not.toBe(book.fileHash);
    const bytes = new Uint8Array(await mockClient.bookBytes(book.bookUid));
    expect(findLeitorBookUid(bytes)).toBe(book.bookUid);
    expect(pdfBytesToLatin1(bytes)).toContain('printing');
    const words = await mockClient.docWords(book.bookUid, 0);
    expect(words.words.length).toBeGreaterThan(20);
    const info = await mockClient.ocrInfo(book.bookUid);
    expect(info).toMatchObject({ hasText: true, status: 'done', lastError: null });
    expect(info.job?.stage).toBe('done');
  }, 20_000);

  it('cancels without touching the book', async () => {
    const book = await scanned();
    mockHandle.ocr.setPageDelay(150);
    const { jobId } = await mockClient.ocrStart(book.bookUid);
    const seen = follow(jobId);
    await new Promise((r) => setTimeout(r, 200));
    expect(await mockClient.ocrCancel(book.bookUid)).toBe(true);
    expect((await seen).at(-1)?.stage).toBe('cancelled');
    expect(await mockClient.ocrCancel(book.bookUid)).toBe(false);
    const after = (await mockClient.libraryList()).find((b) => b.bookUid === book.bookUid)!;
    expect(after).toMatchObject({ hasText: false, ocrStatus: 'none', fileVersion: 1 });
  }, 20_000);

  it('fails with the core error and records the failure', async () => {
    const book = await scanned();
    mockHandle.ocr.failAtPage(1);
    const { jobId } = await mockClient.ocrStart(book.bookUid);
    const last = (await follow(jobId)).at(-1)!;
    expect(last.stage).toBe('failed');
    expect(last.error?.code).toBe('pdf_ocr');
    expect((await mockClient.libraryList()).find((b) => b.bookUid === book.bookUid)?.ocrStatus).toBe('failed');
    expect((await mockClient.ocrInfo(book.bookUid)).lastError).toBe(last.error?.message);
  }, 20_000);

  it('refuses without models and for EPUBs', async () => {
    const book = await scanned();
    mockHandle.ocr.setModelsAvailable(false);
    expect((await mockClient.ocrInfo(book.bookUid)).available).toBe(false);
    await expect(mockClient.ocrStart(book.bookUid)).rejects.toMatchObject({
      code: 'ocr_models_missing',
      message: 'Os modelos de reconhecimento de texto não foram encontrados nesta instalação.',
    });
    const epub = (await mockClient.libraryList()).find((b) => b.format === 'epub')!;
    mockHandle.ocr.setModelsAvailable(true);
    expect((await mockClient.ocrInfo(epub.bookUid)).available).toBe(false);
    await expect(mockClient.ocrStart(epub.bookUid)).rejects.toMatchObject({
      code: 'ocr_not_pdf',
      message: 'O reconhecimento de texto é só para PDFs.',
    });
  });

  it('refuses a PDF that already has text, like the core', async () => {
    const text = (await mockClient.libraryList()).find((b) => b.format === 'pdf' && b.hasText)!;
    await expect(mockClient.ocrStart(text.bookUid)).rejects.toMatchObject({
      code: 'ocr_has_text',
      message: 'Este livro já tem texto; o reconhecimento de texto não é necessário.',
    });
  });
});
