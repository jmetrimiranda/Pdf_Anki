import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { core } from '../../../lib/core/client';
import { mockHandle } from '../../../lib/core/mock';
import { animalFarmUid, deckByName } from '../../../lib/core/mock/ankiData';
import { resetStudyMock } from '../../../lib/core/mock/ankiStudy';
import { installDomStubs } from '../../../lib/testing/dom';
import type { HostToCard } from './CardFrame';
import { cardBodyClass, platformClass, StudyPage } from './StudyPage';

const leitorMock = vi.hoisted(() => ({
  openBook: vi.fn(async (_uid: string, _opts?: { page?: number; find?: string }) => true),
  setReviewing: vi.fn(),
  togglePanel: vi.fn(),
  flushSaves: vi.fn(async () => true),
}));
vi.mock('../../leitor', () => ({ leitor: leitorMock, LeitorHost: () => null }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

const editor = vi.hoisted(() => ({ calls: [] as { noteId: number | null; open: boolean }[] }));
vi.mock('../editor/NoteEditorDialog', () => ({
  NoteEditorDialog: (p: { noteId: number | null; open: boolean }) => {
    editor.calls.push({ noteId: p.noteId, open: p.open });
    return p.open ? <div role="dialog" aria-label="editor" data-note={p.noteId} /> : null;
  },
}));
vi.mock('../pages/AnkiWebPage', () => ({
  AnkiWebPage: (p: { route: string; bare?: boolean }) => (
    <div data-testid="anki-web-page" data-bare={String(Boolean(p.bare))}>
      {p.route}
    </div>
  ),
}));

beforeAll(() => installDomStubs());
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(core, 'cardFrameUrl').mockReturnValue('about:blank');
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (this: HTMLIFrameElement) {
    return fakeWindowOf(this) as unknown as WindowProxy;
  });
  mockHandle.reset();
  resetStudyMock();
  leitorMock.openBook.mockClear();
  navigate.mockClear();
  editor.calls = [];
});

function renderStudy(props: Parameters<typeof StudyPage>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <StudyPage {...props} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Stand-in for the card frame's window (jsdom's own frame windows come and go as it "navigates"). */
interface FakeCardWindow {
  posted: HostToCard[];
  postMessage: (m: unknown) => void;
  focus: () => void;
}
const fakeWindows = new WeakMap<HTMLIFrameElement, FakeCardWindow>();

function fakeWindowOf(iframe: HTMLIFrameElement): FakeCardWindow {
  let w = fakeWindows.get(iframe);
  if (!w) {
    const posted: HostToCard[] = [];
    w = { posted, postMessage: (m) => void posted.push(m as HostToCard), focus: () => {} };
    fakeWindows.set(iframe, w);
  }
  return w;
}

/** The card iframe, what the page posted to it, and a way to send shim messages from it. */
async function cardFrame() {
  const iframe = (await screen.findByTitle('Card')) as HTMLIFrameElement;
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
    last: <T extends HostToCard['t']>(t: T) => win.posted.filter((m) => m.t === t).at(-1),
  };
}

const deckId = (name: string) => deckByName(name)!.id;
const counts = () => screen.getByTestId('study-counts').textContent?.replace(/\s+/g, ' ').trim();

describe('StudyPage', () => {
  it('question → answer → Bom → next card, with counts and the answer logged', async () => {
    const user = userEvent.setup();
    renderStudy({ deckId: deckId('5000 palavras') });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    const q1 = f.last('showQuestion')!;
    expect(q1).toMatchObject({ t: 'showQuestion' });
    if (q1.t === 'showQuestion') expect(q1.bodyclass).toMatch(/^card card1 is(Lin|Win|Mac) fancy$/);
    expect(f.last('theme')).toEqual({ t: 'theme', night: false });
    expect(counts()).toBe('3 + 1 + 3');
    // Screen readers: a live status with the sentence (the colored digits are hidden from them).
    const live = screen.getByTestId('study-counts-sr');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toBe('3 novos, 1 aprendendo, 3 para revisar');
    expect(screen.getByTestId('study-counts').getAttribute('aria-hidden')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Mostrar resposta' }));
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    const buttons = ['De novo', 'Difícil', 'Bom', 'Fácil'].map((n) =>
      screen.getByRole('button', { name: new RegExp(`^${n}`) }),
    );
    expect(buttons).toHaveLength(4);
    expect(screen.getByTestId('interval-3').textContent).not.toBe('');

    await user.click(screen.getByRole('button', { name: /^Bom/ }));
    await waitFor(() => expect(f.posted.filter((m) => m.t === 'showQuestion')).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Mostrar resposta' })).toBeTruthy();
    expect(counts()).not.toBe('3 + 1 + 3');
    const answers = mockHandle.anki.logs.filter((l) => l.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ rating: 3 });
    expect(typeof answers[0]!.ms).toBe('number');
  });

  it("custom scheduling JS: waits for this card's statesMutated, then shows the answer side's labels", async () => {
    const user = userEvent.setup();
    const realNext = core.ankiStudyNext.bind(core);
    vi.spyOn(core, 'ankiStudyNext').mockImplementation(async (id) => {
      const next = await realNext(id);
      if (next.kind !== 'card') return next;
      return { ...next, card: { ...next.card, stateMutation: { key: '42', js: 'states.good = states.easy;' } } };
    });
    const realShow = core.ankiShowAnswer.bind(core);
    const show = vi.spyOn(core, 'ankiShowAnswer').mockImplementation(async (cardId, typed) => ({
      ...(await realShow(cardId, typed)),
      buttons: ['<1min(s)', '<6min(s)', '4dia(s)', '4dia(s)'],
    }));
    renderStudy({ deckId: deckId('Oxford::Oxford 3000') });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() =>
      expect(f.last('mutateStates')).toEqual({ t: 'mutateStates', key: '42', js: expect.any(String) }),
    );

    await user.click(screen.getByRole('button', { name: 'Mostrar resposta' }));
    // A late report from another card does not count.
    await f.send({ t: 'pycmd', cmd: 'statesMutated:7', id: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(show).not.toHaveBeenCalled();
    expect(f.last('showAnswer')).toBeUndefined();

    await f.send({ t: 'pycmd', cmd: 'statesMutated:42', id: 0 });
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    expect(show).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('interval-3').textContent).toBe('4dia(s)');
    expect((screen.getByRole('button', { name: /^Bom/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keys: Space shows the answer, 3 answers, Ctrl+Z undoes only after an answer', async () => {
    renderStudy({ deckId: deckId('Oxford::Oxford 3000') });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    const undo = screen.getByRole('button', { name: 'Desfazer resposta' });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    const first = f.last('showQuestion');
    fireEvent.keyDown(window, { key: '3' });
    await waitFor(() => expect(f.posted.filter((m) => m.t === 'showQuestion')).toHaveLength(2));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Desfazer resposta' }) as HTMLButtonElement).disabled).toBe(false),
    );
    // A key forwarded by the card shim works the same way.
    await f.send({ t: 'key', key: 'z', code: 'KeyZ', ctrl: true, shift: false, alt: false, meta: false });
    await waitFor(() => expect(f.posted.filter((m) => m.t === 'showQuestion')).toHaveLength(3));
    expect(f.last('showQuestion')).toEqual(first);
    expect(mockHandle.anki.logs.filter((l) => l.kind === 'undo')).toHaveLength(1);
  });

  it('pycmd from the card: ans shows the answer (asking for the typed text first), ease answers', async () => {
    renderStudy({ deckId: deckId('ROS 2 — Revisão') });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    const q = f.last('showQuestion');
    expect(q && q.t === 'showQuestion' && q.q).toContain('id=typeans');
    await f.send({ t: 'pycmd', cmd: 'ans', id: 0 });
    await waitFor(() => expect(f.last('getTypedAnswer')).toBeTruthy());
    await f.send({ t: 'typed', v: 'ros2 run tf2_ros tf2_echo world turtle1' });
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    const a = f.last('showAnswer');
    expect(a && a.t === 'showAnswer' && a.a).toContain('typeGood');
    await f.send({ t: 'pycmd', cmd: 'ease4', id: 0 });
    await waitFor(() => expect(mockHandle.anki.logs.filter((l) => l.kind === 'answer')).toHaveLength(1));
    expect(mockHandle.anki.logs.find((l) => l.kind === 'answer')).toMatchObject({ rating: 4 });
  });

  it('drops messages that are not from the card frame', async () => {
    renderStudy({ deckId: deckId('Oxford::Oxford 3000') });
    const f = await cardFrame();
    await f.send({ t: 'link', href: `leitor://livro/${animalFarmUid()}?pagina=2` }, 'http://evil.example');
    await f.send({ t: 'link', href: `leitor://livro/${animalFarmUid()}?pagina=2` }, 'null', window);
    await f.send({ t: 'link', href: 42 });
    await new Promise((r) => setTimeout(r, 20));
    expect(leitorMock.openBook).not.toHaveBeenCalled();
    await f.send({ t: 'link', href: `leitor://livro/${animalFarmUid()}?pagina=2` });
    await waitFor(() => expect(leitorMock.openBook).toHaveBeenCalledTimes(1));
  });

  it('a "shown" the frame sends before React commits the card still opens the answer (?resposta=1)', async () => {
    // WebKitGTK with the real core: the frame is ready before the card arrives, and it answers showQuestion with
    // 'shown' before the new view is rendered.
    const real = core.ankiStudyNext.bind(core);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(core, 'ankiStudyNext').mockImplementation(async (id) => {
      await gate;
      return real(id);
    });
    renderStudy({ deckId: deckId('Matemática'), showAnswer: true });
    const f = await cardFrame();
    const win = fakeWindowOf(f.iframe);
    win.postMessage = (m) => {
      win.posted.push(m as HostToCard);
      if ((m as HostToCard).t !== 'showQuestion') return;
      const ev = new Event('message');
      Object.defineProperties(ev, {
        data: { value: { t: 'shown' } },
        origin: { value: 'null' },
        source: { value: win },
      });
      window.dispatchEvent(ev);
    };
    await f.send({ t: 'ready' });
    await act(async () => release());
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    expect(screen.getByTestId('study-page').dataset.side).toBe('answer');
  });

  it('E opens the note editor for the card on screen', async () => {
    renderStudy({ deckId: deckId('Oxford::Oxford 3000') });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'e' });
    const dialog = await screen.findByRole('dialog', { name: 'editor' });
    expect(Number(dialog.dataset.note)).toBeGreaterThan(0);
  });

  it('"Abrir no livro" opens the book at the page of the Fonte link (0-based) and finds the excerpt', async () => {
    const user = userEvent.setup();
    renderStudy({ deckName: 'Livros::Animal Farm' });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await user.click(await screen.findByRole('button', { name: 'Abrir no livro' }));
    await waitFor(() =>
      expect(leitorMock.openBook).toHaveBeenCalledWith(animalFarmUid(), { page: 36, find: 'windmill' }),
    );
    // The same link clicked inside the card.
    leitorMock.openBook.mockClear();
    await f.send({ t: 'link', href: `leitor://livro/${animalFarmUid()}?pagina=5` });
    await waitFor(() =>
      expect(leitorMock.openBook).toHaveBeenCalledWith(animalFarmUid(), { page: 4, find: undefined }),
    );
  });

  it('studies as the Anki tab and closes only its own session on unmount', async () => {
    const next = vi.spyOn(core, 'ankiStudyNext');
    const close = vi.spyOn(core, 'ankiStudyClose');
    const view = renderStudy({ deckId: deckId('Oxford::Oxford 3000') });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    expect(next).toHaveBeenCalledWith(deckId('Oxford::Oxford 3000'), 'tab');
    expect(mockHandle.anki.studyOwner).toBe('tab');
    view.unmount();
    await waitFor(() => expect(close).toHaveBeenCalledWith('tab'));
    await waitFor(() => expect(mockHandle.anki.studyOwner).toBeNull());
  });

  it('pauses when the book panel takes the session over; "Continuar aqui" takes it back', async () => {
    const user = userEvent.setup();
    const oxford = deckId('Oxford::Oxford 3000');
    renderStudy({ deckId: oxford });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());

    // The panel's "Revisar aqui" opens on another deck.
    await act(async () => {
      await core.ankiMiniReviewOpen(deckId('Livros::Animal Farm'));
    });
    expect(await screen.findByText('Estudo pausado: a revisão rápida do painel do livro está aberta.')).toBeTruthy();
    expect(screen.getByTestId('study-paused')).toBeTruthy();
    // Answer keys wait (from the app and from the card frame).
    fireEvent.keyDown(window, { key: ' ' });
    await f.send({ t: 'key', key: ' ', code: 'Space', ctrl: false, shift: false, alt: false, meta: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.last('showAnswer')).toBeUndefined();
    expect((screen.getByRole('button', { name: 'Mostrar resposta' }) as HTMLButtonElement).disabled).toBe(true);
    // "Editar" waits too: saving would take the session back from the panel.
    await user.click(screen.getByRole('button', { name: 'Mais ações' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getByRole('menuitem', { name: /Editar/ })
        .getAttribute('data-disabled'),
    ).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const next = vi.spyOn(core, 'ankiStudyNext');
    await user.click(screen.getByRole('button', { name: 'Continuar aqui' }));
    await waitFor(() => expect(screen.queryByTestId('study-paused')).toBeNull());
    expect(next).toHaveBeenCalledWith(oxford, 'tab');
    expect(mockHandle.anki.studyOwner).toBe('tab');
    expect(await screen.findByText('A revisão rápida do painel foi pausada.')).toBeTruthy();
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
  });

  it('shows only the congrats page and one back action for an empty deck', async () => {
    const user = userEvent.setup();
    renderStudy({ deckId: deckId('Oxford::Oxford 5000') });
    expect((await screen.findByTestId('anki-web-page')).textContent).toBe('congrats');
    expect(screen.getByTestId('anki-web-page').getAttribute('data-bare')).toBe('true');
    // One message (Anki's page), one back action, no disabled undo alone in the header.
    expect(screen.queryByText('Nada para estudar agora')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Voltar aos decks|Fechar/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Desfazer/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Voltar aos decks' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/anki' });
  });

  it('reports an unknown deck with a retry', async () => {
    renderStudy({ deckName: 'Não existe' });
    expect(await screen.findByText(/Não foi possível carregar o card/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });
});

describe('body classes', () => {
  it('adds the platform, fancy and night mode classes', () => {
    expect(platformClass('Mozilla/5.0 (X11; Linux x86_64)')).toBe('isLin');
    expect(platformClass('Mozilla/5.0 (Windows NT 10.0)')).toBe('isWin');
    expect(platformClass('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('isMac');
    expect(cardBodyClass('card card2', true, 'X11; Linux')).toBe('card card2 isLin fancy nightMode night_mode');
    expect(cardBodyClass('card card1', false, 'X11; Linux')).toBe('card card1 isLin fancy');
  });
});
