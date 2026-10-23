// "Revisar aqui" (spec 10.1): a mini-review of one of the book's decks inside the book panel, with the Anki tab's
// study engine (useStudySession: the same sandboxed CardFrame, answers, undo, keys, audio). Rules:
// - only one place studies at a time: opening it preempts a study session in the Anki tab (toast), and when the tab
//   takes over this one pauses ("Continuar aqui" takes it back);
// - the core remembers the current deck, switches to the chosen one and restores it on close (unless the tab took
//   over: its explicit deck choice wins);
// - Ctrl+Z only undoes an answer (StudyNext.canUndo), and only with the focus in the panel — never in PdfCraft,
//   where Ctrl+Z is PdfCraft's own undo;
// - the reading session is paused (reason 'review') while it is open.
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Ellipsis, EyeOff, Pause, Pencil, Star, Undo2, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button, IconButton, Menu, Notice, SegmentedControl, useToast, type MenuEntry } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { NoteEditorDialog } from '../../anki/editor/NoteEditorDialog';
import { AnswerButtons, ShowAnswerButton, StudyCounts } from '../../anki/study/AnswerBar';
import { CodePanel } from '../../code-review/CodePanel';
import { StudyStage } from '../../anki/study/StudyStage';
import { focusWithin, studyInOrder, useStudySession } from '../../anki/study/useStudySession';
import { leitor, useLeitorSelector } from '../../leitor';
import { useMediaQuery } from '../../../lib/useMediaQuery';

export interface MiniReviewDeck {
  deckId: number;
  name: string;
  role: 'vocab' | 'content';
}

export interface MiniReviewProps {
  bookUid: string;
  decks: MiniReviewDeck[];
  initialDeckId: number;
  onClose: () => void;
}

/** The last segment of a full deck name (`A::B::C` → `C`). */
function leafName(name: string): string {
  const parts = name.split('::');
  return parts[parts.length - 1] || name;
}

export function MiniReview({ bookUid, decks, initialDeckId, onClose }: MiniReviewProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const root = useRef<HTMLElement>(null);
  const [deckId, setDeckIdState] = useState(initialDeckId);
  const deckRef = useRef(initialDeckId);
  /** The core's mini-review is closed (or not opened yet): closing again is a no-op. */
  const closed = useRef(true);
  /** The last focus inside the app document was in this panel (not PdfCraft, not another control). */
  const focusWasInside = useRef(false);

  const toastRef = useRef(toast);
  toastRef.current = toast;

  /**
   * Closes the core's mini-review once (restores the previous deck), resumes reading and refreshes the counts.
   * Returns null when it was already closed. Callers outside the study engine run it through `studyInOrder`.
   */
  const closeOnce = useCallback((): Promise<unknown> | null => {
    if (closed.current) return null;
    closed.current = true;
    leitor.setReviewing(false);
    return core
      .ankiMiniReviewClose()
      .catch(() => undefined)
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: ['bookPanel'] });
        void queryClient.invalidateQueries({ queryKey: ['anki', 'deckTree'] });
        void queryClient.invalidateQueries({ queryKey: ['anki', 'deckNames'] });
      });
  }, [queryClient]);

  /** Button, Esc, window close: in order with the engine's starts and closes. */
  const finish = useCallback(() => {
    if (closed.current) return;
    leitor.setReviewing(false);
    void studyInOrder(async () => closeOnce());
  }, [closeOnce]);

  // The card follows PdfCraft's theme, like the panel around it (spec 4); the system's until PdfCraft reports it.
  const pdfcraftTheme = useLeitorSelector((s) => s.theme);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const session = useStudySession({
    owner: 'panel',
    dark: (pdfcraftTheme ?? (prefersDark ? 'dark' : 'light')) === 'dark',
    // The deck chosen here (switching decks starts again; the core keeps the deck from before the first opening).
    start: async () => {
      closed.current = false;
      leitor.setReviewing(true);
      const opened = await core.ankiMiniReviewOpen(deckRef.current);
      if (opened.preempted === 'tab') toastRef.current.show(t('miniReview.tabPaused'));
      return { deckId: deckRef.current, next: opened.next };
    },
    startKey: deckId,
    close: async () => closeOnce(),
    // Only with the focus in the panel (keys from the card frame come as its own messages). A focused button that
    // the next card replaced leaves the focus on the body: it still counts while nothing else took it since.
    acceptKey: () =>
      focusWithin(root.current) ||
      (focusWasInside.current && (document.activeElement === null || document.activeElement === document.body)),
  });
  const { view, card, side, busy, statesMutated, paused, undoable, editing, setEditing, cardAction } = session;

  // Where the focus went last (focusin bubbles from the PdfCraft iframe element and every app control).
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      focusWasInside.current = e.target instanceof Node && !!root.current?.contains(e.target);
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  // The "Revisar aqui" button that opened it is gone: the keys belong to the review now.
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  // Window close / reload: the core still restores the deck.
  useEffect(() => {
    const onHide = () => finish();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [finish]);

  function close() {
    finish();
    onClose();
  }

  function switchDeck(id: number) {
    if (id === deckRef.current) return;
    deckRef.current = id;
    setDeckIdState(id);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== 'Escape' || editing || e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('[role="menu"],[role="dialog"],[role="listbox"]')) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  const current = decks.find((d) => d.deckId === deckId);
  const deckLabel = current ? leafName(current.name) : (card?.deckName ?? '');
  const roleLabel = (role: MiniReviewDeck['role']) =>
    t(role === 'vocab' ? 'miniReview.deckVocab' : 'miniReview.deckContent');

  const menuItems: MenuEntry[] = card
    ? [
        {
          label: t('anki.study.edit'),
          icon: Pencil,
          shortcut: 'E',
          // Paused: the other place studies; saving would take the session back (spec 10.1).
          disabled: paused,
          onSelect: () => setEditing(true),
        },
        { kind: 'separator' },
        {
          label: t(card.marked ? 'anki.study.unmark' : 'anki.study.mark'),
          icon: Star,
          shortcut: '*',
          onSelect: () => cardAction('mark'),
        },
        { label: t('anki.study.bury'), icon: EyeOff, shortcut: '-', onSelect: () => cardAction('bury') },
        { label: t('anki.study.suspend'), icon: Pause, shortcut: '@', onSelect: () => cardAction('suspend') },
        { kind: 'separator' },
        { label: t('anki.study.replay'), icon: Volume2, shortcut: 'R', onSelect: session.replay },
      ]
    : [];

  return (
    <section
      ref={root}
      role="region"
      aria-label={t('miniReview.region')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="mini-review"
      data-book={bookUid}
      data-deck-id={deckId}
      data-side={side ?? view.kind}
      data-card-id={card?.cardId ?? ''}
      data-paused={paused ? 'true' : 'false'}
      className="flex h-full min-h-0 w-full min-w-0 flex-col outline-none"
    >
      <header className="flex shrink-0 items-center gap-1 pb-1.5">
        {decks.length === 2 ? (
          <SegmentedControl
            size="sm"
            label={t('miniReview.deck')}
            value={String(deckId)}
            onChange={(v) => switchDeck(Number(v))}
            options={decks.map((d) => ({ value: String(d.deckId), label: roleLabel(d.role) }))}
          />
        ) : (
          <span className="min-w-0 truncate text-sm font-semibold" title={current?.name}>
            {deckLabel}
          </span>
        )}
        <span className="flex-1" />
        <IconButton
          icon={Undo2}
          size="sm"
          label={t('anki.study.undo')}
          shortcut="Ctrl+Z"
          aria-keyshortcuts="Control+Z"
          disabled={!undoable || busy}
          onClick={session.undo}
        />
        {card && (
          <Menu
            label={t('anki.study.actions')}
            items={menuItems}
            trigger={<IconButton icon={Ellipsis} size="sm" label={t('anki.study.actions')} />}
          />
        )}
        <IconButton icon={X} size="sm" label={t('miniReview.close')} onClick={close} />
      </header>

      {decks.length === 2 && (
        <p className="truncate pb-1 text-xs text-(--pc-muted)" title={current?.name}>
          {deckLabel}
        </p>
      )}

      {paused && (
        <div className="pb-2" data-testid="mini-review-paused">
          <Notice tone="info">
            <span className="flex flex-col items-start gap-1">
              <span>{t('miniReview.pausedByTab')}</span>
              <Button variant="ghost" size="sm" className="-ml-2.5" onClick={session.resume} disabled={busy}>
                {t('miniReview.resume')}
              </Button>
            </span>
          </Notice>
        </div>
      )}

      {view.kind === 'error' && (
        <div className="pb-2">
          <Notice tone="error" onRetry={session.retry}>
            {t('miniReview.loadError')} <span className="text-muted">{view.message}</span>
          </Notice>
        </div>
      )}

      {view.kind === 'done' && (
        <div className="flex flex-col items-center gap-3 px-2 py-8 text-center" data-testid="mini-review-done">
          <p className="text-base text-(--pc-muted)">{t('miniReview.done')}</p>
          <Button variant="neutral" size="sm" onClick={close}>
            {t('miniReview.close')}
          </Button>
        </div>
      )}

      <div
        className={
          view.kind === 'done' || view.kind === 'error'
            ? 'hidden'
            : card?.code
              ? 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto'
              : 'flex min-h-0 flex-1 flex-col'
        }
      >
        <StudyStage
          session={session}
          className={
            card?.code
              ? 'relative min-h-36 shrink-0 basis-[35%] overflow-hidden rounded-box border border-(--pc-border) bg-card'
              : 'relative min-h-48 flex-1 overflow-hidden rounded-box border border-(--pc-border) bg-card'
          }
        />
        {card?.code && (
          <div className="shrink-0 pb-1">
            <CodePanel key={card.cardId} compact session={session} card={card} />
          </div>
        )}
      </div>

      {card && (
        <footer className="flex shrink-0 flex-col items-stretch gap-1.5 pt-2">
          <div className="flex min-h-5 items-center justify-between gap-2">
            {card.showCounts ? <StudyCounts compact counts={card.counts} queue={card.queue} /> : <span />}
            {card.source && (
              <Button
                variant="ghost"
                size="sm"
                icon={BookOpen}
                className="-mr-2.5"
                onClick={() => {
                  if (card.source) session.openSource(card.source);
                }}
                title={t('anki.study.openInBookHint', { local: card.source.label })}
              >
                {t('anki.study.openInBook')}
              </Button>
            )}
          </div>
          {side === 'question' ? (
            !card.code && (
              <ShowAnswerButton compact ref={session.showRef} onClick={session.showAnswer} disabled={busy || paused} />
            )
          ) : (
            <AnswerButtons
              compact
              labels={view.kind === 'card' && view.answer ? view.answer.buttons : card.buttons}
              showIntervals={card.showIntervals}
              onAnswer={session.answer}
              disabled={busy || !statesMutated || paused}
              goodRef={session.goodRef}
              groupRef={session.answerBarRef}
              suggested={session.codeSuggestion ? session.codeSuggestion.rating : undefined}
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
            session.reloadCurrent();
          }}
        />
      )}
    </section>
  );
}
