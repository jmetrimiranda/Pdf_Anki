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

export function StudyCounts({ counts, queue }: { counts: QueueCounts; queue: StudyQueue | null }) {
  const parts: [StudyQueue, number][] = [
    ['new', counts.new],
    ['learn', counts.learn],
    ['review', counts.review],
  ];
  // Screen readers get the sentence in a live region; the colored digits are visual only (aria-label is not
  // allowed on a plain paragraph and most readers ignore it there).
  return (
    <div className="tabular text-base font-medium">
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

export const ShowAnswerButton = forwardRef<HTMLButtonElement, { onClick: () => void; disabled?: boolean }>(
  function ShowAnswerButton({ onClick, disabled }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-keyshortcuts="Space Enter"
        className={cn(barButton, 'w-full max-w-sm font-semibold')}
      >
        {t('anki.study.showAnswer')}
      </button>
    );
  },
);

/** The four answer buttons; `goodRef` gets the default focus (Anki's "defease"). */
export function AnswerButtons({
  labels,
  showIntervals,
  onAnswer,
  disabled,
  goodRef,
}: {
  labels: [string, string, string, string];
  showIntervals: boolean;
  onAnswer: (rating: Rating) => void;
  disabled?: boolean;
  goodRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div
      role="group"
      aria-label={t('anki.study.answerButtons')}
      className="grid w-full max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {ANSWERS.map(({ rating, label }) => {
        const interval = labels[rating - 1] ?? '';
        return (
          <div key={rating} className="flex min-w-0 flex-col items-stretch gap-1">
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
              aria-keyshortcuts={rating === 3 ? '3 Space Enter' : String(rating)}
              aria-label={showIntervals && interval ? `${t(label)} (${interval})` : t(label)}
              data-rating={rating}
              className={cn(barButton, 'w-full', rating === 3 && 'font-semibold')}
            >
              {t(label)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
