/** Display tokens for the visual diff. */
import { lexSegment, whitespaceTokens } from './lexer';
import { normalizeCommand } from './normalize';
import { markPlaceholders, restorePlaceholders } from './placeholders';
import { splitSegments } from './segments';

/**
 * Tokens as typed (quotes kept, operators and redirections as their own
 * tokens, original order), after normalization. Never throws.
 */
export function shellTokens(command: string): string[] {
  try {
    const split = splitSegments(normalizeCommand(markPlaceholders(command)));
    const out: string[] = [];
    split.segments.forEach((seg, k) => {
      for (const t of lexSegment(seg).display) out.push(restorePlaceholders(t.raw));
      const op = split.operators[k];
      if (op) out.push(op);
    });
    return out;
  } catch {
    return whitespaceTokens(command).map((t) => t.text);
  }
}
