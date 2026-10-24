// What every AI button shares (plan 3.6, 6.4): a call above the confirmation threshold comes back as
// `ai_needs_confirmation`; the user sees the worst case and sends again with `confirmed`. Errors that need a setting
// (AI off, no key) offer the way to Configurações → IA.
import { useNavigate } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Notice } from '../../components/ui';
import { t } from '../../i18n';
import { CoreError } from '../../lib/core/types';

/** Codes the user fixes in Configurações → IA. */
const SETTINGS_CODES = new Set([
  'ai_disabled',
  'ai_no_key',
  'ai_auth',
  'ai_model_unpriced',
  'ai_model_not_found',
  'ai_limit_reached',
  'ai_provider_unavailable',
]);

export function useAiCall(): {
  /** Runs `fn(false)`; on `ai_needs_confirmation` asks and runs `fn(true)`. `null` when the user declined. */
  run: <T>(fn: (confirmed: boolean) => Promise<T>) => Promise<T | null>;
  /** Render it once in the component. */
  dialog: ReactNode;
} {
  const [ask, setAsk] = useState<string | null>(null);
  const answer = useRef<((ok: boolean) => void) | null>(null);

  async function run<T>(fn: (confirmed: boolean) => Promise<T>): Promise<T | null> {
    try {
      return await fn(false);
    } catch (e) {
      if (!(e instanceof CoreError) || e.code !== 'ai_needs_confirmation') throw e;
      const ok = await new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setAsk(e.message);
      });
      setAsk(null);
      answer.current = null;
      return ok ? fn(true) : null;
    }
  }

  const reply = (ok: boolean) => answer.current?.(ok);
  const dialog = ask ? (
    <Dialog
      open
      onOpenChange={(open) => !open && reply(false)}
      title={t('ai.confirm.title')}
      description={ask}
      footer={
        <>
          <Button variant="ghost" onClick={() => reply(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => reply(true)} data-testid="ai-confirm-send">
            {t('ai.confirm.send')}
          </Button>
        </>
      }
    />
  ) : null;
  return { run, dialog };
}

/** An AI error, with "Abrir Configurações → IA" when a setting fixes it. */
export function AiErrorNotice({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const navigate = useNavigate();
  const code = error instanceof CoreError ? error.code : '';
  const message = error instanceof Error ? error.message : t('errors.unexpected');
  return (
    <Notice tone="error" onDismiss={onDismiss}>
      <span className="flex flex-col items-start gap-1" data-testid="ai-error" data-code={code}>
        <span>{message}</span>
        {SETTINGS_CODES.has(code) && (
          <Button
            variant="ghost"
            size="sm"
            icon={Settings}
            className="-ml-2.5"
            onClick={() => void navigate({ to: '/configuracoes/ia' })}
          >
            {t('ai.openSettings')}
          </Button>
        )}
      </span>
    </Notice>
  );
}
