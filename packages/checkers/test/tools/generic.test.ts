import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../src';
import { genericTool, isKnownTool, toolFor } from '../../src/tools';

describe('generic tools', () => {
  it('unknown programs get the generic table', () => {
    expect(isKnownTool('g++')).toBe(false);
    expect(toolFor('g++')).toEqual(genericTool('g++'));
    expect(genericTool('g++').combineShortFlags).toBe(false);
  });

  it('no combined-flag expansion: -Wall and -std=c++20 are one option each', () => {
    expect(checkCommand({ expected: 'g++ -Wall main.cpp', answer: 'g++ -W -a -l -l main.cpp' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'g++ -std=c++20 main.cpp', answer: 'g++ main.cpp -std=c++20' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'mytool -ab x', answer: 'mytool -ba x' }).verdict).toBe('wrong');
  });

  it('arity deduced from the canonical answer', () => {
    // `--out file` in the canonical: `file` is the value of `--out` in both strings.
    expect(checkCommand({ expected: 'mytool --out file input', answer: 'mytool input --out file' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'mytool --out file input', answer: 'mytool --out=file input' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'mytool --out file input', answer: 'mytool --out input file' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'g++ -o prog main.cpp', answer: 'g++ main.cpp -o prog' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'g++ -o prog main.cpp', answer: 'g++ -o main.cpp prog' }).verdict).toBe('wrong');
  });

  it('options as a multiset, positionals in order', () => {
    expect(checkCommand({ expected: 'g++ -Wall -Wextra -o prog main.cpp', answer: 'g++ -Wextra main.cpp -o prog -Wall' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'cp a b', answer: 'cp b a' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'diff a b', answer: 'diff b a' }).diffs[0]?.message).toBe('ordem dos argumentos');
  });

  it('leading words without a dash are positionals', () => {
    expect(checkCommand({ expected: 'git commit -m msg', answer: 'git commit -m msg' }).verdict).toBe('correct');
    expect(checkCommand({ expected: 'git commit -m msg', answer: 'git push -m msg' }).verdict).toBe('wrong');
  });
});
