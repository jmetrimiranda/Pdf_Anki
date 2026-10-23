// Field HTML from decks and the clipboard is UNTRUSTED: the main UI origin can call the core (`invoke`).
// It reaches the DOM only through `sanitizeToFragment`, which parses it in an inert document (DOMParser: no
// scripts run, nothing loads) and copies over only an allowlist of elements and attributes. All the work happens in
// documents without a browsing context, so not even an <img> is fetched before its URL is rewritten for display.

/** Elements kept (with their allowed attributes). */
const ALLOWED: Record<string, readonly string[]> = {
  b: [],
  i: [],
  u: [],
  s: [],
  strong: [],
  em: [],
  code: [],
  pre: [],
  br: [],
  hr: [],
  div: [],
  p: [],
  span: [],
  sub: [],
  sup: [],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
};

/** Removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'svg',
  'math',
  'link',
  'meta',
  'base',
  'head',
  'title',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'portal',
  'xmp',
  'plaintext',
]);

/** Attributes every allowed element may keep (inline formatting from Anki's editor). */
const GLOBAL_ATTRS = ['style', 'class', 'dir'];

const SAFE_LINK = /^(https?:|leitor:)/i;
// Media file names (relative), http(s) images. No javascript:, data:, blob:, file: or protocol-relative URLs.
const UNSAFE_IMG = /^\s*([a-z][a-z0-9+.-]*:|\/\/)/i;

function safeStyle(style: string): string | null {
  // url() can fetch from anywhere, expression()/behavior are old IE script hooks, @import loads sheets.
  if (/url\s*\(|expression\s*\(|behavior\s*:|-moz-binding|@import|javascript:|\\/i.test(style)) return null;
  return style;
}

function safeAttr(tag: string, name: string, value: string): string | null {
  if (name === 'style') return safeStyle(value);
  if (name === 'class') return value.replace(/[^\w\s-]/g, '');
  if (name === 'dir') return /^(ltr|rtl|auto)$/i.test(value) ? value : null;
  if (tag === 'a' && name === 'href') return SAFE_LINK.test(value.trim()) ? value.trim() : null;
  if (tag === 'img' && name === 'src') {
    const v = value.trim();
    if (!v) return null;
    if (/^https?:/i.test(v)) return v;
    return UNSAFE_IMG.test(v) ? null : v;
  }
  if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan')
    return /^\d{1,4}(px|%)?$/.test(value.trim()) ? value.trim() : null;
  if (name === 'alt') return value;
  return null;
}

function copyChildren(from: Node, to: Node, doc: Document): void {
  for (const child of Array.from(from.childNodes)) {
    const out = sanitizeNode(child, doc);
    if (out) to.appendChild(out);
  }
}

function sanitizeNode(node: Node, doc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return null; // comments, processing instructions…
  const el = node as Element;
  const tag = el.localName.toLowerCase();
  if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROP_WITH_CONTENT.has(tag)) return null;
  const allowed = ALLOWED[tag];
  if (!allowed) {
    // Unknown/unsafe wrapper (font, h1, section…): keep its content only.
    const frag = doc.createDocumentFragment();
    copyChildren(el, frag, doc);
    return frag;
  }
  const out = doc.createElement(tag);
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!allowed.includes(name) && !GLOBAL_ATTRS.includes(name)) continue;
    const value = safeAttr(tag, name, attr.value);
    if (value !== null && value !== '') out.setAttribute(name, value);
  }
  if (tag === 'img' && !out.hasAttribute('src')) return null;
  copyChildren(el, out, doc);
  return out;
}

let inertDoc: Document | null = null;

/** A document without a browsing context: elements created in it never load anything. */
export function inertDocument(): Document {
  inertDoc ??= document.implementation.createHTMLDocument('');
  return inertDoc;
}

/** Parses untrusted HTML in an inert document and returns a clean fragment owned by `doc` (inert by default). */
export function sanitizeToFragment(html: string, doc: Document = inertDocument()): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const frag = doc.createDocumentFragment();
  copyChildren(parsed.body, frag, doc);
  return frag;
}

/** Same as `sanitizeToFragment`, serialized. */
export function sanitizeHtml(html: string): string {
  const box = inertDocument().createElement('div');
  box.appendChild(sanitizeToFragment(html));
  return box.innerHTML;
}

/** Text of untrusted HTML (for previews), without ever putting it in the live DOM. */
export function htmlToText(html: string): string {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  for (const el of Array.from(parsed.body.querySelectorAll('script,style,template'))) el.remove();
  return (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- media names in the editor

/** Marks images whose `src` was rewritten for display; the bare file name is restored on save. */
export const MEDIA_ATTR = 'data-anki-src';

function isMediaName(src: string): boolean {
  return !!src && !UNSAFE_IMG.test(src);
}

/** For display: `<img src="name.png">` → the media URL, keeping the name in `data-anki-src`. Remote images are not
 *  fetched from the app's origin: they keep their URL in `data-anki-src` and show only their alt text. */
export function rewriteMediaForDisplay(root: ParentNode, mediaUrl: (name: string) => string): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.hasAttribute(MEDIA_ATTR)) continue;
    const src = img.getAttribute('src') ?? '';
    if (/^https?:/i.test(src)) {
      img.setAttribute(MEDIA_ATTR, src);
      img.removeAttribute('src');
      continue;
    }
    if (!isMediaName(src)) continue;
    let name = src;
    try {
      name = decodeURIComponent(src);
    } catch {
      // Not percent-encoded: Anki stores the raw name.
    }
    img.setAttribute(MEDIA_ATTR, src);
    img.setAttribute('src', mediaUrl(name));
  }
}

/** For saving: puts the stored names back. Works on a clone, never on the live editor. */
export function restoreMediaNames(root: ParentNode): void {
  for (const img of Array.from(root.querySelectorAll(`img[${MEDIA_ATTR}]`))) {
    img.setAttribute('src', img.getAttribute(MEDIA_ATTR) ?? '');
    img.removeAttribute(MEDIA_ATTR);
  }
}

/** Untrusted field HTML → sanitized fragment ready for the editor (media shown through `mediaUrl`). */
export function fieldToEditorFragment(html: string, mediaUrl: (name: string) => string): DocumentFragment {
  const frag = sanitizeToFragment(html);
  rewriteMediaForDisplay(frag, mediaUrl);
  // Only now, with display URLs in place, does the content enter the live document.
  return document.importNode(frag, true);
}

/** The editor's DOM → field HTML (sanitized again, stored media names restored). */
export function editorToFieldHtml(editor: HTMLElement): string {
  const inert = inertDocument();
  const box = inert.createElement('div');
  for (const child of Array.from(editor.childNodes)) box.appendChild(inert.importNode(child, true));
  restoreMediaNames(box);
  const clean = sanitizeHtml(box.innerHTML).replace(/\u200b/g, '');
  // A field the user emptied keeps the browser's placeholder <br>: store it as empty.
  return /^(\s|<br\s*\/?>|&nbsp;)*$/i.test(clean) ? '' : clean;
}
