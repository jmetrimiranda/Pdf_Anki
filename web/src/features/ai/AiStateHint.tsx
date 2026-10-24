// The state every AI button shows next to it (plan 6.4): off, no key, past 80% of a cap, cap reached.
import { useQuery } from '@tanstack/react-query';
import { t, type MessageKey } from '../../i18n';
import { aiQ } from './queries';

/** Why an AI function would not run (or is close to the caps); `null` when it is ready. */
export function useAiState(fn: 'enrich' | 'judge'): MessageKey | null {
  const settings = useQuery(aiQ.settings()).data;
  const usage = useQuery(aiQ.usage()).data;
  if (!settings) return null;
  const provider = settings[fn].provider;
  if (!provider) return 'ai.state.off';
  if (!settings.providers.find((p) => p.id === provider)?.hasKey) return 'ai.state.noKey';
  if (usage?.state === 'blocked') return 'ai.state.blocked';
  if (usage?.state === 'warning') return 'ai.state.warning';
  return null;
}

export function AiStateHint({ fn }: { fn: 'enrich' | 'judge' }) {
  const key = useAiState(fn);
  return key ? (
    <p className="text-2xs text-muted" data-testid="ai-state">
      {t(key)}
    </p>
  ) : null;
}
