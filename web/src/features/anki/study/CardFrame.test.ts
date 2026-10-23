import { describe, expect, it } from 'vitest';
import { parseCardMessage } from './CardFrame';

describe('parseCardMessage', () => {
  it('accepts the shim messages', () => {
    expect(parseCardMessage({ t: 'ready' })).toEqual({ t: 'ready' });
    expect(parseCardMessage({ t: 'shown', extra: 1 })).toEqual({ t: 'shown' });
    expect(parseCardMessage({ t: 'pycmd', cmd: 'ease3', id: 0 })).toEqual({ t: 'pycmd', cmd: 'ease3', id: 0 });
    expect(parseCardMessage({ t: 'typed', v: 'abc' })).toEqual({ t: 'typed', v: 'abc' });
    expect(parseCardMessage({ t: 'link', href: 'leitor://livro/x' })).toEqual({ t: 'link', href: 'leitor://livro/x' });
    expect(
      parseCardMessage({ t: 'key', key: '1', code: 'Digit1', ctrl: false, shift: false, alt: true, meta: false }),
    ).toEqual({ t: 'key', key: '1', code: 'Digit1', ctrl: false, shift: false, alt: true, meta: false });
  });

  it('rejects anything else', () => {
    for (const bad of [
      null,
      'ready',
      { t: 'eval', js: 'x' },
      { t: 'pycmd', cmd: 1, id: 0 },
      { t: 'pycmd', cmd: 'x', id: 1.5 },
      { t: 'pycmd', cmd: 'x'.repeat(3000), id: 0 },
      { t: 'typed', v: 5 },
      { t: 'key', key: 'a', ctrl: 'yes', shift: false, alt: false, meta: false },
      { t: 'link' },
    ]) {
      expect(parseCardMessage(bad)).toBeNull();
    }
  });
});
