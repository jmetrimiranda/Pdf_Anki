import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BookOpen, FileDown, LayoutGrid, List, Plus, Search, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, EmptyState, Input, Kbd, Notice, SegmentedControl, Skeleton, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core, type BookPatch, type LibraryEntry } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import { useNarrow } from '../../lib/useMediaQuery';
import { leitor } from '../leitor';
import { useShell } from '../shell/context';
import { MoveDialog, RemoveDialog, RenameDialog, type BookDialogState } from './BookDialogs';
import { BookItem, type BookAction, type LibraryView } from './BookItem';
import { collectionsOf, filterBooks, sortBooks, type CollectionFilter } from './filter';
import { errorMessage } from './useBookImport';

const VIEW_KEY = 'leitor.library.view';

function loadView(): LibraryView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function useLibraryView(): [LibraryView, (v: LibraryView) => void] {
  const [view, setView] = useState<LibraryView>(loadView);
  return [
    view,
    (v) => {
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        // Not persisted; fine for this session.
      }
    },
  ];
}

function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-xs transition-colors coarse:h-10',
        selected ? 'border-lime bg-lime-soft font-semibold text-lime-dark' : 'border-line text-muted hover:text-fg',
      )}
    >
      {label}
    </button>
  );
}

function AddHint() {
  return (
    <span className="flex items-center gap-1 text-xs text-muted">
      {t('library.or')} <Kbd>Ctrl</Kbd>
      <Kbd>O</Kbd>
    </span>
  );
}

function DropOverlay() {
  return (
    <div
      data-testid="drop-overlay"
      className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-box border-2 border-dashed border-lime bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] anim-fade"
    >
      <FileDown size={28} strokeWidth={1.6} className="text-lime-dark" aria-hidden />
      <p className="text-md font-semibold">{t('library.dropTitle')}</p>
      <p className="text-xs text-muted">{t('library.dropHint')}</p>
    </div>
  );
}

function LoadingGrid({ view }: { view: LibraryView }) {
  return view === 'grid' ? (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-4" aria-busy>
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex flex-col gap-2 rounded-box border border-line bg-card p-3">
          <Skeleton className="aspect-[3/4] w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </li>
      ))}
    </ul>
  ) : (
    <div className="flex flex-col gap-2" aria-busy>
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

/** Spec 6.6: the library grid/list with search, collections and per-book actions. */
export function LibraryPage() {
  const shell = useShell();
  const toast = useToast();
  const narrow = useNarrow();
  const queryClient = useQueryClient();
  const library = useQuery(q.library());
  const [storedView, setView] = useLibraryView();
  const view: LibraryView = narrow ? 'list' : storedView;
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState<CollectionFilter>(null);
  const [dialog, setDialog] = useState<BookDialogState>(null);

  const books = useMemo(() => sortBooks(library.data ?? []), [library.data]);
  const collections = useMemo(() => collectionsOf(books), [books]);
  const activeCollection = collection !== null && collections.includes(collection) ? collection : null;
  const shown = useMemo(() => filterBooks(books, query, activeCollection), [books, query, activeCollection]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['library'] });

  const navigate = useNavigate();
  const update = useMutation({
    mutationFn: ({ uid, patch }: { uid: string; patch: BookPatch }) => core.libraryUpdate(uid, patch),
    onSuccess: async () => {
      await invalidate();
      setDialog(null);
    },
  });
  const remove = useMutation({
    mutationFn: (book: LibraryEntry) => core.libraryRemove(book.bookUid),
    onSuccess: async (_, book) => {
      await invalidate();
      setDialog(null);
      toast.show(t('library.removed', { titulo: book.title }), { tone: 'success' });
    },
  });

  function closeDialog() {
    update.reset();
    remove.reset();
    setDialog(null);
  }

  async function act(book: LibraryEntry, action: BookAction) {
    try {
      switch (action) {
        case 'open':
          await leitor.openBook(book.bookUid);
          break;
        case 'rename':
        case 'move':
        case 'remove':
          update.reset();
          remove.reset();
          setDialog({ kind: action, book });
          break;
        case 'export': {
          const path = await core.pickExportPath(`${book.title}.pdf`);
          if (!path) return;
          await core.bookExport(book.bookUid, path);
          toast.show(t('library.exported'), { tone: 'success' });
          break;
        }
        case 'openExternal':
          await core.bookOpenExternal(book.bookUid);
          break;
        case 'vocabScan':
          await navigate({ to: '/vocabulario/escanear', search: { livro: book.bookUid } });
          break;
        case 'vocabReport':
          await navigate({ to: '/vocabulario', search: { livro: book.bookUid } });
          break;
      }
    } catch (err) {
      const message =
        action === 'open'
          ? t('library.openFailed', { titulo: book.title, mensagem: errorMessage(err) })
          : t('library.actionFailed', { mensagem: errorMessage(err) });
      toast.show(message, { tone: 'error' });
    }
  }

  const count = books.length === 1 ? t('library.countOne') : t('library.count', { n: books.length });
  const filtering = query.trim() !== '' || activeCollection !== null;

  return (
    <div className="relative h-full overflow-auto">
      {shell.dragging && <DropOverlay />}
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{t('library.title')}</h1>
            {library.data && <p className="text-xs text-muted">{count}</p>}
          </div>
          <Button variant="primary" icon={Plus} onClick={shell.addBooks}>
            {t('library.add')}
          </Button>
        </header>

        {books.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                className="min-w-0 flex-1 sm:max-w-sm"
                type="search"
                aria-label={t('library.search')}
                placeholder={t('library.search')}
                leading={<Search size={14} aria-hidden />}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="flex-1 max-sm:hidden" />
              {!narrow && (
                <SegmentedControl
                  label={t('library.view')}
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'grid', label: t('library.viewGrid'), icon: LayoutGrid },
                    { value: 'list', label: t('library.viewList'), icon: List },
                  ]}
                />
              )}
            </div>
            {collections.length > 0 && (
              <div
                role="group"
                aria-label={t('library.collections')}
                className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]"
              >
                <Chip
                  label={t('library.allCollections')}
                  selected={activeCollection === null}
                  onClick={() => setCollection(null)}
                />
                {collections.map((name) => (
                  <Chip
                    key={name}
                    label={name}
                    selected={activeCollection === name}
                    onClick={() => setCollection(name)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {library.isError && (
          <Notice tone="error" onRetry={() => void library.refetch()}>
            {t('library.loadError')} {errorMessage(library.error)}
          </Notice>
        )}

        {library.isPending && <LoadingGrid view={view} />}

        {library.isSuccess && books.length === 0 && (
          <div className="rounded-box border border-line bg-card">
            <EmptyState
              className="py-16"
              icon={BookOpen}
              title={t('library.empty')}
              description={t('library.emptyHint')}
              action={
                <div className="flex flex-col items-center gap-3">
                  <Button variant="primary" icon={Plus} onClick={shell.addBooks}>
                    {t('library.add')}
                  </Button>
                  <AddHint />
                </div>
              }
            />
          </div>
        )}

        {books.length > 0 && shown.length === 0 && (
          <EmptyState
            icon={SearchX}
            title={t('library.noResults')}
            description={t('library.noResultsHint')}
            action={
              filtering && (
                <Button
                  onClick={() => {
                    setQuery('');
                    setCollection(null);
                  }}
                >
                  {t('library.clearFilters')}
                </Button>
              )
            }
          />
        )}

        {shown.length > 0 &&
          (view === 'grid' ? (
            <ul aria-label={t('library.title')} className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-4">
              {shown.map((book) => (
                <BookItem key={book.bookUid} book={book} view="grid" onAction={(a) => void act(book, a)} />
              ))}
            </ul>
          ) : (
            <ul
              aria-label={t('library.title')}
              className="divide-y divide-line overflow-hidden rounded-box border border-line bg-card"
            >
              {shown.map((book) => (
                <BookItem key={book.bookUid} book={book} view="list" onAction={(a) => void act(book, a)} />
              ))}
            </ul>
          ))}
      </div>

      {dialog?.kind === 'rename' && (
        <RenameDialog
          key={dialog.book.bookUid}
          book={dialog.book}
          sheet={narrow}
          pending={update.isPending}
          error={update.error ? errorMessage(update.error) : undefined}
          onClose={closeDialog}
          onSubmit={(title) => update.mutate({ uid: dialog.book.bookUid, patch: { title } })}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          key={dialog.book.bookUid}
          book={dialog.book}
          collections={collections}
          sheet={narrow}
          pending={update.isPending}
          error={update.error ? errorMessage(update.error) : undefined}
          onClose={closeDialog}
          onSubmit={(folder) => update.mutate({ uid: dialog.book.bookUid, patch: { collectionFolder: folder } })}
        />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveDialog
          book={dialog.book}
          sheet={narrow}
          pending={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : undefined}
          onClose={closeDialog}
          onConfirm={() => remove.mutate(dialog.book)}
        />
      )}
    </div>
  );
}
