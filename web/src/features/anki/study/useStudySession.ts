// The study engine shared by the Anki tab ("Estudar", StudyPage) and the book panel's mini-review ("Revisar aqui",
// spec 10.1): the card on screen and its sandboxed CardFrame, show answer (typed answer), answers with the time on
// the card, the custom scheduling JS gate (statesMutated), undo, card actions, audio/TTS, keys and "Abrir no livro".
// Who studies is arbitrated by the core (one place at a time): `owner` is passed to it, and when the other place
// takes the session over this one pauses (answer keys blocked) until "Continuar aqui".
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { q } from '../../../lib/core/queries';
import type {
  AnswerSide,
  AvTag,
  CardAction,
  CardActionResult,
  SourceLink,
  StudyCard,
  StudyNext,
  StudyOwner,
  StudyOwnerChange,
} from '../../../lib/core/types';
import { useTheme } from '../../../lib/theme';
import { leitor } from '../../leitor';
import { isPdfcraftFrame, isTypingTarget } from '../../shell/shortcuts';
import { AvPlayer, browserPlayerDeps, replayTags } from './audio';
import type { CardFrameHandle, CardToHost } from './CardFrame';
import { forwardKey, keyLikeOf, studyKeyAction, type KeyLike, type Rating, type StudyKeyAction } from './keys';
import { parseLeitorLink } from './links';

/** How long to wait for the frame's typed answer. */
export const TYPED_TIMEOUT_MS = 2_000;

export type StudyView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'card'; card: StudyCard; side: 'question' | 'answer'; answer: AnswerSide | null }
  | { kind: 'done'; deckId: number; deckName: string; canUndo: boolean; answered: number };

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message;
  return String(e);
}

/** `isWin|isMac|isLin` (theme.py body_class). */
export function platformClass(ua: string = globalThis.navigator?.userAgent ?? ''): string {
  if (/Windows/i.test(ua)) return 'isWin';
  if (/Mac OS|Macintosh|iPhone|iPad/i.test(ua)) return 'isMac';
  return 'isLin';
}

/** Body classes of the card page: the core's `card cardN` + platform + `fancy` + night mode. */
export function cardBodyClass(base: string, dark: boolean, ua?: string): string {
  return `${base} ${platformClass(ua)} fancy${dark ? ' nightMode night_mode' : ''}`;
}

const DEV_LOG = import.meta.env.DEV || !!import.meta.env.TAURI_ENV_DEBUG;

export const FLAG_KEYS: MessageKey[] = [
  'anki.study.flag1',
  'anki.study.flag2',
  'anki.study.flag3',
  'anki.study.flag4',
  'anki.study.flag5',
  'anki.study.flag6',
  'anki.study.flag7',
];
export const FLAG_COLORS = ['#ff9b9b', '#ffb347', '#93e066', '#85c1ff', '#f097e4', '#5ccfca', '#9f63d3'];

/** What `start` returns: the deck studied and its first card. */
export interface StudyStart {
  deckId: number;
  next: StudyNext;
}

// Starting and closing sessions reach the core in the order they were sent (each Tauri command runs on its own
// task, and a remount — React StrictMode, a deck switch — sends close and start back to back).
let ownershipChain: Promise<unknown> = Promise.resolve();

/** Runs `call` after every start/close sent before it. */
export function studyInOrder<T>(call: () => Promise<T>): Promise<T> {
  const next = ownershipChain.then(call);
  ownershipChain = next.catch(() => undefined);
  return next;
}

/** "Abrir no livro" (spec 10.2): opens the book at the Fonte's page and finds the excerpt there. */
export function openBookAt(source: SourceLink): Promise<boolean> {
  return leitor.openBook(source.bookUid, { page: source.page - 1, find: source.query ?? undefined });
}

export interface StudySessionOptions {
  /** Who studies here (passed to the core; the other owner's session is preempted). */
  owner: StudyOwner;
  /**
   * Starts (or resumes) the session as `owner` (run in order with the closes: see `studyInOrder`). `deck` is the deck on screen when resuming ("Continuar aqui"),
   * `null` when loading (mount, retry, `startKey` change).
   */
  start: (deck: number | null) => Promise<StudyStart>;
  /** A change starts the session again (deck switch). */
  startKey?: unknown;
  /** Unmount: closes this owner's session (it must not close the other owner's). Runs in order with the starts. */
  close: () => Promise<unknown>;
  /** Shows the answer as soon as the first question is on screen (`?resposta=1`). */
  autoShowAnswer?: boolean | undefined;
  /** Keys typed in the app document reach the session only when this accepts them (after the common filters). */
  acceptKey?: (e: KeyboardEvent) => boolean;
  /** This owner's start took the session over from the other one (show a notice). */
  onPreemptedOther?: (other: StudyOwner) => void;
  /** Night mode of the card; defaults to the app theme (the mini-review follows PdfCraft's theme, like its panel). */
  dark?: boolean | undefined;
}

export function useStudySession(opts: StudySessionOptions) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [theme] = useTheme();
  const dark = opts.dark ?? theme === 'dark';
  const { owner, autoShowAnswer } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [deck, setDeckState] = useState<number | null>(null);
  const deckRef = useRef<number | null>(null);
  const setDeck = useCallback((d: number | null) => {
    deckRef.current = d;
    setDeckState(d);
  }, []);
  const [view, setViewState] = useState<StudyView>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [statesMutated, setStatesMutated] = useState(true);
  const [shown, setShown] = useState<'question' | 'answer' | null>(null);
  const [editing, setEditingState] = useState(false);
  const editingRef = useRef(false);
  const setEditing = useCallback((e: boolean) => {
    editingRef.current = e;
    setEditingState(e);
  }, []);
  const [video, setVideo] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  /** The other owner took the session over: everything but "Continuar aqui" waits. */
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const setPaused = useCallback((p: boolean) => {
    pausedRef.current = p;
    setPausedState(p);
  }, []);

  const frame = useRef<CardFrameHandle>(null);
  const goodRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const viewRef = useRef<StudyView>(view);
  viewRef.current = view;
  // The ref changes at once, not at the next render: the card frame can answer a message ('shown') before React
  // commits the new view (seen in WebKitGTK with the real core), and its handler reads the ref.
  const setView = useCallback((v: StudyView) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const busyRef = useRef(false);
  const mutatedRef = useRef(true);
  const frameReady = useRef(false);
  const shownAt = useRef(0);
  const answered = useRef(0);
  const typedWaiter = useRef<((v: string) => void) | null>(null);
  // Custom scheduling JS (cardStateCustomizer): the key of the card whose mutation is pending, and who waits for it.
  // Like the desktop there is no timeout: the answer buttons stay locked until the card reports `statesMutated`.
  const mutationKey = useRef<string | null>(null);
  const mutationWaiters = useRef<(() => void)[]>([]);
  const autoShown = useRef(false);
  const videoDone = useRef<(() => void) | null>(null);
  const darkRef = useRef(dark);
  darkRef.current = dark;

  const toastRef = useRef(toast);
  toastRef.current = toast;
  // One player for the whole session (stable across renders: the unmount cleanup stops it).
  const [player] = useState(
    () =>
      new AvPlayer(
        browserPlayerDeps({
          mediaUrl: (file) => core.cardMediaUrl(file),
          onTtsUnavailable: () => toastRef.current.show(t('anki.study.ttsUnavailable')),
          onError: (what) => toastRef.current.show(t('anki.study.audioFailed', { arquivo: what }), { tone: 'error' }),
          video: (src) =>
            new Promise<void>((resolve) => {
              videoDone.current = resolve;
              setVideo(src);
            }),
          stopVideo: () => {
            videoDone.current?.();
            videoDone.current = null;
            setVideo(null);
          },
        }),
      ),
  );

  const setBusyBoth = (b: boolean) => {
    busyRef.current = b;
    setBusy(b);
  };

  // ---------------------------------------------------------------- presenting

  /** Marks the pending state mutation (if any) as done and releases whoever waits for it. */
  const settleMutation = useCallback(() => {
    mutationKey.current = null;
    mutatedRef.current = true;
    setStatesMutated(true);
    const waiters = mutationWaiters.current;
    mutationWaiters.current = [];
    for (const w of waiters) w();
  }, []);

  /** Resolves once the card's custom scheduling JS has run (at once without one). */
  function mutationSettled(): Promise<void> {
    if (mutatedRef.current) return Promise.resolve();
    return new Promise((resolve) => mutationWaiters.current.push(resolve));
  }

  const present = useCallback(
    (card: StudyCard) => {
      const f = frame.current;
      if (!f || !frameReady.current) return;
      setShown(null);
      f.post({ t: 'theme', night: darkRef.current });
      f.post({
        t: 'showQuestion',
        q: card.questionHtml,
        a: card.answerPreloadHtml,
        bodyclass: cardBodyClass(card.bodyClass, darkRef.current),
      });
      f.post({ t: 'flag', flag: card.flag });
      f.post({ t: 'mark', mark: card.marked });
      // Waiters of the previous card give up (they check the card on screen when they resume).
      settleMutation();
      if (card.stateMutation) {
        mutationKey.current = card.stateMutation.key;
        mutatedRef.current = false;
        setStatesMutated(false);
        f.post({ t: 'mutateStates', key: card.stateMutation.key, js: card.stateMutation.js });
      }
      shownAt.current = performance.now();
      setStartedAt(Date.now());
      if (card.autoplay && card.questionAv.length > 0) player.play(card.questionAv);
      else player.stop();
      if (card.typeAnswer) f.focus();
      // The button appears with the next render when the answer side was on screen.
      else if (showRef.current) showRef.current.focus({ preventScroll: true });
      else requestAnimationFrame(() => showRef.current?.focus({ preventScroll: true }));
    },
    [player, settleMutation],
  );

  const apply = useCallback(
    (next: StudyNext) => {
      if (next.kind === 'card') {
        setView({ kind: 'card', card: next.card, side: 'question', answer: null });
        present(next.card);
      } else {
        player.stop();
        setView({
          kind: 'done',
          deckId: next.deckId,
          deckName: next.deckName,
          canUndo: next.canUndo,
          answered: answered.current,
        });
        void queryClient.invalidateQueries({ queryKey: ['anki', 'deckTree'] });
      }
    },
    [present, player, queryClient, setView],
  );

  // ---------------------------------------------------------------- ownership

  // Subscribed before the first start, so the event of this owner's own start is not missed.
  useEffect(
    () =>
      core.onStudyOwner((c: StudyOwnerChange) => {
        if (c.owner === owner) {
          setPaused(false);
          if (c.preempted && c.preempted !== owner) optsRef.current.onPreemptedOther?.(c.preempted);
          return;
        }
        // The other place studies now (or took this one's session): pause what is on screen.
        const took = (c.owner !== null && c.owner !== owner) || c.preempted === owner;
        const v = viewRef.current;
        if (took && (v.kind === 'card' || v.kind === 'done')) {
          setPaused(true);
          player.stop();
        }
      }),
    [owner, player, setPaused],
  );

  // ---------------------------------------------------------------- loading

  // React StrictMode (dev) mounts, unmounts and mounts again at once: the second mount reuses the start in flight
  // and cancels the close the unmount scheduled, so the core sees one start and no close (one round trip, not three).
  const inflight = useRef<{ key: string; promise: Promise<StudyStart> } | null>(null);
  const cancelClose = useRef<(() => void) | null>(null);
  const startKey = opts.startKey;

  useEffect(() => {
    let alive = true;
    const key = `${String(startKey)}|${attempt}`;
    setView({ kind: 'loading' });
    let started = inflight.current?.key === key ? inflight.current.promise : null;
    if (!started) {
      started = studyInOrder(() => optsRef.current.start(null));
      inflight.current = { key, promise: started };
    }
    const mine = started;
    void (async () => {
      try {
        const { deckId, next } = await mine;
        if (inflight.current?.promise === mine) inflight.current = null;
        if (!alive) return;
        setDeck(deckId);
        setPaused(false);
        apply(next);
      } catch (e) {
        if (inflight.current?.promise === mine) inflight.current = null;
        if (alive) setView({ kind: 'error', message: errorText(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [startKey, attempt, apply, setView, setDeck, setPaused]);

  // A full sync replaced the collection (the core reset the study session): load the next card again. A normal sync
  // keeps the card on screen (answering a card that changed is handled by the answer errors).
  useEffect(
    () =>
      core.onAnkiChanged((e) => {
        if (e.reason === 'syncFull') setAttempt((a) => a + 1);
      }),
    [],
  );

  useEffect(() => {
    // A StrictMode remount: the session goes on.
    cancelClose.current?.();
    cancelClose.current = null;
    return () => {
      player.stop();
      settleMutation();
      let cancelled = false;
      cancelClose.current = () => {
        cancelled = true;
      };
      // Queued now (before any start of a screen mounted next), decided once React is done mounting.
      const decided = new Promise<boolean>((resolve) => setTimeout(() => resolve(!cancelled), 0));
      void studyInOrder(async () => {
        if (!(await decided)) return;
        inflight.current = null;
        await optsRef.current.close();
      }).catch(() => undefined);
    };
  }, [player, settleMutation]);

  // The app theme follows into the card.
  useEffect(() => {
    if (!frameReady.current) return;
    frame.current?.post({ t: 'theme', night: dark });
  }, [dark]);

  // ---------------------------------------------------------------- flow

  function requestTyped(): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        typedWaiter.current = null;
        resolve('');
      }, TYPED_TIMEOUT_MS);
      typedWaiter.current = (v) => {
        clearTimeout(timer);
        typedWaiter.current = null;
        resolve(v);
      };
      frame.current?.post({ t: 'getTypedAnswer' });
    });
  }

  async function run<T>(f: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    setBusyBoth(true);
    try {
      return await f();
    } catch (e) {
      toast.show(t('anki.study.actionFailed', { erro: errorText(e) }), { tone: 'error' });
      return undefined;
    } finally {
      setBusyBoth(false);
    }
  }

  async function showAnswer() {
    const v = viewRef.current;
    if (pausedRef.current || v.kind !== 'card' || v.side !== 'question') return;
    const card = v.card;
    // The answer buttons describe the states the answer will use: wait for the custom scheduling JS first
    // (reviewer.py `_showEaseButtons` waits for `_states_mutated` the same way).
    await mutationSettled();
    const still = viewRef.current;
    if (still.kind !== 'card' || still.side !== 'question' || still.card.cardId !== card.cardId) return;
    const side = await run(async () => {
      const typed = card.typeAnswer ? await requestTyped() : null;
      return core.ankiShowAnswer(card.cardId, typed);
    });
    if (!side) return;
    const now = viewRef.current;
    if (now.kind !== 'card' || now.card.cardId !== card.cardId) return;
    setShown(null);
    setView({ kind: 'card', card, side: 'answer', answer: side });
    frame.current?.post({ t: 'showAnswer', a: side.html });
    if (card.autoplay && side.av.length > 0) player.play(side.av);
    else player.stop();
    requestAnimationFrame(() => goodRef.current?.focus({ preventScroll: true }));
  }

  async function answer(rating: Rating) {
    const v = viewRef.current;
    if (pausedRef.current || v.kind !== 'card' || v.side !== 'answer' || !mutatedRef.current) return;
    const ms = Math.max(0, Math.round(performance.now() - shownAt.current));
    const next = await run(() => core.ankiAnswer(v.card.cardId, rating, ms));
    if (!next) return;
    answered.current += 1;
    apply(next);
  }

  /** Ctrl+Z: only right after an answer (the core's StudyNext.canUndo, spec 10.1), never while paused. */
  function canUndo(): boolean {
    if (pausedRef.current) return false;
    const v = viewRef.current;
    return (v.kind === 'card' && v.card.canUndo) || (v.kind === 'done' && v.canUndo);
  }

  async function undo() {
    if (!canUndo()) return;
    const next = await run(() => core.ankiUndo());
    if (!next) return;
    answered.current = Math.max(0, answered.current - 1);
    toast.show(t('anki.study.undone'));
    apply(next);
  }

  async function cardAction(action: CardAction, flag?: number) {
    const v = viewRef.current;
    if (pausedRef.current || v.kind !== 'card') return;
    const res: CardActionResult | undefined = await run(() => core.ankiCardAction(v.card.cardId, action, flag));
    if (!res) return;
    if (res.next) {
      const msg: Record<string, MessageKey> = {
        bury: 'anki.study.buried',
        buryNote: 'anki.study.noteBuried',
        suspend: 'anki.study.suspended',
        suspendNote: 'anki.study.noteSuspended',
      };
      if (msg[action]) toast.show(t(msg[action]));
      apply(res.next);
      return;
    }
    const now = viewRef.current;
    if (now.kind !== 'card' || now.card.cardId !== v.card.cardId) return;
    // Flag and mark keep the card on screen; any other op makes Ctrl+Z unavailable (only answers are undone).
    setView({ ...now, card: { ...now.card, flag: res.flag, marked: res.marked, canUndo: false } });
    frame.current?.post({ t: 'flag', flag: res.flag });
    frame.current?.post({ t: 'mark', mark: res.marked });
    if (action === 'flag')
      toast.show(res.flag ? t('anki.study.flagged', { cor: t(FLAG_KEYS[res.flag - 1]!) }) : t('anki.study.unflagged'));
    if (action === 'mark') toast.show(t(res.marked ? 'anki.study.marked' : 'anki.study.unmarked'));
  }

  function replay() {
    const v = viewRef.current;
    if (v.kind !== 'card') return;
    player.play(replayTags(v.side, v.card.questionAv, v.answer?.av ?? v.card.answerAv, v.card.replayQuestionOnAnswer));
  }

  /** `play:q:N` / `play:a:N` from a play button (bounds-checked). */
  function playClicked(cmd: string) {
    const m = /^play:([qa]):(\d+)$/.exec(cmd);
    const v = viewRef.current;
    if (!m || v.kind !== 'card') return;
    const tags: AvTag[] = m[1] === 'q' ? v.card.questionAv : (v.answer?.av ?? v.card.answerAv);
    const tag = tags[Number(m[2])];
    if (tag) player.play([tag]);
  }

  async function openSource(source: SourceLink) {
    try {
      const books = await queryClient.fetchQuery(q.library());
      if (!books.some((b) => b.bookUid === source.bookUid)) {
        toast.show(t('anki.study.bookMissing'), { tone: 'error' });
        return;
      }
      void openBookAt(source);
    } catch (e) {
      toast.show(t('anki.study.actionFailed', { erro: errorText(e) }), { tone: 'error' });
    }
  }

  /**
   * The card on screen again (after an edit). Not while paused: asking the core for the next card would take the
   * session back from the place studying now (spec 10.1); "Continuar aqui" shows the edited card.
   */
  function reloadCurrent() {
    const d = deckRef.current;
    if (d === null || pausedRef.current) return;
    void run(() => core.ankiStudyNext(d, owner)).then((next) => next && apply(next));
  }

  /** "Continuar aqui": starts again as this owner (the core preempts the other one). */
  async function resume() {
    const started = await run(() => studyInOrder(() => optsRef.current.start(deckRef.current)));
    if (!started) return;
    setDeck(started.deckId);
    setPaused(false);
    apply(started.next);
  }

  function retry() {
    setAttempt((n) => n + 1);
  }

  function doAction(a: StudyKeyAction, source: KeyLike): boolean {
    switch (a.kind) {
      case 'showAnswer':
        void showAnswer();
        return true;
      case 'answer':
        void answer(a.rating);
        return true;
      case 'edit':
        if (viewRef.current.kind === 'card') setEditing(true);
        return true;
      case 'undo':
        void undo();
        return true;
      case 'mark':
        void cardAction('mark');
        return true;
      case 'bury':
        void cardAction('bury');
        return true;
      case 'buryNote':
        void cardAction('buryNote');
        return true;
      case 'suspend':
        void cardAction('suspend');
        return true;
      case 'suspendNote':
        void cardAction('suspendNote');
        return true;
      case 'replay':
        replay();
        return true;
      case 'forward':
        forwardKey(source);
        return false;
    }
  }

  // Keys typed in the app UI (not in PdfCraft, not in a field, a menu or a dialog).
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || editingRef.current || e.isComposing) return;
    if (isPdfcraftFrame(document.activeElement) || isTypingTarget(e.target)) return;
    if (e.target instanceof Element && e.target.closest('[role="menu"],[role="dialog"],[role="listbox"]')) return;
    const accept = optsRef.current.acceptKey;
    if (accept && !accept(e)) return;
    const v = viewRef.current;
    const side = v.kind === 'card' ? v.side : 'question';
    const action = studyKeyAction(keyLikeOf(e), side, canUndo());
    if (!action || action.kind === 'forward') return;
    if (v.kind !== 'card' && action.kind !== 'undo') return;
    if (pausedRef.current) return;
    e.preventDefault();
    doAction(action, keyLikeOf(e));
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // ---------------------------------------------------------------- card frame messages

  function onCardMessage(m: CardToHost) {
    switch (m.t) {
      case 'ready': {
        frameReady.current = true;
        frame.current?.post({ t: 'theme', night: darkRef.current });
        const v = viewRef.current;
        if (v.kind === 'card') {
          present(v.card);
          if (v.side === 'answer' && v.answer) frame.current?.post({ t: 'showAnswer', a: v.answer.html });
        }
        return;
      }
      case 'shown': {
        const v = viewRef.current;
        if (v.kind === 'card') setShown(v.side);
        if (autoShowAnswer && !autoShown.current && v.kind === 'card' && v.side === 'question') {
          autoShown.current = true;
          void showAnswer();
        }
        return;
      }
      case 'typed':
        typedWaiter.current?.(m.v);
        return;
      case 'link': {
        const link = parseLeitorLink(m.href);
        if (link) void openSource(link);
        else toast.show(t('anki.study.linkInvalid'), { tone: 'error' });
        return;
      }
      case 'key': {
        if (editingRef.current) return;
        const v = viewRef.current;
        const action = studyKeyAction(m, v.kind === 'card' ? v.side : 'question', canUndo());
        if (!action) return;
        // While paused only app shortcuts go through.
        if (pausedRef.current && action.kind !== 'forward') return;
        doAction(action, m);
        return;
      }
      case 'pycmd':
        onPycmd(m.cmd);
        if (m.id > 0) frame.current?.post({ t: 'cb', id: m.id, v: null });
        return;
    }
  }

  /** The pycmd whitelist of the desktop reviewer (docs/tecnico/anki-web-and-reviewer.md §4.5). */
  function onPycmd(cmd: string) {
    const v = viewRef.current;
    if (cmd === 'ans') {
      void showAnswer();
    } else if (/^ease[1-4]$/.test(cmd)) {
      if (v.kind === 'card' && v.side === 'answer') void answer(Number(cmd.slice(4)) as Rating);
    } else if (cmd.startsWith('play:')) {
      playClicked(cmd);
    } else if (cmd.startsWith('statesMutated:')) {
      // Only the report of the card on screen counts: a late one from the previous card is ignored.
      if (mutationKey.current !== null && cmd.slice('statesMutated:'.length) === mutationKey.current) settleMutation();
    } else if (cmd === 'updateToolbar' || cmd === 'repaintNeeded') {
      // Toolbar background / repaint: nothing to do here.
    } else if (DEV_LOG) {
      void core.devLog('info', `card pycmd: ${cmd.slice(0, 200)}`);
    }
  }

  const card = view.kind === 'card' ? view.card : null;
  const side = view.kind === 'card' ? view.side : null;
  const undoable = !paused && ((card?.canUndo ?? false) || (view.kind === 'done' && view.canUndo));

  return {
    owner,
    deck,
    view,
    card,
    side,
    busy,
    statesMutated,
    shown,
    startedAt,
    video,
    paused,
    editing,
    setEditing,
    /** Ctrl+Z / the undo button are enabled. */
    undoable,
    frame,
    goodRef,
    showRef,
    player,
    onCardMessage,
    showAnswer: () => void showAnswer(),
    answer: (r: Rating) => void answer(r),
    undo: () => void undo(),
    cardAction: (a: CardAction, flag?: number) => void cardAction(a, flag),
    replay,
    openSource: (s: SourceLink) => void openSource(s),
    reloadCurrent,
    resume: () => void resume(),
    retry,
  };
}

export type StudySession = ReturnType<typeof useStudySession>;

/** The keyboard focus is inside `root` (or on nothing, the body), never in PdfCraft or a field. */
export function focusWithin(root: Element | null): boolean {
  const active = document.activeElement;
  if (!root || !active || isPdfcraftFrame(active)) return false;
  return root.contains(active);
}
