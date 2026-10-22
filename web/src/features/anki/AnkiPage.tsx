import { useQuery } from '@tanstack/react-query';
import { Blocks, Import } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, EmptyState, Notice, Skeleton, Tabs } from '../../components/ui';
import { t } from '../../i18n';
import { CoreError } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import { DeckTable, studiedTodayText } from './DeckList';

type Section = 'decks' | 'add' | 'browse' | 'stats';

function DeckSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label={t('common.loading')} className="flex flex-col gap-3 pt-2">
      <Skeleton className="h-4 w-full" />
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className={i % 3 ? 'h-3.5 w-2/5' : 'h-3.5 w-1/2'} />
          <span className="flex-1" />
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-8" />
        </div>
      ))}
    </div>
  );
}

export function AnkiPage() {
  const [section, setSection] = useState<Section>('decks');
  const tree = useQuery(q.deckTree());

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 pt-4 pb-10 sm:px-6">
        <Tabs
          idBase="anki"
          label={t('anki.sections')}
          value={section}
          onValueChange={setSection}
          className="justify-center"
          items={[
            { value: 'decks', label: t('anki.section.decks') },
            { value: 'add', label: t('anki.section.add'), disabled: true },
            { value: 'browse', label: t('anki.section.browse'), disabled: true },
            { value: 'stats', label: t('anki.section.stats'), disabled: true },
          ]}
        />
        <div role="tabpanel" id="anki-panel-decks" aria-labelledby="anki-tab-decks" className="flex flex-col gap-5">
          {tree.isError && (
            <Notice tone="error" onRetry={() => void tree.refetch()}>
              {tree.error instanceof CoreError ? tree.error.message : t('anki.loadError')}
            </Notice>
          )}
          <Card padded={false} className="px-3 pt-2 pb-3 sm:px-4">
            {tree.isPending ? (
              <DeckSkeleton />
            ) : tree.data && tree.data.decks.length > 0 ? (
              <DeckTable decks={tree.data.decks} />
            ) : (
              <EmptyState
                icon={Blocks}
                title={t('anki.empty')}
                description={t('anki.emptyHint')}
                action={
                  <Button variant="primary" icon={Import} disabled>
                    {t('anki.import')}
                  </Button>
                }
              />
            )}
          </Card>
          {tree.data && (
            <p className="text-center text-base text-muted" data-testid="studied-today">
              {studiedTodayText(tree.data.studiedToday)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
