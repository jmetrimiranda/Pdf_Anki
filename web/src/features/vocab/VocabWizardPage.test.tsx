import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { defaultRoot } from './VocabWizardPage';

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
afterEach(() => vi.restoreAllMocks());

async function farmUid(): Promise<string> {
  return (await mockClient.libraryList()).find((b) => b.title === 'Animal Farm')!.bookUid;
}

async function deckId(name: string): Promise<number> {
  return (await mockClient.ankiDeckNames()).find((d) => d.name === name)!.id;
}

async function open(search = '') {
  const uid = await farmUid();
  const router = await renderApp(`/vocabulario/escanear?livro=${uid}${search}`);
  return { uid, router };
}

function footerContinue() {
  const buttons = screen.getAllByRole('button', { name: /^(Continuar|Escanear)$/ });
  return buttons[buttons.length - 1]!;
}

describe('Escanear vocabulário (wizard)', () => {
  it('requires a folder: without "Vocabulário" nothing is chosen and "Continuar" waits for a deck', async () => {
    await mockClient.ankiDeckDelete(await deckId('Vocabulário'));
    await open();
    await screen.findByText('Escolha um deck para continuar.');
    expect(footerContinue()).toHaveProperty('disabled', true);
    fireEvent.click(await screen.findByRole('button', { name: 'Usar Oxford como pasta de vocabulário' }));
    await waitFor(() => expect(footerContinue()).toHaveProperty('disabled', false));
    expect(within(screen.getByTestId('vocab-subdecks')).getByText('Oxford 3000')).toBeTruthy();
  });

  it('defaults to "Vocabulário", lists every subdeck and leaves out the unchecked ones (children too)', async () => {
    const start = vi.spyOn(mockClient, 'vocabScanStart');
    const { uid } = await open();
    const list = await screen.findByTestId('vocab-subdecks');
    await within(list).findByText('Inglês básico');
    expect(
      within(list)
        .getAllByTestId('vocab-subdeck')
        .map((li) => li.textContent),
    ).toEqual([
      'Vocabuláriodeck-pai66 cards',
      'Inglês básico27 cards',
      'Livros66 cards',
      'Teste66 cards',
      'Oxford10 cards',
    ]);
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Vocabulário::Livros' }));
    expect(
      (within(list).getByRole('checkbox', { name: 'Vocabulário::Livros::Teste' }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByText('3 de 5 decks')).toBeTruthy();
    fireEvent.click(footerContinue());
    await screen.findByTestId('vocab-step-trecho');
    fireEvent.click(footerContinue());
    // Campos: both user types have no field yet.
    await screen.findByTestId('vocab-step-campos');
    fireEvent.click(footerContinue());
    await screen.findByTestId('vocab-step-criterio');
    fireEvent.click(footerContinue());
    await waitFor(() => expect(start).toHaveBeenCalled());
    const [book, root, excluded, range] = start.mock.calls[0]!;
    expect(book).toBe(uid);
    expect(root).toBe(await deckId('Vocabulário'));
    expect([...excluded].sort()).toEqual(
      [await deckId('Vocabulário::Livros'), await deckId('Vocabulário::Livros::Teste')].sort(),
    );
    expect(range).toEqual({ kind: 'all' });
    expect(defaultRoot((await mockClient.ankiDeckTree()).decks)).toBe(await deckId('Vocabulário'));
  });

  it('checks the children of an outline item and resolves the range', async () => {
    const user = userEvent.setup();
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    await open('&passo=trecho');
    await screen.findByTestId('vocab-step-trecho');
    await user.click(screen.getByRole('radio', { name: 'Por bookmarks/sumário' }));
    const tree = await screen.findByRole('tree', { name: 'Sumário e bookmarks do livro' });
    expect(footerContinue()).toHaveProperty('disabled', true);
    await user.click(within(tree).getByRole('checkbox', { name: 'Cap 2' }));
    const child = within(tree).getByRole('checkbox', { name: 'A morte do Major' }) as HTMLInputElement;
    expect(child.checked).toBe(true);
    expect(child.disabled).toBe(true);
    expect(within(tree).getAllByText('incluído')).toHaveLength(2);
    expect(within(tree).getByRole('checkbox', { name: 'Notas do editor' })).toHaveProperty('disabled', true);
    await waitFor(() =>
      expect(screen.getByTestId('vocab-range-resolved').textContent).toBe('Cap 2 (p. 7–12) · 6 páginas'),
    );
    expect(footerContinue()).toHaveProperty('disabled', false);
  });

  it('shows the core’s pt-BR errors for bad pages and blocks "Continuar"', async () => {
    const user = userEvent.setup();
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    await open('&passo=trecho');
    await user.click(await screen.findByRole('radio', { name: 'Páginas' }));
    const input = screen.getByTestId('vocab-range-pages');
    for (const [text, error] of [
      ['0', 'As páginas começam em 1.'],
      ['45-21', 'O intervalo 45-21 está invertido. Use 21-45.'],
      ['400', 'A página 400 não existe (o livro tem 60 páginas).'],
      ['abc', '“abc” não é uma página válida. Use números, como 37, 21-45 ou 21-45, 60, 72-80.'],
    ] as const) {
      await user.clear(input);
      await user.type(input, text);
      expect(await screen.findByText(error)).toBeTruthy();
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(footerContinue()).toHaveProperty('disabled', true);
    }
    await user.clear(input);
    await user.type(input, '21-45, 50');
    await waitFor(() =>
      expect(screen.getByTestId('vocab-range-resolved').textContent).toBe('p. 21–45, 50 · 26 páginas'),
    );
    expect(footerContinue()).toHaveProperty('disabled', false);
  });

  it('keeps the pages hint (no error) while nothing is typed', async () => {
    const user = userEvent.setup();
    const check = vi.spyOn(mockClient, 'vocabRangeCheck');
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    await open('&passo=trecho');
    await user.click(await screen.findByRole('radio', { name: 'Páginas' }));
    const input = screen.getByTestId('vocab-range-pages');
    const hint = 'Uma página (37), um intervalo (21-45) ou uma lista (21-45, 60, 72-80).';
    // Past the 300 ms debounce: still the hint.
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByText(hint)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(footerContinue()).toHaveProperty('disabled', true);
    expect(check.mock.calls.some(([, spec]) => spec.kind === 'pages')).toBe(false);
    // Typing then erasing goes back to the hint too.
    await user.type(input, '400');
    expect(await screen.findByText('A página 400 não existe (o livro tem 60 páginas).')).toBeTruthy();
    await user.clear(input);
    await waitFor(() => expect(screen.getByText(hint)).toBeTruthy());
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(footerContinue()).toHaveProperty('disabled', true);
  });

  it('"Campos": skeleton while the folder loads', async () => {
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    const real = mockClient.vocabFolder.bind(mockClient);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const folder = vi.spyOn(mockClient, 'vocabFolder').mockImplementation(async (id) => {
      await gate;
      return real(id);
    });
    await open('&passo=campos');
    expect(await screen.findByTestId('vocab-fields-loading')).toBeTruthy();
    expect(screen.queryByText('A pasta não tem notas.')).toBeNull();
    release();
    expect((await screen.findAllByTestId('vocab-notetype')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('vocab-fields-loading')).toBeNull();
    folder.mockRestore();
  });

  it('"Campos": a folder load error with retry, and a folder without notes', async () => {
    const user = userEvent.setup();
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    const real = mockClient.vocabFolder.bind(mockClient);
    vi.spyOn(mockClient, 'vocabFolder')
      .mockRejectedValueOnce(new Error('falhou'))
      .mockImplementation(async (id) => ({ ...(await real(id)), notetypes: [] }));
    await open('&passo=campos');
    expect(await screen.findByText(/Não foi possível ler os decks da pasta\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    expect(await screen.findByText('A pasta não tem notas.')).toBeTruthy();
  });

  it('refreshes the sample words when another field is chosen, and saves the mapping', async () => {
    const user = userEvent.setup();
    const set = vi.spyOn(mockClient, 'vocabMappingSet');
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    await open('&passo=campos');
    const cards = await screen.findAllByTestId('vocab-notetype');
    const oxford = cards.find((c) => c.textContent?.includes('Oxford (Front/Back)'))!;
    expect(within(oxford).getByTestId('vocab-field-samples').textContent).toBe('abandonabilityreadyordersoon');
    await user.selectOptions(within(oxford).getByTestId('vocab-field-select'), 'Back');
    await waitFor(() =>
      expect(within(oxford).getByTestId('vocab-field-samples').textContent).toBe('abandonarhabilidadeprontoordemlogo'),
    );
    await user.click(footerContinue());
    await screen.findByTestId('vocab-step-criterio');
    const ids = Object.fromEntries((await mockClient.ankiNotetypes()).map((n) => [n.name, n.id]));
    expect(set).toHaveBeenCalledWith(ids['Oxford (Front/Back)'], 'Back');
    expect(set).toHaveBeenCalledWith(ids['Vocab (Word)'], 'Word');
    // "Campos" stays reachable from the stepper.
    expect(screen.getByRole('button', { name: /Campos/ })).toHaveProperty('disabled', false);
  });

  it('opens a deep link past "pasta" only when a folder is saved', async () => {
    await open('&passo=criterio');
    await screen.findByTestId('vocab-step-pasta');
    expect(screen.queryByTestId('vocab-step-criterio')).toBeNull();
  });

  it('runs the scan with progress and opens the report', async () => {
    const user = userEvent.setup();
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    mockHandle.vocab.setMapping('Vocab (Word)', 'Word');
    mockHandle.vocab.setMapping('Oxford (Front/Back)', 'Front');
    const { router } = await open('&passo=criterio');
    await screen.findByTestId('vocab-step-criterio');
    const days = screen.getByTestId('vocab-ivl-days');
    await user.clear(days);
    expect(footerContinue()).toHaveProperty('disabled', true);
    expect(screen.getByText('Use um número de 1 a 3650.')).toBeTruthy();
    await user.type(days, '30');
    await user.click(screen.getByRole('switch', { name: 'Contar cards jovens como conhecidos' }));
    const derived = screen.getByRole('radiogroup', { name: 'Derivadas de palavras conhecidas' });
    await user.click(within(derived).getByRole('radio', { name: 'Contar como conhecidas' }));
    await user.click(footerContinue());
    await waitFor(() => expect(router.state.location.pathname).toBe('/vocabulario'));
    await screen.findByTestId('vocab-range');
    const settings = await mockClient.vocabSettingsGet();
    expect(settings.config).toMatchObject({ knownIvlDays: 30, countYoung: true, derivedPolicy: 'known' });
  });

  it('shows the scan errors in pt-BR (data missing)', async () => {
    mockHandle.vocab.setDataAvailable(false);
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    mockHandle.vocab.setMapping('Vocab (Word)', 'Word');
    mockHandle.vocab.setMapping('Oxford (Front/Back)', 'Front');
    await open('&passo=criterio');
    await screen.findByTestId('vocab-step-criterio');
    fireEvent.click(footerContinue());
    expect(
      await screen.findByText(
        'Não foi possível começar: Os dados de vocabulário não estão instalados. Reinstale o app ou rode scripts/build-wordnet.sh.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Escanear de novo' })).toBeTruthy();
  });

  it('EPUB: ranges by the TOC (children included) and by chapters, in chapter wording', async () => {
    const user = userEvent.setup();
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    const uid = (await mockClient.libraryList()).find((b) => b.format === 'epub')!.bookUid;
    await renderApp(`/vocabulario/escanear?livro=${uid}&passo=trecho`);
    await screen.findByTestId('vocab-step-trecho');
    expect(screen.getByText('O livro todo: 8 capítulos.')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Por sumário' }));
    const tree = await screen.findByRole('tree', { name: 'Sumário do livro' });
    await user.click(within(tree).getByRole('checkbox', { name: 'Part I' }));
    expect(within(tree).getByRole('checkbox', { name: 'Chapter II. The Machine' })).toHaveProperty('checked', true);
    expect(within(tree).getAllByText('incluído')).toHaveLength(3);
    await waitFor(() =>
      expect(screen.getByTestId('vocab-range-resolved').textContent).toBe('Part I (cap. 1–4) · 4 capítulos'),
    );
    await user.click(screen.getByRole('radio', { name: 'Capítulos' }));
    const input = screen.getByTestId('vocab-range-pages');
    await user.type(input, '9');
    expect(await screen.findByText('O capítulo 9 não existe (o livro tem 8 capítulos).')).toBeTruthy();
    await user.clear(input);
    await user.type(input, '2-4');
    await waitFor(() => expect(screen.getByTestId('vocab-range-resolved').textContent).toBe('cap. 2–4 · 3 capítulos'));
    expect(footerContinue()).toHaveProperty('disabled', false);
  });

  it('a scanned book offers "Reconhecer texto" (vocab_needs_ocr)', async () => {
    const user = userEvent.setup();
    await mockClient.vocabSettingsSet({ rootDeckId: await deckId('Vocabulário') });
    mockHandle.vocab.setMapping('Vocab (Word)', 'Word');
    mockHandle.vocab.setMapping('Oxford (Front/Back)', 'Front');
    const uid = (await mockClient.libraryList()).find((b) => !b.hasText)!.bookUid;
    const router = await renderApp(`/vocabulario/escanear?livro=${uid}&passo=criterio`);
    await screen.findByTestId('vocab-step-criterio');
    await user.click(footerContinue());
    expect(
      await screen.findByText('Este livro parece escaneado: reconheça o texto (OCR) antes de escanear o vocabulário.'),
    ).toBeTruthy();
    await user.click(screen.getByTestId('vocab-needs-ocr'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/biblioteca'));
  });
});
