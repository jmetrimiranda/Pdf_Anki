/**
 * Step 10 (spec 11.3): a tiny YAML *flow* parser (no dependency). Supports
 * flow maps and sequences, quoted and plain scalars, ints/floats (normalized,
 * so `2` ≡ `2.0`), booleans and null. Only used when a token parses as a flow
 * collection in BOTH strings; outside YAML, numbers are text.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | YamlMap;
export interface YamlMap {
  readonly kind: 'map';
  /** Entries keyed by the canonical form of the key. */
  readonly entries: ReadonlyMap<string, YamlValue>;
}

const MAX_DEPTH = 64;

class ParseError extends Error {}

class Parser {
  private i = 0;
  private readonly s: string;
  constructor(text: string) {
    this.s = text;
  }

  parseDocument(): YamlValue {
    this.ws();
    const v = this.value(0);
    this.ws();
    if (this.i !== this.s.length) throw new ParseError('trailing');
    return v;
  }

  private ws(): void {
    while (this.i < this.s.length) {
      const c = this.s.charAt(this.i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i++;
      } else if (c === '#' && (this.i === 0 || /\s/.test(this.s.charAt(this.i - 1)))) {
        while (this.i < this.s.length && this.s.charAt(this.i) !== '\n') this.i++;
      } else {
        break;
      }
    }
  }

  private peek(): string {
    return this.s.charAt(this.i);
  }

  /** `:` is a mapping indicator when followed by space, a flow indicator or the end. */
  private atColon(afterQuoted: boolean): boolean {
    if (this.peek() !== ':') return false;
    const next = this.s.charAt(this.i + 1);
    return afterQuoted || next === '' || /[\s,\]}[{]/.test(next);
  }

  private value(depth: number): YamlValue {
    if (depth > MAX_DEPTH) throw new ParseError('depth');
    const c = this.peek();
    if (c === '{') return this.map(depth);
    if (c === '[') return this.seq(depth);
    return this.scalar().value;
  }

  private map(depth: number): YamlMap {
    this.i++; // {
    const entries = new Map<string, YamlValue>();
    this.ws();
    while (this.peek() !== '}') {
      if (this.i >= this.s.length) throw new ParseError('unclosed map');
      const key = this.peek() === '{' || this.peek() === '[' ? { value: this.value(depth + 1), quoted: true } : this.scalar();
      this.ws();
      let v: YamlValue = null;
      if (this.atColon(key.quoted)) {
        this.i++;
        this.ws();
        if (this.peek() !== ',' && this.peek() !== '}') v = this.value(depth + 1);
        this.ws();
      }
      entries.set(canonical(key.value), v);
      if (this.peek() === ',') {
        this.i++;
        this.ws();
      } else if (this.peek() !== '}') {
        throw new ParseError('expected , or }');
      }
    }
    this.i++; // }
    return { kind: 'map', entries };
  }

  private seq(depth: number): YamlValue[] {
    this.i++; // [
    const items: YamlValue[] = [];
    this.ws();
    while (this.peek() !== ']') {
      if (this.i >= this.s.length) throw new ParseError('unclosed seq');
      const isCollection = this.peek() === '{' || this.peek() === '[';
      const first = isCollection ? { value: this.value(depth + 1), quoted: true } : this.scalar();
      this.ws();
      if (this.atColon(first.quoted)) {
        // Single-pair implicit map: `[a: 1]`.
        this.i++;
        this.ws();
        let v: YamlValue = null;
        if (this.peek() !== ',' && this.peek() !== ']') v = this.value(depth + 1);
        this.ws();
        items.push({ kind: 'map', entries: new Map([[canonical(first.value), v]]) });
      } else {
        items.push(first.value);
      }
      if (this.peek() === ',') {
        this.i++;
        this.ws();
      } else if (this.peek() !== ']') {
        throw new ParseError('expected , or ]');
      }
    }
    this.i++; // ]
    return items;
  }

  private scalar(): { value: YamlValue; quoted: boolean } {
    const c = this.peek();
    if (c === '"') return { value: this.doubleQuoted(), quoted: true };
    if (c === "'") return { value: this.singleQuoted(), quoted: true };
    const start = this.i;
    while (this.i < this.s.length) {
      const d = this.peek();
      if (d === ',' || d === ']' || d === '}' || d === '[' || d === '{') break;
      if (d === ':' && this.atColon(false)) break;
      if (d === '#' && /\s/.test(this.s.charAt(this.i - 1))) break;
      this.i++;
    }
    return { value: resolvePlain(this.s.slice(start, this.i).trim()), quoted: false };
  }

  private singleQuoted(): string {
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) throw new ParseError('unclosed quote');
      const c = this.peek();
      if (c === "'") {
        if (this.s.charAt(this.i + 1) === "'") {
          out += "'";
          this.i += 2;
          continue;
        }
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
  }

  private doubleQuoted(): string {
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) throw new ParseError('unclosed quote');
      const c = this.peek();
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const e = this.s.charAt(this.i + 1);
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };
        out += map[e] ?? e;
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
  }
}

const INT_RE = /^[-+]?[0-9]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;

function resolvePlain(text: string): YamlValue {
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (INT_RE.test(text) || FLOAT_RE.test(text)) return Number(text);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^0o[0-7]+$/.test(text)) return Number.parseInt(text.slice(2), 8);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return Number.NaN;
  return text;
}

/** Canonical text of a value (map keys, deep comparison). Numbers are normalized: 2 ≡ 2.0. */
export function canonical(v: YamlValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isNaN(v) ? 'n:nan' : `n:${String(v)}`;
  if (typeof v === 'string') return `s:${JSON.stringify(v)}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = [...v.entries.keys()].sort();
  return `{${keys.map((k) => `${k}=${canonical(v.entries.get(k) ?? null)}`).join(',')}}`;
}

/** Parses a YAML flow collection (`{…}` or `[…]`); `undefined` if the text is not one. Never throws. */
export function parseFlowYaml(text: string): YamlValue | undefined {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return new Parser(t).parseDocument();
  } catch {
    return undefined;
  }
}

export function isFlowYaml(text: string): boolean {
  return parseFlowYaml(text) !== undefined;
}

/**
 * `true`/`false` when both texts are YAML flow collections (compared after
 * parsing), `undefined` when YAML doesn't apply.
 */
export function yamlEqual(a: string, b: string): boolean | undefined {
  const va = parseFlowYaml(a);
  if (va === undefined) return undefined;
  const vb = parseFlowYaml(b);
  if (vb === undefined) return undefined;
  return canonical(va) === canonical(vb);
}
