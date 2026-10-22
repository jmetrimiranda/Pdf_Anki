import { useQuery } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, Checkbox, Notice, Skeleton, SkeletonLines } from '../../components/ui';
import { t } from '../../i18n';
import { core, CoreError } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import { formatNumber } from '../../lib/format';
import { DeckTable, studiedTodayText } from '../anki/DeckList';
import { PageView } from '../reader/PageView';

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-base break-words">{children}</dd>
    </div>
  );
}

const PREVIEW_WIDTH = 520;

export function SmokePage() {
  const smoke = useQuery(q.smoke());
  const [debug, setDebug] = useState(false);
  const r = smoke.data;
  const page = r?.doc.pages[0];
  const zoom = page ? PREVIEW_WIDTH / page.width : 1;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{t('dev.smoke.title')}</h1>
            <p className="text-xs text-muted">
              {t('dev.smoke.subtitle', { core: core.kind === 'mock' ? t('dev.smoke.mock') : t('dev.smoke.tauri') })}
            </p>
          </div>
          <Button icon={RotateCw} loading={smoke.isFetching} onClick={() => void smoke.refetch()}>
            {t('dev.smoke.rerun')}
          </Button>
        </header>

        {smoke.isError && (
          <Notice tone="error" onRetry={() => void smoke.refetch()}>
            {smoke.error instanceof CoreError ? smoke.error.message : t('errors.unexpected')}
          </Notice>
        )}

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 flex-col gap-5">
            <Card title={t('dev.smoke.timings')}>
              {r ? (
                <div className="flex flex-wrap gap-2" data-testid="timings">
                  <Badge tone="lime">{t('dev.smoke.ankiMs', { ms: formatNumber(r.millis.anki, 0) })}</Badge>
                  <Badge tone="lime">{t('dev.smoke.pdfOpenMs', { ms: formatNumber(r.millis.pdfOpen, 0) })}</Badge>
                  <Badge tone="lime">{t('dev.smoke.pdfTextMs', { ms: formatNumber(r.millis.pdfText, 0) })}</Badge>
                </div>
              ) : (
                <Skeleton className="h-5 w-2/3" />
              )}
            </Card>
            <Card title={t('dev.smoke.collection')}>
              {r ? (
                <>
                  <p className="mb-3 font-mono text-xs break-all text-muted">{r.collectionPath}</p>
                  <DeckTable decks={r.deckTree.decks} compact />
                  <p className="mt-3 text-center text-xs text-muted">{studiedTodayText(r.deckTree.studiedToday)}</p>
                </>
              ) : (
                <SkeletonLines lines={6} />
              )}
            </Card>
            <Card title={t('dev.smoke.document')}>
              {r ? (
                <dl className="divide-y divide-line">
                  <Info label={t('dev.smoke.docTitle')}>{r.doc.title ?? '—'}</Info>
                  <Info label={t('dev.smoke.docAuthor')}>{r.doc.author ?? '—'}</Info>
                  <Info label={t('dev.smoke.docId')}>
                    <code className="text-xs">{r.doc.docId}</code>
                  </Info>
                  <Info label={t('dev.smoke.pages')}>{r.doc.pageCount}</Info>
                  <Info label={t('dev.smoke.page1Size')}>
                    {page ? `${formatNumber(page.width)} × ${formatNumber(page.height)} pt` : '—'}
                  </Info>
                  <Info label={t('dev.smoke.words')}>
                    <span data-testid="word-count">{r.words}</span>
                  </Info>
                  <Info label={t('dev.smoke.page1Url')}>
                    <code className="line-clamp-2 text-xs break-all">{r.page1Url}</code>
                  </Info>
                </dl>
              ) : (
                <SkeletonLines lines={5} />
              )}
            </Card>
          </div>

          <Card
            title={t('dev.smoke.page1')}
            actions={
              <Checkbox label={t('dev.smoke.showBoxes')} checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            }
            className="w-fit max-w-full"
          >
            <div className="overflow-auto">
              {r && page ? (
                <PageView docId={r.doc.docId} index={0} size={page} zoom={zoom} debugWords={debug} eager />
              ) : (
                <Skeleton rounded="box" className="aspect-[612/792] w-[520px] max-w-full" />
              )}
            </div>
            <p className="mt-2 text-xs text-muted">{t('dev.smoke.selectHint')}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
