import { describe, expect, it } from 'vitest';
import { maxClozeNumber, nextClozeNumber } from './cloze';
import { wrapCloze } from './commands';

function editorWith(html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe('cloze numbering', () => {
  it('uses max + 1, or the current max with Alt', () => {
    expect(maxClozeNumber(['no cloze'])).toBe(0);
    expect(nextClozeNumber(['no cloze'], false)).toBe(1);
    expect(nextClozeNumber(['no cloze'], true)).toBe(1);
    const fields = ['{{c1::a}} {{c3::b}}', 'extra {{c2::c}}'];
    expect(nextClozeNumber(fields, false)).toBe(4);
    expect(nextClozeNumber(fields, true)).toBe(3);
  });

  it('wraps the selection (Ctrl+Shift+C)', () => {
    const el = editorWith('O verbo concorda');
    selectText(el.firstChild!, 2, 7);
    wrapCloze(el, 1);
    expect(el.innerHTML).toBe('O {{c1::verbo}} concorda');
    el.remove();
  });

  it('inserts an empty cloze at the caret', () => {
    const el = editorWith('abc');
    selectText(el.firstChild!, 3, 3);
    wrapCloze(el, 2);
    expect(el.textContent).toBe('abc{{c2::}}');
    el.remove();
  });
});
