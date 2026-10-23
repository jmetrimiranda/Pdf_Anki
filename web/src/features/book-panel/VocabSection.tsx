// The panel's vocabulary section (spec 10.1, 12.7): the book's coverage with the link to the report ("Vocabulário
// 94% →"), or "Escanear vocabulário" when never scanned, and the "Realçar vocabulário" toggle.
import { useNavigate } from '@tanstack/react-router';
import { Switch } from '../../components/ui';
import { t } from '../../i18n';
import type { BookPanelVocab } from '../../lib/core/types';
import { leitor, useVocabHighlight } from '../leitor/instance';

const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });

/** "94%": whole percent, rounded down (coverage is never overstated). */
export function formatCoverage(coverage: number): string {
  const c = Number.isFinite(coverage) ? Math.min(1, Math.max(0, coverage)) : 0;
  return percent.format(Math.floor(c * 100 + 1e-9) / 100);
}

export function VocabSection({ bookUid, vocab }: { bookUid: string; vocab: BookPanelVocab | null }) {
  const navigate = useNavigate();
  const highlight = useVocabHighlight(bookUid);
  const scanned = vocab !== null;
  const linkClass = 'self-start text-left text-base text-link hover:underline';
  const pct = vocab ? formatCoverage(vocab.coverageKnown) : '';
  return (
    <div className="flex flex-col gap-2" data-testid="book-panel-vocab">
      {vocab ? (
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            className={linkClass}
            aria-label={t('vocabReading.coverageLabel', { pct })}
            onClick={() => void navigate({ to: '/vocabulario', search: { livro: bookUid } })}
          >
            {t('vocabReading.coverage', { pct })}
          </button>
          {vocab.rangeLabel && (
            <span className="truncate text-xs text-(--pc-muted)" title={vocab.rangeLabel}>
              {t('vocabReading.range', { trecho: vocab.rangeLabel })}
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          className={linkClass}
          onClick={() => void navigate({ to: '/vocabulario/escanear', search: { livro: bookUid } })}
        >
          {t('vocabReading.scan')}
        </button>
      )}
      <div title={scanned ? t('vocabReading.highlightHint') : t('vocabReading.highlightNotScanned')}>
        <Switch
          checked={scanned && highlight.on}
          disabled={!scanned}
          label={t('vocabReading.highlight')}
          onCheckedChange={(on) => leitor.setHighlight(bookUid, on)}
        />
      </div>
      {!scanned && <p className="text-xs text-(--pc-muted)">{t('vocabReading.highlightNotScanned')}</p>}
    </div>
  );
}
