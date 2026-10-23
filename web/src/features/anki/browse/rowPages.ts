// Lazy rows of the card table: the search returns only ids; rows are fetched in pages of 100 when they scroll
// into view (`ankiBrowseRows` accepts at most 500 ids per call).
import type { BrowseRow } from '../../../lib/core/types';

export const PAGE_SIZE = 100;

export class RowPages {
  private readonly rows = new Map<number, BrowseRow>();
  private readonly loading = new Set<number>();
  private readonly failed = new Set<number>();
  private generation = 0;

  constructor(
    private ids: readonly number[],
    private readonly fetch: (ids: number[]) => Promise<BrowseRow[]>,
    private readonly onChange: () => void,
    readonly pageSize = PAGE_SIZE,
  ) {}

  /** New search result: forgets every row (they may have changed). */
  reset(ids: readonly number[]): void {
    this.ids = ids;
    this.rows.clear();
    this.loading.clear();
    this.failed.clear();
    this.generation++;
  }

  get count(): number {
    return this.ids.length;
  }

  idAt(i: number): number | undefined {
    return this.ids[i];
  }

  /** The row at index `i`, or undefined while its page is loading. */
  row(i: number): BrowseRow | undefined {
    const id = this.ids[i];
    return id === undefined ? undefined : this.rows.get(id);
  }

  /** Whether `i`'s page failed to load (the table shows a retry hint). */
  failedAt(i: number): boolean {
    return this.failed.has(Math.floor(i / this.pageSize));
  }

  /** Loads the pages covering rows `from..=to` that are not loaded or loading yet. */
  ensure(from: number, to: number): Promise<void> {
    const first = Math.max(0, Math.floor(from / this.pageSize));
    const last = Math.min(Math.floor((this.ids.length - 1) / this.pageSize), Math.floor(to / this.pageSize));
    const jobs: Promise<void>[] = [];
    for (let p = first; p <= last; p++) {
      if (this.loading.has(p) || this.failed.has(p) || this.pageLoaded(p)) continue;
      jobs.push(this.load(p));
    }
    return Promise.all(jobs).then(() => undefined);
  }

  /** Lets `ensure` try the pages that failed again. */
  retryFailed(): void {
    this.failed.clear();
    this.onChange();
  }

  /** Re-fetches the given rows in place (after an edit), keeping the rest. */
  async refresh(indexes: readonly number[]): Promise<void> {
    const ids = indexes.map((i) => this.ids[i]).filter((id): id is number => id !== undefined);
    const gen = this.generation;
    for (let k = 0; k < ids.length; k += this.pageSize) {
      const rows = await this.fetch(ids.slice(k, k + this.pageSize));
      if (gen !== this.generation) return;
      for (const r of rows) this.rows.set(r.cardId, r);
    }
    this.onChange();
  }

  private pageLoaded(p: number): boolean {
    const end = Math.min(this.ids.length, (p + 1) * this.pageSize);
    for (let i = p * this.pageSize; i < end; i++) if (!this.rows.has(this.ids[i]!)) return false;
    return true;
  }

  private async load(p: number): Promise<void> {
    const gen = this.generation;
    const ids = this.ids.slice(p * this.pageSize, (p + 1) * this.pageSize);
    this.loading.add(p);
    this.failed.delete(p);
    try {
      const rows = await this.fetch([...ids]);
      if (gen !== this.generation) return;
      for (const r of rows) this.rows.set(r.cardId, r);
      // Ids the core no longer knows (deleted meanwhile) get an empty placeholder so the page counts as loaded.
      for (const id of ids)
        if (!this.rows.has(id))
          this.rows.set(id, {
            cardId: id,
            noteId: 0,
            sortField: '',
            template: '',
            deck: '',
            due: '',
            flag: 0,
            marked: false,
            suspended: false,
            buried: false,
          });
    } catch {
      if (gen === this.generation) this.failed.add(p);
    } finally {
      if (gen === this.generation) {
        this.loading.delete(p);
        this.onChange();
      }
    }
  }
}
