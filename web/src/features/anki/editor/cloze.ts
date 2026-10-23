// Cloze numbering for the editor (Ctrl+Shift+C / Ctrl+Shift+Alt+C), as in Anki's editor.

/** Highest cloze number used in any of the fields (0 when there is none). */
export function maxClozeNumber(fields: readonly string[]): number {
  let max = 0;
  for (const f of fields) for (const m of f.matchAll(/\{\{c(\d+)::/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Number for a new cloze: max + 1, or the current max (at least 1) when `reuse` (the Alt variant). */
export function nextClozeNumber(fields: readonly string[], reuse: boolean): number {
  const max = maxClozeNumber(fields);
  return reuse ? Math.max(1, max) : max + 1;
}

export function clozeOpen(n: number): string {
  return `{{c${n}::`;
}

export const CLOZE_CLOSE = '}}';
