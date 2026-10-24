import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { AlertCircle, ArrowLeft, ExternalLink, RotateCw } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Dialog, Spinner, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { EpubReader, useEpubTheme, type EpubReaderEvents, type EpubReaderHandle, type EpubSelection } from '../epub';
import { BookPanel, PANEL_COMPACT_QUERY, usePdfcraftTheme } from './BookPanel';
import type { PdfcraftTheme } from './bridge';
import type { EpubDrawer, EpubFront, EpubSelectionInfo, LeitorController, LeitorSnapshot } from './controller';
import { leitorController, useLeitorSelector } from './instance';
import { forwardShortcuts } from './keys';

/** The PdfCraft web build, served on the same origin (spec 6.1). `?host=parent` turns its bridge on. */
export const PDFCRAFT_SRC = '/pdfcraft/index.html?host=parent';

export function isLeitorPath(pathname: string): boolean {
  return pathname === '/leitor' || pathname.startsWith('/leitor/');
}

/** What the host shows: everything but the frequent fields it doesn't use (selection, find results, menu rects). */
type HostView = Pick<
  LeitorSnapshot,
  | 'mounted'
  | 'generation'
  | 'status'
  | 'startError'
  | 'startDetail'
  | 'activeId'
  | 'activeTitle'
  | 'openingId'
  | 'openingTitle'
  | 'openError'
  | 'theme'
  | 'panelOpen'
  | 'panelCompact'
  | 'closePrompt'
  | 'front'
  | 'pdfOpen'
  | 'epubMounted'
> & { epubUid: string | null };

function hostView(s: LeitorSnapshot): HostView {
  return {
    mounted: s.mounted,
    generation: s.generation,
    status: s.status,
    startError: s.startError,
    startDetail: s.startDetail,
    activeId: s.activeId,
    activeTitle: s.activeTitle,
    openingId: s.openingId,
    openingTitle: s.openingTitle,
    openError: s.openError,
    theme: s.theme,
    panelOpen: s.panelOpen,
    panelCompact: s.panelCompact,
    closePrompt: s.closePrompt,
    front: s.front,
    pdfOpen: s.pdfOpen,
    epubMounted: s.epubMounted,
    epubUid: s.epub?.uid ?? null,
  };
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  for (const k of Object.keys(a) as (keyof T)[]) if (!Object.is(a[k], b[k])) return false;
  return true;
}

export interface LeitorTarget {
  uid: string;
  /** 0-based page (PDF) or spine section (EPUB). */
  page?: number;
  find?: string;
  /** EPUB location. */
  cfi?: string;
}

/**
 * `/leitor?livro=<uid>&pagina=<1-based>&q=<text>` (PDF) or `&cap=<1-based>&cfi=<CFI>&q=<text>` (EPUB): what to open
 * (page/section 0-based for the controller).
 */
export function leitorSearchTarget(search: Record<string, unknown>): LeitorTarget | null {
  const uid = search.livro;
  if (typeof uid !== 'string' || !uid) return null;
  const target: LeitorTarget = { uid };
  const num = (v: unknown) => (typeof v === 'string' ? Number(v) : v);
  const pagina = num(search.pagina);
  const cap = num(search.cap);
  if (typeof pagina === 'number' && Number.isInteger(pagina) && pagina >= 1) target.page = pagina - 1;
  else if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 1) target.page = cap - 1;
  const cfi = search.cfi;
  if (typeof cfi === 'string' && cfi.trim().startsWith('epubcfi(')) target.cfi = cfi.trim();
  const q = search.q;
  if (typeof q === 'string' && q.trim()) target.find = q;
  else if (typeof q === 'number') target.find = String(q);
  return target;
}

const LATERAL: Record<string, EpubDrawer> = { sumario: 'toc', anotacoes: 'annotations', busca: 'search' };

/** `&lateral=sumario|anotacoes|busca`: the EPUB reader's drawer to open. */
export function leitorDrawer(search: Record<string, unknown>): EpubDrawer | null {
  return typeof search.lateral === 'string' ? (LATERAL[search.lateral] ?? null) : null;
}

/**
 * The Leitor tab's layer inside <main>: the PdfCraft iframe plus the "Painel Anki do livro". Mounted on the first
 * visit to /leitor (or the first openBook) and never unmounted: when another tab is showing it is only hidden
 * (visibility, inert), never `display: none`, so PdfCraft keeps its WebGL canvas and every open document.
 */
export function LeitorHost() {
  const controller = leitorController();
  const snap = useLeitorSelector(hostView, shallowEqual);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // A string key so the selector result is stable between renders.
  const livro = useRouterState({
    select: (s) => {
      const target = leitorSearchTarget(s.location.search as Record<string, unknown>);
      return target ? JSON.stringify(target) : null;
    },
  });
  const visible = isLeitorPath(pathname);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const pdfTheme = usePdfcraftTheme(snap.theme);
  const epubTheme = useEpubTheme();
  const epubFront = snap.front === 'epub' && snap.epubUid !== null;
  // The panel's neutrals follow the reader in front (spec 4): PdfCraft's theme, or the EPUB reader's (sepia is light).
  const theme: PdfcraftTheme = epubFront ? (epubTheme === 'dark' ? 'dark' : 'light') : pdfTheme;
  const compact = useMediaQuery(PANEL_COMPACT_QUERY);

  useEffect(() => controller.setPanelCompact(compact), [controller, compact]);

  useEffect(() => {
    controller.setUi({
      navigateToLeitor: () => {
        if (!isLeitorPath(window.location.pathname)) void navigate({ to: '/leitor' });
      },
      toast: (key, tone, vars) => toast.show(t(key, vars), { tone }),
      libraryChanged: () => void queryClient.invalidateQueries({ queryKey: ['library'] }),
    });
    return () => controller.setUi(null);
  }, [controller, navigate, toast, queryClient]);

  useEffect(() => {
    if (visible) controller.mount();
    controller.setVisible(visible);
  }, [controller, visible]);

  // `/leitor?livro=<uid>[&pagina=<N>&q=<text>]` opens that book, at that page finding that text (captures, links
  // inside the app).
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !livro || opened.current === livro) return;
    opened.current = livro;
    const { uid, ...opts } = JSON.parse(livro) as LeitorTarget;
    const plain = opts.page === undefined && opts.find === undefined && opts.cfi === undefined;
    void controller.openBook(uid, plain ? undefined : opts);
  }, [controller, visible, livro]);

  // `&lateral=sumario|anotacoes|busca` opens the EPUB reader's drawer once that book is in the reader.
  const lateral = useRouterState({
    select: (s) => {
      const search = s.location.search as Record<string, unknown>;
      const drawer = leitorDrawer(search);
      return drawer && typeof search.livro === 'string' ? `${search.livro}|${drawer}` : null;
    },
  });
  const drawerOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !lateral || drawerOpened.current === lateral || snap.epubUid === null) return;
    const [uid, drawer] = lateral.split('|') as [string, EpubDrawer];
    if (uid !== snap.epubUid) return;
    drawerOpened.current = lateral;
    void controller.openEpubDrawer(uid, drawer);
  }, [controller, visible, lateral, snap.epubUid]);

  useEffect(() => {
    const onVisibility = () => controller.setPageVisible(document.visibilityState === 'visible');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [controller]);

  useEffect(() => core.onWindowCloseRequested(() => controller.onCloseRequested()), [controller]);

  // The collection changed (import, sync, a generated deck, the Anki pages): the highlighted words may have changed.
  useEffect(() => core.onAnkiChanged(() => controller.refreshVocab()), [controller]);

  // `/leitor?livro=<uid>&realce=1` turns "Realçar vocabulário" on for that book (captures, tests).
  const realce = useRouterState({
    select: (s) => {
      const search = s.location.search as Record<string, unknown>;
      const on = search.realce === 1 || search.realce === '1' || search.realce === true;
      return on && typeof search.livro === 'string' ? search.livro : null;
    },
  });
  useEffect(() => {
    if (visible && realce) controller.setHighlight(realce, true);
  }, [controller, visible, realce]);

  if (!snap.mounted && !snap.epubMounted) return null;
  // The reader not in front is only hidden (visibility, inert), never unmounted: PdfCraft keeps its WebGL canvas and
  // documents, the EPUB reader its book and place.
  const hide = { visibility: 'hidden', pointerEvents: 'none' } as const;
  return (
    <div
      data-testid="leitor-host"
      data-visible={visible ? 'true' : 'false'}
      data-front={epubFront ? 'epub' : 'pdfcraft'}
      aria-hidden={!visible}
      inert={!visible}
      className="absolute inset-0 z-10 flex"
      style={visible ? undefined : hide}
    >
      <div className="relative min-w-0 flex-1">
        <div
          data-testid="leitor-pdfcraft"
          className="absolute inset-0"
          aria-hidden={epubFront || undefined}
          inert={epubFront}
          style={epubFront ? hide : undefined}
        >
          {snap.mounted && <PdfcraftFrame key={snap.generation} />}
          {snap.mounted && <Overlays snap={snap} />}
        </div>
        {snap.epubMounted && (
          <EpubLayer controller={controller} front={epubFront} showBack={epubFront && snap.pdfOpen} />
        )}
      </div>
      <BookPanel
        open={snap.panelOpen}
        overlay={snap.panelCompact}
        theme={theme}
        bookTitle={snap.activeId ? (snap.activeTitle ?? '') : null}
        onToggle={() => controller.togglePanel()}
      />
      <Dialog
        open={snap.closePrompt}
        onOpenChange={(open) => {
          if (!open) controller.answerClosePrompt(false);
        }}
        title={t('reader.unsavedTitle')}
        description={t('reader.unsavedBody')}
        footer={
          <>
            <Button variant="neutral" onClick={() => controller.answerClosePrompt(false)}>
              {t('reader.cancel')}
            </Button>
            <Button variant="danger" onClick={() => controller.answerClosePrompt(true)}>
              {t('reader.closeAnyway')}
            </Button>
          </>
        }
      />
    </div>
  );
}

function toSelectionInfo(s: EpubSelection, controller: LeitorController): EpubSelectionInfo {
  const epub = controller.snapshot().epub;
  return {
    text: s.text,
    cfi: s.cfi,
    section: s.section,
    tocLabel: epub && epub.section === s.section ? epub.tocLabel : null,
  };
}

/**
 * The EPUB reader (features/epub) in the Leitor tab, wired to the controller: its events become the controller's
 * EPUB calls, and the controller drives it through an `EpubFront` adapter. "Voltar aos PDFs" brings PdfCraft back
 * when it has books open (the EPUB stays loaded behind).
 */
const EpubLayer = memo(function EpubLayer({
  controller,
  front,
  showBack,
}: {
  controller: LeitorController;
  front: boolean;
  showBack: boolean;
}) {
  const handle = useRef<EpubReaderHandle | null>(null);
  const area = useRef<HTMLDivElement>(null);

  /** A rect relative to the reader's book area (`epub-host`) → viewport CSS px. */
  const toViewport = useCallback((rect: [number, number, number, number]) => {
    const host = area.current?.querySelector('[data-testid="epub-host"]') ?? area.current;
    const r = host?.getBoundingClientRect();
    return { x: (r?.left ?? 0) + rect[0], y: (r?.top ?? 0) + rect[1], width: rect[2], height: rect[3] };
  }, []);

  const events = useMemo<EpubReaderEvents>(
    () => ({
      onLocation: (l) => controller.epubLocation(l.uid, l),
      onActivity: (uid) => controller.epubActivity(uid),
      onSelection: (s) => {
        const uid = s?.uid ?? controller.snapshot().epub?.uid;
        if (uid) controller.epubSelection(uid, s ? toSelectionInfo(s, controller) : null);
      },
      onMenu: (key, s) => controller.epubMenu(s.uid, key, toSelectionInfo(s, controller), toViewport(s.rect)),
      onVocabClick: (e) => controller.epubVocabClick(e.uid, e.section, e.form, e.lemma, toViewport(e.rect)),
      onSectionShown: (uid, section) => controller.epubSectionShown(uid, section),
      onKey: (e) => {
        // App shortcuts typed inside the book: the shell listens on the document (same as for PdfCraft's iframe).
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: e.key,
            code: e.code,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            repeat: e.repeat,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      onError: (message) => controller.core.log('warn', `epub: ${message}`),
    }),
    [controller, toViewport],
  );

  const adapter = useMemo<EpubFront>(
    () => ({
      open: async (o) => {
        const h = handle.current;
        if (!h) return null;
        try {
          return await h.open({
            uid: o.uid,
            bytes: o.bytes instanceof Uint8Array ? o.bytes : new Uint8Array(o.bytes),
            title: o.title,
            cfi: o.cfi,
            section: o.section ?? null,
            find: o.find ?? null,
          });
        } catch (e) {
          controller.core.log('warn', `epub open: ${String(e)}`);
          return null;
        }
      },
      goTo: async (o) => {
        const h = handle.current;
        if (!h) return false;
        const r = await h.goTo({ cfi: o.cfi ?? null, section: o.section ?? null, find: o.find ?? null });
        return r.found !== false;
      },
      openDrawer: (which) => handle.current?.openDrawer(which),
      setVocabMarks: (section, words) => handle.current?.setVocabMarks(section, words),
      clearVocabMarks: () => handle.current?.clearVocabMarks(),
      selectionNow: () => {
        const s = handle.current?.selectionNow() ?? null;
        return s ? toSelectionInfo(s, controller) : null;
      },
      flush: () => {
        const l = handle.current?.currentLocation();
        if (l) controller.epubLocation(l.uid, l);
      },
    }),
    [controller],
  );

  const ref = useCallback(
    (h: EpubReaderHandle | null) => {
      handle.current = h;
      controller.setEpubFront(h ? adapter : null);
    },
    [controller, adapter],
  );

  return (
    <div
      ref={area}
      data-testid="leitor-epub"
      className="absolute inset-0 flex flex-col"
      aria-hidden={!front || undefined}
      inert={!front}
      style={front ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
    >
      {showBack && (
        <div className="flex h-8 shrink-0 items-center border-b border-line bg-bg px-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={ArrowLeft}
            title={t('epub.backToPdfsHint')}
            onClick={() => controller.showFront('pdfcraft')}
            data-testid="epub-back-to-pdfs"
            className="text-muted hover:text-fg"
          >
            {t('epub.backToPdfs')}
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <EpubReader ref={ref} events={events} hidden={!front} />
      </div>
    </div>
  );
});

/** Memoized: no props, so nothing the host re-renders for ever touches the iframe element. */
const PdfcraftFrame = memo(function PdfcraftFrame() {
  const controller = leitorController();
  const detachKeys = useRef<(() => void) | null>(null);

  // The WindowProxy is stable across the iframe's navigations, so it can be registered before PdfCraft says ready.
  const ref = useCallback(
    (el: HTMLIFrameElement | null) => {
      controller.setFrameWindow(el?.contentWindow ?? null);
      controller.setFrameElement(el);
      if (!el) {
        detachKeys.current?.();
        detachKeys.current = null;
      }
    },
    [controller],
  );

  const onLoad = (e: SyntheticEvent<HTMLIFrameElement>) => {
    const win = e.currentTarget.contentWindow;
    detachKeys.current?.();
    detachKeys.current = null;
    if (!win) return;
    try {
      detachKeys.current = forwardShortcuts(win, document);
      // PdfCraft's document going away (a reload inside the iframe): whatever was open there is gone.
      win.addEventListener('pagehide', () => controller.frameReloaded(), { once: true });
    } catch {
      // Not same-origin (should never happen): the app shortcuts just don't work inside PdfCraft.
    }
  };

  return (
    <iframe
      ref={ref}
      src={PDFCRAFT_SRC}
      title="PdfCraft"
      allow="clipboard-read; clipboard-write; fullscreen"
      onLoad={onLoad}
      className="absolute inset-0 block size-full border-0"
    />
  );
});

function Overlay({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex items-center justify-center bg-bg/80 p-6">{children}</div>;
}

/** A non-blocking progress chip centered over PdfCraft. */
function ProgressChip({ label, testId }: { label: string; testId: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span
        role="status"
        data-testid={testId}
        className="inline-flex max-w-[min(28rem,90%)] items-center gap-2 rounded-ctl border border-line bg-card px-3 py-1.5 text-base text-muted"
      >
        <Spinner />
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </div>
  );
}

function Overlays({ snap }: { snap: HostView }) {
  const controller = leitorController();
  if (snap.status === 'loading') return <ProgressChip testId="leitor-loading" label={t('reader.loading')} />;
  if (snap.status === 'failed') {
    const hint =
      snap.startError === 'build-missing'
        ? t('reader.buildMissing')
        : snap.startError === 'old-bridge'
          ? t('reader.oldBridge')
          : t('reader.startFailedHint', { erro: snap.startDetail ?? t('errors.unexpected') });
    return (
      <Overlay>
        <ErrorCard
          title={t('reader.startFailedTitle')}
          body={hint}
          actions={
            <Button icon={RotateCw} onClick={() => controller.restart()}>
              {t('reader.retry')}
            </Button>
          }
        />
      </Overlay>
    );
  }
  if (snap.openError) {
    const { uid, title, kind, error } = snap.openError;
    const hint =
      kind === 'timeout'
        ? t('reader.openTimeoutHint')
        : kind === 'core'
          ? t('reader.openCoreFailedHint')
          : t('reader.openFailedHint');
    return (
      <Overlay>
        <ErrorCard
          title={t('reader.openFailedTitle', { titulo: title })}
          body={hint}
          detail={error ? t('reader.openDetail', { erro: error }) : undefined}
          actions={
            <>
              <Button variant="ghost" onClick={() => controller.dismissOpenError()}>
                {t('reader.cancel')}
              </Button>
              <Button icon={RotateCw} onClick={() => void controller.openBook(uid)}>
                {t('reader.retry')}
              </Button>
              <Button variant="primary" icon={ExternalLink} onClick={() => void controller.openExternal(uid)}>
                {t('reader.openExternal')}
              </Button>
            </>
          }
        />
      </Overlay>
    );
  }
  if (snap.status === 'ready' && snap.openingId) {
    return (
      <ProgressChip
        testId="leitor-opening"
        label={snap.openingTitle ? t('reader.opening', { titulo: snap.openingTitle }) : t('reader.openingUntitled')}
      />
    );
  }
  return null;
}

function ErrorCard({
  title,
  body,
  detail,
  actions,
}: {
  title: string;
  body: string;
  /** Technical text (PdfCraft's or the core's), small and secondary. */
  detail?: string | undefined;
  actions: ReactNode;
}) {
  return (
    <section
      role="alert"
      className="w-full max-w-md rounded-box border border-line bg-card p-5 text-fg"
      data-testid="leitor-error"
    >
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <AlertCircle size={18} className="shrink-0 text-error" aria-hidden />
        {title}
      </h2>
      {body && <p className="mt-1.5 text-base break-words text-muted">{body}</p>}
      {detail && (
        <p data-testid="leitor-error-detail" className="mt-2 text-xs break-words text-muted">
          {detail}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">{actions}</div>
    </section>
  );
}
