import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { followJob } from '../vocab/queries';

vi.mock('../leitor', () => ({
  leitor: { openBook: vi.fn(), togglePanel: vi.fn(), flushSaves: vi.fn(async () => true) },
  LeitorHost: () => null,
  useLeitorState: () => ({ ready: false, activeBookUid: null, openIds: [], panelOpen: true, theme: 'light' }),
}));

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  queryClient.clear();
});

describe('Biblioteca → vocabulário (spec 12)', () => {
  it('offers "Escanear vocabulário" and, once scanned, "Relatório de vocabulário"', async () => {
    const user = userEvent.setup();
    const router = await renderApp('/biblioteca');
    await user.click(await screen.findByRole('button', { name: 'Ações do livro Animal Farm' }));
    await screen.findByRole('menuitem', { name: 'Escanear vocabulário' });
    expect(screen.queryByRole('menuitem', { name: 'Relatório de vocabulário' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Escanear vocabulário' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/vocabulario/escanear'));
    // The Biblioteca tab stays selected on the vocabulary screens.
    expect(screen.getByRole('link', { name: 'Biblioteca' }).getAttribute('aria-current')).toBe('page');

    const farm = (await mockClient.libraryList()).find((b) => b.title === 'Animal Farm')!;
    const root = (await mockClient.ankiDeckNames()).find((d) => d.name === 'Vocabulário')!.id;
    await followJob(
      await mockClient.vocabScanStart(
        farm.bookUid,
        root,
        [],
        { kind: 'all' },
        (await mockClient.vocabSettingsGet()).config,
      ),
    );
    // What the wizard does when its scan ends: the library entry now says "scanned".
    await queryClient.invalidateQueries({ queryKey: ['library'] });
    await router.navigate({ to: '/biblioteca' });
    await user.click(await screen.findByRole('button', { name: 'Ações do livro Animal Farm' }));
    // Complete as soon as it opens (no item appearing later).
    expect(screen.getByRole('menuitem', { name: 'Relatório de vocabulário' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Relatório de vocabulário' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/vocabulario'));
    expect(router.state.location.search).toEqual({ livro: farm.bookUid });
  });

  it('has no vocabulary entries for a scanned (image-only) book', async () => {
    const user = userEvent.setup();
    await renderApp('/biblioteca');
    await user.click(await screen.findByRole('button', { name: 'Ações do livro Apostila digitalizada' }));
    await screen.findByRole('menuitem', { name: 'Abrir' });
    expect(screen.queryByRole('menuitem', { name: 'Escanear vocabulário' })).toBeNull();
  });
});
