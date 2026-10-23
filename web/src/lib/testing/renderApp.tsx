// Renders the whole app (router + providers) on a memory history, for component tests that need the shell.
// Test files still mock '../leitor' themselves (vi.mock is per file).
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { createAppRouter, queryClient } from '../../router';

export async function renderApp(at = '/biblioteca'): Promise<ReturnType<typeof createAppRouter>> {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [at] }));
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: 'Abas' });
  return router;
}
