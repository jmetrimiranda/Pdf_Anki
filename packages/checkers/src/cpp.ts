/** C++ mode `estrutura` fallback (spec 11.5): comment-free token comparison. */

const PUNCTUATORS = [
  '<<=', '>>=', '<=>', '->*', '...',
  '::', '->', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '.*', '##',
];

const IDENT_START = /[A-Za-z_$\u0080-\uFFFF]/u;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/u;
const DIGIT = /[0-9]/;

/** Prefixes of string literals: `u8"…"`, `L'…'`, `R"(…)"`, `u8R"x(…)x"`. */
const LITERAL_PREFIX = /^(?:u8|u|U|L)?R?$/;

function readQuoted(s: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote || c === '\n') return i + 1;
    i++;
  }
  return s.length;
}

/** `R"delim( … )delim"`, with `start` at the opening quote. */
function readRaw(s: string, start: number): number {
  const open = s.indexOf('(', start + 1);
  if (open < 0 || open - start - 1 > 16) return readQuoted(s, start, '"');
  const delim = s.slice(start + 1, open);
  const close = s.indexOf(`)${delim}"`, open + 1);
  return close < 0 ? s.length : close + delim.length + 2;
}

/**
 * Tokens of C++ source without comments and whitespace: identifiers, numbers,
 * string/char literals (raw strings respected) and punctuators (multi-char
 * operators kept whole). Never throws.
 */
export function cppStructureTokens(code: string): string[] {
  const s = code.replace(/\r\n?/g, '\n').replace(/\\\n/g, '');
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && s.charAt(i + 1) === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '/' && s.charAt(i + 1) === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < s.length && IDENT_PART.test(s.charAt(j))) j++;
      const word = s.slice(i, j);
      const q = s.charAt(j);
      if ((q === '"' || q === "'") && LITERAL_PREFIX.test(word)) {
        const end = q === '"' && word.endsWith('R') ? readRaw(s, j) : readQuoted(s, j, q);
        out.push(s.slice(i, end));
        i = end;
        continue;
      }
      out.push(word);
      i = j;
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(s.charAt(i + 1)))) {
      let j = i + 1;
      while (j < s.length) {
        const d = s.charAt(j);
        if (/[0-9A-Za-z_.]/.test(d)) j++;
        else if (d === "'" && /[0-9A-Fa-f]/.test(s.charAt(j + 1))) j++; // digit separator
        else if ((d === '+' || d === '-') && /[eEpP]/.test(s.charAt(j - 1)) && !/^0[xX][0-9A-Fa-f]*[eE]$/.test(s.slice(i, j))) j++;
        else break;
      }
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = readQuoted(s, i, c);
      out.push(s.slice(i, end));
      i = end;
      continue;
    }
    const p = PUNCTUATORS.find((op) => s.startsWith(op, i));
    out.push(p ?? c);
    i += p ? p.length : 1;
  }
  return out;
}

/** Same token sequence ignoring comments and whitespace; `>>` ≡ `> >` (template closers). */
export function sameCppStructure(a: string, b: string): boolean {
  const norm = (code: string): string[] => cppStructureTokens(code).flatMap((t) => (t === '>>' ? ['>', '>'] : [t]));
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((t, k) => t === y[k]);
}
