import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ALargeSmall,
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  Highlighter,
  ListTree,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  ScanText,
  Search,
  SquarePlus,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Button,
  buttonBase,
  Card,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Notice,
  Popover,
  SegmentedControl,
  Skeleton,
  SkeletonLines,
  Spinner,
  TabPanel,
  Tabs,
  Toolbar,
  ToolbarSeparator,
  Tree,
  type TreeNode,
} from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core, CoreError } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import type { DocInfo, OutlineItem, Rect, SearchHit } from '../../lib/core/types';
import type { ReadingTheme } from '../../lib/protocol';
import { openDocTab, useDocTabs } from '../../lib/tabs';
import { useNarrow } from '../../lib/useMediaQuery';
import { isTypingTarget } from '../shell/shortcuts';
import { pageBg, PageView } from './PageView';

/** Widgets that own the arrow keys (or float over the viewer); page/zoom keys must not fire inside them. */
const KEY_OWNERS =
  '[role=toolbar],[role=tree],[role=tablist],[role=radiogroup],[role=menu],[role=menubar],[role=listbox],[role=dialog],[data-radix-popper-content-wrapper]';

function inCompositeWidget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEY_OWNERS) !== null;
}

const PAGE_GAP = 16;
const VIEW_PAD = 24;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

type LeftTab = 'outline' | 'thumbs' | 'notes';

function outlineToTree(items: OutlineItem[], prefix = ''): TreeNode<OutlineItem>[] {
  return items.map((item, i) => ({
    id: `${prefix}${i}`,
    data: item,
    children: outlineToTree(item.children, `${prefix}${i}.`),
  }));
}

function OutlinePanel({ docId, onGo }: { docId: string; onGo: (page: number) => void }) {
  const outline = useQuery(q.docOutline(docId));
  const nodes = useMemo(() => outlineToTree(outline.data ?? []), [outline.data]);
  if (outline.isPending) return <SkeletonLines lines={6} className="p-3" />;
  if (outline.isError)
    return (
      <Notice tone="error" className="m-3" onRetry={() => void outline.refetch()}>
        {t('reader.outlineError')}
      </Notice>
    );
  if (!nodes.length) return <EmptyState icon={ListTree} title={t('reader.outlineEmpty')} />;
  return (
    <Tree
      className="p-1.5"
      label={t('reader.outline')}
      nodes={nodes}
      rowClassName="min-h-8 pr-2 coarse:min-h-11"
      onActivate={(n) => n.data.page !== null && onGo(n.data.page)}
      renderRow={(n) => (
        <button
          type="button"
          tabIndex={-1}
          disabled={n.data.page === null}
          onClick={() => n.data.page !== null && onGo(n.data.page)}
          className="flex w-full items-center gap-2 py-1 text-left"
        >
          <span className="min-w-0 flex-1 truncate">{n.data.title}</span>
          {n.data.page !== null && <span className="text-xs text-muted tabular">{n.data.page + 1}</span>}
        </button>
      )}
    />
  );
}

/** Thumbnail width in CSS px is about this fraction of the page width in points. */
const THUMB_SCALE = 0.3;

function ThumbsPanel({
  info,
  current,
  theme,
  onGo,
}: {
  info: DocInfo;
  current: number;
  theme: ReadingTheme;
  onGo: (page: number) => void;
}) {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3);
  const scale = THUMB_SCALE * dpr;
  return (
    <ul className="grid grid-cols-2 gap-3 p-3">
      {info.pages.map((p, i) => (
        <li key={i}>
          <button
            type="button"
            onClick={() => onGo(i)}
            aria-label={t('reader.goToPage', { n: i + 1 })}
            aria-current={i === current ? 'page' : undefined}
            className={cn(
              'flex w-full flex-col items-center gap-1 rounded-ctl p-1.5 hover:bg-hover',
              i === current && 'bg-lime-soft hover:bg-lime-soft',
            )}
          >
            <img
              loading="lazy"
              alt=""
              src={core.pageImageUrl(info.docId, i, { scale, theme, preview: true })}
              className="w-full rounded-[2px] shadow-[0_0_0_1px_var(--border)]"
              style={{ aspectRatio: `${p.width} / ${p.height}`, background: pageBg[theme] }}
            />
            <span className={cn('text-2xs tabular', i === current ? 'font-semibold text-lime-dark' : 'text-muted')}>
              {i + 1}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function LeftPanel({
  info,
  current,
  theme,
  onGo,
}: {
  info: DocInfo;
  current: number;
  theme: ReadingTheme;
  onGo: (page: number) => void;
}) {
  const [tab, setTab] = useState<LeftTab>('outline');
  return (
    <div className="flex h-full flex-col">
      <Tabs
        idBase="left"
        label={t('reader.leftPanel')}
        value={tab}
        onValueChange={setTab}
        size="sm"
        stretch
        items={[
          { value: 'outline', label: t('reader.outline') },
          { value: 'thumbs', label: t('reader.thumbs') },
          { value: 'notes', label: t('reader.notes') },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <TabPanel idBase="left" value="outline" active={tab === 'outline'}>
          <OutlinePanel docId={info.docId} onGo={onGo} />
        </TabPanel>
        <TabPanel idBase="left" value="thumbs" active={tab === 'thumbs'}>
          <ThumbsPanel info={info} current={current} theme={theme} onGo={onGo} />
        </TabPanel>
        <TabPanel idBase="left" value="notes" active={tab === 'notes'}>
          <EmptyState icon={Highlighter} title={t('reader.notesEmpty')} description={t('reader.notesHint')} />
        </TabPanel>
      </div>
    </div>
  );
}

function BookPanel() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <Button variant="primary" icon={SquarePlus} disabled className="w-full">
        {t('book.cardFromSelection')}
      </Button>
      <Card title={t('book.deck')} className="p-3">
        <p className="text-base text-muted">{t('book.noDeck')}</p>
        <Button size="sm" className="mt-3" disabled icon={Plus}>
          {t('book.createDeck')}
        </Button>
      </Card>
      <Card title={t('book.vocab')} className="p-3">
        <p className="text-base text-muted">{t('book.vocabHint')}</p>
        <Button size="sm" className="mt-3" disabled icon={ScanText}>
          {t('book.scan')}
        </Button>
      </Card>
      <p className="px-1 text-xs text-muted">{t('book.phaseNote')}</p>
    </div>
  );
}

function SidePanel({ side, title, children }: { side: 'left' | 'right'; title: ReactNode; children: ReactNode }) {
  return (
    <aside
      aria-label={typeof title === 'string' ? title : undefined}
      className={cn(
        'flex w-[272px] shrink-0 flex-col bg-bg anim-fade',
        side === 'left' ? 'border-r border-line' : 'w-[300px] border-l border-line',
      )}
    >
      {side === 'right' && (
        <div className="flex h-9 shrink-0 items-center border-b border-line px-3 text-base font-semibold">
          <span className="truncate">{title}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </aside>
  );
}

function SearchPopover({
  docId,
  open,
  onOpenChange,
  onPick,
}: {
  docId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (hit: SearchHit) => void;
}) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const results = useQuery({
    queryKey: ['doc', docId, 'search', query],
    queryFn: () => core.docSearch(docId, query),
    enabled: query.length > 0,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setQuery(text.trim());
  }
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      className="w-80 p-0"
      trigger={<IconButton icon={Search} label={t('reader.search')} shortcut="Ctrl+F" active={open} />}
    >
      <form onSubmit={submit} className="border-b border-line p-2">
        <Input
          autoFocus
          leading={<Search size={14} aria-hidden />}
          placeholder={t('reader.searchPlaceholder')}
          aria-label={t('reader.search')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </form>
      <div className="max-h-80 overflow-auto p-1">
        {!query ? (
          <p className="px-2 py-3 text-xs text-muted">{t('reader.searchHint')}</p>
        ) : results.isPending ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted">
            <Spinner /> {t('reader.searching')}
          </div>
        ) : results.isError ? (
          <Notice tone="error" onRetry={() => void results.refetch()}>
            {t('reader.searchError')}
          </Notice>
        ) : results.data.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">{t('reader.searchNone', { q: query })}</p>
        ) : (
          <>
            <p className="px-2 pt-1.5 pb-1 text-2xs text-muted">
              {t('reader.searchCount', { n: results.data.length })}
            </p>
            <ul>
              {results.data.slice(0, 100).map((hit, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onPick(hit)}
                    className="flex w-full gap-2 rounded-[5px] px-2 py-1.5 text-left text-xs hover:bg-hover"
                  >
                    <span className="w-6 shrink-0 text-right text-muted tabular">{hit.page + 1}</span>
                    <span className="line-clamp-2 min-w-0">{hit.context}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Popover>
  );
}

function ReadingThemePopover({ theme, onChange }: { theme: ReadingTheme; onChange: (t: ReadingTheme) => void }) {
  return (
    <Popover
      align="end"
      className="w-auto"
      trigger={<IconButton icon={ALargeSmall} label={t('reader.readingTheme')} />}
    >
      <p className="mb-2 text-xs text-muted">{t('reader.readingTheme')}</p>
      <SegmentedControl
        label={t('reader.readingTheme')}
        value={theme}
        onChange={onChange}
        options={[
          { value: 'claro', label: t('reader.theme.light') },
          { value: 'sepia', label: t('reader.theme.sepia') },
          { value: 'escuro', label: t('reader.theme.dark') },
        ]}
      />
    </Popover>
  );
}

function ViewerSkeleton() {
  return (
    <div
      className="flex h-full flex-col items-center gap-4 overflow-hidden bg-surface p-6"
      aria-busy="true"
      role="status"
    >
      <Skeleton rounded="box" className="h-[792px] w-[612px] max-w-full" />
    </div>
  );
}

function DocError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const notOpen = error instanceof CoreError && error.code === 'doc_not_open';
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 p-6">
      {!notOpen && (
        <Notice tone="error" onRetry={onRetry}>
          {error instanceof CoreError ? error.message : t('errors.unexpected')}
        </Notice>
      )}
      <EmptyState
        icon={FileQuestion}
        title={notOpen ? t('reader.notOpen') : t('reader.loadError')}
        description={notOpen ? t('reader.notOpenHint') : undefined}
        action={
          <Link to="/biblioteca" className={cn(buttonBase, 'h-8 border-line bg-neutral px-3 hover:bg-active')}>
            {t('reader.backToLibrary')}
          </Link>
        }
      />
    </div>
  );
}

export function DocPage({ docId }: { docId: string }) {
  const info = useQuery(q.docInfo(docId));
  const narrow = useNarrow();
  const tabs = useDocTabs();
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [sheet, setSheet] = useState<'left' | 'right' | null>(null);
  const [zoom, setZoom] = useState(1);
  const [theme, setTheme] = useState<ReadingTheme>('claro');
  const [current, setCurrent] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hits, setHits] = useState<{ page: number; rects: Rect[] } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTopBefore = useRef(0);

  const title = info.data?.title ?? tabs.find((x) => x.docId === docId)?.title ?? t('tabs.document');

  // Keep a tab for documents reached by URL.
  useEffect(() => {
    if (info.data) openDocTab({ docId, title: info.data.title ?? tabs.find((x) => x.docId === docId)?.title ?? docId });
  }, [info.data, docId]);

  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = VIEW_PAD;
    for (const p of info.data?.pages ?? []) {
      out.push(y);
      y += p.height * zoom + PAGE_GAP;
    }
    return out;
  }, [info.data, zoom]);

  const goTo = useCallback(
    (page: number) => {
      const count = info.data?.pageCount ?? 0;
      const target = Math.max(0, Math.min(count - 1, page));
      scroller.current?.scrollTo({ top: (offsets[target] ?? 0) - 8 });
      setCurrent(target);
      if (narrow) setSheet(null);
    },
    [info.data, offsets, narrow],
  );

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    let page = 0;
    for (let i = 0; i < offsets.length; i++) if ((offsets[i] ?? 0) <= mid) page = i;
    setCurrent(page);
  }

  // Zoom keeps the reading position: same page, same relative offset inside it.
  const layout = useRef({ zoom, offsets });
  useLayoutEffect(() => {
    const prev = layout.current;
    layout.current = { zoom, offsets };
    const el = scroller.current;
    if (!el || prev.zoom === zoom) return;
    // Anchor on the same point onScroll uses to pick the current page, so the indicator stays put.
    const probe = el.clientHeight / 3;
    const anchor = scrollTopBefore.current + probe;
    let page = 0;
    for (let i = 0; i < prev.offsets.length; i++) if ((prev.offsets[i] ?? 0) <= anchor) page = i;
    const oldTop = prev.offsets[page];
    const newTop = offsets[page];
    if (oldTop === undefined || newTop === undefined) return;
    el.scrollTop = newTop + (anchor - oldTop) * (zoom / prev.zoom) - probe;
  }, [zoom, offsets]);

  const zoomBy = useCallback((dir: 1 | -1) => {
    // Read before the re-render: shrinking content may clamp scrollTop.
    scrollTopBefore.current = scroller.current?.scrollTop ?? 0;
    setZoom((z) => {
      const i = ZOOMS.findIndex((x) => x >= z - 0.001);
      const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))];
      return next ?? z;
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (ctrl || e.altKey || inCompositeWidget(e.target)) {
        return;
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goTo(current + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goTo(current - 1);
      } else if (e.key === '+' || e.key === '=') {
        zoomBy(1);
      } else if (e.key === '-' || e.key === '−') {
        zoomBy(-1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, goTo, zoomBy]);

  if (info.isPending) return <ViewerSkeleton />;
  if (info.isError) return <DocError error={info.error} onRetry={() => void info.refetch()} />;
  const doc = info.data;
  const showLeft = !narrow && leftOpen;
  const showRight = !narrow && rightOpen;
  const bookTitle = t('book.title', { title });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        <Toolbar label={t('reader.toolbar')} className="min-w-0 flex-1">
          <IconButton
            icon={PanelLeft}
            label={t('reader.toggleLeft')}
            active={narrow ? sheet === 'left' : leftOpen}
            onClick={() => (narrow ? setSheet('left') : setLeftOpen((o) => !o))}
          />
          <ToolbarSeparator />
          <IconButton
            icon={ChevronLeft}
            label={t('reader.prevPage')}
            shortcut="←"
            disabled={current <= 0}
            onClick={() => goTo(current - 1)}
          />
          <span className="min-w-16 text-center text-base tabular" aria-live="polite" data-testid="page-indicator">
            {t('reader.pageOf', { n: current + 1, total: doc.pageCount })}
          </span>
          <IconButton
            icon={ChevronRight}
            label={t('reader.nextPage')}
            shortcut="→"
            disabled={current >= doc.pageCount - 1}
            onClick={() => goTo(current + 1)}
          />
          <ToolbarSeparator />
          <IconButton
            icon={Minus}
            label={t('reader.zoomOut')}
            shortcut="−"
            onClick={() => zoomBy(-1)}
            disabled={zoom <= ZOOMS[0]!}
          />
          <span className="w-12 text-center text-base tabular">{Math.round(zoom * 100)}%</span>
          <IconButton
            icon={Plus}
            label={t('reader.zoomIn')}
            shortcut="+"
            onClick={() => zoomBy(1)}
            disabled={zoom >= ZOOMS[ZOOMS.length - 1]!}
          />
          <span className="flex-1" />
          <ReadingThemePopover theme={theme} onChange={setTheme} />
          <SearchPopover
            docId={docId}
            open={searchOpen}
            onOpenChange={setSearchOpen}
            onPick={(hit) => {
              setHits({ page: hit.page, rects: hit.rects });
              goTo(hit.page);
            }}
          />
          <ToolbarSeparator />
          <IconButton
            icon={PanelRight}
            label={t('reader.toggleRight')}
            active={narrow ? sheet === 'right' : rightOpen}
            onClick={() => (narrow ? setSheet('right') : setRightOpen((o) => !o))}
          />
        </Toolbar>
      </div>
      <div className="flex min-h-0 flex-1">
        {showLeft && (
          <SidePanel side="left" title={t('reader.leftPanel')}>
            <LeftPanel info={doc} current={current} theme={theme} onGo={goTo} />
          </SidePanel>
        )}
        <div
          ref={scroller}
          onScroll={onScroll}
          className="min-w-0 flex-1 overflow-auto bg-surface"
          style={{ padding: `${VIEW_PAD}px 16px` }}
          data-testid="viewer"
        >
          <div className="mx-auto flex w-max flex-col items-center" style={{ gap: PAGE_GAP }}>
            {doc.pages.map((p, i) => (
              <PageView
                key={i}
                docId={docId}
                index={i}
                size={p}
                zoom={zoom}
                theme={theme}
                hits={hits?.page === i ? hits.rects : undefined}
              />
            ))}
          </div>
        </div>
        {showRight && (
          <SidePanel side="right" title={bookTitle}>
            <BookPanel />
          </SidePanel>
        )}
      </div>
      {narrow && (
        <Dialog
          variant="sheet"
          open={sheet !== null}
          onOpenChange={(o) => !o && setSheet(null)}
          title={sheet === 'right' ? bookTitle : t('reader.leftPanel')}
        >
          <div className="h-[60vh]">
            {sheet === 'right' ? <BookPanel /> : <LeftPanel info={doc} current={current} theme={theme} onGo={goTo} />}
          </div>
        </Dialog>
      )}
    </div>
  );
}
