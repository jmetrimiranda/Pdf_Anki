import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { core } from '../../../lib/core/client';
import { mockHandle } from '../../../lib/core/mock';
import { animalFarmUid, deckByName } from '../../../lib/core/mock/ankiData';
import { resetStudyMock } from '../../../lib/core/mock/ankiStudy';
import { installDomStubs } from '../../../lib/testing/dom';
import { cardFrame, stubCardFrameWindows } from '../../anki/study/testing';
import { MiniReview, type MiniReviewProps } from './MiniReview';

const leitorMock = vi.hoisted(() => ({
  openBook: vi.fn(async (_uid: string, _opts?: { page?: number; find?: string }) => true),
  setReviewing: vi.fn(),
}));
vi.mock('../../leitor', () => ({ leitor: leitorMock, LeitorHost: () => null, useLeitorSelector: () => null }));

vi.mock('../../anki/editor/NoteEditorDialog', () => ({
  NoteEditorDialog: (p: { noteId: number | null; open: boolean }) =>
    p.open ? <div role="dialog" aria-label="editor" data-note={p.noteId} /> : null,
}));

beforeAll(() => installDomStubs());
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(core, 'cardFrameUrl').mockReturnValue('about:blank');
  stubCardFrameWindows();
  mockHandle.reset();
  resetStudyMock();
  leitorMock.openBook.mockClear();
  leitorMock.setReviewing.mockClear();
});

const deckId = (name: string) => deckByName(name)!.id;
const FARM = () => deckId('Livros::Animal Farm');
const MATH = () => deckId('Matemática');

function renderMini(props: Partial<MiniReviewProps> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const all: MiniReviewProps = {
    bookUid: animalFarmUid(),
    decks: [
      { deckId: FARM(), name: 'Livros::Animal Farm', role: 'vocab' },
      { deckId: MATH(), name: 'Matemática', role: 'content' },
    ],
    initialDeckId: FARM(),
    onClose,
    ...props,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <iframe title="PdfCraft" tabIndex={0} />
          <MiniReview {...all} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, onClose, client };
}

/** The mini-review with its first question on screen. */
async function opened(props: Partial<MiniReviewProps> = {}) {
  const r = renderMini(props);
  const f = await cardFrame();
  await f.send({ t: 'ready' });
  await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
  return { ...r, f, region: screen.getByRole('region', { name: 'Revisão rápida' }) };
}

const undoButton = () => screen.getByRole('button', { name: 'Desfazer resposta' }) as HTMLButtonElement;

/** A key typed with the focus where it is now (it bubbles to the window like a real one). */
function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  fireEvent.keyDown(target, { key, ...init });
}

describe('MiniReview', () => {
  it('switches the current deck to the chosen one and restores it on close; pauses reading meanwhile', async () => {
    const before = mockHandle.anki.currentDeckId;
    expect(before).not.toBe(FARM());
    const user = userEvent.setup();
    const { onClose, client, f } = await opened();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(mockHandle.anki.currentDeckId).toBe(FARM());
    expect(mockHandle.anki.studyOwner).toBe('panel');
    expect(leitorMock.setReviewing).toHaveBeenLastCalledWith(true);
    // The card runs in the same sandboxed frame as the Anki tab.
    expect(f.iframe.getAttribute('sandbox')).toBe('allow-scripts');

    await user.click(screen.getByRole('button', { name: 'Encerrar revisão' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(leitorMock.setReviewing).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(mockHandle.anki.currentDeckId).toBe(before));
    expect(mockHandle.anki.studyOwner).toBeNull();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bookPanel'] }));
  });

  it('closing by unmount (book switch) also restores the deck', async () => {
    const before = mockHandle.anki.currentDeckId;
    const { unmount } = await opened();
    unmount();
    await waitFor(() => expect(mockHandle.anki.currentDeckId).toBe(before));
    expect(leitorMock.setReviewing).toHaveBeenLastCalledWith(false);
  });

  it('Ctrl+Z: disabled after opening and after switching decks, enabled after an answer, which it undoes', async () => {
    const user = userEvent.setup();
    const { f } = await opened();
    expect(undoButton().disabled).toBe(true);
    press('z', { ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockHandle.anki.logs.filter((l) => l.kind === 'undo')).toHaveLength(0);

    press(' ');
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    press('3');
    await waitFor(() => expect(f.count('showQuestion')).toBe(2));
    await waitFor(() => expect(undoButton().disabled).toBe(false));
    press('z', { ctrlKey: true });
    await waitFor(() => expect(mockHandle.anki.logs.filter((l) => l.kind === 'undo')).toHaveLength(1));
    await waitFor(() => expect(undoButton().disabled).toBe(true));

    // Answer again, then switch decks: the switch is not an answer, so there is nothing to undo.
    press(' ');
    await waitFor(() => expect(f.count('showAnswer')).toBe(2));
    press('3');
    await waitFor(() => expect(undoButton().disabled).toBe(false));
    await user.click(screen.getByRole('radio', { name: 'Conteúdo' }));
    await waitFor(() => expect(mockHandle.anki.currentDeckId).toBe(MATH()));
    await waitFor(() => expect(screen.getByTestId('mini-review').dataset.side).toBe('question'));
    expect(undoButton().disabled).toBe(true);
  });

  it('ignores study keys while PdfCraft has the focus (Ctrl+Z is its own undo there)', async () => {
    const { f } = await opened();
    // The engine focuses "Mostrar resposta" on the next animation frame: let it land before the user goes to PdfCraft.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Mostrar resposta/ })));
    const pdfcraft = screen.getByTitle('PdfCraft');
    pdfcraft.focus();
    expect(document.activeElement).toBe(pdfcraft);
    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.last('showAnswer')).toBeUndefined();
    // Focus elsewhere in the app (outside the panel) does not count either.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: ' ' });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.last('showAnswer')).toBeUndefined();
    // Keys forwarded by its own card frame do.
    await f.send({ t: 'key', key: ' ', code: 'Space', ctrl: false, shift: false, alt: false, meta: false });
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
  });

  it('pauses when the Anki tab starts studying; "Continuar aqui" takes the session back', async () => {
    const user = userEvent.setup();
    const { f } = await opened();
    await act(async () => {
      await core.ankiStudyNext(deckId('Oxford::Oxford 3000'), 'tab');
    });
    expect(await screen.findByText('Revisão pausada: você começou a estudar na aba Anki.')).toBeTruthy();
    press(' ');
    await new Promise((r) => setTimeout(r, 30));
    expect(f.last('showAnswer')).toBeUndefined();

    const open = vi.spyOn(core, 'ankiMiniReviewOpen');
    await user.click(screen.getByRole('button', { name: 'Continuar aqui' }));
    await waitFor(() => expect(screen.queryByTestId('mini-review-paused')).toBeNull());
    expect(open).toHaveBeenCalledWith(FARM());
    expect(mockHandle.anki.studyOwner).toBe('panel');
    expect(mockHandle.anki.currentDeckId).toBe(FARM());
    expect(await screen.findByText('A sessão de estudo da aba Anki foi pausada.')).toBeTruthy();
  });

  it('closing after the Anki tab took over keeps the tab’s deck', async () => {
    const user = userEvent.setup();
    await opened();
    const oxford = deckId('Oxford::Oxford 3000');
    await act(async () => {
      await core.ankiStudyNext(oxford, 'tab');
    });
    await screen.findByTestId('mini-review-paused');
    await user.click(screen.getByRole('button', { name: 'Encerrar revisão' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(mockHandle.anki.currentDeckId).toBe(oxford);
    expect(mockHandle.anki.studyOwner).toBe('tab');
  });

  it('switching decks keeps the deck from before the first opening', async () => {
    const before = mockHandle.anki.currentDeckId;
    const user = userEvent.setup();
    await opened();
    await user.click(screen.getByRole('radio', { name: 'Conteúdo' }));
    await waitFor(() => expect(mockHandle.anki.currentDeckId).toBe(MATH()));
    await user.click(screen.getByRole('radio', { name: 'Vocabulário' }));
    await waitFor(() => expect(mockHandle.anki.currentDeckId).toBe(FARM()));
    await user.click(screen.getByRole('button', { name: 'Encerrar revisão' }));
    await waitFor(() => expect(mockHandle.anki.currentDeckId).toBe(before));
  });

  it('opening preempts a study session of the Anki tab with a notice', async () => {
    await core.ankiStudyNext(deckId('Oxford::Oxford 3000'), 'tab');
    await opened();
    expect(await screen.findByText('A sessão de estudo da aba Anki foi pausada.')).toBeTruthy();
    expect(mockHandle.anki.studyOwner).toBe('panel');
  });

  it('"Abrir no livro" goes to the Fonte page and finds the excerpt; Esc closes', async () => {
    const user = userEvent.setup();
    const { onClose } = await opened({
      decks: [{ deckId: FARM(), name: 'Livros::Animal Farm', role: 'vocab' }],
    });
    // One deck: its name instead of the switcher.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText('Animal Farm')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Abrir no livro' }));
    await waitFor(() => expect(leitorMock.openBook).toHaveBeenCalledTimes(1));
    const [uid, opts] = leitorMock.openBook.mock.calls[0]!;
    expect(uid).toBe(animalFarmUid());
    expect(opts).toMatchObject({ page: expect.any(Number) });
    expect(typeof opts?.find).toBe('string');

    screen.getByRole('region', { name: 'Revisão rápida' }).focus();
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the done state with one close action for an empty deck', async () => {
    const user = userEvent.setup();
    const empty = deckId('Oxford::Oxford 5000');
    const { onClose } = renderMini({
      decks: [{ deckId: empty, name: 'Oxford::Oxford 5000', role: 'content' }],
      initialDeckId: empty,
    });
    expect(await screen.findByText('Nada para revisar agora neste deck.')).toBeTruthy();
    const closes = screen.getAllByRole('button', { name: 'Encerrar revisão' });
    expect(closes.length).toBeGreaterThanOrEqual(1);
    await user.click(closes.at(-1)!);
    expect(onClose).toHaveBeenCalled();
  });

  it('a code card: the Pergunta in the frame, the code panel below, the suggestion preselected in the narrow bar', async () => {
    const user = userEvent.setup();
    const ROS = deckId('ROS 2 — Revisão');
    const { f } = await opened({
      decks: [{ deckId: ROS, name: 'ROS 2 — Revisão', role: 'content' }],
      initialDeckId: ROS,
    });
    await f.send({ t: 'shown' });
    const input = await screen.findByTestId('code-command-input');
    expect(screen.getByTestId('code-panel').closest('[data-testid="mini-review"]')).toBeTruthy();
    await user.type(input, 'ros2 run tf2_ros tf2_echo world turtle1{Enter}');
    await waitFor(() => expect(screen.getByTestId('code-verdict').textContent).toBe('Correto'));
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    const good = screen.getByRole('button', { name: /^Bom/ });
    await waitFor(() => expect(good.getAttribute('data-suggested')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(good));
    press('Enter');
    await waitFor(() => expect(mockHandle.anki.logs.filter((l) => l.kind === 'answer')).toHaveLength(1));
    expect(mockHandle.anki.logs.find((l) => l.kind === 'answer')).toMatchObject({ rating: 3 });
  });
});
