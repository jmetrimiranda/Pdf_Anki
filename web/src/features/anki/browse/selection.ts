// Row selection of the card table, as in a file manager: click, Ctrl/Cmd-click, Shift-click ranges,
// Ctrl+A and arrow keys. Rows are indexes into the search result; the selection itself is a set of indexes.

export interface Selection {
  /** Selected row indexes. */
  selected: ReadonlySet<number>;
  /** Row with the keyboard focus (and the side editor), or -1. */
  focus: number;
  /** Start of Shift ranges. */
  anchor: number;
}

export const emptySelection: Selection = { selected: new Set(), focus: -1, anchor: -1 };

export interface Modifiers {
  shift?: boolean;
  /** Ctrl on Linux/Windows, Cmd on macOS. */
  toggle?: boolean;
}

function range(a: number, b: number): number[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
}

/** A click on row `i`. */
export function clickRow(sel: Selection, i: number, mods: Modifiers = {}): Selection {
  if (mods.shift && sel.anchor >= 0) {
    const set = new Set(mods.toggle ? sel.selected : []);
    for (const k of range(sel.anchor, i)) set.add(k);
    return { selected: set, focus: i, anchor: sel.anchor };
  }
  if (mods.toggle) {
    const set = new Set(sel.selected);
    if (set.has(i)) set.delete(i);
    else set.add(i);
    return { selected: set, focus: i, anchor: i };
  }
  return { selected: new Set([i]), focus: i, anchor: i };
}

/** Arrow/Home/End/PageUp/PageDown: moves the focus by `delta` (clamped); Shift extends from the anchor. */
export function moveFocus(sel: Selection, delta: number, count: number, mods: Modifiers = {}): Selection {
  if (count === 0) return emptySelection;
  const from = sel.focus < 0 ? (delta > 0 ? -1 : count) : sel.focus;
  const i = Math.min(count - 1, Math.max(0, from + delta));
  if (mods.shift) {
    const anchor = sel.anchor >= 0 ? sel.anchor : i;
    return { selected: new Set(range(anchor, i)), focus: i, anchor };
  }
  return { selected: new Set([i]), focus: i, anchor: i };
}

export function selectAll(sel: Selection, count: number): Selection {
  if (count === 0) return emptySelection;
  return {
    selected: new Set(range(0, count - 1)),
    focus: sel.focus >= 0 ? sel.focus : 0,
    anchor: sel.anchor >= 0 ? sel.anchor : 0,
  };
}

/** Keeps the rows that still exist after a new search with `count` results. */
export function clampSelection(sel: Selection, count: number): Selection {
  const selected = new Set([...sel.selected].filter((i) => i < count));
  const focus = sel.focus < count ? sel.focus : -1;
  return { selected, focus, anchor: sel.anchor < count ? sel.anchor : focus };
}

/** Selected indexes in ascending order. */
export function selectedIndexes(sel: Selection): number[] {
  return [...sel.selected].sort((a, b) => a - b);
}
