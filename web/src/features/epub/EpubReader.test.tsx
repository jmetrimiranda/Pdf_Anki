import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui';
import { installDomStubs } from '../../lib/testing/dom';
import { EpubReader, type EpubReaderEvents, type EpubReaderHandle } from './index';

beforeAll(() => installDomStubs());

function events(): EpubReaderEvents {
  return {
    onLocation: vi.fn(),
    onActivity: vi.fn(),
    onSelection: vi.fn(),
    onMenu: vi.fn(),
    onVocabClick: vi.fn(),
    onSectionShown: vi.fn(),
    onKey: vi.fn(),
    onError: vi.fn(),
  };
}

describe('EpubReader', () => {
  it('shows a pt-BR error with "Tentar de novo" for an unreadable book, and reports it', async () => {
    const ref = createRef<EpubReaderHandle>();
    const ev = events();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <TooltipProvider>
        <EpubReader ref={ref} events={ev} />
      </TooltipProvider>,
    );
    expect(ref.current?.currentLocation()).toBeNull();
    expect(['light', 'sepia', 'dark']).toContain(ref.current?.theme);
    let error: unknown;
    await act(async () => {
      await ref.current!.open({ uid: 'x', bytes: new TextEncoder().encode('garbage'), title: 'X' }).catch((e) => {
        error = e;
      });
    });
    expect(String(error)).toContain('Não foi possível abrir este EPUB.');
    expect(ev.onError).toHaveBeenCalledWith('Não foi possível abrir este EPUB.');
    expect(await screen.findByText('Não foi possível abrir este EPUB.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(screen.getByTestId('epub-reader').dataset.status).toBe('error');
    // Toolbar actions wait for a book.
    expect((screen.getByTestId('epub-toc-button') as HTMLButtonElement).disabled).toBe(true);
    // Calls on a reader without a book are harmless.
    expect(await ref.current!.goTo({ section: 2 })).toEqual({ found: null });
    ref.current!.setVocabMarks(0, [{ form: 'a', lemma: 'a', status: 'unknown', color: '#d85a30' }]);
    ref.current!.clearVocabMarks();
    ref.current!.openDrawer('toc');
    act(() => ref.current!.close());
    expect(ev.onLocation).not.toHaveBeenCalled();
  });
});
