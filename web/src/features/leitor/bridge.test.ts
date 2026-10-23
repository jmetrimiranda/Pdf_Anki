import { describe, expect, it, vi } from 'vitest';
import { BridgeClient, INFO_KEY, MAX_BYTES, parseMessage, type BridgeIn } from './bridge';
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
});
