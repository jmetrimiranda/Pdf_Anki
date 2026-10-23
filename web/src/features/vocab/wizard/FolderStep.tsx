// Step 1 "Pasta" (spec 12.1): the parent deck of the user's vocabulary (mandatory) and the subdecks it brings in,
// each one with its card count and a checkbox to leave it out.
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Circle, FolderTree } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Checkbox,
  EmptyState,
  Notice,
  Skeleton,
  SkeletonLines,
  Tree,
  type TreeNode,
} from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { q } from '../../../lib/core/queries';
import type { DeckNode, VocabFolder } from '../../../lib/core/types';
import { errorMessage } from '../../anki/decks/DeckDialogs';
import { vocabQ } from '../queries';

function toNodes(decks: DeckNode[]): TreeNode<DeckNode>[] {
  return decks.filter((d) => !d.filtered).map((d) => ({ id: String(d.id), data: d, children: toNodes(d.children) }));
}

/** Ids of the decks on the way to `id` (to open the tree at the chosen deck). */
function pathTo(decks: DeckNode[], id: number, trail: string[] = []): string[] | null {
  for (const d of decks) {
    if (d.id === id) return trail;
    const found = pathTo(d.children, id, [...trail, String(d.id)]);
    if (found) return found;
  }
  return null;
}

function cardsLabel(n: number): string {
  return n === 1 ? t('vocab.folder.cardsOne') : t('vocab.folder.cards', { n });
}

/** The decks under `deckName` in the folder list (its subtree, itself excluded). */
function descendants(folder: VocabFolder, deckName: string): number[] {
  const prefix = `${deckName}::`;
  return folder.decks.filter((d) => d.name.startsWith(prefix)).map((d) => d.deckId);
}

export function FolderStep({
  rootId,
  excluded,
  onRoot,
  onExcluded,
}: {
  rootId: number | null;
  excluded: ReadonlySet<number>;
  onRoot: (id: number) => void;
  onExcluded: (next: Set<number>) => void;
}) {
  const tree = useQuery(q.deckTree());
  const folder = useQuery({ ...vocabQ.folder(rootId ?? 0), enabled: rootId !== null });
  const nodes = useMemo(() => toNodes(tree.data?.decks ?? []), [tree.data]);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const openIds = useMemo(() => {
    if (expanded) return expanded;
    const path = rootId !== null && tree.data ? pathTo(tree.data.decks, rootId) : null;
    return new Set(path ?? []);
  }, [expanded, rootId, tree.data]);

  function toggle(deckId: number, name: string, include: boolean) {
    if (!folder.data) return;
    const next = new Set(excluded);
    for (const id of [deckId, ...descendants(folder.data, name)]) {
      if (include) next.delete(id);
      else next.add(id);
    }
    onExcluded(next);
  }

  // The chosen deck in view (the default "Vocabulário" is often near the end of the list).
  const treeBox = useRef<HTMLElement>(null);
  const hasTree = nodes.length > 0;
  useEffect(() => {
    if (!hasTree) return;
    const row = treeBox.current?.querySelector('[aria-pressed="true"]');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [hasTree, rootId]);

  const subdecks = folder.data?.decks ?? [];
  const included = subdecks.filter((d) => !excluded.has(d.deckId)).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-md font-semibold">{t('vocab.folder.title')}</h2>
        <p className="mt-0.5 text-base text-muted">{t('vocab.folder.description')}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section
          ref={treeBox}
          className="min-w-0 rounded-box border border-line bg-card p-2"
          aria-label={t('vocab.folder.tree')}
        >
          {tree.isPending && <SkeletonLines lines={6} className="p-2" />}
          {tree.isError && <Notice tone="error">{errorMessage(tree.error)}</Notice>}
          {tree.isSuccess && nodes.length === 0 && (
            <EmptyState icon={FolderTree} title={t('vocab.folder.emptyCollection')} />
          )}
          {nodes.length > 0 && (
            <Tree
              nodes={nodes}
              label={t('vocab.folder.tree')}
              expanded={openIds}
              onExpandedChange={setExpanded}
              onActivate={(n) => onRoot(n.data.id)}
              getLabel={(n) => n.data.name}
              className="max-h-[22rem] overflow-auto"
              renderRow={(n) => {
                const chosen = n.data.id === rootId;
                return (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('vocab.folder.choose', { nome: n.data.fullName })}
                    aria-pressed={chosen}
                    onClick={() => onRoot(n.data.id)}
                    className={cn(
                      'flex h-8 w-full min-w-0 items-center gap-2 rounded-ctl pr-2 text-left text-base coarse:h-11',
                      chosen && 'bg-lime-soft font-semibold text-lime-dark',
                    )}
                    data-testid="vocab-folder-deck"
                  >
                    {chosen ? (
                      <CircleCheck size={15} aria-hidden className="shrink-0" />
                    ) : (
                      <Circle size={15} aria-hidden className="shrink-0 text-muted" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{n.data.name}</span>
                    <span className="shrink-0 text-xs font-normal text-muted tabular">{n.data.total}</span>
                  </button>
                );
              }}
            />
          )}
        </section>

        <section className="min-w-0 rounded-box border border-line bg-card p-3" aria-labelledby="vocab-subdecks">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 id="vocab-subdecks" className="text-base font-semibold">
              {t('vocab.folder.subdecks')}
            </h3>
            {folder.data && (
              <span className="text-xs text-muted tabular">
                {t('vocab.folder.subdecksCount', { n: included, total: subdecks.length })}
              </span>
            )}
          </div>
          {rootId === null && <p className="py-6 text-center text-base text-muted">{t('vocab.folder.none')}</p>}
          {rootId !== null && folder.isPending && <Skeleton className="h-24" />}
          {folder.isError && (
            <Notice tone="error" onRetry={() => void folder.refetch()}>
              {t('vocab.folder.loadError')} {errorMessage(folder.error)}
            </Notice>
          )}
          {folder.data && (
            <ul className="flex max-h-[22rem] flex-col overflow-auto" data-testid="vocab-subdecks">
              {folder.data.decks.map((d) => {
                const leaf = d.name.split('::').pop() ?? d.name;
                const parentExcluded = folder.data.decks.some(
                  (p) => p.deckId !== d.deckId && d.name.startsWith(`${p.name}::`) && excluded.has(p.deckId),
                );
                return (
                  <li
                    key={d.deckId}
                    className="flex min-h-8 items-center gap-2"
                    style={{ paddingLeft: d.depth * 18 }}
                    data-testid="vocab-subdeck"
                  >
                    {d.depth === 0 ? (
                      <span className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold">
                        <span className="truncate">{leaf}</span>
                        <Badge tone="lime">{t('vocab.folder.root')}</Badge>
                      </span>
                    ) : (
                      <Checkbox
                        className="min-w-0 flex-1"
                        label={<span className="truncate">{leaf}</span>}
                        checked={!excluded.has(d.deckId)}
                        disabled={parentExcluded}
                        onChange={(e) => toggle(d.deckId, d.name, e.currentTarget.checked)}
                        aria-label={d.name}
                      />
                    )}
                    <span className="shrink-0 text-xs text-muted tabular">{cardsLabel(d.cardCount)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <p className="text-xs text-muted">{t('vocab.folder.saved')}</p>
    </div>
  );
}
