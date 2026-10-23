/**
 * Step 4 (spec 11.3): shell-style lexer for one segment.
 *
 * - Single and double quotes are removed from the final token (`"foo"` ≡ `foo`).
 * - Backslash escapes are resolved.
 * - `$(…)`, `${…}` and backticks stay inside one token, verbatim.
 * - Redirections (`>`, `>>`, `<`, `2>`, `2>&1`, `&>`…) become their own token
 *   together with their target (`>saida.txt` ≡ `> saida.txt`) and are moved to
 *   the end of the segment, keeping their order.
 *
 * Never throws: unbalanced quotes or substitutions just run to the end.
 */

export interface Redirect {
  /** Normalized operator (`1>` → `>`, `0<` → `<`), including a dup target like `2>&1`. */
  op: string;
  /** Target word (quotes removed); empty for dups (`2>&1`) or a missing target. */
  target: string;
}

export interface Token {
  /** Final value: quotes removed, escapes resolved. For redirects: `op target`. */
  text: string;
  /** Text as typed (quotes kept), for display. */
  raw: string;
  quoted: boolean;
  redirect?: Redirect;
}

export interface LexedSegment {
  /** Words in order (redirects excluded). */
  words: Token[];
  /** Redirects in order. */
  redirects: Token[];
  /** All tokens as typed, in their original order (for display). */
  display: Token[];
}

const REDIRECT_RE = /^(?:&>>?|\d*(?:>>|>\||>&|<&|<<<|<<|<>|>|<))/;

interface WordResult {
  text: string;
  raw: string;
  quoted: boolean;
  end: number;
}

/** Index just after the `$(…)` / `${…}` that starts at `start` (pointing at `$`). */
export function scanSubstitution(s: string, start: number): number {
  const open = s.charAt(start + 1);
  const stack: string[] = [open === '(' ? ')' : '}'];
  let i = start + 2;
  let quote: string | null = null;
  while (i < s.length && stack.length > 0) {
    const c = s.charAt(i);
    if (quote) {
      if (c === '\\' && quote !== "'") i++;
      else if (c === quote) quote = null;
    } else if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '$' && (s.charAt(i + 1) === '(' || s.charAt(i + 1) === '{')) {
      stack.push(s.charAt(i + 1) === '(' ? ')' : '}');
      i++;
    } else if (c === '(' && stack[stack.length - 1] === ')') {
      stack.push(')');
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
    }
    i++;
  }
  return Math.min(i, s.length);
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function readWord(s: string, start: number): WordResult {
  let text = '';
  let quoted = false;
  let i = start;
  while (i < s.length) {
    const c = s.charAt(i);
    if (isSpace(c)) break;
    if ((c === '>' || c === '<') && i > start) break;
    if (c === '&' && s.charAt(i + 1) === '>' && i > start) break;
    if (c === '\\') {
      if (i + 1 < s.length) {
        text += s.charAt(i + 1);
        i += 2;
      } else {
        text += c;
        i++;
      }
      continue;
    }
    if (c === "'") {
      quoted = true;
      const close = s.indexOf("'", i + 1);
      const end = close < 0 ? s.length : close;
      text += s.slice(i + 1, end);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      while (i < s.length && s.charAt(i) !== '"') {
        const d = s.charAt(i);
        if (d === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s.charAt(i + 1))) {
          text += s.charAt(i + 1);
          i += 2;
        } else if (d === '$' && (s.charAt(i + 1) === '(' || s.charAt(i + 1) === '{')) {
          const end = scanSubstitution(s, i);
          text += s.slice(i, end);
          i = end;
        } else {
          text += d;
          i++;
        }
      }
      i++; // closing quote (or past the end)
      continue;
    }
    if (c === '$' && (s.charAt(i + 1) === '(' || s.charAt(i + 1) === '{')) {
      const end = scanSubstitution(s, i);
      text += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === '`') {
      const close = s.indexOf('`', i + 1);
      const end = close < 0 ? s.length : close + 1;
      text += s.slice(i, end);
      i = end;
      continue;
    }
    text += c;
    i++;
  }
  const end = Math.min(i, s.length);
  return { text, raw: s.slice(start, end), quoted, end };
}

function normalizeRedirectOp(op: string): string {
  if (op.startsWith('&')) return op;
  const m = /^(\d*)(.*)$/.exec(op);
  const fd = m?.[1] ?? '';
  const rest = m?.[2] ?? op;
  if ((fd === '1' && rest.startsWith('>')) || (fd === '0' && rest.startsWith('<'))) return rest;
  return fd + rest;
}

export function lexSegment(segment: string): LexedSegment {
  const words: Token[] = [];
  const redirects: Token[] = [];
  const display: Token[] = [];
  const s = segment;
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    const m = REDIRECT_RE.exec(s.slice(i, i + 8));
    if (m && (c === '>' || c === '<' || c === '&' || /^\d+[<>]/.test(m[0]))) {
      const start = i;
      let op = m[0];
      i += op.length;
      let target = '';
      if (op.endsWith('&')) {
        const dup = /^(?:\d+|-)/.exec(s.slice(i));
        if (dup) {
          op += dup[0];
          i += dup[0].length;
        } else if (op === '>&') {
          op = '&>';
        }
      }
      if (!/&(?:\d+|-)$/.test(op)) {
        while (i < s.length && isSpace(s.charAt(i))) i++;
        if (i < s.length) {
          const w = readWord(s, i);
          if (w.end > i) {
            target = w.text;
            i = w.end;
          }
        }
      }
      const norm = normalizeRedirectOp(op);
      const token: Token = {
        text: target ? `${norm} ${target}` : norm,
        raw: s.slice(start, i).trim(),
        quoted: false,
        redirect: { op: norm, target },
      };
      redirects.push(token);
      display.push(token);
      continue;
    }
    const w = readWord(s, i);
    if (w.end <= i) {
      // Defensive: never loop forever on an unexpected character.
      const token: Token = { text: c, raw: c, quoted: false };
      words.push(token);
      display.push(token);
      i++;
      continue;
    }
    const token: Token = { text: w.text, raw: w.raw, quoted: w.quoted };
    words.push(token);
    display.push(token);
    i = w.end;
  }
  return { words, redirects, display };
}

/** Plain whitespace tokens: the fallback when anything goes wrong. */
export function whitespaceTokens(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => ({ text: t, raw: t, quoted: false }));
}
