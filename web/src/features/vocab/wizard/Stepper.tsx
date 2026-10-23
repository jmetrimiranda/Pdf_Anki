import { Check } from 'lucide-react';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import type { WizardStep } from '../steps';

/**
 * The wizard's steps as a row of numbered tabs with the lime underline of the design system (spec painel 4): done
 * steps can be revisited, the current one is underlined, later ones are muted.
 */
export function Stepper({
  steps,
  current,
  onGo,
  locked,
}: {
  steps: readonly WizardStep[];
  current: WizardStep;
  onGo: (step: WizardStep) => void;
  /** No going back (the scan is running). */
  locked?: boolean;
}) {
  const at = steps.indexOf(current);
  return (
    <nav aria-label={t('vocab.wizard.steps')} className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
      <ol className="flex min-w-max items-stretch border-b border-line">
        {steps.map((step, i) => {
          const done = i < at;
          const active = i === at;
          const label = t(`vocab.wizard.step.${step}`);
          return (
            <li key={step}>
              <button
                type="button"
                disabled={!done || locked}
                aria-current={active ? 'step' : undefined}
                onClick={() => onGo(step)}
                className={cn(
                  'relative flex h-10 items-center gap-2 px-3 text-base whitespace-nowrap transition-colors coarse:h-11',
                  active && 'font-semibold text-fg',
                  done && !locked && 'text-fg hover:text-lime-dark',
                  !active && !done && 'text-muted',
                  'disabled:cursor-default',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-full border text-2xs font-semibold tabular',
                    active && 'border-lime-dark bg-lime text-on-lime',
                    done && 'border-transparent bg-lime-soft text-lime-dark',
                    !active && !done && 'border-line text-muted',
                  )}
                >
                  {done ? <Check size={12} strokeWidth={3} /> : i + 1}
                </span>
                {label}
                {active && <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-lime" />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
