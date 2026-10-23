import { useQuery } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button, Card, Notice, Skeleton, SkeletonLines } from '../../components/ui';
import { t } from '../../i18n';
import { core, CoreError } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import { formatNumber } from '../../lib/format';

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-base break-words">{children}</dd>
    </div>
  );
}

export function SmokePage() {
  const smoke = useQuery(q.smoke());
  const r = smoke.data;

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
                  <Badge tone="lime">{t('dev.smoke.coverMs', { ms: formatNumber(r.millis.cover, 0) })}</Badge>
                </div>
              ) : (
                <Skeleton className="h-5 w-2/3" />
              )}
            </Card>
            <Card title={t('dev.smoke.document')}>
              {r ? (
                <dl className="divide-y divide-line">
                  <Info label={t('dev.smoke.docTitle')}>{r.doc.title ?? '—'}</Info>
                  <Info label={t('dev.smoke.docAuthor')}>{r.doc.author ?? '—'}</Info>
                  <Info label={t('dev.smoke.pages')}>{r.doc.pageCount}</Info>
                  <Info label={t('dev.smoke.words')}>
                    <span data-testid="word-count">{r.words}</span>
                  </Info>
                </dl>
              ) : (
                <SkeletonLines lines={5} />
              )}
            </Card>
          </div>

          <Card title={t('dev.smoke.page1')} className="w-fit max-w-full">
            {r ? (
              <img
                data-testid="page1"
                src={r.page1DataUrl}
                alt={t('dev.smoke.page1Alt')}
                className="block w-[360px] max-w-full rounded-ctl border border-line"
              />
            ) : (
              <Skeleton rounded="box" className="aspect-[3/4] w-[360px] max-w-full" />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
