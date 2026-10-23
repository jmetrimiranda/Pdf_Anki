import { Sparkles } from 'lucide-react';
import { Card } from '../../components/ui';
import { t } from '../../i18n';

/** Configurações → IA (spec 13): a placeholder until Phase 8 ("Criar cards com IA" links here). */
export function AiSettings() {
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">{t('settings.ai.title')}</h2>
      </header>
      <Card>
        <div className="flex items-start gap-3">
          <Sparkles size={18} aria-hidden className="mt-0.5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold">{t('settings.ai.provider')}</p>
            <p className="mt-1 text-base text-muted">{t('settings.ai.hint')}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
