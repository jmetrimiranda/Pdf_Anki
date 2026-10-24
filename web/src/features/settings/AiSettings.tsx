// Configurações → IA (spec 13, docs/planos/fase-8.md 6.4): the keys (only their last 4 characters), provider, model
// and effort per function (activating a provider asks for consent each time), the spending caps, what was spent,
// the price table, the background queue and what each function sends.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pause, Play, PlugZap, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  IconButton,
  Input,
  Notice,
  ProgressBar,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  useToast,
} from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { core } from '../../lib/core/client';
import type {
  AiEffort,
  AiFunctionSettings,
  AiModelPrice,
  AiProvider,
  AiProviderInfo,
  AiQueueInfo,
  AiSettings as AiSettingsData,
} from '../../lib/core/types';
import { aiQ } from '../ai/queries';
import { errorMessage } from '../anki/decks/DeckDialogs';

export { aiQ };

/** Where each provider's calls go and its data policy (shown in the consent dialog). */
const PROVIDER_INFO: Record<AiProvider, { domain: string; policy: string | null; note?: MessageKey }> = {
  anthropic: { domain: 'api.anthropic.com', policy: 'https://www.anthropic.com/legal/privacy' },
  openai: {
    domain: 'api.openai.com',
    policy: 'https://developers.openai.com/api/docs/guides/your-data',
    note: 'settings.ai.consent.noteOpenai',
  },
  // Filled in (and checked) with its adapter's commit.
  gemini: { domain: 'generativelanguage.googleapis.com', policy: null },
  deepseek: {
    domain: 'api.deepseek.com',
    policy: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
    note: 'settings.ai.consent.noteDeepseek',
  },
};

const FEATURE_LABEL: Record<string, MessageKey> = {
  enrich: 'settings.ai.functions.enrich',
  define: 'settings.ai.sent.define',
  cards: 'settings.ai.sent.cards',
  judge: 'settings.ai.functions.judge',
};

const usdFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** US$ amounts as the screens show them (2 to 4 decimals). */
export function usd(x: number): string {
  return usdFormat.format(x);
}

function parseUsd(text: string): number | null {
  const n = Number(text.replace(',', '.').trim());
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

function useSetSettings() {
  const qc = useQueryClient();
  return (next: AiSettingsData) => {
    qc.setQueryData(aiQ.settings().queryKey, next);
    void qc.invalidateQueries({ queryKey: ['ai', 'queue'] });
  };
}

// ---------------------------------------------------------------- keys

function KeyRow({ provider }: { provider: AiProviderInfo }) {
  const setSettings = useSetSettings();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run(kind: 'save' | 'test' | 'remove', fn: () => Promise<void>) {
    setBusy(kind);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void run('save', async () => {
      const next = await core.aiKeySet(provider.id, key);
      // The key crossed once; the field forgets it.
      setKey('');
      setSettings(next);
      toast.show(t('settings.ai.keys.saved', { provedor: provider.label }), { tone: 'success' });
    });
  }

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" data-testid={`ai-key-${provider.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={15} aria-hidden className="text-muted" />
        <span className="text-base font-semibold">{provider.label}</span>
        {!provider.available ? (
          <Badge>{t('settings.ai.keys.soon')}</Badge>
        ) : (
          <span className="text-xs text-muted" data-testid="ai-key-status">
            {provider.keySuffix
              ? t('settings.ai.keys.suffix', { final: provider.keySuffix })
              : t('settings.ai.keys.none')}
          </span>
        )}
      </div>
      {provider.available && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="w-72 max-w-full"
            aria-label={t('settings.ai.keys.paste', { provedor: provider.label })}
            placeholder={t('settings.ai.keys.paste', { provedor: provider.label })}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" disabled={!key.trim()} loading={busy === 'save'}>
            {t('settings.ai.keys.save')}
          </Button>
          {provider.hasKey && (
            <>
              <Button
                type="button"
                size="sm"
                variant="neutral"
                icon={PlugZap}
                title={t('settings.ai.keys.testHint')}
                loading={busy === 'test'}
                onClick={() =>
                  void run('test', async () => {
                    const r = await core.aiKeyTest(provider.id);
                    setResult({ ok: r.ok, message: r.message });
                  })
                }
              >
                {t('settings.ai.keys.test')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={Trash2}
                loading={busy === 'remove'}
                onClick={() =>
                  void run('remove', async () => {
                    setSettings(await core.aiKeyDelete(provider.id));
                    toast.show(t('settings.ai.keys.removed', { provedor: provider.label }), { tone: 'success' });
                  })
                }
              >
                {t('settings.ai.keys.remove')}
              </Button>
            </>
          )}
        </form>
      )}
      {result && (
        <p role={result.ok ? 'status' : 'alert'} className={result.ok ? 'text-xs text-lime-dark' : 'text-xs text-error'}>
          {result.message}
        </p>
      )}
    </li>
  );
}

function KeysCard({ settings }: { settings: AiSettingsData }) {
  return (
    <Card>
      <h3 className="text-base font-semibold">{t('settings.ai.keys.title')}</h3>
      <p className="mb-3 text-xs text-muted">{t('settings.ai.keys.hint')}</p>
      {!settings.keychainAvailable && (
        <Notice tone="error" className="mb-3">
          {t('settings.ai.keys.noKeychain')}
        </Notice>
      )}
      <ul className="divide-y divide-line">
        {settings.providers.map((p) => (
          <KeyRow key={p.id} provider={p} />
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- consent

export function SentTable() {
  const rows: [MessageKey, MessageKey, MessageKey][] = [
    ['settings.ai.sent.enrich', 'settings.ai.sent.enrichSent', 'settings.ai.sent.enrichNot'],
    ['settings.ai.sent.define', 'settings.ai.sent.defineSent', 'settings.ai.sent.defineNot'],
    ['settings.ai.sent.judge', 'settings.ai.sent.judgeSent', 'settings.ai.sent.judgeNot'],
    ['settings.ai.sent.cards', 'settings.ai.sent.cardsSent', 'settings.ai.sent.cardsNot'],
    ['settings.ai.sent.test', 'settings.ai.sent.testSent', 'settings.ai.sent.testNot'],
  ];
  return (
    <table className="w-full border-collapse text-left text-xs">
      <thead>
        <tr className="text-muted">
          <th className="py-1 pr-2 font-normal">{t('settings.ai.sent.function')}</th>
          <th className="py-1 pr-2 font-normal">{t('settings.ai.sent.sent')}</th>
          <th className="py-1 font-normal">{t('settings.ai.sent.notSent')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([f, sent, not]) => (
          <tr key={f} className="border-t border-line align-top">
            <td className="py-1.5 pr-2 font-semibold">{t(f)}</td>
            <td className="py-1.5 pr-2">{t(sent)}</td>
            <td className="py-1.5 text-muted">{t(not)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConsentDialog({
  provider,
  settings,
  onCancel,
  onActivate,
  busy,
}: {
  provider: AiProviderInfo;
  settings: AiSettingsData;
  onCancel: () => void;
  onActivate: () => void;
  busy: boolean;
}) {
  const info = PROVIDER_INFO[provider.id];
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={t('settings.ai.consent.title', { provedor: provider.label })}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={onActivate} data-testid="ai-consent-activate">
            {t('settings.ai.consent.activate')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-base">
        <p>{t('settings.ai.consent.body', { dominio: info.domain })}</p>
        {info.note && (
          <Notice tone="info">
            <span data-testid="ai-consent-note">{t(info.note)}</span>
          </Notice>
        )}
        <SentTable />
        <p className="text-xs text-muted">
          {t('settings.ai.consent.limits', { dia: usd(settings.limitDayUsd), mes: usd(settings.limitMonthUsd) })}
        </p>
        {info.policy && (
          <a className="text-xs text-link underline" href={info.policy} target="_blank" rel="noreferrer">
            {t('settings.ai.consent.policy')}
          </a>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- functions

const EFFORTS: AiEffort[] = ['minimum', 'low', 'medium', 'high'];

function FunctionCard({
  fn,
  settings,
  prices,
}: {
  fn: 'enrich' | 'judge';
  settings: AiSettingsData;
  prices: AiModelPrice[];
}) {
  const setSettings = useSetSettings();
  const toast = useToast();
  const current: AiFunctionSettings = settings[fn];
  const [pending, setPending] = useState<AiProviderInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cap = fn === 'enrich' ? 4000 : 2000;
  const [tokens, setTokens] = useState(String(current.maxOutputTokens));
  useEffect(() => setTokens(String(current.maxOutputTokens)), [current.maxOutputTokens]);

  async function patch(p: Parameters<typeof core.aiSettingsSet>[0], quiet = false) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await core.aiSettingsSet(p));
      if (!quiet) toast.show(t('settings.ai.functions.saved'), { tone: 'success' });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function chooseProvider(value: string) {
    if (!value) {
      void patch({ [fn]: { provider: null } });
      return;
    }
    const p = settings.providers.find((x) => x.id === value);
    if (p) setPending(p);
  }

  const models = current.provider ? prices.filter((p) => p.provider === current.provider) : [];
  const defaultModel = models.find((m) => m.roleDefault === fn)?.model ?? null;
  const providerInfo = settings.providers.find((p) => p.id === current.provider);
  const title = fn === 'enrich' ? 'settings.ai.functions.enrich' : 'settings.ai.functions.judge';
  const hint = fn === 'enrich' ? 'settings.ai.functions.enrichHint' : 'settings.ai.functions.judgeHint';

  return (
    <Card data-testid={`ai-function-${fn}`}>
      <h3 className="text-base font-semibold">{t(title)}</h3>
      <p className="mb-3 text-xs text-muted">{t(hint)}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('settings.ai.functions.provider')}>
          {({ id }) => (
            <Select
              id={id}
              data-testid={`ai-provider-${fn}`}
              value={current.provider ?? ''}
              disabled={busy}
              onChange={(e) => chooseProvider(e.target.value)}
            >
              <option value="">{t('settings.ai.functions.off')}</option>
              {settings.providers
                .filter((p) => p.available)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        {current.provider && (
          <Field label={t('settings.ai.functions.model')}>
            {({ id }) => (
              <Select
                id={id}
                data-testid={`ai-model-${fn}`}
                value={current.model ?? ''}
                disabled={busy}
                onChange={(e) => void patch({ [fn]: { model: e.target.value || null } })}
              >
                <option value="">
                  {t('settings.ai.functions.modelDefault', { modelo: defaultModel ?? '—' })}
                </option>
                {models
                  .filter((m) => m.model !== defaultModel)
                  .map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.model}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      {current.provider && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">{t('settings.ai.functions.effort')}</span>
            <SegmentedControl<AiEffort>
              label={t('settings.ai.functions.effort')}
              size="sm"
              value={current.effort}
              onChange={(effort) => void patch({ [fn]: { effort } }, true)}
              options={EFFORTS.map((e) => ({ value: e, label: t(`settings.ai.functions.effort.${e}`) }))}
            />
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(tokens);
              if (Number.isInteger(n)) void patch({ [fn]: { maxOutputTokens: n } });
            }}
          >
            <Field label={t('settings.ai.functions.maxTokens', { max: cap })}>
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  className="w-28"
                  value={tokens}
                  onChange={(e) => setTokens(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" size="sm" variant="neutral" disabled={tokens === String(current.maxOutputTokens)}>
              {t('common.save')}
            </Button>
          </form>
        </div>
      )}
      {providerInfo && !providerInfo.hasKey && (
        <p className="mt-2 text-xs text-error" role="status">
          {t('settings.ai.functions.needsKey', { provedor: providerInfo.label })}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
      {pending && (
        <ConsentDialog
          provider={pending}
          settings={settings}
          busy={busy}
          onCancel={() => setPending(null)}
          onActivate={() =>
            void patch({ [fn]: { provider: pending.id }, consent: [pending.id] }).then(() => setPending(null))
          }
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- limits and usage

function LimitsCard({ settings }: { settings: AiSettingsData }) {
  const setSettings = useSetSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [day, setDay] = useState(String(settings.limitDayUsd));
  const [month, setMonth] = useState(String(settings.limitMonthUsd));
  const [confirm, setConfirm] = useState(String(settings.confirmAboveUsd));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const [d, m, c] = [parseUsd(day), parseUsd(month), parseUsd(confirm)];
    if (d === null || m === null || c === null) {
      setError(t('settings.ai.limits.invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSettings(await core.aiSettingsSet({ limitDayUsd: d, limitMonthUsd: m, confirmAboveUsd: c }));
      void qc.invalidateQueries({ queryKey: ['ai', 'usage'] });
      toast.show(t('settings.ai.limits.saved'), { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h3 className="text-base font-semibold">{t('settings.ai.limits.title')}</h3>
      <p className="mb-3 text-xs text-muted">{t('settings.ai.limits.hint')}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => void save(e)}>
        {(
          [
            ['settings.ai.limits.day', day, setDay, 'ai-limit-day'],
            ['settings.ai.limits.month', month, setMonth, 'ai-limit-month'],
            ['settings.ai.limits.confirm', confirm, setConfirm, 'ai-limit-confirm'],
          ] as const
        ).map(([label, value, set, testId]) => (
          <Field key={label} label={t(label)}>
            {({ id }) => (
              <Input
                id={id}
                data-testid={testId}
                inputMode="decimal"
                className="w-32"
                value={value}
                onChange={(e) => set(e.target.value)}
              />
            )}
          </Field>
        ))}
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          {t('settings.ai.limits.save')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </Card>
  );
}

function UsageCard() {
  const usage = useQuery(aiQ.usage());
  const providers = useQuery(aiQ.settings()).data?.providers ?? [];
  if (!usage.data) return <Skeleton className="h-24" />;
  const u = usage.data;
  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  return (
    <Card data-testid="ai-usage">
      <h3 className="mb-3 text-base font-semibold">{t('settings.ai.usage.title')}</h3>
      <div className="flex flex-col gap-3">
        {(
          [
            [t('settings.ai.usage.today', { gasto: usd(u.dayUsd), limite: usd(u.limitDayUsd) }), u.dayUsd, u.limitDayUsd],
            [
              t('settings.ai.usage.month', { gasto: usd(u.monthUsd), limite: usd(u.limitMonthUsd) }),
              u.monthUsd,
              u.limitMonthUsd,
            ],
          ] as const
        ).map(([text, spent, limit]) => (
          <div key={text} className="flex flex-col gap-1">
            <p className="text-xs">{text}</p>
            <ProgressBar label={text} value={Math.min(spent, limit)} max={limit || 1} />
          </div>
        ))}
        {u.state === 'warning' && <Notice tone="info">{t('settings.ai.usage.warning')}</Notice>}
        {u.state === 'blocked' && <Notice tone="error">{t('settings.ai.usage.blocked')}</Notice>}
        {u.month.length === 0 ? (
          <p className="text-xs text-muted">{t('settings.ai.usage.none')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs" data-testid="ai-usage-rows">
            {u.month.map((row) => {
              const vars = {
                provedor: providerLabel(row.provider),
                funcao: FEATURE_LABEL[row.feature] ? t(FEATURE_LABEL[row.feature]!) : row.feature,
                n: row.calls,
                custo: usd(row.costUsd),
              };
              return (
                <li key={`${row.provider}/${row.feature}`}>
                  {row.calls === 1 ? t('settings.ai.usage.rowOne', vars) : t('settings.ai.usage.row', vars)}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted">{t('settings.ai.usage.estimated')}</p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- prices

function PricesCard({ prices, providers }: { prices: AiModelPrice[]; providers: AiProviderInfo[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply(p: AiProvider, m: string, rates: { input: number; output: number } | null) {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(aiQ.prices().queryKey, await core.aiPricesSet(p, m, rates));
      void qc.invalidateQueries({ queryKey: ['ai', 'settings'] });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const [i, o] = [parseUsd(input), parseUsd(output)];
    if (!model.trim() || i === null || o === null) {
      setError(t('settings.ai.prices.invalid'));
      return;
    }
    if (await apply(provider, model.trim(), { input: i, output: o })) {
      toast.show(t('settings.ai.prices.saved', { modelo: model.trim() }), { tone: 'success' });
      setModel('');
      setInput('');
      setOutput('');
    }
  }

  const label = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  return (
    <Card>
      <h3 className="text-base font-semibold">{t('settings.ai.prices.title')}</h3>
      <p className="mb-3 text-xs text-muted">{t('settings.ai.prices.hint')}</p>
      <ul className="divide-y divide-line" data-testid="ai-prices">
        {prices.map((p) => (
          <li key={`${p.provider}/${p.model}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5 text-xs">
            <span className="w-36 shrink-0 text-muted">{label(p.provider)}</span>
            <span className="font-mono font-semibold">{p.model}</span>
            <span>{t('settings.ai.prices.inOut', { entrada: usd(p.input), saida: usd(p.output) })}</span>
            <span className="text-muted">{t('settings.ai.prices.checked', { data: p.checkedAt })}</span>
            {p.edited && <Badge>{t('settings.ai.prices.edited')}</Badge>}
            {p.stale && <Badge tone="warning">{t('settings.ai.prices.stale')}</Badge>}
            {p.hasTiers && <span className="text-muted">({t('settings.ai.prices.tiers')})</span>}
            {p.source && (
              <a className="text-link underline" href={p.source} target="_blank" rel="noreferrer">
                {t('settings.ai.prices.source')}
              </a>
            )}
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setProvider(p.provider as AiProvider);
                  setModel(p.model);
                  setInput(String(p.input));
                  setOutput(String(p.output));
                }}
              >
                {t('settings.ai.prices.edit')}
              </Button>
              {p.edited && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={RotateCcw}
                  onClick={() => void apply(p.provider as AiProvider, p.model, null)}
                >
                  {t('settings.ai.prices.restore')}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => void save(e)}>
        <p className="w-full text-xs font-semibold">{t('settings.ai.prices.add')}</p>
        <Field label={t('settings.ai.functions.provider')}>
          {({ id }) => (
            <Select id={id} value={provider} onChange={(e) => setProvider(e.target.value as AiProvider)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('settings.ai.prices.model')}>
          {({ id }) => <Input id={id} className="w-48" value={model} onChange={(e) => setModel(e.target.value)} />}
        </Field>
        <Field label={t('settings.ai.prices.input')}>
          {({ id }) => (
            <Input id={id} inputMode="decimal" className="w-24" value={input} onChange={(e) => setInput(e.target.value)} />
          )}
        </Field>
        <Field label={t('settings.ai.prices.output')}>
          {({ id }) => (
            <Input
              id={id}
              inputMode="decimal"
              className="w-24"
              value={output}
              onChange={(e) => setOutput(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" size="sm" variant="neutral" loading={busy}>
          {t('settings.ai.prices.save')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- background queue

function QueueCard({ settings }: { settings: AiSettingsData }) {
  const qc = useQueryClient();
  const setSettings = useSetSettings();
  const queue = useQuery(aiQ.queue());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => core.onAiQueue((q) => qc.setQueryData(aiQ.queue().queryKey, q)), [qc]);

  async function run(fn: () => Promise<AiQueueInfo | void>) {
    setError(null);
    try {
      const q = await fn();
      if (q) qc.setQueryData(aiQ.queue().queryKey, q);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const q = queue.data;
  return (
    <Card data-testid="ai-queue">
      <h3 className="text-base font-semibold">{t('settings.ai.queue.title')}</h3>
      <p className="mb-3 text-xs text-muted">{t('settings.ai.queue.hint')}</p>
      <Switch
        checked={settings.backgroundEnrich}
        disabled={!settings.enrich.provider}
        label={t('settings.ai.queue.enable')}
        onCheckedChange={(on) =>
          void run(async () => {
            setSettings(await core.aiSettingsSet({ backgroundEnrich: on }));
            return core.aiQueueGet();
          })
        }
      />
      {q && (q.enabled || q.items.length > 0) && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span data-testid="ai-queue-count">
              {q.pending === 1 ? t('settings.ai.queue.pendingOne') : t('settings.ai.queue.pending', { n: q.pending })}
            </span>
            {q.failed > 0 && <span className="text-error">{t('settings.ai.queue.failed', { n: q.failed })}</span>}
            {q.paused && <Badge tone="warning">{t('settings.ai.queue.paused')}</Badge>}
            <span className="ml-auto flex gap-1">
              {q.paused ? (
                <Button size="sm" variant="neutral" icon={Play} onClick={() => void run(() => core.aiQueueSetPaused(false))}>
                  {t('settings.ai.queue.resume')}
                </Button>
              ) : (
                <Button size="sm" variant="neutral" icon={Pause} onClick={() => void run(() => core.aiQueueSetPaused(true))}>
                  {t('settings.ai.queue.pause')}
                </Button>
              )}
              {q.failed > 0 && (
                <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void run(() => core.aiQueueRetry())}>
                  {t('settings.ai.queue.retry')}
                </Button>
              )}
            </span>
          </div>
          {q.status && (
            <p role="status" className="text-xs text-fg" data-testid="ai-queue-status">
              {q.status}
            </p>
          )}
          {q.items.length === 0 ? (
            <p className="text-xs text-muted">{t('settings.ai.queue.empty')}</p>
          ) : (
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-auto text-xs">
              {q.items.map((i) => (
                <li key={i.uid} className="flex items-center gap-2">
                  <span className={i.state === 'failed' ? 'text-error' : ''}>{i.lemma}</span>
                  {i.error && <span className="text-muted">({i.error})</span>}
                  <IconButton
                    size="sm"
                    icon={X}
                    label={t('settings.ai.queue.remove', { palavra: i.lemma })}
                    onClick={() => void run(() => core.aiQueueRemove(i.uid))}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- page

export function AiSettings() {
  const settings = useQuery(aiQ.settings());
  const prices = useQuery(aiQ.prices());
  const s = settings.data;
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">{t('settings.ai.title')}</h2>
        <p className="mt-1 text-base text-muted">{t('settings.ai.intro')}</p>
      </header>
      {settings.error && <Notice tone="error">{errorMessage(settings.error)}</Notice>}
      {!s || !prices.data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <KeysCard settings={s} />
          <FunctionCard fn="enrich" settings={s} prices={prices.data} />
          <FunctionCard fn="judge" settings={s} prices={prices.data} />
          <LimitsCard settings={s} />
          <UsageCard />
          <QueueCard settings={s} />
          <PricesCard prices={prices.data} providers={s.providers} />
          <Card>
            <h3 className="mb-2 text-base font-semibold">{t('settings.ai.sent.title')}</h3>
            <SentTable />
          </Card>
        </>
      )}
    </div>
  );
}
