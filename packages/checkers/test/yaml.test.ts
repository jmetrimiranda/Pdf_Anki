import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { canonical, parseFlowYaml, yamlEqual } from '../src/yaml';

describe('step 10: YAML flow values', () => {
  it('2 ≡ 2.0 and nested maps, key order free', () => {
    expect(yamlEqual('{linear: {x: 2.0}}', '{linear: {x: 2}}')).toBe(true);
    expect(yamlEqual('{linear: {x: 2.0, y: 0.0}, angular: {z: 1.8}}', '{angular: {z: 1.80}, linear: {y: 0, x: 2}}')).toBe(true);
    expect(yamlEqual('{linear: {x: 2.0}}', '{linear: {x: 3.0}}')).toBe(false);
    expect(yamlEqual('{a: 1}', '{a: 1, b: 2}')).toBe(false);
  });

  it('sequences, quoted and plain scalars, booleans, null', () => {
    expect(parseFlowYaml('[1, 2.5, -3, 1e3]')).toEqual([1, 2.5, -3, 1000]);
    expect(yamlEqual('[a, "b", \'c\']', '["a", b, c]')).toBe(true);
    expect(yamlEqual('{a: true, b: ~}', '{a: True, b: null}')).toBe(true);
    expect(yamlEqual('{data: "2"}', '{data: 2}')).toBe(false);
    expect(yamlEqual('[1, 2]', '[2, 1]')).toBe(false);
    expect(yamlEqual('{data: hello world}', "{data: 'hello world'}")).toBe(true);
    expect(yamlEqual('[a: 1]', '[{a: 1}]')).toBe(true);
    expect(canonical(0x10)).toBe(canonical(16));
  });

  it('applies only when both tokens are flow collections', () => {
    expect(yamlEqual('{a: 1}', 'a')).toBeUndefined();
    expect(yamlEqual('150', '150.0')).toBeUndefined();
    expect(parseFlowYaml('{a: 1')).toBeUndefined();
    expect(parseFlowYaml('{a: 1} x')).toBeUndefined();
    expect(parseFlowYaml('[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]')).toBeUndefined();
  });

  it('outside YAML numbers are text (150 ≠ 150.0)', () => {
    expect(checkCommand({ expected: 'ros2 param set /t r 150', answer: 'ros2 param set /t r 150.0' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 param set /t r 150', answer: 'ros2 param set /t r 151' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 param set /t l "[1, 2]"', answer: "ros2 param set /t l '[1.0, 2.0]'" }).verdict).toBe('equivalent');
  });

  it('YAML inside name:=value', () => {
    expect(checkCommand({ expected: 'ros2 run a b --ros-args -p "l:=[1, 2]"', answer: 'ros2 run a b --ros-args -p "l:=[1.0, 2]"' }).verdict).toBe('equivalent');
  });
});
