// The code review inside the study screen (spec 11.2), against the mock core: the command input with its history,
// Enter/Ctrl+Enter, the verdict, the preselected suggestion and the answer keys, Contestar, the AI placeholder and
// "Fácil se rápido".
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { core } from '../../lib/core/client';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { deckByName } from '../../lib/core/mock/ankiData';
import { resetStudyMock } from '../../lib/core/mock/ankiStudy';
import { installDomStubs } from '../../lib/testing/dom';
import { StudyPage } from '../anki/study/StudyPage';
import { cardFrame, stubCardFrameWindows } from '../anki/study/testing';
import { HISTORY_KEY, pushHistory } from './history';

const leitorMock = vi.hoisted(() => ({ openBook: vi.fn(async () => true), setReviewing: vi.fn() }));
vi.mock('../leitor', () => ({ leitor: leitorMock, LeitorHost: () => null, useLeitorSelector: () => null }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('../anki/editor/NoteEditorDialog', () => ({ NoteEditorDialog: () => null }));
vi.mock('../anki/pages/AnkiWebPage', () => ({ AnkiWebPage: () => null }));

beforeAll(() => {
  installDomStubs();
  // CodeMirror measures text ranges (jsdom has no layout).
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= rects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(core, 'cardFrameUrl').mockReturnValue('about:blank');
  stubCardFrameWindows();
  mockHandle.reset();
  resetStudyMock();
  localStorage.removeItem(HISTORY_KEY);
  navigate.mockClear();
});

const deckId = (name: string) => deckByName(name)!.id;
const answers = () => mockHandle.anki.logs.filter((l) => l.kind === 'answer');

function renderStudy(props: Parameters<typeof StudyPage>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <StudyPage {...props} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The ROS deck: its first card is the "Código · Comando" note (tf2_echo). */
async function openRos() {
  renderStudy({ deckId: deckId('ROS 2 — Revisão') });
  const f = await cardFrame();
  await f.send({ t: 'ready' });
  await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
  await f.send({ t: 'shown' });
  const input = await screen.findByTestId('code-command-input');
  return { f, input: input as HTMLInputElement };
}

/** Suspends the cards of `deck` except the `keep`-th (creation order), so it is the first one shown. */
async function onlyCard(deck: string, keep: number) {
  const ids = await mockClient.ankiSearch(`deck:"${deck}"`, { column: 'noteCrt', reverse: false });
  await mockClient.ankiCardsSuspend(
    ids.filter((_, i) => i !== keep),
    true,
  );
}

describe('CodePanel · command', () => {
  it('shows only the Pergunta in the card frame and the command input instead of "Mostrar resposta"', async () => {
    const { f, input } = await openRos();
    const q = f.last('showQuestion');
    expect(q && q.t === 'showQuestion' && q.q).toContain('Ver a transformação entre os frames world e turtle1');
    expect(q && q.t === 'showQuestion' && q.q).not.toContain('typeans');
    expect((input as HTMLInputElement).getAttribute('aria-label')).toBe('Digite o comando');
    // One "Mostrar resposta" (the panel's ghost button); the engine's bar button is not rendered for code cards.
    expect(screen.getAllByRole('button', { name: /^Mostrar resposta$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Mostrar resposta$/ }).getAttribute('aria-keyshortcuts')).toBeNull();
  });

  it('a typo → Quase, the token diff, Difícil preselected; Enter confirms it', async () => {
    const user = userEvent.setup();
    const { f, input } = await openRos();
    await user.type(input, 'ros2 run tf2_ros tf2_eco world turtle1');
    // Typing keys never reach the study shortcuts.
    expect(answers()).toHaveLength(0);
    await user.keyboard('{Enter}');
    expect((await screen.findByTestId('code-verdict'))?.textContent ?? '').toContain('Quase');
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    expect(screen.getByTestId('code-token-diff')?.textContent ?? '').toContain('tf2_eco');
    const messages = screen.getByTestId('code-diff-messages');
    expect(messages?.textContent ?? '').toMatch(/digitação/);
    // The checker's Markdown backticks render as inline code, never as literal backticks.
    expect(messages?.textContent ?? '').not.toContain('`');
    expect([...(messages?.querySelectorAll('code') ?? [])].map((c) => c.textContent)).toEqual(['tf2_eco', 'tf2_echo']);
    expect(screen.getByTestId('code-reference')?.textContent ?? '').toContain(
      'ros2 run tf2_ros tf2_echo world turtle1',
    );
    const hard = screen.getByRole('button', { name: /^Difícil/ });
    expect(hard?.getAttribute('data-suggested')).toBe('true');
    expect(screen.getByTestId('code-suggestion')?.textContent ?? '').toContain('Sugerida: Difícil');
    await waitFor(() => expect(document.activeElement).toBe(hard));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ rating: 2 });
  });

  it('correct → Correto and Bom; 1–4 choose another rating', async () => {
    const user = userEvent.setup();
    const { input } = await openRos();
    await user.type(input, 'ros2 run tf2_ros tf2_echo world turtle1');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect((await screen.findByTestId('code-verdict'))?.textContent ?? '').toContain('Correto');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Bom/ })?.getAttribute('data-suggested')).toBe('true'),
    );
    expect(screen.queryByRole('button', { name: 'Contestar' })).toBeNull();
    await user.keyboard('4');
    await waitFor(() => expect(answers()).toHaveLength(1));
    expect(answers()[0]).toMatchObject({ rating: 4 });
  });

  it('↑/↓ browse the history (last 100, no consecutive duplicates)', async () => {
    pushHistory('command', 'ros2 topic list');
    pushHistory('command', 'ros2 node list');
    pushHistory('command', 'ros2 node list');
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!).command).toEqual(['ros2 topic list', 'ros2 node list']);
    for (let i = 0; i < 120; i++) pushHistory('command', `cmd ${i}`);
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!).command).toHaveLength(100);
    localStorage.removeItem(HISTORY_KEY);
    pushHistory('command', 'ros2 topic list');
    pushHistory('command', 'ros2 node list');
    const user = userEvent.setup();
    const { input } = await openRos();
    await user.type(input, 'rascunho');
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('ros2 node list');
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('ros2 topic list');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input.value).toBe('rascunho');
  });

  it('Contestar accepts my answer (added to Aceitas) and suggests Bom', async () => {
    const user = userEvent.setup();
    const accept = vi.spyOn(core, 'codeAcceptAnswer');
    const { input } = await openRos();
    await user.type(input, 'ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco{Enter}');
    expect((await screen.findByTestId('code-verdict'))?.textContent ?? '').not.toContain('Correto');
    await user.click(screen.getByRole('button', { name: 'Contestar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aceitar minha resposta' });
    expect((within(dialog).getByLabelText('Adicionar às respostas aceitas') as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByTestId('code-contest-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('code-verdict')?.textContent ?? '').toContain('Correto (aceito por você)'),
    );
    expect(accept).toHaveBeenCalledWith(
      expect.any(Number),
      'ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Bom/ })?.getAttribute('data-suggested')).toBe('true'),
    );
    const noteId = (await mockClient.ankiBrowseRows(await mockClient.ankiSearch('tf2_echo', null)))[0]!.noteId;
    expect(mockHandle.anki.noteFields(noteId)['Aceitas']).toContain('__node:=eco');
  });

  it('"Pedir avaliação da IA" shows the placeholder and never answers the card', async () => {
    const user = userEvent.setup();
    const { input } = await openRos();
    await user.type(input, 'ls -la{Enter}');
    expect((await screen.findByTestId('code-verdict'))?.textContent ?? '').toContain('Errado');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^De novo/ })?.getAttribute('data-suggested')).toBe('true'),
    );
    await user.click(screen.getByRole('button', { name: 'Pedir avaliação da IA' }));
    expect(screen.getByTestId('code-ai-placeholder')?.textContent ?? '').toContain(
      'A avaliação por IA chega numa próxima versão. Configure o provedor em Configurações → IA.',
    );
    await user.click(screen.getByRole('button', { name: 'Abrir Configurações → IA' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/configuracoes/ia' });
    expect(answers()).toHaveLength(0);
  });

  it('"Mostrar resposta" gives up: the answer side, no verdict and no suggestion', async () => {
    const user = userEvent.setup();
    const { f } = await openRos();
    await user.click(screen.getByRole('button', { name: /^Mostrar resposta$/ }));
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    expect(screen.queryByTestId('code-verdict')).toBeNull();
    expect(screen.getByTestId('code-suggestion')?.textContent ?? '').toContain('Escolha uma nota');
    expect(screen.getByTestId('code-reference')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('answer-buttons'), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 30));
    expect(answers()).toHaveLength(0);
  });

  it('suggests Fácil when correct under the threshold (option off by default)', async () => {
    await mockClient.codeSettingsSet({ suggestEasy: true, suggestEasySecs: 600 });
    const user = userEvent.setup();
    const { input } = await openRos();
    await user.type(input, 'ros2 run tf2_ros tf2_echo world turtle1{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Fácil/ })?.getAttribute('data-suggested')).toBe('true'),
    );
  });

  it('a mapped user type is studied interactively (after codeMappingSet)', async () => {
    await onlyCard('ROS 2 — Revisão', 3);
    const user = userEvent.setup();
    // Without the role: a normal card (the type's own front).
    const view = renderStudy({ deckId: deckId('ROS 2 — Revisão') });
    let f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    expect(screen.queryByTestId('code-panel')).toBeNull();
    view.unmount();
    const nt = (await mockClient.ankiNotetypes()).find((n) => n.name === 'ROS 2 · Digite o comando')!;
    await mockClient.codeMappingSet(nt.id, { question: 'Frente', answer: 'Comando', notes: 'Explicação' });
    renderStudy({ deckId: deckId('ROS 2 — Revisão') });
    f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    const q = f.last('showQuestion');
    expect(q && q.t === 'showQuestion' && q.q).not.toContain('textarea');
    const input = await screen.findByTestId('code-command-input');
    await user.type(input, 'ros2 run tf2_ros tf2_echo world turtle1{Enter}');
    expect((await screen.findByTestId('code-verdict'))?.textContent ?? '').toContain('Correto');
  });
});

describe('CodePanel · C++ (mock core)', () => {
  it('testes: the editor with the card language, the tests list and Correto', async () => {
    await onlyCard('Programação', 3);
    const user = userEvent.setup();
    renderStudy({ deckId: deckId('Programação') });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    await f.send({ t: 'shown' });
    const editor = await screen.findByTestId('code-editor');
    expect(editor?.getAttribute('data-language')).toBe('cpp');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByText('Escreva uma resposta antes de verificar.')).toBeTruthy();
    // The CodeMirror view takes the text (jsdom cannot type into a contenteditable reliably).
    await waitFor(() => expect(editor.getAttribute('data-state')).toBe('ready'));
    const view = EditorView.findFromDOM(editor.querySelector('.cm-editor') as HTMLElement)!;
    act(() => view.dispatch({ changes: { from: 0, insert: 'int quadrado(int x) { return x * x; }' } }));
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect((await screen.findByTestId('code-verdict'))?.textContent ?? '').toContain('Correto');
    expect(screen.getByTestId('code-tests-summary')?.textContent ?? '').toContain('2 de 2 testes passaram');
    // The card's back already prints the Resposta: the panel doesn't repeat the reference answer.
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    expect(screen.queryByTestId('code-reference')).toBeNull();
  });

  it('without a compiler: estrutura with the notice; different code is Não verificável with nothing preselected', async () => {
    mockHandle.anki.setCppAvailable(false);
    await onlyCard('Programação', 3);
    renderStudy({ deckId: deckId('Programação'), codeAnswer: 'int quadrado(int x) { return x + x; }' });
    const f = await cardFrame();
    await f.send({ t: 'ready' });
    await waitFor(() => expect(f.last('showQuestion')).toBeTruthy());
    await f.send({ t: 'shown' });
    expect((await screen.findByTestId('code-verdict'))?.textContent ?? '').toContain('Não verificável');
    expect(screen.getByTestId('code-notice')?.textContent ?? '').toContain('Sem compilador de C++ neste computador');
    expect(screen.getByTestId('code-structure')?.textContent ?? '').toContain('x + x');
    await waitFor(() => expect(f.last('showAnswer')).toBeTruthy());
    expect(document.querySelector('[data-suggested="true"]')).toBeNull();
    expect(screen.getByTestId('code-suggestion')?.textContent ?? '').toContain('Escolha uma nota');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('answer-buttons')));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 30));
    expect(answers()).toHaveLength(0);
    fireEvent.keyDown(document.activeElement!, { key: '1' });
    await waitFor(() => expect(answers()).toHaveLength(1));
  });
});
