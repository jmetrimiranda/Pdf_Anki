/** Suggested rating (spec 11.2 step 4). */
import type { Verdict } from './types';

/**
 * Correct/Equivalent → Bom (3), Quase → Difícil (2), Errado → De novo (1),
 * Não verificável (or no verdict) → none. With `suggestEasy` (off by default
 * in the app), a correct answer faster than `easySecs` → Fácil (4).
 */
export function suggestRating(
  verdict: Verdict | null,
  opts: { elapsedMs: number; suggestEasy: boolean; easySecs: number },
): 1 | 2 | 3 | 4 | null {
  switch (verdict) {
    case 'correct':
      return opts.suggestEasy && opts.elapsedMs < opts.easySecs * 1000 ? 4 : 3;
    case 'equivalent':
      return 3;
    case 'almost':
      return 2;
    case 'wrong':
      return 1;
    default:
      return null;
  }
}
