// Test helpers for screens with a CardFrame (Vitest + jsdom): a stand-in window for the card iframe that records what
// the host posts to it, and a way to send shim messages from it.
import { act, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { HostToCard } from './CardFrame';

export interface FakeCardWindow {
  posted: HostToCard[];
  postMessage: (m: unknown) => void;
  focus: () => void;
}

const fakeWindows = new WeakMap<HTMLIFrameElement, FakeCardWindow>();

export function fakeWindowOf(iframe: HTMLIFrameElement): FakeCardWindow {
  let w = fakeWindows.get(iframe);
  if (!w) {
    const posted: HostToCard[] = [];
    w = { posted, postMessage: (m) => void posted.push(m as HostToCard), focus: () => {} };
    fakeWindows.set(iframe, w);
  }
  return w;
}

/** Call in `beforeEach` (jsdom's own frame windows come and go as it "navigates"). */
export function stubCardFrameWindows(): void {
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (this: HTMLIFrameElement) {
    return fakeWindowOf(this) as unknown as WindowProxy;
  });
}

/** The card iframe, what the host posted to it, and a way to send shim messages from it. */
export async function cardFrame(title = 'Card') {
  const iframe = (await screen.findByTitle(title)) as HTMLIFrameElement;
  const win = fakeWindowOf(iframe);
  const send = (data: unknown, origin = 'null', source: unknown = win) =>
    act(() => {
      const ev = new Event('message');
      Object.defineProperties(ev, { data: { value: data }, origin: { value: origin }, source: { value: source } });
      window.dispatchEvent(ev);
    });
  return {
    iframe,
    posted: win.posted,
    send,
    count: (t: HostToCard['t']) => win.posted.filter((m) => m.t === t).length,
    last: <T extends HostToCard['t']>(t: T) => win.posted.filter((m) => m.t === t).at(-1),
  };
}
