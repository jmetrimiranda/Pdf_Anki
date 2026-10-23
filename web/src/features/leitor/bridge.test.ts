import { describe, expect, it, vi } from 'vitest';
import {
  BridgeClient,
  INFO_KEY,
  MAX_BYTES,
  MAX_MARK_PAGES,
  MAX_MARK_RECTS,
  MIN_BRIDGE,
  MAX_RECTS,
  MAX_TEXT,
  normalizeFind,
  parseMessage,
  type BridgeIn,
} from './bridge';
import { fakeFrame, fakeHost, ORIGIN, UID_A, UID_B } from './testing';

const known = (id: string) => id === UID_A;

function setup() {
  const { host, deliver } = fakeHost();
  const frame = fakeFrame();
  const got: BridgeIn[] = [];
  const warn = vi.fn();
  const client = new BridgeClient({
    host,
    origin: ORIGIN,
    frame: () => frame.win as unknown as Window,
    onMessage: (m) => got.push(m),
    warn,
  });
  client.attach();
  const send = (data: unknown, source: unknown = frame.win, origin = ORIGIN) => deliver(data, source, origin);
  return { client, frame, got, warn, send };
}

describe('parseMessage', () => {
  it('accepts the Phase 1 messages', () => {
    expect(parseMessage({ type: 'pdfcraft:ready', version: '0.9', bridge: 1 }, known)).toEqual({
      ok: true,
      msg: { type: 'pdfcraft:ready', version: '0.9', bridge: 1 },
    });
    expect(parseMessage({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 }, known).ok).toBe(true);
    expect(parseMessage({ type: 'pdfcraft:page', id: UID_A, page: 5 }, known).ok).toBe(true);
    expect(parseMessage({ type: 'pdfcraft:activity', id: UID_A }, known).ok).toBe(true);
    expect(parseMessage({ type: 'pdfcraft:theme', theme: 'dark' }, known).ok).toBe(true);
    expect(parseMessage({ type: 'pdfcraft:failed', error: 'x', id: UID_A }, known).ok).toBe(true);
    expect(parseMessage({ type: 'pdfcraft:save-failed', error: 'x', id: UID_A }, known).ok).toBe(true);
    // No tab at all (the fork sends page: null).
    expect(parseMessage({ type: 'pdfcraft:active', id: null, page: null, pageCount: 0 }, known).ok).toBe(true);
  });

  it('treats a ready without `bridge` as version 0 (unforked build)', () => {
    const r = parseMessage({ type: 'pdfcraft:ready', version: '0.9' }, known);
    expect(r).toEqual({ ok: true, msg: { type: 'pdfcraft:ready', version: '0.9', bridge: 0 } });
  });

  it('accepts a null id (document opened inside PdfCraft)', () => {
    expect(parseMessage({ type: 'pdfcraft:active', id: null }, known)).toEqual({
      ok: true,
      msg: { type: 'pdfcraft:active', id: null, page: 0, pageCount: 0 },
    });
    const buf = new ArrayBuffer(4);
    expect(parseMessage({ type: 'pdfcraft:save', id: null, name: 'x.pdf', saveAs: false, bytes: buf }, known)).toEqual({
      ok: true,
      msg: { type: 'pdfcraft:save', id: null, name: 'x.pdf', saveAs: false, bytes: buf },
    });
  });

  it.each([
    ['not an object', 'pdfcraft:ready'],
    ['unknown type', { type: 'pdfcraft:evil' }],
    ['no type', { id: UID_A }],
    ['malformed id', { type: 'pdfcraft:activity', id: 'ABC' }],
    ['uppercase id', { type: 'pdfcraft:activity', id: 'A'.repeat(64) }],
    ['id not opened', { type: 'pdfcraft:activity', id: UID_B }],
    ['negative page', { type: 'pdfcraft:page', id: UID_A, page: -1 }],
    ['fractional page', { type: 'pdfcraft:page', id: UID_A, page: 1.5 }],
    ['page past the end', { type: 'pdfcraft:active', id: UID_A, page: 12, pageCount: 12 }],
    ['page as string', { type: 'pdfcraft:active', id: UID_A, page: '1', pageCount: 12 }],
    ['bytes not a buffer', { type: 'pdfcraft:save', id: UID_A, name: 'a', saveAs: false, bytes: [1, 2] }],
    [
      'long name',
      { type: 'pdfcraft:save', id: UID_A, name: 'x'.repeat(513), saveAs: false, bytes: new ArrayBuffer(1) },
    ],
    ['saveAs missing', { type: 'pdfcraft:save', id: UID_A, name: 'a', bytes: new ArrayBuffer(1) }],
    ['bad theme', { type: 'pdfcraft:theme', theme: 'sepia' }],
    ['dirty not boolean', { type: 'pdfcraft:dirty', dirty: 'yes' }],
    ['dirty ids malformed', { type: 'pdfcraft:dirty', dirty: true, ids: ['zz'] }],
    ['bad bridge', { type: 'pdfcraft:ready', bridge: -1 }],
    ['save-failed without id', { type: 'pdfcraft:save-failed', error: 'x' }],
  ])('rejects %s', (_label, data) => {
    expect(parseMessage(data, known).ok).toBe(false);
  });

  it('rejects bytes over 2 GiB without reading them', () => {
    const huge = { byteLength: MAX_BYTES + 1, [Symbol.toStringTag]: 'ArrayBuffer' };
    expect(parseMessage({ type: 'pdfcraft:save', id: UID_A, name: 'a', saveAs: false, bytes: huge }, known).ok).toBe(
      false,
    );
  });

  it('accepts an ArrayBuffer from another realm', () => {
    const foreign = { byteLength: 3, [Symbol.toStringTag]: 'ArrayBuffer' };
    expect(parseMessage({ type: 'pdfcraft:save', id: UID_A, name: 'a', saveAs: false, bytes: foreign }, known).ok).toBe(
      true,
    );
  });

  it('keeps only opened ids in dirty', () => {
    expect(parseMessage({ type: 'pdfcraft:dirty', dirty: true, ids: [UID_A, UID_B] }, known)).toEqual({
      ok: true,
      msg: { type: 'pdfcraft:dirty', dirty: true, ids: [UID_A] },
    });
  });
});

const KEYS = new Set(['card', 'ai', 'define']);
const parse = (data: unknown) => parseMessage(data, known, KEYS);

describe('parseMessage · bridge v2', () => {
  const sel = { type: 'pdfcraft:selection', id: UID_A, page: 2, text: 'the windmill', rects: [[10, 20, 30.5, 12]] };
  const menu = { ...sel, type: 'pdfcraft:menu', key: 'card', anchor: [100, 200, 120, 24] };

  it('accepts a selection, an empty one (cleared) and one without rects', () => {
    expect(parse(sel)).toEqual({ ok: true, msg: sel });
    expect(parse({ ...sel, text: '', rects: [] })).toEqual({ ok: true, msg: { ...sel, text: '', rects: [] } });
    expect(parse({ type: 'pdfcraft:selection', id: UID_A, page: 0 })).toEqual({
      ok: true,
      msg: { type: 'pdfcraft:selection', id: UID_A, page: 0, text: '', rects: [] },
    });
    // A document PdfCraft opened by itself: parsed (the controller ignores it).
    expect(parse({ ...sel, id: null }).ok).toBe(true);
    expect(parse({ ...sel, text: 'x'.repeat(MAX_TEXT) }).ok).toBe(true);
    expect(parse({ ...sel, rects: Array.from({ length: MAX_RECTS }, () => [0, 0, 1, 1]) }).ok).toBe(true);
  });

  it.each([
    ['huge text', { ...sel, text: 'x'.repeat(MAX_TEXT + 1) }],
    ['text not a string', { ...sel, text: 42 }],
    ['NaN in a rect', { ...sel, rects: [[0, NaN, 1, 1]] }],
    ['Infinity in a rect', { ...sel, rects: [[0, 0, Infinity, 1]] }],
    ['negative width', { ...sel, rects: [[0, 0, -1, 1]] }],
    ['short rect', { ...sel, rects: [[0, 0, 1]] }],
    ['string in a rect', { ...sel, rects: [['0', 0, 1, 1]] }],
    ['rects not an array', { ...sel, rects: { 0: [0, 0, 1, 1] } }],
    ['too many rects', { ...sel, rects: Array.from({ length: MAX_RECTS + 1 }, () => [0, 0, 1, 1]) }],
    ['negative page', { ...sel, page: -1 }],
    ['fractional page', { ...sel, page: 1.5 }],
    ['unknown id', { ...sel, id: UID_B }],
    ['malformed id', { ...sel, id: 'abc' }],
  ])('rejects a selection with %s', (_n, data) => expect(parse(data).ok).toBe(false));

  it('accepts a menu click with or without an anchor', () => {
    expect(parse(menu)).toEqual({ ok: true, msg: menu });
    const { anchor: _a, ...noAnchor } = menu;
    expect(parse(noAnchor)).toEqual({ ok: true, msg: { ...noAnchor, anchor: null } });
    expect(parse({ ...menu, id: null }).ok).toBe(true);
  });

  it.each([
    ['an unknown key', { ...menu, key: 'evil' }],
    ['a key the app did not register', { ...menu, key: 'copy' }],
    ['no key', { ...menu, key: undefined }],
    ['huge text', { ...menu, text: 'x'.repeat(MAX_TEXT + 1) }],
    ['NaN rects', { ...menu, rects: [[NaN, 0, 1, 1]] }],
    ['a bad anchor', { ...menu, anchor: [0, 0, -5, 1] }],
    ['an unknown id', { ...menu, id: UID_B }],
  ])('rejects a menu click with %s', (_n, data) => expect(parse(data).ok).toBe(false));

  it('rejects every menu key when the app registered none', () => {
    expect(parseMessage(menu, known).ok).toBe(false);
  });

  it('accepts menu-shown with registered keys only', () => {
    const shown = { type: 'pdfcraft:menu-shown', id: UID_A, items: [{ key: 'card', rect: [1, 2, 3, 4] }] };
    expect(parse(shown)).toEqual({ ok: true, msg: shown });
    expect(parse({ ...shown, items: [] }).ok).toBe(true);
    expect(parse({ ...shown, items: [{ key: 'evil', rect: [1, 2, 3, 4] }] }).ok).toBe(false);
    expect(parse({ ...shown, items: [{ key: 'card', rect: [1, 2, NaN, 4] }] }).ok).toBe(false);
    expect(parse({ ...shown, items: 'card' }).ok).toBe(false);
    expect(parse({ ...shown, items: Array.from({ length: 17 }, () => shown.items[0]) }).ok).toBe(false);
  });

  it('accepts found results and rejects malformed ones', () => {
    const found = { type: 'pdfcraft:found', id: UID_A, page: 0, query: 'the windmill', found: true };
    expect(parse(found)).toEqual({ ok: true, msg: found });
    expect(parse({ ...found, found: 'yes' }).ok).toBe(false);
    expect(parse({ ...found, query: 7 }).ok).toBe(false);
    expect(parse({ ...found, query: 'x'.repeat(501) }).ok).toBe(false);
    expect(parse({ ...found, page: -2 }).ok).toBe(false);
    expect(parse({ ...found, id: UID_B }).ok).toBe(false);
  });

  it('accepts selection-sent with a whole seq or none', () => {
    expect(parse({ type: 'pdfcraft:selection-sent', seq: 3 })).toEqual({
      ok: true,
      msg: { type: 'pdfcraft:selection-sent', seq: 3 },
    });
    expect(parse({ type: 'pdfcraft:selection-sent', seq: null })).toMatchObject({ ok: true, msg: { seq: null } });
    expect(parse({ type: 'pdfcraft:selection-sent' })).toMatchObject({ ok: true, msg: { seq: null } });
    for (const seq of [-1, 1.5, '3', NaN]) expect(parse({ type: 'pdfcraft:selection-sent', seq }).ok).toBe(false);
  });
});

describe('marks (bridge 3)', () => {
  const marks = (id: string, set: string, page: number) =>
    id === UID_A && set === 'vocab' && page === 2 ? 3 : undefined;
  const parse = (data: unknown) => parseMessage(data, known, new Set(), marks);
  const click = { type: 'pdfcraft:mark-click', id: UID_A, set: 'vocab', index: 1, page: 2, rect: [10, 20, 30, 4] };

  it('needs bridge 3', () => {
    expect(MIN_BRIDGE).toBe(3);
  });

  it('accepts a click on a mark the app sent', () => {
    expect(parse(click)).toEqual({ ok: true, msg: click });
    expect(parse({ ...click, index: 2 }).ok).toBe(true);
  });

  it.each([
    ['no id', { ...click, id: null }],
    ['unknown id', { ...click, id: UID_B }],
    ['unknown set', { ...click, set: 'other' }],
    ['malformed set', { ...click, set: 'Vocab!' }],
    ['set as number', { ...click, set: 3 }],
    ['page without marks', { ...click, page: 1 }],
    ['index past the page marks', { ...click, index: 3 }],
    ['negative index', { ...click, index: -1 }],
    ['fractional index', { ...click, index: 0.5 }],
    ['index as string', { ...click, index: '1' }],
    ['NaN in the rect', { ...click, rect: [NaN, 0, 1, 1] }],
    ['infinite rect', { ...click, rect: [0, Infinity, 1, 1] }],
    ['negative size', { ...click, rect: [0, 0, -1, 1] }],
    ['short rect', { ...click, rect: [0, 0, 1] }],
    ['no rect', { ...click, rect: undefined }],
  ])('drops a mark-click with %s', (_why, data) => {
    expect(parse(data).ok).toBe(false);
  });

  it('drops every mark-click while no marks were sent', () => {
    expect(parseMessage(click, known).ok).toBe(false);
  });

  it('accepts marks-shown and rejects malformed ones', () => {
    const shown = { type: 'pdfcraft:marks-shown', id: UID_A, set: 'vocab', page: 2, count: 3 };
    expect(parse(shown)).toEqual({ ok: true, msg: shown });
    expect(parse({ ...shown, count: -1 }).ok).toBe(false);
    expect(parse({ ...shown, id: null }).ok).toBe(false);
  });

  it('posts marks grouped by page with the underline style, and remembers them for clicks', () => {
    const { client, frame, got, send } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0 });
    const ok = client.sendMarks(UID_A, 'vocab', [
      {
        page: 2,
        marks: [
          { rects: [[1, 2, 3, 4]], color: '#D85A30' },
          { rects: [[5, 6, 7, 8], [NaN, 0, 1, 1] as never], color: '#ba7517' },
        ],
      },
      { page: 3, marks: [] },
    ]);
    expect(ok).toBe(true);
    expect(frame.posted.at(-1)!.msg).toEqual({
      type: 'pdfcraft:marks',
      id: UID_A,
      set: 'vocab',
      marks: [
        { page: 2, rects: [[1, 2, 3, 4]], style: 'underline', color: '#d85a30' },
        { page: 2, rects: [[5, 6, 7, 8]], style: 'underline', color: '#ba7517' },
        // An empty page: one entry without rects clears it in PdfCraft.
        { page: 3, rects: [], style: 'underline', color: '#000000' },
      ],
    });
    expect(client.markCount(UID_A, 'vocab', 2)).toBe(2);
    expect(client.markCount(UID_A, 'vocab', 3)).toBeUndefined();
    send({ type: 'pdfcraft:mark-click', id: UID_A, set: 'vocab', index: 1, page: 2, rect: [1, 1, 1, 1] });
    send({ type: 'pdfcraft:mark-click', id: UID_A, set: 'vocab', index: 2, page: 2, rect: [1, 1, 1, 1] });
    expect(got.filter((m) => m.type === 'pdfcraft:mark-click')).toHaveLength(1);

    // Clearing forgets them: later clicks are dropped.
    expect(client.clearMarks(UID_A, 'vocab')).toBe(true);
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:clear-marks', id: UID_A, set: 'vocab' });
    expect(client.markCount(UID_A, 'vocab', 2)).toBeUndefined();
  });

  it('caps pages, rects per mark, and refuses documents it did not open or bad sets', () => {
    const { client, frame } = setup();
    expect(client.sendMarks(UID_A, 'vocab', [{ page: 0, marks: [{ rects: [[0, 0, 1, 1]], color: '#d85a30' }] }])).toBe(
      false,
    );
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0 });
    expect(client.sendMarks(UID_A, 'Bad Set', [{ page: 0, marks: [] }])).toBe(false);
    const many = Array.from({ length: MAX_MARK_PAGES + 5 }, (_, page) => ({
      page,
      marks: [
        {
          rects: Array.from({ length: 12 }, (_, i) => [i, 0, 1, 1] as [number, number, number, number]),
          color: '#d85a30',
        },
      ],
    }));
    client.sendMarks(UID_A, 'vocab', many);
    const sent = frame.posted.at(-1)!.msg as { marks: { page: number; rects: unknown[] }[] };
    expect(new Set(sent.marks.map((m) => m.page)).size).toBe(MAX_MARK_PAGES);
    expect(sent.marks.every((m) => m.rects.length === MAX_MARK_RECTS)).toBe(true);
  });

  it('forgets the marks of a reload or a closed document', () => {
    const { client } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0 });
    client.sendMarks(UID_A, 'vocab', [{ page: 0, marks: [{ rects: [[0, 0, 1, 1]], color: '#d85a30' }] }]);
    expect(client.markCount(UID_A, 'vocab', 0)).toBe(1);
    client.reset();
    expect(client.markCount(UID_A, 'vocab', 0)).toBeUndefined();
  });
});

describe('normalizeFind', () => {
  it('collapses whitespace and drops empty text', () => {
    expect(normalizeFind('  the\n windmill\t ')).toBe('the windmill');
    expect(normalizeFind('   ')).toBeNull();
    expect(normalizeFind(null)).toBeNull();
    expect(normalizeFind(undefined)).toBeNull();
    expect(normalizeFind('x'.repeat(900))).toHaveLength(500);
  });
});

describe('BridgeClient', () => {
  it('only hears its iframe on its own origin', () => {
    const { client, got, warn, send } = setup();
    send({ type: 'pdfcraft:ready', bridge: 1 }, {}, ORIGIN);
    send({ type: 'pdfcraft:ready', bridge: 1 }, undefined, 'https://evil.example');
    expect(got).toEqual([]);
    expect(client.state.ready).toBe(false);
    send({ type: 'pdfcraft:ready', bridge: 1 });
    expect(got).toHaveLength(1);
    expect(client.state.ready).toBe(true);
    expect(client.state.bridge).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops invalid messages with a warning', () => {
    const { got, warn, send } = setup();
    send({ type: 'pdfcraft:activity', id: UID_A });
    send({ type: 'pdfcraft:nope' });
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/id not opened/);
  });

  it('posts open with the id, page and Info key, transferring the bytes', () => {
    const { client, frame } = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(client.open({ id: UID_A, name: 'Livro.pdf', bytes, page: 4 })).toBe(true);
    const sent = frame.posted[0]!;
    expect(sent.msg).toMatchObject({ type: 'pdfcraft:open', name: 'Livro.pdf', id: UID_A, page: 4, infoKey: INFO_KEY });
    expect(new Uint8Array(sent.msg.bytes as ArrayBuffer)).toEqual(bytes);
    expect(sent.opts).toEqual({ targetOrigin: ORIGIN, transfer: [sent.msg.bytes] });
    expect(client.isOpen(UID_A)).toBe(true);
  });

  it('leaves page 0 out so PdfCraft opens the file at its usual first view', () => {
    const { client, frame } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0 });
    expect(frame.posted[0]!.msg).not.toHaveProperty('page');
  });

  it('sends page 0 when asked to go to it (a tab already open)', () => {
    const { client, frame } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0, goto: true });
    expect(frame.posted[0]!.msg).toMatchObject({ type: 'pdfcraft:open', id: UID_A, page: 0 });
  });

  it('copies a view instead of transferring a shared buffer', () => {
    const { client, frame } = setup();
    const backing = new Uint8Array([9, 9, 1, 2, 9]);
    client.open({ id: UID_A, name: 'a.pdf', bytes: backing.subarray(2, 4), page: 0 });
    const buf = frame.posted[0]!.msg.bytes as ArrayBuffer;
    expect(buf).not.toBe(backing.buffer);
    expect([...new Uint8Array(buf)]).toEqual([1, 2]);
  });

  it('tracks active, page, dirty and theme', () => {
    const { client, send } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0 });
    send({ type: 'pdfcraft:active', id: UID_A, page: 4, pageCount: 12 });
    send({ type: 'pdfcraft:page', id: UID_A, page: 6 });
    send({ type: 'pdfcraft:dirty', dirty: true, ids: [UID_A] });
    send({ type: 'pdfcraft:theme', theme: 'dark' });
    const s = client.state;
    expect(s.activeId).toBe(UID_A);
    expect(s.page).toBe(6);
    expect(s.pageCount).toBe(12);
    expect([...s.dirtyIds]).toEqual([UID_A]);
    expect(s.theme).toBe('dark');
    send({ type: 'pdfcraft:dirty', dirty: false, ids: [] });
    expect(client.state.dirtyIds.size).toBe(0);
  });

  it('assumes the active document for an unextended dirty', () => {
    const { client, send } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0 });
    send({ type: 'pdfcraft:active', id: UID_A, page: 0, pageCount: 2 });
    send({ type: 'pdfcraft:dirty', dirty: true });
    expect([...client.state.dirtyIds]).toEqual([UID_A]);
  });

  it('forgets an id PdfCraft failed to open', () => {
    const { client, send } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new Uint8Array(1), page: 0 });
    send({ type: 'pdfcraft:failed', id: UID_A, error: 'not a PDF' });
    expect(client.isOpen(UID_A)).toBe(false);
  });

  it('posts request-save', () => {
    const { client, frame } = setup();
    client.requestSave(UID_A);
    expect(frame.posted[0]!.msg).toEqual({ type: 'pdfcraft:request-save', id: UID_A });
  });

  it('stops listening after detach', () => {
    const { client, got, send } = setup();
    client.detach();
    send({ type: 'pdfcraft:ready', bridge: 1 });
    expect(got).toEqual([]);
  });

  it('registers menu items (validating keys) and drops clicks on other keys', () => {
    const { client, frame, got, send } = setup();
    client.open({ id: UID_A, name: 'a.pdf', bytes: new ArrayBuffer(1), page: 0 });
    expect(
      client.setMenuItems([
        { key: 'card', label: 'Criar card' },
        { key: 'Bad Key', label: 'x' },
      ]),
    ).toBe(true);
    expect(frame.posted.at(-1)!.msg).toEqual({
      type: 'pdfcraft:menu-items',
      items: [{ key: 'card', label: 'Criar card' }],
    });
    const click = { type: 'pdfcraft:menu', id: UID_A, page: 0, text: 'x', rects: [] };
    send({ ...click, key: 'card' });
    send({ ...click, key: 'ai' });
    expect(got.map((m) => m.type)).toEqual(['pdfcraft:menu']);
  });

  it('posts goto with a normalized find, or without find', () => {
    const { client, frame } = setup();
    client.goto(UID_A, 3.7, '  the\nwindmill ');
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 3, find: 'the windmill' });
    client.goto(UID_A, -2, '   ');
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:goto', id: UID_A, page: 0 });
  });

  it('posts selection-now with its seq', () => {
    const { client, frame } = setup();
    expect(client.selectionNow(4)).toBe(true);
    expect(frame.posted.at(-1)!.msg).toEqual({ type: 'pdfcraft:selection-now', seq: 4 });
  });
});
