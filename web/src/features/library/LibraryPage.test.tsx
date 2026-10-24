import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderLibrary } from './testing';

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

const titles = () => screen.queryAllByTestId('book-title').map((el) => el.textContent);

describe('LibraryPage', () => {
  it('lists the books, most recent first, with progress and the scanned badge', async () => {
    await renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(4));
    expect(titles()).toEqual(['ROS 2 na prática', 'The Time Machine', 'Animal Farm', 'Apostila digitalizada']);
    expect(screen.getByText('4 livros')).toBeTruthy();
    expect(screen.getByText('p. 5 de 12')).toBeTruthy();
    expect(screen.getByText('Parece escaneado')).toBeTruthy();
    // The EPUB carries its format badge.
    expect(screen.getAllByTestId('format-badge').map((el) => el.textContent)).toEqual(['EPUB']);
    expect(screen.getAllByRole('img', { name: /^Capa de / })).toHaveLength(4);
  });

  it('searches without accents and filters by collection', async () => {
    const user = userEvent.setup();
    await renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(4));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar por título ou autor' }), 'pratica');
    expect(titles()).toEqual(['ROS 2 na prática']);
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('Nenhum livro encontrado.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(titles()).toHaveLength(4);

    const chips = screen.getByRole('group', { name: 'Coleções' });
    await user.click(within(chips).getByRole('button', { name: 'Inglês' }));
    expect(titles()).toEqual(['The Time Machine', 'Animal Farm']);
    await user.click(within(chips).getByRole('button', { name: 'Todas' }));
    expect(titles()).toHaveLength(4);
  });

  it('persists the grid/list choice', async () => {
    const user = userEvent.setup();
    await renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(4));
    await user.click(screen.getByRole('radio', { name: 'Lista' }));
    expect(localStorage.getItem('leitor.library.view')).toBe('list');
    expect(screen.getByRole('radio', { name: 'Lista' }).getAttribute('aria-checked')).toBe('true');
  });

  it('opens a book in the Leitor when the card is clicked', async () => {
    const user = userEvent.setup();
    await renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(4));
    await user.click(screen.getByText('ROS 2 na prática'));
    const ros = mockHandle.books.find((b) => b.title === 'ROS 2 na prática')!;
    expect(leitorMock.openBook).toHaveBeenCalledWith(ros.bookUid);
  });

  it('renames, moves to a collection and removes through the book menu', async () => {
    const user = userEvent.setup();
    await renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(4));

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
    await renderLibrary();
    await waitFor(() => expect(titles()).toHaveLength(4));
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
    const { api } = await renderLibrary({ shell: { dragging: true } });
    expect(await screen.findByText('Nenhum livro na biblioteca ainda.')).toBeTruthy();
    expect(screen.getByTestId('drop-overlay')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Adicionar livro' });
    await user.click(buttons[buttons.length - 1]!);
    expect(api.addBooks).toHaveBeenCalled();
  });
});
