import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { CoreError } from '../../lib/core/types';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { roleCandidates } from './CodeSettings';

vi.mock('../leitor', () => ({
  leitor: { openBook: vi.fn(), togglePanel: vi.fn(), flushSaves: vi.fn(async () => true) },
  LeitorHost: () => null,
  useLeitorState: () => ({ ready: false, activeBookUid: null, openIds: [], panelOpen: true, theme: 'light' }),
}));

const USER_TYPE = 'ROS 2 · Digite o comando';

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  queryClient.clear();
});
afterEach(() => vi.restoreAllMocks());

async function open() {
  const router = await renderApp('/configuracoes/codigo');
  await screen.findByRole('heading', { name: 'Código', level: 2 });
  return router;
}

async function startAssign() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Atribuir a um tipo existente' }));
  const form = screen.getByRole('form', { name: 'Atribuir o papel Comando' });
  const notetypes = await mockClient.ankiNotetypes();
  const id = notetypes.find((n) => n.name === USER_TYPE)!.id;
  await user.selectOptions(within(form).getByRole('combobox', { name: 'Tipo de nota' }), String(id));
  return { user, form, id };
}

describe('Configurações → Código', () => {
  it('offers only the user’s own non-cloze notetypes', async () => {
    const notetypes = await mockClient.ankiNotetypes();
    const names = roleCandidates(notetypes, []).map((n) => n.name);
    expect(names).toContain(USER_TYPE);
    expect(names).not.toContain('Código · Comando');
    expect(names.some((n) => notetypes.find((x) => x.name === n)!.kind === 'cloze')).toBe(false);
  });

  it('assigns the Comando role with the chosen fields, lists it and removes it', async () => {
    const set = vi.spyOn(mockClient, 'codeMappingSet');
    await open();
    expect(await screen.findByText('Nenhum tipo de nota seu tem o papel Comando ainda.')).toBeTruthy();
    const { user, form, id } = await startAssign();
    // Fields preselected by their names.
    expect((within(form).getByTestId('role-question') as HTMLSelectElement).value).toBe('Frente');
    expect((within(form).getByTestId('role-answer') as HTMLSelectElement).value).toBe('Comando');
    expect((within(form).getByTestId('role-notes') as HTMLSelectElement).value).toBe('Explicação');
    expect(
      within(form).getByText('O tipo de nota não é alterado: sem mudança de esquema, sem sincronização completa.'),
    ).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Atribuir papel' }));
    expect(set).toHaveBeenCalledWith(id, { question: 'Frente', answer: 'Comando', notes: 'Explicação' });

    const row = await screen.findByTestId('code-mapping');
    expect(row.textContent).toContain(USER_TYPE);
    expect(row.textContent).toContain('Pergunta: Frente · Resposta: Comando · Observação: Explicação');
    await user.click(within(row).getByRole('button', { name: `Remover o papel Comando de ${USER_TYPE}` }));
    await waitFor(() => expect(set).toHaveBeenLastCalledWith(id, null));
    expect(await screen.findByText('Nenhum tipo de nota seu tem o papel Comando ainda.')).toBeTruthy();
  });

  it('shows validation errors inline: the same field twice, and the core’s refusal', async () => {
    const set = vi.spyOn(mockClient, 'codeMappingSet');
    await open();
    const { user, form } = await startAssign();
    await user.selectOptions(within(form).getByTestId('role-answer'), 'Frente');
    await user.click(within(form).getByRole('button', { name: 'Atribuir papel' }));
    expect(within(form).getByRole('alert').textContent).toBe(
      'A Pergunta, a Resposta e a Observação precisam ser campos diferentes.',
    );
    expect(set).not.toHaveBeenCalled();

    set.mockRejectedValueOnce(new CoreError('invalid_input', 'O tipo de nota não tem o campo Comando.'));
    await user.selectOptions(within(form).getByTestId('role-answer'), 'Comando');
    await user.click(within(form).getByRole('button', { name: 'Atribuir papel' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('O tipo de nota não tem o campo Comando.');
  });

  it('saves the review options through codeSettingsSet', async () => {
    const set = vi.spyOn(mockClient, 'codeSettingsSet');
    await open();
    const user = userEvent.setup();
    const easy = await screen.findByRole('switch', { name: 'Sugerir Fácil quando acertar rápido' });
    expect(easy.getAttribute('aria-checked')).toBe('false');
    await user.click(easy);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ suggestEasy: true }));
    await waitFor(() => expect(easy.getAttribute('aria-checked')).toBe('true'));

    const secs = screen.getByLabelText('Em menos de (segundos)') as HTMLInputElement;
    fireEvent.change(secs, { target: { value: '700' } });
    fireEvent.blur(secs);
    expect(await screen.findByText('Use um número de 1 a 600.')).toBeTruthy();
    fireEvent.change(secs, { target: { value: '20' } });
    fireEvent.blur(secs);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ suggestEasySecs: 20 }));

    await user.click(screen.getByRole('switch', { name: 'Comparar a saída exatamente' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ outputExact: true }));
    await user.click(screen.getByRole('radio', { name: 'Runner' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ cppBackend: 'remote' }));
    expect((await mockClient.codeSettingsGet()).suggestEasySecs).toBe(20);
  });

  it('sends the runner token once and never shows it again', async () => {
    const set = vi.spyOn(mockClient, 'codeSettingsSet');
    await open();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Endereço do runner'), 'https://runner.local.test');
    const token = screen.getByTestId('runner-token') as HTMLInputElement;
    expect(token.type).toBe('password');
    await user.type(token, 'segredo-123');
    await user.click(screen.getByRole('button', { name: 'Salvar runner' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({ runnerUrl: 'https://runner.local.test', runnerToken: 'segredo-123' }),
    );
    expect(await screen.findByText('Token salvo no chaveiro')).toBeTruthy();
    expect(token.value).toBe('');
    expect(document.body.innerHTML).not.toContain('segredo-123');
  });

  it('shows the compiler status and the Python line', async () => {
    vi.spyOn(mockClient, 'codeStatus').mockResolvedValue({
      cpp: { local: { compiler: null, clangFormat: false }, remote: { url: null, tokenSet: false } },
      cppBackend: 'none',
    });
    await open();
    const status = await screen.findByTestId('code-cpp-status');
    expect(status.textContent).toContain('não encontrado');
    expect(status.textContent).toContain('Instale o g++ ou o clang++');
    expect(screen.getByText('Python roda offline no próprio app (Pyodide).')).toBeTruthy();
  });
});
