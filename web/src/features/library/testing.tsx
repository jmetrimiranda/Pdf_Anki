// Test helper: the Biblioteca alone (no app shell) on a memory router, with a fake shell API.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { ShellContext, type ShellApi } from '../shell/context';
import { LibraryPage } from './LibraryPage';

export async function renderLibrary(opts: { shell?: Partial<ShellApi>; at?: string; client?: QueryClient } = {}) {
  const api: ShellApi = {
    addBooks: vi.fn(),
    importPaths: vi.fn(async () => {}),
    showShortcuts: vi.fn(),
    dragging: false,
    ...opts.shell,
  };
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: Outlet });
  const library = createRoute({ getParentRoute: () => root, path: '/biblioteca', component: LibraryPage });
  const other = createRoute({ getParentRoute: () => root, path: '$', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([library, other]),
    history: createMemoryHistory({ initialEntries: [opts.at ?? '/biblioteca'] }),
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <ShellContext.Provider value={api}>
            <RouterProvider router={router} />
          </ShellContext.Provider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Biblioteca' });
  return { api, router };
}
