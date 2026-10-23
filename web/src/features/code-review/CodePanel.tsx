// The interactive part of a code card (spec 11.2), below the sandboxed card frame that shows the Pergunta: the
// command input or the code editor, "Verificar" (Enter / Ctrl+Enter) and "Mostrar resposta", the progress of a
// run, then the verdict with its diff/tests/output, the reference answer, the Observação, "Contestar" and
// "Pedir avaliação da IA". After a check the answer side is shown with the suggested rating preselected in the
// study engine's answer bar (Enter confirms it, 1–4 pick another). Shared by the Anki tab and the mini-review.
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Play, Settings, Sparkles, ThumbsUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Kbd, Notice, Spinner, useToast } from '../../components/ui';
import { CodeEditor, loadCodeMirror, type CodeLanguage } from '../../components/code/CodeEditor';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import type { CodeSettings, StudyCard } from '../../lib/core/types';
import { htmlToCode } from '../anki/editor/codeField';
import type { StudySession } from '../anki/study/useStudySession';
import { CodeResult, ReferenceBlock, ResultSection, VerdictBadge } from './CodeResult';
import { CommandInput } from './CommandInput';
import { pushHistory } from './history';
import { suggestRating } from '@leitor/checkers';
import { isAbort, referenceFromCard, runCodeCheck, type CodeOutcome } from './run';
import { pythonManager } from './run/python';
import { RATING_LABEL } from './verdict';

export const DEFAULT_CODE_SETTINGS: CodeSettings = {
  suggestEasy: false,
  suggestEasySecs: 10,
  outputExact: false,
  cppBackend: 'auto',
  runnerUrl: null,
  runnerTokenSet: false,
};

export const codeSettingsQuery = {
  queryKey: ['code', 'settings'] as const,
  queryFn: () => core.codeSettingsGet(),
};

type Phase = 'editing' | 'running' | 'done' | 'gaveUp';

export interface CodePanelProps {
  session: StudySession;
  card: StudyCard;
  /** The book panel's mini-review (narrow). */
  compact?: boolean;
  /** Prefilled answer, verified at once (`?codigo=`, for captures and e2e). */
  autoAnswer?: string | undefined;
}

function editorLanguage(raw: string): CodeLanguage {
  const v = raw.trim().toLowerCase();
  if (v === 'python' || v === 'py') return 'python';
  if (v === 'cpp' || v === 'c++') return 'cpp';
  return 'text';
}

export function CodePanel({ session, card, compact, autoAnswer }: CodePanelProps) {
  const code = card.code!;
  const toast = useToast();
  const navigate = useNavigate();
  const settingsQ = useQuery(codeSettingsQuery);
  const settings = settingsQ.data ?? DEFAULT_CODE_SETTINGS;
  // Extra accepted answers of a type without an Aceitas field (`code_note_extra`).
  const extraQ = useQuery({
    queryKey: ['code', 'noteExtra', card.noteId],
    queryFn: () => core.codeNoteExtraGet(card.noteId),
    enabled: !code.acceptedField,
  });
  const reference = useMemo(() => referenceFromCard(code, extraQ.data ?? null), [code, extraQ.data]);
  const language = code.role === 'command' ? 'shell' : editorLanguage(htmlToCode(code.fields.language));
  const [answer, setAnswer] = useState(() => (code.role === 'program' ? htmlToCode(code.fields.initial) : ''));
  const [phase, setPhase] = useState<Phase>('editing');
  const [outcome, setOutcome] = useState<CodeOutcome | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [contestOpen, setContestOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoDone = useRef(false);
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const side = session.side;
  // After a check, bring the verdict and its details into view (the study body scrolls on short windows).
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Once the answer side is laid out (the card frame shrinks then): a result taller than the view aligns its top.
    if (phase !== 'done' || side !== 'answer') return;
    const el = resultRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [phase, side]);
  const locked = phase !== 'editing' || side === 'answer';

  // Python: the worker is created and preloaded on the first Python card shown; the editor is warmed up.
  useEffect(() => {
    if (code.role === 'program') void loadCodeMirror().catch(() => undefined);
    if (code.role === 'program' && language === 'python') pythonManager().preload();
  }, [code.role, language]);

  // Leaving the card (or the screen) cancels a run in flight; its result is then dropped.
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  async function verify(text = answerRef.current) {
    if (busy.current || phase !== 'editing' || side !== 'question' || session.paused) return;
    if (text.trim() === '') {
      setHint(t('codeReview.empty'));
      return;
    }
    setHint(null);
    if (code.role === 'command') pushHistory('command', text);
    busy.current = true;
    setPhase('running');
    const controller = new AbortController();
    abort.current = controller;
    let result: CodeOutcome;
    try {
      result = await runCodeCheck(reference, text, { outputExact: settings.outputExact, signal: controller.signal });
    } catch (e) {
      abort.current = null;
      busy.current = false;
      if (!alive.current) return;
      if (isAbort(e)) {
        setPhase('editing');
        setHint(t('codeReview.cancelled'));
        return;
      }
      result = {
        verdict: 'unverifiable',
        notice: t('codeReview.checkFailed', { erro: e instanceof Error ? e.message : String(e) }),
        command: null,
        tests: null,
        output: null,
        structure: null,
        compile: null,
        stderr: '',
        timedOut: false,
        durationMs: 0,
        modeUsed: code.role === 'command' ? 'command' : reference.mode,
      };
    }
    abort.current = null;
    busy.current = false;
    if (!alive.current) return;
    setOutcome(result);
    setPhase('done');
    const rating = suggestRating(result.verdict, {
      suggestEasy: settings.suggestEasy,
      easySecs: settings.suggestEasySecs,
      elapsedMs: session.elapsedMs(),
    });
    await session.revealCode(rating);
  }

  function giveUp() {
    if (phase !== 'editing' || side !== 'question') return;
    setPhase('gaveUp');
    void session.revealCode(null);
  }

  function cancel() {
    abort.current?.abort();
  }

  // `?codigo=`: the first code card is prefilled and verified at once.
  useEffect(() => {
    if (autoAnswer === undefined || autoDone.current || session.view.kind !== 'card') return;
    if (session.side !== 'question') return;
    autoDone.current = true;
    setAnswer(autoAnswer);
    void verify(autoAnswer);
    // verify reads the latest state through refs/closures of this render.
  });

  async function contest(addToAccepted: boolean) {
    setContestOpen(false);
    if (addToAccepted && code.role === 'command') {
      try {
        const res = await core.codeAcceptAnswer(card.noteId, answerRef.current.trim());
        toast.show(t(res.target === 'already' ? 'codeReview.contestAlready' : 'codeReview.contestAdded'));
        void extraQ.refetch();
      } catch (e) {
        toast.show(t('codeReview.contestFailed', { erro: e instanceof Error ? e.message : String(e) }), {
          tone: 'error',
        });
      }
    }
    setAccepted(true);
    void session.revealCode(3);
  }

  const suggestion = session.codeSuggestion?.rating ?? null;
  const verdict = outcome?.verdict ?? null;
  const canContest =
    phase === 'done' && !accepted && (verdict === 'almost' || verdict === 'wrong' || verdict === 'unverifiable');
  const canAskAi = phase === 'done' && !accepted && (verdict === 'wrong' || verdict === 'unverifiable');
  const notes = htmlToCode(code.fields.notes).trim();
  const showNotes = side === 'answer' && !code.answerShowsNotes && notes !== '';

  return (
    <div
      className={cn('@container flex min-w-0 flex-col', compact ? 'gap-2' : 'gap-3')}
      data-code-panel
      data-testid="code-panel"
      data-role={code.role}
      data-phase={phase}
      role="region"
      aria-label={t('codeReview.region')}
    >
      {code.role === 'command' ? (
        <CommandInput
          ref={inputRef}
          value={answer}
          onChange={setAnswer}
          onSubmit={() => void verify()}
          readOnly={locked}
          autoFocus={!autoAnswer}
        />
      ) : (
        <CodeEditor
          value={answer}
          onChange={setAnswer}
          language={language}
          ariaLabel={t('codeReview.editorLabel', {
            linguagem: language === 'cpp' ? t('codeReview.language.cpp') : t('codeReview.language.python'),
          })}
          minLines={compact ? 4 : 6}
          maxLines={compact ? 14 : 22}
          readOnly={locked}
          autoFocus={!autoAnswer}
          onSubmit={() => void verify()}
        />
      )}

      {side === 'question' && phase === 'editing' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size={compact ? 'sm' : 'md'}
            icon={Play}
            onClick={() => void verify()}
            disabled={session.paused || session.busy}
          >
            {t('codeReview.verify')}
          </Button>
          <Button
            variant="ghost"
            size={compact ? 'sm' : 'md'}
            onClick={giveUp}
            disabled={session.paused || session.busy}
          >
            {t('codeReview.showAnswer')}
          </Button>
          {!compact && (
            <span className="ml-auto hidden items-center gap-1 text-xs text-muted @md:inline-flex">
              {code.role === 'command' ? (
                <>
                  <Kbd>Enter</Kbd> {t('codeReview.commandHint').replace(/^Enter /, '')}
                </>
              ) : (
                <>
                  <Kbd>Ctrl+Enter</Kbd> {t('codeReview.editorHint').replace(/^Ctrl\+Enter /, '')}
                </>
              )}
            </span>
          )}
        </div>
      )}
      {hint && phase === 'editing' && <p className="text-sm text-muted">{hint}</p>}

      {phase === 'running' && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status" data-testid="code-running">
          <Spinner label={t('codeReview.running')} />
          <span>{t('codeReview.running')}</span>
          {code.role === 'program' && language === 'python' && (
            <Button variant="ghost" size="sm" onClick={cancel}>
              {t('codeReview.cancel')}
            </Button>
          )}
        </div>
      )}

      {phase === 'done' && outcome && (
        <div ref={resultRef} className="flex min-w-0 scroll-mt-2 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictBadge outcome={outcome} accepted={accepted} />
            {side === 'answer' && (
              <span className="text-sm text-muted" data-testid="code-suggestion">
                {suggestion
                  ? `${t('codeReview.suggested', { nota: t(RATING_LABEL[suggestion]) })} · ${t('codeReview.suggestedHint')}`
                  : t('codeReview.chooseRating')}
              </span>
            )}
          </div>
          {outcome.notice && (
            <Notice tone="info">
              <span data-testid="code-notice">{outcome.notice}</span>
            </Notice>
          )}
          <CodeResult outcome={outcome} reference={reference} answer={answer} />
          {(canContest || canAskAi) && (
            <div className="flex flex-wrap items-center gap-2">
              {canContest && (
                <Button size="sm" icon={ThumbsUp} onClick={() => setContestOpen(true)}>
                  {t('codeReview.contest')}
                </Button>
              )}
              {canAskAi && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Sparkles}
                  onClick={() => setAiOpen((o) => !o)}
                  aria-expanded={aiOpen}
                >
                  {t('codeReview.ai')}
                </Button>
              )}
            </div>
          )}
          {aiOpen && canAskAi && (
            <Notice tone="info" onDismiss={() => setAiOpen(false)}>
              <span className="flex flex-col items-start gap-1" data-testid="code-ai-placeholder">
                <span>{t('codeReview.aiPlaceholder')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Settings}
                  className="-ml-2.5"
                  onClick={() => void navigate({ to: '/configuracoes/ia' })}
                >
                  {t('codeReview.aiSettings')}
                </Button>
              </span>
            </Notice>
          )}
        </div>
      )}

      {phase === 'gaveUp' && side === 'answer' && (
        <p className="text-sm text-muted" data-testid="code-suggestion">
          {t('codeReview.gaveUp')} {t('codeReview.chooseRating')}
        </p>
      )}

      {side === 'answer' && (phase === 'done' || phase === 'gaveUp') && !code.answerShowsAnswer && (
        <ResultSection title={t('codeReview.reference')}>
          <ReferenceBlock code={reference.answer} />
        </ResultSection>
      )}
      {showNotes && (
        <ResultSection title={t('codeReview.notes')}>
          <p className="text-sm whitespace-pre-wrap" data-testid="code-notes">
            {notes}
          </p>
        </ResultSection>
      )}

      <ContestDialog
        open={contestOpen}
        onOpenChange={setContestOpen}
        command={code.role === 'command'}
        onConfirm={(add) => void contest(add)}
      />
    </div>
  );
}

function ContestDialog({
  open,
  onOpenChange,
  command,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  command: boolean;
  onConfirm: (addToAccepted: boolean) => void;
}) {
  const [add, setAdd] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('codeReview.contestTitle')}
      description={t('codeReview.contestText')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => onConfirm(command && add)} data-testid="code-contest-confirm">
            {t('codeReview.contestConfirm')}
          </Button>
        </>
      }
    >
      {command && (
        <div className="flex flex-col gap-1 pb-2">
          <Checkbox
            checked={add}
            onChange={(e) => setAdd(e.target.checked)}
            label={t('codeReview.contestAdd')}
            data-testid="code-contest-add"
          />
          <p className="pl-6 text-xs text-muted">{t('codeReview.contestAddHint')}</p>
        </div>
      )}
    </Dialog>
  );
}
