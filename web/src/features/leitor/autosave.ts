// Automatic saving of PdfCraft's in-PDF annotations as new book versions (spec 6.5).
// dirty → 10 s without changes (or doc switch / tab switch / close) → request-save → save → book_save_version.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type FlushReason = 'quiet' | 'doc' | 'tab' | 'close' | 'manual' | 'ocr';

export interface AutosaveDeps {
  /** Posts `pdfcraft:request-save {id}`; false when the iframe is gone. */
  requestSave(id: string): boolean;
  /** book_save_version(uid, bytes). */
  store(id: string, bytes: Uint8Array): Promise<void>;
  /** PdfCraft's "Salvar como" of a book: export a copy of the (just stored) current version. */
  exportCopy(id: string, name: string): Promise<void>;
  /** A save of a document PdfCraft opened by itself (no id): export the bytes somewhere the user picks. */
  exportUnbound(name: string, bytes: Uint8Array): Promise<void>;
  /** All retries failed: tell the user (the bytes stay in memory; the next trigger retries). */
  onStoreFailed(id: string, error: unknown): void;
  /** A version was stored. */
  onStored?(id: string): void;
  timers?: Timers;
  quietMs?: number;
  /** Delays before the 2nd and 3rd attempt. */
  retryDelaysMs?: number[];
  flushTimeoutMs?: number;
}

interface Waiter {
  ids: Set<string>;
  failed: boolean;
  resolve: (ok: boolean) => void;
  timer: unknown;
}

export class Autosave {
  private readonly d: Required<Omit<AutosaveDeps, 'onStored'>> & Pick<AutosaveDeps, 'onStored'>;
  private readonly dirty = new Set<string>();
  private readonly quiet = new Map<string, unknown>();
  /** Bytes PdfCraft handed over that are not stored yet (PdfCraft already considers them saved). */
  private readonly pending = new Map<string, Uint8Array>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly waiters = new Set<Waiter>();

  constructor(deps: AutosaveDeps) {
    this.d = {
      timers: realTimers,
      quietMs: 10_000,
      retryDelaysMs: [1_000, 3_000],
      flushTimeoutMs: 10_000,
      ...deps,
    };
  }

  isDirty(id: string): boolean {
    return this.dirty.has(id) || this.pending.has(id);
  }

  get dirtyIds(): string[] {
    return [...new Set([...this.dirty, ...this.pending.keys()])];
  }

  /** `pdfcraft:dirty`: the full set of dirty ids. Every listed id restarts its quiet timer. */
  setDirty(ids: Iterable<string>) {
    const next = new Set(ids);
    for (const id of [...this.dirty]) {
      if (!next.has(id)) {
        this.dirty.delete(id);
        this.clearQuiet(id);
      }
    }
    for (const id of next) {
      this.dirty.add(id);
      this.arm(id);
    }
  }

  /** `pdfcraft:activity`: the user is still working on `id`; postpone its save. */
  activity(id: string) {
    if (this.dirty.has(id)) this.arm(id);
  }

  /** The document was closed in PdfCraft (it asked the user about unsaved work itself). */
  forget(id: string) {
    this.dirty.delete(id);
    this.clearQuiet(id);
  }

  private arm(id: string) {
    this.clearQuiet(id);
    this.quiet.set(
      id,
      this.d.timers.setTimeout(() => {
        this.quiet.delete(id);
        this.trigger(id);
      }, this.d.quietMs),
    );
  }

  private clearQuiet(id: string) {
    const h = this.quiet.get(id);
    if (h !== undefined) {
      this.d.timers.clearTimeout(h);
      this.quiet.delete(id);
    }
  }

  /** Save `id` now: retry stored-but-failed bytes, or ask PdfCraft for fresh ones. */
  private trigger(id: string) {
    this.clearQuiet(id);
    if (this.dirty.has(id)) {
      if (!this.d.requestSave(id)) this.settle(id, false);
    } else if (this.pending.has(id)) {
      void this.storeWithRetry(id);
    }
  }

  /**
   * Requests a save of every dirty id now (doc switch, tab switch, close). Resolves true when all are stored,
   * false on a failure or after the flush timeout.
   */
  flush(_reason: FlushReason, only?: Iterable<string>): Promise<boolean> {
    const ids = new Set(only ? [...only].filter((id) => this.isDirty(id)) : this.dirtyIds);
    if (ids.size === 0) return Promise.resolve(true);
    const done = new Promise<boolean>((resolve) => {
      const waiter: Waiter = { ids: new Set(ids), failed: false, resolve, timer: undefined };
      waiter.timer = this.d.timers.setTimeout(() => this.finish(waiter, false), this.d.flushTimeoutMs);
      this.waiters.add(waiter);
    });
    for (const id of ids) this.trigger(id);
    return done;
  }

  /** `pdfcraft:save-failed`: PdfCraft could not do a requested save (the work stays dirty in PdfCraft). */
  onSaveFailed(id: string, error: string) {
    this.d.onStoreFailed(id, new Error(error));
    this.settle(id, false);
  }

  /** `pdfcraft:save`. */
  async onSave(msg: { id: string | null; name: string; saveAs: boolean; bytes: ArrayBuffer }): Promise<void> {
    const bytes = new Uint8Array(msg.bytes);
    if (msg.id === null) {
      try {
        await this.d.exportUnbound(msg.name, bytes);
      } catch (e) {
        this.d.onStoreFailed('', e);
      }
      return;
    }
    const id = msg.id;
    // PdfCraft marked the document clean when it handed the bytes over.
    this.dirty.delete(id);
    this.clearQuiet(id);
    this.pending.set(id, bytes);
    const ok = await this.storeWithRetry(id);
    if (ok && msg.saveAs) {
      try {
        await this.d.exportCopy(id, msg.name);
      } catch (e) {
        this.d.onStoreFailed(id, e);
      }
    }
  }

  /** Stores the pending bytes of `id` (one run at a time; a run picks up bytes that arrive meanwhile). */
  private storeWithRetry(id: string): Promise<boolean> {
    const running = this.inflight.get(id);
    if (running) return running;
    const run = this.runStore(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
    return run;
  }

  private async runStore(id: string): Promise<boolean> {
    let failures = 0;
    for (;;) {
      const bytes = this.pending.get(id);
      if (!bytes) {
        this.d.onStored?.(id);
        this.settle(id, true);
        return true;
      }
      try {
        await this.d.store(id, bytes);
        // A newer save may have replaced the bytes while this one was in flight: loop to store it too.
        if (this.pending.get(id) === bytes) this.pending.delete(id);
        failures = 0;
      } catch (e) {
        failures += 1;
        const delay = this.d.retryDelaysMs[failures - 1];
        if (delay === undefined) {
          this.d.onStoreFailed(id, e);
          this.settle(id, false);
          return false;
        }
        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.d.timers.setTimeout(resolve, ms));
  }

  private settle(id: string, ok: boolean) {
    for (const w of [...this.waiters]) {
      if (!w.ids.has(id)) continue;
      w.ids.delete(id);
      if (!ok) w.failed = true;
      if (w.ids.size === 0 || w.failed) this.finish(w, !w.failed);
    }
  }

  private finish(w: Waiter, ok: boolean) {
    if (!this.waiters.delete(w)) return;
    this.d.timers.clearTimeout(w.timer);
    w.resolve(ok);
  }

  dispose() {
    for (const id of [...this.quiet.keys()]) this.clearQuiet(id);
    for (const w of [...this.waiters]) this.finish(w, false);
  }
}
