import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../src';
import { apt } from '../../src/tools';
import { describeTool } from './tableCases';

describeTool(apt, 'apt');

describe('apt ≡ apt-get', () => {
  for (const sub of ['install', 'remove', 'update', 'upgrade']) {
    it(`apt ${sub} ≡ apt-get ${sub}`, () => {
      expect(checkCommand({ expected: `sudo apt ${sub} pkg-a`, answer: `sudo apt-get ${sub} pkg-a` }).verdict).toBe('equivalent');
      expect(checkCommand({ expected: `sudo apt-get ${sub} pkg-a`, answer: `sudo apt ${sub} pkg-a` }).verdict).toBe('equivalent');
      expect(checkCommand({ expected: `sudo apt ${sub} pkg-a`, answer: `sudo apt-cache ${sub} pkg-a` }).verdict).toBe('wrong');
    });
  }

  it('harmless flags anywhere', () => {
    expect(checkCommand({ expected: 'sudo apt install a', answer: 'sudo apt -y -q install a' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'sudo apt-get install -y a', answer: 'sudo apt install a' }).verdict).toBe('equivalent');
  });

  it('install: package list is a set', () => {
    expect(checkCommand({ expected: 'sudo apt install a b', answer: 'sudo apt install b a' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'sudo apt install a b', answer: 'sudo apt install a' }).verdict).toBe('wrong');
  });
});
