// Step 3 "Campos" (spec 12.1): for each notetype of the folder, the field that holds the English word, preselected by
// its name (Word, Palavra, Front…), with 5 words read from it so the user can check. Saved on "Continuar".
import { useQuery } from '@tanstack/react-query';
import { Badge, Field, Notice, Select, SkeletonLines } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import type { VocabFolderNotetype } from '../../../lib/core/types';
import { errorMessage } from '../../anki/decks/DeckDialogs';

/** The field shown for a notetype: the user's choice, else the saved mapping, else the suggestion. */
export function fieldOf(nt: VocabFolderNotetype, choices: Readonly<Record<number, string>>): string {
  return choices[nt.notetypeId] ?? nt.mappedField ?? nt.suggestedField;
}

function NotetypeFields({
  nt,
  rootId,
  excluded,
  field,
  onField,
}: {
  nt: VocabFolderNotetype;
  rootId: number;
  excluded: readonly number[];
  field: string;
  onField: (f: string) => void;
}) {
  const initial = nt.mappedField ?? nt.suggestedField;
  const samples = useQuery({
    queryKey: ['vocab', 'samples', rootId, excluded, nt.notetypeId, field],
    queryFn: () => core.vocabMappingSamples(rootId, [...excluded], nt.notetypeId, field),
    // The folder already brought the words of the saved/suggested field.
    initialData: field === initial ? nt.samples : undefined,
    staleTime: 0,
  });
  const words = samples.data ?? [];
  return (
    <li className="flex flex-col gap-3 rounded-box border border-line bg-card p-4" data-testid="vocab-notetype">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-semibold">{nt.name}</h3>
        <span className="flex items-center gap-2 text-xs text-muted">
          {nt.noteCount === 1 ? t('vocab.fields.notesOne') : t('vocab.fields.notes', { n: nt.noteCount })}
          {nt.mappedField ? (
            <Badge tone="lime">{t('vocab.fields.saved')}</Badge>
          ) : (
            <Badge tone="info">{t('vocab.fields.suggested')}</Badge>
          )}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-start">
        <Field label={t('vocab.fields.field')}>
          {({ id }) => (
            <Select id={id} value={field} onChange={(e) => onField(e.target.value)} data-testid="vocab-field-select">
              {nt.fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted">{t('vocab.fields.samples')}</span>
          {words.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-busy={samples.isFetching} data-testid="vocab-field-samples">
              {words.map((w) => (
                <li key={w} className="rounded-full border border-line bg-neutral px-2.5 py-0.5 text-base">
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-base text-muted">{samples.isFetching ? '…' : t('vocab.fields.noSamples')}</p>
          )}
        </div>
      </div>
    </li>
  );
}

export function FieldsStep({
  notetypes,
  loading,
  loadError,
  onRetry,
  rootId,
  excluded,
  choices,
  onChoice,
  error,
}: {
  /** `undefined` while the folder isn't loaded. */
  notetypes: VocabFolderNotetype[] | undefined;
  /** The folder query is loading (first load or another folder). */
  loading: boolean;
  loadError: unknown;
  onRetry: () => void;
  rootId: number;
  excluded: readonly number[];
  choices: Readonly<Record<number, string>>;
  onChoice: (notetypeId: number, field: string) => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-md font-semibold">{t('vocab.fields.title')}</h2>
        <p className="mt-0.5 text-base text-muted">{t('vocab.fields.description')}</p>
      </div>
      {loadError ? (
        <Notice tone="error" onRetry={onRetry}>
          {t('vocab.folder.loadError')} {errorMessage(loadError)}
        </Notice>
      ) : loading || !notetypes ? (
        <div aria-busy="true" data-testid="vocab-fields-loading">
          <SkeletonLines lines={4} />
        </div>
      ) : notetypes.length === 0 ? (
        <p className="text-base text-muted">{t('vocab.fields.noNotes')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notetypes.map((nt) => (
            <NotetypeFields
              key={nt.notetypeId}
              nt={nt}
              rootId={rootId}
              excluded={excluded}
              field={fieldOf(nt, choices)}
              onField={(f) => onChoice(nt.notetypeId, f)}
            />
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-base text-error">
          {error}
        </p>
      )}
    </div>
  );
}
