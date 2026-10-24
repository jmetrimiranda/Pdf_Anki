// The EPUB reader view (spec 7.1): foliate-js in the webview with the app's quiet chrome around it. A
// self-contained component: W2 mounts it in the Leitor tab and drives it through the handle; annotations are loaded
// and saved here through the core (`epub_annotation_list/upsert/delete`).
import { BookOpen, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button, Dialog, EmptyState, IconButton, Notice, PortalContainerContext, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import { AnnotationPopover } from './AnnotationPopover';
import { AnnotationsDrawer, SearchDrawer, TocDrawer } from './Drawers';
import { EpubToolbar } from './EpubToolbar';
import { openExternalUrl } from './openUrl';
import { DEFAULT_COLOR, SWATCHES } from './palette';
import { getPrefs, THEME_COLORS, useEpubPrefs } from './prefs';
import { SelectionToolbar } from './SelectionToolbar';
import { EpubSession, type AnnotationApi, type SessionSnapshot } from './session';
import { installEpubTestHooks } from './testHooks';
import type { DrawerKind, EpubReaderEvents, EpubReaderHandle } from './types';

const coreAnnotations: AnnotationApi = {
  list: (uid) => core.epubAnnotationList(uid),
  upsert: (input) => core.epubAnnotationUpsert(input),
  remove: (uid) => core.epubAnnotationDelete(uid),
};

const noop = () => () => {};
/** Layers over the reader that handle Escape themselves. */
const LAYERS = '[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]';
const EMPTY_SNAPSHOT = {} as SessionSnapshot;

/** The PdfCraft red, for the bookmark ribbon. */
const RIBBON = SWATCHES[2]!.hex;

function BookmarkRibbon() {
  return (
    <svg
      data-testid="epub-bookmark-ribbon"
      aria-hidden
      width="18"
      height="30"
      viewBox="0 0 18 30"
      className="pointer-events-none absolute top-0 right-8 z-10 drop-shadow-sm"
    >
      <path d="M0 0H18V29L9 22L0 29Z" fill={RIBBON} />
    </svg>
  );
}

export const EpubReader = forwardRef<EpubReaderHandle, { events: EpubReaderEvents; hidden?: boolean }>(
  function EpubReader({ events, hidden }, ref) {
    const [root, setRoot] = useState<HTMLDivElement | null>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const eventsRef = useRef(events);
    eventsRef.current = events;
    const sessionRef = useRef<EpubSession | null>(null);
    const [session, setSession] = useState<EpubSession | null>(null);
    const [lastColor, setLastColor] = useState(DEFAULT_COLOR);
    const prefs = useEpubPrefs();

    const need = useCallback((): EpubSession => {
      if (!sessionRef.current) {
        const host = hostRef.current;
        if (!host) throw new Error('EpubReader is not mounted');
        sessionRef.current = new EpubSession(host, () => eventsRef.current, coreAnnotations, openExternalUrl);
      }
      return sessionRef.current;
    }, []);

    useLayoutEffect(() => {
      const s = need();
      setSession(s);
      const uninstall = installEpubTestHooks(s);
      return () => {
        uninstall();
        s.close();
        if (sessionRef.current === s) sessionRef.current = null;
      };
    }, [need]);

    useImperativeHandle(
      ref,
      () => ({
        open: (o) => need().open(o),
        goTo: (target) => (sessionRef.current ? sessionRef.current.goTo(target) : Promise.resolve({ found: null })),
        close: () => sessionRef.current?.close(),
        currentLocation: () => sessionRef.current?.snapshot().location ?? null,
        selectionNow: () => sessionRef.current?.selectionNow() ?? null,
        setVocabMarks: (section, words) => sessionRef.current?.setVocabMarks(section, words),
        clearVocabMarks: () => sessionRef.current?.clearVocabMarks(),
        openDrawer: (kind) => sessionRef.current?.setDrawer(kind),
        get theme() {
          return getPrefs().theme;
        },
      }),
      [need],
    );

    const snap = useSyncExternalStore(
      session ? session.subscribe : noop,
      session ? session.snapshot : () => EMPTY_SNAPSHOT,
    );
    const ready = snap.status === 'ready';
    const theme = prefs.theme;
    const active = snap.active ? snap.annotations?.find((a) => a.uid === snap.active!.uid) : undefined;

    // A drawer dismissed from the chrome (its close button, Escape, the toolbar toggle) gives focus back to its toolbar
    // button; otherwise (a TOC entry or an annotation chosen, Escape in the book) the book gets it.
    const dismissedFrom = useRef<DrawerKind | null>(null);
    useEffect(() => {
      if (snap.drawer !== null || !ready) return;
      const from = dismissedFrom.current;
      dismissedFrom.current = null;
      const button = from ? root?.querySelector<HTMLElement>(`[data-testid="epub-${from}-button"]`) : null;
      if (button) button.focus();
      else session?.focus();
    }, [snap.drawer, ready, session, root]);

    const closeDrawer = () => session?.setDrawer(null);
    const dismissDrawer = () => {
      dismissedFrom.current = snap.drawer ?? null;
      session?.setDrawer(null);
    };

    return (
      <div
        ref={setRoot}
        role="region"
        aria-label={t('epubReader.region')}
        aria-hidden={hidden || undefined}
        data-testid="epub-reader"
        data-theme={theme === 'dark' ? 'dark' : 'light'}
        data-epub-theme={theme}
        data-status={snap.status ?? 'idle'}
        className={cn('relative flex h-full w-full flex-col overflow-hidden text-fg', hidden && 'invisible')}
        style={{ background: THEME_COLORS[theme].bg }}
        onKeyDown={(e) => {
          // Not `defaultPrevented`: Radix marks Escape handled when it only hides a tooltip (capture listener).
          if (e.key !== 'Escape') return;
          // Popovers, menus and dialogs (portalled in here) close themselves on Escape.
          if (e.target instanceof Element && e.target.closest(LAYERS)) return;
          if (snap.drawer) dismissDrawer();
          else if (snap.selection) session?.clearSelection();
        }}
      >
        <PortalContainerContext.Provider value={root}>
          <EpubToolbar
            title={snap.title ?? ''}
            location={snap.location ?? null}
            drawer={snap.drawer ?? null}
            bookmarked={!!snap.bookmarkHere}
            ready={ready}
            onDrawer={(d) => (d === null ? dismissDrawer() : session?.setDrawer(d))}
            onBookmark={() => void session?.toggleBookmark()}
          />
          <div className="relative min-h-0 flex-1">
            <div ref={hostRef} tabIndex={-1} className="absolute inset-0 outline-none" data-testid="epub-host" />
            {/* Drawers right after the book in the DOM: Tab from the toolbar reaches them before the page arrows. */}
            {ready && session && snap.drawer === 'toc' && (
              <TocDrawer
                toc={snap.toc}
                currentId={snap.tocId}
                onGo={(href) => {
                  closeDrawer();
                  void session.goToHref(href);
                }}
                onClose={dismissDrawer}
              />
            )}
            {ready && session && snap.drawer === 'annotations' && (
              <AnnotationsDrawer
                annotations={snap.annotations}
                sectionOf={(cfi) => session.sectionOf(cfi)}
                sectionTitle={(s) => session.sectionTitle(s)}
                onGo={(uid) => {
                  closeDrawer();
                  void session.goToAnnotation(uid);
                }}
                onDelete={(uid) => void session.deleteAnnotation(uid)}
                onClose={dismissDrawer}
              />
            )}
            {ready && session && snap.drawer === 'search' && <SearchDrawer session={session} onClose={dismissDrawer} />}
            {ready && !snap.fixedLayout && (
              <>
                <IconButton
                  icon={ChevronLeft}
                  label={t('epubReader.prev')}
                  tooltip={false}
                  onClick={() => void session?.turn('left')}
                  className="absolute top-1/2 left-1 z-10 -translate-y-1/2 text-muted opacity-40 hover:opacity-100 focus-visible:opacity-100"
                />
                <IconButton
                  icon={ChevronRight}
                  label={t('epubReader.next')}
                  tooltip={false}
                  onClick={() => void session?.turn('right')}
                  className="absolute top-1/2 right-1 z-10 -translate-y-1/2 text-muted opacity-40 hover:opacity-100 focus-visible:opacity-100"
                />
              </>
            )}
            {ready && snap.bookmarkHere && <BookmarkRibbon />}
            {ready && !hidden && session && snap.selection && !snap.active && (
              <SelectionToolbar
                selection={snap.selection}
                container={root}
                lastColor={lastColor}
                onHighlight={(color) => {
                  setLastColor(color);
                  void session.annotateSelection('highlight', color);
                }}
                onUnderline={() => void session.annotateSelection('underline', lastColor)}
                onNote={() => void session.annotateSelection('note', lastColor)}
                onMenu={(key) => {
                  const sel = session.selectionNow() ?? snap.selection;
                  if (sel) eventsRef.current.onMenu(key, sel);
                }}
                onDismiss={() => session.clearSelection()}
              />
            )}
            {ready && !hidden && session && snap.active && active && (
              <AnnotationPopover
                key={snap.active.seq}
                annotation={active}
                rect={snap.active.rect}
                focusComment={snap.active.focusComment}
                container={root}
                onColor={(color) => {
                  setLastColor(color);
                  void session.updateAnnotation(active.uid, { color });
                }}
                onComment={(comment) => void session.updateAnnotation(active.uid, { comment })}
                onDelete={() => void session.deleteAnnotation(active.uid)}
                onClose={() => session.setActive(null)}
              />
            )}
            {snap.status === 'loading' && (
              <div className="absolute inset-0 z-10 flex items-center justify-center" data-testid="epub-loading">
                <Spinner label={t('epubReader.loading')} />
              </div>
            )}
            {snap.status === 'idle' && (
              <div className="absolute inset-0 flex items-center justify-center text-muted">
                <BookOpen size={28} strokeWidth={1.5} aria-hidden />
              </div>
            )}
            {snap.status === 'error' && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg" data-testid="epub-error">
                <EmptyState
                  icon={TriangleAlert}
                  title={snap.error?.message ?? t('epubReader.openFailed')}
                  description={
                    snap.error?.kind === 'drm'
                      ? undefined
                      : snap.error?.kind === 'timeout'
                        ? t('epubReader.openTimeoutHint')
                        : t('epubReader.openFailedHint')
                  }
                  action={
                    <Button variant="neutral" onClick={() => void session?.retry()?.catch(() => {})}>
                      {t('common.retry')}
                    </Button>
                  }
                />
              </div>
            )}
            {snap.notice && (
              <div className="absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
                <Notice tone="error" onDismiss={() => session?.dismissNotice()} className="max-w-md shadow-popover">
                  {snap.notice}
                </Notice>
              </div>
            )}
          </div>
          <Dialog
            open={!!snap.externalUrl}
            onOpenChange={(open) => {
              if (!open) void session?.confirmExternal(false);
            }}
            title={t('epubReader.externalTitle')}
            description={t('epubReader.externalBody')}
            footer={
              <>
                <Button variant="ghost" onClick={() => void session?.confirmExternal(false)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={() => void session?.confirmExternal(true)}>
                  {t('epubReader.externalOpen')}
                </Button>
              </>
            }
          >
            <p className="text-base break-all" data-testid="epub-external-url">
              {snap.externalUrl}
            </p>
          </Dialog>
        </PortalContainerContext.Provider>
      </div>
    );
  },
);
