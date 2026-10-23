/**
 * Step 12 (spec 11.3): a token in the same position that differs by a
 * Levenshtein distance ≤ 2 AND ≤ 25% of the expected token's length is a
 * typo (→ Quase).
 */

export const TYPO_MAX_DISTANCE = 2;
export const TYPO_MAX_RATIO = 0.25;

/**
 * Levenshtein distance over code points. With a finite `limit`, only the
 * diagonal band |i − j| ≤ limit is computed (O(n·limit)) and any distance above
 * the limit is reported as `limit + 1`.
 */
export function levenshtein(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  const s = Array.from(a);
  const t = Array.from(b);
  const n = s.length;
  const m = t.length;
  if (Math.abs(n - m) > limit) return limit + 1;
  if (n === 0) return m;
  if (m === 0) return n;
  const band = Number.isFinite(limit) ? limit : Math.max(n, m);
  const INF = Number.MAX_SAFE_INTEGER;
  let prev = new Array<number>(m + 1).fill(INF);
  let curr = new Array<number>(m + 1).fill(INF);
  for (let j = 0; j <= Math.min(m, band); j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - band);
    const hi = Math.min(m, i + band);
    // Cells just outside the band must read as "infinite".
    if (lo === 1) curr[0] = i;
    else curr[lo - 1] = INF;
    let rowMin = lo === 1 ? i : INF;
    for (let j = lo; j <= hi; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? INF) + 1, (curr[j - 1] ?? INF) + 1, (prev[j - 1] ?? INF) + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi + 1 <= m) curr[hi + 1] = INF;
    if (rowMin > limit) return limit + 1;
    [prev, curr] = [curr, prev];
  }
  const d = prev[m] ?? INF;
  return d > limit ? limit + 1 : d;
}

/** `got` is a typo of `expected` (different, distance ≤ 2 and ≤ 25% of `expected`'s length). */
export function isTypo(got: string, expected: string): boolean {
  if (got === expected) return false;
  const len = Array.from(expected).length;
  const allowed = Math.min(TYPO_MAX_DISTANCE, Math.floor(len * TYPO_MAX_RATIO));
  if (allowed < 1) return false;
  return levenshtein(got, expected, allowed) <= allowed;
}
