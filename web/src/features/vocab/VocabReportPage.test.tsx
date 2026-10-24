import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../../lib/core/mock';
import type { VocabRangeSpec, VocabReport } from '../../lib/core/types';
import { installDomStubs } from '../../lib/testing/dom';
import { renderApp } from '../../lib/testing/renderApp';
import { queryClient } from '../../router';
import { followJob } from './queries';

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

async function scanned(range: VocabRangeSpec = { kind: 'all' }): Promise<{ uid: string; report: VocabReport }> {
  const uid = await farmUid();
  const root = (await mockClient.ankiDeckNames()).find((d) => d.name === 'Vocabulário')!.id;
  const config = (await mockClient.vocabSettingsGet()).config;
  const end = await followJob(await mockClient.vocabScanStart(uid, root, [], range, config));
  expect(end.stage).toBe('done');
  return { uid, report: (await mockClient.vocabReport(uid))! };
}

const rows = () => screen.queryAllByTestId('vocab-row');
const lemmas = () => rows().map((r) => r.dataset.lemma);
const row = (lemma: string) => rows().find((r) => r.dataset.lemma === lemma);

async function setFilter(name: string, value: string) {
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
}

describe('Relatório de vocabulário', () => {
  it('suggests scanning when the book was never scanned', async () => {
    const uid = await farmUid();
    const router = await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByText('Vocabulário ainda não escaneado');
    fireEvent.click(screen.getByRole('button', { name: 'Escanear vocabulário' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/vocabulario/escanear'));
  });

  it('shows the header with the range, the offline line, coverage, goals, curve and chapters', async () => {
    const { uid, report } = await scanned({ kind: 'outline', ids: ['2', '3'] });
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Animal Farm — George Orwell');
    expect(screen.getByText(/^escaneado em \d\d\/\d\d\/\d{4} · pasta: Vocabulário \(5 decks\)$/)).toBeTruthy();
    expect(screen.getByTestId('vocab-range').textContent).toBe('Trecho: Cap 3 + Cap 4 (p. 13–24)');
    expect(screen.getByTestId('vocab-offline').textContent).toBe(
      'Detecção offline, sem IA. A IA só preenche Definição e Tradução, se estiver ligada.',
    );
    const pct = (f: number) => `${(Math.floor(f * 1000) / 10).toFixed(1).replace('.', ',')}%`;
    expect(screen.getByTestId('vocab-coverage').textContent).toContain(pct(report.metrics.coverageKnown));
    expect(screen.getByTestId('vocab-coverage').textContent).toContain(pct(report.metrics.coverageWithLearning));
    expect(screen.getByTestId('vocab-goal-98').textContent).toBe(
      `Aprendendo ${report.metrics.wordsTo98} palavras você chega a 98%.`,
    );
    expect(screen.getByRole('img', { name: /^Curva de cobertura/ })).toBeTruthy();
    const chips = within(screen.getByTestId('vocab-chapters'));
    expect(chips.getByText('Cap 3')).toBeTruthy();
    expect(chips.getByText('Cap 4')).toBeTruthy();
    expect(chips.queryByText('Cap 5')).toBeNull();
  });

  it('lists forms apart (unchecked, with the base word), the family column and proper nouns apart', async () => {
    const { uid } = await scanned();
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    await setFilter('Status', 'all');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Mín. ocorrências' }), { target: { value: '1' } });
    await setFilter('Capítulo', '2');
    await waitFor(() => expect(row('learning')).toBeTruthy());
    expect(screen.getByText('Formas de palavras que você sabe (desmarcadas)')).toBeTruthy();
    const learning = row('learning')!;
    expect(learning.textContent).toContain('learning ← learn ✓');
    expect((within(learning).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    const learner = row('learner')!;
    expect(learner.textContent).toContain('learn ✓');
    expect((within(learner).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Nomes próprios')).toBeTruthy();
    expect(row('napoleon')!.textContent).toContain('Napoleon');
    expect(row('napoleon')!.textContent).toContain('nome próprio');
    expect(screen.getByText('Phrasal verbs')).toBeTruthy();
    expect(row('set up')).toBeTruthy();
  });

  it('filters by status, occurrences, chapter and rarity, and sorts', async () => {
    const { uid } = await scanned();
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    await setFilter('Capítulo', '5');
    await waitFor(() => expect(row('windmill')).toBeTruthy());
    expect(lemmas()[0]).toBe('windmill');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ocultar raras' }));
    await waitFor(() => expect(row('windmill')).toBeUndefined());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ocultar raras' }));
    await setFilter('Ordenar por', 'frequency');
    await waitFor(() => expect(lemmas()[0]).not.toBe('windmill'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Mín. ocorrências' }), { target: { value: '15' } });
    await waitFor(() => expect(lemmas()).toEqual(['windmill']));
    await setFilter('Status', 'known');
    await setFilter('Capítulo', '');
    await waitFor(() => expect(lemmas()).toContain('farm'));
    expect(lemmas()).not.toContain('windmill');
  });

  it('"Limpar filtros" also resets the "Mín. ocorrências" field', async () => {
    const { uid } = await scanned();
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    const min = screen.getByRole('spinbutton', { name: 'Mín. ocorrências' }) as HTMLInputElement;
    fireEvent.change(min, { target: { value: '9999' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(min.value).toBe('1');
  });

  it('shows "—", not "0%", for a chapter without counted words', async () => {
    const { uid, report } = await scanned();
    const [first, second, ...rest] = report.chapters;
    const empty = { ...second!, totalTokens: 0, knownTokens: 0, coverageKnown: 0, coverageWithLearning: 0 };
    vi.spyOn(mockClient, 'vocabReport').mockResolvedValue({ ...report, chapters: [first!, empty, ...rest] });
    await renderApp(`/vocabulario?livro=${uid}`);
    const chips = within(await screen.findByTestId('vocab-chapters'));
    const chip = chips.getByLabelText(`${empty.label}: sem palavras contadas`);
    expect(chip.textContent).toBe(`${empty.label}—`);
    expect(chips.getByLabelText(new RegExp(`^${first!.label}: cobertura \\d+%$`))).toBeTruthy();
    // The chapter filter doesn't offer it either.
    const option = within(screen.getByRole('combobox', { name: 'Capítulo' })).getByRole('option', {
      name: `${empty.label} (sem palavras)`,
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('"Selecionar as N para 98%" selects exactly N words', async () => {
    const { uid, report } = await scanned();
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    const n = report.metrics.wordsTo98;
    expect(n).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: `Selecionar as ${n} para 98%` }));
    expect(screen.getByRole('button', { name: `Gerar deck (${n})` })).toBeTruthy();
    expect(screen.getByText(`${n} selecionadas`)).toBeTruthy();
  });

  it('"Já sei" adjusts the words, rescans and updates the statuses', async () => {
    const user = userEvent.setup();
    const { uid } = await scanned();
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    await setFilter('Capítulo', '5');
    await waitFor(() => expect(row('windmill')).toBeTruthy());
    // Select only windmill: the header box clears the whole selection.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas as palavras mostradas' }));
    expect(screen.getByRole('button', { name: 'Gerar deck (0)' })).toBeTruthy();
    fireEvent.click(within(row('windmill')!).getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Gerar deck (1)' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Já sei' }));
    await screen.findByText('Status atualizados.');
    await waitFor(() => expect(row('windmill')).toBeUndefined());
    expect(mockHandle.vocab.overrides).toEqual({ windmill: 'known' });
    const report = (await mockClient.vocabReport(uid))!;
    expect(report.rows.find((r) => r.lemma === 'windmill')!.status).toBe('known');
  });

  it('opens the book at the first occurrence when a row is clicked', async () => {
    const { uid } = await scanned();
    const router = await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    await setFilter('Capítulo', '5');
    await waitFor(() => expect(row('windmill')).toBeTruthy());
    fireEvent.click(within(row('windmill')!).getByRole('button', { name: /^Abrir “windmill” no livro, p\. 25$/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/leitor'));
    expect(router.state.location.search).toMatchObject({ livro: uid, pagina: 25, q: 'windmill' });
  });

  it('generates the deck with the options, the disabled AI hint and the result toast', async () => {
    const user = userEvent.setup();
    const generate = vi.spyOn(mockClient, 'vocabGenerateDeck');
    const { uid, report } = await scanned({ kind: 'outline', ids: ['2'] });
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    const n = report.rows.filter((r) => r.defaultSelected).length;
    await user.click(screen.getByRole('button', { name: `Gerar deck (${n})` }));
    const dialog = await screen.findByRole('dialog', { name: 'Gerar deck' });
    expect(within(dialog).getByTestId('vocab-deck-name').textContent).toBe('Vocabulário::Livros::Animal Farm::Cap 3');
    expect(within(dialog).getByTestId('vocab-deck-tags').textContent).toBe('livro::animal-farmtrecho::cap-3cap::03');
    const ai = within(dialog).getByRole('radio', { name: /IA/ }) as HTMLInputElement;
    expect(ai.disabled).toBe(true);
    expect(within(dialog).getByTestId('ai-state').textContent).toBe('IA desligada: configure em Configurações → IA.');
    expect((within(dialog).getByRole('radio', { name: 'WordNet (offline)' }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByRole('switch', { name: 'Um subdeck por capítulo' }));
    expect(within(dialog).getByTestId('vocab-deck-name').textContent).toBe(
      'Vocabulário::Livros::Animal Farm::Cap 01, Cap 02…',
    );
    await user.click(within(dialog).getByRole('switch', { name: 'Um subdeck por capítulo' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Frequência' }));
    await user.click(within(dialog).getByTestId('vocab-deck-create'));
    await screen.findByText(`${n} cards criados em Vocabulário::Livros::Animal Farm::Cap 3.`);
    expect(generate.mock.calls[0]![3]).toEqual({
      order: 'frequency',
      perChapter: false,
      card2: false,
      enrich: 'wordnet',
    });
    // The report refreshes: the words are now in the book's deck and can't be checked again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gerar deck (0)' })).toBeTruthy());
  });

  it('generates with AI definitions: the estimate, the AI job, then the deck from the cache', async () => {
    const user = userEvent.setup();
    await mockClient.aiSettingsSet({ enrich: { provider: 'anthropic' }, consent: ['anthropic'] });
    await mockClient.aiKeySet('anthropic', 'test-key-TEST');
    const start = vi.spyOn(mockClient, 'aiEnrichStart');
    const generate = vi.spyOn(mockClient, 'vocabGenerateDeck');
    const { uid, report } = await scanned({ kind: 'outline', ids: ['2'] });
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    const n = report.rows.filter((r) => r.defaultSelected).length;
    await user.click(screen.getByRole('button', { name: `Gerar deck (${n})` }));
    const dialog = await screen.findByRole('dialog', { name: 'Gerar deck' });
    await user.click(within(dialog).getByRole('radio', { name: /IA/ }));
    expect((await within(dialog).findByTestId('vocab-ai-estimate')).textContent).toMatch(
      /^Custo máximo estimado: US\$ 0,\d+/,
    );
    await user.click(within(dialog).getByTestId('vocab-deck-create'));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(start).toHaveBeenCalledWith(uid, report.scanUid, expect.any(Array), false);
    expect(generate.mock.calls[0]![3]).toMatchObject({ enrich: 'ai' });
    const result = await generate.mock.results[0]!.value;
    const fields = mockHandle.anki.noteFields(result.noteIds[0]);
    expect(fields['Tradução']).not.toBe('');
  });

  it('offers "Preparar coleção" when the vocabulary notetype is missing', async () => {
    const user = userEvent.setup();
    const { uid } = await scanned({ kind: 'pages', text: '25-30' });
    const nt = (await mockClient.ankiNotetypes()).find((x) => x.name === 'Vocabulário · Livro')!;
    // As in a collection prepared before Phase 6 without this type.
    const { ankiState, persistAnki } = await import('../../lib/core/mock/ankiData');
    const s = ankiState();
    s.notes = s.notes.filter((x) => x.notetypeId !== nt.id);
    s.notetypes = s.notetypes.filter((x) => x.id !== nt.id);
    persistAnki();
    await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    await user.click(screen.getByTestId('vocab-generate'));
    const dialog = await screen.findByRole('dialog', { name: 'Gerar deck' });
    await user.click(within(dialog).getByTestId('vocab-deck-create'));
    await within(dialog).findByText('O tipo de nota “Vocabulário · Livro” ainda não existe nesta coleção.');
    await user.click(within(dialog).getByRole('button', { name: 'Preparar coleção' }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Preparar coleção' })).toBeNull());
    await user.click(within(dialog).getByTestId('vocab-deck-create'));
    await screen.findByText(/cards? criados? em Vocabulário::Livros::Animal Farm::p\. 25-30\./);
  });

  it('EPUB: the range by the TOC and "cap. N" for the first occurrence; a row opens the chapter', async () => {
    const uid = (await mockClient.libraryList()).find((b) => b.format === 'epub')!.bookUid;
    const root = (await mockClient.ankiDeckNames()).find((d) => d.name === 'Vocabulário')!.id;
    const config = (await mockClient.vocabSettingsGet()).config;
    const outline = await mockClient.vocabOutline(uid);
    const third = outline.items[0]!.children[2]!;
    const end = await followJob(
      await mockClient.vocabScanStart(uid, root, [], { kind: 'outline', ids: [third.id] }, config),
    );
    expect(end.stage).toBe('done');
    const router = await renderApp(`/vocabulario?livro=${uid}`);
    await screen.findByTestId('vocab-range');
    expect(screen.getByTestId('vocab-range').textContent).toBe(
      'Trecho: Chapter III. The Time Traveller Returns (cap. 4)',
    );
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(screen.getByRole('columnheader', { name: '1º cap.' })).toBeTruthy();
    const first = rows()[0]!;
    expect(within(first).getByText('cap. 4')).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: /^Abrir “.+” no livro, cap\. 4$/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/leitor'));
    expect(router.state.location.search).toMatchObject({ livro: uid, cap: 4 });
  });
});
