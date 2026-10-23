import { Link, Outlet } from '@tanstack/react-router';
import { Badge } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';

/** The sections of "Configurações" (spec 5.2); "Anki e sincronização", "Código" and the "IA" placeholder exist for now. */
const SECTIONS: { key: MessageKey; to?: '/configuracoes/anki' | '/configuracoes/codigo' | '/configuracoes/ia' }[] = [
  { key: 'settings.section.general' },
  { key: 'settings.section.reading' },
  { key: 'settings.section.anki', to: '/configuracoes/anki' },
  { key: 'settings.section.vocab' },
  { key: 'settings.section.code', to: '/configuracoes/codigo' },
  { key: 'settings.section.ai', to: '/configuracoes/ia' },
  { key: 'settings.section.painel' },
];

const item =
  'flex h-8 shrink-0 items-center gap-2 rounded-ctl px-2.5 text-base whitespace-nowrap coarse:min-h-11 md:w-full';

/**
 * Configurações: the section list (a column on wide screens, a scrolling row above the content on narrow ones)
 * and the routed section.
 */
export function SettingsPage() {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-4 px-4 pt-4 pb-10 sm:px-6 md:flex-row md:gap-8">
        <nav aria-label={t('settings.sections')} className="min-w-0 shrink-0 md:w-64">
          <h1 className="mb-2 px-1 text-lg font-semibold">{t('settings.title')}</h1>
          <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:flex-col md:overflow-visible">
            {SECTIONS.map(({ key, to }) => (
              <li key={key} className="shrink-0">
                {to ? (
                  <Link
                    to={to}
                    className={cn(
                      item,
                      'text-fg hover:bg-hover aria-[current=page]:bg-lime-soft aria-[current=page]:font-semibold aria-[current=page]:text-lime-dark',
                    )}
                  >
                    {t(key)}
                  </Link>
                ) : (
                  <span aria-disabled="true" className={cn(item, 'cursor-default justify-between text-muted')}>
                    {t(key)}
                    <Badge>{t('common.soon')}</Badge>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
