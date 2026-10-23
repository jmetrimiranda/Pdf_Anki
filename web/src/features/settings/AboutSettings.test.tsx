import { screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { sourceDetail } from './AboutSettings';

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

function credit(name: string): HTMLElement {
  return screen.getAllByTestId('about-credit').find((li) => li.textContent?.startsWith(name))!;
}

describe('Configurações → Sobre', () => {
  it('shows the version and the credits with their licences', async () => {
    await renderApp('/configuracoes/sobre');
    await screen.findByRole('heading', { name: 'Sobre', level: 2 });
    expect(screen.getByTestId('about-version').textContent).toMatch(/^Versão \d+\.\d+\.\d+/);
    await screen.findAllByTestId('about-credit');
    expect(within(credit('Open English WordNet')).getAllByText(/CC.BY.4\.0/).length).toBeGreaterThan(0);
    expect(within(credit('Modelos de OCR (ocrs)')).getByText('CC BY-SA 4.0')).toBeTruthy();
    expect(within(credit('Anki')).getByText('AGPL-3.0')).toBeTruthy();
    expect(within(credit('PdfCraft')).getByText('MIT / Apache-2.0')).toBeTruthy();
    expect(within(credit('Pyodide')).getByText('MPL-2.0')).toBeTruthy();
    expect(within(credit('CodeMirror')).getByText('MIT')).toBeTruthy();
    expect(within(credit('Lista de frequência do inglês')).getByText('CC-BY-SA-4.0')).toBeTruthy();
    expect(within(credit('Palavras funcionais do inglês')).getByText('BSD-3-Clause')).toBeTruthy();
    expect(screen.queryByText('Dados de vocabulário não instalados')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sobre' }).getAttribute('aria-current')).toBe('page');
  });

  it('says when the vocabulary data is not installed', async () => {
    mockHandle.vocab.setDataAvailable(false);
    await renderApp('/configuracoes/sobre');
    expect((await screen.findAllByText('Dados de vocabulário não instalados')).length).toBe(3);
  });

  it('names the pinned source', () => {
    expect(sourceDetail({ name: 'wordfreq', version: '3.1.1', license: 'CC-BY-SA-4.0', url: null })).toBe(
      'wordfreq 3.1.1',
    );
    expect(sourceDetail({ name: 'Snowball', version: 'dc14fb462784e5bd', license: 'BSD-3-Clause', url: null })).toBe(
      'Snowball dc14fb4',
    );
    expect(sourceDetail(null)).toBeNull();
  });
});
