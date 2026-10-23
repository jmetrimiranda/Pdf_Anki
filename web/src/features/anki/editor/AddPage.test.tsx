import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { mockClient, mockHandle } from '../../../lib/core/mock';
import { installDomStubs } from '../../../lib/testing/dom';
import { runCodeCheck } from '../../code-review/run';
import { AddPage } from './AddPage';
import { cppUnavailableOutcome, outcome } from './codeTesting';

vi.mock('../../../components/code/CodeEditor', async () => (await import('./codeTesting')).fakeCodeEditorModule);
vi.mock('../../code-review/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../code-review/run')>()),
  runCodeCheck: vi.fn(),
}));
const check = vi.mocked(runCodeCheck);

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  localStorage.clear();
  check.mockReset();
});

function renderAdd(props: { deckId?: number; notetypeId?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <AddPage {...props} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function deckId(name: string) {
  return (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;
}

async function notetypeId(name: string) {
  return (await mockClient.ankiNotetypes()).find((n) => n.name === name)!.id;
}

const addLogs = () => mockHandle.anki.logs.filter((l) => l.kind === 'addNote');

describe('AddPage', () => {
  it('adds a Basic note with tags, then clears the fields and keeps the tags', async () => {
    const user = userEvent.setup();
    renderAdd({ deckId: await deckId('Oxford::Oxford 3000'), notetypeId: await notetypeId('Básico') });
    const front = await screen.findByRole('textbox', { name: 'Frente' });
    const back = screen.getByRole('textbox', { name: 'Verso' });
    await user.click(front);
    await user.keyboard('sun');
    await user.click(back);
    await user.keyboard('sol');
    const tags = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(tags, 'astro ');
    await user.click(screen.getByRole('button', { name: 'Adicionar' }));

    await screen.findByText('Card adicionado');
    const log = addLogs().at(-1)!;
    expect(log.fields).toEqual(['sun', 'sol']);
    expect(log.tags).toEqual(['astro']);
    expect(log.deckId).toBe(await deckId('Oxford::Oxford 3000'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Frente' }).textContent).toBe(''));
    expect(screen.getByRole('button', { name: 'Remover a tag astro' })).toBeTruthy();
  });

  it('refuses an empty first field with an inline error', async () => {
    const user = userEvent.setup();
    renderAdd({ notetypeId: await notetypeId('Básico') });
    const back = await screen.findByRole('textbox', { name: 'Verso' });
    await user.click(back);
    await user.keyboard('só o verso');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText('O primeiro campo está vazio.')).toBeTruthy();
    expect(addLogs()).toHaveLength(0);
  });

  it('wraps a cloze with Ctrl+Shift+C and adds one card per cloze', async () => {
    const user = userEvent.setup();
    renderAdd({ deckId: await deckId('Gramática::Cloze'), notetypeId: await notetypeId('Omissão de palavras') });
    const text = await screen.findByRole('textbox', { name: 'Texto' });
    await user.click(text);
    await user.keyboard('A casa');
    // Select "casa" and wrap it (the caret placement itself is covered in Playwright).
    const range = document.createRange();
    range.setStart(text.firstChild!, 2);
    range.setEnd(text.firstChild!, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await user.keyboard('{Control>}{Shift>}C{/Shift}{/Control}');
    await waitFor(() => expect(text.textContent).toBe('A {{c1::casa}}'));
    await user.click(screen.getByRole('button', { name: 'Adicionar' }));
    await screen.findByText('Card adicionado');
    expect(addLogs().at(-1)!.fields).toEqual(['A {{c1::casa}}', '']);
  });

  it('disables the cloze button outside cloze notetypes and offers "Preparar coleção"', async () => {
    renderAdd({ notetypeId: await notetypeId('Básico') });
    await screen.findByRole('textbox', { name: 'Frente' });
    const toolbar = screen.getByRole('toolbar', { name: 'Formatação' });
    expect((within(toolbar).getByRole('button', { name: 'Lacuna (cloze)' }) as HTMLButtonElement).disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Preparar coleção' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preparar coleção' })).toBeNull());
    expect(mockHandle.anki.notetypeNames).toContain('Código · Programa');
  });

  it('warns about duplicates without blocking', async () => {
    const user = userEvent.setup();
    renderAdd({ notetypeId: await notetypeId('Básico') });
    const front = await screen.findByRole('textbox', { name: 'Frente' });
    await user.click(front);
    await user.keyboard('kitchen');
    expect(await screen.findByText(/Já existe uma nota deste tipo/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Adicionar' }));
    await screen.findByText('Card adicionado');
  });
});

describe('AddPage · code notes (spec 11.7)', () => {
  const addButton = () => screen.getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement;

  it('keeps Adicionar disabled until the reference passes, and again after a code edit', async () => {
    const user = userEvent.setup();
    check.mockResolvedValue(outcome('correct', { modeUsed: 'command' }));
    renderAdd({ deckId: await deckId('ROS 2 — Revisão'), notetypeId: await notetypeId('Código · Comando') });
    const question = await screen.findByRole('textbox', { name: 'Pergunta' });
    await user.click(question);
    await user.keyboard('Listar os nós');
    await user.type(screen.getByRole('textbox', { name: 'Resposta' }), 'ros2 node list');
    expect(addButton().disabled).toBe(true);
    expect(screen.getByText('Teste a resposta de referência antes de salvar.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Testar resposta de referência' }));
    expect(await screen.findByText('A resposta de referência passou.')).toBeTruthy();
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'command', answer: 'ros2 node list' }),
      'ros2 node list',
      expect.anything(),
    );
    await waitFor(() => expect(addButton().disabled).toBe(false));

    // A code field changes: the test has to run again.
    await user.type(screen.getByRole('textbox', { name: 'Resposta' }), ' --all');
    await waitFor(() => expect(addButton().disabled).toBe(true));
    expect(screen.getByText('O código mudou: teste de novo antes de salvar.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Testar resposta de referência' }));
    await waitFor(() => expect(addButton().disabled).toBe(false));
    await user.click(addButton());
    await screen.findByText('Card adicionado');
    expect((addLogs().at(-1)!.fields as string[]).slice(0, 2)).toEqual(['Listar os nós', 'ros2 node list --all']);
  });

  it('reports each Aceitas line and refuses a failing reference', async () => {
    const user = userEvent.setup();
    check.mockImplementation(async (_ref, answer) =>
      outcome(answer.includes('echo') ? 'wrong' : 'equivalent', { modeUsed: 'command' }),
    );
    renderAdd({ notetypeId: await notetypeId('Código · Comando') });
    await user.click(await screen.findByRole('textbox', { name: 'Pergunta' }));
    await user.keyboard('Listar tópicos');
    await user.type(screen.getByRole('textbox', { name: 'Resposta' }), 'ros2 topic list');
    await user.type(screen.getByRole('textbox', { name: 'Aceitas' }), 'ros2 topic list -t{Enter}ros2 topic echo /x');
    await user.click(screen.getByRole('button', { name: 'Testar resposta de referência' }));
    const lines = await screen.findAllByTestId('reference-accepted');
    expect(lines.map((l) => l.textContent)).toEqual(['Equivalenteros2 topic list -t', 'Erradoros2 topic echo /x']);
    expect(addButton().disabled).toBe(false);

    check.mockResolvedValue(outcome('wrong', { modeUsed: 'command' }));
    await user.type(screen.getByRole('textbox', { name: 'Resposta' }), 'x');
    await user.click(screen.getByRole('button', { name: 'Testar resposta de referência' }));
    expect(await screen.findByText('A resposta de referência não passou: corrija antes de salvar.')).toBeTruthy();
    expect(addButton().disabled).toBe(true);
  });

  it('offers "Salvar sem testar" when C++ cannot run', async () => {
    const user = userEvent.setup();
    check.mockResolvedValue(cppUnavailableOutcome());
    renderAdd({ deckId: await deckId('ROS 2 — Revisão'), notetypeId: await notetypeId('Código · Programa') });
    await user.click(await screen.findByRole('textbox', { name: 'Pergunta' }));
    await user.keyboard('Soma');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Linguagem' }), 'cpp');
    expect((screen.getByRole('combobox', { name: 'Modo' }) as HTMLSelectElement).value).toBe('testes');
    await user.type(screen.getByRole('textbox', { name: 'Resposta' }), 'int soma(int a, int b) {{ return a + b; }');
    await user.click(screen.getByRole('button', { name: 'Testar resposta de referência' }));
    expect(await screen.findByText(/O C\+\+ não pode rodar agora/)).toBeTruthy();
    expect(addButton().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Salvar sem testar' }));
    await screen.findByText('Card adicionado');
    const fields = addLogs().at(-1)!.fields as string[];
    expect(fields.slice(0, 4)).toEqual(['Soma', 'cpp', 'testes', 'int soma(int a, int b) { return a + b; }']);
  });

  it('does not gate other notetypes', async () => {
    renderAdd({ notetypeId: await notetypeId('Básico') });
    await screen.findByRole('textbox', { name: 'Frente' });
    expect(screen.queryByRole('button', { name: 'Testar resposta de referência' })).toBeNull();
    expect(addButton().disabled).toBe(false);
  });
});
