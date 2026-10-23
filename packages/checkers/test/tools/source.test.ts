import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../src';
import { source } from '../../src/tools';

describe('source ≡ .', () => {
  it('declares both names', () => {
    expect(source.names).toEqual(['source', '.']);
  });

  it('source x ≡ . x (both ways)', () => {
    expect(checkCommand({ expected: 'source install/setup.bash', answer: '. install/setup.bash' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: '. /opt/ros/humble/setup.bash', answer: 'source /opt/ros/humble/setup.bash' }).verdict).toBe('equivalent');
  });

  it('a different file is wrong', () => {
    expect(checkCommand({ expected: 'source install/setup.bash', answer: '. install/local_setup.zsh' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'source install/setup.bash', answer: 'bash install/setup.bash' }).verdict).toBe('wrong');
  });
});
