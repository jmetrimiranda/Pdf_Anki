import { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { AnkiPage } from './features/anki/AnkiPage';
import { LibraryPage } from './features/library/LibraryPage';
import { DocPage } from './features/reader/DocPage';
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

const docRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/doc/$docId',
  component: function DocRoute() {
    const { docId } = docRoute.useParams();
    return <DocPage key={docId} docId={docId} />;
  },
});

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
  docRoute,
  ankiRoute,
  ...(devRoutesEnabled ? [devUiRoute, devSmokeRoute] : []),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: false,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
