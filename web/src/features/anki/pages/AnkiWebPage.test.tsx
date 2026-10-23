import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/ui';
import { mockHandle } from '../../../lib/core/mock';
import { installDomStubs } from '../../../lib/testing/dom';
import { AnkiWebPage, browserSearchOf, originOf } from './AnkiWebPage';
import { ankiPageRoute, ankiPathPage } from './routes';

beforeAll(() => installDomStubs());
beforeEach(() => mockHandle.reset());

const onClose = vi.fn();
const queryClient = new QueryClient();

function renderPage(route = 'deck-options/42', bare = false) {
  onClose.mockClear();
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <AnkiWebPage route={route} title="Opções do deck" onClose={onClose} bare={bare} />,
  });
  const browse = createRoute({
    getParentRoute: () => root,
    path: '/anki/navegar',
    validateSearch: (s: Record<string, unknown>) => ({ busca: String(s.busca ?? '') }),
    component: function Browse() {
      return <p data-testid="browse">{browse.useSearch().busca}</p>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([page, browse]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function frame(): Promise<HTMLIFrameElement> {
  return (await screen.findByTitle('Opções do deck')) as HTMLIFrameElement;
}

const ORIGIN = window.location.origin;

function fromPage(f: HTMLIFrameElement, data: unknown, opts: { origin?: string; source?: Window | null } = {}) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: opts.origin ?? ORIGIN,
        source: opts.source === undefined ? f.contentWindow : opts.source,
      }),
    );
  });
}

const msg = (t: string, extra: Record<string, unknown> = {}) => ({ source: 'leitor-anki-page', t, ...extra });

describe('AnkiWebPage', () => {
  it('loads the Anki route in a sandboxed frame on the anki origin', async () => {
    renderPage();
    const f = await frame();
    expect(f.getAttribute('src')).toBe(`${ORIGIN}/__mock-anki-page/deck-options/42`);
    expect(f.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-modals allow-downloads');
    expect(screen.getByRole('status', { name: 'Abrindo a página do Anki…' })).toBeTruthy();
  });

  it('bare: no own header (title and "Fechar" are the host\'s)', async () => {
    renderPage('congrats', true);
    await frame();
    expect(screen.queryByRole('heading', { name: 'Opções do deck' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fechar' })).toBeNull();
  });

  it('ignores messages from another origin or another window', async () => {
    renderPage();
    const f = await frame();
    fromPage(f, msg('loaded'), { origin: 'http://evil.example' });
    fromPage(f, msg('loaded'), { source: window });
    fromPage(f, msg('close'), { origin: 'http://evil.example' });
    fromPage(f, { t: 'close' });
    expect(screen.getByRole('status', { name: 'Abrindo a página do Anki…' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fromPage(f, msg('loaded'));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Abrindo a página do Anki…' })).toBeNull());
  });

  it('"Fechar" closes directly until the page is ready, then asks the page', async () => {
    renderPage();
    const f = await frame();
    const post = vi.spyOn(f.contentWindow!, 'postMessage');
    fromPage(f, msg('loaded'));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalledWith({ t: 'requestClose' }, '*');
  });

  it('after Ready, "Fechar" posts requestClose and the Close event closes', async () => {
    renderPage();
    const f = await frame();
    const post = vi.spyOn(f.contentWindow!, 'postMessage');
    fromPage(f, msg('loaded'));
    act(() => mockHandle.anki.firePageEvent({ kind: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(post).toHaveBeenCalledWith({ t: 'requestClose' }, '*');
    expect(onClose).not.toHaveBeenCalled();
    act(() => mockHandle.anki.firePageEvent({ kind: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a close message from the page (Escape) closes', async () => {
    renderPage();
    const f = await frame();
    fromPage(f, msg('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('SearchInBrowser and the graphs bridgeCommand open Navegar with the search', async () => {
    const router = renderPage('graphs');
    await screen.findByTitle('Opções do deck');
    act(() => mockHandle.anki.firePageEvent({ kind: 'searchInBrowser', search: 'deck:Oxford' }));
    expect((await screen.findByTestId('browse')).textContent).toBe('deck:Oxford');
    expect(router.state.location.pathname).toBe('/anki/navegar');
  });

  it('the graphs page bridgeCommand("browserSearch: …") navigates too', async () => {
    renderPage('graphs');
    const f = await frame();
    fromPage(f, msg('bridgeCommand', { cmd: 'browserSearch: deck:current is:due' }));
    expect((await screen.findByTestId('browse')).textContent).toBe('deck:current is:due');
  });

  it('shows an error when the page never loads', async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_100);
      });
      expect(screen.getByRole('alert').textContent).toBe('A página do Anki não carregou.');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Anki page routes', () => {
  it('rebuilds the origin of custom-scheme URLs', () => {
    expect(originOf('anki://localhost/graphs')).toBe('anki://localhost');
    expect(originOf('http://anki.localhost/graphs')).toBe('http://anki.localhost');
  });

  it('parses the graphs search command', () => {
    expect(browserSearchOf('browserSearch: deck:x rated:1')).toBe('deck:x rated:1');
    expect(browserSearchOf('unbury')).toBeNull();
  });

  it('allows only the pages opened through /anki/pagina, with paths as one encoded segment', () => {
    expect(ankiPageRoute('congrats')).toBe('congrats');
    expect(ankiPageRoute('change-notetype/12')).toBe('change-notetype/12');
    expect(ankiPageRoute('change-notetype/12/34')).toBe('change-notetype/12/34');
    const encoded = ankiPathPage('import-anki-package', '/home/jorge/Vocab ção.apkg');
    expect(encoded).toBe('import-anki-package/%2Fhome%2Fjorge%2FVocab%20%C3%A7%C3%A3o.apkg');
    expect(ankiPageRoute(encoded)).toBe(encoded);
    expect(ankiPageRoute('import-anki-package//home/jorge/Vocab ção.apkg')).toBe(encoded);
    expect(ankiPageRoute('image-occlusion/%2Ftmp%2Fa.png')).toBe('image-occlusion/%2Ftmp%2Fa.png');
    expect(ankiPageRoute('preferences')).toBeNull();
    expect(ankiPageRoute('change-notetype/abc')).toBeNull();
    expect(ankiPageRoute('import-anki-package/')).toBeNull();
  });
});
