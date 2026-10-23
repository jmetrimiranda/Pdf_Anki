// Code inside Anki fields (spec 11.1): fields are HTML, so code is escaped and newlines become <br> when
// written; reading turns <br>/<div> back into newlines and unescapes. Pure string functions (no DOM), so the
// round trip is exact for any text: `htmlToCode(codeToHtml(s)) === s`.

/** Fields edited with the code editor, per app notetype (the rest use the rich editor). */
export const CODE_FIELDS: Record<string, readonly string[]> = {
  'Código · Comando': ['Resposta', 'Aceitas', 'Exige'],
  'Código · Programa': ['Linguagem', 'Modo', 'Resposta', 'Inicial', 'Setup', 'Testes', 'Entrada', 'SaidaEsperada'],
};

export function isCodeField(notetypeName: string, fieldName: string): boolean {
  return CODE_FIELDS[notetypeName]?.includes(fieldName) ?? false;
}

/** Fields edited with the CodeMirror editor (the rest of CODE_FIELDS keep the monospace textarea). */
const EDITOR_FIELDS = ['Resposta', 'Inicial', 'Setup', 'Testes'];

/** Values of the Linguagem and Modo selects of "Código · Programa" (spec 11.1). */
export const LANGUAGES = ['python', 'cpp'] as const;
export const MODES = ['testes', 'saida', 'estrutura'] as const;

/** How a field of a notetype is edited: CodeMirror, a select, the monospace textarea, or null (rich editor). */
export type CodeFieldKind = 'editor' | 'language' | 'mode' | 'mono';

export function codeFieldKind(
  notetype: { name: string; appType: string | null },
  fieldName: string,
): CodeFieldKind | null {
  const type = notetype.appType ?? notetype.name;
  if (!isCodeField(type, fieldName)) return null;
  if (EDITOR_FIELDS.includes(fieldName)) return 'editor';
  if (type === 'Código · Programa' && fieldName === 'Linguagem') return 'language';
  if (type === 'Código · Programa' && fieldName === 'Modo') return 'mode';
  return 'mono';
}

/** Plain text → field HTML: escape `&`, `<`, `>` and turn line breaks into `<br>`. */
export function codeToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function unescapeHtml(s: string): string {
  // One pass, so "&amp;lt;" becomes "&lt;" (not "<").
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[name.toLowerCase()];
    if (v === undefined) return m;
    // The rich editor writes &nbsp; for runs of spaces; in code they are plain spaces.
    return v === ' ' ? ' ' : v;
  });
}

/** Field HTML → plain text (also reads fields written by Anki's editor, which wraps lines in <div>). */
export function htmlToCode(html: string): string {
  let s = html.replace(/\r\n?/g, '\n');
  // Anki's editor: an empty line is <div><br></div>.
  s = s.replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, '<div></div>');
  let out = '';
  let i = 0;
  let seen = false;
  let lastWasBr = false;
  const text = (t: string) => {
    if (!t) return;
    out += t;
    seen = true;
    lastWasBr = false;
  };
  const tag = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(s))) {
    text(s.slice(i, m.index));
    i = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();
    if (name === 'br' && !closing) {
      out += '\n';
      seen = true;
      lastWasBr = true;
    } else if ((name === 'div' || name === 'p') && !closing) {
      // A block starts a new line, unless a <br> just ended the previous one.
      if (seen && !lastWasBr) out += '\n';
      seen = true;
      lastWasBr = false;
    }
    // Every other tag (and closing div/p) is dropped; its text stays.
  }
  text(s.slice(i));
  return unescapeHtml(out);
}
