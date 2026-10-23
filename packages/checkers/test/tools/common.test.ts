import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../src';
import { common } from '../../src/tools';
import { describeTool } from './tableCases';

for (const tool of common) describeTool(tool);

describe('combined short flags', () => {
  it('covers exactly the spec list', () => {
    expect(common.map((t) => t.id)).toEqual(['ls', 'rm', 'cp', 'mv', 'mkdir', 'grep', 'tar', 'chmod', 'ps', 'du', 'df']);
    expect(common.every((t) => t.combineShortFlags)).toBe(true);
  });

  for (const tool of common) {
    const flags = (tool.root.options ?? []).flatMap((o) => o.names).filter((n) => /^-[A-Za-z]$/.test(n));
    const flagOnly = (tool.root.options ?? []).filter((o) => o.arity === 'flag').flatMap((o) => o.names).filter((n) => /^-[A-Za-z]$/.test(n));
    it(`${tool.id}: -xy ≡ -yx ≡ -x -y`, () => {
      expect(flags.length).toBeGreaterThan(0);
      const [a, b] = flagOnly;
      if (!a || !b) return;
      const combined = `${tool.id} -${a.slice(1)}${b.slice(1)} target`;
      expect(checkCommand({ expected: combined, answer: `${tool.id} -${b.slice(1)}${a.slice(1)} target` }).verdict).toBe('equivalent');
      expect(checkCommand({ expected: combined, answer: `${tool.id} ${a} ${b} target` }).verdict).toBe('equivalent');
      expect(checkCommand({ expected: combined, answer: `${tool.id} ${a} target` }).verdict).toBe('wrong');
    });
  }

  it('a value-taking letter takes the next token (tar -xzf file)', () => {
    expect(checkCommand({ expected: 'tar -xzf a.tar.gz', answer: 'tar -x -z -f a.tar.gz' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'tar -xzf a.tar.gz', answer: 'tar --extract --gzip --file=a.tar.gz' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'tar -xzf a.tar.gz -C /tmp', answer: 'tar -C /tmp -xzf a.tar.gz' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'tar -xzf a.tar.gz', answer: 'tar -xzf b.zip' }).verdict).toBe('wrong');
  });
});
