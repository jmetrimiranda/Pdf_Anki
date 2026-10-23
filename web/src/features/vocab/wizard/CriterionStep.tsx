// Step 4 "Critério" (spec 12.1): which cards of the folder count as words the user knows.
import { ListChecks } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Field, Input, SegmentedControl, Switch } from '../../../components/ui';
import { t } from '../../../i18n';
import type { VocabConfig } from '../../../lib/core/types';

export const MIN_IVL_DAYS = 1;
export const MAX_IVL_DAYS = 3650;

export function validDays(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_IVL_DAYS && n <= MAX_IVL_DAYS;
}

function Row({ children, hint }: { children: ReactNode; hint?: string | null }) {
  return (
    <div className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function CriterionStep({
  config,
  onConfig,
  onReviewFields,
  onValid,
}: {
  config: VocabConfig;
  onConfig: (c: VocabConfig) => void;
  onReviewFields: () => void;
  onValid: (valid: boolean) => void;
}) {
  const [daysText, setDaysText] = useState(String(config.knownIvlDays));
  const days = Number(daysText);
  const daysError = daysText.trim() === '' || !validDays(days) ? t('vocab.criterion.matureInvalid') : null;
  useEffect(() => onValid(!daysError), [daysError, onValid]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-md font-semibold">{t('vocab.criterion.title')}</h2>
          <p className="mt-0.5 text-base text-muted">{t('vocab.criterion.description')}</p>
        </div>
        <Button variant="ghost" size="sm" icon={ListChecks} onClick={onReviewFields}>
          {t('vocab.fields.review')}
        </Button>
      </div>
      <div className="rounded-box border border-line bg-card p-4">
        <Row>
          <Field>
            {({ id }) => (
              <div className="flex flex-wrap items-center gap-2 text-base">
                <label htmlFor={id}>{t('vocab.criterion.mature')}</label>
                <span className="w-20 shrink-0">
                  <Input
                    id={id}
                    type="number"
                    min={MIN_IVL_DAYS}
                    max={MAX_IVL_DAYS}
                    inputMode="numeric"
                    className="tabular"
                    aria-invalid={!!daysError}
                    value={daysText}
                    onChange={(e) => {
                      setDaysText(e.target.value);
                      const n = Number(e.target.value);
                      if (validDays(n)) onConfig({ ...config, knownIvlDays: n });
                    }}
                    data-testid="vocab-ivl-days"
                  />
                </span>
                <span>{t('vocab.criterion.days')}</span>
              </div>
            )}
          </Field>
          <p className={daysError ? 'text-xs text-error' : 'text-xs text-muted'}>
            {daysError ?? t('vocab.criterion.matureHint')}
          </p>
        </Row>
        <Row>
          <Switch
            checked={config.countYoung}
            onCheckedChange={(v) => onConfig({ ...config, countYoung: v })}
            label={t('vocab.criterion.young')}
          />
        </Row>
        <Row>
          <span className="text-base">{t('vocab.criterion.suspended')}</span>
          <SegmentedControl
            label={t('vocab.criterion.suspended')}
            value={config.suspendedPolicy}
            onChange={(v) => onConfig({ ...config, suspendedPolicy: v })}
            className="self-start"
            options={[
              { value: 'ignore', label: t('vocab.criterion.suspendedIgnore') },
              { value: 'known', label: t('vocab.criterion.suspendedKnown') },
            ]}
          />
        </Row>
        <Row hint={t('vocab.criterion.functionWordsHint')}>
          <Switch
            checked={config.functionWordsKnown}
            onCheckedChange={(v) => onConfig({ ...config, functionWordsKnown: v })}
            label={t('vocab.criterion.functionWords')}
          />
        </Row>
        <Row hint={t('vocab.criterion.derivedHint')}>
          <span className="text-base">{t('vocab.criterion.derived')}</span>
          <SegmentedControl
            label={t('vocab.criterion.derived')}
            value={config.derivedPolicy}
            onChange={(v) => onConfig({ ...config, derivedPolicy: v })}
            className="self-start"
            options={[
              { value: 'card', label: t('vocab.criterion.derivedCard') },
              { value: 'known', label: t('vocab.criterion.derivedKnown') },
            ]}
          />
        </Row>
      </div>
    </div>
  );
}
