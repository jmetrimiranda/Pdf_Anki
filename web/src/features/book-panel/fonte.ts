// The `Fonte` field of cards made from a selection (spec 10.2): "Animal Farm, p. 37" linking back to the book with
// `leitor://livro/<book_uid>?pagina=N&q=<trecho>`, or for an EPUB (spec 7.1) "The Time Machine, Chapter III" with
// `?cap=N&cfi=<CFI>&q=<trecho>`. The core has the same builders (core-anki `source_html`/`source_html_section`) with
// the same literal tests, and features/anki/study/links.ts parses what this writes.

/** Longest `q` in a Fonte link (characters). */
export const FONTE_QUERY_MAX = 80;
/** Longest chapter label (the TOC title) in an EPUB Fonte (characters). */
export const FONTE_LABEL_MAX = 60;

/** HTML-escapes text for a field or an attribute (`&`, `<`, `>`, `"`). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The search text of a Fonte link: whitespace collapsed, cut at a word boundary to at most 80 characters (a single
 * longer word is cut at 80); empty when there is nothing to search.
 */
export function fonteQuery(text: string): string {
  return cutAtWord(text, FONTE_QUERY_MAX);
}

/** Whitespace collapsed and trimmed, cut at a word boundary to at most `max` characters (one long word is hard-cut). */
function cutAtWord(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  // The next character is a space: the first `max` end exactly at a word boundary.
  if (chars[max] === ' ') return chars.slice(0, max).join('');
  const head = chars.slice(0, max).join('');
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trim();
}

/** The chapter part of an EPUB Fonte: the TOC label cut at 60 characters at a word boundary, else `cap. N`. */
export function sectionLabel(tocLabel: string | null | undefined, section1: number): string {
  return cutAtWord(tocLabel ?? '', FONTE_LABEL_MAX) || `cap. ${section1}`;
}

/**
 * The Fonte of an EPUB card: `<a href="leitor://livro/{uid}?cap={N}&amp;cfi={cfi}&amp;q={q}">{title}, {label}</a>`;
 * `section1` is the 1-based spine section, `label` the TOC label (see `sectionLabel`), `cfi` and `q` are
 * percent-encoded like `encodeURIComponent` and left out when empty.
 */
export function fonteHtmlSection(
  uid: string,
  title: string,
  section1: number,
  label: string | null,
  cfi: string | null,
  query: string,
): string {
  const c = cfi ? `&amp;cfi=${encodeURIComponent(cfi)}` : '';
  const q = query ? `&amp;q=${encodeURIComponent(query)}` : '';
  return `<a href="leitor://livro/${uid}?cap=${section1}${c}${q}">${escapeHtml(title)}, ${escapeHtml(sectionLabel(label, section1))}</a>`;
}

/** What the form shows for an EPUB Fonte ("The Time Machine, Chapter III. …"). */
export function fonteSectionLabel(title: string, section1: number, label: string | null): string {
  return `${title}, ${sectionLabel(label, section1)}`;
}

/**
 * The Fonte field: `<a href="leitor://livro/{uid}?pagina={N}&amp;q={q}">{title}, p. {N}</a>`; `page1` is 1-based
 * and `q` is left out when the query is empty.
 */
export function fonteHtml(uid: string, title: string, page1: number, query: string): string {
  const q = query ? `&amp;q=${encodeURIComponent(query)}` : '';
  return `<a href="leitor://livro/${uid}?pagina=${page1}${q}">${escapeHtml(title)}, p. ${page1}</a>`;
}

/** What the form shows for the Fonte ("Animal Farm, p. 37"). */
export function fonteLabel(title: string, page1: number): string {
  return `${title}, p. ${page1}`;
}
