import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { core } from '../../../lib/core/client';
import { mockHandle } from '../../../lib/core/mock';
import { deckByName } from '../../../lib/core/mock/ankiData';
import { resetStudyMock } from '../../../lib/core/mock/ankiStudy';
import type { StudyOwner } from '../../../lib/core/types';
import { installDomStubs } from '../../../lib/testing/dom';
import { StudyStage } from './StudyStage';
import { cardFrame, stubCardFrameWindows } from './testing';
import { useStudySession, type StudySession, type StudySessionOptions } from './useStudySession';

const leitorMock = vi.hoisted(() => ({
  openBook: vi.fn(async (_uid: string, _opts?: { page?: number; find?: string }) => true),
  setReviewing: vi.fn(),
}));
vi.mock('../../leitor', () => ({ leitor: leitorMock, LeitorHost: () => null }));

beforeAll(() => installDomStubs());
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(core, 'cardFrameUrl').mockReturnValue('about:blank');
  stubCardFrameWindows();
  mockHandle.reset();
  resetStudyMock();
});

const deckId = (name: string) => deckByName(name)!.id;

let current: StudySession | null = null;

function Harness(props: StudySessionOptions) {
  const session = useStudySession(props);
  current = session;
  return (
    <div data-testid="harness" data-side={session.side ?? session.view.kind} data-paused={String(session.paused)}>
      <StudyStage session={session} className="relative" />
    </div>
  );
}

function renderSession(owner: StudyOwner, deck: number, extra: Partial<StudySessionOptions> = {}, strict = false) {
  const close = vi.fn(() => core.ankiStudyClose(owner));
  const start = vi.fn(async (resume: number | null) => ({
    deckId: resume ?? deck,
    next: await core.ankiStudyNext(resume ?? deck, owner),
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <Harness owner={owner} start={start} close={close} {...extra} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...view, start, close };
}

const session = () => current!;

describe('useStudySession', () => {
  it('starts as its owner, answers with the time on the card and closes on unmount', async () => {
    const deck = deckId('Oxford::Oxford 3000');
    const next = vi.spyOn(core, 'ankiStudyNext');
    const answer = vi.spyOn(core, 'ankiAnswer');
    const { start, close, unmount } = renderSession('panel', deck);
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    expect(start).toHaveBeenCalledWith(null);
    expect(next).toHaveBeenCalledWith(deck, 'panel');
    expect(session().deck).toBe(deck);
    expect(session().undoable).toBe(false);

    act(() => session().showAnswer());
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    act(() => session().answer(3));
    await waitFor(() => expect(answer).toHaveBeenCalledWith(expect.any(Number), 3, expect.any(Number)));
    await waitFor(() => expect(f.count('showQuestion')).toBe(2));
    expect(session().undoable).toBe(true);

    act(() => session().undo());
    await waitFor(() => expect(f.count('showQuestion')).toBe(3));
    expect(session().undoable).toBe(false);

    unmount();
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockHandle.anki.studyOwner).toBeNull());
  });

  it('keeps the answer locked until the card reports statesMutated for its key', async () => {
    const real = core.ankiStudyNext.bind(core);
    vi.spyOn(core, 'ankiStudyNext').mockImplementation(async (id, owner) => {
      const next = await real(id, owner);
      if (next.kind !== 'card') return next;
      return { ...next, card: { ...next.card, stateMutation: { key: '9', js: 'states.good = states.easy;' } } };
    });
    const show = vi.spyOn(core, 'ankiShowAnswer');
    renderSession('tab', deckId('Oxford::Oxford 3000'));
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('mutateStates')).toBeTruthy());
    expect(session().statesMutated).toBe(false);
    act(() => session().showAnswer());
    await new Promise((r) => setTimeout(r, 30));
    expect(show).not.toHaveBeenCalled();
    await f.send({ t: 'pycmd', cmd: 'statesMutated:9', id: 0 });
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    expect(session().statesMutated).toBe(true);
  });

  it('pauses when the other owner takes over, blocks answers, and resumes on "Continuar aqui"', async () => {
    const deck = deckId('Oxford::Oxford 3000');
    const preempted = vi.fn();
    const { start } = renderSession('tab', deck, { onPreemptedOther: preempted });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());

    await act(async () => {
      await core.ankiMiniReviewOpen(deckId('Matemática'));
    });
    await waitFor(() => expect(session().paused).toBe(true));
    act(() => session().showAnswer());
    await new Promise((r) => setTimeout(r, 30));
    expect(f.last('showAnswer')).toBeUndefined();

    await act(async () => session().resume());
    await waitFor(() => expect(session().paused).toBe(false));
    expect(start).toHaveBeenLastCalledWith(deck);
    expect(preempted).toHaveBeenCalledWith('panel');
    expect(mockHandle.anki.studyOwner).toBe('tab');
    expect(screen.getByTestId('harness').dataset.paused).toBe('false');
  });

  it('paused: reloading the card after an edit does not take the session back', async () => {
    renderSession('tab', deckId('Oxford::Oxford 3000'));
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    await act(async () => {
      await core.ankiMiniReviewOpen(deckId('Matemática'));
    });
    await waitFor(() => expect(session().paused).toBe(true));

    const next = vi.spyOn(core, 'ankiStudyNext');
    const open = vi.spyOn(core, 'ankiMiniReviewOpen');
    act(() => session().reloadCurrent());
    await new Promise((r) => setTimeout(r, 30));
    expect(next).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(mockHandle.anki.studyOwner).toBe('panel');
    expect(session().paused).toBe(true);
  });

  it('StrictMode remount: one start, no close, the session goes on', async () => {
    const deck = deckId('Oxford::Oxford 3000');
    const { start, close } = renderSession('panel', deck, {}, true);
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(start).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(mockHandle.anki.studyOwner).toBe('panel');
  });
});
