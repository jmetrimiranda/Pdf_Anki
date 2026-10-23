import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { ShellContext, type ShellApi } from '../shell/context';
import { LibraryPage } from './LibraryPage';

const leitorMock = vi.hoisted(() => ({
  openBook: vi.fn(async (_uid: string) => true),
  togglePanel: vi.fn(),
  flushSaves: vi.fn(async () => true),
}));
vi.mock('../leitor', () => ({ leitor: leitorMock, LeitorHost: () => null }));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  localStorage.clear();
  leitorMock.openBook.mockClear();
});

function renderLibrary(shell: Partial<ShellApi> = {}) {
  const api: ShellApi = {
    addBooks: vi.fn(),
    importPaths: vi.fn(async () => {}),
    showShortcuts: vi.fn(),
    dragging: false,
    ...shell,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <ShellContext.Provider value={api}>
            <LibraryPage />
          </ShellContext.Provider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return api;
}

const titles = () => screen.queryAllByTestId('book-title').map((el) => el.textContent);

describe('LibraryPage', () => {
  it('lists the books, most recent first, with progress and the scanned badge', async () => {
    renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(3));
    expect(titles()).toEqual(['ROS 2 na prática', 'Animal Farm', 'Apostila digitalizada']);
    expect(screen.getByText('3 livros')).toBeTruthy();
    expect(screen.getByText('p. 5 de 12')).toBeTruthy();
    expect(screen.getByText('Parece escaneado')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /^Capa de / })).toHaveLength(3);
  });

  it('searches without accents and filters by collection', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(3));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar por título ou autor' }), 'pratica');
    expect(titles()).toEqual(['ROS 2 na prática']);
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('Nenhum livro encontrado.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(titles()).toHaveLength(3);

    const chips = screen.getByRole('group', { name: 'Coleções' });
    await user.click(within(chips).getByRole('button', { name: 'Inglês' }));
    expect(titles()).toEqual(['Animal Farm']);
    await user.click(within(chips).getByRole('button', { name: 'Todas' }));
    expect(titles()).toHaveLength(3);
  });

  it('persists the grid/list choice', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(3));
    await user.click(screen.getByRole('radio', { name: 'Lista' }));
    expect(localStorage.getItem('leitor.library.view')).toBe('list');
    expect(screen.getByRole('radio', { name: 'Lista' }).getAttribute('aria-checked')).toBe('true');
  });

  it('opens a book in the Leitor when the card is clicked', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(3));
    await user.click(screen.getByText('ROS 2 na prática'));
    const ros = mockHandle.books.find((b) => b.title === 'ROS 2 na prática')!;
    expect(leitorMock.openBook).toHaveBeenCalledWith(ros.bookUid);
  });

  it('renames, moves to a collection and removes through the book menu', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(3));

    await user.click(screen.getByRole('button', { name: 'Ações do livro ROS 2 na prática' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Renomear' }));
    const rename = await screen.findByRole('dialog', { name: 'Renomear livro' });
    const field = within(rename).getByLabelText('Título');
    await user.clear(field);
    await user.type(field, 'ROS 2 avançado');
    await user.click(within(rename).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(titles()).toContain('ROS 2 avançado'));

    await user.click(screen.getByRole('button', { name: 'Ações do livro ROS 2 avançado' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mover para coleção…' }));
    const move = await screen.findByRole('dialog', { name: 'Mover para coleção' });
    await user.click(within(move).getByRole('button', { name: 'Inglês' }));
    await user.click(within(move).getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(mockHandle.books.find((b) => b.title === 'ROS 2 avançado')?.collectionFolder).toBe('Inglês'),
    );

    await user.click(screen.getByRole('button', { name: 'Ações do livro Animal Farm' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remover da biblioteca' }));
    const remove = await screen.findByRole('dialog', { name: 'Remover “Animal Farm” da biblioteca?' });
    await user.click(within(remove).getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(titles()).not.toContain('Animal Farm'));
    expect(await screen.findByText('“Animal Farm” foi removido da biblioteca.')).toBeTruthy();
  });

  it('exports a copy and opens it in the system viewer', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Ações do livro Animal Farm' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Exportar cópia' }));
    expect(await screen.findByText('Cópia exportada.')).toBeTruthy();
    expect(mockHandle.files).toEqual(['/home/jorge/Exportados/Animal Farm.pdf']);

    await user.click(screen.getByRole('button', { name: 'Ações do livro Animal Farm' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Abrir no visualizador do sistema' }));
    await waitFor(() => expect(mockHandle.openedExternally).toHaveLength(1));
  });

  it('shows the empty state with the add action and the drop overlay', async () => {
    for (const b of mockHandle.books) await (await import('../../lib/core/mock')).mockClient.libraryRemove(b.bookUid);
    const user = userEvent.setup();
    const api = renderLibrary({ dragging: true });
    expect(await screen.findByText('Nenhum livro na biblioteca ainda.')).toBeTruthy();
    expect(screen.getByTestId('drop-overlay')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Adicionar livro' });
    await user.click(buttons[buttons.length - 1]!);
    expect(api.addBooks).toHaveBeenCalled();
  });
});
