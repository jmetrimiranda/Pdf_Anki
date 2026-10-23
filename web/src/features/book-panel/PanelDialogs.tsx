// The book panel's floating surfaces for PdfCraft's selection menu: "Criar cards com IA" (spec 10.3, Phase 8 — a
// notice for now) and "Definir palavra" (spec 12.7 — the lemma and the vocabulary note, if any).
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, Settings } from 'lucide-react';
import { Popover as P } from 'radix-ui';
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

export function DefinePopover({ request, onClose }: { request: DefineRequest | null; onClose: () => void }) {
  const container = usePortalContainer();
  const a = request?.anchor;
  return (
    <P.Root open={request !== null} onOpenChange={(o) => !o && onClose()}>
      {/* An invisible fixed box where the menu item was: Radix positions (flips, clamps) the popover against it. */}
      {createPortal(
        <P.Anchor asChild>
          <div
            aria-hidden
            data-testid="define-anchor"
            className="pointer-events-none invisible fixed"
            style={
              a
                ? { left: a.x, top: a.y, width: Math.max(1, a.width), height: Math.max(1, a.height) }
                : { left: 0, top: 0 }
            }
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
          aria-label={t('bookPanel.define.title')}
          className={cn(popoverSurface, 'w-72 max-w-[calc(100vw-16px)] p-3')}
        >
          {request && <DefineBody text={request.text} bookUid={request.bookUid} onClose={onClose} />}
        </P.Content>
      </P.Portal>
    </P.Root>
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
        <p className="text-base text-muted">
          {d.vocabRootDeckId === null ? t('bookPanel.define.noRoot') : t('bookPanel.define.noNote')}
        </p>
      )}
      <p className="border-t border-line pt-2 text-2xs text-muted">{t('bookPanel.define.footer')}</p>
    </div>
  );
}
