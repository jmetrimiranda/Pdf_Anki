import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Tabs } from '../../components/ui';
import { t } from '../../i18n';

export type AnkiSection = 'decks' | 'add' | 'browse' | 'stats';

const SECTION_PATHS: Record<AnkiSection, '/anki' | '/anki/adicionar' | '/anki/navegar' | '/anki/estatisticas'> = {
  decks: '/anki',
  add: '/anki/adicionar',
  browse: '/anki/navegar',
  stats: '/anki/estatisticas',
};

/** Which sub-tab a path belongs to; null for screens without a tab (study, Anki pages). */
export function ankiSectionOf(pathname: string): AnkiSection | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/anki') return 'decks';
  if (p === '/anki/adicionar') return 'add';
  if (p === '/anki/navegar') return 'browse';
  if (p === '/anki/estatisticas') return 'stats';
  return null;
}

/**
 * The Anki tab (spec 8.2): sub-tabs Decks | Adicionar | Navegar | Estatísticas over the routed screen. Studying
 * and Anki's own pages (options, card info…) have no tab: study shows a way back to the decks, the pages a
 * "Fechar" button; the Markdown import of code cards, the same way back as study.
 */
export function AnkiPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const section = ankiSectionOf(pathname);
  // Screens without a sub-tab that lead back to the deck list.
  const backToDecks = pathname.startsWith('/anki/estudar') || pathname.startsWith('/anki/importar-codigo');

  return (
    <div className="flex h-full flex-col">
      {section && (
        <div className="mx-auto w-full max-w-[760px] shrink-0 px-4 pt-3 sm:px-6">
          <Tabs
            idBase="anki"
            label={t('anki.sections')}
            value={section}
            onValueChange={(v) => {
              if (v === 'decks') void navigate({ to: '/anki' });
              else if (v === 'add') void navigate({ to: SECTION_PATHS.add, search: {} });
              else if (v === 'browse') void navigate({ to: SECTION_PATHS.browse, search: {} });
              else void navigate({ to: SECTION_PATHS.stats });
            }}
            className="justify-center"
            items={[
              { value: 'decks', label: t('anki.section.decks') },
              { value: 'add', label: t('anki.section.add') },
              { value: 'browse', label: t('anki.section.browse') },
              { value: 'stats', label: t('anki.section.stats') },
            ]}
          />
        </div>
      )}
      {backToDecks && (
        <div className="shrink-0 px-3 pt-2 sm:px-4">
          <Link
            to="/anki"
            className="inline-flex h-8 items-center gap-1.5 rounded-ctl px-2 text-base text-muted hover:bg-hover hover:text-fg coarse:min-h-11"
          >
            <ArrowLeft size={15} aria-hidden />
            {t('anki.backToDecks')}
          </Link>
        </div>
      )}
      <div
        className="min-h-0 flex-1"
        {...(section
          ? { role: 'tabpanel', id: `anki-panel-${section}`, 'aria-labelledby': `anki-tab-${section}` }
          : {})}
      >
        <Outlet />
      </div>
    </div>
  );
}
