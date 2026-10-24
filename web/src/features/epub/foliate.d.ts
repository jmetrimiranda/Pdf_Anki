// Types for the parts of foliate-js (web/vendor/foliate-js, pinned in scripts/fetch-foliate.sh) the reader uses.
// `@foliate/*` is a Vite alias of web/vendor/foliate-js (vite.config.ts). Written from the pinned source; see
// docs/tecnico/foliate.md.

declare module '@foliate/epubcfi.js' {
  export const isCFI: RegExp;
  /** Orders two CFIs (ranges by their start, then end): -1, 0 or 1. */
  export function compare(a: string, b: string): number;
  export function collapse(cfi: string, toEnd?: boolean): string;
  export function parse(cfi: string): unknown;
  export function fromRange(range: Range): string;
  export function joinIndir(...cfis: string[]): string;
}

declare module '@foliate/overlayer.js' {
  export type DrawFunction = (rects: DOMRectList | DOMRect[], options?: Record<string, unknown>) => SVGElement;
  export class Overlayer {
    readonly element: SVGSVGElement;
    add(
      key: string,
      range: Range | ((root: Node) => Range),
      draw: DrawFunction,
      options?: Record<string, unknown>,
    ): void;
    remove(key: string): void;
    redraw(): void;
    hitTest(point: { x: number; y: number }): [string, Range] | [];
    static underline: DrawFunction;
    static highlight: DrawFunction;
    static outline: DrawFunction;
    static squiggly: DrawFunction;
    static strikethrough: DrawFunction;
  }
}

declare module '@foliate/vendor/zip.js' {
  export function configure(options: Record<string, unknown>): void;
  export interface ZipEntry {
    filename: string;
    directory: boolean;
    uncompressedSize: number;
    compressedSize: number;
    encrypted: boolean;
    getData<T>(writer: { __writes?: T }, options?: Record<string, unknown>): Promise<T>;
  }
  export class BlobReader {
    constructor(blob: Blob);
  }
  export class TextWriter {
    __writes?: string;
    constructor(encoding?: string);
  }
  export class BlobWriter {
    __writes?: Blob;
    constructor(mimeType?: string);
  }
  export class ZipReader {
    constructor(reader: BlobReader, options?: Record<string, unknown>);
    getEntries(options?: Record<string, unknown>): Promise<ZipEntry[]>;
    close(): Promise<void>;
  }
}

declare module '@foliate/epub.js' {
  export interface TocItem {
    id?: number;
    label: string;
    href: string;
    subitems?: TocItem[] | null;
  }
  export interface Section {
    id: string;
    load(): Promise<string> | string;
    unload?(): void;
    createDocument(): Promise<Document>;
    size: number;
    cfi?: string;
    linear?: string;
  }
  export interface EpubLoader {
    loadText(name: string): Promise<string | null> | string | null;
    loadBlob(name: string, type?: string): Promise<Blob | null> | Blob | null;
    getSize(name: string): number;
    sha1?: (s: string) => Promise<Uint8Array>;
  }
  export interface TransformDataDetail {
    readonly name: string;
    type: string;
    data: unknown;
  }
  export interface TransformLoadDetail {
    type: string;
    isScript: boolean;
    allow: boolean | Promise<boolean>;
  }
  export class EPUB {
    constructor(loader: EpubLoader);
    init(): Promise<EPUB>;
    sections: Section[];
    toc?: TocItem[];
    pageList?: TocItem[];
    landmarks?: unknown[];
    metadata?: { title?: unknown; language?: string | string[]; [k: string]: unknown };
    rendition?: { layout?: string; [k: string]: unknown };
    dir?: string;
    /** Fires `load` (detail: TransformLoadDetail) and `data` (detail: TransformDataDetail) for every resource. */
    transformTarget: EventTarget;
    resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range | Node };
    resolveHref(href: string): { index: number; anchor: (doc: Document) => Element | number } | null;
    splitTOCHref(href: string): string[];
    isExternal(uri: string): boolean;
    getCover(): Promise<Blob | null>;
    destroy(): void;
  }
}

declare module '@foliate/view.js' {
  import type { EPUB, TocItem } from '@foliate/epub.js';
  import type { DrawFunction, Overlayer } from '@foliate/overlayer.js';

  export interface RelocateDetail {
    fraction?: number;
    section?: { current: number; total: number };
    location?: { current: number; next: number; total: number };
    tocItem?: TocItem | null;
    pageItem?: TocItem | null;
    cfi: string;
    range: Range;
    reason?: string;
  }
  export interface SearchExcerpt {
    pre: string;
    match: string;
    post: string;
  }
  export type SearchResult =
    | { progress: number }
    | { label: string; subitems: { cfi: string; excerpt: SearchExcerpt }[] }
    | { cfi: string; excerpt: SearchExcerpt }
    | 'done';

  export interface Renderer extends HTMLElement {
    setStyles(styles: string | [string, string]): void;
    getContents(): { index: number; overlayer?: Overlayer; doc: Document }[];
    next(distance?: number): Promise<void>;
    prev(distance?: number): Promise<void>;
    goTo(target: unknown): Promise<void>;
    focusView(): void;
    destroy(): void;
    readonly page?: number;
    readonly pages?: number;
    readonly size?: number;
  }

  export class View extends HTMLElement {
    book: EPUB;
    renderer: Renderer;
    isFixedLayout: boolean;
    lastLocation: RelocateDetail | null;
    open(book: EPUB): Promise<void>;
    close(): void;
    init(o: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
    goTo(target: string | number): Promise<{ index: number; anchor?: unknown } | undefined>;
    goToFraction(fraction: number): Promise<void>;
    select(target: string): Promise<void>;
    deselect(): void;
    prev(): Promise<void>;
    next(): Promise<void>;
    goLeft(): Promise<void>;
    goRight(): Promise<void>;
    getCFI(index: number, range?: Range): string;
    resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range | Node };
    resolveNavigation(target: unknown): { index: number; anchor?: unknown } | undefined;
    addAnnotation(
      annotation: { value: string },
      remove?: boolean,
    ): Promise<{ index: number; label: string } | undefined>;
    deleteAnnotation(annotation: { value: string }): Promise<unknown>;
    search(opts: {
      query: string;
      index?: number;
      matchCase?: boolean;
      matchDiacritics?: boolean;
      matchWholeWords?: boolean;
      draw?: DrawFunction;
      drawOptions?: Record<string, unknown>;
    }): AsyncGenerator<SearchResult>;
    clearSearch(): void;
    getProgressOf(index: number, range: Range): { tocItem?: TocItem | null; pageItem?: TocItem | null };
  }

  export function makeBook(file: Blob | string): Promise<EPUB>;
}

declare module '@foliate/paginator.js' {}
declare module '@foliate/fixed-layout.js' {}
