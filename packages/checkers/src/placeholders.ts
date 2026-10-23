/**
 * Step 1 (spec 11.3): placeholders. `<name>` and `<name...>` are replaced by
 * private-use markers before any other step, so the lexer never reads
 * `<pacote>` as an input redirection.
 */

/** Start of a single-token placeholder marker. */
export const SINGLE_START = '\uE000';
/** Start of a multi-token (`<name...>`) placeholder marker. */
export const MULTI_START = '\uE002';
/** End of any placeholder marker. */
export const MARKER_END = '\uE001';

const PLACEHOLDER_RE = /<([\p{L}\p{N}_.\-]+?)(\.\.\.)?>/gu;
const MARKER_RE = /[\uE000\uE002]([^\uE001]*)\uE001/gu;

/** Replaces `<name>` / `<name...>` by internal markers. */
export function markPlaceholders(command: string): string {
  return command.replace(PLACEHOLDER_RE, (_m, name: string, dots: string | undefined) =>
    dots ? `${MULTI_START}${name}${MARKER_END}` : `${SINGLE_START}${name}${MARKER_END}`,
  );
}

/** Turns markers back into their `<name>` / `<name...>` text. */
export function restorePlaceholders(text: string): string {
  if (!hasMarker(text)) return text;
  return text.replace(MARKER_RE, (m, name: string) => (m.startsWith(MULTI_START) ? `<${name}...>` : `<${name}>`));
}

export function hasMarker(text: string): boolean {
  return text.includes(SINGLE_START) || text.includes(MULTI_START);
}

/** The token is exactly one `<name...>` marker (matches one or more tokens). */
export function isMultiPlaceholder(text: string): boolean {
  return text.startsWith(MULTI_START) && text.endsWith(MARKER_END) && text.indexOf(MARKER_END) === text.length - 1;
}

const regexCache = new Map<string, RegExp>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compares an expected token (which may contain markers) with a got token.
 * A marker matches any non-empty text; text around it must be identical, so
 * `--name=<x>` matches `--name=foo`.
 */
export function matchesWithPlaceholders(expected: string, got: string): boolean {
  if (expected === got) return true;
  if (!hasMarker(expected)) return false;
  let re = regexCache.get(expected);
  if (!re) {
    const parts = expected.split(/[\uE000\uE002][^\uE001]*\uE001/u).map(escapeRegExp);
    re = new RegExp(`^${parts.join('[\\s\\S]+?')}$`, 'u');
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(expected, re);
  }
  return re.test(got);
}

/**
 * Matches an expected sequence (with `<name...>` markers absorbing one or more
 * items) against a got sequence. `eq` compares single items.
 */
export function matchSequence<E, G>(
  expected: readonly E[],
  got: readonly G[],
  isMulti: (e: E) => boolean,
  eq: (e: E, g: G) => boolean,
): boolean {
  if (!expected.some(isMulti)) {
    return expected.length === got.length && expected.every((e, i) => eq(e, got[i] as G));
  }
  // memo[i][j] for i in expected, j in got
  const memo = new Map<number, boolean>();
  const width = got.length + 1;
  const go = (i: number, j: number): boolean => {
    if (i === expected.length) return j === got.length;
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const e = expected[i] as E;
    let ok = false;
    if (isMulti(e)) {
      for (let k = j + 1; k <= got.length && !ok; k++) ok = go(i + 1, k);
    } else if (j < got.length && eq(e, got[j] as G)) {
      ok = go(i + 1, j + 1);
    }
    memo.set(key, ok);
    return ok;
  };
  return go(0, 0);
}
