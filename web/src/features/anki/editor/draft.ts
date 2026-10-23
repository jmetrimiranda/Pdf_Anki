// Dirty tracking of a note being edited. Field HTML from a deck is shown sanitized, so writing the editor's DOM
// back would silently rewrite fields the user never touched: only fields the user edited are taken from the editor,
// every other field is saved exactly as it was loaded.

export interface Draft {
  /** Fields as loaded (or as left by the last add). */
  original: readonly string[];
  /** Field index → HTML from the editor, only for fields the user edited. */
  edits: ReadonlyMap<number, string>;
  tags: readonly string[];
  originalTags: readonly string[];
}

export function newDraft(fields: readonly string[], tags: readonly string[] = []): Draft {
  return { original: [...fields], edits: new Map(), tags: [...tags], originalTags: [...tags] };
}

export function editField(d: Draft, index: number, html: string): Draft {
  const edits = new Map(d.edits);
  edits.set(index, html);
  return { ...d, edits };
}

export function setTags(d: Draft, tags: readonly string[]): Draft {
  return { ...d, tags: [...tags] };
}

/** Fields to save: edited ones from the editor, the rest verbatim. */
export function draftFields(d: Draft): string[] {
  return d.original.map((html, i) => (d.edits.has(i) ? d.edits.get(i)! : html));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Something would change on save. */
export function isDirty(d: Draft): boolean {
  if (!sameList(d.tags, d.originalTags)) return true;
  for (const [i, html] of d.edits) if (html !== d.original[i]) return true;
  return false;
}

/** After a successful save: what was saved becomes the new original. */
export function markSaved(d: Draft): Draft {
  return { original: draftFields(d), edits: new Map(), tags: [...d.tags], originalTags: [...d.tags] };
}
