// The result of a code check (spec 11.2 item 3): the verdict, a visual diff (tokens for commands, lines for
// output, side by side for structure), the tests, compile errors, the reference answer and the Observação.
import { Check, ChevronRight, Copy, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, IconButton, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { CodeOutcome, CodeReference } from './run';
import { shellTokens, tokenDiff, type DiffOp } from '@leitor/checkers';
import { VERDICT_LABEL, VERDICT_TONE } from './verdict';

export function VerdictBadge({ outcome, accepted }: { outcome: CodeOutcome; accepted: boolean }) {
  const label = accepted ? t('codeReview.verdict.accepted') : t(VERDICT_LABEL[outcome.verdict]);
  return (
    <Badge tone={accepted ? 'lime' : VERDICT_TONE[outcome.verdict]} className="h-6 px-2.5 text-xs">
      <span data-testid="code-verdict" data-verdict={accepted ? 'accepted' : outcome.verdict}>
        {label}
      </span>
    </Badge>
  );
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h3 className="text-xs font-semibold text-muted">{title}</h3>
      {children}
    </section>
  );
}

const pre =
  'max-h-64 overflow-auto rounded-ctl border border-line bg-surface px-2.5 py-1.5 font-mono text-sm whitespace-pre';

/**
 * A checker diff message: the checker quotes tokens Markdown-style (`topic`); show those parts as inline code
 * instead of literal backticks. The message text itself stays unchanged (Apêndice B tests match it).
 */
export function DiffMessage({ text }: { text: string }) {
  const parts = text.split('`');
  // An unbalanced backtick (odd count) leaves the text after it as plain text.
  const balanced = parts.length % 2 === 1;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && (balanced || i < parts.length - 1) ? (
          <code key={i} className="rounded-sm bg-surface px-1 font-mono text-[0.92em]">
            {part}
          </code>
        ) : (
          <span key={i}>{i % 2 === 1 ? `\`${part}` : part}</span>
        ),
      )}
    </>
  );
}

/** The command answer against the matched reference, token by token. */
export function TokenDiffView({ ops }: { ops: DiffOp[] }) {
  return (
    <p
      className="flex flex-wrap gap-x-1.5 gap-y-1 rounded-ctl border border-line bg-surface px-2.5 py-1.5 font-mono text-sm break-all"
      data-testid="code-token-diff"
    >
      {ops.map((op, i) => (
        <span
          key={i}
          data-op={op.op}
          className={cn(
            op.op === 'insert' && 'text-error line-through decoration-2',
            op.op === 'delete' && 'text-lime-dark underline decoration-2 underline-offset-4',
          )}
        >
          {op.op === 'insert' && <span className="sr-only">{t('codeReview.diff.extra')} </span>}
          {op.op === 'delete' && <span className="sr-only">{t('codeReview.diff.missing')} </span>}
          {op.text}
        </span>
      ))}
    </p>
  );
}

export function LineDiffView({ ops }: { ops: DiffOp[] }) {
  return (
    <pre className={pre} data-testid="code-line-diff">
      {ops.length === 0 && <span className="text-muted">{t('codeReview.output.empty')}</span>}
      {ops.map((op, i) => (
        <div
          key={i}
          data-op={op.op}
          className={cn(
            op.op === 'insert' && 'bg-error-soft text-error',
            op.op === 'delete' && 'bg-lime-soft text-lime-dark',
          )}
        >
          <span aria-hidden className="mr-2 inline-block w-2 text-muted select-none">
            {op.op === 'insert' ? '+' : op.op === 'delete' ? '−' : ' '}
          </span>
          {op.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function SideBySide({ expected, got }: { expected: string; got: string }) {
  return (
    <div className="grid min-w-0 gap-2 @lg:grid-cols-2" data-testid="code-structure">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-2xs text-muted">{t('codeReview.structure.expected')}</span>
        <pre className={pre}>{expected}</pre>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-2xs text-muted">{t('codeReview.structure.got')}</span>
        <pre className={pre}>{got}</pre>
      </div>
    </div>
  );
}

export function ReferenceBlock({ code }: { code: string }) {
  const toast = useToast();
  return (
    <div className="relative min-w-0">
      <pre className={cn(pre, 'pr-10')} data-testid="code-reference">
        {code}
      </pre>
      <IconButton
        icon={Copy}
        size="sm"
        label={t('codeReview.copy')}
        className="absolute top-1 right-1"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(
            () => toast.show(t('codeReview.copied')),
            () => undefined,
          );
        }}
      />
    </div>
  );
}

/** The reference variant the command checker matched (0 = Resposta, n = the n-th accepted one). */
export function matchedReference(ref: CodeReference, matched: number): string {
  return matched > 0 ? (ref.accepted[matched - 1] ?? ref.answer) : ref.answer;
}

export function CodeResult({
  outcome,
  reference,
  answer,
}: {
  outcome: CodeOutcome;
  reference: CodeReference;
  answer: string;
}) {
  const [compileOpen, setCompileOpen] = useState(true);
  const cmd = outcome.command;
  const showTokenDiff = cmd && outcome.verdict !== 'correct' && answer.trim() !== '';
  const passed = outcome.tests?.filter((x) => x.ok).length ?? 0;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="code-result">
      {showTokenDiff && (
        <Section title={t('codeReview.diff.title')}>
          <TokenDiffView
            ops={tokenDiff(shellTokens(matchedReference(reference, cmd.matchedVariant)), shellTokens(answer))}
          />
          {cmd.diffs.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-sm" data-testid="code-diff-messages">
              {cmd.diffs.map((d, i) => (
                <li key={i} className="text-fg">
                  <DiffMessage text={d.message} />
                </li>
              ))}
            </ul>
          )}
          <p className="text-2xs text-muted">{t('codeReview.diff.legend')}</p>
        </Section>
      )}

      {outcome.compile && !outcome.compile.ok && (
        <section className="flex min-w-0 flex-col gap-1" data-testid="code-compile">
          <button
            type="button"
            aria-expanded={compileOpen}
            onClick={() => setCompileOpen((o) => !o)}
            className="inline-flex items-center gap-1 self-start rounded-ctl text-xs font-semibold text-muted hover:text-fg"
          >
            <ChevronRight size={14} aria-hidden className={cn('transition-transform', compileOpen && 'rotate-90')} />
            {t('codeReview.compile.title')}
          </button>
          {compileOpen && <pre className={cn(pre, 'text-error')}>{outcome.compile.stderr.trim() || '—'}</pre>}
        </section>
      )}

      {outcome.tests && outcome.tests.length > 0 && (
        <Section title={t('codeReview.tests.title')} testId="code-tests">
          <p className="text-sm text-muted" data-testid="code-tests-summary">
            {t('codeReview.tests.summary', { ok: passed, total: outcome.tests.length })}
          </p>
          <ul className="flex flex-col divide-y divide-line rounded-ctl border border-line">
            {outcome.tests.map((row, i) => (
              <li key={i} className="flex min-w-0 items-start gap-2 px-2.5 py-1.5" data-ok={row.ok ? 'true' : 'false'}>
                {row.ok ? (
                  <Check size={15} className="mt-0.5 shrink-0 text-lime-dark" aria-label={t('codeReview.tests.pass')} />
                ) : (
                  <X size={15} className="mt-0.5 shrink-0 text-error" aria-label={t('codeReview.tests.fail')} />
                )}
                <div className="min-w-0 flex-1">
                  <code className="block font-mono text-sm break-all">{row.name}</code>
                  {row.message && <span className="block text-xs whitespace-pre-wrap text-muted">{row.message}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {outcome.output && (
        <Section title={t('codeReview.output.title')} testId="code-output">
          {outcome.verdict === 'correct' ? (
            <>
              <p className="text-sm text-muted">{t('codeReview.output.same')}</p>
              <pre className={pre}>{outcome.output.got || t('codeReview.output.empty')}</pre>
            </>
          ) : (
            <>
              <LineDiffView ops={outcome.output.diff} />
              <p className="text-2xs text-muted">{t('codeReview.output.legend')}</p>
            </>
          )}
        </Section>
      )}

      {outcome.structure && (
        <Section title={t('codeReview.structure.title')}>
          <SideBySide expected={outcome.structure.expected} got={outcome.structure.got} />
        </Section>
      )}

      {outcome.stderr.trim() !== '' && !(outcome.compile && !outcome.compile.ok) && (
        <Section title={t('codeReview.stderr.title')} testId="code-stderr">
          <pre className={cn(pre, 'text-error')}>{outcome.stderr.trim()}</pre>
        </Section>
      )}
    </div>
  );
}

export { Section as ResultSection };
