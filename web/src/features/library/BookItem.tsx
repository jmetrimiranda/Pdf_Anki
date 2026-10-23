import {
  BookOpen,
  ChartColumn,
  Download,
  ExternalLink,
  FolderInput,
  MoreHorizontal,
  Pencil,
  ScanText,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Badge, IconButton, Menu, ProgressBar, Tooltip, type MenuEntry } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { LibraryEntry } from '../../lib/core/client';
import { BookCover } from './BookCover';
import { progressOf } from './filter';

export type BookAction =
  'open' | 'rename' | 'move' | 'export' | 'openExternal' | 'remove' | 'vocabScan' | 'vocabReport';

export type LibraryView = 'grid' | 'list';

function BookMenu({ book, onAction }: { book: LibraryEntry; onAction: (a: BookAction) => void }) {
  const [open, setOpen] = useState(false);
  // Whether the book was scanned (spec 12) comes with the library entry: the menu is complete when it opens.
  const vocab: MenuEntry[] = book.hasText
    ? [
        { kind: 'separator' },
        { label: t('library.vocabScan'), icon: ScanText, onSelect: () => onAction('vocabScan') },
        ...(book.vocabScanned
          ? [{ label: t('library.vocabReport'), icon: ChartColumn, onSelect: () => onAction('vocabReport') }]
          : []),
      ]
    : [];
  const items: MenuEntry[] = [
    { label: t('library.open'), icon: BookOpen, onSelect: () => onAction('open') },
    ...vocab,
    { kind: 'separator' },
    { label: t('library.rename'), icon: Pencil, onSelect: () => onAction('rename') },
    { label: t('library.move'), icon: FolderInput, onSelect: () => onAction('move') },
    { kind: 'separator' },
    { label: t('library.export'), icon: Download, onSelect: () => onAction('export') },
    { label: t('library.openExternal'), icon: ExternalLink, onSelect: () => onAction('openExternal') },
    { kind: 'separator' },
    { label: t('library.remove'), icon: Trash2, danger: true, onSelect: () => onAction('remove') },
  ];
  return (
    <Menu
      label={t('library.actions', { titulo: book.title })}
      items={items}
      open={open}
      onOpenChange={setOpen}
      trigger={<IconButton icon={MoreHorizontal} label={t('library.actions', { titulo: book.title })} size="sm" />}
    />
  );
}

function ScannedBadge() {
  return (
    <Tooltip content={t('library.scannedHint')}>
      <span tabIndex={0} className="inline-flex rounded-full">
        <Badge>{t('library.scanned')}</Badge>
      </span>
    </Tooltip>
  );
}

function Progress({ book }: { book: LibraryEntry }) {
  const p = progressOf(book);
  if (!p) {
    return (
      <span className="text-xs text-muted">
        {book.pages > 0 ? t('library.pages', { n: book.pages }) : t('library.notStarted')}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <ProgressBar value={p.percent} label={t('library.progress')} />
      <span className="text-xs text-muted tabular">{t('library.pageOf', { n: p.page, total: p.total })}</span>
    </div>
  );
}

/** A book in the grid (cover card) or in the list (row). Clicking opens it in the Leitor. */
export function BookItem({
  book,
  view,
  onAction,
}: {
  book: LibraryEntry;
  view: LibraryView;
  onAction: (a: BookAction) => void;
}) {
  const author = book.author || t('library.noAuthor');
  const progress = progressOf(book);

  if (view === 'list') {
    return (
      <li
        data-testid="book"
        data-book-uid={book.bookUid}
        className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-hover"
      >
        <button
          type="button"
          onClick={() => onAction('open')}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-ctl text-left"
        >
          <BookCover book={book} className="w-10 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold" data-testid="book-title">
              {book.title}
            </span>
            <span className={cn('block truncate text-xs', book.author ? 'text-muted' : 'text-muted/70')}>
              {author}
              {progress && (
                <span className="sm:hidden"> · {t('library.pageOf', { n: progress.page, total: progress.total })}</span>
              )}
            </span>
          </span>
        </button>
        {!book.hasText && <ScannedBadge />}
        <div className="hidden w-40 shrink-0 sm:block">
          <Progress book={book} />
        </div>
        <BookMenu book={book} onAction={onAction} />
      </li>
    );
  }

  return (
    <li
      data-testid="book"
      data-book-uid={book.bookUid}
      className="group relative flex flex-col gap-2.5 rounded-box border border-line bg-card p-3 transition-colors hover:border-[color-mix(in_srgb,var(--lime)_60%,var(--border))]"
    >
      <button type="button" onClick={() => onAction('open')} className="flex flex-col gap-2.5 rounded-ctl text-left">
        <BookCover book={book} className="w-full" />
        <span className="min-w-0">
          <span className="line-clamp-2 font-semibold" data-testid="book-title">
            {book.title}
          </span>
          <span className="block truncate text-xs text-muted">{author}</span>
        </span>
      </button>
      <div className="mt-auto flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Progress book={book} />
        </div>
        <BookMenu book={book} onAction={onAction} />
      </div>
      {!book.hasText && (
        <div className="absolute top-5 left-5">
          <ScannedBadge />
        </div>
      )}
    </li>
  );
}
