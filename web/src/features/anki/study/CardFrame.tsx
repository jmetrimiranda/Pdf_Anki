// The card iframe (spec 8.4): reviewer.html on the `card` origin, sandboxed with ONLY `allow-scripts` (opaque origin:
// no app IPC, no storage, no access to the parent). It talks to the study screen through card-bridge.js with the
// messages below; anything else, or anything from another window, is dropped.
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

/** Card shim → host (contract §D). */
export type CardToHost =
  | { t: 'ready' }
  | { t: 'pycmd'; cmd: string; id: number }
  | { t: 'typed'; v: string }
  | { t: 'key'; key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
  | { t: 'link'; href: string }
  | { t: 'shown' };

/** Host → card shim (contract §D). */
export type HostToCard =
  | { t: 'showQuestion'; q: string; a: string; bodyclass: string }
  | { t: 'showAnswer'; a: string }
  | { t: 'flag'; flag: number }
  | { t: 'mark'; mark: boolean }
  | { t: 'getTypedAnswer' }
  | { t: 'mutateStates'; key: string; js: string }
  | { t: 'theme'; night: boolean }
  | { t: 'cb'; id: number; v: unknown };

const MAX_TEXT = 100_000;

const str = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
const bool = (v: unknown): v is boolean => typeof v === 'boolean';

/** Validates a message from the card frame (its content is untrusted: deck templates run there). */
export function parseCardMessage(data: unknown): CardToHost | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case 'ready':
    case 'shown':
      return { t: m.t };
    case 'pycmd':
      return str(m.cmd, 2_000) && typeof m.id === 'number' && Number.isInteger(m.id)
        ? { t: 'pycmd', cmd: m.cmd, id: m.id }
        : null;
    case 'typed':
      return str(m.v) ? { t: 'typed', v: m.v } : null;
    case 'key':
      return str(m.key, 32) &&
        (m.code === undefined || str(m.code, 32)) &&
        bool(m.ctrl) &&
        bool(m.shift) &&
        bool(m.alt) &&
        bool(m.meta)
        ? {
            t: 'key',
            key: m.key,
            code: typeof m.code === 'string' ? m.code : '',
            ctrl: m.ctrl,
            shift: m.shift,
            alt: m.alt,
            meta: m.meta,
          }
        : null;
    case 'link':
      return str(m.href, 4_000) ? { t: 'link', href: m.href } : null;
    default:
      return null;
  }
}

export interface CardFrameHandle {
  post(msg: HostToCard): void;
  /** Moves the keyboard focus into the card (type-in-the-answer). */
  focus(): void;
}

export const CardFrame = forwardRef<
  CardFrameHandle,
  { src: string; title: string; onMessage: (m: CardToHost) => void; className?: string }
>(function CardFrame({ src, title, onMessage, className }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  // Loaded once per study session: the src never changes while the screen is mounted.
  const [initialSrc] = useState(src);

  useImperativeHandle(ref, () => ({
    post(msg) {
      // The frame's origin is opaque ("null"), so it cannot be named as the target; nothing secret is sent.
      frame.current?.contentWindow?.postMessage(msg, '*');
    },
    focus() {
      frame.current?.focus();
      frame.current?.contentWindow?.focus();
    },
  }));

  // `ready` is reported once: by the shim, or by the frame's load event if the shim's message was missed.
  const ready = useRef(false);

  // A layout effect: listening before the browser can run the frame's scripts.
  useLayoutEffect(() => {
    function listener(e: MessageEvent) {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== 'null') return;
      const msg = parseCardMessage(e.data);
      if (!msg) return;
      if (msg.t === 'ready') {
        if (ready.current) return;
        ready.current = true;
      }
      handler.current(msg);
    }
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  return (
    <iframe
      ref={frame}
      src={initialSrc}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={className}
      onLoad={() => {
        if (ready.current || !frame.current?.contentWindow) return;
        ready.current = true;
        handler.current({ t: 'ready' });
      }}
    />
  );
});
