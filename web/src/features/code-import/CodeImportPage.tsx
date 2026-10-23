// Markdown batch import of code cards (spec 11.7): paste or open a .md, see a preview with the errors of each item,
// choose the items and the deck, add. The parsing is the core's (`code_import_markdown`), so the preview and the
// commit read the text the same way.
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, FileUp, Plus, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Notice,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import type { ImportItem } from '../../lib/core/types';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { DeckPicker } from '../anki/shared/DeckPicker';
import { readTextFile } from '../settings/AnkiSyncSettings';
import { ItemTest } from './ItemTest';
import { deckSearch, itemBadge, itemExcerpt } from './preview';

/** Bigger files are refused before reading (the core refuses more than 1 MiB too). */
export const MAX_IMPORT_BYTES = 1024 * 1024;
const DEBOUNCE_MS = 300;

export const CODE_APP_TYPES = ['Código · Comando', 'Código · Programa'] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function PreviewItem({
  item,
  checked,
  onChecked,
}: {
  item: ImportItem;
  checked: boolean;
  onChecked: (v: boolean) => void;
}) {
  const blocked = item.errors.length > 0;
  const excerpt = itemExcerpt(item);
  return (
    <li
      className="flex gap-3 py-3 first:pt-0 last:pb-0"
      data-testid="code-import-item"
      aria-label={t('codeImport.item', { n: item.index + 1, titulo: item.title })}
    >
      <div className="pt-0.5">
        <Checkbox
          label={<span className="sr-only">{t('codeImport.include', { titulo: item.title })}</span>}
          checked={checked && !blocked}
          disabled={blocked}
          onChange={(e) => onChecked(e.target.checked)}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-muted tabular-nums">#{item.index + 1}</span>
          <span className="min-w-0 flex-1 truncate text-base font-semibold">{item.title || '—'}</span>
          <Badge tone={item.kind ? 'lime' : 'error'}>{itemBadge(item)}</Badge>
        </div>
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
        {excerpt && (
          <pre className="overflow-hidden rounded-ctl bg-neutral px-2.5 py-1.5 font-mono text-xs leading-normal whitespace-pre text-fg">
            {excerpt}
          </pre>
        )}
        {item.errors.map((e) => (
          <p key={e} className="text-xs text-error" data-testid="code-import-error">
            {e}
          </p>
        ))}
        {item.warnings.map((w) => (
          <p key={w} className="flex items-start gap-1.5 text-xs text-fg" data-testid="code-import-warning">
            <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-(--vocab-learning)" />
            {w}
          </p>
        ))}
        {!blocked && item.kind && <ItemTest item={item} />}
      </div>
    </li>
  );
}

/** Anki tab → Importar → "Cards de código (Markdown)…" (spec 11.7). */
export function CodeImportPage({ deckId: deckProp }: { deckId?: number | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());
  const [deckId, setDeckId] = useState<number | null>(deckProp ?? null);
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<{ n: number; deck: string } | null>(null);
  const [preparing, setPreparing] = useState(false);

  const notetypes = useQuery(q.notetypes());
  const deckNames = useQuery(q.deckNames());
  const defaults = useQuery({
    queryKey: ['anki', 'addDefaults', null],
    queryFn: () => core.ankiAddDefaults(null),
    enabled: deckProp === undefined,
  });
  useEffect(() => {
    if (defaults.data) setDeckId((cur) => cur ?? defaults.data.deckId);
  }, [defaults.data]);

  const debounced = useDebounced(text, DEBOUNCE_MS);
  const preview = useQuery({
    queryKey: ['codeImport', 'preview', debounced],
    queryFn: () => core.codeImportMarkdown(debounced),
    enabled: debounced.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  const data = debounced.trim() ? preview.data : undefined;
  const pending = text !== debounced || (preview.isFetching && !!debounced.trim());

  // A new text: every item starts checked again.
  useEffect(() => setUnchecked(new Set()), [debounced]);

  const items = data?.items ?? [];
  const include = useMemo(
    () => items.filter((i) => i.errors.length === 0 && i.kind && !unchecked.has(i.index)).map((i) => i.index),
    [items, unchecked],
  );
  const okCount = items.filter((i) => i.errors.length === 0 && i.kind).length;
  const missingTypes =
    notetypes.isSuccess && CODE_APP_TYPES.some((name) => !notetypes.data.some((nt) => nt.appType === name));

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileError(null);
    if (file.size > MAX_IMPORT_BYTES) {
      setFileError(t('codeImport.tooLarge'));
      return;
    }
    try {
      setText(await readTextFile(file));
      setDone(null);
    } catch {
      setFileError(t('codeImport.readFailed'));
    }
  }

  async function prepare() {
    setPreparing(true);
    try {
      await core.ankiPrepareCollection();
      await qc.invalidateQueries({ queryKey: ['anki', 'notetypes'] });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setPreparing(false);
    }
  }

  async function add() {
    if (deckId === null || !include.length || adding || pending) return;
    setAdding(true);
    try {
      const r = await core.codeImportCommit(debounced, deckId, include);
      const deck = deckNames.data?.find((d) => d.id === deckId)?.name ?? '';
      const message = r.added === 1 ? t('codeImport.addedOne', { deck }) : t('codeImport.added', { n: r.added, deck });
      toast.show(message, { tone: 'success' });
      setDone({ n: r.added, deck });
      setText('');
      void qc.invalidateQueries({ queryKey: ['anki'] });
    } catch (e) {
      toast.show(t('codeImport.addFailed', { erro: errorMessage(e) }), { tone: 'error' });
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 pt-2 pb-10 sm:px-6" data-testid="code-import">
        <header>
          <h1 className="text-lg font-semibold">{t('codeImport.title')}</h1>
          <p className="text-base text-muted">{t('codeImport.hint')}</p>
        </header>

        {missingTypes && (
          <Notice tone="info">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-0 flex-1">{t('codeImport.missingTypes')}</span>
              <Button size="sm" icon={Wand2} loading={preparing} onClick={() => void prepare()}>
                {t('codeImport.prepare')}
              </Button>
            </div>
          </Notice>
        )}

        {done && (
          <Notice tone="success" onDismiss={() => setDone(null)}>
            <span className="mr-2">
              {done.n === 1
                ? t('codeImport.addedOne', { deck: done.deck })
                : t('codeImport.added', { n: done.n, deck: done.deck })}
            </span>
            <Link
              to="/anki/navegar"
              search={{ busca: deckSearch(done.deck) }}
              className="font-semibold text-link hover:underline"
            >
              {t('codeImport.browse')}
            </Link>
          </Notice>
        )}

        <Card className="flex flex-col gap-2">
          <Field label={t('codeImport.text')} error={fileError}>
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={10}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={t('codeImport.placeholder')}
                value={text}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                className="font-mono text-sm! [tab-size:4]"
                onChange={(e) => {
                  setText(e.target.value);
                  setDone(null);
                }}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              data-testid="code-import-file"
              onChange={(e) => void onFile(e)}
            />
            <Button size="sm" icon={FileUp} onClick={() => fileInput.current?.click()}>
              {t('codeImport.open')}
            </Button>
            {pending && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
                <Spinner /> {t('codeImport.reading')}
              </span>
            )}
          </div>
        </Card>

        <Card
          title={t('codeImport.preview')}
          actions={
            data && (
              <span className="text-xs text-muted">{t('codeImport.count', { n: items.length, ok: okCount })}</span>
            )
          }
        >
          {!debounced.trim() ? (
            <p className="text-base text-muted">{t('codeImport.empty')}</p>
          ) : !data && preview.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : preview.isError ? (
            <Notice tone="error" onRetry={() => void preview.refetch()}>
              {errorMessage(preview.error)}
            </Notice>
          ) : (
            data && (
              <div className="flex flex-col gap-3">
                {data.errors.map((e) => (
                  <Notice key={e} tone="error">
                    {e}
                  </Notice>
                ))}
                {data.warnings.map((w) => (
                  <p key={w} className="flex items-start gap-1.5 text-xs text-fg">
                    <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-(--vocab-learning)" />
                    {w}
                  </p>
                ))}
                {items.length > 0 && (
                  <ul className="flex flex-col divide-y divide-line" aria-label={t('codeImport.preview')}>
                    {items.map((item) => (
                      <PreviewItem
                        key={`${item.index}:${item.title}`}
                        item={item}
                        checked={!unchecked.has(item.index)}
                        onChecked={(v) =>
                          setUnchecked((s) => {
                            const next = new Set(s);
                            if (v) next.delete(item.index);
                            else next.add(item.index);
                            return next;
                          })
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          )}
        </Card>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <DeckPicker label={t('codeImport.deck')} value={deckId} onChange={setDeckId} />
          </div>
          <Button
            variant="primary"
            icon={Plus}
            loading={adding}
            disabled={deckId === null || include.length === 0 || pending || missingTypes}
            onClick={() => void add()}
          >
            {include.length === 1 ? t('codeImport.addOne') : t('codeImport.add', { n: include.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}
