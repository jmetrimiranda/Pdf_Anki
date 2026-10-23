import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { makePdf } from '../../lib/pdf/minimalPdf';
import { installDomStubs } from '../../lib/testing/dom';
import { createAppRouter, queryClient } from '../../router';

const leitorMock = vi.hoisted(() => ({
  openBook: vi.fn(async (_uid: string, _opts?: unknown) => true),
  togglePanel: vi.fn(),
  flushSaves: vi.fn(async () => true),
  requestCardFromSelection: vi.fn(),
  onPanelRequest: vi.fn(() => () => {}),
  setReviewing: vi.fn(),
}));
vi.mock('../leitor', () => ({
  leitor: leitorMock,
  LeitorHost: () => <div data-testid="leitor-host" />,
  useLeitorState: () => ({ ready: false, activeBookUid: null, openIds: [], panelOpen: true, theme: 'light' }),
}));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  queryClient.clear();
  leitorMock.openBook.mockClear();
  leitorMock.togglePanel.mockClear();
  leitorMock.requestCardFromSelection.mockClear();
});

let router: ReturnType<typeof createAppRouter>;
const path = () => router.state.location.pathname;

async function renderApp(at = '/biblioteca') {
  router = createAppRouter(createMemoryHistory({ initialEntries: [at] }));
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: 'Abas' });
}

describe('AppShell', () => {
  it('shows the three app tabs and keeps the reader host mounted across tabs', async () => {
    await renderApp();
    const nav = screen.getByRole('navigation', { name: 'Abas' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Biblioteca', 'Leitor', 'Anki']);
    const host = screen.getByTestId('leitor-host');
    await act(() => router.navigate({ to: '/anki' }));
    expect(screen.getByTestId('leitor-host')).toBe(host);
    expect(screen.getByRole('link', { name: 'Anki' }).getAttribute('aria-current')).toBe('page');
  });

  it('routes Ctrl+1/2/3 and Alt+1/2/3, and leaves Ctrl+digits to a focused PdfCraft iframe', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true });
    await waitFor(() => expect(path()).toBe('/leitor'));
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', altKey: true });
    await waitFor(() => expect(path()).toBe('/anki'));
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
    await waitFor(() => expect(path()).toBe('/biblioteca'));

    const frame = document.createElement('iframe');
    frame.title = 'PdfCraft';
    frame.tabIndex = 0;
    document.body.appendChild(frame);
    frame.focus();
    expect(document.activeElement).toBe(frame);
    const e = new KeyboardEvent('keydown', {
      key: '3',
      code: 'Digit3',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(path()).toBe('/biblioteca');
    // The reader forwards Alt+digits from inside the iframe as a synthetic keydown on this document.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true, bubbles: true }));
    await waitFor(() => expect(path()).toBe('/leitor'));
    frame.remove();
  });

  it('toggles the panel with Ctrl+Shift+P and lists shortcuts with ?', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
    expect(leitorMock.togglePanel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByRole('dialog', { name: 'Atalhos do teclado' });
    expect(dialog.textContent).toContain('Ir para o Leitor');
    expect(dialog.textContent).toContain('atalhos do próprio PdfCraft');
  });

  it('imports files opened with the app and opens the last one in the Leitor', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getAllByTestId('book-title')).toHaveLength(3));
    act(() => mockHandle.openPaths(['/home/jorge/Livros/Aberto pelo sistema.pdf']));
    await waitFor(() => expect(leitorMock.openBook).toHaveBeenCalledTimes(1));
    const added = mockHandle.books.find((b) => b.title === 'Aberto pelo sistema');
    expect(leitorMock.openBook).toHaveBeenCalledWith(added?.bookUid);
    expect(await screen.findByText('“Aberto pelo sistema” foi adicionado à biblioteca.')).toBeTruthy();
  });

  it('asks before an imported copy replaces the current version of a book', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getAllByTestId('book-title')).toHaveLength(3));
    const farm = mockHandle.books.find((b) => b.title === 'Animal Farm')!;
    const copy = makePdf({ pages: 3, title: 'Animal Farm', leitorBookUid: farm.bookUid, highlight: true });
    for (const name of ['Cópia antiga', 'Cópia nova']) {
      mockHandle.setNextExportPath(`/tmp/${name}.pdf`);
      await mockClient.pickExportPath(`${name}.pdf`);
      await mockClient.exportBytes(`/tmp/${name}.pdf`, copy.buffer as ArrayBuffer);
    }

    // "Manter a atual": nothing changes.
    act(() => mockHandle.openPaths(['/tmp/Cópia antiga.pdf']));
    const dialog = await screen.findByRole('dialog', { name: 'Substituir a versão atual de “Animal Farm”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Manter a atual' }));
    expect(await screen.findByText('“Animal Farm” continua com a versão atual.')).toBeTruthy();
    expect(mockHandle.books.find((b) => b.bookUid === farm.bookUid)?.fileVersion).toBe(1);

    // "Substituir": the copy becomes version 2 of the same book.
    act(() => mockHandle.openPaths(['/tmp/Cópia nova.pdf']));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: /Substituir a versão atual/ })).getByRole('button', {
        name: 'Substituir',
      }),
    );
    expect(await screen.findByText('Reconhecido como Animal Farm: anotações atualizadas')).toBeTruthy();
    expect(mockHandle.books.find((b) => b.bookUid === farm.bookUid)?.fileVersion).toBe(2);
    expect(mockHandle.books).toHaveLength(3);
  });

  it('imports the files the app was launched with', async () => {
    mockHandle.setPendingOpen(['/home/jorge/Livros/Na abertura.pdf']);
    await renderApp();
    await waitFor(() => expect(leitorMock.openBook).toHaveBeenCalledTimes(1));
    expect(mockHandle.books.some((b) => b.title === 'Na abertura')).toBe(true);
  });

  it('adds with Ctrl+O and reports a corrupted file without breaking', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getAllByTestId('book-title')).toHaveLength(3));
    mockHandle.setNextPick(['/tmp/livro corrompido.pdf', '/tmp/Bom.pdf']);
    fireEvent.keyDown(window, { key: 'o', code: 'KeyO', ctrlKey: true });
    expect(
      await screen.findByText(/^Não foi possível adicionar livro corrompido\.pdf: O arquivo não é um PDF válido/),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('book-title')).toHaveLength(4));
    expect(leitorMock.openBook).not.toHaveBeenCalled();
  });

  it('lists the study keys under "Anki · Estudar" in the shortcuts dialog', async () => {
    await renderApp();
    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByRole('dialog', { name: 'Atalhos do teclado' });
    const study = within(dialog).getByRole('list', { name: 'Anki · Estudar' });
    expect(study.textContent).toContain('Mostrar resposta');
    expect(study.textContent).toContain('Desfazer a última resposta');
    expect(study.textContent).toContain('Suspender o card');
  });

  it('a .apkg opened with the app asks, imports directly and shows the summary', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getAllByTestId('book-title')).toHaveLength(3));
    act(() => mockHandle.openPaths(['/home/jorge/Downloads/Fazenda.apkg']));
    const dialog = await screen.findByRole('dialog', { name: 'Importar “Fazenda.apkg” para a coleção?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Importar' }));
    expect(await screen.findByText('Pacote importado: 3 notas adicionadas, 0 atualizadas.')).toBeTruthy();
    await waitFor(() => expect(path()).toBe('/anki'));
    expect(
      mockHandle.anki.logs.some((l) => l.kind === 'import' && l.path === '/home/jorge/Downloads/Fazenda.apkg'),
    ).toBe(true);
    expect(leitorMock.openBook).not.toHaveBeenCalled();
  });

  it('cancelling the .apkg confirmation imports nothing', async () => {
    await renderApp();
    act(() => mockHandle.openPaths(['/tmp/Outro.apkg']));
    const dialog = await screen.findByRole('dialog', { name: /Importar “Outro.apkg”/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockHandle.anki.logs.some((l) => l.kind === 'import')).toBe(false);
  });

  it('a .colpkg opened with the app needs both confirmations and the checkbox', async () => {
    await renderApp();
    act(() => mockHandle.openPaths(['/home/jorge/colecao.colpkg']));
    const first = await screen.findByRole('dialog', { name: 'Substituir a coleção inteira?' });
    fireEvent.click(within(first).getByRole('button', { name: 'Continuar' }));
    const sure = await screen.findByRole('dialog', { name: 'Tem certeza?' });
    const replace = within(sure).getByRole('button', { name: 'Substituir coleção' }) as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    fireEvent.click(replace);
    expect(mockHandle.anki.dataset).toBe('seed');
    fireEvent.click(within(sure).getByRole('checkbox', { name: 'Entendo que a coleção atual será substituída' }));
    expect(replace.disabled).toBe(false);
    fireEvent.click(replace);
    expect(
      await screen.findByText(/^Coleção substituída\. Backup da anterior: backup-antes-de-importar-/),
    ).toBeTruthy();
    expect(mockHandle.anki.dataset).toBe('colpkg');
    await waitFor(() => expect(path()).toBe('/anki'));
  });

  it('handles mixed lists in order: books, then a package', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getAllByTestId('book-title')).toHaveLength(3));
    act(() => mockHandle.openPaths(['/tmp/Livro misto.pdf', '/tmp/Misto.apkg']));
    await screen.findByRole('dialog', { name: /Importar “Misto.apkg”/ });
    // The PDF was imported before the package dialog appeared.
    expect(mockHandle.books.some((b) => b.title === 'Livro misto')).toBe(true);
  });

  it('refreshes the Anki tab when the core reports a change', async () => {
    await renderApp('/anki');
    await screen.findByRole('tree', { name: 'Decks' });
    const spy = vi.spyOn(mockClient, 'ankiDeckTree');
    act(() => mockHandle.anki.fireChanged('page'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  it('"Card da seleção": Ctrl+Shift+N outside PdfCraft, Alt+C from anywhere', async () => {
    await renderApp('/leitor');
    fireEvent.keyDown(window, { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true });
    expect(leitorMock.requestCardFromSelection).toHaveBeenCalledWith('shortcut');

    const frame = document.createElement('iframe');
    frame.title = 'PdfCraft';
    frame.tabIndex = 0;
    document.body.appendChild(frame);
    frame.focus();
    const e = new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, cancelable: true });
    window.dispatchEvent(e);
    // PdfCraft's "Go to page…": not taken, not prevented.
    expect(e.defaultPrevented).toBe(false);
    expect(leitorMock.requestCardFromSelection).toHaveBeenCalledTimes(1);
    // Alt+C forwarded from inside the iframe.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', altKey: true, bubbles: true }));
    expect(leitorMock.requestCardFromSelection).toHaveBeenCalledTimes(2);
    frame.remove();
  });

  it('lists "Card da seleção" as ready with the note about PdfCraft\'s Ctrl+Shift+N', async () => {
    await renderApp();
    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByRole('dialog', { name: 'Atalhos do teclado' });
    const row = within(dialog).getByText('Card da seleção').closest('li')!;
    expect(row.textContent).not.toContain('em breve');
    expect(row.textContent).toContain('Alt');
    expect(dialog.textContent).toContain('Ctrl+Shift+N é o “Ir para a página” do PdfCraft');
  });

  it('opens a leitor:// link given at launch at its page, finding the passage', async () => {
    const farm = mockHandle.books.find((b) => b.title === 'Animal Farm')!;
    mockHandle.setPendingDeepLinks([`leitor://livro/${farm.bookUid}?pagina=3&q=the%20windmill`]);
    await renderApp();
    await waitFor(() => expect(leitorMock.openBook).toHaveBeenCalledTimes(1));
    expect(leitorMock.openBook).toHaveBeenCalledWith(farm.bookUid, { page: 2, find: 'the windmill' });
  });

  it('opens a leitor:// link forwarded while running; an unknown book shows a notice', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getAllByTestId('book-title')).toHaveLength(3));
    const farm = mockHandle.books.find((b) => b.title === 'Animal Farm')!;
    act(() => mockHandle.deepLink(`leitor://livro/${farm.bookUid}?pagina=1`));
    await waitFor(() => expect(leitorMock.openBook).toHaveBeenCalledWith(farm.bookUid, { page: 0, find: null }));

    act(() => mockHandle.deepLink(`leitor://livro/${'f'.repeat(64)}?pagina=2&q=x`));
    expect(await screen.findByText('Este livro não está na Biblioteca deste computador.')).toBeTruthy();
    // Invalid links never reach the app.
    act(() => mockHandle.deepLink('leitor://evil/../x'));
    expect(leitorMock.openBook).toHaveBeenCalledTimes(1);
  });
});
