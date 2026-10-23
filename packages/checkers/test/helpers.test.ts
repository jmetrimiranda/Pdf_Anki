import { describe, expect, it } from 'vitest';
import {
  compareOutput,
  cppStructureTokens,
  lineDiff,
  parseCheckLines,
  sameCppStructure,
  shellTokens,
  suggestRating,
  tokenDiff,
} from '../src';
import type { DiffOp } from '../src';

const apply = (ops: readonly DiffOp[], side: 'a' | 'b'): string[] =>
  ops.filter((o) => o.op === 'equal' || o.op === (side === 'a' ? 'delete' : 'insert')).map((o) => o.text);

describe('tokenDiff', () => {
  it('produces a minimal diff that rebuilds both sides', () => {
    const a = ['ros2', 'run', 'tf2_ros', 'tf2_echo', 'world', 'turtle1'];
    const b = ['ros2', 'run', 'tf2_ros', 'tf2_eco', 'world', 'turtle1', 'x'];
    const ops = tokenDiff(a, b);
    expect(apply(ops, 'a')).toEqual(a);
    expect(apply(ops, 'b')).toEqual(b);
    expect(ops.filter((o) => o.op !== 'equal')).toEqual([
      { op: 'delete', text: 'tf2_echo' },
      { op: 'insert', text: 'tf2_eco' },
      { op: 'insert', text: 'x' },
    ]);
  });

  it('handles empty sides and identical input', () => {
    expect(tokenDiff([], [])).toEqual([]);
    expect(tokenDiff(['a'], [])).toEqual([{ op: 'delete', text: 'a' }]);
    expect(tokenDiff([], ['a'])).toEqual([{ op: 'insert', text: 'a' }]);
    expect(tokenDiff(['a', 'b'], ['a', 'b']).every((o) => o.op === 'equal')).toBe(true);
  });

  it('random sequences round-trip and use LCS-many equals', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const lcs = (a: string[], b: string[]): number => {
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          (dp[i] as number[])[j] = a[i - 1] === b[j - 1] ? ((dp[i - 1] as number[])[j - 1] as number) + 1 : Math.max((dp[i - 1] as number[])[j] as number, (dp[i] as number[])[j - 1] as number);
      return (dp[a.length] as number[])[b.length] as number;
    };
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'.charAt(Math.floor(rnd() * 4)));
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'.charAt(Math.floor(rnd() * 4)));
      const ops = tokenDiff(a, b);
      expect(apply(ops, 'a')).toEqual(a);
      expect(apply(ops, 'b')).toEqual(b);
      expect(ops.filter((o) => o.op === 'equal').length).toBe(lcs(a, b));
    }
  });
});

describe('lineDiff', () => {
  it('diffs per line, CRLF as LF', () => {
    expect(lineDiff('a\r\nb\r\nc', 'a\nB\nc')).toEqual([
      { op: 'equal', text: 'a' },
      { op: 'delete', text: 'b' },
      { op: 'insert', text: 'B' },
      { op: 'equal', text: 'c' },
    ]);
    expect(lineDiff('', '')).toEqual([]);
  });

  it('stays bounded on large, totally different inputs', () => {
    const a = Array.from({ length: 5000 }, (_, k) => `a${k}`).join('\n');
    const b = Array.from({ length: 5000 }, (_, k) => `b${k}`).join('\n');
    const t = performance.now();
    const ops = lineDiff(a, b);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(ops).toHaveLength(10000);
  });
});

describe('compareOutput (mode saida)', () => {
  it('ignores trailing spaces and trailing blank lines', () => {
    expect(compareOutput('6\n0\n', '6  \n0\n\n\n', { exact: false }).verdict).toBe('correct');
    expect(compareOutput('a\nb', 'a\r\nb\r\n', { exact: false }).verdict).toBe('correct');
  });

  it('whitespace runs inside lines → almost', () => {
    expect(compareOutput('a b  c', 'a  b c', { exact: false }).verdict).toBe('almost');
    expect(compareOutput('a b', '  a\tb', { exact: false }).verdict).toBe('almost');
  });

  it('anything else → wrong, with a line diff', () => {
    const r = compareOutput('1\n2\n3', '1\n4\n3', { exact: false });
    expect(r.verdict).toBe('wrong');
    expect(r.diff.filter((o) => o.op !== 'equal')).toEqual([
      { op: 'delete', text: '2' },
      { op: 'insert', text: '4' },
    ]);
    expect(compareOutput('a\n\nb', 'a\nb', { exact: false }).verdict).toBe('wrong');
  });

  it('exact mode: byte-equal → correct, else the relaxed rules give at most almost', () => {
    expect(compareOutput('a\n', 'a\n', { exact: true }).verdict).toBe('correct');
    expect(compareOutput('a\n', 'a', { exact: true }).verdict).toBe('almost');
    expect(compareOutput('a\n', 'a\r\n', { exact: true }).verdict).toBe('almost');
    expect(compareOutput('a', 'b', { exact: true }).verdict).toBe('wrong');
  });
});

describe('parseCheckLines (check.hpp)', () => {
  it('reads PASS/FAIL lines and ignores the rest', () => {
    const r = parseCheckLines('hello\nPASS soma(2, 2) == 4\nFAIL soma(1, 1) == 3 (main.cpp:9)\r\nPASSED nope\nPASS\n');
    expect(r).toEqual({
      lines: [
        { ok: true, text: 'soma(2, 2) == 4' },
        { ok: false, text: 'soma(1, 1) == 3 (main.cpp:9)' },
        { ok: true, text: '' },
      ],
      passed: 2,
      failed: 1,
    });
    expect(parseCheckLines('')).toEqual({ lines: [], passed: 0, failed: 0 });
  });
});

describe('cppStructureTokens / sameCppStructure', () => {
  it('drops comments and whitespace, keeps multi-char operators', () => {
    expect(cppStructureTokens('int x = a->b; // c\n/* d */ x <<= 2; y::z++; a <=> b;')).toEqual([
      'int', 'x', '=', 'a', '->', 'b', ';', 'x', '<<=', '2', ';', 'y', '::', 'z', '++', ';', 'a', '<=>', 'b', ';',
    ]);
  });

  it('respects // and /* inside strings, chars and raw strings', () => {
    expect(cppStructureTokens('auto s = "http://x /* no */"; char c = \'/\'; // gone')).toEqual([
      'auto', 's', '=', '"http://x /* no */"', ';', 'char', 'c', '=', "'/'", ';',
    ]);
    expect(cppStructureTokens('auto r = R"x(a // ) " b)x"; auto u = u8"é";')).toEqual([
      'auto', 'r', '=', 'R"x(a // ) " b)x"', ';', 'auto', 'u', '=', 'u8"é"', ';',
    ]);
    expect(cppStructureTokens('"esc \\" // still"')).toEqual(['"esc \\" // still"']);
  });

  it('numbers with separators, exponents and suffixes', () => {
    expect(cppStructureTokens("1'000'000 3.14e-2f 0x1Fu .5")).toEqual(["1'000'000", '3.14e-2f', '0x1Fu', '.5']);
  });

  it('same structure ignores formatting and comments; >> ≡ > >', () => {
    const a = 'int soma(int a,int b){return a+b;}';
    const b = 'int soma(int a, int b) {\n  // soma\n  return a + b;\n}\n';
    expect(sameCppStructure(a, b)).toBe(true);
    expect(sameCppStructure(a, 'int soma(int a, int b) { return a - b; }')).toBe(false);
    expect(sameCppStructure('std::vector<std::vector<int>> v;', 'std::vector<std::vector<int> > v;')).toBe(true);
  });

  it('never throws on unterminated input', () => {
    for (const s of ['"abc', "'", 'R"x(abc', '/* abc', 'a //', '#include <x']) expect(() => cppStructureTokens(s)).not.toThrow();
  });
});

describe('suggestRating (11.2 table)', () => {
  const opts = { elapsedMs: 10_000, suggestEasy: false, easySecs: 5 };
  it('maps verdicts', () => {
    expect(suggestRating('correct', opts)).toBe(3);
    expect(suggestRating('equivalent', opts)).toBe(3);
    expect(suggestRating('almost', opts)).toBe(2);
    expect(suggestRating('wrong', opts)).toBe(1);
    expect(suggestRating('unverifiable', opts)).toBeNull();
    expect(suggestRating(null, opts)).toBeNull();
  });

  it('optional Easy when correct and fast', () => {
    expect(suggestRating('correct', { elapsedMs: 4_999, suggestEasy: true, easySecs: 5 })).toBe(4);
    expect(suggestRating('correct', { elapsedMs: 5_000, suggestEasy: true, easySecs: 5 })).toBe(3);
    expect(suggestRating('correct', { elapsedMs: 1_000, suggestEasy: false, easySecs: 5 })).toBe(3);
    expect(suggestRating('equivalent', { elapsedMs: 1_000, suggestEasy: true, easySecs: 5 })).toBe(3);
  });
});

describe('shellTokens', () => {
  it('keeps quotes, operators and redirections as typed', () => {
    expect(shellTokens('ros2 topic pub "{a: 1}"  >out.txt | grep x')).toEqual(['ros2', 'topic', 'pub', '"{a: 1}"', '>out.txt', '|', 'grep', 'x']);
    expect(shellTokens('$ ros2 run <pacote> x;')).toEqual(['ros2', 'run', '<pacote>', 'x']);
    expect(shellTokens('')).toEqual([]);
  });
});
