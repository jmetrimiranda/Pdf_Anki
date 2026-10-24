// "Definir com IA" (spec 12.7, Appendix C.3), shared by "Definir palavra" and the popover of a marked word: the sense
// of the word in the sentence of its page (the core finds the sentence), from the cache when already asked.
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import type { AiWordSense, VocabPos } from '../../lib/core/types';
import { AiStateHint } from './AiStateHint';
import { AiErrorNotice, useAiCall } from './useAiCall';

export function AiDefine({
  lemma,
  pos,
  bookUid,
  page,
}: {
  lemma: string;
  pos: VocabPos | null;
  bookUid: string | null;
  page: number | null;
}) {
  const ai = useAiCall();
  const [sense, setSense] = useState<AiWordSense | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asking, setAsking] = useState(false);

  async function define() {
    setAsking(true);
    setError(null);
    try {
      const at = bookUid !== null && page !== null ? { bookUid, page } : undefined;
      setSense(await ai.run((confirmed) => core.aiDefineWord(lemma, pos, '', confirmed, at)));
    } catch (e) {
      setError(e);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {sense ? (
        <div className="flex flex-col gap-0.5 rounded-ctl bg-surface px-2.5 py-2" data-testid="define-ai">
          <p className="text-base break-words">{sense.definition}</p>
          <p className="text-base">{t('bookPanel.define.translation', { traducao: sense.translation })}</p>
          <p className="text-xs text-muted">
            {sense.cached ? t('bookPanel.define.aiCached') : t('bookPanel.define.aiSource')}
          </p>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          icon={Sparkles}
          className="-ml-2 self-start"
          loading={asking}
          onClick={() => void define()}
        >
          {t('bookPanel.define.ai')}
        </Button>
      )}
      {error !== null && <AiErrorNotice error={error} onDismiss={() => setError(null)} />}
      <AiStateHint fn="enrich" />
      {ai.dialog}
    </div>
  );
}
