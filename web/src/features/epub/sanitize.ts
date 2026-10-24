// Sanitizer of EPUB content (spec 18, docs/tecnico/foliate.md §Segurança). foliate-js shows each section in an
// iframe sandboxed with `allow-same-origin allow-scripts` (WebKit needs it for events), so a section document is
// same-origin with the app: anything active in it could reach the app's window. Every (X)HTML/SVG/CSS resource goes
// through here (the EPUB loader's `data` hook, see loader.ts) before foliate turns it into a blob: URL:
// - active elements are dropped (<script>, <iframe>, <frame>, <object>, <embed>, <applet>, <base>, <meta http-equiv>,
//   <link rel=import|preload|prefetch…>, <portal>, <template>, SVG <foreignObject> scripts…); in XML documents they
//   are replaced by an empty inert placeholder so the CFIs of the rest of the document stay the same;
// - every `on*` attribute, `srcdoc`, `ping` and `formaction`/`action` goes;
// - SVG <set>/<animate*> that target an href or an event attribute go;
// - javascript:/vbscript:/data:text/html (any non-image data:) URLs are neutralised in href/src/xlink:href/action…;
// - remote resources (http/https/ftp/file/ws… in src, srcset, poster, stylesheets, CSS url()/@import) are removed:
//   no network, no tracking. Plain <a href="https://…"> links stay: clicks are intercepted and confirmed (session.ts).
// The production CSP (no inline script) is the second layer.

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Elements removed wherever they are (any namespace, case-insensitive). */
const ACTIVE_ELEMENTS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'portal',
  'template',
  'noscript',
  'param',
  'handler',
  'listener',
]);

/** `<link rel>` values that fetch or execute something other than a stylesheet/icon of the book. */
const BAD_LINK_RELS =
  /\b(import|preload|prefetch|prerender|modulepreload|dns-prefetch|preconnect|serviceworker|manifest)\b/i;

/** Attributes holding a URL. */
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'background',
  'codebase',
  'cite',
  'longdesc',
  'usemap',
  'lowsrc',
  'dynsrc',
  'xml:base',
]);

/** Attributes that load a resource (as opposed to a link the reader clicks). */
const RESOURCE_ATTRS = new Set(['src', 'poster', 'data', 'background', 'lowsrc', 'dynsrc', 'codebase', 'longdesc']);

/** Removed outright. */
const DROP_ATTRS = new Set(['srcdoc', 'ping', 'formaction', 'action', 'xml:base', 'http-equiv']);

const SVG_ANIMATION = new Set(['set', 'animate', 'animatetransform', 'animatemotion', 'animatecolor']);

const REMOTE = /^\s*(?:https?|ftp|ftps|wss?|file|gopher|ldap|smb|jar|feed|ms-[\w-]+):/i;

/** Strips control/whitespace characters browsers ignore inside a URL scheme (`java\tscript:`). */
function normalizeUrl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase();
}

/** True for a URL that would run script or render arbitrary HTML when followed. */
export function isDangerousUrl(value: string): boolean {
  const v = normalizeUrl(value);
  // HTML entities are decoded by the parser before we see the attribute, so `&#106;avascript:` is caught here.
  if (/^(?:javascript|vbscript|livescript|mocha):/.test(v)) return true;
  if (v.startsWith('data:'))
    return !/^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|font\/|application\/(?:font|x-font))/.test(v);
  return false;
}

/** True for a URL that reaches the network (or the file system) instead of the book itself. */
export function isRemoteUrl(value: string): boolean {
  return REMOTE.test(value) || /^\s*\/\//.test(value);
}

/** Removes remote `url(…)` and `@import` from CSS (resources inside the book are blob: URLs by now). */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]*)\1\s*\)?[^;]*;?/gi, (m, _q, url: string) =>
      isRemoteUrl(url) || isDangerousUrl(url) ? '' : m,
    )
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, url: string) =>
      isRemoteUrl(url) || isDangerousUrl(url) ? 'url("")' : m,
    )
    .replace(/expression\s*\(/gi, 'invalid(')
    .replace(/-moz-binding\s*:/gi, 'invalid:')
    .replace(/behavior\s*:/gi, 'invalid:');
}

function srcsetIsSafe(value: string): boolean {
  return value.split(',').every((part) => {
    const url = part.trim().split(/\s+/)[0] ?? '';
    return !isRemoteUrl(url) && !isDangerousUrl(url);
  });
}

function placeholder(el: Element, xml: boolean): void {
  const doc = el.ownerDocument;
  if (!xml) {
    el.remove();
    return;
  }
  const inHead = !!el.closest('head');
  const ns = el.namespaceURI ?? XHTML_NS;
  // Same element count (so CFIs of the rest don't move), nothing active, nothing rendered.
  const repl = doc.createElementNS(
    ns === XHTML_NS ? XHTML_NS : ns,
    inHead ? 'meta' : ns === XHTML_NS ? 'span' : 'desc',
  );
  repl.setAttribute('data-leitor-removed', el.localName.toLowerCase());
  if (!inHead && ns === XHTML_NS) repl.setAttribute('hidden', '');
  el.replaceWith(repl);
}

export interface SanitizeReport {
  removedElements: number;
  removedAttributes: number;
}

/** Sanitizes a parsed document in place. `xml`: keep placeholders for removed elements (XHTML/SVG). */
export function sanitizeDocument(doc: Document, xml = true): SanitizeReport {
  const report: SanitizeReport = { removedElements: 0, removedAttributes: 0 };
  // Processing instructions other than xml-stylesheet (and remote xml-stylesheet ones) go.
  for (let node = doc.firstChild; node;) {
    const next = node.nextSibling;
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      const pi = node as ProcessingInstruction;
      const href = /href\s*=\s*['"]([^'"]*)['"]/i.exec(pi.data)?.[1] ?? '';
      if (pi.target !== 'xml-stylesheet' || isRemoteUrl(href) || isDangerousUrl(href)) {
        pi.remove();
        report.removedElements++;
      }
    }
    node = next;
  }
  const root = doc.documentElement;
  if (!root) return report;
  // Collect first: we replace elements while walking.
  const all = [root, ...Array.from(root.getElementsByTagName('*'))];
  for (const el of all) {
    if (!el.isConnected) continue;
    const name = el.localName.toLowerCase();
    if (ACTIVE_ELEMENTS.has(name)) {
      placeholder(el, xml);
      report.removedElements++;
      continue;
    }
    if (name === 'meta' && el.hasAttribute('http-equiv')) {
      placeholder(el, xml);
      report.removedElements++;
      continue;
    }
    if (name === 'link') {
      const rel = el.getAttribute('rel') ?? '';
      const href = el.getAttribute('href') ?? '';
      if (BAD_LINK_RELS.test(rel) || isRemoteUrl(href) || isDangerousUrl(href)) {
        placeholder(el, xml);
        report.removedElements++;
        continue;
      }
    }
    if (SVG_ANIMATION.has(name)) {
      const target = (el.getAttribute('attributeName') ?? '').toLowerCase();
      const values = `${el.getAttribute('to') ?? ''} ${el.getAttribute('values') ?? ''} ${el.getAttribute('from') ?? ''} ${el.getAttribute('by') ?? ''}`;
      if (
        /href$/.test(target) ||
        target.startsWith('on') ||
        el.hasAttribute('href') ||
        el.hasAttributeNS(XLINK_NS, 'href') ||
        /(?:javascript|vbscript|data):/i.test(values.replace(/\s+/g, ''))
      ) {
        placeholder(el, xml);
        report.removedElements++;
        continue;
      }
    }
    for (const attr of Array.from(el.attributes)) {
      const attrName = attr.name.toLowerCase();
      const local = attr.localName.toLowerCase();
      let drop = false;
      if (local.startsWith('on') || DROP_ATTRS.has(attrName) || DROP_ATTRS.has(local)) drop = true;
      else if (URL_ATTRS.has(local) || local.endsWith('href') || attr.namespaceURI === XLINK_NS) {
        const value = attr.value;
        if (isDangerousUrl(value)) drop = true;
        // Remote resources never load; remote links (<a href>) stay and are confirmed on click.
        else if (isRemoteUrl(value) && (RESOURCE_ATTRS.has(local) || !isLinkElement(el, local))) drop = true;
      } else if (local === 'srcset' || local === 'imagesrcset') {
        if (!srcsetIsSafe(attr.value)) drop = true;
      } else if (local === 'style') {
        const css = sanitizeCss(attr.value);
        if (css !== attr.value) attr.value = css;
      } else if (local === 'target' && name !== 'a') {
        drop = true;
      }
      if (drop) {
        el.removeAttributeNode(attr);
        report.removedAttributes++;
      }
    }
    if (name === 'style' && el.textContent) {
      const css = sanitizeCss(el.textContent);
      if (css !== el.textContent) el.textContent = css;
    }
    if (name === 'form') {
      // Forms never submit: no action, no method.
      el.removeAttribute('method');
    }
  }
  return report;
}

/** `<a href>`/`<area href>` (and SVG <a xlink:href>): links the reader clicks, not resources. */
function isLinkElement(el: Element, attr: string): boolean {
  const name = el.localName.toLowerCase();
  return (name === 'a' || name === 'area') && attr.endsWith('href');
}

const XML_TYPES = new Set(['application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml']);

/** An empty but valid document of `type`, used when the original can't be parsed safely. */
function emptyDocument(type: string): string {
  if (type === 'image/svg+xml') return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  if (XML_TYPES.has(type))
    return '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title></title></head><body></body></html>';
  return '<!DOCTYPE html><html><head><title></title></head><body></body></html>';
}

/**
 * Sanitizes a resource of the book before foliate loads it. (X)HTML and SVG are parsed, cleaned and serialized
 * again; CSS gets its remote URLs removed; other types pass through unchanged.
 */
export function sanitizeMarkup(markup: string, type: string): string {
  if (type === 'text/css') return sanitizeCss(markup);
  const xml = XML_TYPES.has(type);
  if (!xml && type !== 'text/html') return markup;
  try {
    const doc = new DOMParser().parseFromString(markup, xml ? (type as DOMParserSupportedType) : 'text/html');
    if (xml && doc.getElementsByTagName('parsererror').length) return emptyDocument(type);
    sanitizeDocument(doc, xml);
    if (xml) return new XMLSerializer().serializeToString(doc);
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  } catch {
    return emptyDocument(type);
  }
}

/** Media types the loader must never let through as a resource of its own. */
export function isScriptType(type: string): boolean {
  return /(?:java|ecma)script|^text\/(?:x-)?(?:vbscript|livescript)|^application\/(?:x-)?(?:wasm|shockwave)/i.test(
    type,
  );
}
