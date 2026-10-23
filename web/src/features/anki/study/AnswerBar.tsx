// Bottom bar of the study screen (spec 8.2; Anki desktop's reviewer bottom bar, built natively): the counters
// "N + N + N" in Anki's colors with the current queue underlined, "Mostrar resposta", then the four answer buttons
// with the next interval above each.
import { forwardRef, type Ref } from 'react';
import { cn } from '../../../lib/cn';
import { t, type MessageKey } from '../../../i18n';
import type { QueueCounts, StudyQueue } from '../../../lib/core/types';
import type { Rating } from './keys';

const COUNT_CLASS: Record<StudyQueue, string> = {
  new: 'text-anki-new',
  learn: 'text-anki-learn',
  review: 'text-anki-review',
};

export function StudyCounts({
  counts,
  queue,
  compact,
}: {
  counts: QueueCounts;
  queue: StudyQueue | null;
  /** The book panel's mini-review (smaller text). */
  compact?: boolean;
}) {
  const parts: [StudyQueue, number][] = [
    ['new', counts.new],
    ['learn', counts.learn],
    ['review', counts.review],
  ];
  // Screen readers get the sentence in a live region; the colored digits are visual only (aria-label is not
  // allowed on a plain paragraph and most readers ignore it there).
  return (
    <div className={cn('tabular font-medium', compact ? 'text-sm' : 'text-base')}>
      <span className="sr-only" role="status" data-testid="study-counts-sr">
        {t('anki.study.counts', { n: counts.new, l: counts.learn, r: counts.review })}
      </span>
      <p aria-hidden data-testid="study-counts">
        {parts.map(([kind, n], i) => (
          <span key={kind}>
            {i > 0 && <span className="text-muted">{' + '}</span>}
            <span className={cn(COUNT_CLASS[kind], kind === queue && 'underline underline-offset-4')}>{n}</span>
          </span>
        ))}
      </p>
    </div>
  );
}

const ANSWERS: { rating: Rating; label: MessageKey }[] = [
  { rating: 1, label: 'anki.study.again' },
  { rating: 2, label: 'anki.study.hard' },
  { rating: 3, label: 'anki.study.good' },
  { rating: 4, label: 'anki.study.easy' },
];

const barButton =
  'inline-flex h-10 min-w-0 select-none items-center justify-center gap-2 rounded-ctl border border-line bg-neutral px-4 text-base transition-colors hover:bg-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50 coarse:min-h-11';

/** The narrow bar of the book panel's mini-review (320 px): smaller buttons, always four in a row. */
const compactButton =
  'inline-flex h-8 min-w-0 select-none items-center justify-center rounded-ctl border border-line bg-neutral px-1 text-sm transition-colors hover:bg-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50 coarse:min-h-11';

export const ShowAnswerButton = forwardRef<
  HTMLButtonElement,
  { onClick: () => void; disabled?: boolean; compact?: boolean }
>(function ShowAnswerButton({ onClick, disabled, compact }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-keyshortcuts="Space Enter"
      className={cn(compact ? compactButton : barButton, 'w-full max-w-sm font-semibold')}
    >
      {t('anki.study.showAnswer')}
    </button>
  );
});

/** The four answer buttons; `goodRef` gets the default focus (Anki's "defease"). */
export function AnswerButtons({
  labels,
  showIntervals,
  onAnswer,
  disabled,
  goodRef,
  compact,
  suggested,
  groupRef,
}: {
  labels: [string, string, string, string];
  showIntervals: boolean;
  onAnswer: (rating: Rating) => void;
  disabled?: boolean;
  goodRef?: Ref<HTMLButtonElement>;
  /** The book panel's mini-review: four narrow buttons in one row. */
  compact?: boolean;
  /** Code cards (spec 11.2): the rating suggested by the check, shown preselected (`null`: none). */
  suggested?: Rating | null | undefined;
  /** The group (focused when a code card has no suggestion: Enter then does nothing). */
  groupRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={groupRef}
      tabIndex={-1}
      data-testid="answer-buttons"
      role="group"
      aria-label={t('anki.study.answerButtons')}
      className={cn(
        'grid w-full outline-none',
        compact ? 'grid-cols-4 gap-1' : 'max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4',
      )}
    >
      {ANSWERS.map(({ rating, label }) => {
        const interval = labels[rating - 1] ?? '';
        return (
          <div key={rating} className={cn('flex min-w-0 flex-col items-stretch', compact ? 'gap-0.5' : 'gap-1')}>
            <span
              className={cn('tabular h-4 truncate text-center text-xs text-muted', !showIntervals && 'invisible')}
              aria-hidden={!showIntervals}
              data-testid={`interval-${rating}`}
            >
              {interval}
            </span>
            <button
              ref={rating === 3 ? goodRef : undefined}
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(rating)}
              aria-keyshortcuts={
                (suggested === undefined ? rating === 3 : suggested === rating)
                  ? `${rating} Space Enter`
                  : String(rating)
              }
              aria-label={showIntervals && interval ? `${t(label)} (${interval})` : t(label)}
              data-rating={rating}
              data-suggested={suggested === rating ? 'true' : undefined}
              className={cn(
                compact ? compactButton : barButton,
                'w-full',
                suggested === undefined && rating === 3 && 'font-semibold',
                suggested === rating && 'border-lime bg-lime-soft font-semibold text-lime-dark',
              )}
            >
              {t(label)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
