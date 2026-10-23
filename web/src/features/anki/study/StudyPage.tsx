// "Estudar" (spec 8.2, 8.4, 10.1): the desktop reviewer rebuilt around Anki's own reviewer.js. The core renders the
// card exactly like qt/aqt/reviewer.py (core-anki `study`); the card runs in a sandboxed iframe (CardFrame) that
// reaches the app only through validated postMessage; audio/TTS play here (audio.ts); the bottom bar, keys and
// actions are native.
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, BookOpen, EyeOff, Info, Pause, Pencil, Settings2, Star, Undo2, Volume2, X, Ellipsis } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  IconButton,
  Menu,
  Notice,
  Skeleton,
  useToast,
  type MenuEntry,
} from '../../../components/ui';
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
} from '../../../lib/core/types';
import { useTheme } from '../../../lib/theme';
import { isPdfcraftFrame, isTypingTarget } from '../../shell/shortcuts';
import { leitor } from '../../leitor';
import { AnkiWebPage } from '../pages/AnkiWebPage';
import { NoteEditorDialog } from '../editor/NoteEditorDialog';
import { AnswerButtons, ShowAnswerButton, StudyCounts } from './AnswerBar';
import { AvPlayer, browserPlayerDeps, replayTags } from './audio';
import { CardFrame, type CardFrameHandle, type CardToHost } from './CardFrame';
import { forwardKey, keyLikeOf, studyKeyAction, type KeyLike, type Rating, type StudyKeyAction } from './keys';
import { parseLeitorLink } from './links';

/** How long to wait for the frame's typed answer. */
const TYPED_TIMEOUT_MS = 2_000;

type View =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'card'; card: StudyCard; side: 'question' | 'answer'; answer: AnswerSide | null }
  | { kind: 'done'; deckId: number; deckName: string; canUndo: boolean; answered: number };

function errorText(e: unknown): string {
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

const FLAG_KEYS: MessageKey[] = [
  'anki.study.flag1',
  'anki.study.flag2',
  'anki.study.flag3',
  'anki.study.flag4',
  'anki.study.flag5',
  'anki.study.flag6',
  'anki.study.flag7',
];
const FLAG_COLORS = ['#ff9b9b', '#ffb347', '#93e066', '#85c1ff', '#f097e4', '#5ccfca', '#9f63d3'];

/** Resolves the deck to study: the id, else the full name (`?nome=`), else the collection's current deck. */
async function resolveDeck(deckId?: number, deckName?: string): Promise<number> {
  if (deckId !== undefined) return deckId;
  if (deckName) {
    const names = await core.ankiDeckNames();
    const key = deckName.toLowerCase();
    const hit = names.find((d) => d.name.toLowerCase() === key);
    if (!hit) throw new Error(t('anki.study.deckMissing', { nome: deckName }));
    return hit.id;
  }
  return (await core.ankiDeckTree()).currentDeckId;
}

export function StudyPage({
  deckId,
  deckName,
  showAnswer: autoShowAnswer,
}: {
  deckId?: number;
  deckName?: string;
  showAnswer?: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [theme] = useTheme();
  const dark = theme === 'dark';

  const [deck, setDeck] = useState<number | null>(null);
  const [view, setViewState] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [statesMutated, setStatesMutated] = useState(true);
  const [shown, setShown] = useState<'question' | 'answer' | null>(null);
  const [editing, setEditing] = useState(false);
  const [video, setVideo] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startedAt, setStartedAt] = useState(0);

  const frame = useRef<CardFrameHandle>(null);
  const goodRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  // The ref changes at once, not at the next render: the card frame can answer a message ('shown') before React
  // commits the new view (seen in WebKitGTK with the real core), and its handler reads the ref.
  const setView = useCallback((v: View) => {
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
      else showRef.current?.focus({ preventScroll: true });
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

  // ---------------------------------------------------------------- loading

  useEffect(() => {
    let alive = true;
    setView({ kind: 'loading' });
    void (async () => {
      try {
        const id = await resolveDeck(deckId, deckName);
        const next = await core.ankiStudyNext(id);
        if (!alive) return;
        setDeck(id);
        apply(next);
      } catch (e) {
        if (alive) setView({ kind: 'error', message: errorText(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [deckId, deckName, attempt, apply, setView]);

  // A full sync replaced the collection (the core reset the study session): load the next card again. A normal sync
  // keeps the card on screen (answering a card that changed is handled by the answer errors).
  useEffect(
    () =>
      core.onAnkiChanged((e) => {
        if (e.reason === 'syncFull') setAttempt((a) => a + 1);
      }),
    [],
  );

  useEffect(
    () => () => {
      player.stop();
      settleMutation();
      void core.ankiStudyClose().catch(() => {});
    },
    [player, settleMutation],
  );

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
    if (v.kind !== 'card' || v.side !== 'question') return;
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
    if (v.kind !== 'card' || v.side !== 'answer' || !mutatedRef.current) return;
    const ms = Math.max(0, Math.round(performance.now() - shownAt.current));
    const next = await run(() => core.ankiAnswer(v.card.cardId, rating, ms));
    if (!next) return;
    answered.current += 1;
    apply(next);
  }

  function canUndo(): boolean {
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
    if (v.kind !== 'card') return;
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
      void leitor.openBook(source.bookUid, { page: source.page - 1 });
    } catch (e) {
      toast.show(t('anki.study.actionFailed', { erro: errorText(e) }), { tone: 'error' });
    }
  }

  function reloadCurrent() {
    if (deck === null) return;
    void run(() => core.ankiStudyNext(deck)).then((next) => next && apply(next));
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
    if (e.defaultPrevented || editing || e.isComposing) return;
    if (isPdfcraftFrame(document.activeElement) || isTypingTarget(e.target)) return;
    if (e.target instanceof Element && e.target.closest('[role="menu"],[role="dialog"],[role="listbox"]')) return;
    const v = viewRef.current;
    const side = v.kind === 'card' ? v.side : 'question';
    const action = studyKeyAction(keyLikeOf(e), side, canUndo());
    if (!action || action.kind === 'forward') return;
    if (v.kind !== 'card' && action.kind !== 'undo') return;
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
        if (editing) return;
        const v = viewRef.current;
        const action = studyKeyAction(m, v.kind === 'card' ? v.side : 'question', canUndo());
        if (action) doAction(action, m);
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

  // ---------------------------------------------------------------- render

  const card = view.kind === 'card' ? view.card : null;
  const side = view.kind === 'card' ? view.side : null;
  const undoable = (card?.canUndo ?? false) || (view.kind === 'done' && view.canUndo);

  const menuItems: MenuEntry[] = card
    ? [
        { label: t('anki.study.edit'), icon: Pencil, shortcut: 'E', onSelect: () => setEditing(true) },
        {
          label: t('anki.study.cardInfo'),
          icon: Info,
          onSelect: () => void navigate({ to: '/anki/info/$cardId', params: { cardId: String(card.cardId) } }),
        },
        {
          label: t('anki.study.deckOptions'),
          icon: Settings2,
          onSelect: () => void navigate({ to: '/anki/opcoes/$deckId', params: { deckId: String(card.deckId) } }),
        },
        { kind: 'separator' },
        { kind: 'label', label: t('anki.study.flag') },
        ...FLAG_KEYS.map((key, i): MenuEntry => ({
          label: t(key),
          checked: card.flag === i + 1,
          onSelect: () => void cardAction('flag', i + 1),
        })),
        { kind: 'separator' },
        {
          label: t(card.marked ? 'anki.study.unmark' : 'anki.study.mark'),
          icon: Star,
          shortcut: '*',
          onSelect: () => void cardAction('mark'),
        },
        { label: t('anki.study.bury'), icon: EyeOff, shortcut: '-', onSelect: () => void cardAction('bury') },
        { label: t('anki.study.buryNote'), shortcut: '=', onSelect: () => void cardAction('buryNote') },
        { label: t('anki.study.suspend'), icon: Pause, shortcut: '@', onSelect: () => void cardAction('suspend') },
        { label: t('anki.study.suspendNote'), shortcut: '!', onSelect: () => void cardAction('suspendNote') },
        { kind: 'separator' },
        { label: t('anki.study.replay'), icon: Volume2, shortcut: 'R', onSelect: replay },
      ]
    : [];

  const title = card?.deckName ?? (view.kind === 'done' ? view.deckName : (deckName ?? t('anki.study.title')));

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t('anki.study.title')}
      data-testid="study-page"
      data-side={side ?? view.kind}
      data-shown={shown ?? ''}
      data-card-id={card?.cardId ?? ''}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 px-3 sm:px-4">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={title}>
          {title}
          {card && card.flag > 0 && (
            <span
              aria-hidden
              className="ml-2 inline-block size-2.5 rounded-full align-middle"
              style={{ backgroundColor: FLAG_COLORS[card.flag - 1] }}
            />
          )}
        </h1>
        {card?.source && (
          <Button
            variant="ghost"
            size="sm"
            icon={BookOpen}
            onClick={() => {
              if (card.source) void openSource(card.source);
            }}
            title={t('anki.study.openInBookHint', { local: card.source.label })}
          >
            {t('anki.study.openInBook')}
          </Button>
        )}
        {view.kind === 'done' && (
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => void navigate({ to: '/anki' })}>
            {t('anki.study.backToDecks')}
          </Button>
        )}
        {(card || (view.kind === 'done' && view.canUndo)) && (
          <IconButton
            icon={Undo2}
            label={t('anki.study.undo')}
            shortcut="Ctrl+Z"
            aria-keyshortcuts="Control+Z"
            disabled={!undoable || busy}
            onClick={() => void undo()}
          />
        )}
        {card && (
          <Menu
            label={t('anki.study.actions')}
            items={menuItems}
            trigger={<IconButton icon={Ellipsis} label={t('anki.study.actions')} />}
          />
        )}
      </header>

      {view.kind === 'error' && (
        <div className="px-3 sm:px-4">
          <Notice tone="error" onRetry={() => setAttempt((n) => n + 1)}>
            {t('anki.study.loadError')} <span className="text-muted">{view.message}</span>
          </Notice>
        </div>
      )}

      {view.kind === 'done' && (
        <DoneView onBack={() => void navigate({ to: '/anki' })} />
      )}

      <div
        className={
          view.kind === 'done' || view.kind === 'error'
            ? 'hidden'
            : 'relative mx-3 min-h-0 flex-1 overflow-hidden rounded-box border border-line bg-card sm:mx-4'
        }
      >
        <CardFrame
          ref={frame}
          src={core.cardFrameUrl()}
          title={t('anki.study.cardFrame')}
          onMessage={onCardMessage}
          className="absolute inset-0 size-full border-0"
        />
        {view.kind === 'loading' && (
          <div
            role="status"
            aria-busy="true"
            aria-label={t('anki.study.loading')}
            className="absolute inset-0 flex flex-col items-center gap-4 bg-card px-6 pt-10"
          >
            <Skeleton className="h-6 w-2/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {video && (
          <div className="absolute inset-0 flex items-center justify-center bg-overlay p-4">
            <video
              src={video}
              autoPlay
              controls
              className="max-h-full max-w-full rounded-box"
              onEnded={() => player.stop()}
              onError={() => player.stop()}
            />
            <IconButton
              icon={X}
              label={t('anki.study.closeVideo')}
              variant="neutral"
              className="absolute top-3 right-3"
              onClick={() => player.stop()}
            />
          </div>
        )}
      </div>

      {card && (
        <footer className="flex shrink-0 flex-col items-center gap-2 px-3 pt-2.5 pb-3 sm:px-4">
          <div className="flex items-center gap-3">
            {card.showCounts && <StudyCounts counts={card.counts} queue={card.queue} />}
            {card.showTimer && side === 'question' && <StudyTimer startedAt={startedAt} maxSecs={card.timerMaxSecs} />}
          </div>
          {side === 'question' ? (
            <ShowAnswerButton ref={showRef} onClick={() => void showAnswer()} disabled={busy} />
          ) : (
            <AnswerButtons
              labels={view.kind === 'card' && view.answer ? view.answer.buttons : card.buttons}
              showIntervals={card.showIntervals}
              onAnswer={(r) => void answer(r)}
              disabled={busy || !statesMutated}
              goodRef={goodRef}
            />
          )}
        </footer>
      )}

      {card && (
        <NoteEditorDialog
          noteId={editing ? card.noteId : null}
          open={editing}
          onOpenChange={setEditing}
          onSaved={() => {
            setEditing(false);
            reloadCurrent();
          }}
        />
      )}
    </section>
  );
}

/**
 * Nothing (more) to study: Anki's own congrats page (spec 8.3), like the desktop shows for an empty or finished
 * deck. It is the only message (it covers both cases, the next learning card and buried cards); the single back
 * action is in the study header.
 */
function DoneView({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 sm:px-4" data-testid="study-done">
      <div className="min-h-64 flex-1 overflow-hidden rounded-box border border-line">
        <AnkiWebPage bare route="congrats" title={t('anki.study.congrats')} onClose={onBack} />
      </div>
    </div>
  );
}

function StudyTimer({ startedAt, maxSecs }: { startedAt: number; maxSecs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const over = maxSecs > 0 && secs >= maxSecs;
  const shownSecs = over ? maxSecs : secs;
  const text = `${Math.floor(shownSecs / 60)}:${String(shownSecs % 60).padStart(2, '0')}`;
  return (
    <span
      role="timer"
      className={over ? 'tabular text-sm text-error' : 'tabular text-sm text-muted'}
      aria-label={t('anki.study.timer')}
    >
      {text}
    </span>
  );
}
