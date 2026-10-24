import { ScanText } from 'lucide-react';
import { Button, Dialog, Notice } from '../../components/ui';
import { t } from '../../i18n';
import type { LibraryEntry } from '../../lib/core/client';
import { OcrProgress } from './OcrProgress';
import { estimateMinutes } from './store';
import { ocrBusy, useOcrJob } from './useOcrJob';

/** "Leva alguns segundos por página — cerca de N min para este livro." from the measured speed (or 4 s/page). */
export function ocrEstimateText(pages: number): string {
  const n = estimateMinutes(pages);
  return n === 0 ? t('ocr.estimateShort') : t('ocr.estimate', { n });
}

/**
 * "Reconhecer texto" (spec 7.2): what OCR does (English only), how long it takes, and that the book gets a new
 * version of its PDF. Starting closes the dialog; the progress shows on the book item and in the panel.
 */
export function OcrDialog({
  book,
  onClose,
  sheet = false,
}: {
  book: Pick<LibraryEntry, 'bookUid' | 'title' | 'pages' | 'format'>;
  onClose: () => void;
  sheet?: boolean;
}) {
  const job = useOcrJob(book.bookUid);
  const busy = ocrBusy(job.state);
  // `ocr_info` reports "unavailable" for anything but a PDF: say what is really wrong, not "models missing".
  const notPdf = book.format !== 'pdf';
  const unavailable = notPdf || !job.available;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('ocr.title')} variant={sheet ? 'sheet' : 'center'}>
      <div className="flex flex-col gap-3 pb-3 text-base" data-testid="ocr-dialog">
        <p>{t('ocr.body')}</p>
        <p className="text-muted" data-testid="ocr-estimate">
          {ocrEstimateText(book.pages)} {t('ocr.backgroundNote')}
        </p>
        <p className="text-muted">{t('ocr.versionNote')}</p>
        {notPdf ? (
          <Notice tone="info">{t('ocr.notPdf')}</Notice>
        ) : (
          unavailable && <Notice tone="error">{t('ocr.unavailable')}</Notice>
        )}
        {busy && <OcrProgress state={job.state} title={book.title} onCancel={() => void job.cancel()} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {busy ? t('common.close') : t('common.cancel')}
          </Button>
          {!busy && (
            <Button
              variant="primary"
              icon={ScanText}
              disabled={unavailable || job.infoLoading}
              onClick={() => {
                void job.start();
                onClose();
              }}
            >
              {t('ocr.start')}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
