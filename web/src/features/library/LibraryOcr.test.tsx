import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import type { LibraryEntry } from '../../lib/core/client';
import { mockHandle } from '../../lib/core/mock';
import { mockOcrHandle } from '../../lib/core/mock/ocr';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { OcrDialog, ocrStore } from '../ocr';
import { BookItem } from './BookItem';
import { renderLibrary } from './testing';

const leitorFake = vi.hoisted(() => ({
  flushSaves: vi.fn(async () => true),
  reloadPdfcraftBook: vi.fn(async () => {}),
  refreshVocab: vi.fn(),
  openBook: vi.fn(async () => true),
  togglePanel: vi.fn(),
}));
vi.mock('../leitor', () => ({
  leitor: leitorFake,
  LeitorHost: () => null,
  useLeitorState: () => ({ ready: false, activeBookUid: null, openIds: [], panelOpen: true, theme: 'light' }),
}));
vi.mock('../leitor/instance', () => ({ leitor: leitorFake, leitorController: () => leitorFake }));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  localStorage.clear();
  queryClient.clear();
  vi.clearAllMocks();
});
afterEach(() => ocrStore.reset());

function entry(extra: Partial<LibraryEntry>): LibraryEntry {
  return {
    bookUid: 'f'.repeat(64),
    title: 'Livro',
    author: null,
    language: 'en',
    format: 'pdf',
    fileName: 'Livro.pdf',
    pages: 10,
    hasText: true,
    ocrStatus: 'none',
    fileHash: 'h',
    fileVersion: 1,
    contentDeckId: null,
    collectionFolder: null,
    addedAt: 0,
    updatedAt: 0,
    // On this device (a book from another PC would offer "Baixar" instead of its progress).
    localPath: 'books/f/v1-h.pdf',
    localHash: 'h',
    downloaded: true,
    position: null,
    vocabScanned: false,
    ...extra,
  };
}

function renderItem(book: LibraryEntry, view: 'grid' | 'list' = 'grid') {
  const onAction = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ToastProvider>
          <ul>
            <BookItem book={book} view={view} onAction={onAction} />
          </ul>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return onAction;
}

async function menuItems(user: ReturnType<typeof userEvent.setup>, title: string): Promise<string[]> {
  await user.click(screen.getByRole('button', { name: `Ações do livro ${title}` }));
  const menu = await screen.findByRole('menu');
  return within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.textContent ?? '');
}

describe('BookItem formats and OCR offer', () => {
  it('an EPUB shows the format badge and its reading fraction, and no OCR', async () => {
    const user = userEvent.setup();
    renderItem(
      entry({
        title: 'Ebook',
        format: 'epub',
        fileName: 'Ebook.epub',
        position: { page: 3, offset: 0, cfi: 'epubcfi(/6/8!/4/2)', progress: 0.42, updatedAt: 1 },
      }),
    );
    expect(screen.getByTestId('format-badge').textContent).toBe('EPUB');
    expect(screen.getByText('42% lido')).toBeTruthy();
    expect(screen.queryByText('Parece escaneado')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconhecer texto' })).toBeNull();
    expect(await menuItems(user, 'Ebook')).not.toContain('Reconhecer texto');
  });

  it('a scanned PDF shows the quiet badge, the inline action and the menu entry', async () => {
    const user = userEvent.setup();
    const onAction = renderItem(entry({ title: 'Scan', hasText: false }), 'list');
    expect(screen.getByText('Parece escaneado')).toBeTruthy();
    expect(screen.queryByTestId('format-badge')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reconhecer texto' }));
    expect(onAction).toHaveBeenLastCalledWith('ocr');
    const items = await menuItems(user, 'Scan');
    expect(items).toContain('Reconhecer texto');
    // No vocabulary scan without text.
    expect(items).not.toContain('Escanear vocabulário');
  });

  it('a PDF whose last OCR failed offers it again; a PDF with text does not', async () => {
    const user = userEvent.setup();
    renderItem(entry({ title: 'Falhou', hasText: true, ocrStatus: 'failed' }));
    expect(screen.queryByText('Parece escaneado')).toBeNull();
    expect(await menuItems(user, 'Falhou')).toContain('Reconhecer texto');
  });

  it('a PDF with text has no OCR entry', async () => {
    const user = userEvent.setup();
    renderItem(entry({ title: 'Texto', hasText: true, ocrStatus: 'done' }));
    expect(screen.queryByRole('button', { name: 'Reconhecer texto' })).toBeNull();
    expect(await menuItems(user, 'Texto')).not.toContain('Reconhecer texto');
  });
});

const scannedItem = () =>
  screen.getAllByTestId('book').find((el) => el.textContent?.includes('Apostila digitalizada'))!;

describe('Biblioteca → Reconhecer texto (spec 6.6, 7.2)', () => {
  it('the dialog explains English-only OCR, estimates the time and the new version', async () => {
    const user = userEvent.setup();
    localStorage.setItem('leitor.ocr.msPerPage', '30000');
    await renderLibrary({ client: queryClient });
    await screen.findByText('Apostila digitalizada');
    await user.click(within(scannedItem()).getByRole('button', { name: 'Reconhecer texto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer texto' });
    expect(dialog.textContent).toContain(
      'O reconhecimento de texto (OCR) lê livros escaneados em inglês. Ele reconhece o alfabeto latino sem acentos: livros em português não ficam corretos.',
    );
    // 8 pages × 30 s (the measured speed) = 4 min.
    expect(within(dialog).getByTestId('ocr-estimate').textContent).toContain(
      'Leva alguns segundos por página — cerca de 4 min para este livro.',
    );
    expect(dialog.textContent).toContain('nova versão do PDF');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('runs in the background with progress, then the badge goes and the version bumps', async () => {
    const user = userEvent.setup();
    mockOcrHandle.setPageDelay(100);
    await renderLibrary({ client: queryClient });
    await screen.findByText('Apostila digitalizada');
    const before = mockHandle.books.find((b) => b.title === 'Apostila digitalizada')!;
    await user.click(within(scannedItem()).getByRole('button', { name: 'Reconhecer texto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer texto' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reconhecer texto' })).toHaveProperty('disabled', false),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reconhecer texto' }));
    expect(leitorFake.flushSaves).toHaveBeenCalled();
    await waitFor(() => expect(within(scannedItem()).getByText(/^Reconhecendo texto… página \d de 8$/)).toBeTruthy());
    expect(
      await screen.findByText(
        'Texto reconhecido: agora dá para buscar, selecionar e escanear o vocabulário deste livro.',
        {},
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    await waitFor(() => expect(within(scannedItem()).queryByText('Parece escaneado')).toBeNull());
    const after = mockHandle.books.find((b) => b.title === 'Apostila digitalizada')!;
    expect(after.fileVersion).toBe(before.fileVersion + 1);
    expect(leitorFake.reloadPdfcraftBook).toHaveBeenCalledWith(before.bookUid);
  });

  it('cancelling mid-way goes back to the offer', async () => {
    const user = userEvent.setup();
    mockOcrHandle.setPageDelay(400);
    await renderLibrary({ client: queryClient });
    await screen.findByText('Apostila digitalizada');
    await user.click(within(scannedItem()).getByRole('button', { name: 'Reconhecer texto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer texto' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reconhecer texto' })).toHaveProperty('disabled', false),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reconhecer texto' }));
    const cancel = await within(scannedItem()).findByRole('button', {
      name: 'Cancelar o reconhecimento de texto de Apostila digitalizada',
    });
    await user.click(cancel);
    expect(
      await screen.findByText('Reconhecimento de texto cancelado. Nada mudou no livro.', {}, { timeout: 3000 }),
    ).toBeTruthy();
    await waitFor(() => expect(within(scannedItem()).getByRole('button', { name: 'Reconhecer texto' })).toBeTruthy());
    expect(within(scannedItem()).getByText('Parece escaneado')).toBeTruthy();
  });

  it('without the OCR models the action is disabled with the message', async () => {
    const user = userEvent.setup();
    mockOcrHandle.setModelsAvailable(false);
    await renderLibrary({ client: queryClient });
    await screen.findByText('Apostila digitalizada');
    await user.click(within(scannedItem()).getByRole('button', { name: 'Reconhecer texto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer texto' });
    expect(
      await within(dialog).findByText(
        'Os modelos de reconhecimento de texto (OCR) não estão instalados. Reinstale o app.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Reconhecer texto' })).toHaveProperty('disabled', true);
  });

  it('/biblioteca?ocr=<uid> opens the dialog for that book', async () => {
    const uid = mockHandle.books.find((b) => b.title === 'Apostila digitalizada')!.bookUid;
    const router = await renderApp(`/biblioteca?ocr=${uid}`);
    expect(await screen.findByRole('dialog', { name: 'Reconhecer texto' })).toBeTruthy();
    // The parameter is consumed: a reload does not reopen the dialog.
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('/biblioteca?ocr=<uid> of a book with text or an EPUB only clears the URL', async () => {
    for (const pick of [
      (b: (typeof mockHandle.books)[number]) => b.format === 'pdf' && b.hasText,
      (b: (typeof mockHandle.books)[number]) => b.format === 'epub',
    ]) {
      const book = mockHandle.books.find(pick)!;
      const router = await renderApp(`/biblioteca?ocr=${book.bookUid}`);
      await waitFor(() => expect(router.state.location.search).toEqual({}));
      expect(await screen.findAllByTestId('book')).not.toHaveLength(0);
      expect(screen.queryByRole('dialog', { name: 'Reconhecer texto' })).toBeNull();
      cleanup();
    }
  });
});

describe('OcrDialog', () => {
  it('says OCR is for PDFs (not "models missing") for an EPUB', async () => {
    const epub = mockHandle.books.find((b) => b.format === 'epub')!;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <OcrDialog book={epub} onClose={() => {}} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer texto' });
    expect(within(dialog).getByText('O reconhecimento de texto só funciona em PDFs escaneados.')).toBeTruthy();
    await waitFor(() => expect(within(dialog).queryByText(/não estão instalados/)).toBeNull());
    expect(within(dialog).getByRole('button', { name: 'Reconhecer texto' })).toHaveProperty('disabled', true);
  });
});
