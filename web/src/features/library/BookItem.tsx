import {
  CloudDownload,
  BookOpen,
  ChartColumn,
  Download,
  ExternalLink,
  FolderInput,
  MoreHorizontal,
  Pencil,
  ScanLine,
  ScanText,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, IconButton, Menu, ProgressBar, Tooltip, type MenuEntry } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { LibraryEntry } from '../../lib/core/client';
import { OcrProgress, ocrBusy, ocrEligible, useOcrJob, type OcrJob } from '../ocr';
import { BookCover } from './BookCover';
import { progressOf } from './filter';

export type BookAction =
  | 'open'
  | 'rename'
  | 'move'
  | 'export'
  | 'openExternal'
  | 'remove'
  | 'vocabScan'
  | 'vocabReport'
  | 'ocr'
  | 'download';

/** The book's current file is on this device (else it came from another PC: "Baixar", spec 16). */
export function onDevice(book: LibraryEntry): boolean {
  return book.localPath !== null && book.localHash === book.fileHash;
}

function DownloadButton({ book, onAction }: { book: LibraryEntry; onAction: (a: BookAction) => void }) {
  return (
    <Button
      size="sm"
      variant="neutral"
      icon={CloudDownload}
      data-testid="book-download"
      aria-label={t('librarySync.downloadLabel', { titulo: book.title })}
      title={t('librarySync.notHere')}
      onClick={() => onAction('download')}
    >
      {t('librarySync.download')}
    </Button>
  );
}

export type LibraryView = 'grid' | 'list';

function BookMenu({
  book,
  offerOcr,
  onAction,
}: {
  book: LibraryEntry;
  offerOcr: boolean;
  onAction: (a: BookAction) => void;
}) {
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
  const ocr: MenuEntry[] = offerOcr
    ? [{ kind: 'separator' }, { label: t('ocr.action'), icon: ScanLine, onSelect: () => onAction('ocr') }]
    : [];
  const items: MenuEntry[] = [
    { label: t('library.open'), icon: BookOpen, onSelect: () => onAction('open') },
    ...ocr,
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
    <Tooltip content={t('ocr.scannedHint')}>
      <span tabIndex={0} className="inline-flex rounded-full" data-testid="scanned-badge">
        <Badge>{t('ocr.scanned')}</Badge>
      </span>
    </Tooltip>
  );
}

function FormatBadge({ book }: { book: LibraryEntry }) {
  if (book.format !== 'epub') return null;
  return (
    <span
      className="inline-flex rounded-full"
      data-testid="format-badge"
      aria-label={t('ocr.library.formatLabel', { formato: t('ocr.library.epub') })}
    >
      <Badge>{t('ocr.library.epub')}</Badge>
    </span>
  );
}

/** The book's OCR line: the running job, or the inline "Reconhecer texto" offer for a scanned PDF. */
function OcrLine({ book, job, onAction }: { book: LibraryEntry; job: OcrJob; onAction: (a: BookAction) => void }) {
  if (ocrBusy(job.state)) {
    return <OcrProgress state={job.state} title={book.title} onCancel={() => void job.cancel()} />;
  }
  if (job.state.phase === 'failed') {
    return (
      <div className="flex min-h-7 items-center gap-1.5 text-xs" role="alert">
        <span className="min-w-0 flex-1 truncate text-error" title={job.state.error ?? undefined}>
          {t('ocr.failedShort')}
        </span>
        <Button size="sm" variant="ghost" className="-mr-1.5 shrink-0" onClick={() => void job.start()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant="ghost" icon={ScanLine} className="-ml-1.5 self-start" onClick={() => onAction('ocr')}>
      {t('ocr.action')}
    </Button>
  );
}

function Progress({ book }: { book: LibraryEntry }) {
  const p = progressOf(book);
  if (!p) {
    return (
      <span className="text-xs text-muted">
        {book.format === 'pdf' && book.pages > 0 ? t('library.pages', { n: book.pages }) : t('library.notStarted')}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <ProgressBar value={p.percent} label={t('library.progress')} />
      <span className="text-xs text-muted tabular">
        {book.format === 'epub'
          ? t('ocr.library.percentRead', { pct: p.percent })
          : t('library.pageOf', { n: p.page, total: p.total })}
      </span>
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
  const eligible = ocrEligible(book);
  const job = useOcrJob(book.bookUid, { enabled: eligible });
  // Right after a run the library may still hold the old entry: the job's end decides until it refreshes.
  const recognised = job.state.phase === 'done';
  const scanned = book.format === 'pdf' && !book.hasText && !recognised;
  const showOcr = !recognised && (ocrBusy(job.state) || eligible || job.state.phase === 'failed');
  const offerOcr = showOcr && !ocrBusy(job.state);
  const mobileOcr = showOcr && (ocrBusy(job.state) || job.state.phase === 'failed');
  const badges = (
    <>
      <FormatBadge book={book} />
      {scanned && <ScannedBadge />}
    </>
  );

  if (view === 'list') {
    return (
      <li
        data-testid="book"
        data-book-uid={book.bookUid}
        data-format={book.format}
        className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 transition-colors hover:bg-hover"
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
                <span className="sm:hidden">
                  {' · '}
                  {book.format === 'epub'
                    ? t('ocr.library.percentRead', { pct: progress.percent })
                    : t('library.pageOf', { n: progress.page, total: progress.total })}
                </span>
              )}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {badges}
          {!onDevice(book) && <DownloadButton book={book} onAction={onAction} />}
        </div>
        {showOcr && (
          <div
            data-testid="ocr-line"
            className={cn(
              'flex shrink-0 sm:w-56 sm:justify-end',
              // Narrow screens: a running or failed job gets its own row under the title (progress, cancel, retry);
              // the plain offer stays in the ⋯ menu.
              'max-sm:order-last max-sm:basis-full max-sm:pl-13 max-sm:*:flex-1',
              !mobileOcr && 'max-sm:hidden',
            )}
          >
            <OcrLine book={book} job={job} onAction={onAction} />
          </div>
        )}
        <div className="hidden w-40 shrink-0 sm:block">
          <Progress book={book} />
        </div>
        <BookMenu book={book} offerOcr={offerOcr} onAction={onAction} />
      </li>
    );
  }

  return (
    <li
      data-testid="book"
      data-book-uid={book.bookUid}
      data-format={book.format}
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
      {showOcr && (
        <div data-testid="ocr-line" className="flex flex-col">
          <OcrLine book={book} job={job} onAction={onAction} />
        </div>
      )}
      <div className="mt-auto flex items-end gap-2">
        <div className="min-w-0 flex-1">
          {onDevice(book) ? <Progress book={book} /> : <DownloadButton book={book} onAction={onAction} />}
        </div>
        <BookMenu book={book} offerOcr={offerOcr} onAction={onAction} />
      </div>
      {(scanned || book.format === 'epub') && <div className="absolute top-5 left-5 flex gap-1">{badges}</div>}
    </li>
  );
}
