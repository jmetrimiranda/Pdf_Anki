// `leitor://livro/<book_uid>?pagina=N[&q=…]` (PDF page) and `?cap=N[&cfi=…][&q=…]` (EPUB chapter, spec 7.1) links
// clicked inside a card (spec 10.2). Same rules as the core's Fonte parser (core-anki study/source.rs): 64 lowercase
// hex chars, `pagina`/`cap` a positive integer (1-based), `cfi` an `epubcfi(…)` (ignored when malformed).
import type { SourceLink } from '../../../lib/core/types';

/** Longest CFI kept from a link (bytes, like core-anki's `MAX_CFI_BYTES`). */
export const MAX_LINK_CFI = 2048;

/** Percent-decodes a query value (`+` is a space, as in forms); null when malformed. */
function decode(v: string, plusIsSpace = true): string | null {
  try {
    return decodeURIComponent(plusIsSpace ? v.replace(/\+/g, ' ') : v);
  } catch {
    return null;
  }
}

/** A decoded `cfi=` value when it looks like an EPUB CFI, else null. */
export function cleanCfi(raw: string | null): string | null {
  const cfi = raw?.trim() ?? '';
  if (!cfi || new TextEncoder().encode(cfi).length > MAX_LINK_CFI) return null;
  if (!/^epubcfi\(\/.*\)$/s.test(cfi) || /[\u0000-\u001f<>"]/.test(cfi)) return null;
  return cfi;
}

export function parseLeitorLink(href: string, label = ''): SourceLink | null {
  const m = /^leitor:\/\/livro\/([0-9a-f]{64})(?:\?([^#]*))?(?:#.*)?$/.exec(href.replace(/&amp;/g, '&').trim());
  if (!m) return null;
  let pagina: number | null = null;
  let cap: number | null = null;
  let query: string | null = null;
  let cfi: string | null = null;
  let cfiSeen = false;
  for (const pair of (m[2] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    if (k === 'pagina' && pagina === null) {
      if (!/^\d+$/.test(v) || Number(v) < 1) return null;
      pagina = Number(v);
    } else if (k === 'cap' && cap === null) {
      if (!/^\d+$/.test(v) || Number(v) < 1) return null;
      cap = Number(v);
    } else if (k === 'q' && query === null) {
      query = decode(v)?.trim().slice(0, 500) || null;
    } else if (k === 'cfi' && !cfiSeen) {
      cfiSeen = true;
      cfi = cleanCfi(decode(v, false));
    }
  }
  // `pagina` (a PDF page) wins over `cap` (an EPUB chapter), like the core.
  const page = pagina ?? cap;
  if (page === null) return null;
  const unit: SourceLink['unit'] = pagina !== null ? 'page' : 'chapter';
  return {
    bookUid: m[1]!,
    page,
    unit,
    cfi: unit === 'chapter' ? cfi : null,
    query,
    label: label.trim() || `${unit === 'chapter' ? 'cap.' : 'p.'} ${page}`,
  };
}

/** Where "Abrir no livro" goes inside the app: `/leitor?livro=…&pagina=N` or `&cap=N&cfi=…`, plus `&q=…`. */
export function leitorSearch(link: Pick<SourceLink, 'bookUid' | 'page' | 'unit' | 'cfi' | 'query'>): {
  livro: string;
  pagina?: number;
  cap?: number;
  cfi?: string;
  q?: string;
} {
  return {
    livro: link.bookUid,
    ...(link.unit === 'chapter' ? { cap: link.page } : { pagina: link.page }),
    ...(link.unit === 'chapter' && link.cfi ? { cfi: link.cfi } : {}),
    ...(link.query ? { q: link.query } : {}),
  };
}

/** The `leitor.openBook` options of a link: 0-based page/section, the passage to find and the EPUB CFI. */
export function openOptions(link: Pick<SourceLink, 'page' | 'unit' | 'cfi' | 'query'>): {
  page: number;
  find?: string;
  cfi?: string;
} {
  return {
    page: Math.max(0, link.page - 1),
    ...(link.query ? { find: link.query } : {}),
    ...(link.unit === 'chapter' && link.cfi ? { cfi: link.cfi } : {}),
  };
}
