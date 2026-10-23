import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { isTypo, levenshtein } from '../src/typo';

describe('step 12: typos', () => {
  it('levenshtein', () => {
    expect(levenshtein('tf2_eco', 'tf2_echo')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abcdef', 'uvwxyz', 2)).toBe(3);
    expect(levenshtein('ção', 'cão')).toBe(1);
  });

  it('distance ≤ 2 and ≤ 25% of the expected length', () => {
    expect(isTypo('tf2_eco', 'tf2_echo')).toBe(true); // 1 ≤ 2
    expect(isTypo('tf2_ec', 'tf2_echo')).toBe(true); // 2 ≤ 2
    expect(isTypo('tf2_e', 'tf2_echo')).toBe(false); // 3
    expect(isTypo('lst', 'list')).toBe(true); // 1 ≤ 1
    expect(isTypo('ls', 'list')).toBe(false); // 2 > 25% of 4
    expect(isTypo('150.0', '150')).toBe(false); // 2 > 0.75
    expect(isTypo('abc', 'abd')).toBe(false); // 1 > 0.75
    expect(isTypo('same', 'same')).toBe(false);
  });

  it('a typo in the same position → almost with the spec message', () => {
    const r = checkCommand({ expected: 'ros2 run tf2_ros tf2_echo world turtle1', answer: 'ros2 run tf2_ros tf2_eco world turtle1' });
    expect(r.verdict).toBe('almost');
    expect(r.diffs).toEqual([{ kind: 'typo', expected: 'tf2_echo', got: 'tf2_eco', message: 'erro de digitação em `tf2_eco` (esperado `tf2_echo`)' }]);
  });

  it('Levenshtein 2 but more than 25% is not a typo', () => {
    expect(checkCommand({ expected: 'ros2 run pkg node', answer: 'ros2 run pkg nod' }).verdict).toBe('almost');
    expect(checkCommand({ expected: 'ros2 run pkg node', answer: 'ros2 run pkg no' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 run pkg talker', answer: 'ros2 run pkg talk' }).verdict).toBe('wrong');
  });

  it('typos in option names and values', () => {
    expect(checkCommand({ expected: 'colcon build --symlink-install', answer: 'colcon build --symlink-instal' }).verdict).toBe('almost');
    expect(checkCommand({ expected: 'ros2 bag record -a -o minha_gravacao', answer: 'ros2 bag record -a -o minha_gravacai' }).verdict).toBe('almost');
  });

  it('numbers and YAML values are never typos', () => {
    expect(checkCommand({ expected: 'ros2 topic pub -r 10 /t std_msgs/String "{}"', answer: 'ros2 topic pub -r 11 /t std_msgs/String "{}"' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 topic pub /t geometry_msgs/Twist "{linear: {x: 2.0}}"', answer: 'ros2 topic pub /t geometry_msgs/Twist "{linear: {x: 3.0}}"' }).verdict).toBe('wrong');
  });
});

describe('banded levenshtein', () => {
  it('matches the full computation under the limit', () => {
    let seed = 3;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const word = (): string => Array.from({ length: Math.floor(rnd() * 9) }, () => 'abc'.charAt(Math.floor(rnd() * 3))).join('');
    for (let k = 0; k < 2000; k++) {
      const a = word();
      const b = word();
      const full = levenshtein(a, b);
      for (const limit of [0, 1, 2, 3]) expect(levenshtein(a, b, limit)).toBe(full <= limit ? full : limit + 1);
    }
  });

  it('is linear for long, near-identical strings', () => {
    const a = 'x'.repeat(20_000);
    const t = performance.now();
    expect(levenshtein(a, `${a}y`, 2)).toBe(1);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
