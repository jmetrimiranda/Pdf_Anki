import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { mockClient, mockHandle } from '../../lib/core/mock';
import type { BookPanelInfo } from '../../lib/core/types';
import { installDomStubs } from '../../lib/testing/dom';
import {
  CardForm,
  defaultDeck,
  initialKind,
  KIND_ORDER,
  noteFields,
  prefill,
  wrapCloze,
  type CardSelection,
} from './CardForm';
import { runCodeCheck } from '../code-review/run';
import { outcome } from '../anki/editor/codeTesting';
import { fonteHtml } from './fonte';

vi.mock(
  '../../components/code/CodeEditor',
  async () => (await import('../anki/editor/codeTesting')).fakeCodeEditorModule,
);
vi.mock('../code-review/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../code-review/run')>()),
  runCodeCheck: vi.fn(),
}));
const check = vi.mocked(runCodeCheck);

beforeAll(() => installDomStubs());
beforeEach(async () => {
  mockHandle.reset();
  localStorage.clear();
  check.mockReset();
  check.mockResolvedValue(outcome('correct', { modeUsed: 'command' }));
  // The seed collection lacks some app notetypes ("Preparar coleção" is tested on its own).
  await mockClient.ankiPrepareCollection();
});
afterEach(() => vi.restoreAllMocks());

const farmUid = () => mockHandle.books.find((b) => b.title === 'Animal Farm')!.bookUid;
const deckId = async (name: string) => (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;
const addLogs = () => mockHandle.anki.logs.filter((l) => l.kind === 'addNote');
const setLogs = () => mockHandle.anki.logs.filter((l) => l.kind === 'bookPanelSet');

async function renderForm(selection: CardSelection, infoPatch: Partial<BookPanelInfo> = {}, waitFields = true) {
  const uid = farmUid();
  const info = { ...(await mockClient.bookPanelInfo(uid)), ...infoPatch };
  const onClose = vi.fn();
  const outerKey = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          {/* The panel's own key handling (overlay Esc) sits above the form. */}
          <div onKeyDown={outerKey}>
            <CardForm bookUid={uid} title="Animal Farm" selection={selection} info={info} onClose={onClose} />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const form = await screen.findByRole('form', { name: 'Novo card' });
  // The notetypes load asynchronously.
  if (waitFields) await within(form).findAllByRole('textbox');
  return { uid, info, onClose, outerKey, form, client };
}

const sel = (text: string, page = 36): CardSelection => ({ page, text, rects: [[72, 120, 200, 14]] });

async function chooseKind(name: string) {
  fireEvent.click(screen.getByRole('radio', { name }));
  await screen.findByRole('radio', { name, checked: true });
}

describe('card form helpers', () => {
  it('prefills each kind by field name, prose collapsed and code kept', () => {
    expect(prefill('basic', 'The wind-\nmill  fell.')).toEqual({ Frente: 'The windmill fell.', Verso: '' });
    expect(prefill('cloze', 'a\nb')).toEqual({ Texto: 'a b', 'Verso extra': '' });
    expect(prefill('codeCommand', 'ros2 run\n  demo')).toEqual({ Pergunta: '', Resposta: 'ros2 run\n  demo' });
    expect(prefill('codeCommand', '$ ros2 run turtlesim turtlesim_node')).toEqual({
      Pergunta: '',
      Resposta: 'ros2 run turtlesim turtlesim_node',
    });
    expect(prefill('codeProgram', 'x = 1')).toEqual({
      Pergunta: '',
      Linguagem: 'python',
      Modo: 'estrutura',
      Resposta: 'x = 1',
    });
    expect(prefill('codeProgram', '#include <cstdio>\nint main() { return 0; }').Linguagem).toBe('cpp');
    expect(prefill('vocab', '“Animals,”')).toEqual({
      Palavra: 'Animals',
      Lema: 'animals',
      Exemplo: 'Animals',
      Família: '',
    });
  });

  it('maps the values on the notetype fields by name (never by index)', () => {
    const nt = {
      id: 1,
      name: 'Básico (Leitor)',
      kind: 'normal' as const,
      // A reordered notetype: Fonte first.
      fields: ['Fonte', 'Verso', 'Frente', 'Extra'].map((name) => ({
        name,
        fontName: '',
        fontSize: 20,
        rtl: false,
        plainText: false,
      })),
      templates: [],
      appType: 'Básico (Leitor)',
      noteCount: 0,
    };
    expect(noteFields('basic', nt, { Frente: 'a < b', Verso: 'x\ny' }, '<a>F</a>')).toEqual([
      '<a>F</a>',
      'x<br>y',
      'a &lt; b',
      '',
    ]);
  });

  it('picks the default deck: last, then content, then the book’s vocab deck, then Anki’s (Vocabulário: vocab first)', () => {
    const base: BookPanelInfo = {
      bookUid: 'u',
      title: 'T',
      vocabRootDeckId: null,
      vocabRootName: null,
      vocabDeck: { role: 'vocab', deckId: 7, name: 'Livros::T', exists: true, counts: null },
      contentDeck: { role: 'content', deckId: 8, name: 'C', exists: true, counts: null },
      lastDeckId: 9,
      lastKind: null,
      reviewDeckId: null,
      vocab: null,
      chapterDeck: null,
    };
    expect(defaultDeck('basic', base, 1)).toBe(9);
    expect(defaultDeck('basic', { ...base, lastDeckId: null }, 1)).toBe(8);
    // A first card of a book with only its Livros::<Título> deck goes there, not to Anki's (unrelated) current deck.
    expect(defaultDeck('basic', { ...base, lastDeckId: null, contentDeck: null }, 1)).toBe(7);
    const noVocab = { ...base.vocabDeck, exists: false, deckId: null };
    expect(defaultDeck('cloze', { ...base, lastDeckId: null, contentDeck: null, vocabDeck: noVocab }, 1)).toBe(1);
    expect(defaultDeck('vocab', base, 1)).toBe(7);
    expect(defaultDeck('vocab', { ...base, vocabDeck: { ...base.vocabDeck, exists: false, deckId: null } }, 1)).toBe(9);
  });

  it('opens with the kind the selection suggests; prose never gets a code kind', () => {
    expect(initialKind('$ ros2 run turtlesim turtlesim_node', null, KIND_ORDER)).toBe('codeCommand');
    expect(initialKind('def f(x):\n    return x', 'cloze', KIND_ORDER)).toBe('codeProgram');
    expect(initialKind('All animals are equal.', 'cloze', KIND_ORDER)).toBe('cloze');
    expect(initialKind('All animals are equal.', 'codeCommand', KIND_ORDER)).toBe('basic');
    expect(initialKind('All animals are equal.', null, KIND_ORDER)).toBe('basic');
  });

  it('wraps a range in a cloze', () => {
    expect(wrapCloze('All animals are equal', 4, 11, 1)).toEqual({
      value: 'All {{c1::animals}} are equal',
      selStart: 10,
      selEnd: 17,
    });
  });
});

describe('CardForm', () => {
  it('adds a Básico with the trecho, the typed back and the Fonte, then saves the last deck and kind', async () => {
    const user = userEvent.setup();
    const { uid, onClose, form } = await renderForm(sel('The windmill\nwas built.'));
    const deck = await deckId('Livros::Animal Farm');
    expect(screen.getByRole('radio', { name: 'Básico', checked: true })).toBeTruthy();
    expect((within(form).getByRole('textbox', { name: 'Frente' }) as HTMLTextAreaElement).value).toBe(
      'The windmill was built.',
    );
    expect(screen.getByTestId('card-form-fonte').textContent).toBe('Animal Farm, p. 37');
    const back = within(form).getByRole('textbox', { name: 'Verso' });
    await waitFor(() => expect(document.activeElement).toBe(back));
    // No last deck nor content deck: Anki's default deck… pick the book's deck instead.
    await waitFor(() => expect(within(form).getByRole('combobox', { name: 'Deck' })).toHaveProperty('disabled', false));
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Deck' }), String(deck));
    await user.type(back, 'o moinho');
    fireEvent.keyDown(back, { key: 'Enter', ctrlKey: true });

    await screen.findByText('Card adicionado');
    const log = addLogs().at(-1)!;
    expect(log.fields).toEqual([
      'The windmill was built.',
      'o moinho',
      fonteHtml(uid, 'Animal Farm', 37, 'The windmill was built.'),
    ]);
    expect(log.deckId).toBe(deck);
    expect(log.tags).toEqual(['leitor']);
    expect(onClose).toHaveBeenCalled();
    await waitFor(() =>
      expect(setLogs().at(-1)).toMatchObject({ uid, patch: { lastDeckId: deck, lastKind: 'basic' } }),
    );
  });

  it('starts on the last kind and deck of the book', async () => {
    const deck = await deckId('Livros::Animal Farm');
    const { form } = await renderForm(sel('Napoleon is always right'), { lastKind: 'cloze', lastDeckId: deck });
    expect(screen.getByRole('radio', { name: 'Cloze', checked: true })).toBeTruthy();
    await waitFor(() =>
      expect((within(form).getByRole('combobox', { name: 'Deck' }) as HTMLSelectElement).value).toBe(String(deck)),
    );
  });

  it('marks cloze gaps with Ctrl+Shift+C and the Lacuna button, numbering them', async () => {
    const { uid, form } = await renderForm(sel('All animals are equal'), { lastKind: 'cloze' });
    const text = within(form).getByRole('textbox', { name: 'Texto' }) as HTMLTextAreaElement;
    text.setSelectionRange(4, 11);
    fireEvent.keyDown(text, { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(text.value).toBe('All {{c1::animals}} are equal'));
    const at = text.value.indexOf('equal');
    text.setSelectionRange(at, at + 5);
    fireEvent.click(within(form).getByRole('button', { name: 'Lacuna' }));
    await waitFor(() => expect(text.value).toBe('All {{c1::animals}} are {{c2::equal}}'));

    fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true });
    await screen.findByText('Card adicionado');
    const log = addLogs().at(-1)!;
    expect(log.fields).toEqual([
      'All {{c1::animals}} are {{c2::equal}}',
      '',
      fonteHtml(uid, 'Animal Farm', 37, 'All animals are equal'),
    ]);
  });

  it('refuses a cloze without gaps (inline error, nothing added)', async () => {
    const { form } = await renderForm(sel('All animals are equal'), { lastKind: 'cloze' });
    const before = addLogs().length;
    fireEvent.keyDown(within(form).getByRole('textbox', { name: 'Texto' }), { key: 'Enter', ctrlKey: true });
    await screen.findByText('Marque pelo menos uma lacuna com Ctrl+Shift+C.');
    expect(addLogs().length).toBe(before);
  });

  it('keeps line breaks for code and escapes them as HTML', async () => {
    const { form } = await renderForm(sel('ls -la | grep "<x>"\n  cd /tmp'));
    await chooseKind('Código · Comando');
    const answer = within(form).getByRole('textbox', { name: 'Resposta' }) as HTMLTextAreaElement;
    expect(answer.value).toBe('ls -la | grep "<x>"\n  cd /tmp');
    const question = within(form).getByRole('textbox', { name: 'Pergunta' });
    await waitFor(() => expect(document.activeElement).toBe(question));
    fireEvent.change(question, { target: { value: 'Listar e filtrar' } });
    const add = within(form).getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(within(form).getByRole('button', { name: 'Testar' }));
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    await screen.findByText('Card adicionado');
    const fields = addLogs().at(-1)!.fields as string[];
    expect(fields[0]).toBe('Listar e filtrar');
    expect(fields[1]).toBe('ls -la | grep "&lt;x&gt;"<br>  cd /tmp');
  });

  it('prefills Código · Programa with the guessed language and mode estrutura', async () => {
    const { form } = await renderForm(sel('print(1)'));
    await chooseKind('Código · Programa');
    expect((within(form).getByRole('combobox', { name: 'Linguagem' }) as HTMLSelectElement).value).toBe('python');
    expect((within(form).getByRole('combobox', { name: 'Modo' }) as HTMLSelectElement).value).toBe('estrutura');
    expect((within(form).getByRole('textbox', { name: 'Resposta' }) as HTMLTextAreaElement).value).toBe('print(1)');
  });

  it('opens a command selection as Código · Comando without the prompt, Pergunta focused', async () => {
    const { form } = await renderForm(sel('$ ros2 run turtlesim turtlesim_node'), { lastKind: 'cloze' });
    expect(screen.getByRole('radio', { name: 'Código · Comando', checked: true })).toBeTruthy();
    expect((within(form).getByRole('textbox', { name: 'Resposta' }) as HTMLTextAreaElement).value).toBe(
      'ros2 run turtlesim turtlesim_node',
    );
    const question = within(form).getByRole('textbox', { name: 'Pergunta' });
    await waitFor(() => expect(document.activeElement).toBe(question));
    // Ctrl+Enter waits for the test.
    fireEvent.change(question, { target: { value: 'Abrir o turtlesim' } });
    const before = addLogs().length;
    fireEvent.keyDown(question, { key: 'Enter', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(addLogs().length).toBe(before);
    fireEvent.click(within(form).getByRole('button', { name: 'Testar' }));
    expect(await within(form).findByText('A resposta de referência passou.')).toBeTruthy();
    fireEvent.keyDown(question, { key: 'Enter', ctrlKey: true });
    await screen.findByText('Card adicionado');
    expect((addLogs().at(-1)!.fields as string[]).slice(0, 2)).toEqual([
      'Abrir o turtlesim',
      'ros2 run turtlesim turtlesim_node',
    ]);
  });

  it('opens a Python block as Código · Programa', async () => {
    await renderForm(sel('def soma(xs):\n    return sum(xs)'));
    expect(screen.getByRole('radio', { name: 'Código · Programa', checked: true })).toBeTruthy();
  });

  it('keeps prose on Básico even when the last kind was code', async () => {
    await renderForm(sel('All animals are equal, but some animals are more equal than others.'), {
      lastKind: 'codeCommand',
    });
    expect(screen.getByRole('radio', { name: 'Básico', checked: true })).toBeTruthy();
  });

  it('offers Vocabulário only for a single word, with the lemma and the sentence around it', async () => {
    const uid = farmUid();
    const words = await mockClient.docWords(uid, 0);
    const farm = words.words.find((w) => w.text === 'farm' && words.text.slice(w.end, w.end + 10) === ' buildings')!;
    const { form } = await renderForm({ page: 0, text: 'farm', rects: farm.rects });
    await chooseKind('Vocabulário');
    expect((within(form).getByRole('textbox', { name: 'Palavra' }) as HTMLInputElement).value).toBe('farm');
    await waitFor(() =>
      expect((within(form).getByRole('textbox', { name: 'Exemplo' }) as HTMLTextAreaElement).value).toBe(
        'As soon as the light in the bedroom went out there was a stirring and a fluttering all through the farm buildings.',
      ),
    );
    expect((within(form).getByRole('textbox', { name: 'Lema' }) as HTMLInputElement).value).toBe('farm');
    // Família (spec 12.6): empty and editable, so the form matches the 10-field type.
    const familia = within(form).getByRole('textbox', { name: 'Família' }) as HTMLInputElement;
    expect(familia.value).toBe('');
    fireEvent.change(familia, { target: { value: 'farmer' } });
    // The vocabulary deck (Livros::Animal Farm while no vocabulary folder is chosen) is the default.
    const deck = await deckId('Livros::Animal Farm');
    await waitFor(() =>
      expect((within(form).getByRole('combobox', { name: 'Deck' }) as HTMLSelectElement).value).toBe(String(deck)),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Adicionar' }));
    await screen.findByText('Card adicionado');
    const nts = await mockClient.ankiNotetypes();
    const vocab = nts.find((n) => n.appType === 'Vocabulário · Livro')!;
    const fields = addLogs().at(-1)!.fields as string[];
    const at = (name: string) => fields[vocab.fields.findIndex((f) => f.name === name)];
    expect(at('Palavra')).toBe('farm');
    expect(at('Lema')).toBe('farm');
    expect(vocab.fields.map((f) => f.name)).toContain('Família');
    expect(at('Família')).toBe('farmer');
    expect(at('Exemplo')).toBe(
      'As soon as the light in the bedroom went out there was a stirring and a fluttering all through the <b>farm</b> buildings.',
    );
    expect(at('Fonte')).toBe(fonteHtml(uid, 'Animal Farm', 1, 'farm'));
  });

  it('shows the lemma from the core for an inflected word', async () => {
    const { form } = await renderForm(sel('animals'));
    await chooseKind('Vocabulário');
    await waitFor(() =>
      expect((within(form).getByRole('textbox', { name: 'Lema' }) as HTMLInputElement).value).toBe('animal'),
    );
  });

  it('hides Vocabulário for several words', async () => {
    await renderForm(sel('two words'));
    expect(screen.queryByRole('radio', { name: 'Vocabulário' })).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('warns about a duplicate but still adds it', async () => {
    const { form } = await renderForm(sel('Same front'));
    const deck = await deckId('Livros::Animal Farm');
    await waitFor(() => expect(within(form).getByRole('combobox', { name: 'Deck' })).toHaveProperty('disabled', false));
    fireEvent.change(within(form).getByRole('combobox', { name: 'Deck' }), { target: { value: String(deck) } });
    vi.spyOn(mockClient, 'ankiNoteCheck').mockResolvedValue('duplicate');
    fireEvent.change(within(form).getByRole('textbox', { name: 'Verso' }), { target: { value: 'x' } });
    await screen.findByText(/Já existe uma nota deste tipo/);
    fireEvent.click(within(form).getByRole('button', { name: 'Adicionar' }));
    await screen.findByText('Card adicionado');
  });

  it('offers Preparar coleção when the app notetypes are missing, then shows the form', async () => {
    const real = await mockClient.ankiNotetypes();
    const spy = vi.spyOn(mockClient, 'ankiNotetypes').mockResolvedValue(real.filter((n) => !n.appType));
    const prepare = vi.spyOn(mockClient, 'ankiPrepareCollection');
    const { form } = await renderForm(sel('Some text'), {}, false);
    await screen.findByText('Os tipos de nota do app ainda não existem nesta coleção.');
    expect(within(form).queryByRole('textbox', { name: 'Frente' })).toBeNull();
    spy.mockResolvedValue(real);
    fireEvent.click(within(form).getByRole('button', { name: 'Preparar coleção' }));
    await within(form).findByRole('textbox', { name: 'Frente' });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('cancels with Esc without letting the panel see it', async () => {
    const { onClose, outerKey, form } = await renderForm(sel('Some text'));
    fireEvent.keyDown(within(form).getByRole('textbox', { name: 'Verso' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(outerKey).not.toHaveBeenCalled();
    expect(addLogs()).toHaveLength(0);
  });
});
