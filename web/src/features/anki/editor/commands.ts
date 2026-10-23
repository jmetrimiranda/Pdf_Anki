// Editing commands of the rich field (a contenteditable): code, cloze, inserting sanitized content and images.
import { CLOZE_CLOSE, clozeOpen } from './cloze';
import { MEDIA_ATTR } from './sanitize';

/** The selection's range when it lies inside `root`. */
export function rangeIn(root: HTMLElement): Range | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

/** A range at the end of `root` (when the field has no caret yet). */
export function endRange(root: HTMLElement): Range {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

function select(range: Range): void {
  const sel = range.startContainer.ownerDocument?.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Wraps the selection in `{{cN::…}}`; with nothing selected, leaves the caret inside the new cloze. */
export function wrapCloze(root: HTMLElement, n: number): void {
  const range = rangeIn(root) ?? endRange(root);
  const doc = root.ownerDocument;
  const after = doc.createRange();
  if (range.collapsed) {
    // One text node with the caret at an offset inside it: a caret between two adjacent text nodes is not kept
    // by every engine (WebKit moves it after the closing braces).
    const node = doc.createTextNode(clozeOpen(n) + CLOZE_CLOSE);
    range.insertNode(node);
    after.setStart(node, clozeOpen(n).length);
    after.collapse(true);
  } else {
    const open = doc.createTextNode(clozeOpen(n));
    const close = doc.createTextNode(CLOZE_CLOSE);
    const end = range.cloneRange();
    end.collapse(false);
    end.insertNode(close);
    range.collapse(true);
    range.insertNode(open);
    after.setStartAfter(open);
    after.setEndBefore(close);
  }
  select(after);
}

/** Placeholder that gives an empty <code> a caret position; removed on save. */
export const ZWSP = '\u200b';

/** Wraps the selection in <code> (or inserts an empty one with the caret inside). */
export function wrapCode(root: HTMLElement): void {
  const range = rangeIn(root) ?? endRange(root);
  const doc = root.ownerDocument;
  const code = doc.createElement('code');
  if (range.collapsed) code.appendChild(doc.createTextNode(ZWSP));
  else code.appendChild(range.extractContents());
  range.insertNode(code);
  const after = doc.createRange();
  after.selectNodeContents(code);
  if (code.textContent === ZWSP) after.collapse(false);
  select(after);
}

/** Replaces the selection (or `at`) with `node` and puts the caret after it. */
export function insertNodeAt(root: HTMLElement, node: Node, at?: Range | null): void {
  const range = at && root.contains(at.commonAncestorContainer) ? at : (rangeIn(root) ?? endRange(root));
  range.deleteContents();
  const last = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node.lastChild : node;
  range.insertNode(node);
  if (last) {
    const after = root.ownerDocument.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    select(after);
  }
}

/** An <img> for a media file: the field stores the name URL-encoded (as Anki's editor does), `url` is shown. */
export function mediaImage(doc: Document, name: string, url: string): HTMLImageElement {
  const img = doc.createElement('img');
  img.setAttribute(MEDIA_ATTR, encodeURIComponent(name));
  img.setAttribute('src', url);
  return img;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export function isImageFile(file: File): boolean {
  return file.type in MIME_EXT;
}

/** Name for a pasted image: the file's own name, unless it is the browser's generic "image.png". */
export function pastedImageName(file: File, now = Date.now()): string {
  const ext = MIME_EXT[file.type] ?? 'png';
  const generic = !file.name || /^image\.\w+$/i.test(file.name);
  if (!generic) return file.name;
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `colado-${stamp}.${ext}`;
}
