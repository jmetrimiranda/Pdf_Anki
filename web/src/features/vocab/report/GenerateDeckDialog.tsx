// "Gerar deck" (spec 12.6): the deck name preview (with the range subdeck, or per-chapter subdecks), the order of the
// new cards, the optional Português → Inglês card, the definitions (WordNet offline; the AI option is the Phase 8
// hook, disabled) and the tags. "Preparar coleção" when the "Vocabulário · Livro" type is missing.
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Dialog, Notice, SegmentedControl, Switch } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { CoreError, type VocabDeckOptions, type VocabDeckResult, type VocabReport } from '../../../lib/core/types';
import { errorMessage } from '../../anki/decks/DeckDialogs';

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
  const n = lemmas.length;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
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
          <label className="inline-flex cursor-not-allowed items-center gap-2 text-base opacity-60 coarse:min-h-11">
            <input type="radio" name="vocab-enrich" className="size-4" disabled aria-describedby="vocab-ai-soon" />
            <Sparkles size={14} aria-hidden />
            {t('vocab.deck.ai')}
            <span id="vocab-ai-soon" className="text-xs text-muted">
              — {t('vocab.deck.aiSoon')}
            </span>
          </label>
        </fieldset>

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
    </Dialog>
  );
}
