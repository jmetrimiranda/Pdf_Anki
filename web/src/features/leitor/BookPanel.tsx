import { useRouterState } from '@tanstack/react-router';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { IconButton, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { AiDialog, BookPanelContent, DefinePopover, type CardSelection, type DefineRequest } from '../book-panel';
import type { PdfcraftTheme } from './bridge';
import type { LeitorSelection, MarkClick, PanelRequest } from './controller';
import { leitor, useLeitorSelector } from './instance';
import { VocabPopover } from './VocabPopover';

/**
 * PdfCraft's neutral tokens (third_party/pdfcraft/crates/ui-egui/src/theme.rs, light/dark palettes at the pinned
 * commit): the panel docks next to the iframe like one of PdfCraft's own side panels (`panel` background,
 * `border` edge), and its header continues PdfCraft's tab band (`titlebar`, 39 px). Only these neutrals follow
 * PdfCraft (spec 4); accent and typography stay the app's.
 */
export const PDFCRAFT_NEUTRALS: Record<PdfcraftTheme, Record<string, string>> = {
  light: {
    '--pc-titlebar': '#e9e9eb',
    '--pc-panel': '#ffffff',
    '--pc-border': '#dadade',
    '--pc-text': '#222226',
    '--pc-muted': '#5e5e66',
    '--pc-hover': '#f0f0f3',
  },
  dark: {
    '--pc-titlebar': '#1b1b1e',
    '--pc-panel': '#26262a',
    '--pc-border': '#3c3c43',
    '--pc-text': '#ececef',
    '--pc-muted': '#aeaeb6',
    '--pc-hover': '#34343a',
  },
};

/**
 * The app's own tokens inside the panel follow PdfCraft's neutrals, so buttons, fields and lists blend with the
 * theme PdfCraft is using (accent, status and link colors stay the app's, in PdfCraft's light/dark variant).
 */
const APP_TOKENS_FROM_PDFCRAFT: Record<string, string> = {
  '--bg': 'var(--pc-panel)',
  '--card': 'var(--pc-panel)',
  '--border': 'var(--pc-border)',
  '--text': 'var(--pc-text)',
  '--muted': 'var(--pc-muted)',
  '--neutral-btn': 'var(--pc-hover)',
};

export const PANEL_WIDTH = 320;
const RAIL_WIDTH = 40;
/**
 * Below this width the panel would squeeze PdfCraft's own toolbars (tab band, "Find tools", search box): it starts
 * closed and, when opened, floats over the iframe instead of taking its width.
 */
export const PANEL_COMPACT_QUERY = '(max-width: 1023px)';

export function usePdfcraftTheme(reported: PdfcraftTheme | null): PdfcraftTheme {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  return reported ?? (prefersDark ? 'dark' : 'light');
}

/** `/leitor?painel=card|revisar|definir&trecho=…` (captures, e2e): what the panel opens on its own. */
function useCaptureRequest(): { painel: string; trecho: string | null; livro: string | null } | null {
  const key = useRouterState({
    select: (s) => {
      if (s.location.pathname !== '/leitor') return null;
      const search = s.location.search as Record<string, unknown>;
      const painel = search.painel;
      if (painel !== 'card' && painel !== 'revisar' && painel !== 'definir') return null;
      const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
      return JSON.stringify({ painel, trecho: text(search.trecho), livro: text(search.livro) });
    },
  });
  return key ? (JSON.parse(key) as { painel: string; trecho: string | null; livro: string | null }) : null;
}

function sameSelection(a: LeitorSelection | null, b: LeitorSelection | null): boolean {
  return a === b || (!!a && !!b && a.id === b.id && a.page === b.page && a.text === b.text);
}

/**
 * "Painel Anki do livro" (spec 10): the shell docked next to PdfCraft (or floating over it in a compact window).
 * It always listens for the panel requests of PdfCraft's selection menu and the shortcuts, even while closed.
 */
export function BookPanel({
  open,
  theme,
  bookTitle,
  overlay = false,
  onToggle,
}: {
  open: boolean;
  theme: PdfcraftTheme;
  bookTitle: string | null;
  /** Compact window: only the rail takes width; the open panel floats over PdfCraft. */
  overlay?: boolean;
  onToggle: () => void;
}) {
  const toast = useToast();
  const bookUid = useLeitorSelector((s) => s.activeBookUid);
  const page = useLeitorSelector((s) => s.page);
  const unit = useLeitorSelector((s) => (s.front === 'epub' && s.epub ? 'chapter' : 'page'));
  // The EPUB in front and where it is (the capture request's passage belongs there).
  const epubKey = useLeitorSelector((s) =>
    s.front === 'epub' && s.epub ? JSON.stringify({ uid: s.epub.uid, cfi: s.epub.cfi, label: s.epub.tocLabel }) : null,
  );
  const epubPlace = epubKey ? (JSON.parse(epubKey) as { uid: string; cfi: string | null; label: string | null }) : null;
  const selection = useLeitorSelector(
    (s) => (s.selection && s.selection.id === s.activeBookUid ? s.selection : null),
    sameSelection,
  );
  const asideRef = useRef<HTMLElement>(null);
  const [card, setCard] = useState<(CardSelection & { uid: string }) | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [define, setDefine] = useState<DefineRequest | null>(null);
  const [reviewRequest, setReviewRequest] = useState(false);
  const [markClick, setMarkClick] = useState<MarkClick | null>(null);

  /** Where a popover opened without a menu anchor points: the panel's top-left corner (or its rail). */
  const panelAnchor = useCallback(() => {
    const r = asideRef.current?.getBoundingClientRect();
    return r ? { x: r.left + 8, y: r.top + 44, width: 1, height: 1 } : { x: 16, y: 56, width: 1, height: 1 };
  }, []);

  const handle = useCallback(
    (r: PanelRequest) => {
      if (r.kind === 'ai') {
        setAiOpen(true);
        return;
      }
      if (r.kind === 'define') {
        setDefine({
          text: r.selection?.text ?? '',
          bookUid: r.selection?.id ?? null,
          page: r.selection?.page ?? null,
          anchor: r.anchor ?? panelAnchor(),
        });
        return;
      }
      if (!r.selection || !r.selection.text.trim()) {
        toast.show(t('bookPanel.selectFirst'), { tone: 'info' });
        return;
      }
      const { id, page: p, text, rects, unit: u, cfi, label } = r.selection;
      if (id === null) {
        toast.show(t('bookPanel.notInLibrary'), { tone: 'info' });
        return;
      }
      setCard({
        uid: id,
        page: p,
        text,
        rects,
        ...(u === 'chapter' ? { unit: u, cfi: cfi ?? null, label: label ?? null } : {}),
      });
    },
    [toast, panelAnchor],
  );

  useEffect(() => leitor.onPanelRequest(handle), [handle]);
  // A click on a highlighted word (spec 12.7): the popover over it.
  useEffect(() => leitor.onMarkClick(setMarkClick), []);

  // A form or a review belongs to the book it was opened for.
  useEffect(() => {
    setCard((c) => (c && c.uid !== bookUid ? null : c));
    setReviewRequest(false);
    setMarkClick((m) => (m && m.id !== bookUid ? null : m));
  }, [bookUid]);

  // Capture/test parameters, applied once the book they name is in front.
  const capture = useCaptureRequest();
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!capture || !bookUid || (capture.livro && capture.livro !== bookUid)) return;
    const key = JSON.stringify(capture);
    if (applied.current === key) return;
    applied.current = key;
    // An EPUB in front: the passage belongs to the section on screen, at the reader's location.
    const sel = {
      id: bookUid,
      page,
      text: capture.trecho ?? '',
      rects: [],
      ...(epubPlace && epubPlace.uid === bookUid
        ? { unit: 'chapter' as const, cfi: epubPlace.cfi, label: epubPlace.label }
        : {}),
    };
    if (capture.painel === 'card') {
      if (!open) leitor.togglePanel(true);
      handle({ kind: 'card', via: 'button', selection: sel.text ? sel : null, anchor: null });
    } else if (capture.painel === 'definir') {
      handle({ kind: 'define', via: 'button', selection: sel, anchor: null });
    } else {
      if (!open) leitor.togglePanel(true);
      setReviewRequest(true);
    }
  }, [capture, bookUid, page, open, handle]);

  const onReviewStarted = useCallback(() => setReviewRequest(false), []);

  const style = {
    ...PDFCRAFT_NEUTRALS[theme],
    ...APP_TOKENS_FROM_PDFCRAFT,
    width: open ? (overlay ? `min(${PANEL_WIDTH}px, calc(100% - ${RAIL_WIDTH * 2}px))` : PANEL_WIDTH) : RAIL_WIDTH,
  } as CSSProperties;
  const showContent = open && bookUid !== null && bookTitle !== null;
  const aside = (
    <aside
      ref={asideRef}
      aria-label={t('panel.label')}
      data-testid="book-panel"
      data-theme={theme}
      data-theme-pdfcraft={theme}
      data-open={open ? 'true' : 'false'}
      data-overlay={overlay ? 'true' : 'false'}
      style={style}
      onKeyDown={
        overlay && open
          ? (e) => {
              if (e.key === 'Escape' && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) {
                e.stopPropagation();
                onToggle();
              }
            }
          : undefined
      }
      className={cn(
        'flex shrink-0 flex-col overflow-hidden border-l border-(--pc-border) bg-(--pc-panel) text-(--pc-text)',
        'transition-[width] duration-150 ease-out motion-reduce:transition-none',
        overlay && 'absolute inset-y-0 right-0 z-20',
        overlay && open && 'shadow-[-4px_0_12px_rgb(0_0_0/0.12)]',
      )}
    >
      <header
        className={cn(
          'flex h-[39px] shrink-0 items-center gap-2 bg-(--pc-titlebar)',
          open ? 'pr-1.5 pl-3' : 'justify-center',
        )}
      >
        {open && (
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
            {t('panel.title')}
            {bookTitle && <span className="font-normal text-(--pc-muted)"> · {bookTitle}</span>}
          </h2>
        )}
        <IconButton
          icon={open ? PanelRightClose : PanelRightOpen}
          label={open ? t('panel.hide') : t('panel.show')}
          size="sm"
          className="text-(--pc-muted)! hover:bg-(--pc-hover)! hover:text-(--pc-text)!"
          onClick={onToggle}
        />
      </header>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3 text-base">
          {showContent ? (
            <BookPanelContent
              key={bookUid}
              bookUid={bookUid}
              title={bookTitle}
              page={page}
              unit={unit}
              selection={selection}
              cardRequest={card && card.uid === bookUid ? card : null}
              onCardDone={() => setCard(null)}
              reviewRequest={reviewRequest}
              onReviewStarted={onReviewStarted}
            />
          ) : (
            <p className="text-(--pc-muted)">{t('panel.noBook')}</p>
          )}
        </div>
      )}
    </aside>
  );
  const floating = (
    <>
      <AiDialog open={aiOpen} onOpenChange={setAiOpen} />
      <DefinePopover request={define} onClose={() => setDefine(null)} />
      <VocabPopover click={markClick} onClose={() => setMarkClick(null)} />
    </>
  );
  if (!overlay)
    return (
      <>
        {aside}
        {floating}
      </>
    );
  // The rail's width stays in the flow, so opening the overlay never resizes PdfCraft.
  return (
    <>
      <div aria-hidden className="shrink-0" style={{ width: RAIL_WIDTH }} />
      {aside}
      {floating}
    </>
  );
}
