// Step 2 "Trecho" (spec 12.1): the whole book (default), outline items (the PDF's bookmarks, including the ones made
// in PdfCraft) or pages (`37`, `21-45`, `21-45, 60, 72-80`). Every choice is checked by the core (`vocab_range_check`),
// whose pt-BR error shows under the field and blocks "Continuar".
import { useQuery } from '@tanstack/react-query';
import { BookmarkX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  SegmentedControl,
  SkeletonLines,
  Tree,
  type TreeNode,
} from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { core } from '../../../lib/core/client';
import type { ResolvedRange, VocabOutlineItem, VocabRangeSpec } from '../../../lib/core/types';
import { useNarrow } from '../../../lib/useMediaQuery';
import { errorMessage } from '../../anki/decks/DeckDialogs';
import { pageCount } from '../model';
import { vocabQ } from '../queries';

export type RangeMode = VocabRangeSpec['kind'];

export function rangeSpec(mode: RangeMode, ids: readonly string[], pages: string): VocabRangeSpec {
  if (mode === 'outline') return { kind: 'outline', ids: [...ids] };
  if (mode === 'pages') return { kind: 'pages', text: pages };
  return { kind: 'all' };
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** "Cap 3 (p. 13–18) · 6 páginas". */
export function resolvedLabel(r: ResolvedRange): string {
  const n = pageCount(r.pages);
  return n === 1
    ? t('vocab.range.resolvedOne', { trecho: r.display })
    : t('vocab.range.resolved', { trecho: r.display, n });
}

function itemPages(it: VocabOutlineItem): string {
  if (it.startPage === null || it.endPage === null) return t('vocab.range.itemNoPage');
  return it.startPage === it.endPage
    ? t('vocab.range.itemPage', { n: it.startPage + 1 })
    : t('vocab.range.itemPages', { de: it.startPage + 1, ate: it.endPage + 1 });
}

function toNodes(items: VocabOutlineItem[]): TreeNode<VocabOutlineItem>[] {
  return items.map((it) => ({ id: it.id, data: it, children: toNodes(it.children) }));
}

function withChildren(items: VocabOutlineItem[], out: string[] = []): string[] {
  for (const it of items) {
    if (it.children.length) out.push(it.id);
    withChildren(it.children, out);
  }
  return out;
}

/** An item is inside a checked one (its id starts with the checked id plus a dot). */
function insideChecked(id: string, checked: ReadonlySet<string>): boolean {
  for (const c of checked) if (id !== c && id.startsWith(`${c}.`)) return true;
  return false;
}

export function RangeStep({
  bookUid,
  pages,
  mode,
  ids,
  pagesText,
  onMode,
  onIds,
  onPagesText,
  onValid,
}: {
  bookUid: string;
  /** The book's page count (for the "Livro inteiro" line). */
  pages: number;
  mode: RangeMode;
  ids: readonly string[];
  pagesText: string;
  onMode: (m: RangeMode) => void;
  onIds: (ids: string[]) => void;
  onPagesText: (s: string) => void;
  /** Whether "Continuar" may go on (the current choice was checked by the core). */
  onValid: (valid: boolean) => void;
}) {
  const narrow = useNarrow();
  const outline = useQuery({ ...vocabQ.outline(bookUid), enabled: mode === 'outline' });
  const spec = useMemo(() => rangeSpec(mode, ids, pagesText), [mode, ids, pagesText]);
  const key = JSON.stringify(spec);
  const debouncedKey = useDebounced(key, mode === 'pages' ? 300 : 0);
  const settled = debouncedKey === key;
  // Nothing to check yet (no item checked, nothing typed): keep the hint, no error before the user types.
  const needsCheck =
    mode !== 'all' && !(mode === 'outline' && ids.length === 0) && !(mode === 'pages' && pagesText.trim() === '');
  const check = useQuery({
    queryKey: ['vocab', 'range', bookUid, debouncedKey],
    queryFn: () => core.vocabRangeCheck(bookUid, JSON.parse(debouncedKey) as VocabRangeSpec),
    enabled: needsCheck,
    retry: false,
    staleTime: Infinity,
  });
  const valid = mode === 'all' || (needsCheck && settled && check.isSuccess);
  useEffect(() => onValid(valid), [valid, onValid]);

  const checked = useMemo(() => new Set(ids), [ids]);
  const nodes = useMemo(() => toNodes(outline.data?.items ?? []), [outline.data]);
  const defaultExpanded = useMemo(() => withChildren(outline.data?.items ?? []), [outline.data]);

  function toggle(id: string, on: boolean) {
    const next = new Set(checked);
    if (on) {
      next.add(id);
      // A checked item includes its children: they don't need their own check.
      for (const c of [...next]) if (c !== id && c.startsWith(`${id}.`)) next.delete(c);
    } else next.delete(id);
    onIds([...next]);
  }

  const resolved = needsCheck && settled && check.isSuccess ? check.data : null;
  const error = needsCheck && settled && check.isError ? errorMessage(check.error) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-md font-semibold">{t('vocab.range.title')}</h2>
        <p className="mt-0.5 text-base text-muted">{t('vocab.range.description')}</p>
      </div>
      <SegmentedControl
        label={t('vocab.range.mode')}
        value={mode}
        onChange={onMode}
        size={narrow ? 'sm' : 'md'}
        className="self-start"
        options={[
          { value: 'all', label: t('vocab.range.all') },
          { value: 'outline', label: t('vocab.range.outline') },
          { value: 'pages', label: t('vocab.range.pages') },
        ]}
      />

      {mode === 'all' && <p className="text-base text-muted">{t('vocab.range.allHint', { n: pages })}</p>}

      {mode === 'outline' && (
        <section className="rounded-box border border-line bg-card p-2">
          {outline.isPending && <SkeletonLines lines={5} className="p-2" />}
          {outline.isError && (
            <Notice tone="error" onRetry={() => void outline.refetch()}>
              {t('vocab.range.loadError')} {errorMessage(outline.error)}
            </Notice>
          )}
          {outline.isSuccess && nodes.length === 0 && (
            <EmptyState
              icon={BookmarkX}
              title={t('vocab.range.noOutline')}
              description={t('vocab.range.noOutlineHint')}
              action={<Button onClick={() => onMode('pages')}>{t('vocab.range.usePages')}</Button>}
            />
          )}
          {nodes.length > 0 && (
            <>
              <p className="px-2 pt-1 pb-2 text-xs text-muted">{t('vocab.range.outlineHint')}</p>
              <Tree
                nodes={nodes}
                label={t('vocab.range.outlineTree')}
                defaultExpanded={defaultExpanded}
                getLabel={(n) => `${n.data.title}, ${itemPages(n.data)}`}
                onActivate={(n) => {
                  if (n.data.startPage !== null && !insideChecked(n.id, checked)) toggle(n.id, !checked.has(n.id));
                }}
                className="max-h-[24rem] overflow-auto"
                renderRow={(n) => {
                  const it = n.data;
                  const noPage = it.startPage === null;
                  const inherited = insideChecked(it.id, checked);
                  const on = checked.has(it.id) || inherited;
                  return (
                    <label
                      className={cn(
                        'flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 pr-2 text-base coarse:min-h-11',
                        (noPage || inherited) && 'cursor-default',
                        noPage && 'text-muted',
                      )}
                      data-testid="vocab-outline-item"
                    >
                      <input
                        type="checkbox"
                        tabIndex={-1}
                        className="size-4 shrink-0 cursor-pointer rounded-[4px] accent-[var(--lime)] disabled:cursor-default"
                        checked={on}
                        disabled={noPage || inherited}
                        onChange={(e) => toggle(it.id, e.currentTarget.checked)}
                        aria-label={it.title}
                      />
                      <span className="min-w-0 flex-1 truncate">{it.title}</span>
                      <span className="shrink-0 text-xs text-muted tabular">
                        {inherited ? t('vocab.range.included') : itemPages(it)}
                      </span>
                    </label>
                  );
                }}
              />
            </>
          )}
        </section>
      )}

      {mode === 'pages' && (
        <Field label={t('vocab.range.pagesLabel')} error={error} hint={error ? undefined : t('vocab.range.pagesHint')}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={pagesText}
              inputMode="numeric"
              autoComplete="off"
              placeholder="21-45, 60, 72-80"
              onChange={(e) => onPagesText(e.target.value)}
              className="max-w-sm"
              data-testid="vocab-range-pages"
            />
          )}
        </Field>
      )}

      {mode !== 'all' && (
        <p className="min-h-5 text-base" aria-live="polite" data-testid="vocab-range-resolved">
          {mode === 'outline' && ids.length === 0 && nodes.length > 0 ? (
            <span className="text-muted">{t('vocab.range.chooseItems')}</span>
          ) : resolved ? (
            <span className="font-semibold">{resolvedLabel(resolved)}</span>
          ) : needsCheck && !error && (!settled || check.isFetching) ? (
            <span className="text-muted">{t('vocab.range.checking')}</span>
          ) : mode === 'outline' && error ? (
            <span className="text-error">{error}</span>
          ) : null}
        </p>
      )}
    </div>
  );
}
