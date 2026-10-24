// The side drawers of the EPUB reader: Sumário (nested TOC, current entry marked), Buscar (foliate search, results
// → goTo) and Anotações (highlights, notes and bookmarks in reading order; click → goTo, delete).
import { Bookmark, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState, IconButton, Input, Spinner, Tree, type TreeNode } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';
import type { EpubAnnotation } from '../../lib/core/types';
import { excerpt } from './annotations';
import { normalizeColor } from './palette';
import type { EpubSession, SearchHit, TocNode } from './session';

/** The first focusable element of a drawer (its close button at least). */
const FOCUSABLE = 'button:not([disabled]), input, [tabindex="0"]';

function DrawerShell({
  title,
  onClose,
  children,
  testId,
  initialFocus,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
  /** Where focus goes when the drawer opens (default: its first focusable element after the header). */
  initialFocus?: (aside: HTMLElement) => HTMLElement | null | undefined;
}) {
  const ref = useRef<HTMLElement>(null);
  const initial = useRef(initialFocus);
  // Focus moves into the drawer when it opens (keyboard users land on its content, not behind it).
  useEffect(() => {
    const aside = ref.current;
    if (!aside || aside.contains(document.activeElement)) return;
    const body = aside.querySelector<HTMLElement>('[data-drawer-body]');
    const target =
      initial.current?.(aside) ??
      body?.querySelector<HTMLElement>(FOCUSABLE) ??
      aside.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? aside).focus();
  }, []);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label={title}
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute inset-y-0 left-0 z-20 flex w-[min(340px,85%)] flex-col border-r border-line bg-card shadow-popover outline-none anim-fade"
    >
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line pr-1.5 pl-4">
        <h2 className="truncate text-md font-semibold">{title}</h2>
        <IconButton icon={X} size="sm" label={t('common.close')} onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-drawer-body>
        {children}
      </div>
    </aside>
  );
}

/** The TOC row of the current place, else the tree's first row. */
function currentTocRow(aside: HTMLElement): HTMLElement | null {
  const current = aside.querySelector('[aria-current="location"]')?.closest<HTMLElement>('[role="treeitem"]');
  return current ?? aside.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
}

function toTree(nodes: TocNode[]): TreeNode<TocNode>[] {
  return nodes.map((n) => ({ id: String(n.id), data: n, children: n.children.length ? toTree(n.children) : [] }));
}

function allIds(nodes: TocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) {
      out.push(String(n.id));
      allIds(n.children, out);
    }
  }
  return out;
}

export function TocDrawer({
  toc,
  currentId,
  onGo,
  onClose,
}: {
  toc: TocNode[];
  currentId: number | null;
  onGo: (href: string) => void;
  onClose: () => void;
}) {
  const nodes = useMemo(() => toTree(toc), [toc]);
  const expanded = useMemo(() => allIds(toc), [toc]);
  return (
    <DrawerShell title={t('epubReader.toc')} onClose={onClose} testId="epub-toc" initialFocus={currentTocRow}>
      {toc.length === 0 ? (
        <EmptyState title={t('epubReader.tocEmpty')} />
      ) : (
        <Tree
          nodes={nodes}
          label={t('epubReader.toc')}
          defaultExpanded={expanded}
          className="p-2"
          onActivate={(n) => onGo(n.data.href)}
          renderRow={(n) => {
            const current = n.data.id === currentId;
            return (
              <button
                type="button"
                tabIndex={-1}
                aria-current={current ? 'location' : undefined}
                title={current ? t('epubReader.tocCurrent') : undefined}
                onClick={() => onGo(n.data.href)}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 py-1.5 pr-2 text-left text-base',
                  current ? 'font-semibold text-fg' : 'text-fg',
                )}
              >
                <span
                  aria-hidden
                  className={cn('h-4 w-0.5 shrink-0 rounded-full', current ? 'bg-lime' : 'bg-transparent')}
                />
                <span className="truncate">{n.data.label || '—'}</span>
              </button>
            );
          }}
        />
      )}
    </DrawerShell>
  );
}

const KIND_LABEL: Record<EpubAnnotation['kind'], MessageKey> = {
  highlight: 'epubReader.kind.highlight',
  underline: 'epubReader.kind.underline',
  note: 'epubReader.kind.note',
  bookmark: 'epubReader.kind.bookmark',
};

function KindMark({ a }: { a: EpubAnnotation }) {
  if (a.kind === 'bookmark') return <Bookmark size={15} aria-hidden className="mt-0.5 shrink-0 text-error" />;
  const color = normalizeColor(a.color);
  if (a.kind === 'underline')
    return <span aria-hidden className="mt-2 h-0.5 w-3.5 shrink-0 rounded-full" style={{ background: color }} />;
  return (
    <span
      aria-hidden
      className="mt-1 size-3.5 shrink-0 rounded-[3px] border border-black/15"
      style={{ background: color }}
    />
  );
}

export function AnnotationsDrawer({
  annotations,
  sectionTitle,
  sectionOf,
  onGo,
  onDelete,
  onClose,
}: {
  annotations: EpubAnnotation[];
  sectionTitle: (section: number) => string | null;
  sectionOf: (cfi: string) => number | null;
  onGo: (uid: string) => void;
  onDelete: (uid: string) => void;
  onClose: () => void;
}) {
  return (
    <DrawerShell title={t('epubReader.annotations')} onClose={onClose} testId="epub-annotations">
      {annotations.length === 0 ? (
        <EmptyState title={t('epubReader.annotationsEmpty')} description={t('epubReader.annotationsHint')} />
      ) : (
        <ul className="divide-y divide-line">
          {annotations.map((a) => {
            const section = sectionOf(a.cfi);
            const where = section != null ? sectionTitle(section) : null;
            const text =
              a.kind === 'bookmark'
                ? where
                  ? t('epubReader.bookmarkIn', { capitulo: where })
                  : t('epubReader.bookmarkUntitled')
                : excerpt(a.text);
            return (
              <li key={a.uid} className="group relative" data-testid="epub-annotation-item" data-kind={a.kind}>
                <button
                  type="button"
                  onClick={() => onGo(a.uid)}
                  className="flex w-full items-start gap-2.5 px-4 py-2.5 pr-11 text-left hover:bg-hover"
                >
                  <KindMark a={a} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-2xs tracking-wide text-muted uppercase">
                      {t(KIND_LABEL[a.kind])}
                      {where && a.kind !== 'bookmark' ? ` · ${where}` : ''}
                    </span>
                    <span className="line-clamp-3 block text-base">{text}</span>
                    {a.comment && <span className="mt-0.5 line-clamp-3 block text-xs text-muted">{a.comment}</span>}
                  </span>
                </button>
                <IconButton
                  icon={Trash2}
                  size="sm"
                  label={t('epubReader.delete')}
                  onClick={() => onDelete(a.uid)}
                  className="absolute top-2 right-2 opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                />
              </li>
            );
          })}
        </ul>
      )}
    </DrawerShell>
  );
}

export function SearchDrawer({ session, onClose }: { session: EpubSession; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [progress, setProgress] = useState(1);
  const [done, setDone] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    return () => session.clearSearch();
  }, [session]);

  useEffect(() => {
    if (!submitted) return;
    setHits([]);
    setDone(false);
    setProgress(0);
    return session.search(submitted, (h, p, d) => {
      setHits(h);
      setProgress(p);
      setDone(d);
    });
  }, [session, submitted]);

  const count = hits.length === 1 ? t('epubReader.searchCountOne') : t('epubReader.searchCount', { n: hits.length });

  return (
    <DrawerShell title={t('epubReader.search')} onClose={onClose} testId="epub-search">
      <form
        className="sticky top-0 z-10 border-b border-line bg-card p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
        }}
        role="search"
      >
        <Input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('epubReader.searchPlaceholder')}
          aria-label={t('epubReader.search')}
          leading={<Search size={15} aria-hidden />}
        />
        {submitted && (
          <p className="mt-2 flex items-center gap-2 text-xs text-muted" aria-live="polite">
            {!done && <Spinner className="size-3.5" />}
            {!done
              ? t('epubReader.searching', { pct: `${Math.round(progress * 100)}%` })
              : hits.length
                ? count
                : t('epubReader.searchNone', { q: submitted })}
          </p>
        )}
      </form>
      {hits.length > 0 && (
        <ul className="divide-y divide-line" aria-label={count}>
          {hits.map((h, i) => (
            <li key={`${h.cfi}-${i}`}>
              <button
                type="button"
                data-testid="epub-search-hit"
                onClick={() => void session.goToCfi(h.cfi)}
                className="block w-full px-4 py-2.5 text-left hover:bg-hover"
              >
                {h.label && <span className="block truncate text-2xs text-muted">{h.label}</span>}
                <span className="line-clamp-2 block text-base">
                  {h.pre}
                  <mark className="rounded-[2px] bg-[#fff000] px-0.5 text-[#1f1f1f]">{h.match}</mark>
                  {h.post}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </DrawerShell>
  );
}
