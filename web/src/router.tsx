import { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AnkiPage } from './features/anki/AnkiPage';
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

const ankiRoute = createRoute({ getParentRoute: () => rootRoute, path: '/anki', component: AnkiPage });

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
  ankiRoute,
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
