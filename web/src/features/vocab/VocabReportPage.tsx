// "Relatório de vocabulário" (spec 12.4, 12.5): the book's last scan — header with the range, the fixed offline line,
// coverage and goals with the curve, chapters, the filtered word table and the actions (select the words for 98%,
// "Já sei", "Ignorar", "Nome próprio", "Gerar deck").
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, EyeOff, Layers, RefreshCw, ScanText, Search, ShieldCheck, Target, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Input,
  Notice,
  Select,
  Skeleton,
  Spinner,
  Toolbar,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import type { VocabDeckResult, VocabOverride, VocabReport, VocabRow } from '../../lib/core/types';
import { useNarrow } from '../../lib/useMediaQuery';
import { errorMessage } from '../anki/decks/DeckDialogs';
import {
  DEFAULT_FILTERS,
  defaultSelection,
  formatDate,
  formatPct,
  formatPct0,
  goalSelection,
  selectable,
  tableItems,
  type ReportFilters,
  type SortKey,
  type StatusFilter,
} from './model';
import { followJob, vocabQ } from './queries';
import { q } from '../../lib/core/queries';
import { CoverageCurve } from './report/CoverageCurve';
import { GenerateDeckDialog } from './report/GenerateDeckDialog';
import { ReportTable } from './report/ReportTable';
import { BookHeader, VocabPage } from './VocabPage';

export function VocabReportPage({ bookUid }: { bookUid: string | undefined }) {
  const navigate = useNavigate();
  const report = useQuery({ ...vocabQ.report(bookUid ?? ''), enabled: !!bookUid });
  const scan = () => void navigate({ to: '/vocabulario/escanear', search: { livro: bookUid } });

  if (!bookUid) {
    return (
      <VocabPage>
        <EmptyState
          icon={ScanText}
          title={t('vocab.noBook')}
          description={t('vocab.noBookHint')}
          action={<Button onClick={() => void navigate({ to: '/biblioteca' })}>{t('vocab.openLibrary')}</Button>}
        />
      </VocabPage>
    );
  }
  if (report.isPending) {
    return (
      <VocabPage wide>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-36" rounded="box" />
        <Skeleton className="h-72" rounded="box" />
      </VocabPage>
    );
  }
  if (report.isError) {
    return (
      <VocabPage wide>
        <Notice tone="error" onRetry={() => void report.refetch()}>
          {t('vocab.loadError')} {errorMessage(report.error)}
        </Notice>
      </VocabPage>
    );
  }
  if (!report.data) {
    return (
      <VocabPage>
        <BookHeader
          title={t('vocab.report.title')}
          back={{ label: t('vocab.backToLibrary'), onClick: () => void navigate({ to: '/biblioteca' }) }}
        />
        <div className="rounded-box border border-line bg-card">
          <EmptyState
            className="py-14"
            icon={ScanText}
            title={t('vocab.report.empty')}
            description={t('vocab.report.emptyHint')}
            action={
              <Button variant="primary" icon={ScanText} onClick={scan}>
                {t('vocab.report.scan')}
              </Button>
            }
          />
        </div>
      </VocabPage>
    );
  }
  return <Report report={report.data} />;
}

function Metrics({ report }: { report: VocabReport }) {
  const m = report.metrics;
  const goalLine = (goal: number, n: number) =>
    m.coverageWithLearning + 1e-9 >= goal
      ? t('vocab.report.atGoal', { meta: formatPct0(goal) })
      : n === 1
        ? t('vocab.report.toGoalOne', { meta: formatPct0(goal) })
        : t('vocab.report.toGoal', { n, meta: formatPct0(goal) });
  return (
    <section
      className="grid gap-4 rounded-box border border-line bg-card p-4 md:grid-cols-[1fr_auto]"
      aria-label={t('vocab.report.coverageNow')}
      data-testid="vocab-metrics"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <dl className="grid grid-cols-3 gap-3" data-testid="vocab-coverage">
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t('vocab.report.coverageNow')}</dt>
            <dd className="text-xl font-semibold tabular">{formatPct(m.coverageKnown)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted first-letter:uppercase">{t('vocab.report.coverageLearning')}</dt>
            <dd className="text-xl font-semibold tabular">{formatPct(m.coverageWithLearning)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted first-letter:uppercase">{t('vocab.report.goal')}</dt>
            <dd className="text-xl font-semibold text-muted tabular">98%</dd>
          </div>
        </dl>
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold" data-testid="vocab-goal-98">
            {goalLine(0.98, m.wordsTo98)}
          </p>
          <p className="text-muted" data-testid="vocab-goal-95">
            {goalLine(0.95, m.wordsTo95)}
          </p>
        </div>
        <p className="text-xs text-muted">
          {t('vocab.report.tokens', {
            n: m.totalTokens.toLocaleString('pt-BR'),
            u: m.unknownLemmas.toLocaleString('pt-BR'),
            r: m.unknownLemmasRepeated.toLocaleString('pt-BR'),
          })}
        </p>
        {report.chapters.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="vocab-chapters">
            <span className="mr-1 text-xs text-muted">{t('vocab.report.chapters')}</span>
            {report.chapters.map((c) => {
              // A chapter without counted words has no coverage: "—", never a misleading "0%".
              const empty = c.totalTokens === 0;
              return (
                <span
                  key={c.index}
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-line px-2 text-xs"
                  aria-label={
                    empty
                      ? t('vocab.report.chapterEmptyLabel', { capitulo: c.label })
                      : t('vocab.report.chapterLabel', { capitulo: c.label, pct: formatPct0(c.coverageKnown) })
                  }
                  data-empty={empty || undefined}
                >
                  <span className="max-w-[10rem] truncate">{c.label}</span>
                  <span className={empty ? 'text-muted' : 'font-semibold tabular'} aria-hidden>
                    {empty ? '—' : formatPct0(c.coverageKnown)}
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="min-w-0 md:border-l md:border-line md:pl-4">
        <CoverageCurve curve={m.curve} wordsTo95={m.wordsTo95} wordsTo98={m.wordsTo98} />
      </div>
    </section>
  );
}

function Filters({
  filters,
  onChange,
  chapters,
}: {
  filters: ReportFilters;
  onChange: (f: ReportFilters) => void;
  chapters: VocabReport['chapters'];
}) {
  const [minText, setMinText] = useState(String(filters.minOccurrences));
  // Follow outside changes ("Limpar filtros"); while typing, the text may be invalid or equal in value.
  useEffect(() => {
    setMinText((text) => (Number(text) === filters.minOccurrences ? text : String(filters.minOccurrences)));
  }, [filters.minOccurrences]);
  return (
    <div
      role="group"
      aria-label={t('vocab.filter.label')}
      className="flex flex-wrap items-end gap-x-3 gap-y-2"
      data-testid="vocab-filters"
    >
      <Field label={t('vocab.filter.search')} className="w-full sm:w-48">
        {({ id }) => (
          <Input
            id={id}
            type="search"
            value={filters.query}
            placeholder={t('vocab.filter.searchPlaceholder')}
            leading={<Search size={14} aria-hidden />}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('vocab.filter.status')} className="w-36">
        {({ id }) => (
          <Select
            id={id}
            value={filters.status}
            onChange={(e) => onChange({ ...filters, status: e.target.value as StatusFilter })}
          >
            {(['unknown', 'learning', 'known', 'all'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`vocab.filter.status.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('vocab.filter.minOccurrences')} className="w-28">
        {({ id }) => (
          <Input
            id={id}
            type="number"
            min={1}
            inputMode="numeric"
            className="tabular"
            value={minText}
            onChange={(e) => {
              setMinText(e.target.value);
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1) onChange({ ...filters, minOccurrences: n });
            }}
          />
        )}
      </Field>
      {chapters.length > 1 && (
        <Field label={t('vocab.filter.chapter')} className="w-52 max-w-full">
          {({ id }) => (
            <Select
              id={id}
              value={filters.chapter === null ? '' : String(filters.chapter)}
              onChange={(e) => onChange({ ...filters, chapter: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{t('vocab.filter.allChapters')}</option>
              {chapters.map((c) => (
                <option key={c.index} value={c.index} disabled={c.totalTokens === 0}>
                  {c.totalTokens === 0 ? t('vocab.filter.chapterEmpty', { capitulo: c.label }) : c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label={t('vocab.filter.sort')} className="w-40">
        {({ id }) => (
          <Select
            id={id}
            value={filters.sort}
            onChange={(e) => onChange({ ...filters, sort: e.target.value as SortKey })}
          >
            {(['occurrences', 'first', 'frequency'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`vocab.filter.sort.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Checkbox
        className="h-8"
        label={t('vocab.filter.hideRare')}
        checked={filters.hideRare}
        onChange={(e) => onChange({ ...filters, hideRare: e.currentTarget.checked })}
      />
    </div>
  );
}

/** Keeps what the user selected across a rescan, minus the words that are no longer to learn. */
function carrySelection(prev: ReadonlySet<string>, rows: readonly VocabRow[]): Set<string> {
  const byLemma = new Map(rows.map((r) => [r.lemma, r]));
  const out = new Set<string>();
  for (const lemma of prev) {
    const r = byLemma.get(lemma);
    if (!r || !selectable(r)) continue;
    if (r.group === 'main' && r.status !== 'unknown') continue;
    out.add(lemma);
  }
  return out;
}

function Report({ report }: { report: VocabReport }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const narrow = useNarrow();
  const scroller = useRef<HTMLDivElement>(null);
  const [filters, setFilters] = useState<ReportFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(report.rows));
  const [scanUid, setScanUid] = useState(report.scanUid);
  const [updating, setUpdating] = useState(false);
  const [generate, setGenerate] = useState(false);
  const carried = useRef<Set<string> | null>(null);
  const folderCount = report.folder.deckCount;
  // An EPUB's units are its chapters (spine sections): "cap. N" instead of "p. N" (spec 12 for EPUB).
  const library = useQuery(q.library());
  const unit = library.data?.find((b) => b.bookUid === report.bookUid)?.format === 'epub' ? 'chapter' : 'page';

  // A new scan of the same book (rescan, deck generation): keep the selection that still makes sense.
  useEffect(() => {
    if (report.scanUid === scanUid && !carried.current) return;
    setScanUid(report.scanUid);
    setSelected((prev) => carrySelection(carried.current ?? prev, report.rows));
    carried.current = null;
  }, [report, scanUid]);

  const items = useMemo(() => tableItems(report.rows, filters), [report.rows, filters]);
  const goal = useMemo(() => goalSelection(report), [report]);
  const rowCount = items.filter((i) => i.kind === 'row').length;
  const chosen = useMemo(
    () => report.rows.filter((r) => selected.has(r.lemma) && selectable(r)).map((r) => r.lemma),
    [report.rows, selected],
  );

  async function rescan(): Promise<void> {
    const job = await core.vocabRescan(report.bookUid);
    const end = await followJob(job);
    if (end.stage !== 'done') throw new Error(end.error?.message ?? t('vocab.scan.failed'));
    await qc.invalidateQueries({ queryKey: ['vocab', 'report', report.bookUid] });
  }

  async function override(status: VocabOverride) {
    if (!chosen.length) return;
    setUpdating(true);
    try {
      await core.vocabOverrideSet(chosen, status);
      const rest = new Set(selected);
      for (const l of chosen) rest.delete(l);
      carried.current = rest;
      await rescan();
      toast.show(t('vocab.actions.updated'), { tone: 'success' });
    } catch (e) {
      carried.current = null;
      toast.show(t('vocab.actions.failed', { erro: errorMessage(e) }), { tone: 'error' });
    } finally {
      setUpdating(false);
    }
  }

  async function rescanNow() {
    setUpdating(true);
    try {
      carried.current = new Set(selected);
      await rescan();
      toast.show(t('vocab.actions.updated'), { tone: 'success' });
    } catch (e) {
      carried.current = null;
      toast.show(t('vocab.actions.failed', { erro: errorMessage(e) }), { tone: 'error' });
    } finally {
      setUpdating(false);
    }
  }

  function onGenerated(result: VocabDeckResult) {
    setGenerate(false);
    const msg =
      result.created === 0
        ? t('vocab.deck.createdNone', { deck: result.deckName })
        : result.created === 1
          ? t('vocab.deck.createdOne', { deck: result.deckName })
          : t('vocab.deck.created', { n: result.created, deck: result.deckName });
    const skipped =
      result.skippedExisting.length || result.skippedPrevious.length
        ? ` ${t('vocab.deck.skipped', { n: result.skippedExisting.length, p: result.skippedPrevious.length })}`
        : '';
    toast.show(msg + skipped, { tone: 'success', durationMs: 6000 });
    carried.current = new Set();
    void qc.invalidateQueries({ queryKey: ['vocab', 'report', report.bookUid] });
  }

  function toggle(lemma: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(lemma);
      else next.delete(lemma);
      return next;
    });
  }

  /** The header box: checks every word shown, or clears the whole selection (shown or filtered out). */
  function toggleAll(on: boolean) {
    setSelected((prev) => {
      if (!on) return new Set();
      const next = new Set(prev);
      for (const it of items) if (it.kind === 'row' && selectable(it.row)) next.add(it.row.lemma);
      return next;
    });
  }

  const title = report.author
    ? t('vocab.report.byAuthor', { titulo: report.title, autor: report.author })
    : report.title;
  const meta =
    folderCount === 1
      ? t('vocab.report.metaOne', { data: formatDate(report.scannedAt), pasta: report.folder.rootName })
      : t('vocab.report.meta', { data: formatDate(report.scannedAt), pasta: report.folder.rootName, n: folderCount });

  return (
    <VocabPage wide ref={scroller}>
      <BookHeader
        title={title}
        subtitle={meta}
        back={{ label: t('vocab.backToLibrary'), onClick: () => void navigate({ to: '/biblioteca' }) }}
        actions={
          <Toolbar label={t('vocab.report.actions')} className="flex-wrap">
            <Button size="sm" icon={RefreshCw} onClick={() => void rescanNow()} disabled={updating}>
              {t('vocab.report.rescan')}
            </Button>
            <Button
              size="sm"
              icon={ScanText}
              onClick={() =>
                void navigate({ to: '/vocabulario/escanear', search: { livro: report.bookUid, passo: 'trecho' } })
              }
            >
              {t('vocab.report.otherRange')}
            </Button>
          </Toolbar>
        }
      >
        <p className="text-base" data-testid="vocab-range">
          {t('vocab.report.range', { trecho: report.range.display })}
        </p>
        <p className="flex items-start gap-1.5 text-xs text-muted" data-testid="vocab-offline">
          <ShieldCheck size={14} aria-hidden className="mt-px shrink-0 text-lime-dark" />
          {t('vocab.report.offline')}
        </p>
      </BookHeader>

      <Metrics report={report} />

      <Filters filters={filters} onChange={setFilters} chapters={report.chapters} />

      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted tabular" aria-live="polite">
          {rowCount === 1 ? t('vocab.filter.shownOne') : t('vocab.filter.shown', { n: rowCount })}
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={t('vocab.filter.none')}
          action={
            <Button onClick={() => setFilters({ ...DEFAULT_FILTERS, status: 'all', minOccurrences: 1 })}>
              {t('vocab.filter.clear')}
            </Button>
          }
        />
      ) : (
        <ReportTable
          items={items}
          selected={selected}
          onToggle={toggle}
          onToggleAll={toggleAll}
          scroller={scroller}
          unit={unit}
          onOpen={(row) =>
            void navigate({
              to: '/leitor',
              search:
                unit === 'chapter'
                  ? { livro: report.bookUid, cap: row.firstPage + 1, q: row.form }
                  : { livro: report.bookUid, pagina: row.firstPage + 1, q: row.form },
            })
          }
        />
      )}

      <div
        role="toolbar"
        aria-label={t('vocab.actions.label')}
        className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-wrap items-center gap-2 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6"
        data-testid="vocab-actions"
      >
        <Button
          size="sm"
          icon={Target}
          disabled={updating || goal.length === 0}
          onClick={() => setSelected(new Set(goal))}
        >
          {t('vocab.actions.selectGoal', { n: report.metrics.wordsTo98 })}
        </Button>
        {narrow ? (
          <>
            <IconButton
              icon={Check}
              variant="neutral"
              label={t('vocab.actions.known')}
              disabled={updating || !chosen.length}
              onClick={() => void override('known')}
            />
            <IconButton
              icon={EyeOff}
              variant="neutral"
              label={t('vocab.actions.ignore')}
              disabled={updating || !chosen.length}
              onClick={() => void override('ignored')}
            />
            <IconButton
              icon={UserRound}
              variant="neutral"
              label={t('vocab.actions.proper')}
              disabled={updating || !chosen.length}
              onClick={() => void override('proper')}
            />
          </>
        ) : (
          <>
            <Button size="sm" icon={Check} disabled={updating || !chosen.length} onClick={() => void override('known')}>
              {t('vocab.actions.known')}
            </Button>
            <Button
              size="sm"
              icon={EyeOff}
              disabled={updating || !chosen.length}
              onClick={() => void override('ignored')}
            >
              {t('vocab.actions.ignore')}
            </Button>
            <Button
              size="sm"
              icon={UserRound}
              disabled={updating || !chosen.length}
              onClick={() => void override('proper')}
            >
              {t('vocab.actions.proper')}
            </Button>
          </>
        )}
        <span className="flex-1" />
        {updating ? (
          <span className="flex items-center gap-1.5 text-xs text-muted" role="status">
            <Spinner />
            {t('vocab.actions.updating')}
          </span>
        ) : (
          <span className="hidden text-xs text-muted tabular sm:inline">
            {chosen.length === 1 ? t('vocab.actions.selectedOne') : t('vocab.actions.selected', { n: chosen.length })}
          </span>
        )}
        <Button
          variant="primary"
          size="sm"
          icon={Layers}
          disabled={updating || !chosen.length}
          onClick={() => setGenerate(true)}
          data-testid="vocab-generate"
        >
          {t('vocab.actions.generate', { n: chosen.length })}
        </Button>
      </div>

      {generate && (
        <GenerateDeckDialog
          report={report}
          lemmas={chosen}
          sheet={narrow}
          onClose={() => setGenerate(false)}
          onDone={onGenerated}
        />
      )}
    </VocabPage>
  );
}
