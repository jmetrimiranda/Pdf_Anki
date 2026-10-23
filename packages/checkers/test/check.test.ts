import { describe, expect, it } from 'vitest';
import { VERDICT_ORDER, checkCommand } from '../src';

describe('steps 13–14: variants and classification', () => {
  it('VERDICT_ORDER is best → worst', () => {
    expect(VERDICT_ORDER).toEqual(['correct', 'equivalent', 'almost', 'wrong', 'unverifiable']);
  });

  it('best verdict over Resposta + Aceitas, with matchedVariant', () => {
    const input = {
      expected: 'ros2 run tf2_ros tf2_echo world turtle1',
      accepted: ['ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco', 'ros2 run tf2_ros tf2_monitor'],
    };
    expect(checkCommand({ ...input, answer: 'ros2 run tf2_ros tf2_echo world turtle1' })).toMatchObject({ verdict: 'correct', matchedVariant: 0 });
    expect(checkCommand({ ...input, answer: 'ros2 run tf2_ros tf2_echo world turtle1 --ros-args --remap __node:=eco' })).toMatchObject({ verdict: 'equivalent', matchedVariant: 1 });
    expect(checkCommand({ ...input, answer: 'ros2 run tf2_ros tf2_monitor' })).toMatchObject({ verdict: 'correct', matchedVariant: 2, normalizedExpected: 'ros2 run tf2_ros tf2_monitor' });
    expect(checkCommand({ ...input, answer: 'ros2 run tf2_ros tf2_monitr' })).toMatchObject({ verdict: 'almost', matchedVariant: 2 });
    expect(checkCommand({ ...input, answer: 'ls' }).verdict).toBe('wrong');
  });

  it('empty Aceitas lines are skipped but keep their index', () => {
    expect(checkCommand({ expected: 'a b', accepted: ['', '  ', 'c d'], answer: 'c d' }).matchedVariant).toBe(3);
  });

  it('scores', () => {
    expect(checkCommand({ expected: 'ls -la', answer: 'ls -la' }).score).toBe(1);
    expect(checkCommand({ expected: 'ls -la', answer: 'ls -al' }).score).toBe(0.9);
    expect(checkCommand({ expected: 'sudo ls', answer: 'ls' }).score).toBe(0.6);
    const wrong = checkCommand({ expected: 'ros2 topic echo /a', answer: 'ros2 topic echo /b' });
    expect(wrong.score).toBeGreaterThan(0);
    expect(wrong.score).toBeLessThanOrEqual(0.5);
    expect(checkCommand({ expected: 'abc', answer: 'xyz' }).score).toBe(0);
  });

  it('empty answer → wrong with a missing diff', () => {
    for (const answer of ['', '   ', '\n\t']) {
      const r = checkCommand({ expected: 'ls -la', answer });
      expect(r.verdict).toBe('wrong');
      expect(r.diffs).toEqual([{ kind: 'missing', expected: 'ls -la', message: 'resposta vazia' }]);
    }
  });

  it('no canonical answer → unverifiable', () => {
    expect(checkCommand({ expected: '', answer: 'ls' }).verdict).toBe('unverifiable');
  });

  it('normalized strings', () => {
    const r = checkCommand({ expected: '$ ros2  run <pacote>  x;', answer: '  ros2 run “a”  x ' });
    expect(r.normalizedExpected).toBe('ros2 run <pacote> x');
    expect(r.normalizedAnswer).toBe('ros2 run "a" x');
    expect(r.verdict).toBe('correct');
  });

  it('equivalences only → equivalent; quotes and spaces → correct', () => {
    expect(checkCommand({ expected: "grep 'a b' f", answer: 'grep "a b" f' }).verdict).toBe('correct');
    expect(checkCommand({ expected: 'grep "a b" f', answer: 'grep a b f' }).verdict).toBe('wrong');
  });

  it('the spec 11.7 example card', () => {
    const card = { expected: 'ros2 run tf2_ros tf2_echo world turtle1', accepted: ['ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco'] };
    expect(checkCommand({ ...card, answer: card.expected }).verdict).toBe('correct');
    expect(checkCommand({ ...card, answer: card.accepted[0] ?? '' })).toMatchObject({ verdict: 'correct', matchedVariant: 1 });
  });
});
