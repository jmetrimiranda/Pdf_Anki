import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/ui';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { CoreError, type FullSyncChoice } from '../../lib/core/types';
import { installDomStubs } from '../../lib/testing/dom';
import { FullSyncDialog } from './FullSyncDialog';

const DOWNLOAD = 'Baixar do servidor (recomendado se você revisou em outro aparelho)';
const UPLOAD = 'Enviar deste aparelho';

beforeAll(() => installDomStubs());
beforeEach(async () => {
  mockHandle.reset();
  await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null);
  await new Promise((r) => setTimeout(r, 5));
});
afterEach(() => vi.restoreAllMocks());

function renderDialog(choice: FullSyncChoice) {
  const onClose = vi.fn();
  // The core only runs a full sync the server asked for.
  mockHandle.syncRequireFull(choice);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <FullSyncDialog choice={choice} onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Sincronização completa necessária' });
  return { onClose, dialog };
}

const button = (root: HTMLElement, name: string) =>
  within(root).getByRole('button', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) }) as HTMLButtonElement;

describe('FullSyncDialog', () => {
  it('explains the choice with the exact labels and focuses download', () => {
    const { dialog } = renderDialog({ uploadOk: true, downloadOk: true });
    expect(dialog.textContent).toContain(
      'As mudanças deste aparelho e as do servidor não podem ser juntadas. Escolha qual cópia da coleção fica. A outra será substituída. Um backup da coleção deste aparelho é feito antes, em qualquer das duas opções.',
    );
    expect(button(dialog, DOWNLOAD).textContent).toBe(DOWNLOAD);
    expect(button(dialog, UPLOAD).textContent).toBe(UPLOAD);
    expect(document.activeElement).toBe(button(dialog, DOWNLOAD));
  });

  it('downloads with ankiSyncFull("download") and shows the backup name', async () => {
    const full = vi.spyOn(mockClient, 'ankiSyncFull');
    const { dialog, onClose } = renderDialog({ uploadOk: true, downloadOk: true });
    fireEvent.click(button(dialog, DOWNLOAD));
    expect(full).toHaveBeenCalledWith('download');
    expect(await screen.findByText('Fazendo backup e sincronizando…')).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(
      await screen.findByText(/^Sincronização completa concluída\. Backup: backup-antes-da-sincronizacao-/),
    ).toBeTruthy();
  });

  it('asks again before uploading; Cancelar goes back without uploading', async () => {
    const full = vi.spyOn(mockClient, 'ankiSyncFull');
    const { dialog } = renderDialog({ uploadOk: true, downloadOk: true });
    fireEvent.click(button(dialog, UPLOAD));
    const confirm = await screen.findByRole('dialog', { name: 'Enviar deste aparelho?' });
    expect(confirm.textContent).toContain(
      'Enviar substitui a coleção do servidor e dos outros aparelhos na próxima sincronização deles. Continuar?',
    );
    // The confirmation starts on "Cancelar": Enter there never uploads.
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByRole('dialog', { name: 'Sincronização completa necessária' })).toBeTruthy();
    expect(full).not.toHaveBeenCalled();

    fireEvent.click(button(screen.getByRole('dialog'), UPLOAD));
    const again = await screen.findByRole('dialog', { name: 'Enviar deste aparelho?' });
    fireEvent.click(within(again).getByRole('button', { name: UPLOAD }));
    expect(full).toHaveBeenCalledWith('upload');
  });

  it('never uploads on Enter or Esc', async () => {
    const full = vi.spyOn(mockClient, 'ankiSyncFull');
    const { dialog, onClose } = renderDialog({ uploadOk: true, downloadOk: false });
    // Download unavailable: the focus is on "Agora não".
    expect(document.activeElement).toBe(button(dialog, 'Agora não'));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    fireEvent.click(button(dialog, UPLOAD));
    const confirm = await screen.findByRole('dialog', { name: 'Enviar deste aparelho?' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(await screen.findByRole('dialog', { name: 'Sincronização completa necessária' })).toBeTruthy();
    expect(full).not.toHaveBeenCalled();
  });

  it('disables a direction that is not possible, with the reason', () => {
    const { dialog } = renderDialog({ uploadOk: false, downloadOk: true });
    expect(button(dialog, UPLOAD).disabled).toBe(true);
    expect(dialog.textContent).toContain('A coleção deste aparelho está vazia.');
    expect(button(dialog, DOWNLOAD).disabled).toBe(false);
  });

  it('disables download when the server has no collection', () => {
    const { dialog } = renderDialog({ uploadOk: true, downloadOk: false });
    expect(button(dialog, DOWNLOAD).disabled).toBe(true);
    expect(button(dialog, DOWNLOAD).getAttribute('aria-describedby')).toBeTruthy();
    expect(dialog.textContent).toContain('O servidor ainda não tem uma coleção.');
  });

  it('shows the core error and stays open', async () => {
    vi.spyOn(mockClient, 'ankiSyncFull').mockRejectedValue(new CoreError('anki_sync_offline', 'Sem conexão.'));
    const { dialog, onClose } = renderDialog({ uploadOk: true, downloadOk: true });
    await act(async () => {
      fireEvent.click(button(dialog, DOWNLOAD));
    });
    expect(await screen.findByText('A sincronização completa não deu certo: Sem conexão.')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
