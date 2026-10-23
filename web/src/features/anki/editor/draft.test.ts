import { describe, expect, it } from 'vitest';
import { draftFields, editField, isDirty, markSaved, newDraft, setTags } from './draft';

describe('note draft (dirty tracking)', () => {
  const original = ['<p onclick="x">Front with <font color=red>legacy</font> HTML</p>', '<div>Back</div>', 'Fonte'];

  it('keeps fields the user did not edit verbatim', () => {
    let d = newDraft(original, ['a']);
    expect(isDirty(d)).toBe(false);
    d = editField(d, 1, 'New back');
    expect(isDirty(d)).toBe(true);
    expect(draftFields(d)).toEqual([original[0], 'New back', original[2]]);
  });

  it('an edit back to the original is not dirty', () => {
    const d = editField(newDraft(original), 2, 'Fonte');
    expect(isDirty(d)).toBe(false);
  });

  it('tracks tags and the saved state', () => {
    let d = setTags(newDraft(original, ['a']), ['a', 'b']);
    expect(isDirty(d)).toBe(true);
    d = markSaved(editField(d, 0, 'x'));
    expect(isDirty(d)).toBe(false);
    expect(d.original[0]).toBe('x');
    expect(d.originalTags).toEqual(['a', 'b']);
  });
});
