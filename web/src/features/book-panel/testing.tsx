// Test doubles for the book panel (Vitest only): a fake Leitor instance (snapshot store + panel requests) and a
// render helper with the providers the panel needs.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import type { LeitorSelection, LeitorSnapshot, PanelRequest } from '../leitor/controller';

type Snap = Pick<LeitorSnapshot, 'activeBookUid' | 'page' | 'visible' | 'panelOpen'> & {
  selection: LeitorSelection | null;
};

/** A stand-in for features/leitor/instance: `vi.mock('…/leitor/instance', () => fakeLeitorModule(fake))`. */
export function createFakeLeitor(initial: Partial<Snap> = {}) {
  let snap: Snap = { activeBookUid: null, page: 0, visible: true, panelOpen: true, selection: null, ...initial };
  const subs = new Set<() => void>();
  const panelListeners = new Set<(r: PanelRequest) => void>();
  const leitor = {
    openBook: vi.fn(async (_uid: string, _opts?: { page?: number; find?: string | null }) => true),
    togglePanel: vi.fn(),
    flushSaves: vi.fn(async () => true),
    setReviewing: vi.fn(),
    requestCardFromSelection: vi.fn((via: 'shortcut' | 'button' = 'shortcut') => {
      for (const fn of [...panelListeners]) fn({ kind: 'card', via, selection: snap.selection, anchor: null });
    }),
    onPanelRequest: vi.fn((cb: (r: PanelRequest) => void) => {
      panelListeners.add(cb);
      return () => void panelListeners.delete(cb);
    }),
  };
  const subscribe = (fn: () => void) => {
    subs.add(fn);
    return () => void subs.delete(fn);
  };
  const get = () => snap as unknown as LeitorSnapshot;
  return {
    leitor,
    set(patch: Partial<Snap>) {
      snap = { ...snap, ...patch };
      for (const fn of [...subs]) fn();
    },
    /** Delivers a panel request as the controller would (PdfCraft's menu, a shortcut). */
    emit(r: PanelRequest) {
      for (const fn of [...panelListeners]) fn(r);
    },
    module: {
      leitor,
      useLeitorState: () => useSyncExternalStore(subscribe, get, get),
      useLeitorSelector: <T,>(select: (s: LeitorSnapshot) => T) => {
        const s = useSyncExternalStore(subscribe, get, get);
        return select(s);
      },
      leitorController: () => ({}),
    },
  };
}

export function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}
