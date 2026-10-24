// The EPUB reader's toolbar, quiet like PdfCraft's chrome: Sumário, the title, the progress ("Cap. 3 · 42%"),
// Buscar, "Aa" (theme, letter size, line spacing), Anotações and the bookmark of the visible page.
import { ALargeSmall, Bookmark, BookmarkCheck, ListTree, Minus, NotebookPen, Plus, Search } from 'lucide-react';
import { IconButton, Popover, SegmentedControl, Tooltip } from '../../components/ui';
import { t } from '../../i18n';
import { FONT_MAX, FONT_MIN, FONT_STEP, setPrefs, useEpubPrefs, type EpubTheme, type LineHeight } from './prefs';
import type { DrawerKind, EpubLocation } from './types';

export function progressLabel(location: EpubLocation | null): string {
  if (!location) return '';
  const pct = `${Math.round(location.fraction * 100)}%`;
  return t('epubReader.progressChapter', { n: location.section + 1, pct });
}

function AppearancePopover() {
  const prefs = useEpubPrefs();
  return (
    <Popover
      align="end"
      className="w-72"
      trigger={<IconButton icon={ALargeSmall} label={t('epubReader.appearance')} data-testid="epub-appearance" />}
    >
      <div className="flex flex-col gap-4" data-testid="epub-appearance-panel">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">{t('epubReader.theme')}</span>
          <SegmentedControl<EpubTheme>
            label={t('epubReader.theme')}
            value={prefs.theme}
            onChange={(theme) => setPrefs({ theme })}
            options={[
              { value: 'light', label: t('epubReader.theme.light') },
              { value: 'sepia', label: t('epubReader.theme.sepia') },
              { value: 'dark', label: t('epubReader.theme.dark') },
            ]}
            className="w-full [&>button]:flex-1 [&>button]:justify-center"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted" id="epub-font-size-label">
            {t('epubReader.fontSize')}
          </span>
          <div className="flex items-center justify-between gap-2" role="group" aria-labelledby="epub-font-size-label">
            <IconButton
              icon={Minus}
              variant="neutral"
              label={t('epubReader.fontSmaller')}
              disabled={prefs.fontSize <= FONT_MIN}
              onClick={() => setPrefs({ fontSize: prefs.fontSize - FONT_STEP })}
            />
            <output className="tabular text-base font-semibold" data-testid="epub-font-size" aria-live="polite">
              {prefs.fontSize}%
            </output>
            <IconButton
              icon={Plus}
              variant="neutral"
              label={t('epubReader.fontLarger')}
              disabled={prefs.fontSize >= FONT_MAX}
              onClick={() => setPrefs({ fontSize: prefs.fontSize + FONT_STEP })}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">{t('epubReader.lineHeight')}</span>
          <SegmentedControl<LineHeight>
            label={t('epubReader.lineHeight')}
            value={prefs.lineHeight}
            onChange={(lineHeight) => setPrefs({ lineHeight })}
            options={[
              { value: 'compact', label: t('epubReader.lineHeight.compact') },
              { value: 'normal', label: t('epubReader.lineHeight.normal') },
              { value: 'relaxed', label: t('epubReader.lineHeight.relaxed') },
            ]}
            size="sm"
            className="w-full [&>button]:flex-1 [&>button]:justify-center"
          />
        </div>
      </div>
    </Popover>
  );
}

export function EpubToolbar({
  title,
  location,
  drawer,
  bookmarked,
  ready,
  onDrawer,
  onBookmark,
}: {
  title: string;
  location: EpubLocation | null;
  drawer: DrawerKind | null;
  bookmarked: boolean;
  ready: boolean;
  onDrawer: (d: DrawerKind | null) => void;
  onBookmark: () => void;
}) {
  const toggle = (d: DrawerKind) => onDrawer(drawer === d ? null : d);
  const progress = progressLabel(location);
  return (
    <div
      role="toolbar"
      aria-label={t('epubReader.toolbar')}
      className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-1.5"
    >
      <IconButton
        icon={ListTree}
        label={t('epubReader.toc')}
        active={drawer === 'toc'}
        disabled={!ready}
        onClick={() => toggle('toc')}
        data-testid="epub-toc-button"
      />
      <div className="flex min-w-0 flex-1 items-baseline justify-center gap-2 px-2">
        <span className="truncate text-base font-semibold" data-testid="epub-title">
          {title}
        </span>
        {progress && (
          <Tooltip content={location?.tocLabel ?? t('epubReader.progress')}>
            <span
              className="shrink-0 text-xs text-muted tabular"
              data-testid="epub-progress"
              aria-label={t('epubReader.progress')}
            >
              {progress}
            </span>
          </Tooltip>
        )}
      </div>
      <IconButton
        icon={Search}
        label={t('epubReader.search')}
        active={drawer === 'search'}
        disabled={!ready}
        onClick={() => toggle('search')}
        data-testid="epub-search-button"
      />
      <AppearancePopover />
      <IconButton
        icon={NotebookPen}
        label={t('epubReader.annotations')}
        active={drawer === 'annotations'}
        disabled={!ready}
        onClick={() => toggle('annotations')}
        data-testid="epub-annotations-button"
      />
      <IconButton
        icon={bookmarked ? BookmarkCheck : Bookmark}
        label={bookmarked ? t('epubReader.bookmarkRemove') : t('epubReader.bookmarkAdd')}
        active={bookmarked}
        disabled={!ready}
        onClick={onBookmark}
        data-testid="epub-bookmark-button"
      />
    </div>
  );
}
