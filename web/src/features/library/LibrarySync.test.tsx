// A book that came from another PC (spec 16): the library offers "Baixar", and opening it downloads first.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_LIBRARY_PASSWORD, mockClient, mockHandle } from '../../lib/core/mock';
import { installDomStubs } from '../../lib/testing/dom';
import { renderLibrary } from './testing';

const leitorMock = vi.hoisted(() => ({
  openBook: vi.fn(async (_uid: string) => true),
  togglePanel: vi.fn(),
  flushSaves: vi.fn(async () => true),
}));
vi.mock('../leitor', () => ({ leitor: leitorMock, LeitorHost: () => null }));

beforeAll(() => installDomStubs());
beforeEach(async () => {
  mockHandle.reset();
  localStorage.clear();
  leitorMock.openBook.mockClear();
  await mockClient.librarySyncLogin('https://leitor-sync.example.com', 'jorge', MOCK_LIBRARY_PASSWORD, 'PC B');
});

describe('library sync in the library', () => {
  it('"Baixar" brings the file of a book from another PC', async () => {
    const user = userEvent.setup();
    const farm = mockHandle.books.find((b) => b.title === 'Animal Farm')!;
    mockHandle.libraryRemoteOnly(farm.bookUid);
    const download = vi.spyOn(mockClient, 'libraryDownload');
    await renderLibrary();
    const item = (await screen.findAllByTestId('book')).find((el) => el.dataset.bookUid === farm.bookUid)!;
    await user.click(within(item).getByTestId('book-download'));
    await waitFor(() => expect(download).toHaveBeenCalledWith(farm.bookUid));
    await waitFor(() => expect(within(item).queryByTestId('book-download')).toBeNull());
    expect(mockHandle.books.find((b) => b.bookUid === farm.bookUid)!.localHash).toBe(farm.fileHash);
    expect(leitorMock.openBook).not.toHaveBeenCalled();
  });

  it('opening a book that is only on the server downloads it first', async () => {
    const user = userEvent.setup();
    const farm = mockHandle.books.find((b) => b.title === 'Animal Farm')!;
    mockHandle.libraryRemoteOnly(farm.bookUid);
    const download = vi.spyOn(mockClient, 'libraryDownload');
    await renderLibrary();
    const item = (await screen.findAllByTestId('book')).find((el) => el.dataset.bookUid === farm.bookUid)!;
    await user.click(within(item).getAllByRole('button')[0]!);
    await waitFor(() => expect(leitorMock.openBook).toHaveBeenCalledWith(farm.bookUid));
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.invocationCallOrder[0]!).toBeLessThan(leitorMock.openBook.mock.invocationCallOrder[0]!);
  });
});
