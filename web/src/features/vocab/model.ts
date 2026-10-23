// Pure helpers of the vocabulary report (spec 12.4, 12.5): pt-BR number formatting, the filters and sort of the
// table, its sections, and "Selecionar as N para 98%" (the same order as the core's coverage curve).
import { t } from '../../i18n';
import type { VocabReport, VocabRow, VocabStatus } from '../../lib/core/types';

const pct1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** 0.9412 → "94,1%". */
export function formatPct(fraction: number): string {
  return `${pct1.format(Math.floor(fraction * 1000) / 10)}%`;
}

/** 0.95 → "95%" (chapter chips, goals). */
export function formatPct0(fraction: number): string {
  return `${pct0.format(Math.floor(fraction * 100))}%`;
}

/** Epoch ms → "22/10/2026". */
export function formatDate(ms: number): string {
  return shortDate.format(new Date(ms));
}

/** Number of pages of 0-based inclusive intervals. */
export function pageCount(pages: [number, number][]): number {
  return pages.reduce((n, [a, b]) => n + Math.max(0, b - a + 1), 0);
}

export type StatusFilter = 'unknown' | 'learning' | 'known' | 'all';
export type SortKey = 'occurrences' | 'first' | 'frequency';

export interface ReportFilters {
  status: StatusFilter;
  minOccurrences: number;
  /** 1-based chapter index, or `null` for every chapter. */
  chapter: number | null;
  hideRare: boolean;
  sort: SortKey;
  /** Part of a word (lemma or form), case and accents ignored; '' shows everything. */
  query: string;
}

export const DEFAULT_FILTERS: ReportFilters = {
  status: 'unknown',
  minOccurrences: 2,
  chapter: null,
  hideRare: false,
  sort: 'occurrences',
  query: '',
};

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const STATUS_GROUPS: Record<Exclude<StatusFilter, 'all'>, readonly VocabStatus[]> = {
  unknown: ['unknown'],
  learning: ['learning', 'new', 'suspended'],
  known: ['known', 'ignored'],
};

function byLemma(a: VocabRow, b: VocabRow): number {
  return a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0;
}

/** The core's reading order: first page, then the position on it. */
export function readingOrder(a: VocabRow, b: VocabRow): number {
  return a.firstPage - b.firstPage || a.position - b.position || byLemma(a, b);
}

/** The core's frequency order (`RowOrder::Frequency`), also the order of the coverage curve. */
export function curveOrder(a: VocabRow, b: VocabRow): number {
  return b.occurrences - a.occurrences || a.firstPage - b.firstPage || a.position - b.position || byLemma(a, b);
}

function generalOrder(a: VocabRow, b: VocabRow): number {
  return (b.zipf ?? -1) - (a.zipf ?? -1) || curveOrder(a, b);
}

const SORTS: Record<SortKey, (a: VocabRow, b: VocabRow) => number> = {
  occurrences: curveOrder,
  first: readingOrder,
  frequency: generalOrder,
};

/** Rows that can be checked (a note made by an earlier scan of the book can't be created again). */
export function selectable(row: VocabRow): boolean {
  return row.existingNoteId === null;
}

/** The rows of a group after the filters (the status filter applies to the main group only). */
export function filterRows(rows: readonly VocabRow[], group: VocabRow['group'], f: ReportFilters): VocabRow[] {
  const query = fold(f.query.trim());
  return rows
    .filter((r) => {
      if (r.group !== group) return false;
      // A search shows the word whatever its status or count.
      if (query) return fold(r.lemma).includes(query) || fold(r.form).includes(query);
      if (group === 'main' && f.status !== 'all' && !STATUS_GROUPS[f.status].includes(r.status)) return false;
      if (r.occurrences < f.minOccurrences) return false;
      if (f.chapter !== null && r.chapter !== f.chapter) return false;
      if (f.hideRare && r.rare && group !== 'proper') return false;
      return true;
    })
    .sort(SORTS[f.sort]);
}

/** One line of the virtualized table: a section header or a row. */
export type TableItem =
  { kind: 'header'; group: Exclude<VocabRow['group'], 'main'>; count: number } | { kind: 'row'; row: VocabRow };

/** The table: the main rows, then proper nouns, the forms of known words and the phrasal verbs (spec 12.5). */
export function tableItems(rows: readonly VocabRow[], f: ReportFilters): TableItem[] {
  const out: TableItem[] = filterRows(rows, 'main', f).map((row) => ({ kind: 'row', row }));
  for (const group of ['proper', 'forms', 'phrasal'] as const) {
    const list = filterRows(rows, group, f);
    if (!list.length) continue;
    out.push({ kind: 'header', group, count: list.length });
    for (const row of list) out.push({ kind: 'row', row });
  }
  return out;
}

/**
 * "Selecionar as N para 98%": the N most frequent unknown words of the main group (N = `wordsTo98`), in the order of
 * the coverage curve, leaving out the ones already made by an earlier scan.
 */
export function goalSelection(report: Pick<VocabReport, 'rows' | 'metrics'>): string[] {
  return report.rows
    .filter((r) => r.group === 'main' && r.status === 'unknown' && selectable(r))
    .sort(curveOrder)
    .slice(0, report.metrics.wordsTo98)
    .map((r) => r.lemma);
}

/** The selection the report opens with: the rows the core marks `defaultSelected`. */
export function defaultSelection(rows: readonly VocabRow[]): Set<string> {
  return new Set(rows.filter((r) => r.defaultSelected && selectable(r)).map((r) => r.lemma));
}

/** Label of a row's status (badges). */
export function statusLabel(status: VocabStatus): string {
  return t(`vocab.status.${status}`);
}
