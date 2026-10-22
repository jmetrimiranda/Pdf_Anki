// In-browser stand-in for the Rust core: used by `vite --mode mock`, Playwright and plain browsers.
// Pages are generated SVGs whose text layout is computed here, so word rects line up exactly.
import {
  CoreError,
  type CoreClient,
  type DeckNode,
  type DeckTree,
  type DocInfo,
  type OutlineItem,
  type PageImageOptions,
  type PageWord,
  type PageWords,
  type Rect,
  type SearchHit,
} from './types';

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 72;
const BODY_SIZE = 11;
const CHAR_W = BODY_SIZE * 0.6;
const LINE_H = 16.5;
const HEADING_SIZE = 20;
const COLS = Math.floor((PAGE_W - 2 * MARGIN_X) / CHAR_W);
/** Last usable baseline; leaves room for the page number. */
const BOTTOM = PAGE_H - 84;

// ---------------------------------------------------------------- decks

let nextDeckId = 1_700_000_000_000;

function deck(
  fullName: string,
  counts: [number, number, number],
  children: DeckNode[] = [],
  collapsed = false,
): DeckNode {
  const parts = fullName.split('::');
  return {
    id: nextDeckId++,
    name: parts[parts.length - 1] ?? fullName,
    fullName,
    level: parts.length,
    newCount: counts[0],
    learnCount: counts[1],
    reviewCount: counts[2],
    collapsed,
    children,
  };
}

export function mockDeckTree(): DeckTree {
  nextDeckId = 1_700_000_000_000;
  return {
    decks: [
      deck('5000 palavras', [0, 17, 1002]),
      deck(
        'Grammar A1',
        [36, 10, 88],
        [deck('Grammar A1::Unidade 1', [20, 6, 50]), deck('Grammar A1::Unidade 2', [16, 4, 38])],
        true,
      ),
      deck('Leitura de Livros A1', [40, 0, 21], [deck('Leitura de Livros A1::Animal Farm', [40, 0, 21])], true),
      deck('On Palestine — Noam Chomsky', [40, 21, 24]),
      deck('Oxford', [40, 35, 96], [deck('Oxford::Oxford 3000', [40, 35, 96]), deck('Oxford::Oxford 5000', [0, 0, 0])]),
      deck('RimA Summer School — Go2 Prep', [40, 8, 0]),
      deck(
        'ROS 2 — Revisão',
        [40, 23, 26],
        [deck('ROS 2 — Revisão::Comandos', [20, 15, 18]), deck('ROS 2 — Revisão::Conceitos', [20, 8, 8])],
        true,
      ),
      deck('Verbos Irregulares (Inglês)', [30, 10, 0]),
      deck(
        'Vocabulário',
        [10, 2, 14],
        [deck('Vocabulário::Livros', [10, 2, 14], [deck('Vocabulário::Livros::Teste', [10, 2, 14])])],
      ),
    ],
    studiedToday: { cards: 5, seconds: 170 },
  };
}

// ---------------------------------------------------------------- documents

const CHAPTERS: { title: string; paragraphs: string[] }[] = [
  {
    title: 'Chapter 1 — Nodes and Topics',
    paragraphs: [
      'A robot is rarely a single program. It is a small society of processes that talk to each other all the time: one reads the laser, another estimates where the robot is, a third decides where to go next. ROS 2 gives each of these processes a name and a common language.',
      'The basic unit is the node. A node is a process that does one job well and exposes that job through topics, services and actions. Keeping nodes small makes them easy to test, to restart and to replace when the hardware changes.',
      'Topics carry streams of messages. A publisher does not know who is listening, and a subscriber does not know who is speaking. This loose coupling is what lets you record a session, replay it later and debug the same situation again and again.',
    ],
  },
  {
    title: 'Chapter 2 — Quality of Service',
    paragraphs: [
      'Not every message deserves the same treatment. A camera frame that arrives late is worthless, while a command to stop the motors must never be lost. Quality of service settings let each topic choose between speed and certainty.',
      'Reliable delivery retries until the message arrives; best effort sends once and moves on. Durability decides whether a late subscriber receives the last value that was published before it joined, which is exactly what you want for maps and parameters.',
      'When two endpoints disagree about these settings, they silently refuse to talk. The command line tools can show the profile of every endpoint, and checking them is the first step whenever data seems to disappear.',
    ],
  },
  {
    title: 'Chapter 3 — Launching a System',
    paragraphs: [
      'Starting twenty nodes by hand is tedious and fragile. Launch files describe the whole system in one place: which nodes to start, with which parameters, in which namespace, and what to do when one of them fails.',
      'A good launch file reads like a table of contents. It includes smaller launch files for each subsystem and passes arguments down, so that the same description works on the real robot and in the simulator.',
      'Parameters belong in files, not in code. Changing a gain or a frame name should never require a rebuild, and keeping these values under version control makes every experiment repeatable.',
    ],
  },
  {
    title: 'Chapter 4 — Transforms',
    paragraphs: [
      'Every sensor sees the world from its own point of view. The transform library keeps track of how all these frames relate over time, so that a point seen by the camera can be expressed in the frame of the map or of the gripper.',
      'Static transforms describe parts that never move relative to each other, such as a lidar bolted to the base. Dynamic transforms change continuously and are published by the nodes that know them, like odometry or the joint state publisher.',
    ],
  },
];

interface Line {
  text: string;
  x: number;
  baseline: number;
  size: number;
  charW: number;
}

interface MockPage {
  lines: Line[];
  text: string;
  /** Start offset of each line in `text`. */
  offsets: number[];
}

interface MockDoc {
  info: DocInfo;
  pages: MockPage[];
  outline: OutlineItem[];
}

function wrap(paragraph: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of paragraph.split(/\s+/)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= COLS) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

function layoutBook(): { pages: MockPage[]; outline: OutlineItem[] } {
  const pages: Line[][] = [];
  const outline: OutlineItem[] = [];
  for (const chapter of CHAPTERS) {
    // Each chapter starts on a new page and repeats its paragraphs to fill a few pages.
    let lines: Line[] = [];
    let y = 120;
    outline.push({ title: chapter.title, page: pages.length, children: [] });
    lines.push({ text: chapter.title, x: MARGIN_X, baseline: y, size: HEADING_SIZE, charW: HEADING_SIZE * 0.6 });
    y += 40;
    for (const paragraph of Array.from({ length: 4 }, () => chapter.paragraphs).flat()) {
      for (const text of wrap(paragraph)) {
        if (y > BOTTOM) {
          pages.push(lines);
          lines = [];
          y = 84;
        }
        lines.push({ text, x: MARGIN_X, baseline: y, size: BODY_SIZE, charW: CHAR_W });
        y += LINE_H;
      }
      y += LINE_H * 0.6;
    }
    pages.push(lines);
  }
  return {
    pages: pages.map((lines) => {
      const offsets: number[] = [];
      let text = '';
      for (const line of lines) {
        offsets.push(text.length);
        text += `${line.text}\n`;
      }
      return { lines, text, offsets };
    }),
    outline,
  };
}

const docs = new Map<string, MockDoc>();
let docCounter = 0;

function createDoc(docId: string, title: string | null, author: string | null): MockDoc {
  const { pages, outline } = layoutBook();
  const doc: MockDoc = {
    info: {
      docId,
      pageCount: pages.length,
      pages: pages.map(() => ({ width: PAGE_W, height: PAGE_H })),
      title,
      author,
    },
    pages,
    outline,
  };
  docs.set(docId, doc);
  return doc;
}

export const MOCK_DOC_ID = 'mock-ros2';
createDoc(MOCK_DOC_ID, 'ROS 2 na prática', 'Jorge Metri');

function getDoc(docId: string): MockDoc {
  const doc = docs.get(docId);
  if (!doc) throw new CoreError('doc_not_open', 'Este documento não está aberto.');
  return doc;
}

function getPage(doc: MockDoc, page: number): MockPage {
  const p = Number.isInteger(page) ? doc.pages[page] : undefined;
  if (!p) throw new CoreError('page_out_of_range', `A página ${page + 1} não existe neste documento.`);
  return p;
}

/** Rects covering text[start, end) of a page, one per line. */
function rangeRects(page: MockPage, start: number, end: number): Rect[] {
  const rects: Rect[] = [];
  page.lines.forEach((line, i) => {
    const lineStart = page.offsets[i] ?? 0;
    const lineEnd = lineStart + line.text.length;
    const a = Math.max(start, lineStart);
    const b = Math.min(end, lineEnd);
    if (a >= b) return;
    rects.push([
      line.x + (a - lineStart) * line.charW,
      line.baseline - line.size * 0.82,
      (b - a) * line.charW,
      line.size * 1.08,
    ]);
  });
  return rects;
}

function pageWords(doc: MockDoc, pageIndex: number): PageWords {
  const page = getPage(doc, pageIndex);
  const words: PageWord[] = [];
  for (const m of page.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    const start = m.index;
    const end = start + m[0].length;
    words.push({ index: words.length, text: m[0], start, end, rects: rangeRects(page, start, end) });
  }
  return { page: pageIndex, width: PAGE_W, height: PAGE_H, text: page.text, words };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

const PAGE_THEMES = {
  claro: { bg: '#ffffff', text: '#1f1f1f', muted: '#8a8a8a' },
  sepia: { bg: '#f4ecd8', text: '#5b4636', muted: '#9b8670' },
  escuro: { bg: '#1b1b1b', text: '#d8d8d8', muted: '#7a7a7a' },
} as const;

export function mockPageSvg(doc: DocInfo, pageIndex: number, opts: PageImageOptions): string {
  const page = docs.get(doc.docId)?.pages[pageIndex];
  const colors = PAGE_THEMES[opts.theme ?? 'claro'];
  const w = Math.round(PAGE_W * opts.scale);
  const h = Math.round(PAGE_H * opts.scale);
  const body = (page?.lines ?? [])
    .map(
      (l) =>
        `<text x="${l.x}" y="${l.baseline}" font-size="${l.size}" textLength="${(l.text.length * l.charW).toFixed(2)}" lengthAdjust="spacingAndGlyphs"${l.size > BODY_SIZE ? ' font-weight="600"' : ''}>${escapeXml(l.text)}</text>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">` +
    `<rect width="${PAGE_W}" height="${PAGE_H}" fill="${colors.bg}"/>` +
    `<g fill="${colors.text}" font-family="'DejaVu Sans Mono','Liberation Mono',Menlo,Consolas,monospace">${body}</g>` +
    `<text x="${PAGE_W / 2}" y="${PAGE_H - 40}" font-size="9" text-anchor="middle" fill="${colors.muted}" font-family="sans-serif">${pageIndex + 1}</text>` +
    `</svg>`
  );
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------- client

/** Simulated latency so loading states are visible; 0 in unit tests. */
let latencyMs = import.meta.env.MODE === 'test' ? 0 : 120;
export function setMockLatency(ms: number): void {
  latencyMs = ms;
}

function later<T>(fn: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    }, latencyMs);
  });
}

function fileTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.pdf$/i, '');
}

function search(doc: MockDoc, q: string): SearchHit[] {
  const needle = q.trim().toLocaleLowerCase('pt-BR');
  if (!needle) return [];
  const hits: SearchHit[] = [];
  doc.pages.forEach((page, pageIndex) => {
    const hay = page.text.toLocaleLowerCase('pt-BR');
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const ctxStart = Math.max(0, at - 40);
      const ctxEnd = Math.min(page.text.length, end + 40);
      hits.push({
        page: pageIndex,
        rects: rangeRects(page, at, end),
        context: `${ctxStart > 0 ? '…' : ''}${page.text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim()}${ctxEnd < page.text.length ? '…' : ''}`,
      });
      from = end;
    }
  });
  return hits;
}

export const mockClient: CoreClient = {
  kind: 'mock',
  ankiDeckTree: () => later(mockDeckTree),
  docOpenPath: (path) =>
    later(() => {
      if (!/\.pdf$/i.test(path)) {
        throw new CoreError('unsupported_format', 'Formato não suportado. Abra um arquivo PDF.');
      }
      if (/corromp/i.test(path)) {
        throw new CoreError('pdf_invalid', 'Não foi possível abrir este PDF: o arquivo parece estar corrompido.');
      }
      docCounter += 1;
      return structuredClone(createDoc(`mock-${docCounter}`, fileTitle(path), null).info);
    }),
  docInfo: (docId) => later(() => structuredClone(getDoc(docId).info)),
  docOutline: (docId) => later(() => structuredClone(getDoc(docId).outline)),
  docWords: (docId, page) => later(() => pageWords(getDoc(docId), page)),
  docSearch: (docId, q) => later(() => search(getDoc(docId), q)),
  docClose: (docId) =>
    later(() => {
      if (docId !== MOCK_DOC_ID) docs.delete(docId);
    }),
  devSmoke: () =>
    later(() => {
      const doc = getDoc(MOCK_DOC_ID);
      return {
        collectionPath: '/home/jorge/.local/share/dev.jmetri.leitor-estudos/smoke/anki/collection.anki2',
        deckTree: mockDeckTree(),
        doc: structuredClone(doc.info),
        page1Url: mockClient.pageImageUrl(MOCK_DOC_ID, 0, { scale: 1 }),
        words: pageWords(doc, 0).words.length,
        millis: { anki: 38, pdfOpen: 12, pdfText: 4 },
      };
    }),
  pageImageUrl: (docId, page, opts) => {
    const info = docs.get(docId)?.info;
    if (!info) return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`);
    return svgDataUrl(mockPageSvg(info, page, opts));
  },
};
