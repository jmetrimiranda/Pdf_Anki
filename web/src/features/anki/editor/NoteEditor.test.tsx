import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../../components/ui';
import { mockClient, mockHandle } from '../../../lib/core/mock';
import { installDomStubs } from '../../../lib/testing/dom';
import { runCodeCheck } from '../../code-review/run';
import { outcome } from './codeTesting';
import { NoteEditor } from './NoteEditor';

vi.mock('../../../components/code/CodeEditor', async () => (await import('./codeTesting')).fakeCodeEditorModule);
vi.mock('../../code-review/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../code-review/run')>()),
  runCodeCheck: vi.fn(),
}));
const check = vi.mocked(runCodeCheck);

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  check.mockReset();
  check.mockResolvedValue(outcome('correct', { modeUsed: 'command' }));
});

async function commandNoteId(): Promise<number> {
  const cards = await mockClient.ankiSearch('Listar os tópicos ativos', null);
  const [row] = await mockClient.ankiBrowseRows(cards.slice(0, 1));
  return row!.noteId;
}

function renderEditor(noteId: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <NoteEditor noteId={noteId} autosave />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const saveButton = () => screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
const updates = () => mockHandle.anki.logs.filter((l) => l.kind === 'updateNote');

describe('NoteEditor · code notes (spec 11.7)', () => {
  it('saves a Pergunta edit without the test', async () => {
    const user = userEvent.setup();
    renderEditor(await commandNoteId());
    const question = await screen.findByRole('textbox', { name: 'Pergunta' });
    await user.click(question);
    await user.keyboard(' agora');
    expect(screen.queryByRole('button', { name: 'Testar resposta de referência' })).toBeNull();
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await user.click(saveButton());
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(check).not.toHaveBeenCalled();
  });

  it('blocks saving a changed Resposta until the reference passes', async () => {
    const user = userEvent.setup();
    renderEditor(await commandNoteId());
    const answer = await screen.findByRole('textbox', { name: 'Resposta' });
    await user.type(answer, ' -t');
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(screen.getByText('Teste a resposta de referência antes de salvar.')).toBeTruthy();
    // Leaving the editor does not save it either.
    await user.click(document.body);
    expect(updates()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Testar resposta de referência' }));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ answer: 'ros2 topic list -t' }),
      'ros2 topic list -t',
      expect.anything(),
    );
    await user.click(saveButton());
    await waitFor(() => expect(updates()).toHaveLength(1));
    // Saved: the test block goes away until the next code change.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Testar resposta de referência' })).toBeNull());
  });
});

describe('NoteEditor · a user type with the Comando role (spec 11.1, code_note_extra)', () => {
  async function rosNote() {
    const nt = (await mockClient.ankiNotetypes()).find((n) => n.name === 'ROS 2 · Digite o comando')!;
    const rows = await mockClient.ankiBrowseRows(await mockClient.ankiSearch('', null));
    const noteId = rows.map((r) => r.noteId).find((id) => 'Comando' in mockHandle.anki.noteFields(id))!;
    return { nt, noteId };
  }

  it('has no Aceitas/Exige editor without the role', async () => {
    const { noteId } = await rosNote();
    renderEditor(noteId);
    await screen.findByTestId('note-editor');
    await screen.findAllByRole('textbox');
    expect(screen.queryByTestId('code-extra')).toBeNull();
  });

  it('edits the extra accepted answers and Exige, saved to code_note_extra with the note', async () => {
    const { nt, noteId } = await rosNote();
    await mockClient.codeMappingSet(nt.id, { question: 'Frente', answer: 'Comando', notes: 'Explicação' });
    await mockClient.codeNoteExtraSet(noteId, ['ros2 topic list -t'], []);
    const user = userEvent.setup();
    renderEditor(noteId);
    const accepted = (await screen.findByRole('textbox', { name: 'Outras respostas aceitas' })) as HTMLTextAreaElement;
    expect(accepted.value).toBe('ros2 topic list -t');
    const requires = screen.getByRole('textbox', { name: 'Exige' }) as HTMLTextAreaElement;
    expect(saveButton().disabled).toBe(true);
    await user.clear(accepted);
    await user.type(accepted, '  ros2 topic list --show-types  {Enter}{Enter}');
    await user.type(requires, 'sudo');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await user.click(saveButton());
    await waitFor(async () =>
      expect(await mockClient.codeNoteExtraGet(noteId)).toEqual({
        noteId,
        accepted: ['ros2 topic list --show-types'],
        requires: ['sudo'],
      }),
    );
    // Only the extra changed: the note itself is not rewritten.
    expect(updates()).toHaveLength(0);
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });
});
