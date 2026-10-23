import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { mockClient, mockHandle } from '../../../lib/core/mock';
import { installDomStubs } from '../../../lib/testing/dom';
import { AddPage } from './AddPage';

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  localStorage.clear();
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
