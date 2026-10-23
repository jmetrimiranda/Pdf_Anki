import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import type { LeitorSelection } from '../leitor/controller';
import { BookPanelContent } from './BookPanelContent';
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

vi.mock('../anki/editor/NoteEditorDialog', () => ({
  NoteEditorDialog: (p: { noteId: number | null; open: boolean }) =>
    p.open ? <div role="dialog" aria-label="editor" data-note={p.noteId} /> : null,
}));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  review.props = null;
});
afterEach(() => vi.restoreAllMocks());

const farmUid = () => mockHandle.books.find((b) => b.title === 'Animal Farm')!.bookUid;
const deckId = async (name: string) => (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;

function renderContent(opts: { page?: number; selection?: LeitorSelection | null } = {}) {
  const uid = farmUid();
  const onCardDone = vi.fn();
  const utils = renderWithProviders(
    <BookPanelContent
      bookUid={uid}
      title="Animal Farm"
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
    expect(screen.getByText('Ainda não escaneado.')).toBeTruthy();
    expect(screen.getByText('Ver relatório →').getAttribute('aria-disabled')).toBe('true');
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
});
