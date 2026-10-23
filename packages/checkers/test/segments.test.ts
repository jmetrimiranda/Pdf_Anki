import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { splitSegments } from '../src/segments';

describe('step 3: segments', () => {
  it('splits on |, &&, || and ; in order', () => {
    expect(splitSegments('a | b && c || d ; e')).toEqual({ segments: ['a', 'b', 'c', 'd', 'e'], operators: ['|', '&&', '||', ';'] });
  });

  it('respects quotes, escapes, $(…), ${…} and backticks', () => {
    expect(splitSegments(`echo "a | b" 'c && d' \\| $(x | y) \${v:-a;b} \`p | q\``).segments).toHaveLength(1);
  });

  it('does not split redirections with &', () => {
    expect(splitSegments('cmd > log 2>&1').segments).toEqual(['cmd > log 2>&1']);
    expect(splitSegments('cmd &> log').segments).toEqual(['cmd &> log']);
    expect(splitSegments('server & client').operators).toEqual(['&']);
  });

  it('newlines separate commands; a trailing ; is dropped', () => {
    expect(splitSegments('a\nb').operators).toEqual([';']);
    expect(splitSegments('a ;').segments).toEqual(['a']);
  });

  it('operators must match and segments are compared in order', () => {
    expect(checkCommand({ expected: 'a x && b y', answer: 'a x ; b y' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'a x && b y', answer: 'b y && a x' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'cat f | grep -i x', answer: 'cat f | grep x -i' }).verdict).toBe('equivalent');
    const extra = checkCommand({ expected: 'ros2 topic echo /chatter', answer: 'ros2 topic echo /chatter | grep data' });
    expect(extra.diffs.map((d) => d.kind)).toEqual(['extra']);
    const missing = checkCommand({ expected: 'a | b', answer: 'a' });
    expect(missing.diffs.map((d) => d.kind)).toEqual(['missing']);
  });

  it('lone operators never throw', () => {
    expect(splitSegments('|').segments).toEqual(['', '']);
    expect(checkCommand({ expected: '| &&', answer: '||' }).verdict).toBe('wrong');
  });
});
