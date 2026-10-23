// The `Fonte` field of cards made from a selection (spec 10.2): "Animal Farm, p. 37" linking back to the book with
// `leitor://livro/<book_uid>?pagina=N&q=<trecho>`. The core has the same builder (core-anki) with the same literal
// test, and features/anki/study/links.ts parses what this writes.

/** Longest `q` in a Fonte link (characters). */
export const FONTE_QUERY_MAX = 80;

/** HTML-escapes text for a field or an attribute (`&`, `<`, `>`, `"`). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The search text of a Fonte link: whitespace collapsed, cut at a word boundary to at most 80 characters (a single
 * longer word is cut at 80); empty when there is nothing to search.
 */
export function fonteQuery(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= FONTE_QUERY_MAX) return s;
  // The next character is a space: the first 80 end exactly at a word boundary.
  if (chars[FONTE_QUERY_MAX] === ' ') return chars.slice(0, FONTE_QUERY_MAX).join('');
  const head = chars.slice(0, FONTE_QUERY_MAX).join('');
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trim();
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
