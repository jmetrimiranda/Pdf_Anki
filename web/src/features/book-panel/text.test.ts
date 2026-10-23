import { describe, expect, it } from 'vitest';
import type { PageWords } from '../../lib/core/types';
import { codeText, exampleSentence, previewLine, proseText, proseToHtml, singleWord } from './text';

function page(text: string): PageWords {
  const words = [...text.matchAll(/\S+/g)].map((m, index) => ({
    index,
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
    rects: [[m.index * 5, 100, m[0].length * 5, 12] as [number, number, number, number]],
  }));
  return { page: 0, width: 600, height: 800, text, words };
}

describe('proseText', () => {
  it('collapses PDF line breaks and joins hyphenated words', () => {
    expect(proseText('  The wind-\nmill was\n  built\tagain. ')).toBe('The windmill was built again.');
    expect(proseText('well-known\nfact')).toBe('well-known fact');
  });
});

describe('codeText', () => {
  it('keeps line breaks and indentation', () => {
    expect(codeText('\r\nros2 run demo talker  \r\n  --ros-args\n\n')).toBe('ros2 run demo talker\n  --ros-args');
  });
});

describe('proseToHtml', () => {
  it('escapes and keeps typed line breaks', () => {
    expect(proseToHtml('a < b\nc & d')).toBe('a &lt; b<br>c &amp; d');
  });
});

describe('singleWord', () => {
  it('accepts one word with surrounding punctuation', () => {
    expect(singleWord(' “Animals,” ')).toBe('Animals');
    expect(singleWord("don't")).toBe("don't");
    expect(singleWord('well-known.')).toBe('well-known');
  });

  it('rejects several words, digits and empty text', () => {
    expect(singleWord('two words')).toBeNull();
    expect(singleWord('1984')).toBeNull();
    expect(singleWord('well--known')).toBeNull();
    expect(singleWord('line\nbreak')).toBeNull();
    expect(singleWord(' ... ')).toBeNull();
    expect(singleWord('x'.repeat(65))).toBeNull();
    expect(singleWord('(Boxer)')).toBe('Boxer');
    expect(singleWord('ação')).toBe('ação');
  });
});

describe('exampleSentence', () => {
  const text = 'Mr. Jones was drunk. All animals are equal! The pigs said so. Other animals agreed.';
  it('takes the sentence of the selected occurrence and bolds the word', () => {
    const p = page(text);
    const second = p.words.find((w) => w.text === 'animals' && w.start > 50)!;
    expect(exampleSentence(p, 'animals', second.rects)).toBe('Other <b>animals</b> agreed.');
    expect(exampleSentence(p, 'animals', [])).toBe('All <b>animals</b> are equal!');
  });

  it('falls back to the word', () => {
    expect(exampleSentence(null, 'windmill', [])).toBe('<b>windmill</b>');
    expect(exampleSentence(page('nothing here'), 'windmill', [])).toBe('<b>windmill</b>');
  });

  it('cuts very long sentences around the word', () => {
    const long = `${'word '.repeat(200)}target ${'more '.repeat(200)}`;
    const html = exampleSentence(page(long), 'target', []);
    expect(html).toContain('<b>target</b>');
    expect(html.length).toBeLessThan(360);
    expect(html.startsWith('…')).toBe(true);
    expect(html.endsWith('…')).toBe(true);
  });
});

describe('previewLine', () => {
  it('cuts with an ellipsis', () => {
    expect(previewLine('a\nb')).toBe('a b');
    expect(previewLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
