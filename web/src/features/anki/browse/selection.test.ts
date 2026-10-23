import { describe, expect, it } from 'vitest';
import { clampSelection, clickRow, emptySelection, moveFocus, selectAll, selectedIndexes } from './selection';

const sorted = (s: { selected: ReadonlySet<number> }) => [...s.selected].sort((a, b) => a - b);

describe('browser selection', () => {
  it('click selects one row', () => {
    const s = clickRow(clickRow(emptySelection, 3), 5);
    expect(sorted(s)).toEqual([5]);
    expect(s.focus).toBe(5);
    expect(s.anchor).toBe(5);
  });

  it('Ctrl/Cmd-click toggles rows', () => {
    let s = clickRow(emptySelection, 2);
    s = clickRow(s, 6, { toggle: true });
    s = clickRow(s, 9, { toggle: true });
    expect(sorted(s)).toEqual([2, 6, 9]);
    s = clickRow(s, 6, { toggle: true });
    expect(sorted(s)).toEqual([2, 9]);
  });

  it('Shift-click selects a range from the anchor, either direction', () => {
    let s = clickRow(emptySelection, 4);
    s = clickRow(s, 7, { shift: true });
    expect(sorted(s)).toEqual([4, 5, 6, 7]);
    s = clickRow(s, 2, { shift: true });
    expect(sorted(s)).toEqual([2, 3, 4]);
    expect(s.anchor).toBe(4);
  });

  it('Ctrl+Shift-click adds a range to the selection', () => {
    let s = clickRow(emptySelection, 0);
    s = clickRow(s, 5, { toggle: true });
    s = clickRow(s, 7, { shift: true, toggle: true });
    expect(sorted(s)).toEqual([0, 5, 6, 7]);
  });

  it('arrow keys move, Shift+arrows extend, clamped to the table', () => {
    let s = moveFocus(emptySelection, 1, 10);
    expect(sorted(s)).toEqual([0]);
    s = moveFocus(s, 1, 10, { shift: true });
    s = moveFocus(s, 1, 10, { shift: true });
    expect(sorted(s)).toEqual([0, 1, 2]);
    s = moveFocus(s, 100, 10);
    expect(sorted(s)).toEqual([9]);
    s = moveFocus(s, -100, 10);
    expect(s.focus).toBe(0);
    expect(moveFocus(emptySelection, -1, 10).focus).toBe(9);
    expect(moveFocus(s, 1, 0)).toEqual(emptySelection);
  });

  it('Ctrl+A selects everything, and results that shrink clamp it', () => {
    const s = selectAll(clickRow(emptySelection, 3), 6);
    expect(selectedIndexes(s)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.focus).toBe(3);
    const c = clampSelection(s, 2);
    expect(selectedIndexes(c)).toEqual([0, 1]);
    expect(c.focus).toBe(-1);
  });
});
