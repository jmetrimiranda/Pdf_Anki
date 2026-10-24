// The AI queries shared by Configurações → IA and the AI buttons of the other screens.
import { core } from '../../lib/core/client';

export const aiQ = {
  settings: () => ({ queryKey: ['ai', 'settings'], queryFn: () => core.aiSettingsGet() }) as const,
  usage: () => ({ queryKey: ['ai', 'usage'], queryFn: () => core.aiUsage(), staleTime: 0 }) as const,
  prices: () => ({ queryKey: ['ai', 'prices'], queryFn: () => core.aiPricesGet() }) as const,
  queue: () => ({ queryKey: ['ai', 'queue'], queryFn: () => core.aiQueueGet(), staleTime: 0 }) as const,
};
