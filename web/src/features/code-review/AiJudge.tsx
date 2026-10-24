// "Pedir avaliação da IA" (spec 11.2, Appendix C.1): the judge's verdict, its short explanation and the suggested
// rating — a suggestion only, the user rates.
import { Sparkles } from 'lucide-react';
import { Notice, Spinner } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import type { AiJudgeResult as AiJudgeData } from '../../lib/core/types';
import { AiErrorNotice } from '../ai/useAiCall';
import type { CodeOutcome } from './run';
import { RATING_LABEL } from './verdict';

export type AiJudgeState =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'done'; result: AiJudgeData }
  | { kind: 'error'; error: unknown };

/** Longest checker summary sent (the diff of a long output is cut). */
const MAX_SUMMARY = 4000;

/** What the checker found, as text for the judge: differences, failing tests, output, compiler errors. */
export function outcomeSummary(o: CodeOutcome): string {
  const parts: string[] = [];
  if (o.notice) parts.push(o.notice);
  for (const d of o.command?.diffs ?? []) parts.push(d.message);
  for (const row of o.tests ?? []) if (!row.ok) parts.push(`Teste ${row.name}: ${row.message}`);
  if (o.output) parts.push(`Saída esperada:\n${o.output.expected}\nSaída obtida:\n${o.output.got}`);
  if (o.compile && !o.compile.ok) parts.push(`Compilação:\n${o.compile.stderr}`);
  else if (o.stderr.trim()) parts.push(`Erros:\n${o.stderr}`);
  if (o.timedOut) parts.push('Tempo esgotado.');
  return parts.join('\n').slice(0, MAX_SUMMARY);
}

export function AiJudgeResult({ state, onDismiss }: { state: AiJudgeState; onDismiss: () => void }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'asking')
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> {t('codeReview.aiAsking')}
      </p>
    );
  if (state.kind === 'error') return <AiErrorNotice error={state.error} onDismiss={onDismiss} />;
  const r = state.result;
  const rating = RATING_LABEL[r.notaSugerida as 1 | 2 | 3 | 4];
  return (
    <Notice tone="info" onDismiss={onDismiss}>
      <span className="flex flex-col gap-1" data-testid="code-ai-result" data-verdict={r.veredito}>
        <span className="flex items-center gap-1.5 font-semibold">
          <Sparkles size={14} aria-hidden />
          {t('codeReview.aiTitle', { veredito: t(`codeReview.aiVerdict.${r.veredito}` as MessageKey) })}
        </span>
        <span>{r.explicacao}</span>
        {rating && <span className="text-xs">{t('codeReview.aiSuggestion', { nota: t(rating) })}</span>}
      </span>
    </Notice>
  );
}
