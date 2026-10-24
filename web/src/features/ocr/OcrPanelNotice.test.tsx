import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, TooltipProvider } from '../../components/ui';
import { mockClient, mockHandle } from '../../lib/core/mock';
import { mockOcrHandle } from '../../lib/core/mock/ocr';
import { installDomStubs } from '../../lib/testing/dom';

const leitorFake = vi.hoisted(() => ({
  flushSaves: vi.fn(async () => true),
  reloadPdfcraftBook: vi.fn(async () => {}),
  refreshVocab: vi.fn(),
}));
vi.mock('../leitor/instance', () => ({ leitor: leitorFake, leitorController: () => leitorFake }));

const { OcrPanelNotice } = await import('./OcrPanelNotice');
const { ocrStore } = await import('./store');

beforeAll(() => installDomStubs());
beforeEach(() => {
  mockHandle.reset();
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => ocrStore.reset());

/** The library is already loaded (as in the Leitor): the notice decides on its first render. */
async function renderNotice(uid: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['library'], await mockClient.libraryList());
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <div data-testid="host">
            <OcrPanelNotice uid={uid} />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const uidOf = (title: string) => mockHandle.books.find((b) => b.title === title)!.bookUid;

describe('OcrPanelNotice', () => {
  it('offers OCR for a scanned PDF and opens the dialog', async () => {
    const user = userEvent.setup();
    await renderNotice(uidOf('Apostila digitalizada'));
    const notice = await screen.findByTestId('ocr-panel-notice');
    expect(notice.textContent).toContain('Este livro parece escaneado.');
    await user.click(within(notice).getByRole('button', { name: 'Reconhecer texto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer texto' });
    expect(dialog.textContent).toContain('lê livros escaneados em inglês');
  });

  it('shows the running job with its progress, then goes away once the text is recognised', async () => {
    const user = userEvent.setup();
    mockOcrHandle.setPageDelay(100);
    await renderNotice(uidOf('Apostila digitalizada'));
    const notice = await screen.findByTestId('ocr-panel-notice');
    await user.click(within(notice).getByRole('button', { name: 'Reconhecer texto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconhecer texto' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reconhecer texto' })).toHaveProperty('disabled', false),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reconhecer texto' }));
    expect(await within(notice).findByTestId('ocr-progress')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('ocr-panel-notice')).toBeNull(), { timeout: 5000 });
    expect(leitorFake.flushSaves).toHaveBeenCalled();
  });

  it('renders nothing for books with text, EPUBs and no book', async () => {
    for (const uid of [uidOf('Animal Farm'), uidOf('The Time Machine'), null]) {
      const { unmount } = await renderNotice(uid);
      expect(screen.getByTestId('host').childElementCount).toBe(0);
      unmount();
    }
  });
});
