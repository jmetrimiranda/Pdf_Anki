import { FileText } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core, type LibraryEntry } from '../../lib/core/client';

/** First-page cover from the core (`pdf://localhost/cover/…`), with an icon when there is none. */
export function BookCover({ book, className }: { book: LibraryEntry; className?: string }) {
  const src = core.coverUrl(book.bookUid, book.fileVersion);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = book.pages === 0 || failedSrc === src;
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
