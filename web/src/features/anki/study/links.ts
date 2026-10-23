// `leitor://livro/<book_uid>?pagina=N[&q=…]` links clicked inside a card (spec 10.2). Same rules as the core's
// Fonte parser (core-anki study/source.rs): 64 lowercase hex chars, `pagina` a positive integer (1-based).
import type { SourceLink } from '../../../lib/core/types';

export function parseLeitorLink(href: string, label = ''): SourceLink | null {
  const m = /^leitor:\/\/livro\/([0-9a-f]{64})(?:\?([^#]*))?(?:#.*)?$/.exec(href.replace(/&amp;/g, '&').trim());
  if (!m) return null;
  let page: number | null = null;
  let query: string | null = null;
  for (const pair of (m[2] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    if (k === 'pagina' && page === null) {
      if (!/^\d+$/.test(v) || Number(v) < 1) return null;
      page = Number(v);
    } else if (k === 'q' && query === null) {
      try {
        query = decodeURIComponent(v.replace(/\+/g, ' ')).trim().slice(0, 500) || null;
      } catch {
        query = null;
      }
    }
  }
  if (page === null) return null;
  return { bookUid: m[1]!, page, query, label: label.trim() || `p. ${page}` };
}
