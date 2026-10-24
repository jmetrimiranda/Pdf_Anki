import { describe, expect, it } from 'vitest';
import { findVocabRanges, formIndex, matchWords, normalizeWord, wordSpans, type EpubVocabWord } from './vocab';

const word = (form: string, color = '#d85a30'): EpubVocabWord => ({ form, lemma: form, status: 'unknown', color });

describe('EPUB vocabulary marks', () => {
  it('normalises case and apostrophes', () => {
    expect(normalizeWord('Don’t')).toBe("don't");
    expect(normalizeWord('TRAVELLER‘S')).toBe("traveller's");
  });

  it('segments words with their offsets', () => {
    const spans = wordSpans('The Time-Traveller’s eyes, 42 of them.');
    expect(spans.map((s) => s.word)).toEqual(['The', 'Time', 'Traveller’s', 'eyes', '42', 'of', 'them']);
    expect(spans[2]).toMatchObject({ start: 9, end: 20 });
  });

  it('matches forms ignoring case and apostrophe style; a possessive marks its stem', () => {
    const forms = formIndex([word('recondite'), word("don't", '#ba7517'), word('traveller')]);
    const text = 'A Recondite matter. I don’t know. The Traveller’s eyes; travellers.';
    const hits = matchWords(text, forms);
    expect(hits.map((h) => text.slice(h.start, h.end))).toEqual(['Recondite', 'don’t', 'Traveller']);
    expect(hits[1]!.word.color).toBe('#ba7517');
  });

  it('respects the limit', () => {
    const forms = formIndex([word('a')]);
    expect(matchWords('a a a a a', forms, 3)).toHaveLength(3);
  });

  it('finds ranges in the body, skipping scripts, styles and SVG', () => {
    const doc = new DOMParser().parseFromString(
      '<html><head><title>recondite</title></head><body><p>A <i>recondite</i> matter, recondite.</p><style>.recondite{}</style><svg><text>recondite</text></svg></body></html>',
      'text/html',
    );
    const ranges = findVocabRanges(doc, [word('recondite')]);
    expect(ranges).toHaveLength(2);
    expect(ranges.every((r) => r.range.toString() === 'recondite')).toBe(true);
    expect(findVocabRanges(doc, [word('recondite')], 1)).toHaveLength(1);
    expect(findVocabRanges(doc, [])).toHaveLength(0);
  });
});
