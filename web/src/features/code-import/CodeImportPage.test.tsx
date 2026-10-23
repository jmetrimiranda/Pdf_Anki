import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { CodeImportPage } from './CodeImportPage';
import { SPEC_EXAMPLE } from './example';
import { deckSearch, itemBadge, itemExcerpt } from './preview';

beforeAll(() => installDomStubs());
beforeEach(async () => {
  mockHandle.reset();
  await mockClient.ankiPrepareCollection();
});
afterEach(() => vi.restoreAllMocks());

const deckId = async (name: string) => (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;

async function renderImport(deck?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The page links to Navegar: a minimal router around it.
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <CodeImportPage deckId={deck} />,
  });
  const browse = createRoute({ getParentRoute: () => root, path: '/anki/navegar', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([page, browse]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { textarea: (await screen.findByRole('textbox', { name: 'Texto em Markdown' })) as HTMLTextAreaElement };
}

const items = () => screen.findAllByTestId('code-import-item');

describe('preview helpers', () => {
  it('labels the kind and cuts the Resposta to three lines', () => {
    expect(itemBadge({ kind: 'command', language: 'bash', mode: null })).toBe('Comando');
    expect(itemBadge({ kind: 'program', language: 'python', mode: 'testes' })).toBe('Programa · Python · testes');
    expect(itemBadge({ kind: 'program', language: 'cpp', mode: 'saida' })).toBe('Programa · C++ · saída');
    expect(itemBadge({ kind: null, language: null, mode: null })).toBe('Sem resposta');
    expect(itemExcerpt({ fields: { Resposta: 'a\nb\nc\nd\n' } })).toBe('a\nb\nc\n…');
    expect(itemExcerpt({ fields: { Resposta: 'a\nb' } })).toBe('a\nb');
    expect(deckSearch('ROS 2 — "x"')).toBe('deck:"ROS 2 — \\"x\\""');
  });
});

describe('CodeImportPage (spec 11.7)', () => {
  it('previews the exact example of the spec: 2 items, no errors', async () => {
    const { textarea } = await renderImport(await deckId('ROS 2 — Revisão'));
    fireEvent.change(textarea, { target: { value: SPEC_EXAMPLE } });
    const list = await items();
    expect(list).toHaveLength(2);
    expect(within(list[0]!).getByText('Ver a transformação entre os frames world e turtle1')).toBeTruthy();
    expect(within(list[0]!).getByText('Comando')).toBeTruthy();
    expect(within(list[0]!).getByText('tf2')).toBeTruthy();
    expect(within(list[1]!).getByText('Programa · Python · testes')).toBeTruthy();
    expect(screen.queryAllByTestId('code-import-error')).toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Adicionar 2 cards' })).toBeTruthy();
  });

  it('shows the errors of an item and leaves it out', async () => {
    const user = userEvent.setup();
    const commit = vi.spyOn(mockClient, 'codeImportCommit');
    const { textarea } = await renderImport(await deckId('ROS 2 — Revisão'));
    const text = `${SPEC_EXAMPLE}\n### Sem resposta\nSó texto, nenhum bloco.\n`;
    fireEvent.change(textarea, { target: { value: text } });
    const list = await items();
    expect(list).toHaveLength(3);
    const bad = list[2]!;
    expect(within(bad).getAllByTestId('code-import-error').length).toBeGreaterThan(0);
    const box = within(bad).getByRole('checkbox') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);

    // Unchecking a good item leaves it out too.
    await user.click(within(list[0]!).getByRole('checkbox'));
    await user.click(await screen.findByRole('button', { name: 'Adicionar 1 card' }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit).toHaveBeenCalledWith(text, await deckId('ROS 2 — Revisão'), [1]);
    expect(await screen.findAllByText('1 card adicionado ao deck ROS 2 — Revisão')).not.toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Ver no Navegar' })).toBeTruthy();
  });

  it('adds both items of the example to the chosen deck', async () => {
    const user = userEvent.setup();
    const commit = vi.spyOn(mockClient, 'codeImportCommit');
    const { textarea } = await renderImport(await deckId('ROS 2 — Revisão'));
    fireEvent.change(textarea, { target: { value: SPEC_EXAMPLE } });
    await items();
    await user.click(await screen.findByRole('button', { name: 'Adicionar 2 cards' }));
    expect(await screen.findAllByText('2 cards adicionados ao deck ROS 2 — Revisão')).not.toHaveLength(0);
    expect(commit).toHaveBeenCalledWith(SPEC_EXAMPLE, await deckId('ROS 2 — Revisão'), [0, 1]);
    // The text is cleared for the next batch.
    expect(textarea.value).toBe('');
  });

  it('reads a .md file and refuses one over 1 MiB', async () => {
    const { textarea } = await renderImport();
    const input = screen.getByTestId('code-import-file') as HTMLInputElement;
    const big = new File(['x'.repeat(1024 * 1024 + 1)], 'grande.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText('O arquivo é grande demais (máximo de 1 MiB).')).toBeTruthy();
    const file = new File([SPEC_EXAMPLE], 'cards.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(textarea.value).toBe(SPEC_EXAMPLE));
    expect(await items()).toHaveLength(2);
  });
});
