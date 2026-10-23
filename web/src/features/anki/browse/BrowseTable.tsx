import { ArrowDown, ArrowUp, Bookmark } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Skeleton } from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import type { BrowseColumn, BrowseOrder, BrowseRow } from '../../../lib/core/types';
import type { RowPages } from './rowPages';
import { clickRow, moveFocus, selectAll, type Selection } from './selection';

export const ROW_HEIGHT = 32;
const OVERSCAN = 8;
/** Rows rendered when the container has no measurable height yet (first paint, jsdom). */
const FALLBACK_VISIBLE = 30;

export const FLAG_COLORS = ['', '#e25252', '#f0a03c', '#4fae4f', '#3d8be4', '#e57cc2', '#35b8b8', '#9a6ae0'];

interface ColumnDef {
  key: keyof Pick<BrowseRow, 'sortField' | 'template' | 'due' | 'deck'>;
  sort: BrowseColumn;
  label: string;
  /** Hidden below this container width (px). */
  minWidth?: number;
}

function columns(): ColumnDef[] {
  return [
    { key: 'sortField', sort: 'sortField', label: t('anki.browse.col.sortField') },
    { key: 'template', sort: 'template', label: t('anki.browse.col.template'), minWidth: 560 },
    { key: 'due', sort: 'cardDue', label: t('anki.browse.col.due') },
    { key: 'deck', sort: 'deck', label: t('anki.browse.col.deck'), minWidth: 460 },
  ];
}

const TEMPLATES: Record<string, string> = {
  sortField: 'minmax(0,2.2fr)',
  template: 'minmax(0,1fr)',
  due: '112px',
  deck: 'minmax(0,1.3fr)',
};

/**
 * The browser's card table (spec 8.2 Navegar): virtualized (fixed row height, only visible rows in the DOM), rows
 * fetched lazily by page, cells as TEXT only.
 */
export function BrowseTable({
  pages,
  version,
  selection,
  onSelection,
  order,
  onOrder,
  onOpen,
  onDelete,
  label,
  className,
}: {
  pages: RowPages;
  /** Bumped when rows arrive (re-render). */
  version: number;
  selection: Selection;
  onSelection: (s: Selection) => void;
  order: BrowseOrder;
  onOrder: (o: BrowseOrder) => void;
  /** Enter / double click on a row. */
  onOpen: (index: number) => void;
  /** Delete key. */
  onDelete: () => void;
  label: string;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0 });
  const count = pages.count;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport((v) => ({ ...v, height: el.clientHeight, width: el.clientWidth }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visibleRows = viewport.height > 0 ? Math.ceil(viewport.height / ROW_HEIGHT) : FALLBACK_VISIBLE;
  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count - 1, Math.floor(viewport.top / ROW_HEIGHT) + visibleRows + OVERSCAN);

  useEffect(() => {
    if (count > 0) void pages.ensure(first, last);
  }, [pages, first, last, count, version]);

  // Keep the focused row in view (keyboard moves).
  const focusRow = selection.focus;
  useEffect(() => {
    const el = scroller.current;
    if (!el || focusRow < 0) return;
    // Rows start below the sticky header row.
    const header = ROW_HEIGHT;
    const top = header + focusRow * ROW_HEIGHT;
    if (top < el.scrollTop + header) el.scrollTop = top - header;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [focusRow]);

  const cols = columns().filter((c) => !c.minWidth || viewport.width === 0 || viewport.width >= c.minWidth);
  const grid = cols.map((c) => TEMPLATES[c.key]).join(' ');
  const page = Math.max(1, visibleRows - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mods = { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey };
    const move = (delta: number) => {
      e.preventDefault();
      onSelection(moveFocus(selection, delta, count, mods));
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(1);
      case 'ArrowUp':
        return move(-1);
      case 'PageDown':
        return move(page);
      case 'PageUp':
        return move(-page);
      case 'Home':
        return move(-count);
      case 'End':
        return move(count);
      case 'Enter':
        if (selection.focus >= 0) {
          e.preventDefault();
          onOpen(selection.focus);
        }
        return;
      case 'Delete':
        if (selection.selected.size) {
          e.preventDefault();
          onDelete();
        }
        return;
      default:
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          onSelection(selectAll(selection, count));
        }
    }
  };

  const onRowClick = (i: number, e: MouseEvent) => {
    onSelection(clickRow(selection, i, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
  };

  const rows: number[] = [];
  for (let i = first; i <= last; i++) rows.push(i);

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={label}
      aria-rowcount={count + 1}
      aria-colcount={cols.length}
      aria-multiselectable="true"
      aria-activedescendant={focusRow >= first && focusRow <= last ? `browse-row-${focusRow}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setViewport((v) => (v.top === top ? v : { ...v, top }));
      }}
      className={cn('relative min-h-0 overflow-auto outline-none focus-visible:outline-none', className)}
      data-testid="browse-table"
    >
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-10 grid h-8 border-b border-line bg-bg text-xs text-muted"
        style={{ gridTemplateColumns: grid }}
      >
        {cols.map((c) => {
          const active = order.column === c.sort;
          const Arrow = order.reverse ? ArrowDown : ArrowUp;
          return (
            <div
              key={c.key}
              role="columnheader"
              aria-sort={active ? (order.reverse ? 'descending' : 'ascending') : 'none'}
              className="flex min-w-0 items-center"
            >
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onOrder({ column: c.sort, reverse: active ? !order.reverse : false })}
                className={cn(
                  'flex h-full w-full min-w-0 items-center gap-1 px-3 text-left font-semibold hover:text-fg',
                  active && 'text-fg',
                )}
              >
                <span className="truncate">{c.label}</span>
                {active && <Arrow size={13} aria-hidden className="shrink-0" />}
              </button>
            </div>
          );
        })}
      </div>
      <div role="rowgroup" style={{ height: count * ROW_HEIGHT, position: 'relative' }}>
        {rows.map((i) => {
          const row = pages.row(i);
          const selected = selection.selected.has(i);
          const focused = selection.focus === i;
          return (
            <div
              key={pages.idAt(i) ?? i}
              id={`browse-row-${i}`}
              role="row"
              aria-rowindex={i + 2}
              aria-selected={selected}
              data-suspended={row?.suspended || undefined}
              data-marked={row?.marked || undefined}
              onMouseDown={(e) => {
                // Shift-click would select text; the grid keeps the keyboard focus.
                if (e.shiftKey) e.preventDefault();
              }}
              onClick={(e) => onRowClick(i, e)}
              onDoubleClick={() => onOpen(i)}
              className={cn(
                'absolute inset-x-0 grid cursor-default items-center border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] text-base select-none',
                row?.suspended && 'bg-[color-mix(in_srgb,#e8c547_20%,transparent)]',
                !row?.suspended && row?.marked && 'bg-[color-mix(in_srgb,#9a6ae0_12%,transparent)]',
                row?.buried && 'text-muted',
                selected ? 'bg-[color-mix(in_srgb,var(--link)_18%,transparent)]' : 'hover:bg-hover',
                focused && 'shadow-[inset_2px_0_0_var(--link)]',
              )}
              style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT, gridTemplateColumns: grid }}
            >
              {row ? (
                cols.map((c, k) => (
                  <div key={c.key} role="gridcell" className="flex min-w-0 items-center gap-1.5 px-3">
                    {k === 0 && row.flag > 0 && (
                      <span
                        aria-label={t('anki.browse.flag', { n: row.flag })}
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: FLAG_COLORS[row.flag] }}
                      />
                    )}
                    {k === 0 && row.marked && (
                      <Bookmark size={12} aria-label={t('anki.browse.marked')} className="shrink-0 text-[#9a6ae0]" />
                    )}
                    <span className={cn('truncate', c.key === 'due' && 'tabular-nums')}>{row[c.key]}</span>
                  </div>
                ))
              ) : (
                <div role="gridcell" className="col-span-full flex items-center gap-2 px-3 text-muted">
                  {pages.failedAt(i) ? (
                    <span className="text-xs">{t('anki.browse.rowsFailed')}</span>
                  ) : (
                    <Skeleton className="h-3 w-2/5" />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
