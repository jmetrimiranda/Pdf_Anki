import { describe, expect, it } from 'vitest';
import { DEFAULT_COLOR, drawHighlight, drawUnderline, normalizeColor, SWATCHES } from './palette';

// PdfCraft's palette, read from the pinned fork (read-only) when the submodule is checked out.
const sources = import.meta.glob<string>('../../../../third_party/pdfcraft/crates/ui-egui/src/comments.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const EXPECTED: [string, number[]][] = [
  ['Yellow', [1.0, 0.94, 0.0]],
  ['Orange', [1.0, 0.54, 0.0]],
  ['Red', [0.89, 0.13, 0.13]],
  ['Pink', [1.0, 0.37, 0.64]],
  ['Purple', [0.54, 0.25, 0.82]],
  ['Blue', [0.0, 0.47, 0.84]],
  ['Light blue', [0.36, 0.75, 0.98]],
  ['Green', [0.18, 0.62, 0.36]],
  ['Gray', [0.5, 0.5, 0.5]],
  ['Black', [0.0, 0.0, 0.0]],
];

function swatchesFromRust(src: string): [string, number[]][] {
  const block = /pub const SWATCHES[^=]*=\s*\[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
  return Array.from(block.matchAll(/\("([^"]+)",\s*\[([^\]]+)\]\)/g), (m) => [
    m[1]!,
    m[2]!.split(',').map((x) => Number(x.trim())),
  ]);
}

describe('EPUB highlight palette (PdfCraft look)', () => {
  it('equals PdfCraft SWATCHES, in order', () => {
    const fromRust = Object.values(sources)[0];
    const expected = fromRust ? swatchesFromRust(fromRust) : EXPECTED;
    expect(expected).toHaveLength(10);
    expect(SWATCHES.map((s) => [s.name, [...s.rgb]])).toEqual(expected);
  });

  it('defaults to Yellow #fff000 and stores #rrggbb', () => {
    expect(DEFAULT_COLOR).toBe('#fff000');
    expect(SWATCHES.map((s) => s.hex)).toEqual([
      '#fff000',
      '#ff8a00',
      '#e32121',
      '#ff5ea3',
      '#8a40d1',
      '#0078d6',
      '#5cbffa',
      '#2e9e5c',
      '#808080',
      '#000000',
    ]);
    expect(normalizeColor('#ABCDEF')).toBe('#abcdef');
    expect(normalizeColor('red')).toBe(DEFAULT_COLOR);
    expect(normalizeColor(null)).toBe(DEFAULT_COLOR);
  });

  it('draws highlights with Multiply (translucent on dark pages), notes with the icon, 2 px underlines', () => {
    const rects = [new DOMRect(10, 20, 100, 16), new DOMRect(10, 40, 50, 16)];
    const hl = drawHighlight(rects, { color: '#fff000' });
    const fills = hl.firstElementChild as SVGGElement;
    expect(hl.getAttribute('fill')).toBe('#fff000');
    expect(fills.style.mixBlendMode).toBe('multiply');
    expect(fills.style.opacity).toBe('1');
    expect(fills.querySelectorAll('rect')).toHaveLength(2);
    expect(hl.querySelector('[data-note-icon]')).toBeNull();

    const dark = drawHighlight(rects, { color: '#fff000', dark: true }).firstElementChild as SVGGElement;
    expect(dark.style.mixBlendMode).toBe('normal');
    expect(Number(dark.style.opacity)).toBeLessThan(1);

    const note = drawHighlight(rects, { color: '#0078d6', note: true });
    expect(note.getAttribute('data-kind')).toBe('note');
    expect(note.querySelector('[data-note-icon]')).not.toBeNull();

    const ul = drawUnderline(rects, { color: '#d85a30' });
    const lines = Array.from(ul.querySelectorAll('rect'));
    expect(lines.map((r) => r.getAttribute('height'))).toEqual(['2', '2']);
    expect(lines[0]!.getAttribute('y')).toBe('34');
  });
});
