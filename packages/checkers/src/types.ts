/** Public result types of the command checker (spec 11.3). */

export type Verdict = 'correct' | 'equivalent' | 'almost' | 'wrong' | 'unverifiable';

/** Best → worst. */
export const VERDICT_ORDER: readonly Verdict[] = ['correct', 'equivalent', 'almost', 'wrong', 'unverifiable'];

export interface CheckDiff {
  kind: 'missing' | 'extra' | 'order' | 'typo' | 'value' | 'prefix';
  expected?: string;
  got?: string;
  /** pt-BR. */
  message: string;
}

export interface CheckResult {
  verdict: Verdict;
  /** 0..1 */
  score: number;
  diffs: CheckDiff[];
  normalizedExpected: string;
  normalizedAnswer: string;
  /** 0 = Resposta, 1..n = Aceitas. */
  matchedVariant: number;
}

export interface CommandCheckInput {
  /** Canonical answer (Resposta). May hold `<placeholders>`. */
  expected: string;
  /** Other accepted answers (Aceitas). */
  accepted?: readonly string[];
  /** Required prefixes or flags (Exige), e.g. `sudo`. */
  requires?: readonly string[];
  /** The user's answer. */
  answer: string;
}
