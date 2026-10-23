import { describe, expect, it } from 'vitest';
import { normalizeCommand, straightenQuotes } from '../src/normalize';

describe('step 2: normalize', () => {
  it('trims and collapses spaces outside quotes', () => {
    expect(normalizeCommand('  ros2  run   a\tb  ')).toBe('ros2 run a b');
    expect(normalizeCommand('echo "a   b"   c')).toBe('echo "a   b" c');
    expect(normalizeCommand("echo 'a   b'")).toBe("echo 'a   b'");
  });

  it('strips a leading $ prompt', () => {
    expect(normalizeCommand('$ ls -la')).toBe('ls -la');
    expect(normalizeCommand('$HOME/bin/x')).toBe('$HOME/bin/x');
  });

  it('straightens typographic quotes', () => {
    expect(straightenQuotes('“a” ‘b’')).toBe(`"a" 'b'`);
    expect(normalizeCommand('echo “oi”')).toBe('echo "oi"');
  });

  it('strips a trailing ; (not escaped, not quoted)', () => {
    expect(normalizeCommand('ls;')).toBe('ls');
    expect(normalizeCommand('ls ; ')).toBe('ls');
    expect(normalizeCommand('echo \\;')).toBe('echo \\;');
    expect(normalizeCommand('echo "a;')).toBe('echo "a;');
  });

  it('joins line continuations and keeps newlines as separators', () => {
    expect(normalizeCommand('colcon build \\\n  --symlink-install')).toBe('colcon build --symlink-install');
    expect(normalizeCommand('a\r\n\r\nb')).toBe('a\nb');
  });
});
