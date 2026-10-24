import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { createFakeLeitor, renderWithProviders } from '../book-panel/testing';
import type { WordDefinition } from '../../lib/core/types';
import { clampAnchor } from '../book-panel/PanelDialogs';
import { BookPanel } from './BookPanel';
import type { MarkClick } from './controller';

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

  it('"Criar cards com IA" with AI off says so and links to the settings', async () => {
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
    expect((await within(dialog).findByTestId('ai-state')).textContent).toBe(
      'IA desligada: configure em Configurações → IA.',
    );
    fireEvent.click(within(dialog).getByTestId('ai-cards-propose'));
    expect((await within(dialog).findByTestId('ai-error')).getAttribute('data-code')).toBe('ai_disabled');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abrir Configurações → IA' }));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/configuracoes/ia' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Criar cards com IA' })).toBeNull());
  });

  it('"Criar cards com IA" proposes cards and adds the chosen ones with the Fonte of the selection', async () => {
    await mockClient.aiSettingsSet({ enrich: { provider: 'anthropic' }, consent: ['anthropic'] });
    await mockClient.aiKeySet('anthropic', 'test-key-TEST');
    const add = vi.spyOn(mockClient, 'ankiNoteAdd');
    const uid = withBook();
    renderPanel();
    act(() =>
      fake.current.emit({
        kind: 'ai',
        via: 'menu',
        selection: { id: uid, page: 3, text: 'Pigs are clever. Windmills grind grain.', rects: [] },
        anchor: null,
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Criar cards com IA' });
    expect(await within(dialog).findByTestId('ai-cards-estimate')).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId('ai-cards-propose'));
    const list = await within(dialog).findByTestId('ai-cards-list');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Adicionar a proposta 2' }));
    await waitFor(() => expect((within(dialog).getByTestId('ai-cards-add') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByTestId('ai-cards-add'));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    const note = add.mock.calls[0]![0];
    expect(note.tags).toEqual(['leitor', 'ia']);
    expect(note.fields.join(' ')).toContain('Pigs are clever.');
    expect(note.fields.join(' ')).toContain(`leitor://livro/${uid}?pagina=4`);
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
    expect(within(pop).getByRole('button', { name: 'Definir com IA' })).toBeTruthy();
    expect((await within(pop).findByTestId('ai-state')).textContent).toBe(
      'IA desligada: configure em Configurações → IA.',
    );
    const anchor = screen.getByTestId('define-anchor');
    expect(anchor.style.left).toBe('200px');
    expect(anchor.style.top).toBe('300px');
  });

  it('"Definir com IA" sends the word with the book page (the core finds the sentence) and shows the sense', async () => {
    await mockClient.aiSettingsSet({ enrich: { provider: 'anthropic' }, consent: ['anthropic'] });
    await mockClient.aiKeySet('anthropic', 'test-key-TEST');
    const aiDefine = vi.spyOn(mockClient, 'aiDefineWord');
    const uid = withBook();
    renderPanel();
    act(() =>
      fake.current.emit({
        kind: 'define',
        via: 'menu',
        selection: { id: uid, page: 2, text: 'animals,', rects: [] },
        anchor: { x: 200, y: 300, width: 120, height: 24 },
      }),
    );
    const pop = await screen.findByTestId('define-popover');
    await within(pop).findByText('Lema: animal');
    fireEvent.click(within(pop).getByRole('button', { name: 'Definir com IA' }));
    const sense = await within(pop).findByTestId('define-ai');
    expect(sense.textContent).toContain('Tradução: animal (pt)');
    expect(aiDefine).toHaveBeenCalledWith('animal', expect.anything(), '', false, { bookUid: uid, page: 2 });
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

  describe('popover over a highlighted word (spec 12.7)', () => {
    const definition = (over: Partial<WordDefinition> = {}): WordDefinition => ({
      word: 'learner',
      lemma: 'learner',
      pos: 'n',
      status: 'unknown',
      family: { lemma: 'learn', status: 'known' },
      wordnetDefinition: 'someone who is learning',
      definitionSource: 'wordnet',
      vocabRootDeckId: 1,
      vocabRootName: 'Vocabulário',
      note: null,
      ...over,
    });

    function clickMark(uid: string, status: 'unknown' | 'learning' = 'unknown') {
      const click: MarkClick = {
        id: uid,
        page: 3,
        index: 1,
        mark: { lemma: 'learner', form: 'Learners', status, rects: [[10, 20, 30, 12]] },
        anchor: { x: 300, y: 400, width: 40, height: 14 },
      };
      act(() => fake.current.emitMark(click));
      return click;
    }

    it('shows the lemma, the form, the status, the WordNet definition and the family', async () => {
      const uid = withBook();
      const define = vi.spyOn(mockClient, 'vocabDefine').mockResolvedValue(definition());
      renderPanel();
      clickMark(uid);
      const pop = await screen.findByTestId('vocab-popover');
      expect(screen.getByRole('dialog', { name: 'Palavra realçada' })).toBeTruthy();
      expect(within(pop).getByText('learner')).toBeTruthy();
      expect(within(pop).getByText('no texto: “Learners”')).toBeTruthy();
      expect(within(pop).getByText('desconhecida').className).toContain('--vocab-unknown');
      await within(pop).findByText('someone who is learning');
      expect(within(pop).getByText('WordNet')).toBeTruthy();
      expect(within(pop).getByTestId('vocab-family').textContent).toBe('Da família de: learn ✓');
      expect(within(pop).getByRole('button', { name: 'Definir com IA' })).toBeTruthy();
      expect(define).toHaveBeenCalledWith('learner', uid);
      const anchor = screen.getByTestId('vocab-anchor');
      expect([anchor.style.left, anchor.style.top, anchor.style.width]).toEqual(['300px', '400px', '40px']);
    });

    it('prefers the definition of the note in the deck, and shows "aprendendo" in amber', async () => {
      const uid = withBook();
      vi.spyOn(mockClient, 'vocabDefine').mockResolvedValue(
        definition({
          family: null,
          definitionSource: 'note',
          note: {
            noteId: 5,
            deckName: 'Vocabulário::Livros::Animal Farm',
            notetype: 'x',
            definition: 'aprendiz',
            preview: 'learner',
          },
        }),
      );
      renderPanel();
      clickMark(uid, 'learning');
      const pop = await screen.findByTestId('vocab-popover');
      await within(pop).findByText('aprendiz');
      expect(within(pop).getByText('Da sua nota em Vocabulário::Livros::Animal Farm')).toBeTruthy();
      expect(within(pop).getByText('aprendendo').className).toContain('--vocab-learning');
      expect(within(pop).queryByTestId('vocab-family')).toBeNull();
      // Already in a deck: nothing to add.
      expect(within(pop).queryByRole('button', { name: 'Adicionar ao deck do livro' })).toBeNull();
    });

    it('"Adicionar ao deck do livro" adds the word, says where, and refreshes the marks', async () => {
      const uid = withBook();
      vi.spyOn(mockClient, 'vocabDefine').mockResolvedValue(definition());
      const add = vi
        .spyOn(mockClient, 'vocabAddWord')
        .mockResolvedValue({ noteId: 9, deckId: 2, deckName: 'Vocabulário::Livros::Animal Farm' });
      renderPanel();
      clickMark(uid);
      const pop = await screen.findByTestId('vocab-popover');
      fireEvent.click(within(pop).getByRole('button', { name: 'Adicionar ao deck do livro' }));
      await screen.findByText('Adicionado a Vocabulário::Livros::Animal Farm');
      expect(add).toHaveBeenCalledWith(uid, 'learner', 3, 'Learners');
      expect(fake.current.leitor.refreshVocab).toHaveBeenCalledWith(uid);
      await waitFor(() => expect(screen.queryByTestId('vocab-popover')).toBeNull());
    });

    it('"Já sei" and "Nome próprio" set the adjustment of the lemma', async () => {
      const uid = withBook();
      vi.spyOn(mockClient, 'vocabDefine').mockResolvedValue(definition());
      const set = vi.spyOn(mockClient, 'vocabOverrideSet').mockResolvedValue();
      renderPanel();
      clickMark(uid);
      fireEvent.click(within(await screen.findByTestId('vocab-popover')).getByRole('button', { name: 'Já sei' }));
      await screen.findByText('“learner” marcada como conhecida.');
      expect(set).toHaveBeenLastCalledWith(['learner'], 'known');
      await waitFor(() => expect(screen.queryByTestId('vocab-popover')).toBeNull());

      clickMark(uid);
      fireEvent.click(within(await screen.findByTestId('vocab-popover')).getByRole('button', { name: 'Nome próprio' }));
      await screen.findByText('“learner” marcada como nome próprio.');
      expect(set).toHaveBeenLastCalledWith(['learner'], 'proper');
      expect(fake.current.leitor.refreshVocab).toHaveBeenCalledTimes(2);
    });

    it('keeps the popover open with an error when an action fails', async () => {
      const uid = withBook();
      vi.spyOn(mockClient, 'vocabDefine').mockResolvedValue(definition());
      vi.spyOn(mockClient, 'vocabOverrideSet').mockRejectedValue(new Error('banco ocupado'));
      renderPanel();
      clickMark(uid);
      const pop = await screen.findByTestId('vocab-popover');
      fireEvent.click(within(pop).getByRole('button', { name: 'Já sei' }));
      await screen.findByText('Não foi possível concluir: banco ocupado');
      expect(screen.getByTestId('vocab-popover')).toBeTruthy();
      expect(fake.current.leitor.refreshVocab).not.toHaveBeenCalled();
    });

    it('closes with Esc', async () => {
      const uid = withBook();
      vi.spyOn(mockClient, 'vocabDefine').mockResolvedValue(definition());
      renderPanel();
      clickMark(uid);
      const pop = await screen.findByTestId('vocab-popover');
      fireEvent.keyDown(pop, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('vocab-popover')).toBeNull());
    });
  });

  describe('clampAnchor', () => {
    const view = { width: 390, height: 844 };
    it('keeps an anchor inside the window', () => {
      expect(clampAnchor({ x: 100, y: 200, width: 40, height: 14 }, view)).toEqual({
        x: 100,
        y: 200,
        width: 40,
        height: 14,
      });
      // Half out on the right and the bottom: cut at the edges.
      expect(clampAnchor({ x: 370, y: 840, width: 40, height: 14 }, view)).toEqual({
        x: 370,
        y: 840,
        width: 20,
        height: 4,
      });
      // Out on the left/top: moved in, at least 1 px.
      expect(clampAnchor({ x: -50, y: -30, width: 20, height: 10 }, view)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
      expect(clampAnchor({ x: 999, y: 999, width: 5, height: 5 }, view)).toEqual({
        x: 389,
        y: 843,
        width: 1,
        height: 1,
      });
      expect(clampAnchor({ x: Number.NaN, y: 3, width: -4, height: 0 }, view)).toEqual({
        x: 0,
        y: 3,
        width: 1,
        height: 1,
      });
      // No window size (tests): unchanged but at least 1 px.
      expect(clampAnchor({ x: 5, y: 6, width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({
        x: 5,
        y: 6,
        width: 1,
        height: 1,
      });
    });
  });
});
