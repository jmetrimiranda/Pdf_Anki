import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { mockClient, mockHandle } from '../../../lib/core/mock';
import { installDomStubs } from '../../../lib/testing/dom';
import { createAppRouter, queryClient } from '../../../router';
import { DeckTable } from '../DeckList';
import { apkgFileName } from './DecksPage';
import { deckNameError, subdeckName } from './DeckDialogs';

vi.mock('../../leitor', () => ({
  leitor: { openBook: vi.fn(async () => true), togglePanel: vi.fn(), flushSaves: vi.fn(async () => true) },
  LeitorHost: () => null,
  useLeitorState: () => ({ ready: false, activeBookUid: null, openIds: [], panelOpen: true, theme: 'light' }),
}));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  queryClient.clear();
});
afterEach(() => vi.restoreAllMocks());

let router: ReturnType<typeof createAppRouter>;

async function renderDecks() {
  router = createAppRouter(createMemoryHistory({ initialEntries: ['/anki'] }));
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return screen.findByRole('tree', { name: 'Decks' });
}

async function deckId(name: string): Promise<number> {
  const d = (await mockClient.ankiDeckNames()).find((x) => x.name === name);
  if (!d) throw new Error(`no deck ${name}`);
  return d.id;
}

/** Opens a deck's gear menu from the keyboard (Shift+F10 on its row) and picks an item. */
async function deckMenu(rowName: RegExp, item: string) {
  const tree = await screen.findByRole('tree', { name: 'Decks' });
  const row = within(tree).getAllByRole('treeitem', { name: rowName })[0]!;
  row.focus();
  fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
  const menu = await screen.findByRole('menu');
  fireEvent.click(within(menu).getByRole('menuitem', { name: item }));
}

describe('deck names', () => {
  it('validates parts and composes subdeck names', () => {
    expect(deckNameError('')).toBe('Dê um nome ao deck.');
    expect(deckNameError('A::')).toBe('Cada parte do nome entre :: precisa ter texto.');
    expect(deckNameError('A:: ::B')).not.toBeNull();
    expect(deckNameError('A::B')).toBeNull();
    expect(subdeckName('Oxford', ' Verbos :: Irregulares ')).toBe('Oxford::Verbos::Irregulares');
    expect(apkgFileName({ name: 'A/B: C' } as never)).toBe('A_B_ C.apkg');
  });
});

describe('DecksPage', () => {
  it('shows the deck tree, the current deck and the studied-today footer', async () => {
    const tree = await renderDecks();
    expect(within(tree).getByRole('treeitem', { name: /^5000 palavras, 0 novos, 17 aprendendo, 1002/ })).toBeTruthy();
    expect(screen.getByTestId('studied-today').textContent).toBe('Estudados hoje: 5 cards em 2,83 min (34 s/card)');
    expect(tree.querySelector('[data-current]')?.textContent).toContain('5000 palavras');
  });

  it('a click on a deck name studies it', async () => {
    const tree = await renderDecks();
    fireEvent.click(within(tree).getByRole('button', { name: 'Matemática' }));
    const id = await deckId('Matemática');
    await waitFor(() => expect(router.state.location.pathname).toBe('/anki/estudar'));
    expect(router.state.location.search).toEqual({ deck: id });
  });

  it('creates a subdeck under the deck', async () => {
    await renderDecks();
    const create = vi.spyOn(mockClient, 'ankiDeckCreate');
    await deckMenu(/^Oxford,/, 'Criar subdeck');
    const dialog = await screen.findByRole('dialog', { name: 'Criar subdeck em “Oxford”' });
    fireEvent.change(within(dialog).getByLabelText('Nome do deck'), { target: { value: ' Phrasal verbs ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Oxford::Phrasal verbs'));
    expect(await screen.findByText('Deck “Oxford::Phrasal verbs” criado.')).toBeTruthy();
  });

  it('rename validates every part before calling the core', async () => {
    await renderDecks();
    const rename = vi.spyOn(mockClient, 'ankiDeckRename');
    await deckMenu(/^Oxford,/, 'Renomear');
    const dialog = await screen.findByRole('dialog', { name: 'Renomear deck' });
    const input = within(dialog).getByLabelText('Nome do deck') as HTMLInputElement;
    expect(input.value).toBe('Oxford');
    fireEvent.change(input, { target: { value: 'Inglês::' } });
    expect(within(dialog).getByText('Cada parte do nome entre :: precisa ter texto.')).toBeTruthy();
    fireEvent.submit(input.closest('form')!);
    expect(rename).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Inglês::Oxford' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith(expect.any(Number), 'Inglês::Oxford'));
    expect(rename.mock.calls[0]![0]).toBe(await deckId('Inglês::Oxford'));
  });

  it('move offers neither the deck nor its subdecks, and "Nível superior"', async () => {
    await renderDecks();
    const move = vi.spyOn(mockClient, 'ankiDeckMove');
    await deckMenu(/^Oxford,/, 'Mover…');
    const dialog = await screen.findByRole('dialog', { name: 'Mover “Oxford”' });
    const select = within(dialog).getByLabelText('Colocar dentro de') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(5));
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels[0]).toBe('Nível superior');
    expect(labels).not.toContain('Oxford');
    expect(labels).not.toContain('Oxford::Oxford 3000');
    expect(labels).toContain('Grammar A1');
    const oxford = await deckId('Oxford');
    const grammar = await deckId('Grammar A1');
    fireEvent.change(select, { target: { value: String(grammar) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }));
    await waitFor(() => expect(move).toHaveBeenCalledWith([oxford], grammar));
    expect(await deckId('Grammar A1::Oxford::Oxford 3000')).toBeTruthy();
  });

  it('delete asks with the card count', async () => {
    await renderDecks();
    const del = vi.spyOn(mockClient, 'ankiDeckDelete');
    const id = await deckId('Matemática');
    await deckMenu(/^Matemática,/, 'Excluir');
    const dialog = await screen.findByRole('dialog', { name: 'Excluir “Matemática” e 2 cards?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(id));
    expect(await screen.findByText('“Matemática” foi excluído (2 cards).')).toBeTruthy();
  });

  it('export asks the options, then the .apkg path, then exports', async () => {
    await renderDecks();
    const pick = vi.spyOn(mockClient, 'pickExportPath');
    const exp = vi.spyOn(mockClient, 'ankiExport');
    await deckMenu(/^5000 palavras,/, 'Exportar .apkg…');
    const dialog = await screen.findByRole('dialog', { name: 'Exportar “5000 palavras”' });
    const scheduling = within(dialog).getByRole('checkbox', { name: 'Incluir agendamento' }) as HTMLInputElement;
    expect(scheduling.checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: 'Incluir mídia' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(scheduling);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Escolher onde salvar…' }));
    await waitFor(() => expect(exp).toHaveBeenCalled());
    expect(pick).toHaveBeenCalledWith('5000 palavras.apkg', 'apkg');
    expect(exp).toHaveBeenCalledWith(await deckId('5000 palavras'), '/home/jorge/Exportados/5000 palavras.apkg', {
      withScheduling: false,
      withMedia: true,
    });
    expect(await screen.findByText('Deck exportado: 7 notas.')).toBeTruthy();
  });

  it('cancelling the save dialog keeps the export dialog open', async () => {
    await renderDecks();
    const exp = vi.spyOn(mockClient, 'ankiExport');
    mockHandle.setNextExportPath(null);
    await deckMenu(/^5000 palavras,/, 'Exportar .apkg…');
    const dialog = await screen.findByRole('dialog', { name: 'Exportar “5000 palavras”' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Escolher onde salvar…' }));
    await waitFor(() => expect(mockHandle.files).toEqual([]));
    expect(exp).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Exportar “5000 palavras”' })).toBeTruthy();
  });

  it('options open the Anki page', async () => {
    await renderDecks();
    const id = await deckId('Oxford');
    await deckMenu(/^Oxford,/, 'Opções');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/anki/opcoes/${id}`));
    expect(await screen.findByTitle('Opções do deck')).toBeTruthy();
  });

  it('filtered decks have no options page', async () => {
    const onAction = vi.fn();
    const deck = {
      id: 9,
      name: 'Filtrado',
      fullName: 'Filtrado',
      level: 1,
      newCount: 0,
      learnCount: 0,
      reviewCount: 3,
      collapsed: false,
      filtered: true,
      total: 3,
      children: [],
    };
    render(<DeckTable decks={[deck]} onAction={onAction} />);
    const row = screen.getByRole('treeitem', { name: /^Filtrado,/ });
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Opções' }).getAttribute('data-disabled')).not.toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Estudar' }));
    expect(onAction).toHaveBeenCalledWith('study', deck);
  });

  it('collapsing a deck persists it in the collection', async () => {
    const tree = await renderDecks();
    const collapse = vi.spyOn(mockClient, 'ankiDeckSetCollapsed');
    const oxford = within(tree).getAllByRole('treeitem', { name: /^Oxford,/ })[0]!;
    expect(oxford.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(oxford).getByRole('button', { name: 'Recolher' }));
    await waitFor(() => expect(collapse).toHaveBeenCalledWith(expect.any(Number), true));
    expect(oxford.getAttribute('aria-expanded')).toBe('false');
  });

  it('"Preparar coleção" reports the created types', async () => {
    await renderDecks();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Mais ações' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Preparar coleção' }));
    expect(await screen.findByText(/^Tipos de nota criados: Cloze \(Leitor\)\.$/)).toBeTruthy();
  });

  it('the colpkg import from the menu needs both confirmations', async () => {
    await renderDecks();
    act(() => mockHandle.anki.setNextPackagePick('/home/jorge/Anki.colpkg'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Importar' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Coleção inteira (.colpkg)…' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Substituir a coleção inteira?' })).getByRole('button', {
        name: 'Continuar',
      }),
    );
    const sure = await screen.findByRole('dialog', { name: 'Tem certeza?' });
    fireEvent.click(within(sure).getByRole('checkbox'));
    fireEvent.click(within(sure).getByRole('button', { name: 'Substituir coleção' }));
    const tree = await screen.findByRole('tree', { name: 'Decks' });
    await waitFor(() =>
      expect(
        within(tree)
          .getAllByRole('treeitem')
          .map((r) => r.getAttribute('aria-label')?.split(',')[0]),
      ).toEqual(['5000 palavras', 'Oxford', 'Oxford 3000', 'Oxford 5000', 'ROS 2 — Revisão']),
    );
  });

  it('the .apkg import from the menu opens the Anki import page with the encoded path', async () => {
    await renderDecks();
    act(() => mockHandle.anki.setNextPackagePick('/home/jorge/Downloads/Vocab.apkg'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Importar' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pacote do Anki (.apkg)…' }));
    const frame = (await screen.findByTitle('Importar pacote do Anki')) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toContain(
      '/__mock-anki-page/import-anki-package/%2Fhome%2Fjorge%2FDownloads%2FVocab.apkg',
    );
  });
});
