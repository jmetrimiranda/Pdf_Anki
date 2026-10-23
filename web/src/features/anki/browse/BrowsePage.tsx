import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleHelp,
  FolderInput,
  Info,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Shapes,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, IconButton, Input, Menu, Notice, Popover, useToast } from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { core, CoreError } from '../../../lib/core/client';
import type { BrowseOrder, BrowseRow } from '../../../lib/core/types';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { useGo } from '../editor/useGo';
import { NoteEditor } from '../editor/NoteEditor';
import { NoteEditorDialog } from '../editor/NoteEditorDialog';
import { BrowseTable } from './BrowseTable';
import { ConfirmDialog, ForgetDialog, MoveDialog, TagsDialog } from './BulkDialogs';
import { RowPages } from './rowPages';
import { emptySelection, selectedIndexes, type Selection } from './selection';

export const DEFAULT_QUERY = 'deck:current';
const ORDER_KEY = 'leitor.anki.browse.order';
const RECENT_KEY = 'leitor.anki.browse.recent';
const MAX_RECENT = 8;
const ROWS_PER_CALL = 500;

const EXAMPLES: [string, string][] = [
  ['deck:"5000 palavras"', 'anki.browse.help.deck'],
  ['deck:current', 'anki.browse.help.current'],
  ['is:due', 'anki.browse.help.due'],
  ['is:new', 'anki.browse.help.new'],
  ['is:suspended', 'anki.browse.help.suspended'],
  ['tag:livro::animal-farm', 'anki.browse.help.tag'],
  ['note:"Básico (Leitor)"', 'anki.browse.help.note'],
  ['frente:casa', 'anki.browse.help.field'],
  ['casa -deck:Oxford', 'anki.browse.help.not'],
  ['windmill OR moinho', 'anki.browse.help.or'],
  ['added:7', 'anki.browse.help.added'],
  ['rated:1:1', 'anki.browse.help.rated'],
];

function loadOrder(): BrowseOrder {
  try {
    const o = JSON.parse(localStorage.getItem(ORDER_KEY) ?? 'null') as BrowseOrder | null;
    if (o && typeof o.column === 'string' && typeof o.reverse === 'boolean') return o;
  } catch {
    // Corrupt: default order.
  }
  return { column: 'sortField', reverse: false };
}

function loadRecent(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof CoreError || err instanceof Error ? err.message : t('errors.unexpected');
}

type DialogKind = 'move' | 'tags' | 'forget' | 'delete' | 'notetype' | null;

/** "Navegar" (spec 8.2): Anki search, virtualized card table, side note editor and bulk operations. */
export function BrowsePage({ initialQuery }: { initialQuery?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const go = useGo();
  const wide = useMediaQuery('(min-width: 1024px)');
  const [text, setText] = useState(initialQuery ?? DEFAULT_QUERY);
  const [query, setQuery] = useState(initialQuery ?? DEFAULT_QUERY);
  const [order, setOrderState] = useState<BrowseOrder>(loadOrder);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [editNote, setEditNote] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // A new initialQuery (e.g. "Pesquisar no navegador" from an Anki page) runs it.
  useEffect(() => {
    if (initialQuery !== undefined) {
      setText(initialQuery);
      setQuery(initialQuery);
    }
  }, [initialQuery]);

  const search = useQuery({
    queryKey: ['anki', 'search', query, order],
    queryFn: () => core.ankiSearch(query, order),
    staleTime: 0,
    placeholderData: (prev) => prev,
  });

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const pages = useMemo(() => new RowPages([], (ids) => core.ankiBrowseRows(ids), bump), [bump]);
  const ids = search.data;
  const prevIds = useRef<readonly number[]>([]);

  // New result: reset the row cache and keep the selected cards that are still there.
  useEffect(() => {
    if (!ids) return;
    const before = prevIds.current;
    pages.reset(ids);
    prevIds.current = ids;
    const index = new Map(ids.map((id, i) => [id, i]));
    setSelection((sel) => {
      const selected = new Set<number>();
      for (const i of sel.selected) {
        const j = index.get(before[i] ?? -1);
        if (j !== undefined) selected.add(j);
      }
      const remap = (i: number) => (i >= 0 ? (index.get(before[i] ?? -1) ?? -1) : -1);
      const focus = remap(sel.focus);
      return {
        selected,
        focus: focus >= 0 ? focus : selected.size ? Math.min(...selected) : -1,
        anchor: remap(sel.anchor),
      };
    });
    bump();
  }, [ids, pages, bump]);

  useEffect(() => core.onAnkiChanged(() => void qc.invalidateQueries({ queryKey: ['anki'] })), [qc]);

  const count = ids?.length ?? 0;
  const indexes = selectedIndexes(selection);
  const selectedCardIds = indexes.map((i) => pages.idAt(i)).filter((x): x is number => x !== undefined);
  const focusedRow = selection.focus >= 0 ? pages.row(selection.focus) : undefined;
  const focusedNote = focusedRow && focusedRow.noteId > 0 ? focusedRow.noteId : null;
  const loadedSelected = indexes.map((i) => pages.row(i)).filter((r): r is BrowseRow => !!r);
  const allSuspended = loadedSelected.length > 0 && loadedSelected.every((r) => r.suspended);

  /** Note ids of the selection (rows not loaded yet are fetched). */
  const selectedNoteIds = async (): Promise<number[]> => {
    const notes = new Set<number>();
    const missing: number[] = [];
    for (const i of indexes) {
      const r = pages.row(i);
      if (r && r.noteId > 0) notes.add(r.noteId);
      else if (pages.idAt(i) !== undefined) missing.push(pages.idAt(i)!);
    }
    for (let k = 0; k < missing.length; k += ROWS_PER_CALL)
      for (const r of await core.ankiBrowseRows(missing.slice(k, k + ROWS_PER_CALL))) notes.add(r.noteId);
    return [...notes];
  };
  const [noteCount, setNoteCount] = useState(0);

  const run = (q: string) => {
    const trimmed = q.trim();
    setQuery(trimmed);
    setText(trimmed);
    if (trimmed && trimmed !== DEFAULT_QUERY) {
      const next = [trimmed, ...recent.filter((r) => r !== trimmed)].slice(0, MAX_RECENT);
      setRecent(next);
      saveRecent(next);
    }
    // Same query again: search anew (the collection may have changed).
    if (trimmed === query) void search.refetch();
  };

  const setOrder = (o: BrowseOrder) => {
    setOrderState(o);
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(o));
    } catch {
      // Storage unavailable.
    }
  };

  /** Re-reads the loaded rows of a saved note (its sort field may have changed). */
  const refreshNote = (noteId: number) => {
    const indexes: number[] = [];
    for (let i = 0; i < pages.count; i++) if (pages.row(i)?.noteId === noteId) indexes.push(i);
    if (indexes.length) void pages.refresh(indexes);
  };

  const refreshAll = async () => {
    await qc.invalidateQueries({ queryKey: ['anki'] });
    pages.reset(prevIds.current);
    bump();
  };

  const bulk = async (job: () => Promise<string | null>) => {
    try {
      const message = await job();
      setDialog(null);
      await refreshAll();
      if (message) toast.show(message, { tone: 'success' });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const openDialog = async (kind: Exclude<DialogKind, null>) => {
    if (kind === 'tags' || kind === 'delete' || kind === 'notetype') {
      try {
        setNoteCount((await selectedNoteIds()).length);
      } catch (e) {
        toast.show(errorMessage(e), { tone: 'error' });
        return;
      }
    }
    setDialog(kind);
  };

  const openEditor = (i: number) => {
    const row = pages.row(i);
    if (!row || row.noteId <= 0) return;
    if (wide) {
      const field = document.querySelector<HTMLElement>(
        '[data-testid="browse-side"] [role="textbox"], [data-testid="browse-side"] textarea',
      );
      field?.focus();
    } else setEditNote(row.noteId);
  };

  const n = selectedCardIds.length;
  const searchError = search.isError ? errorMessage(search.error) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="anki-browse">
      <h1 className="sr-only">{t('anki.browse.title')}</h1>
      <form
        role="search"
        className="flex items-center gap-2 border-b border-line px-4 py-2.5 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          run(text);
        }}
      >
        <Input
          aria-label={t('anki.browse.search')}
          leading={<Search size={15} aria-hidden />}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('anki.browse.searchPlaceholder')}
          spellCheck={false}
          autoCapitalize="off"
          className="min-w-0 flex-1 font-mono"
        />
        <Popover
          open={helpOpen}
          onOpenChange={setHelpOpen}
          align="end"
          className="w-[min(380px,calc(100vw-24px))] p-0"
          trigger={
            <IconButton icon={CircleHelp} label={t('anki.browse.help.title')} variant="neutral" tooltip={false} />
          }
        >
          <div className="flex max-h-[70vh] flex-col overflow-auto p-3">
            {recent.length > 0 && (
              <section className="mb-3">
                <h2 className="mb-1 text-2xs font-semibold tracking-wide text-muted uppercase">
                  {t('anki.browse.recent')}
                </h2>
                <ul className="flex flex-col">
                  {recent.map((r) => (
                    <li key={r}>
                      <button
                        type="button"
                        onClick={() => {
                          setHelpOpen(false);
                          run(r);
                        }}
                        className="w-full truncate rounded-[5px] px-2 py-1 text-left font-mono text-sm hover:bg-hover"
                      >
                        {r}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <h2 className="mb-1 text-2xs font-semibold tracking-wide text-muted uppercase">
              {t('anki.browse.help.title')}
            </h2>
            <p className="mb-2 text-sm text-muted">{t('anki.browse.help.intro')}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {EXAMPLES.map(([example, key]) => (
                <div key={example} className="contents">
                  <dt>
                    <button
                      type="button"
                      onClick={() => {
                        setHelpOpen(false);
                        run(example);
                      }}
                      className="rounded-[4px] bg-neutral px-1.5 py-0.5 text-left font-mono text-xs hover:bg-active"
                    >
                      {example}
                    </button>
                  </dt>
                  <dd className="self-center text-muted">{t(key as Parameters<typeof t>[0])}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Popover>
        <Button type="submit" variant="neutral" className="hidden sm:inline-flex">
          {t('anki.browse.searchButton')}
        </Button>
      </form>

      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 sm:px-6">
        {n > 0 ? (
          <>
            <span className="text-sm font-semibold tabular-nums" role="status">
              {t(n === 1 ? 'anki.browse.selectedOne' : 'anki.browse.selected', { n })}
            </span>
            <div role="toolbar" aria-label={t('anki.browse.bulk')} className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" icon={FolderInput} onClick={() => void openDialog('move')}>
                {t('anki.browse.move')}
              </Button>
              <Button size="sm" variant="ghost" icon={Tags} onClick={() => void openDialog('tags')}>
                {t('anki.browse.tags')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={allSuspended ? Play : Pause}
                onClick={() =>
                  void bulk(async () => {
                    await core.ankiCardsSuspend(selectedCardIds, !allSuspended);
                    return t(allSuspended ? 'anki.browse.unsuspended' : 'anki.browse.suspended', { n });
                  })
                }
              >
                {allSuspended ? t('anki.browse.unsuspend') : t('anki.browse.suspend')}
              </Button>
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void openDialog('delete')}>
                {t('anki.browse.delete')}
              </Button>
              <Menu
                label={t('anki.browse.more')}
                trigger={<IconButton icon={MoreHorizontal} size="sm" label={t('anki.browse.more')} tooltip={false} />}
                items={[
                  { label: t('anki.browse.forget'), icon: RotateCcw, onSelect: () => void openDialog('forget') },
                  {
                    label: t('anki.browse.changeNotetype'),
                    icon: Shapes,
                    onSelect: () => void openDialog('notetype'),
                  },
                  {
                    label: t('anki.browse.cardInfo'),
                    icon: Info,
                    disabled: selection.focus < 0,
                    onSelect: () => {
                      const cid = pages.idAt(selection.focus);
                      if (cid !== undefined) go(`/anki/info/${cid}`);
                    },
                  },
                  ...(!wide
                    ? [
                        {
                          label: t('anki.browse.editNote'),
                          icon: Pencil,
                          disabled: focusedNote === null,
                          onSelect: () => setEditNote(focusedNote),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
            <span className="flex-1" />
            <IconButton
              icon={X}
              size="sm"
              label={t('anki.browse.clearSelection')}
              onClick={() => setSelection(emptySelection)}
            />
          </>
        ) : (
          <span className="text-sm text-muted tabular-nums" role="status" data-testid="browse-count">
            {search.isPending
              ? t('common.loading')
              : t(count === 1 ? 'anki.browse.countOne' : 'anki.browse.count', { n: count })}
          </span>
        )}
      </div>

      {searchError && (
        <Notice tone="error" className="mx-4 mb-2 sm:mx-6" onDismiss={() => run(DEFAULT_QUERY)}>
          {searchError}
        </Notice>
      )}

      <div className="flex min-h-0 flex-1 border-t border-line">
        {count === 0 && !search.isPending && !searchError ? (
          <EmptyState
            icon={Search}
            title={t('anki.browse.empty')}
            description={t('anki.browse.emptyHint')}
            className="flex-1"
          />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BrowseTable
              pages={pages}
              version={version}
              selection={selection}
              onSelection={setSelection}
              order={order}
              onOrder={setOrder}
              onOpen={openEditor}
              onDelete={() => void openDialog('delete')}
              label={t('anki.browse.table')}
              className={cn('flex-1', search.isFetching && 'opacity-90')}
            />
          </div>
        )}
        {wide && (
          <aside
            aria-label={t('anki.browse.sideEditor')}
            className="flex w-[400px] shrink-0 flex-col overflow-auto border-l border-line px-4 py-3 xl:w-[460px]"
            data-testid="browse-side"
          >
            {focusedNote !== null ? (
              <NoteEditor key={focusedNote} noteId={focusedNote} autosave onSaved={refreshNote} />
            ) : (
              <EmptyState
                icon={Pencil}
                title={t('anki.browse.noFocus')}
                description={t('anki.browse.noFocusHint')}
                className="my-auto"
              />
            )}
          </aside>
        )}
      </div>

      <MoveDialog
        open={dialog === 'move'}
        onOpenChange={(o) => !o && setDialog(null)}
        count={n}
        onMove={(deckId) =>
          bulk(async () => {
            const moved = await core.ankiCardsSetDeck(selectedCardIds, deckId);
            return t(moved === 1 ? 'anki.browse.movedOne' : 'anki.browse.moved', { n: moved });
          })
        }
      />
      <TagsDialog
        open={dialog === 'tags'}
        onOpenChange={(o) => !o && setDialog(null)}
        count={noteCount}
        onApply={(add, remove) =>
          bulk(async () => {
            await core.ankiNotesTags(await selectedNoteIds(), add.join(' '), remove.join(' '));
            return t('anki.browse.tagsDone');
          })
        }
      />
      <ForgetDialog
        open={dialog === 'forget'}
        onOpenChange={(o) => !o && setDialog(null)}
        count={n}
        onForget={(opts) =>
          bulk(async () => {
            await core.ankiCardsForget(selectedCardIds, opts);
            return t(n === 1 ? 'anki.browse.forgottenOne' : 'anki.browse.forgotten', { n });
          })
        }
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t(noteCount === 1 ? 'anki.browse.deleteTitleOne' : 'anki.browse.deleteTitle', { n: noteCount })}
        description={t('anki.browse.deleteDescription')}
        confirmLabel={t('anki.browse.delete')}
        danger
        onConfirm={() =>
          bulk(async () => {
            const deleted = await core.ankiNotesDelete(await selectedNoteIds());
            setSelection(emptySelection);
            return t(deleted === 1 ? 'anki.browse.deletedOne' : 'anki.browse.deleted', { n: deleted });
          })
        }
      />
      <ConfirmDialog
        open={dialog === 'notetype'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('anki.browse.changeNotetypeTitle')}
        description={t('anki.browse.changeNotetypeDescription')}
        confirmLabel={t('anki.browse.changeNotetypeConfirm')}
        onConfirm={async () => {
          try {
            const { notetypeId } = await core.ankiChangeNotetypePrepare(await selectedNoteIds());
            setDialog(null);
            go(`/anki/pagina/change-notetype/${notetypeId}`);
          } catch (e) {
            toast.show(errorMessage(e), { tone: 'error' });
          }
        }}
      />
      <NoteEditorDialog
        noteId={editNote}
        open={editNote !== null}
        onOpenChange={(o) => !o && setEditNote(null)}
        onSaved={refreshNote}
      />
    </div>
  );
}
