// Configurações → Código (spec 5.2, 11.1, 11.2, 11.4, 11.5): the "Comando" role of the user's own notetypes, the
// review options, where C++ runs (local compiler or the runner) and the Python line.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, PlugZap, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  Field,
  IconButton,
  Input,
  Notice,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import type {
  CodeMapping,
  CodeSettings as CodeSettingsData,
  CodeSettingsPatch,
  CppBackendChoice,
  NotetypeInfo,
} from '../../lib/core/types';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { htmlToCode } from '../anki/editor/codeField';

export const codeQ = {
  mappings: () => ({ queryKey: ['code', 'mappings'], queryFn: () => core.codeMappingList() }) as const,
  settings: () => ({ queryKey: ['code', 'settings'], queryFn: () => core.codeSettingsGet() }) as const,
  status: () => ({ queryKey: ['code', 'status'], queryFn: () => core.codeStatus(), staleTime: 0 }) as const,
};

/** Notetypes that can get the "Comando" role: the user's own (not the app's), not cloze. */
export function roleCandidates(notetypes: readonly NotetypeInfo[], mappings: readonly CodeMapping[]): NotetypeInfo[] {
  const mapped = new Set(mappings.map((m) => m.notetypeId));
  return notetypes.filter((nt) => nt.appType === null && nt.kind !== 'cloze' && !mapped.has(nt.id));
}

/** Field preselected for a role: a field with a familiar name, else by position. */
function guessField(names: readonly string[], wanted: RegExp, fallback: number): string {
  return names.find((n) => wanted.test(n)) ?? names[fallback] ?? '';
}

function MappingRow({ mapping }: { mapping: CodeMapping }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = mapping.notetypeName || t('settings.code.roles.notetypeGone');

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(codeQ.mappings().queryKey, await core.codeMappingSet(mapping.notetypeId, null));
      toast.show(t('settings.code.roles.removed', { tipo: name }), { tone: 'success' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0" data-testid="code-mapping">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{name}</p>
          <p className="text-xs text-muted">
            {t('settings.code.roles.fields', {
              pergunta: mapping.fields.question,
              resposta: mapping.fields.answer,
              observacao: mapping.fields.notes ?? t('settings.code.roles.none'),
            })}
          </p>
          <p className="text-xs text-muted">
            {mapping.noteCount === 1
              ? t('settings.code.roles.notesOne')
              : t('settings.code.roles.notes', { n: mapping.noteCount })}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={Trash2}
          loading={busy}
          aria-label={t('settings.code.roles.removeLabel', { tipo: name })}
          onClick={() => void remove()}
        >
          {t('settings.code.roles.remove')}
        </Button>
      </div>
      {mapping.missingFields.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-fg" role="status">
          <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-(--vocab-learning)" />
          {t('settings.code.roles.missing', { campos: mapping.missingFields.join(', ') })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </li>
  );
}

/** The first note of a notetype, decoded as text (a cheap preview for choosing the fields). */
function useFirstNote(notetype: NotetypeInfo | null) {
  return useQuery({
    queryKey: ['code', 'firstNote', notetype?.id ?? null],
    enabled: !!notetype && notetype.noteCount > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const name = notetype!.name.replace(/(["\\])/g, '\\$1');
      const cards = await core.ankiSearch(`"note:${name}"`, null);
      const first = cards[0];
      if (first === undefined) return null;
      const [row] = await core.ankiBrowseRows([first]);
      if (!row) return null;
      const note = await core.ankiNoteGet(row.noteId);
      return note.fields.map((html) => htmlToCode(html).replace(/\s+/g, ' ').trim());
    },
  });
}

function AssignForm({ candidates, onDone }: { candidates: NotetypeInfo[]; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ntid, setNtid] = useState<number | null>(null);
  const notetype = candidates.find((nt) => nt.id === ntid) ?? null;
  const names = useMemo(() => notetype?.fields.map((f) => f.name) ?? [], [notetype]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useFirstNote(notetype);

  // Another notetype: preselect fields by their usual names.
  useEffect(() => {
    setQuestion(guessField(names, /^(pergunta|frente|front|question)$/i, 0));
    setAnswer(guessField(names, /^(resposta|comando|verso|back|answer|command)$/i, 1));
    setNotes(names.find((n) => /^(observação|observacao|explicação|explicacao|notes?|extra)$/i.test(n)) ?? '');
    setError(null);
  }, [names]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!notetype) return;
    if (!question || !answer) {
      setError(t('settings.code.roles.pickFields'));
      return;
    }
    if (question === answer || (notes && (notes === question || notes === answer))) {
      setError(t('settings.code.roles.sameField'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await core.codeMappingSet(notetype.id, { question, answer, notes: notes || null });
      qc.setQueryData(codeQ.mappings().queryKey, next);
      // Cards of this type now study with the interactive panel.
      void qc.invalidateQueries({ queryKey: ['anki'] });
      toast.show(t('settings.code.roles.saved', { tipo: notetype.name }), { tone: 'success' });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const fieldSelect = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    optional: boolean,
    testId: string,
  ) => (
    <Field label={label}>
      {({ id }) => (
        <Select id={id} value={value} data-testid={testId} onChange={(e) => onChange(e.target.value)}>
          {optional && <option value="">{t('settings.code.roles.observationNone')}</option>}
          {names.map((n, i) => (
            <option key={n} value={n}>
              {preview.data?.[i] ? `${n} — ${preview.data[i]!.slice(0, 40)}` : n}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      aria-label={t('settings.code.roles.assignTitle')}
      className="flex flex-col gap-3 rounded-box border border-line p-3"
    >
      <div className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 text-base font-semibold">{t('settings.code.roles.assignTitle')}</h4>
        <IconButton icon={X} size="sm" label={t('common.cancel')} onClick={onDone} />
      </div>
      {candidates.length === 0 ? (
        <p className="text-base text-muted">{t('settings.code.roles.noCandidates')}</p>
      ) : (
        <>
          <Field label={t('settings.code.roles.notetype')}>
            {({ id }) => (
              <Select
                id={id}
                value={ntid ?? ''}
                onChange={(e) => setNtid(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('settings.code.roles.chooseNotetype')}</option>
                {candidates.map((nt) => (
                  <option key={nt.id} value={nt.id}>
                    {nt.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {notetype && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {fieldSelect(t('settings.code.roles.question'), question, setQuestion, false, 'role-question')}
                {fieldSelect(t('settings.code.roles.answer'), answer, setAnswer, false, 'role-answer')}
                {fieldSelect(t('settings.code.roles.observation'), notes, setNotes, true, 'role-notes')}
              </div>
              {preview.data && (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-ctl bg-neutral px-2.5 py-2 text-xs">
                  <dt className="col-span-2 mb-0.5 text-muted">{t('settings.code.roles.preview')}</dt>
                  {[question, answer, notes].filter(Boolean).map((name) => {
                    const i = names.indexOf(name);
                    return (
                      <div key={name} className="contents">
                        <dt className="text-muted">{name}</dt>
                        <dd className="truncate font-mono">{preview.data?.[i] ?? ''}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
              <p className="text-xs text-muted">{t('settings.code.roles.unchanged')}</p>
            </>
          )}
          {error && (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onDone}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!notetype}>
              {t('settings.code.roles.save')}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

function RolesCard() {
  const mappings = useQuery(codeQ.mappings());
  const notetypes = useQuery(q.notetypes());
  const [assigning, setAssigning] = useState(false);
  const commands = (mappings.data ?? []).filter((m) => m.role === 'code_command');
  const candidates = roleCandidates(notetypes.data ?? [], mappings.data ?? []);
  const error = mappings.error ?? notetypes.error;

  return (
    <Card title={t('settings.code.roles.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t('settings.code.roles.hint')}</p>
        {error && (
          <Notice
            tone="error"
            onRetry={() => {
              void mappings.refetch();
              void notetypes.refetch();
            }}
          >
            {errorMessage(error)}
          </Notice>
        )}
        {mappings.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : commands.length ? (
          <ul className="flex flex-col divide-y divide-line" aria-label={t('settings.code.roles.title')}>
            {commands.map((m) => (
              <MappingRow key={m.notetypeId} mapping={m} />
            ))}
          </ul>
        ) : (
          !error && <p className="text-base text-muted">{t('settings.code.roles.empty')}</p>
        )}
        {assigning && notetypes.data ? (
          <AssignForm candidates={candidates} onDone={() => setAssigning(false)} />
        ) : (
          <div>
            <Button icon={Plus} disabled={!notetypes.data} onClick={() => setAssigning(true)}>
              {t('settings.code.roles.assign')}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted">{t('settings.code.roles.extraHint')}</p>
      </div>
    </Card>
  );
}

/** Applies a settings patch, caching the answer; errors become a toast. */
function useSaveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (patch: CodeSettingsPatch): Promise<CodeSettingsData | null> => {
    try {
      const next = await core.codeSettingsSet(patch);
      qc.setQueryData(codeQ.settings().queryKey, next);
      void qc.invalidateQueries({ queryKey: codeQ.status().queryKey });
      return next;
    } catch (e) {
      toast.show(t('settings.code.saveFailed', { erro: errorMessage(e) }), { tone: 'error' });
      return null;
    }
  };
}

function ReviewCard({ settings }: { settings: CodeSettingsData }) {
  const save = useSaveSettings();
  const [secs, setSecs] = useState(String(settings.suggestEasySecs));
  const [secsError, setSecsError] = useState<string | null>(null);
  useEffect(() => setSecs(String(settings.suggestEasySecs)), [settings.suggestEasySecs]);

  function commitSecs() {
    const n = Number(secs);
    if (!/^\d+$/.test(secs.trim()) || n < 1 || n > 600) {
      setSecsError(t('settings.code.review.secondsInvalid'));
      return;
    }
    setSecsError(null);
    if (n !== settings.suggestEasySecs) void save({ suggestEasySecs: n });
  }

  return (
    <Card title={t('settings.code.review.title')}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Switch
            checked={settings.suggestEasy}
            onCheckedChange={(v) => void save({ suggestEasy: v })}
            label={t('settings.code.review.suggestEasy')}
          />
          <Field label={t('settings.code.review.seconds')} error={secsError} className="w-60 max-w-full pl-[46px]">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                max={600}
                value={secs}
                disabled={!settings.suggestEasy}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => setSecs(e.target.value)}
                onBlur={commitSecs}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitSecs();
                  }
                }}
              />
            )}
          </Field>
        </div>
        <div className="flex flex-col gap-1">
          <Switch
            checked={settings.outputExact}
            onCheckedChange={(v) => void save({ outputExact: v })}
            label={t('settings.code.review.exact')}
          />
          <p className="text-xs text-muted">{t('settings.code.review.exactHint')}</p>
        </div>
      </div>
    </Card>
  );
}

function CppCard({ settings }: { settings: CodeSettingsData }) {
  const status = useQuery(codeQ.status());
  const save = useSaveSettings();
  const toast = useToast();
  const [url, setUrl] = useState(settings.runnerUrl ?? '');
  // The token is write-only: typed here, sent once, never shown back.
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setUrl(settings.runnerUrl ?? ''), [settings.runnerUrl]);

  async function saveRunner(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const patch: CodeSettingsPatch = { runnerUrl: url.trim() || null };
    if (token) patch.runnerToken = token;
    const next = await save(patch);
    setToken('');
    setBusy(false);
    if (next) toast.show(t('settings.code.runner.saved'), { tone: 'success' });
  }

  async function removeToken() {
    setBusy(true);
    await save({ runnerToken: null });
    setBusy(false);
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const r = await core.codeRunnerTest();
      setResult({ ok: r.ok, message: r.ok ? t('settings.code.runner.ok') : r.message });
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  }

  const local = status.data?.cpp.local ?? null;
  return (
    <Card title={t('settings.code.cpp.title')}>
      <div className="flex flex-col gap-4">
        {status.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : status.isError ? (
          <Notice tone="error" onRetry={() => void status.refetch()}>
            {errorMessage(status.error)}
          </Notice>
        ) : (
          status.data && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-base" data-testid="code-cpp-status">
              <dt className="text-muted">{t('settings.code.cpp.compiler')}</dt>
              <dd className="min-w-0">
                {local?.compiler ? (
                  <span className="font-mono text-sm break-all">{local.compiler}</span>
                ) : (
                  <>
                    <span>{t('settings.code.cpp.compilerNone')}</span>
                    <span className="block text-xs text-muted">{t('settings.code.cpp.compilerHint')}</span>
                  </>
                )}
              </dd>
              <dt className="text-muted">{t('settings.code.cpp.clangFormat')}</dt>
              <dd>{local?.clangFormat ? t('settings.code.cpp.yes') : t('settings.code.cpp.no')}</dd>
            </dl>
          )
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">{t('settings.code.cpp.backend')}</span>
          <SegmentedControl<CppBackendChoice>
            label={t('settings.code.cpp.backend')}
            value={settings.cppBackend}
            onChange={(v) => void save({ cppBackend: v })}
            options={[
              { value: 'auto', label: t('settings.code.cpp.auto') },
              { value: 'local', label: t('settings.code.cpp.local') },
              { value: 'remote', label: t('settings.code.cpp.remote') },
            ]}
            className="self-start"
          />
          <p className="text-xs text-muted">{t('settings.code.cpp.backendHint')}</p>
        </div>
        <form noValidate onSubmit={(e) => void saveRunner(e)} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.code.runner.url')}>
              {({ id }) => (
                <Input
                  id={id}
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t('settings.code.runner.urlPlaceholder')}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('settings.code.runner.token')}
              hint={settings.runnerTokenSet ? t('settings.code.runner.tokenSaved') : undefined}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  placeholder={settings.runnerTokenSet ? '••••••••' : t('settings.code.runner.tokenPlaceholder')}
                  value={token}
                  aria-describedby={describedBy}
                  data-testid="runner-token"
                  onChange={(e) => setToken(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy}>
              {t('settings.code.runner.save')}
            </Button>
            <Button
              variant="ghost"
              icon={PlugZap}
              loading={testing}
              disabled={!settings.runnerUrl}
              onClick={() => void test()}
            >
              {t('settings.code.runner.test')}
            </Button>
            {settings.runnerTokenSet && (
              <Button variant="ghost" disabled={busy} onClick={() => void removeToken()}>
                {t('settings.code.runner.tokenRemove')}
              </Button>
            )}
          </div>
          {result && (
            <Notice tone={result.ok ? 'success' : 'error'} onDismiss={() => setResult(null)}>
              {result.message}
            </Notice>
          )}
        </form>
      </div>
    </Card>
  );
}

/** Configurações → Código. */
export function CodeSettings() {
  const settings = useQuery(codeQ.settings());
  return (
    <div className="flex flex-col gap-4" data-testid="settings-code">
      <header>
        <h2 className="text-lg font-semibold">{t('settings.section.code')}</h2>
        <p className="text-base text-muted">{t('settings.code.hint')}</p>
      </header>
      <RolesCard />
      {settings.isError && (
        <Notice tone="error" onRetry={() => void settings.refetch()}>
          {t('settings.code.loadError')}
        </Notice>
      )}
      {settings.isPending && <Skeleton className="h-24 w-full" />}
      {settings.data && (
        <>
          <ReviewCard settings={settings.data} />
          <CppCard settings={settings.data} />
        </>
      )}
      <Card title={t('settings.code.python.title')}>
        <p className="text-base">{t('settings.code.python.offline')}</p>
      </Card>
    </div>
  );
}
