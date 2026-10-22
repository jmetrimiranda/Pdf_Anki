import { describe, expect, it } from 'vitest';
import { ptBR, t } from './index';

const files = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('i18n', () => {
  it('has every key referenced in the source', () => {
    const used = new Set<string>();
    for (const text of Object.values(files)) {
      for (const m of text.matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1]!);
      for (const m of text.matchAll(/label: '([a-z]+\.[\w.]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used].filter((k) => !(k in ptBR));
    expect(missing).toEqual([]);
  });

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(ptBR)) expect(value.trim(), key).not.toBe('');
  });

  it('fills placeholders', () => {
    expect(t('tabs.close', { title: 'Livro' })).toBe('Fechar Livro');
    expect(t('reader.pageOf', { n: 3, total: 10 })).toBe('3 / 10');
  });
});
