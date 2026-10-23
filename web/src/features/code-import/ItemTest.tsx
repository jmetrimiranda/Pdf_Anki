// Optional "Testar" of one import item (spec 11.7): the item's Resposta against itself, as in the Add screen.
import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import type { ImportItem } from '../../lib/core/types';
import { ReferenceResultView } from '../anki/editor/ReferenceTest';
import {
  referenceFromFields,
  testReference,
  textFieldsToHtml,
  type ReferenceResult,
} from '../anki/editor/referenceTest';

export function ItemTest({ item }: { item: ImportItem }) {
  const settings = useQuery({ queryKey: ['code', 'settings'], queryFn: () => core.codeSettingsGet() });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReferenceResult | null>(null);
  const role = item.kind;
  if (!role) return null;

  async function run() {
    setRunning(true);
    const ref = referenceFromFields(role!, textFieldsToHtml(item.fields));
    setResult(await testReference(ref, settings.data?.outputExact ?? false));
    setRunning(false);
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-2">
      <div>
        <Button size="sm" variant="ghost" icon={FlaskConical} loading={running} onClick={() => void run()}>
          {t('codeAuthoring.testShort')}
        </Button>
      </div>
      {result && !running && (
        <>
          <ReferenceResultView result={result} />
          {result.kind === 'unavailable' && (
            <p className="text-xs text-muted">{t('codeAuthoring.cppUnavailable', { aviso: result.notice })}</p>
          )}
        </>
      )}
    </div>
  );
}
