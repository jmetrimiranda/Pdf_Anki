import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import type { LeitorSelection } from '../leitor/controller';
import type { BookPanelInfo } from '../../lib/core/types';
import { BookPanelContent, PAGE_DEBOUNCE_MS } from './BookPanelContent';
import { formatCoverage } from './VocabSection';
import { createFakeLeitor, renderWithProviders } from './testing';

const fake = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof createFakeLeitor> }));
vi.mock('../leitor/instance', async () => {
  const { createFakeLeitor: create } = await import('./testing');
  fake.current = create();
  return fake.current.module;
});

const review = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('./review/MiniReview', () => ({
  MiniReview: (p: { initialDeckId: number; decks: unknown[]; onClose: () => void }) => {
    review.props = p as unknown as Record<string, unknown>;
    return (
      <div data-testid="mini-review" data-deck={p.initialDeckId}>
        <button type="button" onClick={p.onClose}>
          fechar
        </button>
      </div>
    );
  },
}));

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => router.navigate,
}));

vi.mock('../anki/editor/NoteEditorDialog', () => ({
  NoteEditorDialog: (p: { noteId: number | null; open: boolean }) =>
    p.open ? <div role="dialog" aria-label="editor" data-note={p.noteId} /> : null,
}));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  review.props = null;
  router.navigate.mockClear();
});
afterEach(() => vi.restoreAllMocks());

const farmUid = () => mockHandle.books.find((b) => b.title === 'Animal Farm')!.bookUid;
const deckId = async (name: string) => (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;

function renderContent(
  opts: { page?: number; selection?: LeitorSelection | null; uid?: string; unit?: 'page' | 'chapter' } = {},
) {
  const uid = opts.uid ?? farmUid();
  const onCardDone = vi.fn();
  const utils = renderWithProviders(
    <BookPanelContent
      bookUid={uid}
      title="Animal Farm"
      unit={opts.unit ?? 'page'}
      page={opts.page ?? 0}
      selection={opts.selection ?? null}
      cardRequest={null}
      onCardDone={onCardDone}
    />,
  );
  return { uid, onCardDone, ...utils };
}

describe('BookPanelContent', () => {
  it('shows the book decks with their counts in the status colors', async () => {
    renderContent();
    const vocab = await screen.findByTestId('book-deck-vocab');
    // No vocabulary folder yet: the top-level `Livros::<Título>` deck.
    expect(within(vocab).getByText('Livros::Animal Farm')).toBeTruthy();
    const counts = within(vocab).getByLabelText('2 novos, 0 aprendendo, 0 para revisar');
    const [n, l, r] = counts.querySelectorAll('span.tabular');
    expect(n!.className).toContain('text-anki-new');
    expect(l!.className).toContain('opacity-60');
    expect(r!.className).toContain('opacity-60');
    expect(within(vocab).getByRole('button', { name: 'Revisar aqui: Livros::Animal Farm' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(within(screen.getByTestId('book-deck-content')).getByText('Escolher deck de conteúdo…')).toBeTruthy();
  });

  it('says when the vocabulary deck does not exist', async () => {
    const real = await mockClient.bookPanelInfo(farmUid());
    vi.spyOn(mockClient, 'bookPanelInfo').mockResolvedValue({
      ...real,
      vocabDeck: { ...real.vocabDeck, deckId: null, exists: false, counts: null },
    });
    renderContent();
    const vocab = await screen.findByTestId('book-deck-vocab');
    expect(within(vocab).getByText('ainda não existe')).toBeTruthy();
    expect(within(vocab).queryByRole('button', { name: /Revisar aqui/ })).toBeNull();
  });

  it('disables "Card da seleção" without a selection and previews the selection otherwise', async () => {
    const { unmount } = renderContent();
    const button = await screen.findByRole('button', { name: /Card da seleção/ });
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByTestId('book-panel-selection').textContent).toBe('Selecione um trecho no livro');
    unmount();

    const text = `The windmill ${'was rebuilt again '.repeat(8)}`;
    renderContent({ selection: { id: farmUid(), page: 0, text, rects: [] } });
    const enabled = await screen.findByRole('button', { name: /Card da seleção/ });
    expect(enabled).toHaveProperty('disabled', false);
    const preview = screen.getByTestId('book-panel-selection').textContent!;
    expect(preview.startsWith('Seleção: “The windmill was rebuilt')).toBe(true);
    expect(preview.endsWith('…”')).toBe(true);
    fireEvent.click(enabled);
    expect(fake.current.leitor.requestCardFromSelection).toHaveBeenCalledWith('button');
  });

  it('chooses the content deck with the deck picker', async () => {
    const { uid } = renderContent();
    fireEvent.click(await screen.findByRole('button', { name: 'Escolher deck de conteúdo…' }));
    const select = await screen.findByRole('combobox', { name: 'Deck de conteúdo' });
    await waitFor(() => expect(select).toHaveProperty('disabled', false));
    const math = await deckId('Matemática');
    fireEvent.change(select, { target: { value: String(math) } });
    await waitFor(() =>
      expect(mockHandle.anki.logs.filter((l) => l.kind === 'bookPanelSet').at(-1)).toMatchObject({
        uid,
        patch: { contentDeckId: math },
      }),
    );
    const content = await screen.findByTestId('book-deck-content');
    await within(content).findByText('Matemática');
    expect(within(content).getByRole('button', { name: 'Trocar o deck de conteúdo' })).toBeTruthy();
  });

  it('lists the cards of the current page only, and opens them in the book', async () => {
    const { uid } = renderContent({ page: 0 });
    const section = await screen.findByRole('region', { name: 'Cards desta página (p. 1)' });
    const list = await within(section).findByTestId('book-page-cards');
    expect(within(list).getByText('Where does the story of Animal Farm begin?')).toBeTruthy();
    expect(within(list).queryByText('What did the animals build on the knoll?')).toBeNull();
    expect(within(list).getByText('Básico (Leitor) · Livros::Animal Farm')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: /Mostrar o trecho no livro/ }));
    expect(fake.current.leitor.openBook).toHaveBeenCalledWith(uid, { page: 0, find: 'Manor Farm' });
    fireEvent.click(within(list).getByRole('button', { name: /Editar a nota/ }));
    expect(screen.getByRole('dialog', { name: 'editor' })).toBeTruthy();
  });

  it('EPUB: lists the cards of the chapter in front and opens them at their CFI', async () => {
    const uid = mockHandle.books.find((b) => b.format === 'epub')!.bookUid;
    const basic = (await mockClient.ankiNotetypes()).find((n) => n.appType === 'Básico (Leitor)')!;
    const cfi = 'epubcfi(/6/8!/4/2/1:0)';
    const fonte = `<a href="leitor://livro/${uid}?cap=3&amp;cfi=${encodeURIComponent(cfi)}&amp;q=Filby">The Time Machine, Chapter II</a>`;
    await mockClient.ankiNoteAdd({
      notetypeId: basic.id,
      deckId: await deckId('Livros::Animal Farm'),
      fields: ['Who is Filby?', 'An argumentative person', fonte],
      tags: [],
    });
    renderContent({ uid, unit: 'chapter', page: 2 });
    const section = await screen.findByRole('region', { name: 'Cards deste capítulo (cap. 3)' });
    const list = await within(section).findByTestId('book-page-cards');
    fireEvent.click(within(list).getByRole('button', { name: /Mostrar o trecho no livro: Who is Filby/ }));
    expect(fake.current.leitor.openBook).toHaveBeenCalledWith(uid, { page: 2, find: 'Filby', cfi });
  });

  it('EPUB: an empty chapter', async () => {
    const uid = mockHandle.books.find((b) => b.format === 'epub')!.bookUid;
    renderContent({ uid, unit: 'chapter', page: 0 });
    const section = await screen.findByRole('region', { name: 'Cards deste capítulo (cap. 1)' });
    await within(section).findByText('Nenhum card deste capítulo ainda.');
  });

  it('shows the empty state of a page without cards', async () => {
    renderContent({ page: 4 });
    const section = await screen.findByRole('region', { name: 'Cards desta página (p. 5)' });
    await within(section).findByText('Nenhum card desta página ainda.');
  });

  it('"Revisar aqui" replaces the content with the mini-review and remembers the deck', async () => {
    const { uid } = renderContent();
    const farm = await deckId('Livros::Animal Farm');
    fireEvent.click(await screen.findByRole('button', { name: 'Revisar aqui: Livros::Animal Farm' }));
    const mini = await screen.findByTestId('mini-review');
    expect(mini.dataset.deck).toBe(String(farm));
    expect(review.props?.decks).toEqual([{ deckId: farm, name: 'Livros::Animal Farm', role: 'vocab' }]);
    await waitFor(() =>
      expect(mockHandle.anki.logs.filter((l) => l.kind === 'bookPanelSet').at(-1)).toMatchObject({
        uid,
        patch: { reviewDeckId: farm },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'fechar' }));
    await screen.findByTestId('book-deck-vocab');
  });

  it('a card request during the review ends it and shows the form', async () => {
    const uid = farmUid();
    const props = { bookUid: uid, title: 'Animal Farm', page: 0, selection: null, onCardDone: vi.fn() };
    const { rerender } = renderWithProviders(<BookPanelContent {...props} cardRequest={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revisar aqui: Livros::Animal Farm' }));
    await screen.findByTestId('mini-review');
    rerender(<BookPanelContent {...props} cardRequest={{ page: 0, text: 'Manor Farm', rects: [] }} />);
    await screen.findByRole('form', { name: 'Novo card' });
    expect(screen.queryByTestId('mini-review')).toBeNull();
  });

  describe('vocabulary (spec 10.1, 12.7)', () => {
    async function withInfo(patch: (real: BookPanelInfo) => Partial<BookPanelInfo>) {
      const real = await mockClient.bookPanelInfo(farmUid());
      return vi.spyOn(mockClient, 'bookPanelInfo').mockImplementation(async (_uid, page) => ({
        ...real,
        ...patch(real),
        // Echo the page asked for in the chapter deck's name, to see which page the panel asked for.
        ...(patch(real).chapterDeck ? { chapterDeck: { ...patch(real).chapterDeck!, name: `X::Cap ${page}` } } : {}),
      }));
    }

    it('formats the coverage as a whole pt-BR percent, never rounding up', () => {
      expect(formatCoverage(0.941)).toBe('94%');
      expect(formatCoverage(0.9999)).toBe('99%');
      expect(formatCoverage(1)).toBe('100%');
      expect(formatCoverage(Number.NaN)).toBe('0%');
    });

    it('offers the scan when the book was never scanned, with the highlight disabled', async () => {
      await withInfo(() => ({ vocab: null, chapterDeck: null }));
      const { uid } = renderContent();
      const section = await screen.findByTestId('book-panel-vocab');
      fireEvent.click(within(section).getByRole('button', { name: 'Escanear vocabulário' }));
      expect(router.navigate).toHaveBeenCalledWith({ to: '/vocabulario/escanear', search: { livro: uid } });
      const toggle = within(section).getByRole('switch');
      expect(toggle).toHaveProperty('disabled', true);
      expect(within(section).getByText('Escaneie o vocabulário do livro para poder realçar as palavras.')).toBeTruthy();
      expect(within(section).queryByText(/Vocabulário \d/)).toBeNull();
    });

    it('links "Vocabulário 94% →" to the report, with the scanned range, and turns the highlight on', async () => {
      await withInfo(() => ({
        vocab: { scanUid: 's1', coverageKnown: 0.941, coverageWithLearning: 0.953, rangeLabel: 'Cap 3', scannedAt: 0 },
        chapterDeck: null,
      }));
      const { uid } = renderContent();
      const link = await screen.findByRole('button', { name: 'Abrir o relatório de vocabulário (cobertura 94%)' });
      expect(link.textContent).toBe('Vocabulário 94% →');
      expect(screen.getByText('Trecho: Cap 3')).toBeTruthy();
      fireEvent.click(link);
      expect(router.navigate).toHaveBeenCalledWith({ to: '/vocabulario', search: { livro: uid } });
      const toggle = screen.getByRole('switch', { name: 'Realçar vocabulário' });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      fireEvent.click(toggle);
      expect(fake.current.leitor.setHighlight).toHaveBeenCalledWith(uid, true);
      await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
      fireEvent.click(toggle);
      expect(fake.current.leitor.setHighlight).toHaveBeenLastCalledWith(uid, false);
    });

    it('shows the current chapter subdeck with its counts and "Revisar aqui", following the page', async () => {
      const spy = await withInfo((real) => ({
        vocab: { scanUid: 's1', coverageKnown: 0.9, coverageWithLearning: 0.95, rangeLabel: null, scannedAt: 0 },
        chapterDeck: {
          role: 'vocab',
          deckId: real.vocabDeck.deckId! + 1000,
          name: 'X',
          exists: true,
          counts: { new: 3, learn: 1, review: 0 },
        },
      }));
      const uid = farmUid();
      const props = { bookUid: uid, title: 'Animal Farm', selection: null, cardRequest: null, onCardDone: vi.fn() };
      const { rerender } = renderWithProviders(<BookPanelContent {...props} page={12} />);
      const row = await screen.findByTestId('book-deck-chapter');
      expect(within(row).getByText('Capítulo atual')).toBeTruthy();
      expect(within(row).getByText('X::Cap 12')).toBeTruthy();
      expect(within(row).getByLabelText('3 novos, 1 aprendendo, 0 para revisar')).toBeTruthy();
      expect(spy).toHaveBeenCalledWith(uid, 12);
      expect(screen.queryByText(/Vocabulário 90%/)).toBeTruthy();

      // A new page: the rest stays on screen and the chapter is asked again once the page rests.
      rerender(<BookPanelContent {...props} page={18} />);
      expect(screen.getByTestId('book-deck-chapter')).toBeTruthy();
      await waitFor(() => expect(spy).toHaveBeenCalledWith(uid, 18), { timeout: PAGE_DEBOUNCE_MS + 1000 });
      await screen.findByText('X::Cap 18');

      fireEvent.click(within(screen.getByTestId('book-deck-chapter')).getByRole('button', { name: /Revisar aqui/ }));
      const mini = await screen.findByTestId('mini-review');
      expect(review.props?.decks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'X::Cap 18' })]));
      expect(mini).toBeTruthy();
    });
  });
});
