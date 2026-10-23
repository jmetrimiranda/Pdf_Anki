/** Output comparison (spec 11.4/11.5 mode `saida`) and `check.hpp` result parsing (mode `testes`). */
import type { DiffOp } from './diff';
import { lineDiff } from './diff';

function lines(text: string): string[] {
  const out = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/u, ''));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function collapsed(ls: readonly string[]): string[] {
  return ls.map((l) => l.replace(/\s+/gu, ' ').trim());
}

/**
 * Compares stdout with the expected output.
 * - Not exact: trailing whitespace of each line and trailing blank lines are ignored → `correct`.
 * - Exact: byte-equal → `correct`.
 * - Equal only after collapsing whitespace runs inside lines (or, in exact mode, after the relaxed rules) → `almost`.
 * - Otherwise `wrong`. The diff is per line, on the relaxed form.
 */
export function compareOutput(
  expected: string,
  got: string,
  opts: { exact: boolean },
): { verdict: 'correct' | 'almost' | 'wrong'; diff: DiffOp[] } {
  const e = lines(expected);
  const g = lines(got);
  const diff = lineDiff(e.join('\n'), g.join('\n'));
  const relaxedEqual = e.length === g.length && e.every((l, k) => l === g[k]);
  if (opts.exact ? expected === got : relaxedEqual) return { verdict: 'correct', diff };
  if (relaxedEqual) return { verdict: 'almost', diff };
  const ec = collapsed(e);
  const gc = collapsed(g);
  if (ec.length === gc.length && ec.every((l, k) => l === gc[k])) return { verdict: 'almost', diff };
  return { verdict: 'wrong', diff };
}

export interface CheckLine {
  ok: boolean;
  text: string;
}

/**
 * Reads the `check.hpp` output: lines starting with `PASS ` / `FAIL `
 * (a bare `PASS`/`FAIL` also counts); every other line is ignored.
 */
export function parseCheckLines(stdout: string): { lines: CheckLine[]; passed: number; failed: number } {
  const out: CheckLine[] = [];
  let passed = 0;
  let failed = 0;
  for (const raw of stdout.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^(PASS|FAIL)(?: (.*))?$/.exec(raw.replace(/\s+$/u, ''));
    if (!m) continue;
    const ok = m[1] === 'PASS';
    out.push({ ok, text: (m[2] ?? '').trim() });
    if (ok) passed++;
    else failed++;
  }
  return { lines: out, passed, failed };
}
