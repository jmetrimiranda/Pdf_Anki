import { useQuery } from '@tanstack/react-query';
import { ScanText } from 'lucide-react';
import { useState } from 'react';
import { Button, Notice } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { q } from '../../lib/core/queries';
import { OcrDialog } from './OcrDialog';
import { OcrProgress } from './OcrProgress';
import { ocrBusy, ocrEligible, useOcrJob } from './useOcrJob';

/**
 * The book panel's notice for a PDF that looks scanned (spec 6.6, 7.2): "Este livro parece escaneado." with
 * "Reconhecer texto", the running job's progress, or the last failure with "Tentar de novo". Renders nothing for
 * EPUBs, books with text and when no book is open.
 */
export function OcrPanelNotice({ uid, className }: { uid: string | null; className?: string }) {
  const library = useQuery(q.library());
  const book = uid ? (library.data?.find((b) => b.bookUid === uid) ?? null) : null;
  const eligible = ocrEligible(book);
  const job = useOcrJob(uid, { enabled: eligible });
  const [dialog, setDialog] = useState(false);
  const { phase } = job.state;

  if (!book || phase === 'done') return null;
  if (!eligible && !ocrBusy(job.state) && phase !== 'failed') return null;

  return (
    <section
      data-testid="ocr-panel-notice"
      aria-label={t('ocr.panelScanned')}
      className={cn('flex flex-col gap-2 rounded-box border border-(--pc-border) p-3 text-base', className)}
    >
      {ocrBusy(job.state) ? (
        <OcrProgress state={job.state} title={book.title} onCancel={() => void job.cancel()} />
      ) : phase === 'failed' ? (
        <Notice tone="error" onRetry={() => void job.start()} className="border-0 bg-transparent p-0">
          {job.state.error ? t('ocr.failed', { mensagem: job.state.error }) : t('ocr.failedShort')}
        </Notice>
      ) : (
        <>
          <div>
            <p className="font-semibold">{t('ocr.panelScanned')}</p>
            <p className="text-xs text-(--pc-muted)">{t('ocr.panelScannedHint')}</p>
          </div>
          <Button size="sm" icon={ScanText} className="self-start" onClick={() => setDialog(true)}>
            {t('ocr.action')}
          </Button>
        </>
      )}
      {dialog && <OcrDialog book={book} onClose={() => setDialog(false)} />}
    </section>
  );
}
