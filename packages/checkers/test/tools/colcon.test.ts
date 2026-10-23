import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../src';
import { colcon } from '../../src/tools';
import { describeTool } from './tableCases';

describeTool(colcon);

describe('colcon specifics', () => {
  it('--packages-select and --packages-up-to are variadic sets', () => {
    expect(checkCommand({ expected: 'colcon build --packages-select a b --symlink-install', answer: 'colcon build --symlink-install --packages-select b a' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'colcon build --packages-up-to a b', answer: 'colcon build --packages-up-to a' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'colcon build --packages-select a', answer: 'colcon build --packages-up-to a' }).verdict).toBe('wrong');
  });

  it('--symlink-install is a flag (does not eat the next option)', () => {
    expect(checkCommand({ expected: 'colcon build --symlink-install --packages-select a', answer: 'colcon build --packages-select a --symlink-install' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'colcon build --symlink-install', answer: 'colcon build' }).verdict).toBe('wrong');
  });

  it('colcon test', () => {
    expect(checkCommand({ expected: 'colcon test --packages-select a', answer: 'colcon test --packages-select=a' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'colcon test', answer: 'colcon build' }).verdict).toBe('wrong');
  });
});
