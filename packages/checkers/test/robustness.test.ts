import { describe, expect, it } from 'vitest';
import { checkCommand, compareOutput, cppStructureTokens, parseCheckLines, shellTokens } from '../src';
import { parseFlowYaml } from '../src/yaml';

const ALPHABET = [
  ...'abcxyz0129 -_./=:',
  '"', "'", '`', '\\', '$', '(', ')', '{', '}', '[', ']', '<', '>', '|', '&', ';', '\n', '\t', '#', '*', '~',
  '<pacote>', '<x...>', '--ros-args', '--', 'sudo', 'ros2', 'topic', 'pub', 'apt', 'ls', '-la', '2>&1', '$(', '${', ':=',
  '“', '’', 'é', '\u0000', '', '', '', '🙂',
];

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function garbage(rnd: () => number): string {
  const n = Math.floor(rnd() * 40);
  let out = '';
  for (let k = 0; k < n; k++) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)] ?? '';
  return out;
}

describe('robustness: never throws', () => {
  it('2000 random/garbage pairs', () => {
    const rnd = rng(42);
    for (let k = 0; k < 2000; k++) {
      const expected = garbage(rnd);
      const answer = garbage(rnd);
      const accepted = rnd() < 0.3 ? [garbage(rnd)] : [];
      const requires = rnd() < 0.2 ? ['sudo', garbage(rnd)] : [];
      const r = checkCommand({ expected, answer, accepted, requires });
      expect(['correct', 'equivalent', 'almost', 'wrong', 'unverifiable']).toContain(r.verdict);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(() => shellTokens(answer)).not.toThrow();
      expect(() => cppStructureTokens(answer)).not.toThrow();
      expect(() => parseFlowYaml(`{${answer}}`)).not.toThrow();
      expect(() => compareOutput(expected, answer, { exact: rnd() < 0.5 })).not.toThrow();
      expect(() => parseCheckLines(answer)).not.toThrow();
    }
  });

  it('pathological inputs', () => {
    const cases = [
      '"'.repeat(5000),
      '$('.repeat(3000),
      '{'.repeat(4000),
      '['.repeat(4000) + ']'.repeat(4000),
      'ls ' + '-a '.repeat(3000),
      '| '.repeat(3000),
      'x'.repeat(10_000),
      Array.from({ length: 2000 }, (_, k) => `t${k}`).join(' '),
      '<a...> '.repeat(500),
    ];
    for (const s of cases) {
      expect(() => checkCommand({ expected: s, answer: s.slice(0, s.length - 1) })).not.toThrow();
      expect(() => checkCommand({ expected: 'ros2 topic pub /t a/b "{x: 1}"', answer: s })).not.toThrow();
    }
  });

  it('non-string fields from untrusted callers', () => {
    const bad = { expected: 42, answer: null, accepted: [undefined, 7], requires: [null] } as unknown as Parameters<typeof checkCommand>[0];
    expect(() => checkCommand(bad)).not.toThrow();
  });
});
