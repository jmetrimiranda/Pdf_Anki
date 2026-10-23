import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, useToast } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import type { AnkiPageEvent } from '../../../lib/core/types';
import { useTheme } from '../../../lib/theme';

/** How long the page has to say `loaded` before the frame shows an error. */
export const PAGE_LOAD_TIMEOUT_MS = 15_000;

const SOURCE = 'leitor-anki-page';

/**
 * `scheme://host[:port]` of a URL. `new URL(…).origin` is "null" for non-special schemes such as `anki://`, while
 * WebKit reports `anki://localhost` as the origin of messages from those pages, so it is rebuilt by hand.
 */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** The search of a graphs-page `bridgeCommand("browserSearch: <search>")` (desktop: qt/aqt/stats.py), or null. */
export function browserSearchOf(cmd: string): string | null {
  if (!cmd.startsWith('browserSearch')) return null;
  const i = cmd.indexOf(':');
  return i < 0 ? '' : cmd.slice(i + 1).trim();
}

type PageMessage = { t: 'bridgeCommand'; cmd: string } | { t: 'close' } | { t: 'loaded' };

function asPageMessage(data: unknown): PageMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as { source?: unknown; t?: unknown; cmd?: unknown };
  if (m.source !== SOURCE) return null;
  if (m.t === 'bridgeCommand') return typeof m.cmd === 'string' ? { t: 'bridgeCommand', cmd: m.cmd } : null;
  if (m.t === 'close') return { t: 'close' };
  if (m.t === 'loaded') return { t: 'loaded' };
  return null;
}

/**
 * One of Anki's own SvelteKit pages (deck options, statistics, import…, spec 8.3) in a frame on the `anki`
 * origin. That origin is not the app's, so `allow-same-origin` keeps the page's own origin (SvelteKit needs it)
 * without giving it the app's `invoke`. Messages are accepted only from that origin and that frame's window.
 */
export function AnkiWebPage({
  route,
  title,
  onClose,
  bare = false,
}: {
  route: string;
  title: string;
  onClose: () => void;
  /** Without the page's own header (title + "Fechar"): the host shows the title and the back action. */
  bare?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [theme] = useTheme();
  const night = theme === 'dark';
  // The `#night` hash is only read at load; later theme changes go through {t:'theme'} (no reload).
  const [src] = useState(() => core.ankiPageUrl(route, night));
  const [pageOrigin] = useState(() => originOf(core.ankiPageUrl('', false)));
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = useRef(false);
  const closing = useRef(false);
  const closed = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  function close() {
    if (closed.current) return;
    closed.current = true;
    onCloseRef.current();
  }

  function post(msg: Record<string, unknown>) {
    // Nothing secret travels to the page; '*' because a custom-scheme origin cannot be a target origin.
    frame.current?.contentWindow?.postMessage(msg, '*');
  }

  // Page → host messages (page-bridge.js).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== pageOrigin || !frame.current || e.source !== frame.current.contentWindow) return;
      const msg = asPageMessage(e.data);
      if (!msg) return;
      if (msg.t === 'loaded') {
        setLoaded(true);
        setFailed(false);
      } else if (msg.t === 'close') {
        close();
      } else {
        const search = browserSearchOf(msg.cmd);
        if (search !== null) {
          void navigate({ to: '/anki/navegar', search: { busca: search } });
        } else if (msg.cmd === 'unbury' || msg.cmd === 'customStudy') {
          toast.show(t('anki.page.notYet'));
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pageOrigin, navigate, toast]);

  // Core → host events for the Anki pages (`anki://page`).
  useEffect(
    () =>
      core.onAnkiPageEvent((e: AnkiPageEvent) => {
        switch (e.kind) {
          case 'ready':
            ready.current = true;
            break;
          case 'close':
            close();
            break;
          case 'importDone':
          case 'changed':
            void queryClient.invalidateQueries({ queryKey: ['anki'] });
            break;
          case 'searchInBrowser':
            void navigate({ to: '/anki/navegar', search: { busca: e.search } });
            break;
          case 'error':
            toast.show(e.message, { tone: 'error' });
            break;
          case 'openLink':
            break;
        }
      }),
    [queryClient, navigate, toast],
  );

  // The app theme follows into the page.
  const firstTheme = useRef(true);
  useEffect(() => {
    if (firstTheme.current) {
      firstTheme.current = false;
      return;
    }
    if (loaded) post({ t: 'theme', night });
  }, [night, loaded]);

  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => setFailed(true), PAGE_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loaded]);

  /** "Fechar": once the page is ready it decides (deck options may ask about unsaved changes); a second click closes. */
  function requestClose() {
    if (ready.current && loaded && !closing.current) {
      closing.current = true;
      post({ t: 'requestClose' });
      return;
    }
    close();
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={title}>
      {!bare && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
          <Button variant="ghost" size="sm" icon={X} onClick={requestClose}>
            {t('common.close')}
          </Button>
        </header>
      )}
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={frame}
          src={src}
          title={title}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
          className="absolute inset-0 size-full border-0 bg-card"
        />
        {!loaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg text-base text-muted">
            {failed ? (
              <>
                <AlertCircle size={22} className="text-error" aria-hidden />
                <p role="alert">{t('anki.page.loadFailed')}</p>
                <Button variant="neutral" onClick={close}>
                  {t('common.close')}
                </Button>
              </>
            ) : (
              <>
                <Spinner label={t('anki.page.loading')} />
                <span aria-hidden>{t('anki.page.loading')}</span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
