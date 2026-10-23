import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { createFakeLeitor, renderWithProviders } from '../book-panel/testing';
import { BookPanel } from './BookPanel';

const fake = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof createFakeLeitor> }));
vi.mock('./instance', async () => {
  const { createFakeLeitor: create } = await import('../book-panel/testing');
  fake.current = create();
  return fake.current.module;
});

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: { pathname: '/leitor', search: {} as Record<string, unknown> },
}));
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => router.navigate,
  useRouterState: ({ select }: { select: (s: { location: typeof router.location }) => unknown }) =>
    select({ location: router.location }),
}));

vi.mock('../book-panel/review/MiniReview', () => ({
  MiniReview: (p: { initialDeckId: number }) => <div data-testid="mini-review" data-deck={p.initialDeckId} />,
}));

beforeAll(() => installDomStubs());
beforeEach(async () => {
  mockHandle.reset();
  await mockClient.ankiPrepareCollection();
  router.navigate.mockClear();
  router.location = { pathname: '/leitor', search: {} };
  fake.current.set({ activeBookUid: null, page: 0, selection: null });
});
afterEach(() => vi.restoreAllMocks());

const farmUid = () => mockHandle.books.find((b) => b.title === 'Animal Farm')!.bookUid;

function renderPanel(props: { open?: boolean; overlay?: boolean; title?: string | null } = {}) {
  const onToggle = vi.fn();
  const utils = renderWithProviders(
    <BookPanel
      open={props.open ?? true}
      overlay={props.overlay ?? false}
      theme="light"
      bookTitle={props.title === undefined ? 'Animal Farm' : props.title}
      onToggle={onToggle}
    />,
  );
  return { onToggle, ...utils };
}

function withBook(page = 36) {
  const uid = farmUid();
  fake.current.set({ activeBookUid: uid, page });
  return uid;
}

describe('BookPanel', () => {
  it('takes its full width beside PdfCraft in a wide window', () => {
    renderPanel({ title: null });
    const panel = screen.getByTestId('book-panel');
    expect(panel.style.width).toBe('320px');
    expect(panel.dataset.overlay).toBe('false');
    expect(screen.getByText('Abra um livro pela Biblioteca.')).toBeTruthy();
  });

  it('floats over PdfCraft in a compact window, keeping only the rail in the flow', () => {
    const { container, onToggle } = renderPanel({ overlay: true, title: null });
    const panel = screen.getByTestId('book-panel');
    expect(panel.dataset.overlay).toBe('true');
    expect(panel.className).toContain('absolute');
    expect(panel.style.width).toContain('min(320px');
    const spacer = container.firstElementChild as HTMLElement;
    expect(spacer.style.width).toBe('40px');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('follows PdfCraft’s theme with the app tokens inside the panel', () => {
    renderPanel({ title: null });
    const panel = screen.getByTestId('book-panel');
    expect(panel.dataset.theme).toBe('light');
    expect(panel.style.getPropertyValue('--border')).toBe('var(--pc-border)');
    expect(panel.style.getPropertyValue('--pc-panel')).toBe('#ffffff');
  });

  it('shows the book content when a library book is in front', async () => {
    withBook(0);
    renderPanel();
    await screen.findByTestId('book-deck-vocab');
    expect(screen.getByRole('region', { name: 'Cards desta página (p. 1)' })).toBeTruthy();
  });

  it('opens the card form for a "card" request with the request’s selection', async () => {
    const uid = withBook();
    renderPanel();
    await screen.findByTestId('book-deck-vocab');
    act(() =>
      fake.current.emit({
        kind: 'card',
        via: 'menu',
        selection: { id: uid, page: 36, text: 'the windmill', rects: [[1, 2, 3, 4]] },
        anchor: null,
      }),
    );
    const form = await screen.findByRole('form', { name: 'Novo card' });
    expect(((await within(form).findByRole('textbox', { name: 'Frente' })) as HTMLTextAreaElement).value).toBe(
      'the windmill',
    );
    expect(within(form).getByTestId('card-form-fonte').textContent).toBe('Animal Farm, p. 37');
    // Esc in the form cancels it (and only it).
    fireEvent.keyDown(within(form).getByRole('textbox', { name: 'Verso' }), { key: 'Escape' });
    await screen.findByTestId('book-deck-vocab');
  });

  it('the panel button goes through the request (the same path as the menu and the shortcut)', async () => {
    const uid = withBook();
    fake.current.set({ selection: { id: uid, page: 36, text: 'Four legs good', rects: [] } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Card da seleção/ }));
    await screen.findByRole('form', { name: 'Novo card' });
  });

  it('asks for a selection when a card is requested without one', async () => {
    withBook();
    renderPanel();
    await screen.findByTestId('book-deck-vocab');
    act(() => fake.current.emit({ kind: 'card', via: 'shortcut', selection: null, anchor: null }));
    await screen.findByText('Selecione um trecho no livro primeiro.');
    expect(screen.queryByRole('form', { name: 'Novo card' })).toBeNull();
  });

  it('"Criar cards com IA" explains that AI is not configured and links to the settings', async () => {
    const uid = withBook();
    renderPanel({ open: false });
    act(() =>
      fake.current.emit({
        kind: 'ai',
        via: 'menu',
        selection: { id: uid, page: 3, text: 'Some text', rects: [] },
        anchor: null,
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Criar cards com IA' });
    expect(within(dialog).getByText(/A IA ainda não está configurada/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abrir Configurações → IA' }));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/configuracoes/ia' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Criar cards com IA' })).toBeNull());
  });

  it('"Definir palavra" shows the lemma and says when no vocabulary folder is chosen', async () => {
    const uid = withBook();
    renderPanel();
    act(() =>
      fake.current.emit({
        kind: 'define',
        via: 'menu',
        selection: { id: uid, page: 0, text: 'animals,', rects: [] },
        anchor: { x: 200, y: 300, width: 120, height: 24 },
      }),
    );
    const pop = await screen.findByTestId('define-popover');
    expect(within(pop).getByText('animals')).toBeTruthy();
    await within(pop).findByText('Lema: animal');
    expect(within(pop).getByText('Nenhuma nota com esta palavra no deck de vocabulário do livro.')).toBeTruthy();
    expect(within(pop).getByText(/Definições do WordNet chegam/)).toBeTruthy();
    const anchor = screen.getByTestId('define-anchor');
    expect(anchor.style.left).toBe('200px');
    expect(anchor.style.top).toBe('300px');
  });

  it('"Definir palavra" shows the vocabulary note with its definition, or says there is none', async () => {
    const uid = withBook();
    const root = (await mockClient.ankiDeckNames()).find((d) => d.name === '5000 palavras')!.id;
    mockHandle.setVocabRoot(root);
    renderPanel();
    // The seed's Vocabulário · Livro note "windmill" lives in "5000 palavras".
    act(() =>
      fake.current.emit({
        kind: 'define',
        via: 'menu',
        selection: { id: uid, page: 0, text: 'Windmills', rects: [] },
        anchor: null,
      }),
    );
    const pop = await screen.findByTestId('define-popover');
    await within(pop).findByText('A building with sails that turn in the wind.');
    expect(within(pop).getByText('Lema: windmill')).toBeTruthy();
    expect(within(pop).getByText('5000 palavras')).toBeTruthy();
    const note = (await mockClient.vocabDefine('windmill', null)).note!;
    fireEvent.click(within(pop).getByRole('button', { name: 'Abrir no Anki' }));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/anki/navegar', search: { busca: `nid:${note.noteId}` } });
    await waitFor(() => expect(screen.queryByTestId('define-popover')).toBeNull());

    act(() =>
      fake.current.emit({
        kind: 'define',
        via: 'menu',
        selection: { id: uid, page: 0, text: 'pigs', rects: [] },
        anchor: null,
      }),
    );
    await screen.findByText('Nenhuma nota com esta palavra na pasta de vocabulário.');
  });

  it('"Definir palavra" works for a document outside the library (no book uid)', async () => {
    fake.current.set({ activeBookUid: null, page: 0 });
    renderPanel({ title: null });
    act(() =>
      fake.current.emit({
        kind: 'define',
        via: 'menu',
        selection: { id: null, page: 0, text: 'animals', rects: [] },
        anchor: null,
      }),
    );
    const pop = await screen.findByTestId('define-popover');
    await within(pop).findByText('Lema: animal');
    expect(within(pop).getByText('Nenhuma nota com esta palavra no deck de vocabulário do livro.')).toBeTruthy();
  });

  it('"Definir palavra" asks for a single word', async () => {
    const uid = withBook();
    renderPanel();
    act(() =>
      fake.current.emit({
        kind: 'define',
        via: 'menu',
        selection: { id: uid, page: 0, text: 'two words', rects: [] },
        anchor: null,
      }),
    );
    await screen.findByText('Selecione uma só palavra.');
  });

  it('opens the form from the capture parameters (?painel=card&trecho=…)', async () => {
    withBook(9);
    router.location = { pathname: '/leitor', search: { painel: 'card', trecho: 'All animals are equal' } };
    renderPanel();
    const form = await screen.findByRole('form', { name: 'Novo card' });
    expect(((await within(form).findByRole('textbox', { name: 'Frente' })) as HTMLTextAreaElement).value).toBe(
      'All animals are equal',
    );
    expect(within(form).getByTestId('card-form-fonte').textContent).toBe('Animal Farm, p. 10');
  });

  it('opens the mini-review from ?painel=revisar', async () => {
    withBook();
    router.location = { pathname: '/leitor', search: { painel: 'revisar' } };
    renderPanel();
    await screen.findByTestId('mini-review');
  });
});
