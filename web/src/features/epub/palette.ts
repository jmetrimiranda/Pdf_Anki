// PdfCraft's highlight look for EPUB annotations (spec 4: "Destaques em EPUB: imitar as cores e a aparência dos
// destaques do PdfCraft"). The colours are PdfCraft's comment swatches (third_party/pdfcraft/crates/ui-egui/src/
// comments.rs, `SWATCHES`, default Yellow); the look follows its appearance streams (crates/annot/src/appearance.rs):
// a highlight is an opaque fill drawn with the Multiply blend mode (`/BM /Multiply`, opacity 1), so the glyphs stay
// dark; an underline is a line in the colour; a note is PdfCraft's speech-bubble icon filled with the note colour and
// outlined in dark grey.
import type { MessageKey } from '../../i18n';

export interface Swatch {
  /** PdfCraft's name (English, as in comments.rs). */
  name: string;
  /** The pt-BR label. */
  label: MessageKey;
  /** 0–1 RGB, exactly PdfCraft's values. */
  rgb: readonly [number, number, number];
  /** `#rrggbb` (what `epub_annotation.color` stores). */
  hex: string;
}

function toHex([r, g, b]: readonly [number, number, number]): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const RAW: [string, MessageKey, [number, number, number]][] = [
  ['Yellow', 'epubReader.color.yellow', [1.0, 0.94, 0.0]],
  ['Orange', 'epubReader.color.orange', [1.0, 0.54, 0.0]],
  ['Red', 'epubReader.color.red', [0.89, 0.13, 0.13]],
  ['Pink', 'epubReader.color.pink', [1.0, 0.37, 0.64]],
  ['Purple', 'epubReader.color.purple', [0.54, 0.25, 0.82]],
  ['Blue', 'epubReader.color.blue', [0.0, 0.47, 0.84]],
  ['Light blue', 'epubReader.color.lightBlue', [0.36, 0.75, 0.98]],
  ['Green', 'epubReader.color.green', [0.18, 0.62, 0.36]],
  ['Gray', 'epubReader.color.gray', [0.5, 0.5, 0.5]],
  ['Black', 'epubReader.color.black', [0.0, 0.0, 0.0]],
];

/** PdfCraft's 10 comment swatches, in its order. */
export const SWATCHES: readonly Swatch[] = RAW.map(([name, label, rgb]) => ({ name, label, rgb, hex: toHex(rgb) }));

/** PdfCraft's default highlight colour (Yellow, #fff000). */
export const DEFAULT_COLOR = SWATCHES[0]!.hex;

/** A stored colour, or the default when it is missing or not `#rrggbb`. */
export function normalizeColor(color: string | null | undefined): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_COLOR;
}

export function swatchOf(color: string | null | undefined): Swatch | undefined {
  const hex = normalizeColor(color);
  return SWATCHES.find((s) => s.hex === hex);
}

// ---------------------------------------------------------------------------------------------------------------
// Overlay drawing (foliate's Overlayer calls these with the client rects of the range)

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

type Rects = DOMRectList | DOMRect[] | readonly DOMRectReadOnly[];

export interface HighlightOptions {
  color: string;
  /** Dark page: Multiply would turn the fill black, so it is drawn translucent instead (like the app's search hits). */
  dark?: boolean;
  /** Note: draw PdfCraft's note icon at the end of the passage. */
  note?: boolean;
  /** `data-annotation` (tests and hit testing). */
  id?: string;
}

/** Opacity of a highlight on a dark page (Multiply is not usable there). */
export const DARK_HIGHLIGHT_OPACITY = 0.38;

/** PdfCraft's `/Comment` icon (a speech bubble), from appearance.rs `note_icon`, in a 20×20 box (y down). */
const NOTE_BUBBLE =
  'M3 1.5L17 1.5C18.5 1.5 18.5 3 18.5 3L18.5 12C18.5 13.5 17 13.5 17 13.5L9.5 13.5L5 18L5.5 13.5L3 13.5C1.5 13.5 1.5 12 1.5 12L1.5 3C1.5 1.5 3 1.5 3 1.5Z';
const NOTE_LINES = 'M4.5 5L15.5 5M4.5 7.5L15.5 7.5M4.5 10L11.5 10';

/** Size of the note icon, in CSS px. */
export const NOTE_ICON_PX = 14;

function noteIcon(x: number, y: number, color: string): SVGGElement {
  const scale = NOTE_ICON_PX / 20;
  const g = svg('g', { transform: `translate(${x} ${y}) scale(${scale})`, 'data-note-icon': '' });
  g.append(
    svg('path', { d: NOTE_BUBBLE, fill: color, stroke: '#404040', 'stroke-width': 0.8, 'stroke-linejoin': 'round' }),
    svg('path', { d: NOTE_LINES, fill: 'none', stroke: '#404040', 'stroke-width': 0.8, 'stroke-linecap': 'round' }),
  );
  return g;
}

/** A PdfCraft-style highlight: an opaque fill with the Multiply blend (translucent on a dark page). */
export function drawHighlight(rects: Rects, options?: Record<string, unknown>): SVGElement {
  const o = options as unknown as HighlightOptions;
  const g = svg('g', { 'data-kind': o.note ? 'note' : 'highlight', fill: o.color });
  if (o.id) g.setAttribute('data-annotation', o.id);
  const fills = svg('g', {});
  fills.style.mixBlendMode = o.dark ? 'normal' : 'multiply';
  fills.style.opacity = o.dark ? String(DARK_HIGHLIGHT_OPACITY) : '1';
  const list = Array.from(rects);
  for (const r of list) {
    if (r.width <= 0 || r.height <= 0) continue;
    fills.append(svg('rect', { x: r.left, y: r.top, width: r.width, height: r.height }));
  }
  g.append(fills);
  const last = list.filter((r) => r.width > 0 && r.height > 0).at(-1);
  if (o.note && last) g.append(noteIcon(last.right + 1, last.top - NOTE_ICON_PX * 0.55, o.color));
  return g;
}

/** A PdfCraft-style underline: a 2 px line in the colour along the bottom of each line box. */
export function drawUnderline(rects: Rects, options?: Record<string, unknown>): SVGElement {
  const o = options as unknown as { color: string; width?: number; id?: string; kind?: string };
  const width = o.width ?? 2;
  const g = svg('g', { 'data-kind': o.kind ?? 'underline', fill: o.color });
  if (o.id) g.setAttribute('data-annotation', o.id);
  for (const r of Array.from(rects)) {
    if (r.width <= 0 || r.height <= 0) continue;
    g.append(svg('rect', { x: r.left, y: r.bottom - width, width: r.width, height: width }));
  }
  return g;
}
