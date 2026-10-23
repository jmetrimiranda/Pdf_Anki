/** Myers O(ND) sequence diff, used for the visual token/line diffs and for aligning arguments. */

export type DiffOp = { op: 'equal' | 'insert' | 'delete'; text: string };

/** One step of an alignment: `a` index for equal/delete, `b` index for equal/insert. */
export type EditStep = { op: 'equal'; a: number; b: number } | { op: 'delete'; a: number } | { op: 'insert'; b: number };

/** Above this edit distance the diff gives up and reports "replace everything" (bounded time and memory). */
const MAX_EDITS = 2000;

export function diffSequences<A, B>(a: readonly A[], b: readonly B[], eq: (x: A, y: B) => boolean): EditStep[] {
  // Common prefix and suffix first: cheap and keeps the core small.
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start] as A, b[start] as B)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1] as A, b[endB - 1] as B)) {
    endA--;
    endB--;
  }
  const steps: EditStep[] = [];
  for (let k = 0; k < start; k++) steps.push({ op: 'equal', a: k, b: k });
  steps.push(...myers(a, b, start, endA, start, endB, eq));
  for (let k = 0; k < a.length - endA; k++) steps.push({ op: 'equal', a: endA + k, b: endB + k });
  return steps;
}

function myers<A, B>(
  a: readonly A[],
  b: readonly B[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  eq: (x: A, y: B) => boolean,
): EditStep[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const replaceAll = (): EditStep[] => {
    const out: EditStep[] = [];
    for (let i = a0; i < a1; i++) out.push({ op: 'delete', a: i });
    for (let j = b0; j < b1; j++) out.push({ op: 'insert', b: j });
    return out;
  };
  if (n === 0 || m === 0) return replaceAll();
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0;
      } else {
        x = (v[offset + k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && eq(a[a0 + x] as A, b[b0 + y] as B)) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        v = next;
        trace.push(v);
        found = true;
        break outer;
      }
    }
    v = next;
  }
  if (!found) return replaceAll();
  // Backtrack. trace[d] holds V before step d; the last entry is the final V.
  const out: EditStep[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const vd = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : (vd[offset + prevK] ?? 0);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: 'equal', a: a0 + x - 1, b: b0 + y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: 'insert', b: b0 + y - 1 });
      else out.push({ op: 'delete', a: a0 + x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  // d === 0 diagonal (leading snake) is handled by the loop above when prevX/prevY = 0.
  while (x > 0 && y > 0) {
    out.push({ op: 'equal', a: a0 + x - 1, b: b0 + y - 1 });
    x--;
    y--;
  }
  return out.reverse();
}

function toOps(steps: readonly EditStep[], a: readonly string[], b: readonly string[]): DiffOp[] {
  return steps.map((s) =>
    s.op === 'insert'
      ? { op: 'insert', text: b[s.b] ?? '' }
      : s.op === 'delete'
        ? { op: 'delete', text: a[s.a] ?? '' }
        : { op: 'equal', text: a[s.a] ?? '' },
  );
}

/** Token diff for the visual diff (expected → got). */
export function tokenDiff(expected: readonly string[], got: readonly string[]): DiffOp[] {
  return toOps(
    diffSequences(expected, got, (x, y) => x === y),
    expected,
    got,
  );
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** Line diff (expected → got); CRLF is read as LF. */
export function lineDiff(expected: string, got: string): DiffOp[] {
  const a = splitLines(expected);
  const b = splitLines(got);
  return tokenDiff(a, b);
}

/** Length of the longest common subsequence, from an alignment. */
export function commonLength<A, B>(a: readonly A[], b: readonly B[], eq: (x: A, y: B) => boolean): number {
  return diffSequences(a, b, eq).filter((s) => s.op === 'equal').length;
}
