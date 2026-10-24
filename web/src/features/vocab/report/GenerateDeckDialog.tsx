// "Gerar deck" (spec 12.6): the deck name preview (with the range subdeck, or per-chapter subdecks), the order of the
// new cards, the optional Português → Inglês card, the definitions (WordNet offline, or AI: the estimate first, then a
// job that asks the AI batch by batch into the cache, then the deck reads the cache) and the tags. "Preparar coleção"
// when the "Vocabulário · Livro" type is missing.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Square } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Dialog, Notice, ProgressBar, SegmentedControl, Switch } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { CoreError, type VocabDeckOptions, type VocabDeckResult, type VocabReport } from '../../../lib/core/types';
import { errorMessage } from '../../anki/decks/DeckDialogs';
import { useAiState } from '../../ai/AiStateHint';
import { AiErrorNotice, useAiCall } from '../../ai/useAiCall';
import { usd } from '../../settings/AiSettings';
import { followJob } from '../queries';

/** The deck the cards go to, as the core names it (`VocabDeckNames::deck_for`). */
export function deckPreview(report: VocabReport, perChapter: boolean): string {
  return perChapter ? t('vocab.deck.perChapterName', { deck: report.deck.baseName }) : report.deck.fullName;
}

/** The tags of the generated notes (spec 12.6): `livro::…`, `trecho::…` and the chapters' `cap::NN` (first three). */
export function deckTags(report: VocabReport): string[] {
  const caps = report.chapters.map((c) => `cap::${String(c.index).padStart(2, '0')}`);
  return [
    report.deck.bookTag,
    ...(report.deck.rangeTag ? [report.deck.rangeTag] : []),
    ...caps.slice(0, 3),
    ...(caps.length > 3 ? ['…'] : []),
  ];
}

export function GenerateDeckDialog({
  report,
  lemmas,
  sheet,
  onClose,
  onDone,
}: {
  report: VocabReport;
  lemmas: string[];
  sheet?: boolean;
  onClose: () => void;
  onDone: (result: VocabDeckResult) => void;
}) {
  const qc = useQueryClient();
  const [options, setOptions] = useState<VocabDeckOptions>({
    order: 'reading',
    perChapter: false,
    card2: false,
    enrich: 'wordnet',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPrepare, setNeedsPrepare] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ jobId: string; done: number; total: number } | null>(null);
  const [aiError, setAiError] = useState<unknown>(null);
  const ai = useAiCall();
  const aiState = useAiState('enrich');
  const aiReady = aiState === null || aiState === 'ai.state.warning';
  const n = lemmas.length;
  const estimate = useQuery({
    queryKey: ['ai', 'estimate', 'deck', report.scanUid, lemmas],
    queryFn: () =>
      core.aiEstimate({ feature: 'deck', bookUid: report.bookUid, scanUid: report.scanUid, lemmas }),
    enabled: options.enrich === 'ai' && aiReady && n > 0,
    staleTime: 0,
  });

  /** AI definitions: fills the cache (a job), then the deck reads it. `false` when stopped or declined. */
  async function enrich(): Promise<boolean> {
    const started = await ai.run((confirmed) =>
      core.aiEnrichStart(report.bookUid, report.scanUid, lemmas, confirmed),
    );
    if (!started) return false;
    if (started.jobId === null) return true;
    setAiProgress({ jobId: started.jobId, done: 0, total: started.toSend });
    const end = await followJob({ jobId: started.jobId, scanUid: report.scanUid }, (p) =>
      setAiProgress({ jobId: p.jobId, done: p.done, total: p.total }),
    );
    setAiProgress(null);
    void qc.invalidateQueries({ queryKey: ['ai', 'usage'] });
    if (end.stage === 'done') return true;
    setAiError(
      end.error ? new CoreError(end.error.code, end.error.message) : new CoreError('cancelled', t('vocab.deck.aiCancelled')),
    );
    return false;
  }

  async function generate(skipAi = false) {
    setBusy(true);
    setError(null);
    setAiError(null);
    try {
      if (options.enrich === 'ai' && !skipAi && !(await enrich())) return;
      const result = await core.vocabGenerateDeck(report.bookUid, report.scanUid, lemmas, options);
      await Promise.all([qc.invalidateQueries({ queryKey: ['anki'] }), qc.invalidateQueries({ queryKey: ['vocab'] })]);
      onDone(result);
    } catch (e) {
      if (e instanceof CoreError && e.code === 'vocab_prepare_needed') setNeedsPrepare(true);
      else setError(t('vocab.deck.failed', { erro: errorMessage(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      await core.ankiPrepareCollection();
      await qc.invalidateQueries({ queryKey: ['anki'] });
      setNeedsPrepare(false);
    } catch (e) {
      setError(t('bookPanel.form.prepareFailed', { erro: errorMessage(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      variant={sheet ? 'sheet' : 'center'}
      title={t('vocab.deck.title')}
      description={n === 1 ? t('vocab.deck.descriptionOne') : t('vocab.deck.description', { n })}
      className="sm:w-[min(560px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void generate()}
            loading={busy && !needsPrepare}
            disabled={busy || needsPrepare || n === 0}
            data-testid="vocab-deck-create"
          >
            {t('vocab.deck.create', { n })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('vocab.deck.name')}</span>
          <code
            className="rounded-ctl border border-line bg-neutral px-2.5 py-1.5 font-mono text-base [overflow-wrap:anywhere]"
            data-testid="vocab-deck-name"
          >
            {deckPreview(report, options.perChapter)}
          </code>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">{t('vocab.deck.order')}</span>
          <SegmentedControl
            label={t('vocab.deck.order')}
            value={options.order}
            onChange={(order) => setOptions((o) => ({ ...o, order }))}
            className="self-start"
            options={[
              { value: 'reading', label: t('vocab.deck.orderReading') },
              { value: 'frequency', label: t('vocab.deck.orderFrequency') },
            ]}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Switch
            checked={options.perChapter}
            onCheckedChange={(perChapter) => setOptions((o) => ({ ...o, perChapter }))}
            label={t('vocab.deck.perChapter')}
          />
          <p className="pl-[46px] text-xs text-muted">{t('vocab.deck.perChapterHint')}</p>
        </div>
        <Switch
          checked={options.card2}
          onCheckedChange={(card2) => setOptions((o) => ({ ...o, card2 }))}
          label={t('vocab.deck.card2')}
        />

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-xs text-muted">{t('vocab.deck.definitions')}</legend>
          <label className="inline-flex cursor-pointer items-center gap-2 text-base coarse:min-h-11">
            <input
              type="radio"
              name="vocab-enrich"
              className="size-4 accent-[var(--lime)]"
              checked={options.enrich === 'wordnet'}
              onChange={() => setOptions((o) => ({ ...o, enrich: 'wordnet' }))}
            />
            {t('vocab.deck.wordnet')}
          </label>
          <label
            className={
              aiReady
                ? 'inline-flex cursor-pointer items-center gap-2 text-base coarse:min-h-11'
                : 'inline-flex cursor-not-allowed items-center gap-2 text-base opacity-60 coarse:min-h-11'
            }
          >
            <input
              type="radio"
              name="vocab-enrich"
              className="size-4 accent-[var(--lime)]"
              disabled={!aiReady}
              checked={options.enrich === 'ai'}
              aria-describedby={aiState ? 'vocab-ai-state' : undefined}
              onChange={() => setOptions((o) => ({ ...o, enrich: 'ai' }))}
            />
            <Sparkles size={14} aria-hidden />
            {t('vocab.deck.ai')}
          </label>
          {aiState && (
            <p id="vocab-ai-state" className="pl-6 text-xs text-muted" data-testid="ai-state">
              {t(aiState)}
            </p>
          )}
          {options.enrich === 'ai' && estimate.data && (
            <p className="pl-6 text-xs text-muted" data-testid="vocab-ai-estimate">
              {t('ai.cost', { custo: usd(estimate.data.worstUsd) })}
              {estimate.data.cached > 0 && <> {t('ai.cost.cached', { n: estimate.data.cached })}</>}
            </p>
          )}
          {options.enrich === 'ai' && estimate.error && (
            <div className="pl-6">
              <AiErrorNotice error={estimate.error} onOpenSettings={onClose} />
            </div>
          )}
        </fieldset>

        {aiProgress && (
          <div className="flex items-center gap-2" data-testid="vocab-ai-progress">
            <ProgressBar
              className="flex-1"
              label={t('vocab.deck.aiAsking', { feitas: aiProgress.done, total: aiProgress.total })}
              value={aiProgress.done}
              max={aiProgress.total || 1}
            />
            <span className="text-xs text-muted">
              {t('vocab.deck.aiAsking', { feitas: aiProgress.done, total: aiProgress.total })}
            </span>
            <Button size="sm" variant="ghost" icon={Square} onClick={() => void core.jobCancel(aiProgress.jobId)}>
              {t('vocab.deck.aiCancel')}
            </Button>
          </div>
        )}
        {aiError !== null && (
          <div className="flex flex-col gap-2">
            <AiErrorNotice error={aiError} onOpenSettings={onClose} />
            <p className="text-xs text-muted">{t('vocab.deck.aiStopped')}</p>
            <Button size="sm" className="self-start" onClick={() => void generate(true)} data-testid="vocab-ai-anyway">
              {t('vocab.deck.aiGenerateAnyway')}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">{t('vocab.deck.tags')}</span>
          <div className="flex flex-wrap gap-1.5" data-testid="vocab-deck-tags">
            {deckTags(report).map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted">{t('vocab.deck.noDuplicates')}</p>

        {needsPrepare && (
          <Notice tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t('vocab.deck.prepareNeeded')}</span>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void prepare()}>
                {t('vocab.deck.prepare')}
              </Button>
            </div>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      {ai.dialog}
    </Dialog>
  );
}
