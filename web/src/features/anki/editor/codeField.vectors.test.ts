// The shared HTML ↔ code vectors (spec 11.1, 20): the same file runs in Rust (core-code) and here, so both sides
// write and read code fields identically.
import { describe, expect, it } from 'vitest';
import raw from '../../../../../src-tauri/crates/core-code/tests/fixtures/code_html_vectors.json?raw';
import { codeToHtml, htmlToCode } from './codeField';

interface Vector {
  name: string;
  /** Text written to a field (absent: a read-only vector, HTML written by another editor). */
  text?: string;
  html: string;
  /** What reading `html` gives (default: `text`). */
  readsAs?: string;
}

const vectors = JSON.parse(raw) as Vector[];

describe('code field vectors shared with Rust', () => {
  it('has the vectors', () => {
    expect(vectors.length).toBeGreaterThan(20);
  });

  it.each(vectors.filter((v) => v.text !== undefined).map((v) => [v.name, v] as const))('writes %s', (_, v) => {
    expect(codeToHtml(v.text!)).toBe(v.html);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('reads %s', (_, v) => {
    expect(htmlToCode(v.html)).toBe(v.readsAs ?? v.text);
  });
});
