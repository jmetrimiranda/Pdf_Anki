import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosave, type AutosaveDeps } from './autosave';
import { UID_A, UID_B, viTimers } from './testing';

function setup(over: Partial<AutosaveDeps> = {}) {
  const requests: string[] = [];
  const stored: [string, number][] = [];
  const deps = {
    requestSave: vi.fn((id: string) => {
      requests.push(id);
      return true;
    }),
    store: vi.fn(async (id: string, bytes: Uint8Array) => {
      stored.push([id, bytes.length]);
    }),
    exportCopy: vi.fn(async () => {}),
    exportUnbound: vi.fn(async () => {}),
    onStoreFailed: vi.fn(),
    onStored: vi.fn(),
    timers: viTimers,
    ...over,
  };
  const a = new Autosave(deps);
  const save = (id: string | null, n = 3, saveAs = false) =>
    a.onSave({ id, name: 'Livro.pdf', saveAs, bytes: new Uint8Array(n).buffer });
  return { a, deps, requests, stored, save };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Autosave', () => {
  it('requests a save after 10 s of quiet', async () => {
    const { a, requests } = setup();
    a.setDirty([UID_A]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toEqual([UID_A]);
  });

  it('restarts the timer on activity and on every dirty message', async () => {
    const { a, requests } = setup();
    a.setDirty([UID_A]);
    await vi.advanceTimersByTimeAsync(8_000);
    a.activity(UID_A);
    await vi.advanceTimersByTimeAsync(8_000);
    a.setDirty([UID_A, UID_B]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requests.sort()).toEqual([UID_A, UID_B].sort());
  });

  it('ignores activity of a clean document', async () => {
    const { a, requests } = setup();
    a.activity(UID_A);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toEqual([]);
  });

  it('cancels the timer when the document becomes clean', async () => {
    const { a, requests } = setup();
    a.setDirty([UID_A]);
    a.setDirty([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toEqual([]);
  });

  it('flush (doc/tab switch, close) requests every dirty id at once and resolves when stored', async () => {
    const { a, requests, save, stored } = setup();
    a.setDirty([UID_A, UID_B]);
    const done = a.flush('tab');
    expect(requests.sort()).toEqual([UID_A, UID_B].sort());
    await save(UID_A, 5);
    let settled = false;
    void done.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await save(UID_B, 7);
    await expect(done).resolves.toBe(true);
    expect(stored).toEqual([
      [UID_A, 5],
      [UID_B, 7],
    ]);
    // Nothing left: the quiet timers were cleared.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toHaveLength(2);
  });

  it('flush of selected ids only', async () => {
    const { a, requests } = setup();
    a.setDirty([UID_A, UID_B]);
    void a.flush('doc', [UID_A]);
    expect(requests).toEqual([UID_A]);
  });

  it('flush with nothing dirty resolves true at once', async () => {
    const { a } = setup();
    await expect(a.flush('close')).resolves.toBe(true);
  });

  it('flush times out after 10 s when PdfCraft never answers', async () => {
    const { a } = setup();
    a.setDirty([UID_A]);
    const done = a.flush('close');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBe(false);
  });

  it('retries a failed store with backoff, then reports and keeps the bytes', async () => {
    const store = vi.fn().mockRejectedValue(new Error('disk full'));
    const { a, deps, save } = setup({ store });
    a.setDirty([UID_A]);
    const done = a.flush('manual');
    const saving = save(UID_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(store).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store).toHaveBeenCalledTimes(3);
    await saving;
    expect(deps.onStoreFailed).toHaveBeenCalledTimes(1);
    await expect(done).resolves.toBe(false);
    expect(a.isDirty(UID_A)).toBe(true);

    // The next trigger retries the bytes kept in memory (PdfCraft already thinks they're saved).
    store.mockResolvedValue(undefined);
    await expect(a.flush('tab')).resolves.toBe(true);
    expect(store).toHaveBeenCalledTimes(4);
    expect(a.isDirty(UID_A)).toBe(false);
  });

  it('recovers when a retry succeeds', async () => {
    const store = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
    const { deps, save } = setup({ store });
    const saving = save(UID_A);
    await vi.advanceTimersByTimeAsync(1_000);
    await saving;
    expect(store).toHaveBeenCalledTimes(2);
    expect(deps.onStoreFailed).not.toHaveBeenCalled();
    expect(deps.onStored).toHaveBeenCalledWith(UID_A);
  });

  it('"Salvar como" stores the version, then exports a copy', async () => {
    const { deps, save, stored } = setup();
    await save(UID_A, 4, true);
    expect(stored).toEqual([[UID_A, 4]]);
    expect(deps.exportCopy).toHaveBeenCalledWith(UID_A, 'Livro.pdf');
  });

  it('a save without id (file opened inside PdfCraft) is exported, never stored', async () => {
    const { deps, save, stored } = setup();
    await save(null, 9);
    expect(stored).toEqual([]);
    expect(deps.exportUnbound).toHaveBeenCalledWith('Livro.pdf', expect.any(Uint8Array));
  });

  it('save-failed from PdfCraft fails the flush and reports', async () => {
    const { a, deps } = setup();
    a.setDirty([UID_A]);
    const done = a.flush('tab');
    a.onSaveFailed(UID_A, 'unknown id');
    await expect(done).resolves.toBe(false);
    expect(deps.onStoreFailed).toHaveBeenCalledWith(UID_A, new Error('unknown id'));
  });

  it('a request that cannot be posted fails the flush', async () => {
    const { a } = setup({ requestSave: () => false });
    a.setDirty([UID_A]);
    await expect(a.flush('close')).resolves.toBe(false);
  });

  it('stores the newest bytes when a save arrives during a store', async () => {
    let release!: () => void;
    const store = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const { save } = setup({ store });
    const first = save(UID_A, 1);
    await vi.advanceTimersByTimeAsync(0);
    const second = save(UID_A, 2);
    release();
    await Promise.all([first, second]);
    expect(store).toHaveBeenCalledTimes(2);
    expect((store.mock.calls[1]?.[1] as Uint8Array).length).toBe(2);
  });
});
