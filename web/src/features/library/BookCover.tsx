import { FileText } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core, type LibraryEntry } from '../../lib/core/client';

/** Cover from the core (`pdf://localhost/cover/…`: a PDF's first page, an EPUB's cover image), else an icon. */
export function BookCover({ book, className }: { book: LibraryEntry; className?: string }) {
  const src = core.coverUrl(book.bookUid, book.fileVersion);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // An EPUB's cover doesn't depend on its page count; an empty PDF has no first page to show.
  const failed = (book.format === 'pdf' && book.pages === 0) || failedSrc === src;
  return (
    <div
      className={cn(
        'relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-ctl border border-line bg-surface',
        className,
      )}
    >
      {failed ? (
        <FileText size={22} strokeWidth={1.6} className="text-muted" aria-hidden data-testid="cover-fallback" />
      ) : (
        <img
          src={src}
          alt={t('library.coverAlt', { titulo: book.title })}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedSrc(src)}
          className="size-full object-cover"
        />
      )}
    </div>
  );
}
