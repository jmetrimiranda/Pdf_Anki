import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { mockClient, mockHandle } from '../../../lib/core/mock';
import { installDomStubs } from '../../../lib/testing/dom';
import { BrowsePage } from './BrowsePage';

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

function renderBrowse(initialQuery?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <BrowsePage {...(initialQuery !== undefined && { initialQuery })} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const bodyRows = () => screen.getAllByRole('row').filter((r) => r.getAttribute('aria-rowindex') !== '1');
const selected = () => bodyRows().filter((r) => r.getAttribute('aria-selected') === 'true');

describe('BrowsePage', () => {
  it('searches the current deck by default and shows text cells', async () => {
    renderBrowse();
    await waitFor(() => expect(screen.getByTestId('browse-count').textContent).toBe('7 cards'));
    await screen.findByText('kitchen');
    // HTML of the fields never reaches the table as markup.
    expect(screen.getByTestId('browse-table').querySelector('img')).toBeNull();
    expect((screen.getByRole('textbox', { name: /Buscar cards/ }) as HTMLInputElement).value).toBe('deck:current');
  });

  it('click, Ctrl-click, Shift-click, Ctrl+A and arrows select rows', async () => {
    renderBrowse('deck:"5000 palavras"');
    await screen.findByText('kitchen');
    const rows = bodyRows();
    fireEvent.click(rows[1]!);
    expect(selected()).toHaveLength(1);
    fireEvent.click(rows[4]!, { shiftKey: true });
    expect(selected().map((r) => r.getAttribute('aria-rowindex'))).toEqual(['3', '4', '5', '6']);
    fireEvent.click(rows[6]!, { ctrlKey: true });
    expect(selected()).toHaveLength(5);
    expect(screen.getByText('5 selecionados')).toBeTruthy();
    const grid = screen.getByRole('grid', { name: 'Cards' });
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true });
    expect(selected()).toHaveLength(7);
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(selected()).toHaveLength(1);
    fireEvent.keyDown(grid, { key: 'ArrowUp', shiftKey: true });
    expect(selected()).toHaveLength(2);
  });

  it('loads rows lazily in pages of at most 100', async () => {
    const spy = vi.spyOn(mockClient, 'ankiBrowseRows');
    const words = (await mockClient.ankiDeckNames()).find((d) => d.name === 'Oxford::Oxford 5000')!.id;
    const nt = (await mockClient.ankiNotetypes()).find((n) => n.name === 'Básico')!.id;
    for (let i = 0; i < 230; i++)
      await mockClient.ankiNoteAdd({ notetypeId: nt, deckId: words, fields: [`w${i}`, 'x'], tags: [] });
    renderBrowse('deck:"Oxford::Oxford 5000"');
    await waitFor(() => expect(screen.getByTestId('browse-count').textContent).toBe('230 cards'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // Only the visible window is in the DOM.
    expect(bodyRows().length).toBeLessThan(60);
  });

  it('shows the search error and sorts by column', async () => {
    const user = userEvent.setup();
    renderBrowse('deck:"5000 palavras"');
    await screen.findByText('kitchen');
    const input = screen.getByRole('textbox', { name: /Buscar cards/ });
    await user.clear(input);
    await user.type(input, 'deck:"sem fim{Enter}');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Pesquisa inválida/);

    await user.clear(input);
    await user.type(input, 'deck:Oxford*{Enter}');
    await screen.findByText('abandon');
    const header = screen.getByRole('columnheader', { name: /Campo de ordenação/ });
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    await user.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    await waitFor(() => expect(bodyRows()[0]!.textContent).toContain('able'));
  });

  it('suspends the selection from the bulk toolbar', async () => {
    const user = userEvent.setup();
    renderBrowse('deck:Oxford*');
    await screen.findByText('abandon');
    fireEvent.click(bodyRows()[0]!);
    fireEvent.click(bodyRows()[1]!, { shiftKey: true });
    await user.click(screen.getByRole('button', { name: 'Suspender' }));
    await waitFor(() => expect(mockHandle.anki.logs.some((l) => l.kind === 'suspend')).toBe(true));
    await waitFor(() => expect(bodyRows()[0]!.getAttribute('data-suspended')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy();
  });
});
