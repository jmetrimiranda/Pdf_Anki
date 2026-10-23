// Verdict labels and tones of the code review (spec 11.2): Correto · Equivalente · Quase · Errado · Não verificável.
import type { BadgeTone } from '../../components/ui';
import type { MessageKey } from '../../i18n';
import type { Rating } from '../anki/study/keys';
import type { Verdict } from './run';

export const VERDICT_LABEL: Record<Verdict, MessageKey> = {
  correct: 'codeReview.verdict.correct',
  equivalent: 'codeReview.verdict.equivalent',
  almost: 'codeReview.verdict.almost',
  wrong: 'codeReview.verdict.wrong',
  unverifiable: 'codeReview.verdict.unverifiable',
};

/** success · info · warning · error · neutral (design tokens). */
export const VERDICT_TONE: Record<Verdict, BadgeTone> = {
  correct: 'lime',
  equivalent: 'info',
  almost: 'warning',
  wrong: 'error',
  unverifiable: 'neutral',
};

export const RATING_LABEL: Record<Rating, MessageKey> = {
  1: 'anki.study.again',
  2: 'anki.study.hard',
  3: 'anki.study.good',
  4: 'anki.study.easy',
};
