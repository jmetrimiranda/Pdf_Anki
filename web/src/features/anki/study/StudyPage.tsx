// "Estudar" (spec 8.2, 8.4, 10.1): the desktop reviewer rebuilt around Anki's own reviewer.js. The core renders the
// card exactly like qt/aqt/reviewer.py (core-anki `study`); the card runs in a sandboxed iframe (CardFrame) that
// reaches the app only through validated postMessage; audio/TTS play here (audio.ts); the bottom bar, keys and
// actions are native. The flow lives in useStudySession (shared with the book panel's mini-review); this is the
// Anki tab's layout, and the tab's side of "one place studies at a time" (spec 10.1).
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  BookOpen,
  EyeOff,
  Info,
  Pause,
  Pencil,
  Settings2,
  Star,
  Undo2,
  Volume2,
  Ellipsis,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, IconButton, Menu, Notice, useToast, type MenuEntry } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { AnkiWebPage } from '../pages/AnkiWebPage';
import { NoteEditorDialog } from '../editor/NoteEditorDialog';
import { CodePanel } from '../../code-review/CodePanel';
import { AnswerButtons, ShowAnswerButton, StudyCounts } from './AnswerBar';
import { StudyStage } from './StudyStage';
import { FLAG_COLORS, FLAG_KEYS, useStudySession } from './useStudySession';

export { cardBodyClass, platformClass } from './useStudySession';

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
  codeAnswer,
}: {
  deckId?: number;
  deckName?: string;
  showAnswer?: boolean;
  /** `?codigo=`: the first code card is prefilled with this answer and verified at once (captures, e2e). */
  codeAnswer?: string | undefined;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const session = useStudySession({
    owner: 'tab',
    // Resuming keeps the deck on screen (the current deck may be the panel's by now).
    start: async (current) => {
      const id = current ?? (await resolveDeck(deckId, deckName));
      return { deckId: id, next: await core.ankiStudyNext(id, 'tab') };
    },
    startKey: `${deckId ?? ''}|${deckName ?? ''}`,
    close: () => core.ankiStudyClose('tab'),
    autoShowAnswer,
    onPreemptedOther: (other) => {
      if (other === 'panel') toast.show(t('anki.study.panelPaused'));
    },
  });
  const { view, card, side, busy, statesMutated, shown, startedAt, editing, setEditing, undoable, paused } = session;
  const { cardAction, replay } = session;
  // `codeAnswer` goes to the first code card only.
  const [codeAnswerCard, setCodeAnswerCard] = useState<number | null>(null);
  useEffect(() => {
    if (codeAnswer !== undefined && codeAnswerCard === null && card?.code) setCodeAnswerCard(card.cardId);
  }, [codeAnswer, codeAnswerCard, card]);
  const code = card?.code ? card : null;

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
          onSelect: () => cardAction('flag', i + 1),
        })),
        { kind: 'separator' },
        {
          label: t(card.marked ? 'anki.study.unmark' : 'anki.study.mark'),
          icon: Star,
          shortcut: '*',
          onSelect: () => cardAction('mark'),
        },
        { label: t('anki.study.bury'), icon: EyeOff, shortcut: '-', onSelect: () => cardAction('bury') },
        { label: t('anki.study.buryNote'), shortcut: '=', onSelect: () => cardAction('buryNote') },
        { label: t('anki.study.suspend'), icon: Pause, shortcut: '@', onSelect: () => cardAction('suspend') },
        { label: t('anki.study.suspendNote'), shortcut: '!', onSelect: () => cardAction('suspendNote') },
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
              if (card.source) session.openSource(card.source);
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
            onClick={session.undo}
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

      {paused && (
        <div className="px-3 pb-2 sm:px-4" data-testid="study-paused">
          <Notice tone="info">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1">{t('anki.study.pausedByPanel')}</span>
              <Button variant="ghost" size="sm" onClick={session.resume} disabled={busy}>
                {t('anki.study.resume')}
              </Button>
            </span>
          </Notice>
        </div>
      )}

      {view.kind === 'error' && (
        <div className="px-3 sm:px-4">
          <Notice tone="error" onRetry={session.retry}>
            {t('anki.study.loadError')} <span className="text-muted">{view.message}</span>
          </Notice>
        </div>
      )}

      {view.kind === 'done' && <DoneView onBack={() => void navigate({ to: '/anki' })} />}

      <div
        className={
          view.kind === 'done' || view.kind === 'error'
            ? 'hidden'
            : code
              ? 'mx-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto sm:mx-4'
              : 'mx-3 flex min-h-0 flex-1 flex-col sm:mx-4'
        }
        data-testid="study-body"
      >
        <StudyStage
          session={session}
          className={
            code
              ? // The Pergunta (question side) or the card's answer side, above the code panel. The answer side
                // stays small (it scrolls inside) so the verdict, diff/tests and Contestar fit below it.
                side === 'answer'
                ? 'relative max-h-72 min-h-28 shrink-0 basis-[30%] overflow-hidden rounded-box border border-line bg-card'
                : 'relative min-h-28 shrink-0 basis-[28%] overflow-hidden rounded-box border border-line bg-card'
              : 'relative min-h-0 flex-1 overflow-hidden rounded-box border border-line bg-card'
          }
        />
        {code && (
          <div className="shrink-0 pb-1">
            <CodePanel
              key={code.cardId}
              session={session}
              card={code}
              autoAnswer={codeAnswerCard === code.cardId ? codeAnswer : undefined}
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
            // Code cards answer through the code panel (Verificar / Mostrar resposta).
            !card.code && (
              <ShowAnswerButton ref={session.showRef} onClick={session.showAnswer} disabled={busy || paused} />
            )
          ) : (
            <AnswerButtons
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
