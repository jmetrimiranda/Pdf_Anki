// The "Testar resposta de referência" block of the code notes (spec 11.7): the button, the verdict, the Aceitas
// lines and the check's details (tests, output diff, compile errors: the code review's own CodeResult), inline
// under the fields.
import { FlaskConical } from 'lucide-react';
import { Badge, Button, Notice } from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { CodeResult, VerdictBadge } from '../../code-review/CodeResult';
import { VERDICT_LABEL, VERDICT_TONE } from '../../code-review/verdict';
import type { ReferenceGate, ReferenceResult } from './referenceTest';

/** The result of the last test (verdict, Aceitas lines, tests, output, compile errors). */
export function ReferenceResultView({ result }: { result: ReferenceResult }) {
  if (result.kind === 'error') {
    return (
      <p role="alert" className="text-xs text-error">
        {t('codeAuthoring.testError', { erro: result.message })}
      </p>
    );
  }
  if (result.kind === 'unavailable') return null;
  const o = result.outcome;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="reference-result" data-passed={result.passed}>
      <p className={cn('flex flex-wrap items-center gap-2 text-base', !result.passed && 'text-error')} role="status">
        <VerdictBadge outcome={o} accepted={false} />
        {result.passed ? t('codeAuthoring.testPassed') : t('codeAuthoring.testFailed')}
      </p>
      {o.notice && <p className="text-xs text-muted">{o.notice}</p>}
      {result.accepted.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">{t('codeAuthoring.accepted')}</span>
          <ul className="flex flex-col gap-1" aria-label={t('codeAuthoring.accepted')}>
            {result.accepted.map((a, i) => (
              <li key={i} className="flex min-w-0 items-center gap-2 text-xs" data-testid="reference-accepted">
                <Badge tone={VERDICT_TONE[a.verdict]}>{t(VERDICT_LABEL[a.verdict])}</Badge>
                <code className="min-w-0 truncate font-mono">{a.line}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!(result.passed && o.command) && (
        <CodeResult outcome={o} reference={result.reference} answer={result.reference.answer} />
      )}
    </div>
  );
}

/**
 * The test block: "Testar resposta de referência", the status (needed / changed since) and the result. When C++
 * cannot run, the notice and "Salvar sem testar" (`onSaveUntested`).
 */
export function ReferenceTest({
  gate,
  onSaveUntested,
  compact,
}: {
  gate: ReferenceGate;
  /** Saves right away without the test (only offered when C++ cannot run). */
  onSaveUntested?: () => void;
  /** The book panel's narrow form: no frame, short button label. */
  compact?: boolean;
}) {
  if (!gate.required) return null;
  const r = gate.result;
  return (
    <div
      className={cn('@container flex min-w-0 flex-col gap-2', !compact && 'rounded-box border border-line p-3')}
      data-testid="reference-test"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" icon={FlaskConical} loading={gate.running} onClick={() => void gate.run()}>
          {compact ? t('codeAuthoring.testShort') : t('codeAuthoring.test')}
        </Button>
        {gate.running ? (
          <span className="text-xs text-muted" role="status">
            {t('codeAuthoring.testing')}
          </span>
        ) : (
          !r && (
            <span className="min-w-0 text-xs text-muted" role="status">
              {gate.stale ? t('codeAuthoring.testStale') : t('codeAuthoring.testNeeded')}
            </span>
          )
        )}
      </div>
      {r && !gate.running && <ReferenceResultView result={r} />}
      {r?.kind === 'unavailable' && !gate.running && (
        <Notice tone="info">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="min-w-0 flex-1">{t('codeAuthoring.cppUnavailable', { aviso: r.notice })}</span>
            {onSaveUntested && (
              <Button size="sm" variant="ghost" onClick={onSaveUntested}>
                {t('codeAuthoring.saveUntested')}
              </Button>
            )}
          </div>
        </Notice>
      )}
    </div>
  );
}
