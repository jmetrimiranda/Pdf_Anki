/**
 * Step 2 (spec 11.3): trim, collapse whitespace outside quotes, strip a
 * leading `$ ` prompt, typographic quotes → straight, strip a trailing `;`.
 */

const TYPOGRAPHIC_QUOTES: Readonly<Record<string, string>> = {
  '“': '"',
  '”': '"',
  '„': '"',
  '″': '"',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '′': "'",
};

export function straightenQuotes(text: string): string {
  return text.replace(/[“”„″‘’‚′]/gu, (c) => TYPOGRAPHIC_QUOTES[c] ?? c);
}

export function normalizeCommand(command: string): string {
  let s = straightenQuotes(command)
    .replace(/\r\n?/g, '\n')
    .replace(/\\\n/g, ' ') // line continuations
    .replace(/[\u00A0\u2007\u202F]/g, ' ');
  s = s.trim();
  s = s.replace(/^\$[ \t]+/, '');
  s = collapseOutsideQuotes(s);
  // Trailing `;` (one or more, unescaped, outside quotes).
  for (;;) {
    if (!s.endsWith(';') || s.endsWith('\\;') || endsInsideQuotes(s)) break;
    s = s.slice(0, -1).trimEnd();
  }
  return s;
}

/** Collapses runs of spaces/tabs outside quotes into one space. Newlines are kept (they separate commands). */
function collapseOutsideQuotes(s: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (quote) {
      out += c;
      if (c === '\\' && quote === '"' && i + 1 < s.length) {
        out += s.charAt(++i);
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      out += c + s.charAt(++i);
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      let j = i;
      let newline = false;
      while (j < s.length && /[ \t\n]/.test(s.charAt(j))) {
        if (s.charAt(j) === '\n') newline = true;
        j++;
      }
      out += newline ? '\n' : ' ';
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function endsInsideQuotes(s: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }
  return quote !== null;
}
