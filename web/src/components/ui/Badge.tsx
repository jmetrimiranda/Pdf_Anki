import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../i18n';

export type BadgeTone = 'neutral' | 'lime' | 'new' | 'learn' | 'review' | 'error';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-neutral text-muted border-line',
  lime: 'bg-lime-soft text-lime-dark border-transparent',
  new: 'text-anki-new border-transparent bg-[color-mix(in_srgb,var(--anki-new)_12%,transparent)]',
  learn: 'text-anki-learn border-transparent bg-[color-mix(in_srgb,var(--anki-learn)_12%,transparent)]',
  review: 'text-anki-review border-transparent bg-[color-mix(in_srgb,var(--anki-review)_12%,transparent)]',
  error: 'bg-error-soft text-error border-transparent',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full border px-2 text-2xs font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const countColor = {
  new: 'text-anki-new',
  learn: 'text-anki-learn',
  review: 'text-anki-review',
} as const;

/** A single Anki count; zero is muted, like in Anki's deck list. */
export function Count({
  kind,
  value,
  className,
}: {
  kind: keyof typeof countColor;
  value: number;
  className?: string;
}) {
  return (
    <span className={cn('tabular', value === 0 ? 'text-muted opacity-60' : countColor[kind], className)}>{value}</span>
  );
}

/** "12 · 4 · 7" in Anki colors (new · learn · review). */
export function Counts({
  newCount,
  learnCount,
  reviewCount,
  className,
}: {
  newCount: number;
  learnCount: number;
  reviewCount: number;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-base', className)}
      aria-label={t('anki.countsLabel', { n: newCount, l: learnCount, r: reviewCount })}
    >
      <Count kind="new" value={newCount} />
      <span aria-hidden className="text-muted">
        ·
      </span>
      <Count kind="learn" value={learnCount} />
      <span aria-hidden className="text-muted">
        ·
      </span>
      <Count kind="review" value={reviewCount} />
    </span>
  );
}
