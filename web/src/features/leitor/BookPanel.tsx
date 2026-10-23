import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { CSSProperties } from 'react';
import { IconButton } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/useMediaQuery';
import type { PdfcraftTheme } from './bridge';

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

/** "Painel Anki do livro" (spec 10): a placeholder in Phase 1, the real content arrives in Phase 4. */
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
  const style = {
    ...PDFCRAFT_NEUTRALS[theme],
    width: open ? (overlay ? `min(${PANEL_WIDTH}px, calc(100% - ${RAIL_WIDTH * 2}px))` : PANEL_WIDTH) : RAIL_WIDTH,
  } as CSSProperties;
  const aside = (
    <aside
      aria-label={t('panel.label')}
      data-testid="book-panel"
      data-theme-pdfcraft={theme}
      data-open={open ? 'true' : 'false'}
      data-overlay={overlay ? 'true' : 'false'}
      style={style}
      onKeyDown={
        overlay && open
          ? (e) => {
              if (e.key === 'Escape') {
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
        overlay && open && 'shadow-[-8px_0_24px_rgb(0_0_0/0.18)]',
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
          {bookTitle ? (
            <p className="text-(--pc-muted)">{t('panel.soon')}</p>
          ) : (
            <p className="text-(--pc-muted)">{t('panel.noBook')}</p>
          )}
        </div>
      )}
    </aside>
  );
  if (!overlay) return aside;
  // The rail's width stays in the flow, so opening the overlay never resizes PdfCraft.
  return (
    <>
      <div aria-hidden className="shrink-0" style={{ width: RAIL_WIDTH }} />
      {aside}
    </>
  );
}
