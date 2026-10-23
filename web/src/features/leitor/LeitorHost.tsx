import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { AlertCircle, ExternalLink, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Dialog, Spinner, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { BookPanel, PANEL_COMPACT_QUERY, usePdfcraftTheme } from './BookPanel';
import type { LeitorSnapshot } from './controller';
import { leitorController, useLeitorState } from './instance';
import { forwardShortcuts } from './keys';

/** The PdfCraft web build, served on the same origin (spec 6.1). `?host=parent` turns its bridge on. */
export const PDFCRAFT_SRC = '/pdfcraft/index.html?host=parent';

export function isLeitorPath(pathname: string): boolean {
  return pathname === '/leitor' || pathname.startsWith('/leitor/');
}

/**
 * The Leitor tab's layer inside <main>: the PdfCraft iframe plus the "Painel Anki do livro". Mounted on the first
 * visit to /leitor (or the first openBook) and never unmounted: when another tab is showing it is only hidden
 * (visibility, inert), never `display: none`, so PdfCraft keeps its WebGL canvas and every open document.
 */
export function LeitorHost() {
  const controller = leitorController();
  const snap = useLeitorState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const livro = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown>).livro;
      return typeof v === 'string' ? v : null;
    },
  });
  const visible = isLeitorPath(pathname);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const theme = usePdfcraftTheme(snap.theme);
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

  // `/leitor?livro=<uid>` opens that book (captures, deep links inside the app).
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !livro || opened.current === livro) return;
    opened.current = livro;
    void controller.openBook(livro);
  }, [controller, visible, livro]);

  useEffect(() => {
    const onVisibility = () => controller.setPageVisible(document.visibilityState === 'visible');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [controller]);

  useEffect(() => core.onWindowCloseRequested(() => controller.onCloseRequested()), [controller]);

  if (!snap.mounted) return null;
  return (
    <div
      data-testid="leitor-host"
      data-visible={visible ? 'true' : 'false'}
      aria-hidden={!visible}
      inert={!visible}
      className="absolute inset-0 z-10 flex"
      style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
    >
      <div className="relative min-w-0 flex-1">
        <PdfcraftFrame key={snap.generation} />
        <Overlays snap={snap} />
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

function PdfcraftFrame() {
  const controller = leitorController();
  const detachKeys = useRef<(() => void) | null>(null);

  // The WindowProxy is stable across the iframe's navigations, so it can be registered before PdfCraft says ready.
  const ref = useCallback(
    (el: HTMLIFrameElement | null) => {
      controller.setFrameWindow(el?.contentWindow ?? null);
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
}

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

function Overlays({ snap }: { snap: LeitorSnapshot }) {
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
