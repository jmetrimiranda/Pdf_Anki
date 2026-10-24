// "Escanear vocabulário" (spec 12.1): a stepper page — Pasta (mandatory), Trecho, Campos (only when a notetype of the
// folder has no field yet, or on "Revisar campos"), Critério, Escanear — that ends in the report.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, ScanText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Notice, Skeleton } from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import type { DeckNode, VocabConfig } from '../../lib/core/types';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { BookHeader, VocabPage } from './VocabPage';
import { vocabQ } from './queries';
import type { VocabStepParam, WizardStep } from './steps';
import { CriterionStep } from './wizard/CriterionStep';
import { fieldOf, FieldsStep } from './wizard/FieldsStep';
import { FolderStep } from './wizard/FolderStep';
import { rangeSpec, RangeStep, type RangeMode } from './wizard/RangeStep';
import { ScanStep } from './wizard/ScanStep';
import { Stepper } from './wizard/Stepper';

/** The default folder: a top-level deck named "Vocabulário" (spec 12.1: "normalmente Vocabulário"). */
export function defaultRoot(decks: DeckNode[]): number | null {
  const key = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return decks.find((d) => !d.filtered && key(d.name) === 'vocabulario')?.id ?? null;
}

export function VocabWizardPage({
  bookUid,
  initialStep,
}: {
  bookUid: string | undefined;
  initialStep?: VocabStepParam;
}) {
  const library = useQuery(q.library());
  const book = bookUid ? library.data?.find((b) => b.bookUid === bookUid) : undefined;
  if (!bookUid) {
    return (
      <VocabPage>
        <EmptyState icon={ScanText} title={t('vocab.noBook')} description={t('vocab.noBookHint')} />
      </VocabPage>
    );
  }
  if (library.isPending) {
    return (
      <VocabPage>
        <Skeleton className="h-40" rounded="box" />
      </VocabPage>
    );
  }
  if (!book) {
    return (
      <VocabPage>
        <EmptyState icon={ScanText} title={t('vocab.bookMissing')} />
      </VocabPage>
    );
  }
  return (
    <Wizard
      bookUid={bookUid}
      title={book.title}
      author={book.author}
      pages={book.pages}
      unit={book.format === 'epub' ? 'chapter' : 'page'}
      initialStep={initialStep}
    />
  );
}

function Wizard({
  bookUid,
  title,
  author,
  pages,
  unit,
  initialStep,
}: {
  bookUid: string;
  title: string;
  author: string | null;
  pages: number;
  /** `chapter` for an EPUB (ranges by chapters and by its TOC). */
  unit: 'page' | 'chapter';
  initialStep?: VocabStepParam;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = useQuery(vocabQ.settings());
  const tree = useQuery(q.deckTree());
  const [rootId, setRootId] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<RangeMode>('all');
  const [ids, setIds] = useState<string[]>([]);
  const [pagesText, setPagesText] = useState('');
  const [rangeValid, setRangeValid] = useState(true);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [reviewFields, setReviewFields] = useState(false);
  const [config, setConfig] = useState<VocabConfig | null>(null);
  const [configValid, setConfigValid] = useState(true);
  const [step, setStep] = useState<WizardStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const initialized = useRef(false);

  // Defaults: the last folder (settings), else a deck named "Vocabulário"; a deep link past "pasta" only with a saved
  // folder.
  useEffect(() => {
    if (initialized.current || !settings.data || !tree.data) return;
    initialized.current = true;
    const s = settings.data;
    const root = s.rootDeckId ?? defaultRoot(tree.data.decks);
    setRootId(root);
    setExcluded(new Set(s.rootDeckId !== null && s.rootDeckId === root ? s.excludedDeckIds : []));
    setConfig(s.config);
    const first = initialStep && s.rootDeckId !== null ? initialStep : 'pasta';
    setStep(first);
    if (first === 'campos') setReviewFields(true);
  }, [settings.data, tree.data, initialStep]);

  const folder = useQuery({ ...vocabQ.folder(rootId ?? 0), enabled: rootId !== null });
  const unmapped = folder.data?.notetypes.some((nt) => nt.mappedField === null) ?? false;
  const fieldsShown = unmapped || reviewFields;
  const steps = useMemo<WizardStep[]>(
    () => ['pasta', 'trecho', ...(fieldsShown ? (['campos'] as const) : []), 'criterio', 'escanear'],
    [fieldsShown],
  );

  const go = useCallback(
    (next: WizardStep) => {
      setStep(next);
      // Once shown, "Campos" stays in the stepper (the mapping just saved would hide it otherwise).
      if (next === 'campos') setReviewFields(true);
      if (next !== 'escanear') {
        void navigate({ to: '/vocabulario/escanear', search: { livro: bookUid, passo: next }, replace: true });
      }
    },
    [navigate, bookUid],
  );

  const onRoot = useCallback(
    (id: number) => {
      if (id === rootId) return;
      setRootId(id);
      setExcluded(new Set());
      setChoices({});
    },
    [rootId],
  );

  async function saveFields(): Promise<boolean> {
    const list = folder.data?.notetypes ?? [];
    const changes = list.filter((nt) => fieldOf(nt, choices) !== nt.mappedField);
    if (!changes.length) return true;
    setSaving(true);
    setFieldsError(null);
    try {
      for (const nt of changes) await core.vocabMappingSet(nt.notetypeId, fieldOf(nt, choices));
      await qc.invalidateQueries({ queryKey: ['vocab', 'folder'] });
      return true;
    } catch (e) {
      setFieldsError(t('vocab.fields.saveFailed', { erro: errorMessage(e) }));
      return false;
    } finally {
      setSaving(false);
    }
  }

  const index = step ? steps.indexOf(step) : -1;
  const nextStep = steps[index + 1];
  const prevStep = index > 0 ? steps[index - 1] : undefined;

  async function onContinue() {
    if (!step || !nextStep) return;
    if (step === 'campos' && !(await saveFields())) return;
    go(nextStep);
  }

  const canContinue =
    step === 'pasta'
      ? rootId !== null && folder.isSuccess
      : step === 'trecho'
        ? rangeValid
        : step === 'campos'
          ? folder.isSuccess && !saving
          : step === 'criterio'
            ? configValid && config !== null
            : false;

  const onValidRange = useCallback((v: boolean) => setRangeValid(v), []);
  const onValidConfig = useCallback((v: boolean) => setConfigValid(v), []);

  const loading = settings.isPending || tree.isPending || step === null;
  const loadError = settings.error ?? tree.error;

  return (
    <VocabPage>
      <BookHeader
        title={t('vocab.wizard.title')}
        subtitle={author ? t('vocab.report.byAuthor', { titulo: title, autor: author }) : title}
        back={{ label: t('vocab.backToLibrary'), onClick: () => void navigate({ to: '/biblioteca' }) }}
      />
      {loadError && <Notice tone="error">{errorMessage(loadError)}</Notice>}
      {loading && !loadError && <Skeleton className="h-64" rounded="box" />}
      {!loading && step && config && (
        <>
          <Stepper steps={steps} current={step} onGo={go} locked={busy} />
          <div className="min-h-[16rem]" data-testid={`vocab-step-${step}`}>
            {step === 'pasta' && (
              <FolderStep rootId={rootId} excluded={excluded} onRoot={onRoot} onExcluded={setExcluded} />
            )}
            {step === 'trecho' && (
              <RangeStep
                bookUid={bookUid}
                pages={pages}
                unit={unit}
                mode={mode}
                ids={ids}
                pagesText={pagesText}
                onMode={setMode}
                onIds={setIds}
                onPagesText={setPagesText}
                onValid={onValidRange}
              />
            )}
            {step === 'campos' && rootId !== null && (
              <FieldsStep
                notetypes={folder.data?.notetypes}
                loading={folder.isPending}
                loadError={folder.data ? null : folder.error}
                onRetry={() => void folder.refetch()}
                rootId={rootId}
                excluded={[...excluded]}
                choices={choices}
                onChoice={(id, f) => setChoices((c) => ({ ...c, [id]: f }))}
                error={fieldsError}
              />
            )}
            {step === 'criterio' && (
              <CriterionStep
                config={config}
                onConfig={setConfig}
                onValid={onValidConfig}
                onReviewFields={() => {
                  setReviewFields(true);
                  go('campos');
                }}
              />
            )}
            {step === 'escanear' && rootId !== null && (
              <ScanStep
                start={() =>
                  core.vocabScanStart(bookUid, rootId, [...excluded], rangeSpec(mode, ids, pagesText), config)
                }
                onBusy={setBusy}
                unit={unit}
                onNeedsOcr={() => void navigate({ to: '/biblioteca', search: { ocr: bookUid } })}
                onBack={() => go('criterio')}
                onDone={() => {
                  void qc.invalidateQueries({ queryKey: ['vocab'] });
                  // The library menu offers the report once the book is scanned.
                  void qc.invalidateQueries({ queryKey: ['library'] });
                  void navigate({ to: '/vocabulario', search: { livro: bookUid }, replace: true });
                }}
              />
            )}
          </div>
          {step !== 'escanear' && (
            <footer
              className="flex items-center justify-between gap-2 border-t border-line pt-4"
              data-testid="vocab-wizard-footer"
            >
              <Button variant="ghost" icon={ArrowLeft} disabled={!prevStep} onClick={() => prevStep && go(prevStep)}>
                {t('vocab.back')}
              </Button>
              <span className="hidden text-xs text-muted sm:inline">
                {t('vocab.wizard.stepOf', { n: index + 1, total: steps.length })}
              </span>
              <Button
                variant="primary"
                iconRight={ArrowRight}
                disabled={!canContinue}
                loading={saving}
                onClick={() => void onContinue()}
              >
                {nextStep === 'escanear' ? t('vocab.wizard.scan') : t('vocab.wizard.continue')}
              </Button>
            </footer>
          )}
        </>
      )}
    </VocabPage>
  );
}
