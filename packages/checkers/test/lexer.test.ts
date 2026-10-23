import { describe, expect, it } from 'vitest';
import { lexSegment } from '../src/lexer';

const texts = (s: string): string[] => lexSegment(s).words.map((t) => t.text);

describe('step 4: lexer', () => {
  it('removes single and double quotes in the final token', () => {
    expect(texts(`echo "foo" 'bar baz' a"b"c`)).toEqual(['echo', 'foo', 'bar baz', 'abc']);
    const [, quoted] = lexSegment('echo "foo"').words;
    expect(quoted).toMatchObject({ text: 'foo', raw: '"foo"', quoted: true });
  });

  it('resolves backslash escapes', () => {
    expect(texts('echo a\\ b \\"q\\" "x\\"y" \'c\\d\'')).toEqual(['echo', 'a b', '"q"', 'x"y', 'c\\d']);
  });

  it('keeps $(…), ${…} and backticks as one token', () => {
    expect(texts('echo $(ros2 pkg prefix "a b") ${HOME:-/x y} `date +%s`')).toEqual([
      'echo',
      '$(ros2 pkg prefix "a b")',
      '${HOME:-/x y}',
      '`date +%s`',
    ]);
    expect(texts('cd "$(dirname "$0")"')).toEqual(['cd', '$(dirname "$0")']);
  });

  it('turns redirections into their own tokens with the target, moved to the end', () => {
    const lexed = lexSegment('> out.txt cmd a 2>&1 b');
    expect(lexed.words.map((t) => t.text)).toEqual(['cmd', 'a', 'b']);
    expect(lexed.redirects.map((t) => t.text)).toEqual(['> out.txt', '2>&1']);
  });

  it('>saida.txt ≡ > saida.txt, and the other redirection forms', () => {
    expect(lexSegment('x >saida.txt').redirects).toEqual(lexSegment('x > saida.txt').redirects.map((t) => ({ ...t, raw: '>saida.txt' })));
    const ops = (s: string): string[] => lexSegment(s).redirects.map((t) => t.redirect?.op ?? '');
    expect(ops('x >> a < b 2> c 2>&1 &> d 1> e')).toEqual(['>>', '<', '2>', '2>&1', '&>', '>']);
    expect(lexSegment('x 2>err.log').redirects[0]?.redirect).toEqual({ op: '2>', target: 'err.log' });
    expect(lexSegment('x>"a b"').redirects[0]?.redirect).toEqual({ op: '>', target: 'a b' });
    expect(texts('x 2>err')).toEqual(['x']);
  });

  it('keeps the display order with quotes', () => {
    expect(lexSegment('a "b c" >d e').display.map((t) => t.raw)).toEqual(['a', '"b c"', '>d', 'e']);
  });

  it('never throws on unbalanced input', () => {
    for (const s of ['"abc', "'abc", '$(abc', '${abc', '`abc', 'a\\', '>', '2>&', '&>']) {
      expect(() => lexSegment(s)).not.toThrow();
    }
    expect(texts('echo "unclosed text')).toEqual(['echo', 'unclosed text']);
  });
});
