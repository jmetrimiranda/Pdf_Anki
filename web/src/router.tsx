import { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useCanGoBack,
  useNavigate,
  useRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { lazy, Suspense, type ReactNode } from 'react';
import { AnkiPage } from './features/anki/AnkiPage';
import { DecksPage } from './features/anki/decks/DecksPage';
import { AnkiWebPage } from './features/anki/pages/AnkiWebPage';
import { ankiPageRoute, ankiPageTitle } from './features/anki/pages/routes';
import { LibraryPage } from './features/library/LibraryPage';
import { AppShell } from './features/shell/AppShell';
import { devRoutesEnabled } from './features/shell/devRoutes';
import { NotFound } from './features/shell/NotFound';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/biblioteca' });
  },
});

const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: '/biblioteca', component: LibraryPage });

// The reader itself is <LeitorHost/>, kept mounted by AppShell; this route only selects the tab.
const leitorRoute = createRoute({ getParentRoute: () => rootRoute, path: '/leitor', component: () => null });

// ---------------------------------------------------------------- Anki tab (spec 8.2, 8.3)

/** A positive integer from a search/path param (`?deck=123` arrives as a number or a string), else undefined. */
export function parseId(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim()) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** A trimmed non-empty string param (numbers become strings: `?nome=2024`), else undefined. */
export function parseText(v: unknown): string | undefined {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

const parseFlag = (v: unknown): boolean | undefined => (v === true || v === 1 || v === '1' ? true : undefined);

const StudyPage = lazy(() => import('./features/anki/study/StudyPage').then((m) => ({ default: m.StudyPage })));
const BrowsePage = lazy(() => import('./features/anki/browse/BrowsePage').then((m) => ({ default: m.BrowsePage })));
const AddPage = lazy(() => import('./features/anki/editor/AddPage').then((m) => ({ default: m.AddPage })));

function Lazy({ children }: { children: ReactNode }): ReactNode {
  return <Suspense fallback={null}>{children}</Suspense>;
}

/** Closing an Anki page goes back where the user came from (Navegar, Decks…), or to the deck list. */
function useCloseAnkiPage(): () => void {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  return () => {
    if (canGoBack) router.history.back();
    else void navigate({ to: '/anki' });
  };
}

const ankiRoute = createRoute({ getParentRoute: () => rootRoute, path: '/anki', component: AnkiPage });

const ankiDecksRoute = createRoute({ getParentRoute: () => ankiRoute, path: '/', component: DecksPage });

const ankiStudyRoute = createRoute({
  getParentRoute: () => ankiRoute,
  path: 'estudar',
  validateSearch: (s: Record<string, unknown>): { deck?: number; nome?: string; resposta?: boolean } => ({
    deck: parseId(s.deck),
    nome: parseText(s.nome),
    resposta: parseFlag(s.resposta),
  }),
  component: StudyRoute,
});

function StudyRoute(): ReactNode {
  const { deck, nome, resposta } = ankiStudyRoute.useSearch();
  return (
    <Lazy>
      <StudyPage deckId={deck} deckName={nome} showAnswer={resposta} />
    </Lazy>
  );
}

const ankiBrowseRoute = createRoute({
  getParentRoute: () => ankiRoute,
  path: 'navegar',
  validateSearch: (s: Record<string, unknown>): { busca?: string } => ({ busca: parseText(s.busca) }),
  component: BrowseRoute,
});

function BrowseRoute(): ReactNode {
  const { busca } = ankiBrowseRoute.useSearch();
  return (
    <Lazy>
      {/* Remounts when a new search arrives (graphs page, links), so it becomes the initial query. */}
      <BrowsePage key={busca ?? ''} initialQuery={busca} />
    </Lazy>
  );
}

const ankiAddRoute = createRoute({
  getParentRoute: () => ankiRoute,
  path: 'adicionar',
  validateSearch: (s: Record<string, unknown>): { deck?: number; tipo?: number } => ({
    deck: parseId(s.deck),
    tipo: parseId(s.tipo),
  }),
  component: AddRoute,
});

function AddRoute(): ReactNode {
  const { deck, tipo } = ankiAddRoute.useSearch();
  return (
    <Lazy>
      <AddPage deckId={deck} notetypeId={tipo} />
    </Lazy>
  );
}

function WebPageRoute({ route }: { route: string }): ReactNode {
  const close = useCloseAnkiPage();
  return <AnkiWebPage key={route} route={route} title={ankiPageTitle(route)} onClose={close} />;
}

const ankiStatsRoute = createRoute({
  getParentRoute: () => ankiRoute,
  path: 'estatisticas',
  component: StatsRoute,
});

function StatsRoute(): ReactNode {
  const navigate = useNavigate();
  return <AnkiWebPage route="graphs" title={ankiPageTitle('graphs')} onClose={() => void navigate({ to: '/anki' })} />;
}

const ankiOptionsRoute = createRoute({
  getParentRoute: () => ankiRoute,
  path: 'opcoes/$deckId',
  component: OptionsRoute,
});

function OptionsRoute(): ReactNode {
  const { deckId } = ankiOptionsRoute.useParams();
  const id = parseId(deckId);
  return id ? <WebPageRoute route={`deck-options/${id}`} /> : <NotFound />;
}

const ankiInfoRoute = createRoute({ getParentRoute: () => ankiRoute, path: 'info/$cardId', component: InfoRoute });

function InfoRoute(): ReactNode {
  const { cardId } = ankiInfoRoute.useParams();
  const id = parseId(cardId);
  return id ? <WebPageRoute route={`card-info/${id}`} /> : <NotFound />;
}

const ankiGenericPageRoute = createRoute({
  getParentRoute: () => ankiRoute,
  path: 'pagina/$',
  component: GenericPageRoute,
});

function GenericPageRoute(): ReactNode {
  const { _splat } = ankiGenericPageRoute.useParams();
  const route = ankiPageRoute(_splat ?? '');
  return route ? <WebPageRoute route={route} /> : <NotFound />;
}

// ---------------------------------------------------------------- Configurações (spec 5.2)

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/configuracoes',
  component: lazyRouteComponent(() => import('./features/settings/SettingsPage'), 'SettingsPage'),
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/configuracoes/anki' });
  },
});

const settingsAnkiRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'anki',
  component: lazyRouteComponent(() => import('./features/settings/AnkiSyncSettings'), 'AnkiSyncSettings'),
});

const settingsAiRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'ia',
  component: lazyRouteComponent(() => import('./features/settings/AiSettings'), 'AiSettings'),
});

const devUiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev/ui',
  component: lazyRouteComponent(() => import('./features/dev/DevUiPage'), 'DevUiPage'),
});
const devSmokeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev/smoke',
  component: lazyRouteComponent(() => import('./features/dev/SmokePage'), 'SmokePage'),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  leitorRoute,
  ankiRoute.addChildren([
    ankiDecksRoute,
    ankiStudyRoute,
    ankiBrowseRoute,
    ankiAddRoute,
    ankiStatsRoute,
    ankiOptionsRoute,
    ankiInfoRoute,
    ankiGenericPageRoute,
  ]),
  settingsRoute.addChildren([settingsIndexRoute, settingsAnkiRoute, settingsAiRoute]),
  ...(devRoutesEnabled ? [devUiRoute, devSmokeRoute] : []),
]);

/** The app router; tests pass a memory history to get an isolated instance. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: false,
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
