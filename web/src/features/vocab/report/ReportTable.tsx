// The report's word table (spec 12.5), virtualized against the page's own scroller: only the visible rows (plus a
// margin) are in the DOM, so a book with 8–10k lemmas stays smooth. Sections (proper nouns, forms of known words,
// phrasal verbs) are rows of the same list.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { Badge } from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import type { VocabRow } from '../../../lib/core/types';
import { selectable, statusLabel, type TableItem } from '../model';

export const ROW_HEIGHT = 44;
const OVERSCAN = 10;
const FALLBACK_VISIBLE = 30;

const GRID =
  'grid grid-cols-[2rem_minmax(0,1fr)_3.25rem_3.5rem] items-center gap-x-2 px-2 md:grid-cols-[2rem_minmax(8rem,1.2fr)_3.5rem_3.75rem_4rem_minmax(5rem,0.8fr)_minmax(8rem,2.4fr)]';

/** The example around the word, the form in bold, cut before it when long. */
function Example({ row }: { row: VocabRow }) {
  if (!row.example) return <span className="text-muted">—</span>;
  const span = row.exampleSpan;
  if (!span || span[1] > row.example.length) return <span title={row.example}>{row.example}</span>;
  const from = Math.max(0, span[0] - 36);
  const before = (from > 0 ? '…' : '') + row.example.slice(from, span[0]);
  return (
    <span title={row.example}>
      {before}
      <b className="font-semibold text-fg">{row.example.slice(span[0], span[1])}</b>
      {row.example.slice(span[1])}
    </span>
  );
}

function WordCell({ row }: { row: VocabRow }) {
  const base = row.group === 'forms' && row.base;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-semibold">
        {base
          ? t('vocab.table.formOf', { forma: row.form, base: base.lemma })
          : row.group === 'proper'
            ? row.form
            : row.lemma}
      </span>
      {row.existingNoteId !== null ? (
        <Badge tone="lime" className="hidden sm:inline-flex">
          {t('vocab.table.inBookDeck')}
        </Badge>
      ) : row.group === 'main' && row.status !== 'unknown' ? (
        <Badge
          tone={
            row.status === 'known' ? 'review' : row.status === 'learning' || row.status === 'new' ? 'learn' : 'neutral'
          }
          className="hidden sm:inline-flex"
        >
          {statusLabel(row.status)}
        </Badge>
      ) : null}
      {row.family && (
        <span className="truncate text-xs text-muted md:hidden">
          · {t('vocab.table.familyOf', { lema: row.family.lemma })}
        </span>
      )}
    </span>
  );
}

function SectionHeader({ item }: { item: Extract<TableItem, { kind: 'header' }> }) {
  return (
    <div className="flex h-full items-end gap-2 border-b border-line px-2 pb-1.5" role="presentation">
      <span className="text-xs font-semibold tracking-wide text-muted uppercase">{t(`vocab.group.${item.group}`)}</span>
      <span className="text-xs text-muted tabular">{item.count}</span>
      {item.group === 'forms' && (
        <span className="hidden truncate text-xs text-muted sm:inline">— {t('vocab.group.formsHint')}</span>
      )}
    </div>
  );
}

export function ReportTable({
  items,
  selected,
  onToggle,
  onOpen,
  onToggleAll,
  scroller,
}: {
  items: readonly TableItem[];
  selected: ReadonlySet<string>;
  onToggle: (lemma: string, on: boolean) => void;
  onOpen: (row: VocabRow) => void;
  /** Checks/unchecks every selectable row shown. */
  onToggleAll: (on: boolean) => void;
  /** The page's scrolling element (the table scrolls with the page). */
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !body) return;
    const measure = () => {
      const offset = body.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      setView({ top: el.scrollTop - offset, height: el.clientHeight });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [scroller, body]);

  // Content above the table can change height (filters, notices): measure again on the next frame.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !body) return;
    const id = requestAnimationFrame(() => el.dispatchEvent(new Event('scroll')));
    return () => cancelAnimationFrame(id);
  }, [items, scroller, body]);

  const visibleRows = view.height > 0 ? Math.ceil(view.height / ROW_HEIGHT) : FALLBACK_VISIBLE;
  const first = Math.max(0, Math.floor(Math.max(0, view.top) / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(items.length - 1, Math.floor(Math.max(0, view.top) / ROW_HEIGHT) + visibleRows + OVERSCAN);

  const rows = items.filter((i): i is Extract<TableItem, { kind: 'row' }> => i.kind === 'row');
  const shownSelectable = rows.filter((i) => selectable(i.row));
  const allOn = shownSelectable.length > 0 && shownSelectable.every((i) => selected.has(i.row.lemma));
  const someOn = shownSelectable.some((i) => selected.has(i.row.lemma));

  return (
    <div role="table" aria-label={t('vocab.table.label')} aria-rowcount={rows.length + 1} className="text-base">
      <div
        role="row"
        aria-rowindex={1}
        className={cn(GRID, 'sticky top-0 z-10 h-9 border-b border-line bg-bg text-xs font-semibold text-muted')}
      >
        <span role="columnheader" className="flex justify-center">
          {/* Some checked (indeterminate) or all: a click clears them; none: a click checks them all. */}
          <input
            type="checkbox"
            ref={(el) => {
              if (el) el.indeterminate = someOn && !allOn;
            }}
            className="size-4 cursor-pointer rounded-[4px] accent-[var(--lime)]"
            checked={allOn}
            disabled={!shownSelectable.length}
            onChange={() => onToggleAll(!someOn)}
            aria-label={t('vocab.table.selectAll')}
          />
        </span>
        <span role="columnheader">{t('vocab.table.word')}</span>
        <span role="columnheader" className="text-right">
          {t('vocab.table.occurrences')}
        </span>
        <span role="columnheader" className="text-right">
          {t('vocab.table.firstPage')}
        </span>
        <span role="columnheader" className="hidden md:block">
          {t('vocab.table.general')}
        </span>
        <span role="columnheader" className="hidden md:block">
          {t('vocab.table.family')}
        </span>
        <span role="columnheader" className="hidden md:block">
          {t('vocab.table.example')}
        </span>
      </div>
      <div ref={setBody} role="rowgroup" style={{ height: items.length * ROW_HEIGHT, position: 'relative' }}>
        {items.slice(first, last + 1).map((item, k) => {
          const i = first + k;
          const style = { top: i * ROW_HEIGHT, height: ROW_HEIGHT };
          if (item.kind === 'header') {
            return (
              <div key={`h-${item.group}`} className="absolute inset-x-0" style={style}>
                <SectionHeader item={item} />
              </div>
            );
          }
          const row = item.row;
          const can = selectable(row);
          const on = can && selected.has(row.lemma);
          return (
            <div
              key={`${row.group}-${row.lemma}`}
              role="row"
              data-testid="vocab-row"
              data-lemma={row.lemma}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('input,button')) return;
                onOpen(row);
              }}
              className={cn(
                GRID,
                'absolute inset-x-0 cursor-pointer border-b border-line/60 transition-colors hover:bg-hover',
                on && 'bg-lime-soft/40',
                !can && 'text-muted',
              )}
              style={style}
            >
              <span role="cell" className="flex justify-center">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer rounded-[4px] accent-[var(--lime)] disabled:cursor-not-allowed"
                  checked={on}
                  disabled={!can}
                  onChange={(e) => onToggle(row.lemma, e.currentTarget.checked)}
                  aria-label={`${t('vocab.table.select')} ${row.group === 'proper' ? row.form : row.lemma}`}
                />
              </span>
              <span role="cell" className="min-w-0">
                <button
                  type="button"
                  className="block w-full min-w-0 rounded-ctl text-left"
                  aria-label={t('vocab.table.open', { palavra: row.form, n: row.firstPage + 1 })}
                  onClick={() => onOpen(row)}
                >
                  <WordCell row={row} />
                </button>
              </span>
              <span role="cell" className="text-right tabular">
                {row.occurrences}
              </span>
              <span role="cell" className="text-right text-muted tabular">
                {t('vocab.table.page', { n: row.firstPage + 1 })}
              </span>
              <span role="cell" className="hidden text-muted md:block">
                {row.group === 'proper'
                  ? t('vocab.table.properNoun')
                  : row.group === 'phrasal'
                    ? '—'
                    : row.rare
                      ? t('vocab.table.rare')
                      : t('vocab.table.common')}
              </span>
              <span role="cell" className="hidden truncate md:block">
                {row.family ? t('vocab.table.familyOf', { lema: row.family.lemma }) : ''}
              </span>
              <span role="cell" className="hidden truncate text-muted md:block">
                <Example row={row} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
