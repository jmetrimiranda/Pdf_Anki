// The book panel's floating surfaces for PdfCraft's selection menu: "Criar cards com IA" (spec 10.3, Phase 8 — a
// notice for now) and "Definir palavra" (spec 12.7 — the lemma and the vocabulary note, if any).
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, Settings } from 'lucide-react';
import { Popover as P } from 'radix-ui';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, popoverSurface, SkeletonLines } from '../../components/ui';
import { usePortalContainer } from '../../components/ui/portal';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import { singleWord } from './text';

export function AiDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('bookPanel.ai.title')}
      description={t('bookPanel.ai.body')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
          <Button
            variant="primary"
            icon={Settings}
            onClick={() => {
              onOpenChange(false);
              void navigate({ to: '/configuracoes/ia' });
            }}
          >
            {t('bookPanel.ai.settings')}
          </Button>
        </>
      }
    />
  );
}

/** Viewport CSS px rectangle the popover points at. */
export interface ViewportAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DefineRequest {
  text: string;
  bookUid: string | null;
  anchor: ViewportAnchor;
}

/**
 * A popover pointing at a viewport rectangle (a word in PdfCraft, a menu item): an invisible fixed box sits where
 * the anchor is and Radix positions the popover against it (flipped and clamped inside the window). Esc and a click
 * outside close it; the focus moves into it and, on close, back to `returnFocus` (e.g. the PdfCraft iframe).
 */
export function AnchoredPopover({
  anchor,
  onClose,
  label,
  testId,
  returnFocus,
  children,
}: {
  /** Null: closed. */
  anchor: ViewportAnchor | null;
  onClose: () => void;
  label: string;
  testId: string;
  returnFocus?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const container = usePortalContainer();
  const a = anchor ? clampAnchor(anchor, viewportSize()) : null;
  return (
    <P.Root open={anchor !== null} onOpenChange={(o) => !o && onClose()}>
      {createPortal(
        <P.Anchor asChild>
          <div
            aria-hidden
            data-testid={testId}
            className="pointer-events-none invisible fixed"
            style={a ? { left: a.x, top: a.y, width: a.width, height: a.height } : { left: 0, top: 0 }}
          />
        </P.Anchor>,
        container ?? document.body,
      )}
      <P.Portal container={container}>
        <P.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          className={cn(popoverSurface, 'w-72 max-w-[calc(100vw-16px)] p-3')}
          onCloseAutoFocus={(e) => {
            const el = returnFocus?.();
            if (!el) return;
            e.preventDefault();
            el.focus({ preventScroll: true });
          }}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

function viewportSize(): { width: number; height: number } {
  return typeof window === 'undefined'
    ? { width: 0, height: 0 }
    : { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The anchor kept inside the window (at least 1 px, never past an edge), so the popover never points at something
 * off screen (a word half scrolled out of PdfCraft). A zero-sized window keeps the anchor as is.
 */
export function clampAnchor(a: ViewportAnchor, view: { width: number; height: number }): ViewportAnchor {
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  let { x, y } = { x: finite(a.x), y: finite(a.y) };
  let width = Math.max(1, finite(a.width));
  let height = Math.max(1, finite(a.height));
  if (view.width > 0 && view.height > 0) {
    const x1 = Math.min(view.width, Math.max(1, x + width));
    const y1 = Math.min(view.height, Math.max(1, y + height));
    x = Math.min(Math.max(0, x), view.width - 1);
    y = Math.min(Math.max(0, y), view.height - 1);
    width = Math.max(1, x1 - x);
    height = Math.max(1, y1 - y);
  }
  return { x, y, width, height };
}

export function DefinePopover({ request, onClose }: { request: DefineRequest | null; onClose: () => void }) {
  return (
    <AnchoredPopover
      anchor={request?.anchor ?? null}
      onClose={onClose}
      label={t('bookPanel.define.title')}
      testId="define-anchor"
    >
      {request && <DefineBody text={request.text} bookUid={request.bookUid} onClose={onClose} />}
    </AnchoredPopover>
  );
}

function DefineBody({ text, bookUid, onClose }: { text: string; bookUid: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const word = singleWord(text);
  const def = useQuery({
    queryKey: ['vocabDefine', word, bookUid],
    queryFn: () => core.vocabDefine(word!, bookUid),
    enabled: word !== null,
    staleTime: 0,
  });
  if (word === null) {
    return <p className="text-base">{t('bookPanel.define.oneWord')}</p>;
  }
  const d = def.data;
  return (
    <div data-testid="define-popover" className="flex flex-col gap-2">
      <div>
        <p className="text-md font-semibold break-words">{word}</p>
        {d && <p className="text-xs text-muted">{t('bookPanel.define.lemma', { lema: d.lemma })}</p>}
      </div>
      {def.isPending ? (
        <SkeletonLines lines={2} />
      ) : def.isError || !d ? (
        <p className="text-base text-error">{t('bookPanel.define.loadError')}</p>
      ) : d.note ? (
        <div className="flex flex-col gap-1 rounded-ctl bg-surface px-2.5 py-2">
          <p className="text-base break-words">{d.note.definition || d.note.preview}</p>
          <p className="truncate text-xs text-muted" title={d.note.deckName}>
            {d.note.deckName}
          </p>
          <Button
            size="sm"
            variant="ghost"
            icon={ExternalLink}
            className="-ml-2 self-start text-link!"
            onClick={() => {
              onClose();
              void navigate({ to: '/anki/navegar', search: { busca: `nid:${d.note!.noteId}` } });
            }}
          >
            {t('bookPanel.define.openAnki')}
          </Button>
        </div>
      ) : (
        <>
          {d.wordnetDefinition ? (
            <div className="flex flex-col gap-0.5 rounded-ctl bg-surface px-2.5 py-2">
              <p className="text-base break-words">{d.wordnetDefinition}</p>
              <p className="text-xs text-muted">{t('bookPanel.define.wordnet')}</p>
            </div>
          ) : (
            <p className="text-base text-muted">{t('bookPanel.define.noDefinition')}</p>
          )}
          <p className="text-xs text-muted">
            {d.vocabRootDeckId === null ? t('bookPanel.define.noRoot') : t('bookPanel.define.noNote')}
          </p>
        </>
      )}
      <p className="border-t border-line pt-2 text-2xs text-muted">{t('bookPanel.define.footer')}</p>
    </div>
  );
}
